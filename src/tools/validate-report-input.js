import { loadReportModulesConfig } from './hvac-knowledge.js';
import { toolEnvelope, toolFailure } from './tool-envelope.js';
import { resolveFactConflict } from './resolve-fact-conflicts.js';

const QUESTIONS = Object.freeze({
  customer_complaint: '客户最初反映的问题是什么？',
  inspection_findings: '你在现场检查发现了什么？',
  work_performed: '你实际完成了哪些维修或保养工作？',
  test_results: '完工后做了什么测试，结果如何？',
  completion_status: '目前问题是已解决、部分解决，还是未解决？',
});

async function generateContextualQuestions({ missingFields, uncertainFacts, existingFacts, provider, model }) {
  // Deterministic fallback
  if (!provider?.generateJson || missingFields.length === 0) {
    return missingFields.slice(0, 3).map(field => ({
      field,
      question: QUESTIONS[field],
      priority: 'REQUIRED',
      reason: 'Deterministic fallback'
    }));
  }
  try {
    const response = await provider.generateJson({
      model,
      system: `You rank missing HVAC service report fields by criticality. Return only field priorities from the supplied missing_fields list. Never invent fields, completion states, or technical recommendations. Return JSON only.`,
      prompt: JSON.stringify({
        missing_fields: missingFields,
        uncertain_fact_ids: uncertainFacts.slice(0, 10),
        present_fields_summary: existingFacts
          .filter(f => f.support_status !== 'UNCERTAIN')
          .map(f => ({ field: f.field, has_value: true })),
        allowed_priorities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
        required_output: {
          ranked_questions: [{ field: 'field from missing_fields', question: 'Chinese question text', priority: 'CRITICAL|HIGH|MEDIUM|LOW', reason: 'Brief explanation' }]
        }
      })
    });
    const ranked = Array.isArray(response?.data?.ranked_questions) ? response.data.ranked_questions : [];
    const valid = ranked
      .filter(q => missingFields.includes(q?.field) && typeof q?.question === 'string' && q.question.length > 0 && q.question.length <= 500 && ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(q?.priority))
      .slice(0, 3);
    if (valid.length === 0) {
      return missingFields.slice(0, 3).map(field => ({ field, question: QUESTIONS[field], priority: 'REQUIRED', reason: 'LLM output invalid, deterministic fallback' }));
    }
    const usedFields = new Set(valid.map(q => q.field));
    const remaining = missingFields.filter(f => !usedFields.has(f)).slice(0, 3 - valid.length)
      .map(field => ({ field, question: QUESTIONS[field], priority: 'REQUIRED', reason: 'Deterministic supplement' }));
    return [...valid, ...remaining];
  } catch (error) {
    return missingFields.slice(0, 3).map(field => ({ field, question: QUESTIONS[field], priority: 'REQUIRED', reason: `Provider error: ${error.code || 'UNKNOWN'}` }));
  }
}

export async function validateReportInput({ facts = [], traceId, knowledgeRoot, provider = null, model = null } = {}) {
  try {
    const config = await loadReportModulesConfig({ knowledgeRoot });
    const supportedFields = new Set(facts.filter((fact) => fact?.support_status !== 'UNCERTAIN').map((fact) => fact.field));
    const uncertainFacts = facts.filter((fact) => fact?.support_status === 'UNCERTAIN').map((fact) => fact.fact_id).filter(Boolean).slice(0, 50);
    const missingRequiredFields = config.required_fact_fields.filter((field) => !supportedFields.has(field));
    const completionFacts = facts.filter(fact => fact.field === 'completion_status' && fact.support_status !== 'UNCERTAIN');
    let conflicts = [];
    let autoResolved = [];
    if (new Set(completionFacts.map(f => JSON.stringify(f.value))).size > 1) {
      const resolution = await resolveFactConflict({ conflictingFacts: completionFacts, field: 'completion_status', allFacts: facts, provider, model });
      if (resolution.resolution === 'ACCEPT_FACT_ID') {
        autoResolved.push({ field: 'completion_status', conflicting_fact_ids: completionFacts.map(f => f.fact_id), selected_fact_id: resolution.selected_fact_id, reason: resolution.reason, confidence: resolution.confidence });
      } else {
        conflicts.push({ field: 'completion_status', fact_ids: completionFacts.map(f => f.fact_id), fact_values: completionFacts.map(f => f.value), resolution_reason: resolution.reason });
      }
    }
    let status = 'PASS';
    if (conflicts.length || uncertainFacts.length) status = 'NEEDS_CONFIRMATION';
    else if (missingRequiredFields.length) status = 'NEEDS_MORE_INFO';
    return toolEnvelope('validate_report_input', traceId, status, {
      missing_required_fields: missingRequiredFields,
      uncertain_fact_ids: uncertainFacts,
      conflicts,
      auto_resolved_conflicts: autoResolved,
      follow_up_questions: await generateContextualQuestions({ missingFields: missingRequiredFields, uncertainFacts, existingFacts: facts, provider, model }),
      question_generation_mode: provider?.generateJson ? 'LLM_ASSISTED' : 'DETERMINISTIC',
      can_generate_draft: true,
      can_save_or_export: false,
    });
  } catch (error) {
    return toolFailure('validate_report_input', traceId, error, 'INPUT_VALIDATION_FAILED');
  }
}
