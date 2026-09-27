import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashContract } from '../src/domain/index.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

const corpus = JSON.parse(await fs.readFile(new URL('../evaluation/semantic-routing-frozen.v1.json', import.meta.url), 'utf8'));

function caseByLetter(letter) {
  const entry = corpus.cases.find((item) => item.id.startsWith(`${letter}-`));
  assert.ok(entry, `missing frozen corpus case ${letter}`);
  return entry;
}

async function workflow(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-routing-corpus-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'authority') });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore,
    whisperProvider: { transcribe: async () => { throw new Error('Unexpected audio transcription.'); } },
    clock: () => '2026-09-27T06:00:00.000Z',
  });
  return { service, sessionStore };
}

async function createSession(service, entry) {
  return service.createSession({
    template_id: entry.template_id,
    template_version: '1.0.0',
    job_context_ref: `semantic-corpus:${entry.id}`,
  });
}

function fieldOf(result, fieldId) {
  const field = result.agent_state.report_fields.find((item) => item.field_id === fieldId);
  assert.ok(field, `missing report field ${fieldId}`);
  return field;
}

async function captureTextAndContinue(service, session, text, idempotencyKey) {
  const captured = await service.captureText({
    session_id: session.session_id,
    expected_revision: session.revision,
    text,
    language: 'en',
    idempotency_key: idempotencyKey,
  });
  if (captured.next_action !== 'REVIEW_TRANSCRIPT') return captured;
  return service.decideTranscriptReview({
    session_id: session.session_id,
    expected_revision: captured.session.revision,
    review_id: captured.review.review_id,
    decisions: captured.review.items.map((item) => ({ review_item_id: item.review_item_id, decision: 'NO_CHANGE' })),
  });
}

test('T multiple frozen captures accumulate in one authoritative ReportSession with distinct transcript provenance', async (t) => {
  const entry = caseByLetter('T');
  assert.equal(entry.captures.length, 3);
  const { service, sessionStore } = await workflow(t);
  const created = await createSession(service, entry);
  let current = created;
  const transcriptIds = [];
  for (const [index, text] of entry.captures.entries()) {
    current = await captureTextAndContinue(service, current.session, text, `${entry.id}:capture:${index}`);
    transcriptIds.push(current.transcript.transcript_id);
  }

  assert.equal(current.session.session_id, created.session.session_id);
  assert.deepEqual(current.session.transcript_ids, transcriptIds);
  assert.equal(new Set(transcriptIds).size, entry.captures.length);
  for (const expected of entry.expected) {
    const field = fieldOf(current, expected.field_id);
    assert.equal(field.value, expected.value, `${expected.field_id} must retain its own captured fact`);
    assert.equal(field.candidates.some((candidate) => candidate.claim.value === expected.value
      && candidate.evidence_refs.some((ref) => transcriptIds.includes(ref.evidence_id))), true);
  }
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.deepEqual(chain.transcripts.map((transcript) => transcript.raw_text), entry.captures);
});

test('V manual typed evidence uses the real text capture path and remains technician evidence', async (t) => {
  const entry = caseByLetter('V');
  assert.equal(entry.input_mode, 'MANUAL_TEXT');
  const { service, sessionStore } = await workflow(t);
  const created = await createSession(service, entry);
  const captured = await captureTextAndContinue(service, created.session, entry.input, `${entry.id}:capture`);

  assert.equal(captured.evidence.evidence_type, 'MANUAL_INPUT');
  assert.equal(captured.transcript.raw_text, entry.input);
  assert.equal(captured.transcript.provider, 'technician-text');
  assert.equal(captured.candidates.find((candidate) => candidate.field_id === 'work_performed')?.support_type, 'MANUAL_TECHNICIAN_INPUT');
  assert.equal(fieldOf(captured, 'work_performed').value, entry.expected[0].value);
  assert.equal((await sessionStore.loadChain(created.session.session_id)).transcripts[0].raw_text, entry.input);
});

