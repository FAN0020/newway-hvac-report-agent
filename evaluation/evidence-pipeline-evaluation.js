import { performance } from 'node:perf_hooks';

import { aggregateFactValueScores, scoreFactValues, setCounts, scores } from './component-metrics.js';
import { interpretEvidence, EVIDENCE_APPROACHES } from '../src/tools/interpret-evidence.js';
import { createRetriever } from '../src/v2/retrieval.js';
import { allowedScopes, loadScopeRegistry } from '../src/v2/scope.js';
import { mapFactsForTemplate, templateFor } from '../web/template-catalog.js';

function valueOf(fact) {
  return fact.claim_kind === 'EXPLICIT_NONE' ? null : fact.value;
}

function factForValueScoring(fact) {
  if (fact?.value && typeof fact.value === 'object' && 'value' in fact.value) {
    return { ...fact, value: fact.value.value, unit: fact.value.unit ?? fact.unit };
  }
  return fact;
}

function scalarEqual(left, right) {
  if (left && typeof left === 'object' && 'value' in left) return String(left.value) === String(right);
  return String(left) === String(right);
}

function templateCompleteness(template, facts, systemContext = {}) {
  const mapped = mapFactsForTemplate(template.templateId, facts).facts;
  const present = new Set([...mapped.map((fact) => fact.field), ...Object.keys(systemContext)]);
  const required = template.schema.fields.filter((field) => field.required && !field.id.endsWith('.*'));
  const complete = required.filter((definition) => present.has(definition.id)).length;
  return { complete, total: required.length, ratio: required.length ? complete / required.length : 1 };
}

function detectedConflicts(facts, systemContext = {}) {
  const conflicts = [];
  for (const [field, value] of Object.entries(systemContext)) {
    const candidates = facts.filter((fact) => fact.field === field).map(valueOf);
    if (candidates.some((candidate) => !scalarEqual(candidate, value))) conflicts.push(field);
  }
  return conflicts;
}

function scopeIsolated(results, contextId, registry) {
  const allowed = new Set(allowedScopes(contextId, registry));
  return results.every((item) => allowed.has(item.source === 'upload' ? `USER_UPLOADED:${item.scope_id}` : item.scope_id));
}

async function evaluateCase({ item, approach, registry, retriever, repeats }) {
  let interpretation;
  const durations = [];
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    interpretation = await interpretEvidence({ scope_id: item.scope_id, raw_text: item.raw_text, approach });
    durations.push(performance.now() - started);
  }
  const actualFields = [...new Set(interpretation.facts.map((fact) => fact.field))];
  const counts = setCounts(item.expected_fields || [], actualFields);
  const forbidden = (item.forbidden_fields || []).filter((field) => actualFields.includes(field));
  const valueErrors = Object.entries(item.expected_values || {}).filter(([field, expected]) => {
    const fact = interpretation.facts.find((candidate) => candidate.field === field);
    return !fact || !scalarEqual(valueOf(fact), expected);
  }).map(([field]) => field);
  const stateErrors = Object.entries(item.expected_states || {}).filter(([field, expected]) => {
    const fact = interpretation.facts.find((candidate) => candidate.field === field);
    const actual = fact?.claim_kind === 'EXPLICIT_NONE' ? 'EXPLICIT_NONE' : fact ? 'KNOWN_VALUE' : 'UNKNOWN';
    return actual !== expected;
  }).map(([field]) => field);
  const valueScores = scoreFactValues(item.fact_value_targets || [], interpretation.facts.map(factForValueScoring));
  const conflicts = detectedConflicts(interpretation.facts, item.system_context);
  const conflictCounts = setCounts(item.expected_conflict_fields || [], conflicts);
  let retrieval = { results: [] };
  if (item.retrieval_query) retrieval = await retriever({ contextId: item.context_id, query: item.retrieval_query, topK: 3, includeUploads: false });
  const retrievalIds = retrieval.results.map((entry) => entry.chunk_id);
  const expectedRetrieval = item.relevant_retrieval_ids || [];
  const retrievalFound = expectedRetrieval.filter((id) => retrievalIds.includes(id));
  const template = templateFor(item.template_id);
  const completeness = templateCompleteness(template, interpretation.facts, item.system_context);
  let unnecessary = 0;
  if (approach === 'FACT_CENTRIC_HYBRID' && interpretation.intervention_count) {
    const raw = await interpretEvidence({ scope_id: item.scope_id, raw_text: item.raw_text, approach: 'RAW_DIRECT' });
    const rawFields = new Set(raw.facts.map((fact) => fact.field));
    const improvesExpectedCoverage = (item.expected_fields || []).some((field) => actualFields.includes(field) && !rawFields.has(field));
    const fixesExpectedValue = Object.entries(item.expected_values || {}).some(([field, expected]) => {
      const before = raw.facts.find((fact) => fact.field === field);
      const after = interpretation.facts.find((fact) => fact.field === field);
      return after && scalarEqual(valueOf(after), expected) && (!before || !scalarEqual(valueOf(before), expected));
    });
    const requiredConfirmation = interpretation.confirmation_questions.some((question) => question.critical === true);
    unnecessary = Number(!improvesExpectedCoverage && !fixesExpectedValue && !requiredConfirmation);
  }
  return {
    case_id: item.case_id,
    status: 'RUN',
    actual_fields: actualFields,
    counts,
    forbidden_fields_emitted: forbidden,
    false_supported_count: counts.fp + forbidden.length,
    missed_count: counts.fn,
    value_errors: valueErrors,
    value_scores: valueScores,
    state_errors: stateErrors,
    conflicts,
    conflict_counts: conflictCounts,
    provenance_valid: interpretation.provenance_valid,
    intervention_count: interpretation.intervention_count,
    unnecessary_interventions: unnecessary,
    retrieval_hit_at_3: expectedRetrieval.length ? Number(retrievalFound.length > 0) : 1,
    retrieval_recall_at_3: expectedRetrieval.length ? retrievalFound.length / expectedRetrieval.length : 1,
    scope_isolated: scopeIsolated(retrieval.results, item.context_id, registry),
    required_completeness: completeness.ratio,
    latency_ms: durations.reduce((sum, value) => sum + value, 0) / durations.length,
  };
}

