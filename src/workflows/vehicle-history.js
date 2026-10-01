import { hashContract, validatePersistedSnapshot } from '../domain/index.js';

function error(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function identity(value, label) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/u.test(text)) {
    throw error(`${label} is invalid or missing.`, `INVALID_${label.toUpperCase()}`, 400);
  }
  return text;
}

function snapshotForSession(session, snapshot) {
  if (session.phase !== 'CONFIRMED' || !session.snapshot_ref || !session.confirmation_ref) {
    throw error('The report has not been confirmed.', 'REPORT_NOT_CONFIRMED');
  }
  validatePersistedSnapshot(snapshot);
  if (snapshot.session_phase !== 'CONFIRMED' || snapshot.session_id !== session.session_id
    || snapshot.session_revision !== session.revision || snapshot.snapshot_id !== session.snapshot_ref
    || snapshot.confirmation_ref !== session.confirmation_ref
    || hashContract(snapshot.job_context_binding || null) !== hashContract(session.job_context_binding || null)) {
    throw error('Snapshot does not belong to the confirmed session.', 'SNAPSHOT_IDENTITY_MISMATCH');
  }
  return snapshot;
}

function matchBinding(snapshot) {
  const binding = snapshot.job_context_binding;
  if (!binding) return null;
  const vehicleId = identity(binding.vehicle_id, 'vehicle_id');
  const workOrderRef = identity(binding.record_id, 'work_order_ref');
  const workOrderVersion = identity(binding.version, 'work_order_version');
  if (workOrderRef !== snapshot.job_context_ref) {
    throw error('Reviewed work order belongs to another report.', 'WORK_ORDER_BINDING_MISMATCH');
  }
  if (!/^[a-f0-9]{64}$/u.test(String(binding.source_sha256))
    || !/^[a-f0-9]{64}$/u.test(String(binding.review_sha256))) {
    throw error('Reviewed work order hashes are missing.', 'WORK_ORDER_BINDING_INCOMPLETE');
  }
  if (snapshot.fields.some((field) => ['asset.internal_fleet_no', 'vehicle_id'].includes(field.field_id)
    && field.state === 'KNOWN_VALUE' && String(field.value).trim() !== vehicleId)) {
    throw error('Report and reviewed vehicle identifiers disagree.', 'VEHICLE_ID_MISMATCH');
  }
  return { vehicle_id: vehicleId, work_order_ref: workOrderRef, work_order_version: workOrderVersion,
    source_sha256: binding.source_sha256, review_sha256: binding.review_sha256 };
}

export class VehicleHistoryService {
  constructor({ sessionStore } = {}) {
    if (!sessionStore) throw new TypeError('ReportSessionStore is required.');
    this.sessionStore = sessionStore;
  }

  async snapshot(sessionId) {
    const session = await this.sessionStore.load(sessionId);
    if (!session.snapshot_ref) throw error('The report has not been confirmed.', 'REPORT_NOT_CONFIRMED');
    const snapshot = snapshotForSession(session, await this.sessionStore.readRecord('report-snapshots', session.snapshot_ref));
    return { session, snapshot };
  }

