import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { candidateBundleHash } from '../src/tools/correction-integrity.js';
import { extractServiceFacts } from '../src/tools/extract-service-facts.js';
import { buildTranscriptCorrectionCandidates } from '../src/tools/hvac-knowledge.js';
import { normalizeHvacTranscript } from '../src/tools/normalize-hvac-transcript.js';

function decisionsFor(candidates, { accept = true, confirmCritical = true } = {}) {
  return candidates.map((candidate) => ({
    candidate_id: candidate.candidate_id,
    decision: accept ? 'ACCEPT' : 'REJECT',
    critical_value_confirmed: confirmCritical,
  }));
}

async function setup(name, rawText) {
  const root = path.resolve('.tmp-tests', name);
  await fs.rm(root, { recursive: true, force: true });
  const store = new ArtifactStore({ root });
  const transcript = await store.putManualTranscript({ raw_text: rawText });
  const knowledge = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
  const candidatesHash = candidateBundleHash({ transcriptArtifactId: transcript.artifact_id, rawText: transcript.raw_text, knowledgeVersion: knowledge.knowledge_version, candidates: knowledge.candidates });
  return { root, store, transcript, knowledge, candidatesHash };
}

test('controlled HVAC typo is proposed, technician-confirmed, and used for facts without overwriting raw text', async (t) => {
  const context = await setup('correction-valid', '客户反映不制冷。检查发现运刑电容损坏。更换了一个三十五微法电容。试机运行正常。问题已解决。');
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  assert.equal(context.knowledge.candidates.length, 2);
  assert.ok(context.knowledge.candidates.every((item) => item.match_basis.rule_id && item.knowledge_version === context.knowledge.knowledge_version));
  const normalized = await normalizeHvacTranscript({
    transcript: context.transcript,
    knowledgeCandidates: context.knowledge.candidates,
    knowledgeVersion: context.knowledge.knowledge_version,
    traceId: 'trace_controlled_normalization',
  });
  assert.match(normalized.data.proposed_text, /运行电容/);
  assert.match(normalized.data.proposed_text, /35 µF/);
  assert.equal((await context.store.readTranscript(context.transcript.artifact_id)).raw_text, context.transcript.raw_text);

  const receipt = await context.store.putCorrectionReceipt({
    transcriptArtifactId: context.transcript.artifact_id,
    knowledgeVersion: context.knowledge.knowledge_version,
    candidates: context.knowledge.candidates,
    candidatesHash: normalized.data.candidate_bundle_hash,
    decisions: decisionsFor(context.knowledge.candidates),
    technicianId: 'TECH-1',
    technicianName: '陈师傅',
  });
  assert.match(receipt.final_text, /运行电容/);
  assert.match(receipt.final_text, /35 µF/);
  const extracted = await extractServiceFacts({
    transcript: { ...context.transcript, raw_text: receipt.final_text },
    correctionReceipt: receipt,
    confirmedCorrections: receipt.decisions,
    traceId: 'trace_corrected_facts',
  });
  assert.equal(extracted.status, 'PASS');
  assert.ok(extracted.data.facts.some((fact) => fact.source_refs.includes(`correction_receipt:${receipt.correction_receipt_id}`)));
  const factsReceipt = await context.store.putFacts({ correctionReceipt: receipt, facts: extracted.data.facts });
  assert.equal(factsReceipt.correction_receipt_hash, receipt.correction_receipt_hash);
});

test('no candidate still produces an immutable original-text confirmation receipt', async (t) => {
  const context = await setup('correction-none', '客户反映不制冷。');
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  assert.deepEqual(context.knowledge.candidates, []);
  const receipt = await context.store.putCorrectionReceipt({
    transcriptArtifactId: context.transcript.artifact_id,
    knowledgeVersion: context.knowledge.knowledge_version,
    candidates: [],
    candidatesHash: context.candidatesHash,
    decisions: [],
    technicianId: 'TECH-2',
    technicianName: '李师傅',
  });
  assert.equal(receipt.final_text, context.transcript.raw_text);
  assert.equal(receipt.decisions.length, 0);
  assert.deepEqual(await context.store.readCorrectionReceipt(receipt.correction_receipt_id, {
    expectedKnowledgeVersion: context.knowledge.knowledge_version,
    expectedCandidates: [],
  }), receipt);
});

