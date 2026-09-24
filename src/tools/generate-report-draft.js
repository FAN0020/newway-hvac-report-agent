import { FIELD_TO_SECTION, renderFact } from './hvac-schema.js';
import { boundedString, stableId, toolEnvelope } from './tool-envelope.js';

function validFacts(facts) {
  return facts.filter((fact) => fact?.fact_id && FIELD_TO_SECTION[fact.field] && fact.support_status !== 'UNCERTAIN').slice(0, 100);
}

function groupingFromProvider(response, allowedFactIds, selectedSectionIds) {
  const groups = Array.isArray(response?.data?.groups) ? response.data.groups : [];
  const used = new Set();
  const accepted = [];
  for (const group of groups.slice(0, 100)) {
    const section = boundedString(group?.section, 80);
    const factIds = Array.isArray(group?.fact_ids) ? [...new Set(group.fact_ids.map(String))] : [];
    if (!selectedSectionIds.has(section) || factIds.length === 0 || factIds.some((id) => !allowedFactIds.has(id) || used.has(id))) continue;
    factIds.forEach((id) => used.add(id));
    accepted.push({ section, fact_ids: factIds });
  }
  return { accepted, used };
}

function buildClaim(section, claimFacts) {
  const factIds = claimFacts.map((fact) => fact.fact_id);
  return {
    type: 'claim',
    claim_id: stableId('claim', section, factIds),
    section,
    text: claimFacts.map(renderFact).join(' '),
    fact_ids: factIds,
    claim_mode: 'FACT_RENDERED',
  };
}

export async function generateReportDraft({ facts = [], plan, template, provider, model, traceId } = {}) {
  if (!Array.isArray(plan?.sections) || !template?.template_id) {
    return toolEnvelope('generate_report_draft', traceId, 'FAIL', {}, { error_code: 'INVALID_REPORT_PLAN_OR_TEMPLATE' });
  }
  const reportFacts = validFacts(facts);
  const byId = new Map(reportFacts.map((fact) => [fact.fact_id, fact]));
  const selectedSectionIds = new Set(plan.sections.map((section) => section.id));
  const allowedFactIds = new Set(byId.keys());
  const warnings = [];
  let providerGroups = [];
  let providerMetadata = null;
  if (provider?.generateJson && reportFacts.length) {
    try {
      const response = await provider.generateJson({
        model,
        system: 'Plan grouping only. Use only supplied fact_id and section IDs. Do not write report text or add facts. Return JSON only.',
        prompt: JSON.stringify({
          facts: reportFacts.map((fact) => ({ fact_id: fact.fact_id, field: fact.field, value: fact.value, required_section: FIELD_TO_SECTION[fact.field] })),
          section_ids: [...selectedSectionIds],
          required_output: { groups: [{ section: 'section_id', fact_ids: ['fact_id'] }] },
        }),
      });
      const grouped = groupingFromProvider(response, allowedFactIds, selectedSectionIds);
      providerGroups = grouped.accepted;
      providerMetadata = { provider: response?.provider || 'unknown', model: response?.model || model || 'unknown' };
      if (providerGroups.length < (response?.data?.groups?.length || 0)) warnings.push('Invalid provider groupings were discarded.');
    } catch (error) {
      warnings.push(`Provider generation failed; deterministic generation was used (${error.code || 'PROVIDER_ERROR'}).`);
    }
  }
  const groupedIds = new Set(providerGroups.flatMap((group) => group.fact_ids));
  const allGroups = [...providerGroups];
  for (const fact of reportFacts) {
    if (!groupedIds.has(fact.fact_id)) allGroups.push({ section: FIELD_TO_SECTION[fact.field], fact_ids: [fact.fact_id] });
  }
  const claimsBySection = new Map();
  for (const group of allGroups) {
    const claimFacts = group.fact_ids.map((id) => byId.get(id)).filter(Boolean);
    if (!claimFacts.length || claimFacts.some((fact) => FIELD_TO_SECTION[fact.field] !== group.section)) continue;
    const claim = buildClaim(group.section, claimFacts);
    if (!claimsBySection.has(group.section)) claimsBySection.set(group.section, []);
    claimsBySection.get(group.section).push(claim);
  }
  const sections = plan.sections.map((section) => {
    const claims = claimsBySection.get(section.id) || [];
    return {
      section_id: section.id,
      title: section.title,
      items: claims.length ? claims : [{ type: 'template_text', text: template.placeholder }],
    };
  });
  const draft = {
    report_id: stableId('report', template.template_id, facts, plan.sections.map((item) => item.id)),
    report_version: 1,
    schema_version: 'hvac-report-draft.v1',
    template_id: template.template_id,
    template_version: template.template_version,
    disclaimer: { type: 'template_text', text: template.disclaimer },
    sections,
    knowledge_context: {
      knowledge_version: plan.knowledge_version || null,
      citations: Array.isArray(plan.retrieved_evidence)
        ? plan.retrieved_evidence.slice(0, 8).map((item) => ({
            chunk_id: item.chunk_id,
            document_id: item.document_id,
            title: item.title,
            section: item.section,
            source: item.source,
            source_hash: item.source_hash,
            score: item.score,
          }))
        : [],
      usage: 'REFERENCE_ONLY_NOT_SERVICE_FACTS',
    },
    generation: { deterministic_claim_text: true, provider: providerMetadata },
    confirmation: { status: 'NOT_CONFIRMED' },
  };
  return toolEnvelope('generate_report_draft', traceId, 'PASS', { draft }, { warnings });
}
