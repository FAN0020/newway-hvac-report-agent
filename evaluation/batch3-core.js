import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRetriever } from '../src/v2/retrieval.js';
import { loadScopeRegistry } from '../src/v2/scope.js';
import { buildBusReportSections, buildRailReportSections, buildIndustrialReportSections, checkHardGates, planV2Report } from '../src/v2/report-builder.js';
import { planReportSections } from '../src/tools/plan-report-sections.js';
import { generateReportDraft } from '../src/tools/generate-report-draft.js';
import { retrieveReportTemplate } from '../src/tools/hvac-knowledge.js';

export const SCOPES = ['HVAC', 'SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID'];
export const CONTEXT = { HVAC: 'HVAC', SBS_BUS: 'SBS/BUS', SBS_RAIL: 'SBS/RAIL', OILFIELD: 'OILFIELD', POWER_GRID: 'POWER/GRID' };
export const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const PLACEHOLDER = 'Not provided / pending confirmation';

export function ragScores(relevantIds, hits) {
  const relevant = new Set(relevantIds);
  const ids = hits.slice(0, 3).map((hit) => hit.chunk_id);
  const truePositive = ids.filter((id) => relevant.has(id)).length;
  const first = ids.findIndex((id) => relevant.has(id));
  return { hit_at_3: truePositive > 0 ? 1 : 0, recall_at_3: relevant.size ? truePositive / relevant.size : null, precision_at_3: truePositive / 3, mrr_at_3: first < 0 ? 0 : 1 / (first + 1), relevant_total: relevant.size, relevant_found: truePositive };
}

export async function corpusSnapshot(root, registry) {
  const files = [...new Set(Object.values(registry.knowledge_files).flat())].sort();
  return { registry_sha256: sha(await fs.readFile(path.join(root, 'data/knowledge/v2/scope-registry.v1.json'))), files: Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha(await fs.readFile(path.join(root, 'data/knowledge', file)))]))) };
}

export async function runRag({ root, cases, fixtures, registry = null, retriever = null }) {
  const actualRegistry = registry || await loadScopeRegistry();
  const retrieve = retriever || createRetriever({ registry: actualRegistry, knowledgeRoot: path.join(root, 'data/knowledge') });
  const snapshot = await corpusSnapshot(root, actualRegistry);
  const results = [];
  for (const item of cases) {
    const query = fixtures.rag_queries[item.case_id];
    if (!query || !CONTEXT[item.scope]) { results.push({ case_id: item.case_id, scope: item.scope, status: 'NOT_SUPPORTED', reason: 'NO_FIXED_QUERY_OR_CONTEXT' }); continue; }
    try {
      const prediction = await retrieve({ contextId: CONTEXT[item.scope], query, topK: 3, includeUploads: false });
      const hits = prediction.results.map((hit) => ({ chunk_id: hit.chunk_id, scope_id: hit.scope_id, source: hit.source, score: hit.score, provenance: hit.provenance, text: hit.text }));
      const hard_gate_failures = hits.flatMap((hit) => {
        const failures = [];
        if (hit.scope_id !== item.scope) failures.push({ class: 'CROSS_DOMAIN_LEAKAGE', chunk_id: hit.chunk_id });
        if (hit.source !== 'knowledge' || hit.provenance?.scope_id !== item.scope) failures.push({ class: 'SCOPE_LEAKAGE', chunk_id: hit.chunk_id });
        return failures;
      });
      const metrics = ragScores(item.relevant_retrieval_ids, hits);
      results.push({ case_id: item.case_id, scope: item.scope, scenario: item.scenario, status: 'RUN', input: { query, context_id: CONTEXT[item.scope], include_uploads: false, top_k: 3, corpus_snapshot: snapshot }, expected: { relevant_ids: item.relevant_retrieval_ids }, prediction: { hits, warnings: prediction.warnings }, metrics, hard_gate_failures });
    } catch (error) { results.push({ case_id: item.case_id, scope: item.scope, status: 'ERROR', reason: error.code || error.name, detail: error.message }); }
  }
  return { corpus_snapshot: snapshot, results };
}

async function fixedKnowledgeContext(root, ids, scope) {
  const context = [];
  for (const id of ids) {
    const match = /^knowledge:([^:]+):(.+):([^:]+)$/.exec(id);
    if (!match || match[1] !== scope) throw new Error(`Invalid fixed context ID ${id}`);
    const raw = await fs.readFile(path.join(root, 'data/knowledge', match[2]));
    const document = JSON.parse(raw);
    const records = document.records || [...(document.fixed_sections || []), ...(document.conditional_sections || [])];
    const record = records.find((entry) => entry.id === match[3]);
    if (!record) throw new Error(`Fixed context record missing: ${id}`);
    context.push({ chunk_id: id, source_sha256: sha(raw), record });
  }
  return context;
}

function v2Draft(scope, facts, receipt) {
  if (scope === 'SBS_BUS') return buildBusReportSections({ facts, factsReceiptId: receipt });
  if (scope === 'SBS_RAIL') return buildRailReportSections({ facts, factsReceiptId: receipt });
  if (scope === 'OILFIELD' || scope === 'POWER_GRID') return buildIndustrialReportSections({ scopeId: scope, facts, factsReceiptId: receipt });
  return null;
}