test('unknown candidate injection and unreviewed critical value are rejected', async (t) => {
  const context = await setup('correction-rejections', '更换了一个三十五微法电容。');
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  assert.equal(context.knowledge.candidates.length, 1);
  await assert.rejects(context.store.putCorrectionReceipt({
    transcriptArtifactId: context.transcript.artifact_id,
    knowledgeVersion: context.knowledge.knowledge_version,
    candidates: context.knowledge.candidates,
    decisions: decisionsFor(context.knowledge.candidates),
    technicianId: 'TECH-3',
    technicianName: '王师傅',
  }), { code: 'CANDIDATE_BUNDLE_MISMATCH' });
  await assert.rejects(context.store.putCorrectionReceipt({
    transcriptArtifactId: context.transcript.artifact_id,
    knowledgeVersion: context.knowledge.knowledge_version,
    candidates: context.knowledge.candidates,
    candidatesHash: context.candidatesHash,
    decisions: [{ candidate_id: 'candidate_injected', decision: 'ACCEPT', critical_value_confirmed: true }],
    technicianId: 'TECH-3',
    technicianName: '王师傅',
  }), { code: 'UNKNOWN_CORRECTION_CANDIDATE' });
  await assert.rejects(context.store.putCorrectionReceipt({
    transcriptArtifactId: context.transcript.artifact_id,
    knowledgeVersion: context.knowledge.knowledge_version,
    candidates: context.knowledge.candidates,
    candidatesHash: context.candidatesHash,
    decisions: decisionsFor(context.knowledge.candidates, { confirmCritical: false }),
    technicianId: 'TECH-3',
    technicianName: '王师傅',
  }), { code: 'CRITICAL_CORRECTION_UNCONFIRMED' });
});

test('tampered receipt and candidate reuse across another transcript are rejected', async (t) => {
  const context = await setup('correction-tamper', '检查发现运刑电容损坏。');
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  const receipt = await context.store.putCorrectionReceipt({
    transcriptArtifactId: context.transcript.artifact_id,
    knowledgeVersion: context.knowledge.knowledge_version,
    candidates: context.knowledge.candidates,
    candidatesHash: context.candidatesHash,
    decisions: decisionsFor(context.knowledge.candidates),
    technicianId: 'TECH-4',
    technicianName: '赵师傅',
  });
  const second = await context.store.putManualTranscript({ raw_text: '另一份无关原文。' });
  await assert.rejects(context.store.readCorrectionReceipt(receipt.correction_receipt_id, {
    expectedKnowledgeVersion: 'hvac-corrections@stale-version',
  }), { code: 'CORRECTION_KNOWLEDGE_VERSION_MISMATCH' });
  await assert.rejects(context.store.putCorrectionReceipt({
    transcriptArtifactId: second.artifact_id,
    knowledgeVersion: context.knowledge.knowledge_version,
    candidates: context.knowledge.candidates,
    candidatesHash: context.candidatesHash,
    decisions: decisionsFor(context.knowledge.candidates, { accept: false }),
    technicianId: 'TECH-4',
    technicianName: '赵师傅',
  }), { code: 'INVALID_CONTROLLED_CORRECTION_CANDIDATE' });

  const file = path.join(context.store.correctionRoot, `${receipt.correction_receipt_id}.json`);
  const tampered = JSON.parse(await fs.readFile(file, 'utf8'));
  tampered.final_text += '已额外加氟并报价500元。';
  await fs.writeFile(file, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(context.store.readCorrectionReceipt(receipt.correction_receipt_id), { code: 'CORRECTION_RECEIPT_TAMPERED' });
});

test('hallucinated model rewrite is discarded in favor of controlled deterministic candidates', async () => {
  const rawText = '检查发现运刑电容损坏。';
  const knowledge = await buildTranscriptCorrectionCandidates({ rawText });
  const result = await normalizeHvacTranscript({
    transcript: { artifact_id: 'transcript_model_test', raw_text: rawText },
    knowledgeCandidates: knowledge.candidates,
    knowledgeVersion: knowledge.knowledge_version,
    provider: { generateJson: async () => ({
      provider: 'fake',
      model: 'fake',
      data: { selected_candidate_ids: ['candidate_invented'], rewritten_text: '已完成安全测试，报价500元。' },
    }) },
    model: 'server-model',
    traceId: 'trace_hallucination',
  });
  assert.equal(result.data.deterministic_fallback_used, true);
  assert.equal(result.data.proposed_text, '检查发现运行电容损坏。');
  assert.doesNotMatch(result.data.proposed_text, /安全测试|500/);
  assert.ok(result.warnings.some((warning) => warning.includes('discarded')));
});

test('facts persistence requires a verified correction receipt', async (t) => {
  const context = await setup('facts-requires-correction', '客户反映不制冷。');
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  await assert.rejects(context.store.putFacts({ facts: [] }), { code: 'INVALID_CORRECTION_RECEIPT_ID' });
  const server = await fs.readFile('src/server.js', 'utf8');
  assert.match(server, /correction_receipt_id/);
  assert.match(server, /CORRECTION_RECEIPT_REQUIRED/);
  assert.doesNotMatch(server, /putFacts\(\{\s*transcriptArtifactId/);
});
