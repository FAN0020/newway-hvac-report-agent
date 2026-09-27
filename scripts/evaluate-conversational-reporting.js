import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

const corpus = JSON.parse(await fs.readFile(new URL('../evaluation/conversational-reporting.v1.json', import.meta.url), 'utf8'));
const baseline = JSON.parse(await fs.readFile(new URL('../evaluation/conversational-reporting-baseline.v1.json', import.meta.url), 'utf8'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conversational-reporting-eval-'));

function key(type, value) {
  return JSON.stringify([type, value]);
}

async function evaluate(entry) {
  const sessionStore = new ReportSessionStore({ root: path.join(root, entry.id, 'sessions') });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, entry.id, 'artifacts') }),
    sessionStore,
    whisperProvider: { transcribe: async () => { throw new Error('Unexpected audio capture'); } },
    clock: () => '2026-09-28T06:00:00.000Z',
    reportTimeZone: 'Asia/Shanghai',
  });
  const created = await service.createSession({
    template_id: entry.template_id, template_version: '1.0.0', job_context_ref: `evaluation:${entry.id}`,
  });
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: entry.text, language: 'en', idempotency_key: `evaluation:${entry.id}`,
  });
  const trace = result.semantic_trace;
  const fields = new Map(result.agent_state.report_fields.map((field) => [field.field_id, field]));
  const expectedFacts = new Set(entry.expected_facts.map(([type, value]) => key(type, value)));
  const actualFacts = new Set(trace.canonical_facts.map((fact) => key(fact.semantic_type, fact.value)));
  const trueFacts = [...actualFacts].filter((fact) => expectedFacts.has(fact)).length;
  const sourceSpanErrors = trace.canonical_facts.filter((fact) =>
    entry.text.slice(fact.char_start, fact.char_end) !== fact.evidence_quote).length;
  const assertionSpanErrors = trace.assertions.filter((assertion) =>
    entry.text.slice(assertion.start, assertion.end) !== assertion.text).length;
  const assertionBoundaryMisses = entry.expected_assertions.filter((text) =>
    !trace.assertions.some((assertion) => assertion.text === text));
  const fieldErrors = Object.entries(entry.expected_fields).flatMap(([id, expected]) => {
    const actual = fields.get(id);
    return actual?.state === (expected === null ? 'EXPLICIT_NONE' : 'KNOWN_VALUE')
      && actual.value === expected ? [] : [{ field_id: id, expected, actual: actual?.value ?? null, state: actual?.state ?? null }];
  });
  const unsupportedFills = entry.expected_unknown.filter((id) => fields.get(id)?.state !== 'UNKNOWN');
  const semanticErrors = (entry.expected_semantics || []).filter((gold) => !trace.canonical_facts.some((fact) =>
    fact.semantic_type === gold.type && fact.value === gold.value
      && fact.source_role === gold.actor && fact.temporality === gold.temporality));
  const unresolvedAssertions = trace.assertions.filter((assertion) => ['UNRESOLVED', 'PARTIALLY_RESOLVED', 'AMBIGUOUS'].includes(assertion.status)).length;
  const clarificationCount = result.agent_state.resolution_queue.length;
  const errors = [
    ...assertionBoundaryMisses.map((text) => `missing assertion: ${text}`),
    ...fieldErrors.map((error) => `field mismatch: ${error.field_id}`),
    ...unsupportedFills.map((id) => `unsupported fill: ${id}`),
    ...[...expectedFacts].filter((fact) => !actualFacts.has(fact)).map((fact) => `missing fact: ${fact}`),
    ...[...actualFacts].filter((fact) => !expectedFacts.has(fact)).map((fact) => `unsupported fact: ${fact}`),
    ...semanticErrors.map((gold) => `actor or temporality mismatch: ${key(gold.type, gold.value)}`),
    ...(clarificationCount > entry.max_clarifications ? ['clarification count exceeded gold limit'] : []),
    ...(sourceSpanErrors ? [`${sourceSpanErrors} invalid fact spans`] : []),
    ...(assertionSpanErrors ? [`${assertionSpanErrors} invalid assertion spans`] : []),
    ...(result.transcript.raw_text !== entry.text ? ['raw transcript changed'] : []),
    ...(result.transcript.normalized_text !== entry.text ? ['normalization unexpectedly changed transcript'] : []),
  ];
  return {
    case_id: entry.id, split: entry.split,
    normalization_exact: result.transcript.normalized_text === entry.text,
    assertion_boundary_recall: 1 - assertionBoundaryMisses.length / entry.expected_assertions.length,
    assertion_span_accuracy: 1 - assertionSpanErrors / Math.max(1, trace.assertions.length),
    canonical_fact_precision: trueFacts / Math.max(1, actualFacts.size),
    canonical_fact_recall: trueFacts / Math.max(1, expectedFacts.size),
    actor_temporality_accuracy: 1 - semanticErrors.length / Math.max(1, (entry.expected_semantics || []).length),
    source_span_accuracy: 1 - sourceSpanErrors / Math.max(1, trace.canonical_facts.length),
    routing_accuracy: 1 - fieldErrors.length / Math.max(1, Object.keys(entry.expected_fields).length),
    unsupported_fill_count: unsupportedFills.length,
    unsupported_fill_rate: unsupportedFills.length / Math.max(1, entry.expected_unknown.length),
    extraction_failure_count: trace.model.error ? 1 : 0,
    unresolved_assertion_count: unresolvedAssertions,
    clarification_count: clarificationCount,
    model_rejection_count: trace.model.rejections.length,
    errors,
  };
}

try {
  const cases = [];
  for (const entry of corpus.cases) cases.push(await evaluate(entry));
  const real = cases.find((entry) => entry.case_id === baseline.case_id);
  const result = {
    schema_version: 'conversational-reporting-evaluation-result.v1',
    pipeline: 'canonical-report-facts.v1',
    baseline_comparison: {
      case_id: baseline.case_id,
      baseline_known_field_count: Object.keys(baseline.fields).length,
      current_expected_field_count: Object.keys(corpus.cases.find((entry) => entry.id === baseline.case_id).expected_fields).length,
      unsupported_fill_delta: real.unsupported_fill_count,
      clarification_delta: real.clarification_count - baseline.clarification_count,
      baseline_model_contributed: baseline.model_contributed,
    },
    cases,
    passed: cases.every((entry) => entry.errors.length === 0 && entry.unsupported_fill_count === 0),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
