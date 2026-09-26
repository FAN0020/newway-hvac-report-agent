import fs from 'node:fs/promises';
import { extractV2Facts } from '../src/tools/extract-v2-facts.js';
import { createReportSession, createResolveQueue, mapFactsToStructuredState } from '../web/report-runtime.js';

const fixturePath = new URL('../test/fixtures/sbs-extraction-eval.v1.json', import.meta.url);
const caseSet = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
const results = [];

for (const evaluationCase of caseSet.cases) {
  const output = await extractV2Facts({ contextId: evaluationCase.context_id, rawText: evaluationCase.input });
  const actualFields = new Set(output.facts.map((fact) => fact.field));
  const falseMissing = evaluationCase.expected_fields.filter((field) => !actualFields.has(field));
  const falseSupported = evaluationCase.forbidden_fields.filter((field) => actualFields.has(field));
  const valueErrors = Object.entries(evaluationCase.expected_values || {}).filter(([field, expected]) => {
    const actual = output.facts.find((fact) => fact.field === field)?.value;
    return actual !== expected;
  }).map(([field, expected]) => ({ field, expected, actual: output.facts.find((fact) => fact.field === field)?.value }));
  const session = mapFactsToStructuredState(createReportSession({ id: evaluationCase.id, reportType: evaluationCase.report_type }), output.facts);
  const resolve = createResolveQueue(session).map((item) => `${item.type}:${item.fieldId}`);
  const resolveMismatch = evaluationCase.expected_resolve
    && JSON.stringify(resolve) !== JSON.stringify(evaluationCase.expected_resolve);
  results.push({
    id: evaluationCase.id,
    category: evaluationCase.category,
    expected_fields: evaluationCase.expected_fields,
    actual_fields: [...actualFields],
    false_missing: falseMissing,
    false_supported: falseSupported,
    value_errors: valueErrors,
    resolve,
    expected_resolve: evaluationCase.expected_resolve || null,
    resolve_mismatch: Boolean(resolveMismatch),
    warnings: output.warnings,
  });
}

const totals = results.reduce((summary, result) => ({
  cases: summary.cases + 1,
  expected_fields: summary.expected_fields + result.expected_fields.length,
  false_missing: summary.false_missing + result.false_missing.length,
  false_supported: summary.false_supported + result.false_supported.length,
  value_errors: summary.value_errors + result.value_errors.length,
  resolve_mismatches: summary.resolve_mismatches + Number(result.resolve_mismatch),
}), { cases: 0, expected_fields: 0, false_missing: 0, false_supported: 0, value_errors: 0, resolve_mismatches: 0 });

const run = {
  id: `sbs-extraction-${new Date().toISOString()}`,
  pipeline_revision: process.env.SBS_EVAL_REVISION || 'working-tree',
  case_set_version: caseSet.version,
  provider_model: 'deterministic rules (no model/provider)',
  prompt_and_config_version: 'not applicable',
  retrieval_preprocessing_version: 'scoped vocabulary v1 + sentence rules',
  repeats: 1,
  hard_gate_failures: results.flatMap((result) => [
    ...result.false_supported.map((field) => `${result.id}: forbidden ${field}`),
    ...result.value_errors.map((error) => `${result.id}: ${error.field} value mismatch`),
    ...(result.resolve_mismatch ? [`${result.id}: Resolve queue mismatch`] : []),
  ]),
  metrics_by_dimension: {
    field_recall: totals.expected_fields ? (totals.expected_fields - totals.false_missing) / totals.expected_fields : 1,
    false_missing_count: totals.false_missing,
    false_supported_count: totals.false_supported,
    value_error_count: totals.value_errors,
    resolve_mismatch_count: totals.resolve_mismatches,
  },
  per_case_results: results,
  latency: { not_measured: true },
  cost_and_resources: { external_calls: 0 },
  limitations: ['Frozen deterministic cases cover shipped demo and known safety regressions, not production speech variability.'],
  decision: totals.false_missing === 0 && totals.false_supported === 0 && totals.value_errors === 0 && totals.resolve_mismatches === 0 ? 'promote' : 'hold',
};

console.log(JSON.stringify(run, null, 2));
if (run.decision !== 'promote') process.exitCode = 1;
