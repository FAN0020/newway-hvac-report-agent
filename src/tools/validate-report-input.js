import { loadReportModulesConfig } from './hvac-knowledge.js';
import { toolEnvelope, toolFailure } from './tool-envelope.js';

const QUESTIONS = Object.freeze({
  customer_complaint: '客户最初反映的问题是什么？',
  inspection_findings: '你在现场检查发现了什么？',
  work_performed: '你实际完成了哪些维修或保养工作？',
  test_results: '完工后做了什么测试，结果如何？',
  completion_status: '目前问题是已解决、部分解决，还是未解决？',
});

export async function validateReportInput({ facts = [], traceId, knowledgeRoot } = {}) {
  try {
    const config = await loadReportModulesConfig({ knowledgeRoot });
    const supportedFields = new Set(facts.filter((fact) => fact?.support_status !== 'UNCERTAIN').map((fact) => fact.field));
    const uncertainFacts = facts.filter((fact) => fact?.support_status === 'UNCERTAIN').map((fact) => fact.fact_id).filter(Boolean).slice(0, 50);
    const missingRequiredFields = config.required_fact_fields.filter((field) => !supportedFields.has(field));
    const completionValues = facts.filter((fact) => fact.field === 'completion_status' && fact.support_status !== 'UNCERTAIN').map((fact) => JSON.stringify(fact.value));
    const conflicts = new Set(completionValues).size > 1 ? [{ field: 'completion_status', fact_values: [...new Set(completionValues)].map(JSON.parse) }] : [];
    let status = 'PASS';
    if (conflicts.length || uncertainFacts.length) status = 'NEEDS_CONFIRMATION';
    else if (missingRequiredFields.length) status = 'NEEDS_MORE_INFO';
    return toolEnvelope('validate_report_input', traceId, status, {
      missing_required_fields: missingRequiredFields,
      uncertain_fact_ids: uncertainFacts,
      conflicts,
      follow_up_questions: missingRequiredFields.slice(0, 3).map((field) => ({ field, question: QUESTIONS[field] })),
      can_generate_draft: true,
      can_save_or_export: false,
    });
  } catch (error) {
    return toolFailure('validate_report_input', traceId, error, 'INPUT_VALIDATION_FAILED');
  }
}