export function scoreV2Report({ scope, facts, draft, receipt }) {
  const plan = planV2Report({ scopeId: scope, facts, factsReceiptId: receipt });
  const sections = draft.sections;
  const allContent = sections.flatMap((section) => section.content.filter((text) => text !== PLACEHOLDER));
  const text = allContent.join('\n');
  const supported = facts.filter((fact) => fact.support_status !== 'UNCERTAIN');
  const covered = supported.filter((fact) => text.includes(String(fact.value)));
  const untraceable = allContent.filter((line) => !line.startsWith('Facts receipt:') && !supported.some((fact) => line.includes(String(fact.value))));
  const required = plan.sections.filter((section) => section.required);
  const present = required.filter((section) => sections.some((row) => row.id === section.id));
  const populated = required.filter((section) => sections.some((row) => row.id === section.id && row.content.some((line) => line !== PLACEHOLDER)));
  const gate = checkHardGates({ scopeId: scope, facts });
  const hard_gate_failures = [...gate.violations];
  if (untraceable.length) hard_gate_failures.push(...untraceable.map((line) => ({ class: 'UNSUPPORTED_REPORT_CLAIM', line })));
  // A knowledge recommendation may appear in the fixed context, but an
  // occurred action in the report still needs a grounded service-action fact.
  const actionWords = /\b(replaced?|replacement|installed?|removed?)\b|更换|替换|安装|拆除/iu;
  const groundedActions = supported.filter((fact) =>
    ['work_performed', 'work.description', 'performed_actions', 'parts.replaced'].includes(fact.field)
    && ['DIRECT_TRANSCRIPT', 'MANUAL_ENTRY', 'CONFIRMED_BY_TECHNICIAN'].includes(fact.support_status));
  for (const line of allContent) {
    if (actionWords.test(line) && !groundedActions.some((fact) => line.includes(String(fact.value)))) {
      hard_gate_failures.push({ class: 'UNSUPPORTED_SERVICE_FACT_PROMOTION', line });
    }
  }
  return { metrics: { required_section_completeness: required.length ? present.length / required.length : null, required_section_populated: required.length ? populated.length / required.length : null, fact_value_coverage: supported.length ? covered.length / supported.length : null, supported_facts: supported.length, covered_fact_ids: covered.map((fact) => fact.fact_id), unsupported_claim_count: untraceable.length, traceability: allContent.length ? (allContent.length - untraceable.length) / allContent.length : null, missing_required_sections: plan.missing_required_fields }, hard_gate_failures };
}

export async function runReports({ root, cases, fixtures }) {
  const results = [];
  for (const item of cases) {
    const fixed = fixtures.report_cases[item.case_id];
    if (!fixed) { results.push({ case_id: item.case_id, scope: item.scope, status: 'NOT_RUN', reason: 'NO_FIXED_REPORT_SEED_FACTS' }); continue; }
    if (!SCOPES.includes(item.scope)) { results.push({ case_id: item.case_id, scope: item.scope, status: 'NOT_SUPPORTED', reason: 'SCOPE_REPORT_BUILDER_UNAVAILABLE' }); continue; }
    try {
      const context = await fixedKnowledgeContext(root, fixed.retrieval_context_ids, item.scope);
      const facts = fixed.facts;
      const receipt = `synthetic-seed:${item.case_id}`;
      let draft, scored;
      if (item.scope === 'HVAC') {
        const planResult = await planReportSections({ facts, traceId: receipt, provider: null });
        const templateResult = await retrieveReportTemplate({ traceId: receipt });
        if (planResult.status !== 'PASS' || templateResult.status !== 'PASS') throw new Error('HVAC_PLAN_OR_TEMPLATE_FAILED');
        const generated = await generateReportDraft({ facts, plan: planResult.data, template: templateResult.data.template, traceId: receipt, reportSessionId: receipt, provider: null });
        if (generated.status !== 'PASS') throw new Error(`HVAC_DRAFT_${generated.status}`);
        draft = generated.data.draft;
        const claims = draft.sections.flatMap((section) => section.items.filter((entry) => entry.type === 'claim'));
        const factIds = new Set(facts.map((fact) => fact.fact_id));
        const coveredIds = new Set(claims.flatMap((claim) => claim.fact_ids));
        const unsupported = claims.filter((claim) => claim.fact_ids.some((id) => !factIds.has(id)) || !claim.fact_ids.some((id) => facts.some((fact) => claim.text.includes(String(fact.value)))));
        const required = planResult.data.sections.filter((section) => section.required);
        const populated = required.filter((section) => draft.sections.find((entry) => entry.section_id === section.id)?.items.some((entry) => entry.type === 'claim'));
        scored = { metrics: { required_section_completeness: required.length ? draft.sections.filter((section) => required.some((entry) => entry.id === section.section_id)).length / required.length : null, required_section_populated: required.length ? populated.length / required.length : null, fact_value_coverage: facts.length ? facts.filter((fact) => claims.some((claim) => claim.text.includes(String(fact.value)))).length / facts.length : null, supported_facts: facts.length, covered_fact_ids: [...coveredIds], unsupported_claim_count: unsupported.length, traceability: claims.length ? (claims.length - unsupported.length) / claims.length : null, missing_required_sections: required.filter((section) => !populated.some((entry) => entry.id === section.id)).map((section) => section.id) }, hard_gate_failures: unsupported.map((claim) => ({ class: 'UNSUPPORTED_REPORT_CLAIM', claim_id: claim.claim_id })) };
      } else {
        draft = v2Draft(item.scope, facts, receipt);
        scored = scoreV2Report({ scope: item.scope, facts, draft, receipt });
      }
      results.push({ case_id: item.case_id, scope: item.scope, scenario: item.scenario, status: 'RUN', input: { facts, retrieval_context: context, facts_receipt_id: receipt }, prediction: { draft }, ...scored });
    } catch (error) { results.push({ case_id: item.case_id, scope: item.scope, status: 'ERROR', reason: error.code || error.name, detail: error.message }); }
  }
  return { results };
}
