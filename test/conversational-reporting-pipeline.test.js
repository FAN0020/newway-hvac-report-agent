import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';
import { deriveCaptureTimeAssignments } from '../src/semantic/temporal-fields.js';
import { verifyStructuredFactProposals } from '../src/semantic/structured-proposals.js';
import { extractAtomicFacts } from '../src/semantic/atomic-facts.js';
import { routeAtomicFacts } from '../src/semantic/field-router.js';
import { templateFor } from '../web/template-catalog.js';

const corpus = JSON.parse(await fs.readFile(new URL('../evaluation/conversational-reporting.v1.json', import.meta.url), 'utf8'));

async function capture(t, entry, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conversational-pipeline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'sessions') });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore,
    whisperProvider: { transcribe: async () => { throw new Error('Unexpected audio capture'); } },
    clock: () => '2026-09-28T06:00:00.000Z',
    reportTimeZone: 'Asia/Shanghai',
    ...options,
  });
  const created = await service.createSession({
    template_id: entry.template_id, template_version: '1.0.0', job_context_ref: `new-report:${entry.id}`,
  });
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: entry.text, language: 'en', idempotency_key: entry.id,
  });
  return { result, sessionStore, service };
}

function field(result, id) {
  return result.agent_state.report_fields.find((item) => item.field_id === id);
}

test('real technician narration fills independently supported report facts without inventing root cause or clock time', async (t) => {
  const entry = corpus.cases[0];
  const { result } = await capture(t, entry);
  assert.equal(result.transcript.raw_text, entry.text);
  for (const [id, expected] of Object.entries(entry.expected_fields)) {
    const actual = field(result, id);
    assert.equal(actual?.state, expected === null ? 'EXPLICIT_NONE' : 'KNOWN_VALUE', id);
    if (expected !== null) assert.equal(actual.value, expected, id);
  }
  for (const id of entry.expected_unknown) assert.equal(field(result, id)?.state, 'UNKNOWN', id);
  assert.equal(result.agent_state.validation_issues.some((issue) => issue.field_id === 'completion.state'
    && issue.code === 'CRITICAL_CONFIRMATION_REQUIRED'), true);
  assert.equal(result.agent_state.unresolved_information.find((item) => item.field_id === 'diagnosis.root_cause')?.reason,
    'AMBIGUOUS');
  assert.match(result.agent_state.resolution_queue.find((item) => item.field_id === 'diagnosis.root_cause')?.prompt || '',
    /confirmed root cause/iu);
  assert.match(result.agent_state.resolution_queue.find((item) => item.field_id === 'work.date_time')?.prompt || '',
    /exact date and time/iu);
  assert.equal(result.candidates.find((candidate) => candidate.field_id === 'test.result')?.semantic?.semantic_type,
    'TEST_OBSERVATION');
  assert.equal(result.semantic_trace.canonical_facts.find((fact) => fact.semantic_type === 'COMPLETED_ACTION'
    && fact.value === 'tightened the bracket')?.temporality, 'COMPLETED');
});

test('capture persists assertion-level trace and distinguishes unresolved evidence from absent fields', async (t) => {
  const entry = corpus.cases[0];
  const { result, sessionStore, service } = await capture(t, entry);
  const trace = result.semantic_trace;
  assert.ok(trace, 'capture must return its persisted semantic trace');
  assert.equal(trace.transcript_id, result.transcript.transcript_id);
  assert.equal(trace.pipeline_versions.ontology, 'canonical-report-facts.v1');
  assert.equal(trace.pipeline_versions.normalizer, 'contextual-transcript-normalization.v1');
  for (const assertion of trace.assertions) {
    assert.equal(entry.text.slice(assertion.start, assertion.end), assertion.text);
    assert.ok(['RESOLVED', 'PARTIALLY_RESOLVED', 'UNRESOLVED', 'NON_REPORT_CONTENT', 'AMBIGUOUS'].includes(assertion.status));
  }
  assert.ok(trace.assertions.some((item) => item.text.toLowerCase().includes('re-tested')));
  assert.ok(trace.canonical_facts.some((fact) => fact.semantic_type === 'TEST_ACTION'));
  assert.ok(trace.canonical_facts.some((fact) => fact.semantic_type === 'TEST_OBSERVATION'));
  assert.ok(trace.relationships.some((relationship) => relationship.relationship_type === 'SYMPTOM_RESOLUTION'));
  assert.equal(trace.missing_information.find((item) => item.field_id === 'asset.registration_no')?.reason, 'NOT_MENTIONED');
  assert.equal(trace.missing_information.find((item) => item.field_id === 'diagnosis.root_cause')?.reason, 'AMBIGUOUS');
  assert.equal(trace.missing_information.find((item) => item.field_id === 'work.date_time')?.reason, 'MENTIONED_BUT_INVALID');
  assert.deepEqual(await sessionStore.readRecord('semantic-traces', trace.trace_id), trace);
  const inspection = await service.getSemanticTrace(result.session.session_id);
  assert.deepEqual(inspection.semantic_trace, trace);
  assert.equal(inspection.normalization.raw_text, entry.text);
  assert.equal(inspection.normalization.normalized_text, result.transcript.normalized_text);
  assert.deepEqual(inspection.normalization.corrections, result.transcript.corrections);
  assert.deepEqual(inspection.report_state.report_fields, result.agent_state.report_fields);
  assert.deepEqual(inspection.clarification_queue, result.agent_state.resolution_queue);
  assert.equal(inspection.report_state.session_revision, result.session.revision);
  const replay = await service.replaySemanticTrace({
    session_id: result.session.session_id, transcript_id: result.transcript.transcript_id,
  });
  assert.equal(replay.replayed_trace.trace_id, trace.trace_id);
  assert.deepEqual(replay.comparison.facts_added, []);
  assert.deepEqual(replay.comparison.facts_removed, []);
  assert.deepEqual(replay.comparison.replayed_field_assignments, replay.comparison.previous_field_assignments);
});