function aggregate(results) {
  const counts = results.reduce((total, item) => ({ tp: total.tp + item.counts.tp, fp: total.fp + item.counts.fp, fn: total.fn + item.counts.fn }), { tp: 0, fp: 0, fn: 0 });
  const conflictCounts = results.reduce((total, item) => ({ tp: total.tp + item.conflict_counts.tp, fp: total.fp + item.conflict_counts.fp, fn: total.fn + item.conflict_counts.fn }), { tp: 0, fp: 0, fn: 0 });
  const extraction = scores(counts);
  const conflict = scores(conflictCounts);
  const valueSummary = aggregateFactValueScores(results);
  const mean = (key) => results.reduce((sum, item) => sum + Number(item[key] || 0), 0) / results.length;
  return {
    extraction_precision: extraction.precision,
    extraction_recall: extraction.recall,
    extraction_f1: extraction.f1,
    hallucinated_fact_count: counts.fp,
    missed_fact_count: counts.fn,
    false_supported_count: results.reduce((sum, item) => sum + item.false_supported_count, 0),
    value_error_count: results.reduce((sum, item) => sum + item.value_errors.length + item.state_errors.length, 0),
    fact_value_precision: valueSummary?.micro.precision ?? 1,
    fact_value_recall: valueSummary?.micro.recall ?? 1,
    fact_value_f1: valueSummary?.micro.f1 ?? 1,
    negation_accuracy: valueSummary?.negation.accuracy ?? 1,
    conflict_recall: conflict.recall,
    provenance_rate: mean('provenance_valid'),
    retrieval_hit_at_3: mean('retrieval_hit_at_3'),
    retrieval_recall_at_3: mean('retrieval_recall_at_3'),
    scope_isolation_rate: mean('scope_isolated'),
    intervention_count: results.reduce((sum, item) => sum + item.intervention_count, 0),
    unnecessary_interventions: results.reduce((sum, item) => sum + item.unnecessary_interventions, 0),
    mean_required_completeness: mean('required_completeness'),
    mean_latency_ms: mean('latency_ms'),
  };
}

export async function evaluateEvidencePipelines({ fixture, fixtureSha256 = null, repeats = 5 } = {}) {
  const registry = await loadScopeRegistry();
  const retriever = createRetriever({ registry });
  const perApproach = {};
  const summary = {};
  for (const approach of EVIDENCE_APPROACHES) {
    perApproach[approach] = [];
    for (const item of fixture.cases) perApproach[approach].push(await evaluateCase({ item, approach, registry, retriever, repeats }));
    summary[approach] = aggregate(perApproach[approach]);
  }
  const safe = EVIDENCE_APPROACHES.filter((approach) => summary[approach].false_supported_count === 0
    && summary[approach].provenance_rate === 1
    && summary[approach].scope_isolation_rate === 1
    && summary[approach].negation_accuracy === 1);
  const selected = [...safe].sort((left, right) => summary[right].extraction_f1 - summary[left].extraction_f1
    || summary[right].fact_value_f1 - summary[left].fact_value_f1
    || summary[right].conflict_recall - summary[left].conflict_recall
    || summary[left].unnecessary_interventions - summary[right].unnecessary_interventions)[0] || null;
  return {
    contract_version: 'evidence-pipeline-comparison.v1',
    fixture_version: fixture.schema_version,
    fixture_sha256: fixtureSha256,
    label_status: fixture.label_status,
    human_gold: false,
    approaches: [...EVIDENCE_APPROACHES],
    cases: fixture.cases.length,
    repeats,
    summary,
    per_approach: perApproach,
    decision: {
      selected,
      rule: 'Zero false-supported facts, complete raw-span provenance, perfect negation preservation and scope isolation are hard gates; maximize extraction and typed-value F1 plus conflict recall, then minimize unnecessary intervention.',
    },
  };
}
