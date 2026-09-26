import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runRag, runReports, ragScores, scoreV2Report } from '../evaluation/batch3-core.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'evaluation/synthetic-cases.v1.json')));
const fixtures = JSON.parse(await fs.readFile(path.join(root, 'evaluation/batch3-fixtures.v1.json')));

test('RAG score uses stable IDs and a fixed top-three denominator', () => {
  assert.deepEqual(ragScores(['a', 'b'], [{ chunk_id: 'x' }, { chunk_id: 'b' }, { chunk_id: 'a' }]), { hit_at_3: 1, recall_at_3: 1, precision_at_3: 2 / 3, mrr_at_3: 1 / 2, relevant_total: 2, relevant_found: 2 });
  assert.equal(ragScores(['a'], [{ chunk_id: 'x' }]).hit_at_3, 0);
});

test('all five scopes invoke real retrieval without cross-scope hits', async () => {
  const selected = manifest.cases.filter((entry) => entry.scenario === 'normal');
  const output = await runRag({ root, cases: selected, fixtures });
  assert.equal(output.results.length, 5);
  for (const result of output.results) {
    assert.equal(result.status, 'RUN', JSON.stringify(result));
    assert.ok(result.prediction.hits.every((hit) => hit.scope_id === result.scope && hit.provenance.scope_id === result.scope));
    assert.deepEqual(result.hard_gate_failures, []);
  }
});

test('report runner uses fixed seed facts, fixed context and leaves unfilled sections visible', async () => {
  const selected = manifest.cases.filter((entry) => entry.scenario === 'normal');
  const output = await runReports({ root, cases: selected, fixtures });
  assert.equal(output.results.length, 5);
  for (const result of output.results) {
    assert.equal(result.status, 'RUN', JSON.stringify(result));
    assert.ok(result.input.retrieval_context.length > 0);
    assert.equal(result.metrics.fact_value_coverage, 1);
    assert.equal(result.metrics.unsupported_claim_count, 0);
    assert.ok(result.metrics.required_section_populated < 1);
  }
});

test('report scorer separates untraceable claims and knowledge-driven action promotion', () => {
  const facts = [{ fact_id: 'f1', field: 'asset.registration_no', value: 'SG3050Z', support_status: 'DIRECT_TRANSCRIPT', source: 'seed' }];
  const draft = { sections: [{ id: 'vehicle_identification', content: ['Vehicle: SG3050Z.'] }, { id: 'work_performed', content: ['Replaced door motor based on manual.'] }] };
  const result = scoreV2Report({ scope: 'SBS_BUS', facts, draft, receipt: 'seed' });
  assert.equal(result.metrics.unsupported_claim_count, 1);
  assert.ok(result.hard_gate_failures.some((gate) => gate.class === 'UNSUPPORTED_SERVICE_FACT_PROMOTION'));
});
