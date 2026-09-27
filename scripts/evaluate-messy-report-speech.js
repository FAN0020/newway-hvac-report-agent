import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { OllamaProvider } from '../src/providers/ollama.js';
import { extractAtomicFacts } from '../src/semantic/atomic-facts.js';
import { routeAtomicFacts } from '../src/semantic/field-router.js';
import { proposeStructuredAtomicFacts } from '../src/semantic/structured-proposals.js';
import { templateFor } from '../web/template-catalog.js';

const corpus = JSON.parse(await fs.readFile(new URL('../evaluation/messy-report-speech.v1.json', import.meta.url), 'utf8'));
const option = (name, fallback = '') => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const model = option('model');
const split = option('split', 'dev');
const output = option('output');
const provider = model ? new OllamaProvider() : null;

function selectedFacts(deterministic, proposed) {
  const protectedTypes = new Set(['WORK_ORDER', 'EQUIPMENT_OR_ASSET', 'MEASUREMENT', 'TEST_OUTCOME', 'COMPLETION_STATE']);
  const overlaps = (a, b) => a.char_start < b.char_end && b.char_start < a.char_end;
  const modelFacts = proposed.filter((fact) => !protectedTypes.has(fact.semantic_type)
    || !deterministic.some((fallback) => fallback.semantic_type === fact.semantic_type && overlaps(fact, fallback)));
  return [...modelFacts, ...deterministic.filter((fact) => !modelFacts.some((proposal) => proposal.semantic_type === fact.semantic_type && overlaps(proposal, fact)))];
}

function matches(assignment, expectation) {
  if (assignment.field_id !== expectation.field_id) return false;
  if (expectation.claim_kind && assignment.claim_kind !== expectation.claim_kind) return false;
  if (!expectation.contains) return true;
  return String(assignment.value || '').toLowerCase().includes(expectation.contains.toLowerCase());
}

function score(entry, assignments) {
  const required = (entry.required || []).map((expected) => ({ ...expected, found: assignments.some((item) => matches(item, expected)) }));
  const forbidden = (entry.forbidden || []).map((expected) => ({ ...expected, violated: assignments.some((item) => matches(item, expected)) }));
  return {
    required_found: required.filter((item) => item.found).length,
    required_total: required.length,
    forbidden_violations: forbidden.filter((item) => item.violated),
    missing: required.filter((item) => !item.found),
  };
}

const entries = corpus.cases.filter((entry) => split === 'all' || entry.split === split);
if (!entries.length) throw new Error(`No cases found for split ${split}.`);
const results = [];
for (const entry of entries) {
  const template = templateFor(entry.template_id);
  const deterministic = await extractAtomicFacts({
    scope_id: entry.scope_id, raw_text: entry.input, transcript_id: `${entry.id}:transcript`,
  });
  const baseline = routeAtomicFacts({ facts: deterministic, template });
  const start = performance.now();
  let rawModelOutput = null;
  const proposed = model ? await proposeStructuredAtomicFacts({
    provider: {
      generateJson: async (request) => {
        const response = await provider.generateJson(request);
        rawModelOutput = response.data;
        return response;
      },
    },
    model, scope_id: entry.scope_id, transcript_id: `${entry.id}:transcript`, raw_text: entry.input,
  }) : { facts: [], rejections: [] };
  const latencyMs = Math.round(performance.now() - start);
  const combined = routeAtomicFacts({ facts: selectedFacts(deterministic, proposed.facts), template });
  results.push({
    id: entry.id, split: entry.split, latency_ms: latencyMs,
    deterministic: score(entry, baseline.assignments),
    combined: score(entry, combined.assignments),
    model_accepted: proposed.facts.length,
    raw_model_output: rawModelOutput,
    model_rejections: proposed.rejections,
    assignments: combined.assignments.map((item) => ({ field_id: item.field_id, semantic_type: item.semantic_type,
      value: item.value, claim_kind: item.claim_kind, quote: item.source_span.text })),
  });
}

const result = {
  schema_version: 'messy-report-evaluation.v1', corpus_version: corpus.schema_version,
  model: model || null, split, revision: process.env.GIT_REVISION || null,
  cases: results,
  summary: {
    required_found: results.reduce((sum, item) => sum + item.combined.required_found, 0),
    required_total: results.reduce((sum, item) => sum + item.combined.required_total, 0),
    forbidden_violations: results.reduce((sum, item) => sum + item.combined.forbidden_violations.length, 0),
    model_accepted: results.reduce((sum, item) => sum + item.model_accepted, 0),
    model_rejections: results.reduce((sum, item) => sum + item.model_rejections.length, 0),
    latency_ms: results.reduce((sum, item) => sum + item.latency_ms, 0),
  },
};
if (output) {
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(result, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(result.summary)}\n`);