  async reviewIdentity(sessionId, { vehicle_id: vehicleId, attested, review_note: reviewNote } = {}, reviewerPrincipalRef) {
    const { session, snapshot } = await this.snapshot(sessionId);
    if (snapshot.job_context_binding) {
      throw error('This report already has a reviewed work-order vehicle identity.', 'VEHICLE_IDENTITY_ALREADY_BOUND');
    }
    if (!String(snapshot.job_context_ref || '').startsWith('new-report:')) {
      throw error('Manual vehicle identity review is limited to reports started without a work order.', 'VEHICLE_IDENTITY_REVIEW_NOT_APPLICABLE');
    }
    if (attested !== true) throw error('Explicit vehicle identity review is required.', 'VEHICLE_IDENTITY_REVIEW_REQUIRED', 400);
    const id = identity(vehicleId, 'vehicle_id');
    const reviewer = identity(reviewerPrincipalRef, 'reviewer_principal_ref');
    const note = String(reviewNote || '').trim();
    if (!note || note.length > 500) throw error('Describe the independent source checked for this stable vehicle ID.', 'VEHICLE_IDENTITY_SOURCE_REQUIRED', 400);
    this.assertFieldVehicleId(snapshot, id);
    const existing = await this.identityReview(snapshot.snapshot_id);
    if (existing) {
      if (existing.vehicle_id !== id || existing.snapshot_hash !== snapshot.snapshot_hash || existing.session_id !== session.session_id) {
        throw error('This report is already reviewed for another vehicle.', 'VEHICLE_IDENTITY_CONFLICT');
      }
      return this.link(sessionId);
    }
    const body = {
      contract: 'VehicleIdentityReview', contract_version: '1',
      snapshot_id: snapshot.snapshot_id, snapshot_hash: snapshot.snapshot_hash,
      session_id: session.session_id, vehicle_id: id,
      reviewer_principal_ref: reviewer, review_note: note,
      reviewed_at: new Date().toISOString(),
    };
    const review = { ...body, review_hash: hashContract(body) };
    try {
      await this.sessionStore.putRecord('vehicle-identity-reviews', snapshot.snapshot_id, review);
    } catch (cause) {
      if (cause.code !== 'IMMUTABLE_RECORD_COLLISION') throw cause;
      const winner = await this.identityReview(snapshot.snapshot_id);
      if (winner?.vehicle_id !== id) throw error('This report is already reviewed for another vehicle.', 'VEHICLE_IDENTITY_CONFLICT');
    }
    return this.link(sessionId);
  }

  assertFieldVehicleId(snapshot, vehicleId) {
    for (const field of snapshot.fields.filter((item) => ['asset.internal_fleet_no', 'vehicle_id'].includes(item.field_id))) {
      if (field.state === 'KNOWN_VALUE' && String(field.value).trim() !== vehicleId) {
        throw error('Report and reviewed vehicle identifiers disagree.', 'VEHICLE_ID_MISMATCH');
      }
    }
  }

  async identityReview(snapshotId) {
    const review = await this.sessionStore.readRecord('vehicle-identity-reviews', snapshotId)
      .catch((cause) => { if (cause.code === 'IMMUTABLE_RECORD_NOT_FOUND') return null; throw cause; });
    if (!review) return null;
    const { review_hash: reviewHash, ...body } = review;
    if (review.contract !== 'VehicleIdentityReview' || review.contract_version !== '1'
      || reviewHash !== hashContract(body) || review.snapshot_id !== snapshotId) {
      throw error('Vehicle identity review content changed.', 'VEHICLE_IDENTITY_REVIEW_MISMATCH');
    }
    return review;
  }

  async reviewedBinding(snapshot) {
    const order = matchBinding(snapshot);
    if (order) return order;
    const review = await this.identityReview(snapshot.snapshot_id);
    if (!review) return null;
    if (!String(snapshot.job_context_ref || '').startsWith('new-report:')) {
      throw error('Manual vehicle identity review is not valid for this report.', 'VEHICLE_IDENTITY_REVIEW_NOT_APPLICABLE');
    }
    if (review.snapshot_hash !== snapshot.snapshot_hash || review.session_id !== snapshot.session_id) {
      throw error('Vehicle identity review belongs to another report.', 'VEHICLE_IDENTITY_REVIEW_MISMATCH');
    }
    const id = identity(review.vehicle_id, 'vehicle_id');
    this.assertFieldVehicleId(snapshot, id);
    return { vehicle_id: id, work_order_ref: null, work_order_version: null,
      vehicle_identity_source: 'MANUAL_REVIEW', identity_review_ref: snapshot.snapshot_id,
      identity_review_hash: review.review_hash };
  }