for (const entry of corpus.cases.slice(1)) {
  test(`${entry.id} preserves supported facts and withholds misleading field fills`, async (t) => {
    const { result } = await capture(t, entry);
    for (const [id, expected] of Object.entries(entry.expected_fields)) {
      const actual = field(result, id);
      assert.equal(actual?.state, expected === null ? 'EXPLICIT_NONE' : 'KNOWN_VALUE', id);
      if (expected !== null) assert.equal(actual.value, expected, id);
    }
    for (const id of entry.expected_unknown) assert.equal(field(result, id)?.state, 'UNKNOWN', id);
    assert.ok(result.semantic_trace.canonical_facts.every((fact) =>
      entry.text.slice(fact.char_start, fact.char_end) === fact.evidence_quote));
  });
}

test('structured extraction receives unresolved semantic windows without template fields and rejects an invented technician', async (t) => {
  const entry = {
    id: 'semantic-gaps', template_id: 'bus-defect-rectification-corrective-maintenance',
    text: 'Work order 7231. I spoke to Maria. The return-air flange had a hairline crack.',
  };
  let request;
  const semanticProvider = { generateJson: async (input) => {
    request = input;
    return { provider: 'mock-semantic-provider', data: { facts: [
      { semantic_type: 'TECHNICIAN_IDENTITY', value: 'Maria', claim_kind: 'VALUE', evidence_quote: 'I spoke to Maria' },
      { semantic_type: 'INSPECTION_FINDING', value: 'hairline crack', claim_kind: 'VALUE', evidence_quote: 'The return-air flange had a hairline crack' },
      { semantic_type: 'ROOT_CAUSE', value: 'hairline crack', claim_kind: 'VALUE', evidence_quote: 'The return-air flange had a hairline crack' },
    ] } };
  } };
  const { result } = await capture(t, entry, { semanticProvider, semanticModel: 'test-model' });
  const prompt = JSON.parse(request.prompt);
  assert.ok(prompt.semantic_windows.some((window) => window.text.includes('hairline crack')));
  assert.ok(prompt.established_facts.some((fact) => fact.semantic_type === 'WORK_ORDER'));
  assert.equal(Object.hasOwn(prompt, 'template_fields'), false);
  assert.equal(field(result, 'inspection_findings').value, 'hairline crack');
  assert.equal(field(result, 'technician.name').state, 'UNKNOWN');
  assert.ok(result.semantic_trace.model.rejections.some((item) => item.reason === 'SEMANTIC_TYPE_MISMATCH'));
  assert.ok(result.semantic_trace.model.rejections.some((item) => item.reason === 'UNSUPPORTED_CAUSALITY'));
});

test('provider-independent semantic proposal contract uses the same verifier and field routing', async (t) => {
  const entry = { id: 'semantic-provider-contract', template_id: 'hvac-service-report',
    text: 'Work order 7231. The return-air flange had a hairline crack.' };
  let received;
  const semanticProvider = { name: 'mock-cloud', extractSemanticProposals: async (input) => {
    received = input;
    return { proposals: [{ semantic_type: 'INSPECTION_FINDING', value: 'hairline crack', claim_kind: 'VALUE',
      evidence_quote: 'The return-air flange had a hairline crack' }] };
  } };
  const { result } = await capture(t, entry, { semanticProvider });
  assert.ok(received.semantic_windows.some((window) => window.text.includes('hairline crack')));
  assert.equal(field(result, 'inspection_findings').value, 'hairline crack');
  assert.equal(result.semantic_trace.model.provider, 'mock-cloud');
  assert.equal(result.semantic_trace.semantic_proposals.length, 1);
});

