import { loadReportModulesConfig } from './hvac-knowledge.js';
import { toolEnvelope, toolFailure } from './tool-envelope.js';

export async function planReportSections({ facts = [], serviceType = 'general_hvac', traceId, knowledgeRoot } = {}) {
  try {
    const config = await loadReportModulesConfig({ knowledgeRoot });
    const presentFields = new Set(facts.map((fact) => fact?.field).filter(Boolean));
    const selectedConditional = config.conditional_sections.filter((section) => section.fields.some((field) => presentFields.has(field)));
    return toolEnvelope('plan_report_sections', traceId, 'PASS', {
      service_type: serviceType,
      schema_version: config.schema_version,
      sections: [...config.fixed_sections.map((section) => ({ ...section, required: true })), ...selectedConditional.map((section) => ({ ...section, required: false }))],
      selected_conditional_section_ids: selectedConditional.map((section) => section.id),
      excluded_conditional_section_ids: config.conditional_sections.filter((section) => !selectedConditional.includes(section)).map((section) => section.id),
    });
  } catch (error) {
    return toolFailure('plan_report_sections', traceId, error, 'REPORT_PLAN_FAILED');
  }
}
