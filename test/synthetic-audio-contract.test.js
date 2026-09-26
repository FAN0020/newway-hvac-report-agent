import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(fs.readFileSync(new URL('../evaluation/synthetic-cases.v1.json', import.meta.url)));
const scopes = ['HVAC', 'SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID'];
const scenarios = ['normal', 'confusable_term', 'negation_missing'];

function run(...args) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/generate-synthetic-audio.js', import.meta.url)), ...args], { encoding: 'utf8' });
}

test('manifest validates against scope registry and knowledge IDs without audio tools', () => {
  const result = run('--validate');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /15 SYNTHETIC seed cases/);
  assert.equal(new Set(manifest.cases.map((x) => x.case_id)).size, 15);
  for (const scope of scopes) for (const scenario of scenarios) {
    assert.equal(manifest.cases.filter((x) => x.scope === scope && x.scenario === scenario).length, 1);
  }
});

test('dry run selects stable cases and does not synthesize', () => {
  const result = run('--dry-run', '--case', 'HVAC-NORMAL-001');
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.label, 'SYNTHETIC');
  assert.deepEqual(plan.cases.map((x) => x.case_id), ['HVAC-NORMAL-001']);
  assert.equal(plan.cases[0].wav, 'HVAC-NORMAL-001.wav');
});

test('unknown case fails before audio generation', () => {
  const result = run('--dry-run', '--case', 'UNKNOWN-001');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown --case ID/);
});

test('blank annotation cannot be mistaken for frozen Gold', () => {
  const blank = JSON.parse(fs.readFileSync(new URL('../evaluation/ground-truth.blank.v1.json', import.meta.url)));
  assert.equal(blank.synthetic, true);
  assert.equal(blank.human_review_status, 'unreviewed');
  assert.equal(blank.frozen_gold, false);
  assert.equal(blank.annotation.verbatim_transcript, null);
});
