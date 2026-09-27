import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { distance, errorRate, setCounts, scores, aggregateFieldScores, aggregateFactValueScores, scoreFactValues, categoryHits } from '../evaluation/component-metrics.js';
import { correctionAdapter, factsAdapter, missingAdapter } from '../evaluation/component-adapters.js';

const manifest = JSON.parse(await fs.readFile(new URL('../evaluation/synthetic-cases.v1.json', import.meta.url)));
const fixtures = JSON.parse(await fs.readFile(new URL('../evaluation/component-fixtures.v1.json', import.meta.url)));

test('component fixtures bind to unique synthetic cases and all five scopes', () => {
  const ids = new Set(manifest.cases.map((item) => item.case_id));
  assert.equal(ids.size, 15);
  assert.deepEqual(new Set(manifest.cases.map((item) => item.scope)), new Set(['HVAC', 'SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID']));
  for (const id of ids) assert.ok(Array.isArray(fixtures.fact_fields[id]), id);
  for (const id of ids) assert.ok(Array.isArray(fixtures.fact_value_targets[id]), id);
  for (const item of [...fixtures.correction, ...fixtures.missing]) assert.ok(ids.has(item.case_id), item.case_id);
  assert.deepEqual(
    new Set(Object.values(fixtures.fact_value_targets).flat().map((target) => target.kind)),
    new Set(['equipment_id', 'number_unit', 'action', 'negation', 'completion']),
  );
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

test('fact-value scoring keeps typed values separate from field-presence F1', () => {
  const targets = [
    { kind: 'equipment_id', field: 'asset.registration_no', value: 'SG3050Z' },
    { kind: 'number_unit', field: 'measurement.pressure', value: '6.2', unit: 'bar' },
    { kind: 'action', field: 'parts.replaced', value: 'true' },
    { kind: 'completion', field: 'completion.state', value: 'completed' },
    { kind: 'negation', prohibited: [{ kind: 'action', field: 'work_performed', value: 'steering', match: 'contains' }] },
  ];
  const facts = [
    { field: 'asset.registration_no', value: 'SG 3050 Z' },
    { field: 'measurement.pressure', value: '6.20', unit: 'bar' },
    { field: 'parts.replaced', value: 'true' },
    { field: 'completion.state', value: 'completed' },
  ];
  const result = scoreFactValues(targets, facts);
  assert.deepEqual(result.counts, { tp: 4, fp: 0, fn: 0 });
  assert.equal(result.metrics.f1, 1);
  assert.equal(result.negation.correct, 1);
  assert.equal(result.target_results.filter((target) => !target.passed).length, 0);

  const unsafe = scoreFactValues(targets, [...facts, { field: 'work_performed', value: 'adjusted the steering' }]);
  assert.equal(unsafe.negation.correct, 0);
  assert.equal(unsafe.negation.violations[0].violations[0].field, 'work_performed');
  const summary = aggregateFactValueScores([{ status: 'RUN', value_scores: result }, { status: 'NOT_RUN' }]);
  assert.equal(summary.micro.f1, 1);
  assert.equal(summary.negation.accuracy, 1);
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
    const factResult = report.results.find((item) => item.component === 'facts');
    assert.ok(factResult.value_scores);
    assert.ok(Array.isArray(factResult.expected.value_targets));
    assert.ok(report.summary.facts.SBS_BUS.value_scores);
    assert.ok((await fs.readFile(path.join(output, 'component-results.md'), 'utf8')).includes('Hard gate failures'));
    assert.ok((await fs.readFile(path.join(output, 'component-results.md'), 'utf8')).includes('Value-level micro P/R/F1'));
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
