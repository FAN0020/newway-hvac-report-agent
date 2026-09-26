import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { candidateBundleHash } from '../src/tools/correction-integrity.js';
import { buildTranscriptCorrectionCandidates } from '../src/tools/hvac-knowledge.js';
import { pcmWav } from './helpers.js';

const root = path.resolve('.tmp-tests', 'artifacts');

test('stores content-addressed audio and immutable idempotent transcript', async (t) => {
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore({ root });
  const firstAudio = await store.putAudio(pcmWav());
  const secondAudio = await store.putAudio(pcmWav());
  assert.equal(firstAudio.audio_id, secondAudio.audio_id);
  assert.match(firstAudio.source_hash, /^sha256:[a-f0-9]{64}$/);

  const input = { audio_id: firstAudio.audio_id, raw_text: '换了一个三十五微法电容', language: 'zh', provider: 'fake', model: 'test', segments: [] };
  const artifact = await store.putTranscript(input, { idempotencyKey: 'same-call' });
  const repeated = await store.putTranscript({ ...input, raw_text: '不应覆盖' }, { idempotencyKey: 'same-call' });
  assert.equal(repeated.artifact_id, artifact.artifact_id);
  assert.equal(repeated.raw_text, input.raw_text);
  assert.deepEqual(await store.readTranscript(artifact.artifact_id), artifact);
});

test('manual transcript is immutable and explicitly labelled manual', async (t) => {
  const manualRoot = path.resolve('.tmp-tests', 'manual-artifact');
  await fs.rm(manualRoot, { recursive: true, force: true });
  t.after(() => fs.rm(manualRoot, { recursive: true, force: true }));
  const store = new ArtifactStore({ root: manualRoot });
  const artifact = await store.putManualTranscript({ raw_text: '换了一个35微法电容。', language: 'zh' }, { idempotencyKey: 'manual-one' });
  assert.equal(artifact.provider, 'manual');
  assert.equal(artifact.model, 'manual-entry');
  assert.equal(artifact.audio_id, null);
  assert.equal(artifact.input_mode, 'MANUAL_TRANSCRIPT');
  const repeated = await store.putManualTranscript({ raw_text: '不应覆盖。', language: 'zh' }, { idempotencyKey: 'manual-one' });
  assert.equal(repeated.raw_text, artifact.raw_text);
});

test('edited transcript records the immutable source artifact it was derived from', async (t) => {
  const editRoot = path.resolve('.tmp-tests', 'edited-artifact');
  await fs.rm(editRoot, { recursive: true, force: true });
  t.after(() => fs.rm(editRoot, { recursive: true, force: true }));
  const store = new ArtifactStore({ root: editRoot });
  const original = await store.putTranscript({
    audio_id: 'audio_voice',
    raw_text: 'Replaced a thirty five microfarad capacitor.',
    language: 'en',
    provider: 'fake',
    model: 'test',
    segments: [],
    source_hash: 'sha256:voice',
    input_mode: 'VOICE_TRANSCRIPT',
  }, { idempotencyKey: 'voice-original' });
  const edited = await store.putManualTranscript({
    raw_text: 'Replaced a 35 µF capacitor.',
    language: 'en',
    input_mode: 'EDITED_TRANSCRIPT',
    edited_from_artifact_id: original.artifact_id,
  }, { idempotencyKey: 'voice-edited' });

  assert.equal(edited.input_mode, 'EDITED_TRANSCRIPT');
  assert.equal(edited.edited_from_artifact_id, original.artifact_id);
  assert.equal((await store.readTranscript(original.artifact_id)).raw_text, original.raw_text);
  await assert.rejects(store.putManualTranscript({
    raw_text: 'Unbound edit',
    input_mode: 'EDITED_TRANSCRIPT',
    edited_from_artifact_id: 'transcript_000000000000000000000000',
  }), { code: 'TRANSCRIPT_NOT_FOUND' });
});

test('facts are persisted as an integrity-checked receipt bound to a transcript', async (t) => {
  const factRoot = path.resolve('.tmp-tests', 'fact-receipt');
  await fs.rm(factRoot, { recursive: true, force: true });
  t.after(() => fs.rm(factRoot, { recursive: true, force: true }));
  const store = new ArtifactStore({ root: factRoot });
  const transcript = await store.putManualTranscript({ raw_text: '换了一个35微法电容。' });
  const knowledge = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
  const correctionReceipt = await store.putCorrectionReceipt({
    transcriptArtifactId: transcript.artifact_id,
    knowledgeVersion: knowledge.knowledge_version,
    candidates: knowledge.candidates,
    candidatesHash: candidateBundleHash({ transcriptArtifactId: transcript.artifact_id, rawText: transcript.raw_text, knowledgeVersion: knowledge.knowledge_version, candidates: knowledge.candidates }),
    decisions: [],
    technicianId: 'TEST-1',
    technicianName: '测试技师',
  });
  const facts = [{ fact_id: 'fact_demo', field: 'parts_used', value: { name: '电容' }, source_refs: ['transcript:0-10'], source_span: { start: 0, end: 10, text: '换了一个35微法电' }, support_status: 'DIRECT_TRANSCRIPT' }];
  const receipt = await store.putFacts({ correctionReceipt, facts });
  const repeated = await store.putFacts({ correctionReceipt, facts });
  assert.match(receipt.facts_receipt_id, /^facts_[a-f0-9]{24}$/);
  assert.equal(repeated.facts_receipt_id, receipt.facts_receipt_id);
  assert.deepEqual((await store.readFacts(receipt.facts_receipt_id)).facts, facts);
  assert.equal(receipt.correction_receipt_id, correctionReceipt.correction_receipt_id);
  await assert.rejects(store.readFacts('../../escape'), { code: 'INVALID_FACTS_RECEIPT_ID' });
});
