import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { evaluateEvidencePipelines } from '../evaluation/evidence-pipeline-evaluation.js';

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
