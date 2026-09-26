import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { distance, errorRate, setCounts, scores, aggregateFieldScores, categoryHits } from '../evaluation/component-metrics.js';
import { correctionAdapter, factsAdapter, missingAdapter } from '../evaluation/component-adapters.js';

const manifest = JSON.parse(await fs.readFile(new URL('../evaluation/synthetic-cases.v1.json', import.meta.url)));
const fixtures = JSON.parse(await fs.readFile(new URL('../evaluation/component-fixtures.v1.json', import.meta.url)));

test('component fixtures bind to unique synthetic cases and all five scopes', () => {
  const ids = new Set(manifest.cases.map((item) => item.case_id));
  assert.equal(ids.size, 15);
  assert.deepEqual(new Set(manifest.cases.map((item) => item.scope)), new Set(['HVAC', 'SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID']));
  for (const id of ids) assert.ok(Array.isArray(fixtures.fact_fields[id]), id);
  for (const item of [...fixtures.correction, ...fixtures.missing]) assert.ok(ids.has(item.case_id), item.case_id);
  assert.equal(fixtures.label_status, 'SYNTHETIC_SEED_ONLY');
});

test('WER and CER use edit distance with a fixed normalization', () => {
  assert.equal(distance(['a', 'b'], ['a', 'c']), 1);
  assert.equal(errorRate('A B C', 'a b X'), 1 / 3);
  assert.equal(errorRate('AC-104', 'AC 105', 'character'), 1 / 5);
  assert.deepEqual(categoryHits('SG3050Z brake 6.2 bar', ['SG3050Z', '6.2 bar', 'MAN A95']), { matched: 2, total: 3, missed: ['MAN A95'] });
  assert.equal(categoryHits('Bus SG 3050 Z passed', ['SG3050Z'], 'equipment_id').matched, 1);
});

test('set scoring counts errors and does not average away hard failures', () => {
  const counts = setCounts(['a', 'b'], ['a', 'c']);
  assert.deepEqual(counts, { tp: 1, fp: 1, fn: 1 });
  assert.equal(scores(counts).f1, 0.5);
  const summary = aggregateFieldScores([{ status: 'RUN', counts }, { status: 'NOT_RUN' }]);
  assert.equal(summary.cases, 1);
  assert.equal(summary.micro.f1, 0.5);
});

test('correction adapter uses existing scoped modules and reports unsupported scopes', async () => {
  for (const fixture of fixtures.correction) {
    const scope = manifest.cases.find((item) => item.case_id === fixture.case_id).scope;
    const result = await correctionAdapter(scope, fixture.raw_text, fixture.case_id);
    assert.equal(result.text, fixture.expected_text, fixture.case_id);
  }
  assert.equal(await correctionAdapter('OILFIELD', 'test', 'fixture'), null);
});

test('facts use fixed reference independently of ASR and missing fields use fixed facts', async () => {
  const hvac = await factsAdapter('HVAC', 'At fictional unit AC 104, I cleared the drain line.', 'fixture');
  assert.equal(hvac.status, 'PASS');
  const missing = fixtures.missing.find((item) => item.case_id === 'HVAC-NORMAL-001');
  const result = await missingAdapter('HVAC', missing.facts, missing.case_id);
  assert.deepEqual(result.missing, missing.expected);
});

test('dry-run CLI keeps ASR unscored and writes a provisional, isolated result contract', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'component-eval-contract-'));
  try {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/evaluate-components.js', import.meta.url)), '--dry-run', '--case', 'SBS-BUS-TERM-002', '--output', output]);
    const report = JSON.parse(await fs.readFile(path.join(output, 'component-results.json')));
    assert.equal(report.label_status, 'PROVISIONAL_SYNTHETIC_SEED');
    assert.equal(report.frozen_gold, false);
    assert.deepEqual(report.results.map((item) => [item.component, item.status]), [['asr', 'NOT_RUN'], ['correction', 'RUN'], ['facts', 'RUN'], ['missing', 'NOT_RUN']]);
    assert.equal(report.results.find((item) => item.component === 'facts').input.reference_text, manifest.cases.find((item) => item.case_id === 'SBS-BUS-TERM-002').standard_text);
    assert.ok((await fs.readFile(path.join(output, 'component-results.md'), 'utf8')).includes('Hard gate failures'));
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