test('semantic provider failure preserves deterministic facts and unresolved evidence', async (t) => {
  const entry = {
    id: 'semantic-provider-error', template_id: 'hvac-service-report',
    text: 'Work order 7231. The return-air flange had a hairline crack.',
  };
  const semanticProvider = { generateJson: async () => { throw Object.assign(new Error('offline'), { code: 'MODEL_UNAVAILABLE' }); } };
  const { result } = await capture(t, entry, { semanticProvider, semanticModel: 'test-model' });
  assert.equal(field(result, 'work_order').value, '7231');
  assert.equal(field(result, 'inspection_findings').state, 'UNKNOWN');
  assert.equal(result.semantic_trace.model.error, 'MODEL_UNAVAILABLE');
  assert.equal(result.semantic_trace.missing_information.find((item) => item.field_id === 'inspection_findings')?.reason,
    'EXTRACTION_FAILED');
  assert.ok(result.semantic_trace.assertions.some((item) => item.text.includes('hairline crack')
    && item.status === 'UNRESOLVED'));
});

test('same-source retry reuses the capture and canonical fact records', async (t) => {
  const entry = corpus.cases[0];
  const { result, service, sessionStore } = await capture(t, entry);
  const replayed = await service.captureText({
    session_id: result.session.session_id, expected_revision: result.session.revision,
    text: entry.text, language: 'en', idempotency_key: entry.id,
  });
  assert.equal(replayed.reused, true);
  assert.equal(replayed.session.revision, result.session.revision);
  const chain = await sessionStore.loadChain(result.session.session_id);
  assert.equal(chain.transcripts.length, 1);
  assert.equal(chain.field_candidates.length, result.candidates.length);
  assert.deepEqual((await service.getSemanticTrace(result.session.session_id)).semantic_trace, result.semantic_trace);
  for (const fact of result.semantic_trace.canonical_facts) {
    assert.deepEqual(await sessionStore.readRecord('canonical-facts', fact.fact_id), fact);
  }
});

test('applying a versioned replay supersedes legacy transcript candidates and is idempotent', async (t) => {
  const entry = corpus.cases[0];
  const { result, service, sessionStore } = await capture(t, entry);
  const work = result.candidates.find((candidate) => candidate.field_id === 'work_performed');
  const legacyCandidate = { ...work, candidate_id: 'candidate_legacy_work',
    claim: { kind: 'VALUE', value: 'tightened the bracket and re-tested' },
    extraction: { method: 'deterministic-rule', version: 'atomic-semantic-extraction.v6' } };
  await sessionStore.putRecord('field-candidates', legacyCandidate.candidate_id, legacyCandidate);
  const priorTrace = { ...result.semantic_trace, trace_id: 'trace_legacy_fixture',
    pipeline_versions: { ...result.semantic_trace.pipeline_versions, segmenter: 'semantic-assertions.v0' } };
  await sessionStore.putRecord('semantic-traces', priorTrace.trace_id, priorTrace);
  const prior = await sessionStore.recordEvent({
    session_id: result.session.session_id, expected_revision: result.session.revision,
    event_type: 'STRUCTURED_CANDIDATES_CREATED', occurred_at: '2026-09-28T06:01:00.000Z',
    details: { transcript_id: result.transcript.transcript_id, semantic_trace_id: priorTrace.trace_id,
      field_candidate_ids: [legacyCandidate.candidate_id] },
    additions: { field_candidate_ids: [legacyCandidate.candidate_id] },
  });
  const migrated = await service.applySemanticReplay({
    session_id: result.session.session_id, transcript_id: result.transcript.transcript_id,
    expected_revision: prior.session.revision,
  });
  assert.equal(migrated.reused, false);
  assert.deepEqual(migrated.superseded_field_candidate_ids, [legacyCandidate.candidate_id]);
  assert.equal(migrated.agent_state.report_fields.find((field) => field.field_id === 'work_performed').value,
    'tightened the bracket');
  assert.equal(migrated.agent_state.report_fields.find((field) => field.field_id === 'work_performed').state,
    'KNOWN_VALUE');
  const retry = await service.applySemanticReplay({
    session_id: result.session.session_id, transcript_id: result.transcript.transcript_id,
    expected_revision: prior.session.revision,
  });
  assert.equal(retry.reused, true);
  assert.equal(retry.session.revision, migrated.session.revision);
});

