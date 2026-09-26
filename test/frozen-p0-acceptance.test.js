import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const EXPECTED_CASES = [
  'mostly_complete_sbs_bus',
  'multi_field_dictation',
  'explicit_none',
  'identity_conflict',
  'uncertain_measurement',
  'root_cause_unknown',
  'planned_work',
  'negation',
  'rag_guidance',
  'safety_confirmation',
  'stt_failure',
  'upload_failure',
  'stale_concurrent_answer',
  'stale_confirmation',
  'successful_confirmation_export',
];

test('the frozen P0 ReportSession dataset has complete acceptance and anti-hallucination coverage', async () => {
  const dataset = JSON.parse(await fs.readFile(new URL('../evaluation/p0-report-session-acceptance.v1.json', import.meta.url), 'utf8'));
  assert.equal(dataset.contract, 'P0ReportSessionAcceptanceDataset');
  assert.equal(dataset.version, '1.0.0');
  assert.deepEqual(dataset.cases.map(({ id }) => id), EXPECTED_CASES);
  for (const scenario of dataset.cases) {
    assert.ok(scenario.input.length > 5, `${scenario.id} has a deterministic input`);
    assert.ok(scenario.preconditions.length > 0, `${scenario.id} records its preconditions`);
    assert.ok(scenario.expected_properties.length > 0, `${scenario.id} defines expected behavior`);
    assert.ok(scenario.forbidden_behavior.length > 0, `${scenario.id} defines forbidden authority behavior`);
    assert.ok(scenario.automated_evidence.length > 0, `${scenario.id} maps to automated evidence`);
  }
});