  async link(sessionId) {
    const { session, snapshot } = await this.snapshot(sessionId);
    const binding = await this.reviewedBinding(snapshot);
    const existing = await this.sessionStore.readRecord('vehicle-history-links', snapshot.snapshot_id)
      .catch((cause) => { if (cause.code === 'IMMUTABLE_RECORD_NOT_FOUND') return null; throw cause; });
    if (existing) {
      if (existing.snapshot_hash !== snapshot.snapshot_hash || existing.session_id !== session.session_id) {
        throw error('Vehicle history link does not match its snapshot.', 'VEHICLE_HISTORY_LINK_MISMATCH');
      }
      const { link_hash: linkHash, ...body } = existing;
      if (linkHash !== hashContract(body)) throw error('Vehicle history link content changed.', 'VEHICLE_HISTORY_LINK_MISMATCH');
      if (!binding || existing.vehicle_id !== binding.vehicle_id
        || existing.work_order_ref !== binding.work_order_ref
        || existing.work_order_version !== binding.work_order_version
        || existing.source_sha256 !== binding.source_sha256
        || existing.review_sha256 !== binding.review_sha256
        || existing.vehicle_identity_source !== binding.vehicle_identity_source
        || existing.identity_review_ref !== binding.identity_review_ref
        || existing.identity_review_hash !== binding.identity_review_hash) {
        throw error('Vehicle history link disagrees with its identity review.', 'VEHICLE_HISTORY_LINK_MISMATCH');
      }
      return existing;
    }
    if (!binding) return null;
    const body = {
      contract: 'VehicleHistoryLink', contract_version: '1',
      snapshot_id: snapshot.snapshot_id, snapshot_hash: snapshot.snapshot_hash,
      session_id: session.session_id, session_revision: session.revision,
      ...binding,
      report_id: snapshot.report.report_id,
      report_version: snapshot.report.report_version,
      confirmation_ref: snapshot.confirmation_ref,
      confirmed_at: snapshot.confirmed_at,
      technician_principal_ref: snapshot.technician_principal_ref,
    };
    const link = Object.freeze({ ...body, link_hash: hashContract(body) });
    return this.sessionStore.putRecord('vehicle-history-links', snapshot.snapshot_id, link);
  }

  async list(vehicleId) {
    const id = identity(vehicleId, 'vehicle_id');
    const sessions = await this.sessionStore.listSessions();
    const records = [];
    for (const session of sessions.filter((item) => item.phase === 'CONFIRMED')) {
      const link = await this.link(session.session_id);
      if (link?.vehicle_id !== id) continue;
      await this.snapshot(session.session_id);
      records.push(link);
    }
    records.sort((a, b) => a.confirmed_at.localeCompare(b.confirmed_at) || a.snapshot_id.localeCompare(b.snapshot_id));
    return Object.freeze({ vehicle_id: id, reports: Object.freeze(records) });
  }

  async export(sessionId) {
    const { snapshot } = await this.snapshot(sessionId);
    const link = await this.link(sessionId);
    return Object.freeze({
      schema_version: 'servicescribe-structured-report.v1',
      vehicle_identity_status: link ? 'VERIFIED' : 'PENDING_VERIFICATION',
      vehicle_id: link?.vehicle_id || null,
      work_order_ref: link?.work_order_ref || null,
      work_order_version: link?.work_order_version || null,
      source_snapshot_id: snapshot.snapshot_id,
      source_snapshot_hash: snapshot.snapshot_hash,
      report_id: snapshot.report.report_id,
      report_version: snapshot.report.report_version,
      confirmation_ref: snapshot.confirmation_ref,
      confirmed_at: snapshot.confirmed_at,
      technician_principal_ref: snapshot.technician_principal_ref,
      template_binding: snapshot.template_binding,
      job_context_ref: snapshot.job_context_ref,
      report: snapshot.report,
      fields: snapshot.fields,
      export_content_hash: hashContract({ report: snapshot.report, fields: snapshot.fields }),
    });
  }
}
