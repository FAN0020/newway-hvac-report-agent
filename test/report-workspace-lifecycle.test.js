import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

const systemFields = [
  { field_id: 'work.work_order_id', value: 'WO-111-1222' },
  { field_id: 'work.date_time', value: '2026-09-27 10:42' },
  { field_id: 'asset.internal_fleet_no', value: '8300-354' },
  { field_id: 'asset.registration_no', value: 'SBS6025Z' },
  { field_id: 'asset.bus_model', value: 'MAN A95' },
  { field_id: 'measurement.odometer_km', value: 51020, unit: 'km' },
  { field_id: 'asset.depot', value: 'Hougang Depot' },
  { field_id: 'technician.name', value: 'Alex Tan' },
  { field_id: 'work.trigger', value: 'Passenger door would not close' },
  { field_id: 'inspection_findings', value: 'Door controller connector was loose' },
  { field_id: 'diagnosis.root_cause', value: 'Root cause not established' },
  { field_id: 'work_performed', value: 'Reseated and secured the connector' },
  { field_id: 'test.result', value: 'Door cycle test completed five times' },
  { field_id: 'completion.outstanding_issues', value: 'None' },
  { field_id: 'completion.state', value: 'NOT_READY' },
];

async function fixture(t, name) {
  const root = path.resolve('.tmp-tests', `workspace-lifecycle-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'authority') });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore,
    whisperProvider: { transcribe: async () => { throw new Error('Not used.'); } },
    jobContextProvider: { resolve: async () => ({ record_id: 'work-order:WO-111-1222', version: 'work-order.v1', fields: systemFields }) },
    clock: () => '2026-09-27T10:42:00.000Z',
  });
  return { root, service, sessionStore };
}

async function resolveAll(service, created) {
  let current = created;
  while (current.agent_state.resolution_queue.length) {
    const next = current.agent_state.resolution_queue[0];
    const field = current.agent_state.report_fields.find((entry) => entry.field_id === next.field_id);
    const existing = field.candidates.find((candidate) => candidate.support_type === 'AUTHORITATIVE_SYSTEM_DATA');
    current = await service.answerResolutionItem({
      session_id: created.session.session_id,
      expected_revision: current.session.revision,
      resolution_id: next.resolution_id,
      answer: existing
        ? { kind: 'SELECT_CANDIDATE', candidate_id: existing.candidate_id }
        : { kind: 'VALUE', value: next.field_id === 'completion.state' ? 'NOT_READY' : 'Not established' },
      idempotency_key: `resolve-${next.resolution_id}`,
    });
  }
  return current;
}

test('server-owned review lifecycle moves complete sessions through REVIEW and READY only', async (t) => {
  const { service } = await fixture(t, 'review');
  const created = await service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance', template_version: '1.0.0', job_context_ref: 'WO-111-1222',
  });
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Passenger door fault inspected.',
    idempotency_key: 'workspace-review-capture',
  });
  const resolved = await resolveAll(service, captured);
  assert.equal(resolved.agent_state.completeness.complete, true);

  const review = await service.enterReview({ session_id: created.session.session_id, expected_revision: resolved.session.revision });
  assert.equal(review.session.phase, 'REVIEW');
  const ready = await service.completeReview({ session_id: created.session.session_id, expected_revision: review.session.revision });
  assert.equal(ready.session.phase, 'READY');
  await assert.rejects(() => service.completeReview({ session_id: created.session.session_id, expected_revision: review.session.revision }), { code: 'STALE_REVISION' });

  const confirmation = {
    confirmation_token: `confirm_${'a'.repeat(48)}`,
    report_session_id: created.session.session_id,
    report_id: 'report_demo',
    report_hash: `sha256:${'b'.repeat(64)}`,
    technician_id: 'TECH-001',
  };
  const confirmed = await service.confirmSession({
    session_id: created.session.session_id, expected_revision: ready.session.revision, confirmation,
  });
  assert.equal(confirmed.session.phase, 'CONFIRMED');
  assert.equal(confirmed.session.confirmation_ref, confirmation.confirmation_token);
});

test('a resolved session can capture additional evidence without browser-side state reconstruction', async (t) => {
  const { service } = await fixture(t, 'capture-more');
  const created = await service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance', template_version: '1.0.0', job_context_ref: 'WO-111-1222',
  });
  const first = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: 'No parts were used.', idempotency_key: 'capture-more-first',
  });
  assert.equal(first.session.phase, 'RESOLVE');
  const second = await service.captureText({
    session_id: created.session.session_id, expected_revision: first.session.revision,
    text: 'Root cause not established.', idempotency_key: 'capture-more-second',
  });
  assert.equal(second.session.phase, 'RESOLVE');
  assert.equal(second.session.transcript_ids.length, 2);
});

test('incomplete sessions cannot enter REVIEW and browser input cannot forge readiness', async (t) => {
  const { service } = await fixture(t, 'blocked');
  const created = await service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance', template_version: '1.0.0', job_context_ref: 'WO-BLOCKED',
  });
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Passenger door fault inspected.',
    idempotency_key: 'workspace-blocked-capture',
  });
  await assert.rejects(() => service.enterReview({
    session_id: created.session.session_id, expected_revision: captured.session.revision,
  }), { code: 'REPORT_NOT_COMPLETE' });
});

test('one classified attachment becomes server-owned evidence without becoming a report fact', async (t) => {
  const { service, sessionStore } = await fixture(t, 'attachment');
  const created = await service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance', template_version: '1.0.0', job_context_ref: 'WO-ATTACH',
  });
  const attached = await service.attachEvidence({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    filename: 'after-work-photo.txt',
    mime_type: 'text/plain',
    purpose: 'AFTER_WORK_PHOTO',
    buffer: Buffer.from('Photo placeholder bytes', 'utf8'),
  });
  assert.equal(attached.evidence.evidence_type, 'DOCUMENT');
  assert.equal(attached.evidence.metadata.purpose, 'AFTER_WORK_PHOTO');
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(chain.evidence.some((entry) => entry.evidence_id === attached.evidence.evidence_id), true);
  assert.equal(chain.field_candidates.some((entry) => entry.source_ref === attached.evidence.evidence_id), false);
});
