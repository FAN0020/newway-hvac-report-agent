import { SESSION_PHASES } from './constants.js';
import {
  ContractValidationError,
  copy,
  deepFreeze,
  hashContract,
  requiredString,
  requiredTimestamp,
  stringArray,
} from './contract-utils.js';

const SNAPSHOT_PHASES = new Set(['REVIEW', 'READY', 'CONFIRMED']);

function uniqueStrings(value, label, code) {
  const items = stringArray(value || [], label, { code });
  if (new Set(items).size !== items.length) throw new ContractValidationError(`${label} must not contain duplicates.`, code);
  return items;
}

function contractArray(value, label, contract, code) {
  if (!Array.isArray(value)) throw new ContractValidationError(`${label} must be an array.`, code);
  return value.map((item, index) => {
    if (!item || item.contract !== contract) {
      throw new ContractValidationError(`${label}[${index}] must be a ${contract}.`, code);
    }
    return copy(item);
  });
}

function snapshotBody(input, code = 'INVALID_REPORT_SNAPSHOT') {
  const session = input.session;
  if (!session || session.contract !== 'ReportSession' || session.authority !== 'SERVER'
    || !SNAPSHOT_PHASES.has(session.phase)) {
    throw new ContractValidationError('ReportSnapshot requires a server-authoritative session in REVIEW, READY, or CONFIRMED.', code);
  }
  const fields = contractArray(input.fields || [], 'fields', 'ReportField', code);
  if (fields.some((field) => field.session_id !== session.session_id)) {
    throw new ContractValidationError('ReportField belongs to another ReportSession.', 'CROSS_SESSION_FIELD');
  }
  const fieldIds = fields.map((field) => field.field_id);
  if (new Set(fieldIds).size !== fieldIds.length) throw new ContractValidationError('fields must have unique field_id values.', code);
  const evidenceIds = uniqueStrings(input.evidence_ids, 'evidence_ids', code);
  const guidanceIds = uniqueStrings(input.guidance_context_ids, 'guidance_context_ids', code);
  if (guidanceIds.some((id) => evidenceIds.includes(id))) {
    throw new ContractValidationError('GuidanceContext identifiers cannot appear in evidence_ids.', 'GUIDANCE_NOT_JOB_EVIDENCE');
  }
  const confirmed = session.phase === 'CONFIRMED';
  const finalization = confirmed ? {
    structured_state_hash: requiredString(input.structured_state_hash, 'structured_state_hash', code),
    validation_ref: requiredString(input.validation_ref, 'validation_ref', code),
    confirmation_ref: requiredString(input.confirmation_ref, 'confirmation_ref', code),
    technician_principal_ref: requiredString(input.technician_principal_ref, 'technician_principal_ref', code),
    confirmed_at: requiredTimestamp(input.confirmed_at, 'confirmed_at', code),
    report: copy(input.report),
  } : {};
  if (confirmed && (!finalization.report || finalization.report.contract !== 'ExistingFormatReport'
    || finalization.report.report_session_id !== session.session_id
    || finalization.report.structured_state_hash !== finalization.structured_state_hash)) {
    throw new ContractValidationError('Confirmed ReportSnapshot requires a matching authoritative report.', code);
  }
  return {
    contract: 'ReportSnapshot',
    contract_version: '1',
    session_id: session.session_id,
    session_revision: session.revision,
    session_phase: session.phase,
    template_binding: copy(session.template_binding),
    context_binding: copy(session.context_binding),
    job_context_ref: session.job_context_ref,
    audit_event_ids: copy(session.audit_event_ids),
    fields,
    evidence_ids: evidenceIds,
    transcript_ids: uniqueStrings(input.transcript_ids, 'transcript_ids', code),
    transcript_review_ids: uniqueStrings(session.transcript_review_ids || input.transcript_review_ids, 'transcript_review_ids', code),
    guidance_context_ids: guidanceIds,
    validation_issues: contractArray(input.validation_issues || [], 'validation_issues', 'ValidationIssue', code),
    resolution_items: contractArray(input.resolution_items || [], 'resolution_items', 'ResolutionItem', code),
    ...finalization,
    created_at: requiredTimestamp(input.created_at, 'created_at', code),
  };
}

export function createReportSnapshot(input = {}) {
  const body = snapshotBody(input);
  const snapshotHash = hashContract(body);
  return deepFreeze({
    snapshot_id: `snapshot_${snapshotHash.slice(7, 31)}`,
    snapshot_hash: snapshotHash,
    ...body,
  });
}

export function validatePersistedSnapshot(snapshot) {
  const code = 'INVALID_REPORT_SNAPSHOT';
  if (!snapshot || snapshot.contract !== 'ReportSnapshot' || snapshot.contract_version !== '1') {
    throw new ContractValidationError('Persisted value is not a ReportSnapshot v1.', code);
  }
  requiredString(snapshot.snapshot_id, 'snapshot_id', code);
  requiredString(snapshot.snapshot_hash, 'snapshot_hash', code);
  requiredString(snapshot.session_id, 'session_id', code);
  if (!Number.isSafeInteger(snapshot.session_revision) || snapshot.session_revision < 0) {
    throw new ContractValidationError('session_revision must be a non-negative integer.', code);
  }
  if (!SESSION_PHASES.includes(snapshot.session_phase) || !SNAPSHOT_PHASES.has(snapshot.session_phase)) {
    throw new ContractValidationError('session_phase is not snapshot-eligible.', code);
  }
  const body = copy(snapshot);
  delete body.snapshot_id;
  delete body.snapshot_hash;
  const actualHash = hashContract(body);
  if (actualHash !== snapshot.snapshot_hash || snapshot.snapshot_id !== `snapshot_${actualHash.slice(7, 31)}`) {
    throw new ContractValidationError('ReportSnapshot identity does not match its content.', 'SNAPSHOT_IDENTITY_MISMATCH');
  }
  return true;
}
