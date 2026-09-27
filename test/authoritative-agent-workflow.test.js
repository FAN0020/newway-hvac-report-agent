import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { createRetriever } from '../src/v2/retrieval.js';
import { loadScopeRegistry } from '../src/v2/scope.js';
import { createUploadStore } from '../src/v2/upload.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

async function fixture(t, name, { systemFields = [] } = {}) {
  const root = path.resolve('.tmp-tests', `authoritative-agent-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = await loadScopeRegistry();
  const uploadStore = createUploadStore({ baseDir: path.join(root, 'uploads') });
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'authority') });
  const makeService = () => new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore,
    whisperProvider: { transcribe: async () => { throw new Error('Unexpected transcription.'); } },
    scopeRegistry: registry,
    uploadStore,
    retriever: createRetriever({ registry, uploadStore }),
    jobContextProvider: {
      resolve: async ({ job_context_ref: jobContextRef }) => ({
        record_id: `work-order:${jobContextRef}`,
        version: 'work-order.v1',
        fields: systemFields,
      }),
    },
    clock: () => '2026-09-27T11:00:00.000Z',
  });
  return { root, sessionStore, makeService };
}

async function createBusSession(service, suffix) {
  return service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0',
    job_context_ref: `WO-AGENT-${suffix}`,
  });
}

async function createHvacSession(service) {
  return service.createSession({
    template_id: 'hvac-service-report',
    template_version: '1.0.0',
    job_context_ref: 'job-context:QA-HVAC',
  });
}

async function captureAndReview(service, input) {
  const captured = await service.captureText(input);
  if (captured.next_action !== 'REVIEW_TRANSCRIPT') return captured;
  return service.decideTranscriptReview({
    session_id: input.session_id,
    expected_revision: captured.session.revision,
    review_id: captured.review.review_id,
    decisions: captured.review.items.map((item) => ({ review_item_id: item.review_item_id, decision: 'NO_CHANGE' })),
  });
}

test('authoritative system and transcript identities conflict until a server-owned technician answer resolves them', async (t) => {
  const { makeService } = await fixture(t, 'conflict', { systemFields: [
    { field_id: 'asset.registration_no', value: 'SBS6025Z' },
  ] });
  const service = makeService();
  const created = await createBusSession(service, 'CONFLICT');
  const captured = await captureAndReview(service, {
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Bus MAN A95 registration SBS6026Z had a door fault.',
    language: 'en',
  });
  const conflictField = captured.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no');
  assert.equal(conflictField.state, 'CONFLICT');
  assert.deepEqual(new Set(conflictField.candidates.map((item) => item.support_type)), new Set(['AUTHORITATIVE_SYSTEM_DATA', 'MANUAL_TECHNICIAN_INPUT']));
  assert.equal(conflictField.candidates.every((item) => item.evidence_refs.length > 0), true);

  const item = captured.agent_state.resolution_queue.find((entry) => entry.field_id === 'asset.registration_no');
  assert.equal(item.type, 'CONFLICT');
  const systemCandidate = conflictField.candidates.find((entry) => entry.support_type === 'AUTHORITATIVE_SYSTEM_DATA');
  const answered = await service.answerResolutionItem({
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    resolution_id: item.resolution_id,
    answer: { kind: 'SELECT_CANDIDATE', candidate_id: systemCandidate.candidate_id },
    idempotency_key: 'answer-conflict-1',
  });
  const resolved = answered.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no');
  assert.equal(resolved.state, 'KNOWN_VALUE');
  assert.equal(resolved.value, 'SBS6025Z');
  assert.equal(resolved.candidates.length, 4);
  assert.ok(resolved.candidates.some((entry) => entry.support_type === 'TECHNICIAN_CONFIRMATION'));
  assert.ok(resolved.superseded_candidate_ids.includes(systemCandidate.candidate_id));
  assert.equal(answered.agent_state.resolution_queue.some((entry) => entry.field_id === 'asset.registration_no'), false);
});

test('HVAC work order and equipment text answers satisfy the visible resolution questions', async (t) => {
  const { makeService } = await fixture(t, 'hvac-visible-identity-inputs');
  const service = makeService();
  const created = await createHvacSession(service);
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'I found a blocked drain and cleared it.',
    language: 'en',
    idempotency_key: 'hvac-visible-identity-capture',
  });

  const equipment = await service.submitFieldAnswer({
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    field_id: 'equipment',
    value: 'Fictional split unit AC-104',
  });
  const workOrder = await service.submitFieldAnswer({
    session_id: created.session.session_id,
    expected_revision: equipment.session.revision,
    field_id: 'work_order',
    value: 'QA-WO-104',
  });

  for (const [fieldId, expected] of [['equipment', 'Fictional split unit AC-104'], ['work_order', 'QA-WO-104']]) {
    const field = workOrder.agent_state.report_fields.find((entry) => entry.field_id === fieldId);
    assert.equal(field.state, 'KNOWN_VALUE');
    assert.equal(field.value, expected);
    assert.equal(workOrder.agent_state.validation_issues.some((issue) => issue.field_id === fieldId), false);
    assert.equal(workOrder.agent_state.resolution_queue.some((item) => item.field_id === fieldId), false);
  }
});

test('one structured answer resolves every current issue for its field and a resolved question does not reappear', async (t) => {
  const { makeService } = await fixture(t, 'multi-issue', { systemFields: [
    { field_id: 'completion.state', value: 'BROKEN' },
  ] });
  const service = makeService();
  const created = await createBusSession(service, 'MULTI');
  const captured = await captureAndReview(service, {
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Bus MAN A95 registration SBS6025Z had a door fault.',
  });
  const item = captured.agent_state.resolution_queue.find((entry) => entry.field_id === 'completion.state');
  assert.equal(item.type, 'SAFETY_CONFIRMATION');
  assert.ok(item.issue_ids.length >= 2);

  const answered = await service.answerResolutionItem({
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    resolution_id: item.resolution_id,
    answer: { kind: 'VALUE', value: 'NOT_READY' },
    idempotency_key: 'answer-completion-1',
  });
  assert.equal(answered.agent_state.validation_issues.some((issue) => issue.field_id === 'completion.state'), false);
  assert.equal(answered.agent_state.resolution_queue.some((entry) => entry.field_id === 'completion.state'), false);
  const field = answered.agent_state.report_fields.find((entry) => entry.field_id === 'completion.state');
  assert.equal(field.state, 'KNOWN_VALUE');
  assert.ok(field.candidates.some((entry) => entry.support_type === 'TECHNICIAN_CONFIRMATION'));
});

test('duplicate answer retries are idempotent, stale different answers fail, and restart preserves the current queue', async (t) => {
  const { makeService, sessionStore } = await fixture(t, 'durability');
  let service = makeService();
  const created = await createBusSession(service, 'DURABILITY');
  const captured = await captureAndReview(service, {
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Bus MAN A95 registration SBS6025Z had a door fault.',
  });
  const item = captured.agent_state.resolution_queue.find((entry) => entry.field_id === 'diagnosis.root_cause');
  const request = {
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    resolution_id: item.resolution_id,
    answer: { kind: 'SEMANTIC_STATE', state: 'NOT_ESTABLISHED' },
    idempotency_key: 'answer-root-cause-1',
  };
  const first = await service.answerResolutionItem(request);
  const retry = await service.answerResolutionItem(request);
  assert.equal(retry.reused, true);
  assert.equal(retry.session.revision, first.session.revision);
  assert.equal(retry.candidate.candidate_id, first.candidate.candidate_id);

  await assert.rejects(() => service.answerResolutionItem({
    ...request,
    idempotency_key: 'answer-root-cause-2',
    answer: { kind: 'SEMANTIC_STATE', state: 'FURTHER_INVESTIGATION_REQUIRED' },
  }), { code: 'STALE_REVISION' });

  service = makeService();
  const reloaded = await service.getAgentState(created.session.session_id);
  assert.equal(reloaded.session.revision, first.session.revision);
  assert.equal(reloaded.agent_state.resolution_queue.some((entry) => entry.resolution_id === item.resolution_id), false);
  const rootCause = reloaded.agent_state.report_fields.find((entry) => entry.field_id === 'diagnosis.root_cause');
  assert.equal(rootCause.value, 'Root cause not established');
  assert.equal(rootCause.state, 'KNOWN_VALUE');
  assert.equal((await sessionStore.loadChain(created.session.session_id)).agent_runs.length >= 2, true);
});

test('explicit no-parts narration becomes EXPLICIT_NONE rather than UNKNOWN', async (t) => {
  const { makeService } = await fixture(t, 'no-parts');
  const service = makeService();
  const created = await createBusSession(service, 'NO-PARTS');
  const captured = await captureAndReview(service, {
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Bus MAN A95 registration SBS6025Z had a door fault. No parts were used.',
  });
  const field = captured.agent_state.report_fields.find((entry) => entry.field_id === 'parts.part_number');
  assert.equal(field.state, 'EXPLICIT_NONE');
  assert.ok(field.selected_candidate_ids.length > 0);
});

test('explicit no-parts narration wins over a component mentioned elsewhere in the same statement', async (t) => {
  const { makeService } = await fixture(t, 'no-parts-with-component-mention');
  const service = makeService();
  const created = await createBusSession(service, 'NO-PARTS-COMPONENT');
  const captured = await captureAndReview(service, {
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Door controller connector was loose. Reseated and secured the connector. No parts were used.',
  });
  const field = captured.agent_state.report_fields.find((entry) => entry.field_id === 'parts.part_number');
  assert.equal(field.state, 'EXPLICIT_NONE');
  assert.equal(field.value, null);
  assert.equal(field.candidates.some((candidate) => candidate.claim.kind === 'VALUE'), false);
});
