import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

const PRINCIPAL = 'principal:demo-technician';
const FIELDS = [
  { field_id: 'work.work_order_id', value: 'WO-P0-001' },
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

async function fixture(t, name, options = {}) {
  const root = path.resolve('.tmp-tests', `final-report-authority-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'authority') });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore,
    whisperProvider: { transcribe: async () => { throw new Error('Not used.'); } },
    jobContextProvider: { resolve: async ({ job_context_ref: ref }) => ({ record_id: ref, version: 'work-order.v1', fields: FIELDS }) },
    exportWriter: options.exportWriter,
    clock: () => '2026-09-27T10:42:00.000Z',
  });
  return { root, sessionStore, service };
}

async function readyReport(service) {
  const created = await service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0',
    job_context_ref: 'work-order:WO-P0-001',
  });
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'No parts were used.',
    idempotency_key: `final-authority-capture-${created.session.session_id}`,
  });
  let current = captured;
  while (current.agent_state.resolution_queue.length) {
    const item = current.agent_state.resolution_queue[0];
    const field = current.agent_state.report_fields.find((entry) => entry.field_id === item.field_id);
    const system = field.candidates.find((candidate) => candidate.support_type === 'AUTHORITATIVE_SYSTEM_DATA');
    current = await service.answerResolutionItem({
      session_id: created.session.session_id,
      expected_revision: current.session.revision,
      resolution_id: item.resolution_id,
      answer: system
        ? { kind: 'SELECT_CANDIDATE', candidate_id: system.candidate_id }
        : { kind: 'VALUE', value: 'Not established' },
      idempotency_key: `final-authority-${item.resolution_id}`,
    });
  }
  const review = await service.enterReview({
    session_id: created.session.session_id,
    expected_revision: current.session.revision,
  });
  const ready = await service.completeReview({
    session_id: created.session.session_id,
    expected_revision: review.session.revision,
  });
  return ready;
}

test('review completion creates a current revision-bound validation receipt', async (t) => {
  const { service, sessionStore } = await fixture(t, 'validation');
  const ready = await readyReport(service);
  assert.equal(ready.session.phase, 'READY');
  assert.match(ready.session.validation_ref, /^validation_[a-f0-9]{24}$/u);
  const receipt = await sessionStore.readRecord('validation-receipts', ready.session.validation_ref);
  assert.equal(receipt.session_id, ready.session.session_id);
  assert.equal(receipt.session_revision, ready.session.revision);
  assert.deepEqual(receipt.template_binding, ready.session.template_binding);
  assert.equal(receipt.status, 'PASS');
  assert.match(receipt.structured_state_hash, /^sha256:[a-f0-9]{64}$/u);
});

test('server-owned confirmation creates one immutable snapshot without a client draft', async (t) => {
  const { service, sessionStore } = await fixture(t, 'snapshot');
  const ready = await readyReport(service);
  const confirmed = await service.confirmSession({
    session_id: ready.session.session_id,
    expected_revision: ready.session.revision,
  });
  assert.equal(confirmed.session.phase, 'CONFIRMED');
  assert.match(confirmed.session.confirmation_ref, /^confirmation_[a-f0-9]{24}$/u);
  assert.match(confirmed.session.snapshot_ref, /^snapshot_[a-f0-9]{24}$/u);
  assert.equal(confirmed.confirmation.technician_principal_ref, PRINCIPAL);
  assert.equal(confirmed.confirmation.expected_revision, ready.session.revision);
  assert.equal(confirmed.confirmation.confirmed_revision, confirmed.session.revision);
  assert.equal(confirmed.snapshot.session_revision, confirmed.session.revision);
  assert.equal(confirmed.snapshot.validation_ref, ready.session.validation_ref);
  assert.equal(confirmed.snapshot.confirmation_ref, confirmed.confirmation.confirmation_id);
  assert.equal(confirmed.snapshot.report.template_id, ready.session.template_binding.template_id);
  assert.equal(confirmed.snapshot.report.sections.some((section) => section.content.some((field) => field.state === 'EXPLICIT_NONE' && field.value === 'None')), true);
  assert.equal(Object.isFrozen(confirmed.snapshot), true);

  const persisted = await sessionStore.readRecord('report-snapshots', confirmed.snapshot.snapshot_id);
  assert.equal(persisted.snapshot_hash, confirmed.snapshot.snapshot_hash);
  await assert.rejects(() => service.captureText({
    session_id: ready.session.session_id,
    expected_revision: confirmed.session.revision,
    text: 'Change the report.',
  }), { code: 'REPORT_SESSION_FINAL' });
});

test('stale and replayed confirmations cannot create another snapshot', async (t) => {
  const { service, sessionStore } = await fixture(t, 'stale-replay');
  const ready = await readyReport(service);
  await assert.rejects(() => service.confirmSession({
    session_id: ready.session.session_id,
    expected_revision: ready.session.revision - 1,
  }), { code: 'STALE_REVISION' });
  const first = await service.confirmSession({
    session_id: ready.session.session_id,
    expected_revision: ready.session.revision,
  });
  const replay = await service.confirmSession({
    session_id: ready.session.session_id,
    expected_revision: ready.session.revision,
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.snapshot.snapshot_id, first.snapshot.snapshot_id);
  assert.equal(replay.confirmation.confirmation_id, first.confirmation.confirmation_id);
  const chain = await sessionStore.loadChain(ready.session.session_id);
  assert.equal(chain.audit_events.filter((event) => event.event_type === 'REPORT_CONFIRMED').length, 1);
});

test('a validation receipt from another ReportSession cannot authorize confirmation', async (t) => {
  const { service, sessionStore } = await fixture(t, 'cross-session-validation');
  const first = await readyReport(service);
  const second = await readyReport(service);
  const poisoned = await sessionStore.attachFinalization({
    session_id: first.session.session_id,
    expected_revision: first.session.revision,
    validation_ref: second.session.validation_ref,
  });
  await assert.rejects(() => service.confirmSession({
    session_id: poisoned.session_id,
    expected_revision: poisoned.revision,
  }), { code: 'STALE_VALIDATION' });
  const chain = await sessionStore.loadChain(first.session.session_id);
  assert.equal(chain.session.phase, 'READY');
  assert.equal(chain.report_snapshot, null);
  assert.equal(chain.confirmation, null);
});

test('confirmed export is snapshot-owned, retry-idempotent, and survives service restart', async (t) => {
  const { root, service } = await fixture(t, 'export');
  const ready = await readyReport(service);
  const confirmed = await service.confirmSession({ session_id: ready.session.session_id, expected_revision: ready.session.revision });
  const first = await service.exportConfirmedSession({
    session_id: confirmed.session.session_id,
    expected_revision: confirmed.session.revision,
  });
  assert.equal(first.reused, false);
  assert.match(first.export_text, /Bus Defect Rectification/iu);
  assert.match(first.export_text, /Parts \/ materials: None/iu);
  assert.match(first.export_text, /Odometer: 51020 km/iu);
  assert.doesNotMatch(first.export_text, /Measurements: 51020/iu);
  const second = await service.exportConfirmedSession({
    session_id: confirmed.session.session_id,
    expected_revision: confirmed.session.revision,
  });
  assert.equal(second.reused, true);
  assert.equal(second.export_hash, first.export_hash);

  const restarted = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore: new ReportSessionStore({ root: path.join(root, 'authority') }),
    whisperProvider: { transcribe: async () => { throw new Error('Not used.'); } },
    clock: () => '2026-09-27T10:42:00.000Z',
  });
  const afterRestart = await restarted.exportConfirmedSession({
    session_id: confirmed.session.session_id,
    expected_revision: confirmed.session.revision,
  });
  assert.equal(afterRestart.reused, true);
  assert.equal(afterRestart.export_hash, first.export_hash);
});

test('an export failure leaves the confirmation and immutable snapshot valid', async (t) => {
  const { service, sessionStore } = await fixture(t, 'export-failure', {
    exportWriter: async () => { throw Object.assign(new Error('disk unavailable'), { code: 'EXPORT_UNAVAILABLE', status: 503 }); },
  });
  const ready = await readyReport(service);
  const confirmed = await service.confirmSession({ session_id: ready.session.session_id, expected_revision: ready.session.revision });
  await assert.rejects(() => service.exportConfirmedSession({
    session_id: confirmed.session.session_id,
    expected_revision: confirmed.session.revision,
  }), { code: 'EXPORT_UNAVAILABLE' });
  const chain = await sessionStore.loadChain(confirmed.session.session_id);
  assert.equal(chain.session.phase, 'CONFIRMED');
  assert.equal(chain.session.snapshot_ref, confirmed.snapshot.snapshot_id);
  assert.equal(chain.report_snapshot.snapshot_hash, confirmed.snapshot.snapshot_hash);
});