test('W transcript correction is applied through review while immutable raw words remain available', async (t) => {
  const entry = caseByLetter('W');
  const { service, sessionStore } = await workflow(t);
  const created = await createSession(service, entry);
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: entry.input,
    language: 'en',
    idempotency_key: `${entry.id}:capture`,
  });

  assert.equal(captured.next_action, 'REVIEW_TRANSCRIPT');
  const correction = captured.review.items.find((item) => item.kind === 'CORRECTION');
  assert.ok(correction, 'frozen W input must exercise an actual transcript correction');
  const decided = await service.decideTranscriptReview({
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    review_id: captured.review.review_id,
    decisions: captured.review.items.map((item) => ({
      review_item_id: item.review_item_id,
      decision: item.review_item_id === correction.review_item_id ? 'ACCEPT' : 'NO_CHANGE',
    })),
  });
  assert.equal(decided.transcript.raw_text, entry.input);
  assert.equal(decided.review.effective_projection_hash, hashContract(entry.effective_input));
  assert.equal(fieldOf(decided, 'asset.bus_model').value, 'MAN A95');
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(chain.transcripts[0].raw_text, entry.input);
  assert.ok(decided.candidates.some((candidate) => candidate.correction_provenance?.transcript_review_id === decided.review.review_id));
});

test('X manual selection supersedes the prior AI value while preserving both candidates and unrelated fields', async (t) => {
  const entry = caseByLetter('X');
  const { service, sessionStore } = await workflow(t);
  const created = await createSession(service, entry);
  const captured = await captureTextAndContinue(service, created.session, entry.input, `${entry.id}:capture`);
  const before = fieldOf(captured, entry.manual_selection.field_id);
  assert.equal(before.value, entry.expected[0].value);
  const unrelatedBefore = captured.agent_state.report_fields
    .filter((field) => field.field_id !== entry.manual_selection.field_id)
    .map((field) => [field.field_id, field.state, field.value]);

  const selected = await service.selectFieldRepresentation({
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    field_id: entry.manual_selection.field_id,
    selection: { kind: 'MANUAL', value: entry.manual_selection.value },
    idempotency_key: `${entry.id}:manual-selection`,
  });
  const after = fieldOf(selected, entry.manual_selection.field_id);
  assert.equal(after.state, 'KNOWN_VALUE');
  assert.equal(after.value, entry.manual_selection.value);
  assert.equal(after.candidates.some((candidate) => candidate.claim.value === entry.expected[0].value), true);
  assert.equal(after.candidates.some((candidate) => candidate.claim.value === entry.manual_selection.value), true);
  assert.ok(after.superseded_candidate_ids.length > 0);
  assert.equal(selected.agent_state.resolution_queue.some((item) => item.field_id === entry.manual_selection.field_id), false);
  assert.deepEqual(selected.agent_state.report_fields
    .filter((field) => field.field_id !== entry.manual_selection.field_id)
    .map((field) => [field.field_id, field.state, field.value]), unrelatedBefore);

  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(chain.transcripts[0].raw_text, entry.input);
  assert.equal(fieldOf({ agent_state: chain.agent_state }, entry.manual_selection.field_id).value, entry.manual_selection.value);
});

test('Z contradictory outcomes remain an explicit field conflict in authoritative state', async (t) => {
  const entry = caseByLetter('Z');
  const { service, sessionStore } = await workflow(t);
  const created = await createSession(service, entry);
  const captured = await captureTextAndContinue(service, created.session, entry.input, `${entry.id}:capture`);
  const field = fieldOf(captured, entry.expected_field_state.field_id);

  assert.equal(field.state, entry.expected_field_state.state);
  assert.deepEqual(new Set(field.candidates.map((candidate) => candidate.claim.value)), new Set(entry.expected.map((item) => item.value)));
  assert.equal(captured.agent_state.resolution_queue.some((item) => item.field_id === entry.expected_field_state.field_id), true);
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(chain.transcripts[0].raw_text, entry.input);
  for (const candidate of field.candidates) {
    const spanId = candidate.evidence_refs[0]?.span_id;
    const span = chain.evidence_spans.find((item) => item.span_id === spanId);
    assert.ok(span, `candidate ${candidate.candidate_id} needs an immutable evidence span`);
    assert.equal(span.evidence_id, captured.transcript.transcript_id);
    assert.match(entry.input.slice(span.start_offset, span.end_offset), new RegExp(String(candidate.claim.value), 'iu'));
  }
});