test('competing asset identities remain a field conflict with targeted resolution', async (t) => {
  const entry = { id: 'conflicting-buses', template_id: 'bus-defect-rectification-corrective-maintenance',
    text: 'Work order 1234. I worked on bus 204. Later I worked on bus 205.' };
  const { result } = await capture(t, entry);
  assert.equal(field(result, 'asset.internal_fleet_no').state, 'CONFLICT');
  assert.equal(result.agent_state.unresolved_information.find((item) => item.field_id === 'asset.internal_fleet_no')?.reason,
    'CONFLICTING');
  assert.equal(result.agent_state.resolution_queue.find((item) => item.field_id === 'asset.internal_fleet_no')?.type,
    'CONFLICT');
  assert.equal(result.semantic_trace.conflicts.find((item) => item.field_id === 'asset.internal_fleet_no')?.values.length, 2);
  assert.ok(result.semantic_trace.assertions.some((item) => item.status === 'AMBIGUOUS'));
});

test('temporal mapping respects schema precision and never borrows capture clock minutes', () => {
  const template = { schema: { fields: [{ id: 'work.date_time', label: 'Date / Time', precisionRequirement: 'MINUTE' }] } };
  const context = { template, captured_at: '2026-09-28T02:42:00.000Z', time_zone: 'Asia/Shanghai' };
  assert.deepEqual(deriveCaptureTimeAssignments({ ...context, raw_text: 'I worked on bus 204 this morning.' }), []);
  assert.deepEqual(deriveCaptureTimeAssignments({ ...context, raw_text: 'I finished today at 09:15.' })
    .map((item) => item.value), ['2026-09-28 09:15']);
  assert.deepEqual(deriveCaptureTimeAssignments({ ...context, raw_text: 'I finished today at 9:15 pm.' })
    .map((item) => item.value), ['2026-09-28 21:15']);
  const dayTemplate = { schema: { fields: [{ id: 'work.date_time', label: 'Date', precisionRequirement: 'DAY' }] } };
  assert.deepEqual(deriveCaptureTimeAssignments({ ...context, template: dayTemplate, raw_text: 'I worked this morning.' })
    .map((item) => item.value), ['2026-09-28']);
});

test('semantic verifier accepts supported handover semantics and rejects future or negated actions', () => {
  const handover = 'The bus is back in service.';
  const accepted = verifyStructuredFactProposals({ raw_text: handover, transcript_id: 'handover', proposals: [
    { semantic_type: 'COMPLETION_STATE', value: 'RETURNED_TO_SERVICE', claim_kind: 'VALUE', evidence_quote: handover },
  ] });
  assert.equal(accepted.facts[0]?.value, 'RETURNED_TO_SERVICE');
  const future = 'A retest is needed tomorrow.';
  const rejectedFuture = verifyStructuredFactProposals({ raw_text: future, transcript_id: 'future', proposals: [
    { semantic_type: 'TEST_ACTION', value: 'retest', claim_kind: 'VALUE', evidence_quote: future },
  ] });
  assert.equal(rejectedFuture.facts.length, 0);
  assert.equal(rejectedFuture.rejections[0]?.reason, 'TEMPORALITY_MISMATCH');
  const negated = 'The bracket was not tightened.';
  const rejectedNegation = verifyStructuredFactProposals({ raw_text: negated, transcript_id: 'negated', proposals: [
    { semantic_type: 'COMPLETED_ACTION', value: 'tightened', claim_kind: 'VALUE', evidence_quote: negated },
  ] });
  assert.equal(rejectedNegation.facts.length, 0);
  assert.equal(rejectedNegation.rejections[0]?.reason, 'TEMPORALITY_MISMATCH');
});

test('broad Post-work test and strict Test result schemas route the same test action differently', async () => {
  const facts = await extractAtomicFacts({ raw_text: 'I tested the door.', transcript_id: 'test-schema-roles' });
  const action = facts.find((fact) => fact.semantic_type === 'TEST_ACTION');
  assert.ok(action);
  const broad = routeAtomicFacts({ facts: [action], template: templateFor('bus-defect-rectification-corrective-maintenance') });
  const strict = routeAtomicFacts({ facts: [action], template: templateFor('bus-preventive-maintenance-inspection') });
  assert.equal(broad.assignments[0]?.field_id, 'test.result');
  assert.equal(strict.assignments.length, 0);
});

test('reported first-person speech cannot become the technician identity, work, test, or handover', async (t) => {
  const entry = { id: 'reported-first-person', template_id: 'bus-defect-rectification-corrective-maintenance',
    text: 'The driver said I am Alex and I re-tested, then I returned the bus to service due to a loose bracket.' };
  const { result } = await capture(t, entry);
  for (const id of ['technician.name', 'work_performed', 'test.result', 'completion.state', 'diagnosis.root_cause']) {
    assert.equal(field(result, id)?.state, 'UNKNOWN', id);
  }
});
