import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  'generated_report_first_review',
  'inline_manual_field_edit',
  'inline_field_dictation',
  'reversible_field_source_selection',
  'inline_missing_field_resolution',
  'multi_missing_detail_capture',
  'single_submit_after_review',
  'review_state_persistence',
  'mobile_inline_report_review',
];

test('the frozen P0 ReportSession dataset has complete acceptance and anti-hallucination coverage', async () => {
  const dataset = JSON.parse(await fs.readFile(new URL('../evaluation/p0-report-session-acceptance.v1.json', import.meta.url), 'utf8'));
  assert.equal(dataset.contract, 'P0ReportSessionAcceptanceDataset');
  assert.equal(dataset.version, '1.2.0');
  assert.equal(dataset.human_gold, false);
  assert.deepEqual(dataset.cases.map(({ id }) => id), EXPECTED_CASES);
  for (const scenario of dataset.cases) {
    assert.ok(scenario.input.length > 5, `${scenario.id} has a deterministic input`);
    assert.ok(scenario.preconditions.length > 0, `${scenario.id} records its preconditions`);
    assert.ok(scenario.expected_properties.length > 0, `${scenario.id} defines expected behavior`);
    assert.ok(scenario.forbidden_behavior.length > 0, `${scenario.id} defines forbidden authority behavior`);
    assert.ok(scenario.automated_evidence.length > 0, `${scenario.id} maps to automated evidence`);
    for (const relativePath of scenario.automated_evidence) {
      assert.match(relativePath, /^test\/.+\.test\.js$/u, `${scenario.id} evidence uses an exact repository-relative test path`);
      await fs.access(path.join(root, relativePath));
    }
  }
});
