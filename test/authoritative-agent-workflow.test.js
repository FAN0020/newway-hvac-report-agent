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

test('field review can reversibly select draft, original words, and manual values without losing provenance', async (t) => {
  const { makeService, sessionStore } = await fixture(t, 'reversible-field-review', { systemFields: [
    { field_id: 'asset.registration_no', value: 'SBS6025Z' },
  ] });
  const service = makeService();
  const created = await createBusSession(service, 'REVERSIBLE');
  const captured = await captureAndReview(service, {
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Bus registration SBS6026Z had a door fault.',
  });
  const conflicted = captured.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no');
  const systemCandidate = conflicted.candidates.find((candidate) => candidate.support_type === 'AUTHORITATIVE_SYSTEM_DATA');
  const transcriptCandidate = conflicted.candidates.find((candidate) => candidate.support_type === 'MANUAL_TECHNICIAN_INPUT');
  assert.equal(conflicted.state, 'CONFLICT');

  const draft = await service.selectFieldRepresentation({
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    field_id: 'asset.registration_no',
    selection: { kind: 'CANDIDATE', candidate_id: transcriptCandidate.candidate_id },
    idempotency_key: 'select-transcript-draft',
  });
  assert.equal(draft.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no').value, 'SBS6026Z');

  const chain = await sessionStore.loadChain(created.session.session_id);
  const spanId = transcriptCandidate.evidence_refs.find((reference) => reference.span_id)?.span_id;
  const sourceSpan = chain.evidence_spans.find((span) => span.span_id === spanId);
  const sourceTranscript = chain.transcripts.find((transcript) => transcript.transcript_id === sourceSpan.evidence_id);
  const sourceWords = sourceTranscript.raw_text.slice(sourceSpan.start_offset, sourceSpan.end_offset);
  const original = await service.selectFieldRepresentation({
    session_id: created.session.session_id,
    expected_revision: draft.session.revision,
    field_id: 'asset.registration_no',
    selection: { kind: 'TRANSCRIPT_SPAN', candidate_id: transcriptCandidate.candidate_id, span_id: spanId },
    idempotency_key: 'select-original-words',
  });
  assert.equal(original.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no').value, sourceWords);

  const manual = await service.selectFieldRepresentation({
    session_id: created.session.session_id,
    expected_revision: original.session.revision,
    field_id: 'asset.registration_no',
    selection: { kind: 'MANUAL', value: 'SBS6027Z' },
    idempotency_key: 'select-manual-edit',
  });
  assert.equal(manual.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no').value, 'SBS6027Z');

  const restored = await service.selectFieldRepresentation({
    session_id: created.session.session_id,
    expected_revision: manual.session.revision,
    field_id: 'asset.registration_no',
    selection: { kind: 'CANDIDATE', candidate_id: systemCandidate.candidate_id },
    idempotency_key: 'restore-work-order-draft',
  });
  const restoredField = restored.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no');
  assert.equal(restoredField.state, 'KNOWN_VALUE');
  assert.equal(restoredField.value, 'SBS6025Z');
  assert.equal(restoredField.candidates.some((candidate) => candidate.candidate_id === transcriptCandidate.candidate_id), true);
  assert.equal(restoredField.candidates.some((candidate) => candidate.candidate_id === systemCandidate.candidate_id), true);
  assert.equal(restoredField.candidates.filter((candidate) => candidate.support_type === 'TECHNICIAN_CONFIRMATION').length, 4);
  assert.equal(restored.agent_state.resolution_queue.some((item) => item.field_id === 'asset.registration_no'), false);

  const reloaded = await service.getAgentState(created.session.session_id);
  assert.equal(reloaded.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no').value, 'SBS6025Z');

  const laterEvidence = await captureAndReview(service, {
    session_id: created.session.session_id,
    expected_revision: restored.session.revision,
    text: 'Bus registration SBS6028Z had a new reported fault.',
  });
  const reopened = laterEvidence.agent_state.report_fields.find((field) => field.field_id === 'asset.registration_no');
  assert.equal(reopened.state, 'CONFLICT');
  assert.equal(reopened.candidates.some((candidate) => candidate.claim.value === 'SBS6028Z'), true);
  assert.equal(laterEvidence.agent_state.resolution_queue.some((item) => item.field_id === 'asset.registration_no'), true);
});

test('a suspected root cause remains uncertain instead of becoming a confirmed diagnosis', async (t) => {
  const { makeService } = await fixture(t, 'suspected-root-cause');
  const service = makeService();
  const created = await createBusSession(service, 'SUSPECTED');
  const captured = await captureAndReview(service, {
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'I inspected the passenger door and found intermittent controller communication.',
  });
  const suspected = await service.selectFieldRepresentation({
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    field_id: 'diagnosis.root_cause',
    selection: { kind: 'SEMANTIC_STATE', state: 'SUSPECTED', value: 'controller communication fault' },
    idempotency_key: 'suspected-cause-selection',
  });
  const field = suspected.agent_state.report_fields.find((entry) => entry.field_id === 'diagnosis.root_cause');
  assert.equal(field.state, 'UNCERTAIN');
  assert.match(String(field.value || field.candidates.at(-1)?.claim?.value), /Suspected root cause/u);
  assert.equal(suspected.agent_state.resolution_queue.some((item) => item.field_id === 'diagnosis.root_cause'), true);
});

test('field review selection rejects stale revisions and candidates from another report', async (t) => {
  const { makeService } = await fixture(t, 'field-review-boundaries');
  const service = makeService();
  const first = await createBusSession(service, 'BOUNDARY-A');
  const firstCaptured = await captureAndReview(service, {
    session_id: first.session.session_id,
    expected_revision: first.session.revision,
    text: 'Bus MAN A95 had a door fault.',
  });
  const firstCandidate = firstCaptured.agent_state.report_fields
    .flatMap((field) => field.candidates)
    .find((candidate) => candidate.claim.kind === 'VALUE');

  const second = await createBusSession(service, 'BOUNDARY-B');
  const secondCaptured = await captureAndReview(service, {
    session_id: second.session.session_id,
    expected_revision: second.session.revision,
    text: 'Passenger door would not close.',
  });
  await assert.rejects(() => service.selectFieldRepresentation({
    session_id: second.session.session_id,
    expected_revision: secondCaptured.session.revision,
    field_id: firstCandidate.field_id,
    selection: { kind: 'CANDIDATE', candidate_id: firstCandidate.candidate_id },
    idempotency_key: 'cross-report-candidate',
  }), { code: 'FIELD_CANDIDATE_BINDING_MISMATCH' });

  await assert.rejects(() => service.selectFieldRepresentation({
    session_id: first.session.session_id,
    expected_revision: firstCaptured.session.revision - 1,
    field_id: firstCandidate.field_id,
    selection: { kind: 'CANDIDATE', candidate_id: firstCandidate.candidate_id },
    idempotency_key: 'stale-field-selection',
  }), { code: 'STALE_REVISION' });
});
