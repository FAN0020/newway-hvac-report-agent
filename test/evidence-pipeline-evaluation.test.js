import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { evaluateEvidencePipelines } from '../evaluation/evidence-pipeline-evaluation.js';
import { interpretEvidence } from '../src/tools/interpret-evidence.js';

const fixture = JSON.parse(await fs.readFile(new URL('../evaluation/evidence-pipeline-frozen.v1.json', import.meta.url), 'utf8'));

test('frozen evidence comparison covers grounding, conflicts, provenance, retrieval, and completeness', async () => {
  assert.equal(fixture.schema_version, 'evidence-pipeline-frozen.v1');
  assert.equal(fixture.human_gold, false);
  assert.ok(fixture.cases.length >= 10);
  assert.ok(fixture.cases.some((item) => item.expected_conflict_fields?.length));
  assert.ok(fixture.cases.some((item) => item.expected_states?.['parts.part_number'] === 'EXPLICIT_NONE'));
  assert.ok(fixture.cases.some((item) => item.expected_negation_preserved));
  assert.ok(fixture.cases.some((item) => item.expected_planned_preserved));
  assert.ok(fixture.cases.some((item) => item.relevant_retrieval_ids?.length));
  assert.ok(fixture.cases.some((item) => item.fact_value_targets?.some((target) => target.kind === 'number_unit')));
  assert.ok(fixture.cases.some((item) => item.fact_value_targets?.some((target) => target.kind === 'negation')));

  const result = await evaluateEvidencePipelines({ fixture, repeats: 2 });
  assert.deepEqual(result.approaches, ['RAW_DIRECT', 'WHOLE_TRANSCRIPT_CORRECTION', 'FACT_CENTRIC_HYBRID']);
  assert.equal(result.cases, fixture.cases.length);
  for (const summary of Object.values(result.summary)) {
    assert.equal(typeof summary.extraction_precision, 'number');
    assert.equal(typeof summary.extraction_recall, 'number');
    assert.equal(typeof summary.fact_value_f1, 'number');
    assert.equal(typeof summary.negation_accuracy, 'number');
    assert.equal(typeof summary.provenance_rate, 'number');
    assert.equal(typeof summary.retrieval_hit_at_3, 'number');
    assert.equal(typeof summary.scope_isolation_rate, 'number');
    assert.equal(typeof summary.mean_required_completeness, 'number');
    assert.equal(typeof summary.mean_latency_ms, 'number');
    assert.equal(typeof summary.unnecessary_interventions, 'number');
  }
  assert.equal(result.summary.FACT_CENTRIC_HYBRID.false_supported_count, 0);
  assert.equal(result.summary.FACT_CENTRIC_HYBRID.conflict_recall, 1);
  assert.equal(result.summary.FACT_CENTRIC_HYBRID.provenance_rate, 1);
  assert.equal(result.summary.FACT_CENTRIC_HYBRID.negation_accuracy, 1);
  assert.ok(result.summary.FACT_CENTRIC_HYBRID.extraction_recall >= result.summary.RAW_DIRECT.extraction_recall);
  assert.ok(result.summary.FACT_CENTRIC_HYBRID.extraction_precision >= result.summary.WHOLE_TRANSCRIPT_CORRECTION.extraction_precision);
  assert.equal(result.decision.selected, 'FACT_CENTRIC_HYBRID');
});

test('fact-centric interpretation prefers an explicit inspection statement over a complaint fallback', async () => {
  const result = await interpretEvidence({
    scope_id: 'SBS_BUS',
    raw_text: 'The passenger door would not close. Inspection found a loose connector.',
  });
  assert.deepEqual(
    result.facts.filter((fact) => fact.field === 'inspection_findings').map((fact) => fact.value),
    ['Inspection found a loose connector'],
  );
});

test('fact-centric interpretation retains explicit no-outstanding-issues semantics', async () => {
  const result = await interpretEvidence({
    scope_id: 'SBS_BUS',
    raw_text: 'No outstanding issues.',
  });
  assert.deepEqual(result.facts.find((fact) => fact.field === 'completion.outstanding_issues'), {
    field: 'completion.outstanding_issues',
    value: null,
    claim_kind: 'EXPLICIT_NONE',
    support_status: 'DIRECT_TRANSCRIPT',
    source: 'manual',
    source_span: { start: 0, end: 21, text: 'No outstanding issues' },
    critical: false,
  });
});
