import { loadReportModulesConfig } from './hvac-knowledge.js';
import { toolEnvelope, toolFailure } from './tool-envelope.js';

async function selectConditionalSections({ config, presentFields, facts, provider, model }) {
  // Always start with field-presence baseline
  const candidateSections = config.conditional_sections.filter(
    (section) => section.fields.some((field) => presentFields.has(field))
  );

  if (!provider?.generateJson || candidateSections.length === 0) {
    return { sections: candidateSections, mode: 'DETERMINISTIC' };
  }

  try {
    const response = await provider.generateJson({
      model,
      system: `You decide whether sparse HVAC data warrants a dedicated report section.
Return only section inclusion decisions from the supplied candidate list.
Do not add sections, remove required sections, or invent data.
Return JSON only.`,
      prompt: JSON.stringify({
        candidate_sections: candidateSections.map((s) => ({
          id: s.id,
          title: s.title,
          fields: s.fields,
          manual_or_authorized_only: s.manual_or_authorized_only || false,
        })),
        field_data_density: candidateSections.map((section) => {
          const sectionFacts = facts.filter(
            (f) => section.fields.includes(f.field) && f.support_status !== 'UNCERTAIN'
          );
          return {
            section_id: section.id,
            fact_count: sectionFacts.length,
            fields_with_data: [...new Set(sectionFacts.map((f) => f.field))],
            has_substantial_content:
              sectionFacts.length >= 2 || sectionFacts.some((f) => String(f.value).length > 20),
          };
        }),
        required_output: {
          decisions: [{ section_id: 'section from candidate_sections', include: true, reason: 'Brief Chinese explanation' }],
        },
      }),
    });

    const decisions = Array.isArray(response?.data?.decisions) ? response.data.decisions : [];
    const validIds = new Set(candidateSections.map((s) => s.id));
    const validDecisions = decisions.filter((d) => validIds.has(d?.section_id) && typeof d?.include === 'boolean');

    if (validDecisions.length === 0) {
      return { sections: candidateSections, mode: 'DETERMINISTIC' };
    }

    // Apply LLM decisions but never drop manual_or_authorized_only sections
    const selected = candidateSections.filter((section) => {
      if (section.manual_or_authorized_only) return true;
      const decision = validDecisions.find((d) => d.section_id === section.id);
      return decision ? decision.include : true;
    });

    return { sections: selected, mode: 'LLM_ASSISTED' };
  } catch (_error) {
    return { sections: candidateSections, mode: 'DETERMINISTIC' };
  }
}

export async function planReportSections({
  facts = [],
  serviceType = 'general_hvac',
  traceId,
  knowledgeRoot,
  provider = null,
  model = null,
} = {}) {
  try {
    const config = await loadReportModulesConfig({ knowledgeRoot });
    const presentFields = new Set(facts.map((fact) => fact?.field).filter(Boolean));
    const { sections: selectedConditional, mode: sectionSelectionMode } = await selectConditionalSections({
      config,
      presentFields,
      facts,
      provider,
      model,
    });
    return toolEnvelope('plan_report_sections', traceId, 'PASS', {
      service_type: serviceType,
      schema_version: config.schema_version,
      sections: [
        ...config.fixed_sections.map((section) => ({ ...section, required: true })),
        ...selectedConditional.map((section) => ({ ...section, required: false })),
      ],
      selected_conditional_section_ids: selectedConditional.map((section) => section.id),
      excluded_conditional_section_ids: config.conditional_sections
        .filter((section) => !selectedConditional.includes(section))
        .map((section) => section.id),
      section_selection_mode: sectionSelectionMode,
    });
  } catch (error) {
    return toolFailure('plan_report_sections', traceId, error, 'REPORT_PLAN_FAILED');
  }
}
