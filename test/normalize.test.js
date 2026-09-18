import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHvacTranscript } from '../src/tools/normalize-hvac-transcript.js';

const transcript = { artifact_id: 'transcript_test', raw_text: '换了一个三十五微法电容' };
const knowledgeVersion = 'hvac-corrections@test';

test('preserves raw transcript when no knowledge-backed candidates exist', async () => {
  const provider = { generateJson: () => { throw new Error('must not call LLM'); } };
  const result = await normalizeHvacTranscript({ transcript, provider, knowledgeVersion, traceId: 'trace_1' });
  assert.equal(result.status, 'PASS');
  assert.equal(result.data.raw_text_unchanged, true);
  assert.deepEqual(result.data.correction_candidates, []);
});

test('only emits supplied candidates and requires critical-value confirmation', async () => {
  const source = '三十五微法';
  const start = transcript.raw_text.indexOf(source);
  const provider = {
    generateJson: async () => ({
      data: { selected_candidate_ids: ['cap-35', 'invented'] },
      provider: 'fake-ollama',
      model: 'test-model',
    }),
  };
  const result = await normalizeHvacTranscript({
    transcript,
    provider,
    model: 'test-model',
    traceId: 'trace_2',
    knowledgeVersion,
    knowledgeCandidates: [{
      candidate_id: 'cap-35',
      knowledge_version: knowledgeVersion,
      source_span: { start, end: start + source.length, text: source },
      candidate: '35 µF',
      knowledge_ids: ['term_capacitance_uf'],
      risk: 'CRITICAL_VALUE',
      reason: '含数值与单位的格式候选',
      match_basis: { knowledge_id: 'term_capacitance_uf', rule_id: 'test-rule', match_basis: 'CONTROLLED_TEST', matched_text: source },
    }],
  });
  assert.equal(result.status, 'NEEDS_CONFIRMATION');
  assert.equal(result.data.raw_text_unchanged, true);
  assert.equal(result.data.correction_candidates.length, 1);
  assert.equal(result.data.correction_candidates[0].status, 'NEEDS_TECHNICIAN_CONFIRMATION');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.data.deterministic_fallback_used, true);
  assert.equal(result.data.proposed_text, '换了一个35 µF电容');
});
