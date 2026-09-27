import fs from 'node:fs/promises';
import { OllamaProvider } from '../src/providers/ollama.js';
import { extractAtomicFacts } from '../src/semantic/atomic-facts.js';
import { routeAtomicFacts } from '../src/semantic/field-router.js';
import { extractCuedFieldAssignments, proposeStructuredAtomicFacts } from '../src/semantic/structured-proposals.js';
import { deriveCaptureTimeAssignments } from '../src/semantic/temporal-fields.js';
import { templateFor } from '../web/template-catalog.js';

const corpus = JSON.parse(await fs.readFile(new URL('../evaluation/schema-aware-blanks.v1.json', import.meta.url), 'utf8'));
const option = (name, fallback = '') => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const model = option('model');
const split = option('split', 'dev');
const provider = model ? new OllamaProvider() : null;
const results = [];
for (const entry of corpus.cases.filter((item) => split === 'all' || item.split === split)) {
  const template = templateFor(entry.template_id);
  const deterministic = await extractAtomicFacts({ scope_id: entry.scope_id, raw_text: entry.input, transcript_id: entry.id });
  let rawModelOutput = null;
  const tracedProvider = provider && { generateJson: async (request) => {
    const response = await provider.generateJson(request);
    rawModelOutput = response.data;
    return response;
  } };
  const proposed = await proposeStructuredAtomicFacts({ provider: tracedProvider, model, template,
    scope_id: entry.scope_id, raw_text: entry.input, transcript_id: entry.id });
  const protectedTypes = new Set(['WORK_ORDER', 'EQUIPMENT_OR_ASSET', 'MEASUREMENT', 'TEST_OUTCOME', 'COMPLETION_STATE']);
  const overlaps = (a, b) => a.char_start < b.char_end && b.char_start < a.char_end;
  const modelFacts = proposed.facts.filter((fact) => !protectedTypes.has(fact.semantic_type)
    || !deterministic.some((fallback) => fallback.semantic_type === fact.semantic_type && overlaps(fact, fallback)));
  const facts = [...modelFacts, ...deterministic.filter((fact) => !modelFacts.some((proposal) =>
    proposal.semantic_type === fact.semantic_type && overlaps(proposal, fact)))];
  const routed = routeAtomicFacts({ facts, template }).assignments;
  const used = new Set(routed.map((item) => item.field_id));
  const modelFields = (proposed.field_assignments || []).filter((item) => !used.has(item.field_id) && used.add(item.field_id));
  const cuedFields = extractCuedFieldAssignments({ template, raw_text: entry.input }).assignments
    .filter((item) => !used.has(item.field_id) && used.add(item.field_id));
  const dateFields = deriveCaptureTimeAssignments({ raw_text: entry.input, template,
    captured_at: corpus.clock, time_zone: corpus.time_zone }).filter((item) => !used.has(item.field_id));
  const assignments = [...routed, ...modelFields, ...cuedFields, ...dateFields];
  const matching = (item, expected) => item.field_id === expected.field_id
    && (!expected.contains || String(item.value).toLowerCase().includes(expected.contains.toLowerCase()));
  results.push({ id: entry.id, split: entry.split,
    missing: entry.required.filter((expected) => !assignments.some((item) => matching(item, expected))),
    forbidden: entry.forbidden.filter((expected) => assignments.some((item) => matching(item, expected))),
    assignments: assignments.map((item) => ({ field_id: item.field_id, value: item.value, quote: item.source_span.text })),
    rejections: proposed.rejections, raw_model_output: rawModelOutput,
  });
}
if (!results.length) throw new Error(`No ${split} cases.`);
const summary = { cases: results.length, passed: results.filter((item) => !item.missing.length && !item.forbidden.length).length,
  missing: results.reduce((sum, item) => sum + item.missing.length, 0),
  forbidden: results.reduce((sum, item) => sum + item.forbidden.length, 0) };
process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
if (summary.passed !== summary.cases) process.exitCode = 1;
