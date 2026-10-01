const MODEL_SYSTEM = 'Recommend a source for each report field from its eligible_sources only. Return JSON {"fields":[{"field_id":"...","source":"TECHNICIAN or WORK_ORDER or KNOWLEDGE"}]}. A work order is eligible only when reviewed evidence is already bound to this session. KNOWLEDGE is eligible only for manager-classified NORMATIVE_REFERENCE fields and is guidance for terminology or standards, never evidence of work done, measurements, parts, tests, safety, or completion. Do not invent job facts or change required rules.';
const NORMATIVE_FIELD_ID = /^(?:standard|reference|terminology|procedure)\.[a-z0-9_.-]+$/u;

function acceptedWorkOrderFields(agentState) {
  return new Set((agentState?.report_fields || []).filter((field) =>
    field.selected_candidate_ids?.some((id) => field.candidates?.some((candidate) =>
      candidate.candidate_id === id && candidate.support_type === 'AUTHORITATIVE_SYSTEM_DATA')))
    .map((field) => field.field_id));
}

export function ruleSourcePlan({ session, template, agentState, knowledgeAvailable = false } = {}) {
  if (session?.template_binding?.template_id !== template?.templateId
    || session?.template_binding?.template_version !== template?.templateVersion) {
    throw Object.assign(new Error('Source plan requires the exact bound template version.'), { code: 'SOURCE_PLAN_TEMPLATE_MISMATCH', status: 409 });
  }
  const workOrderFields = acceptedWorkOrderFields(agentState);
  return (template.schema?.fields || []).map((definition) => {
    const allowed = definition.allowedSources || ['TECHNICIAN'];
    const hasWorkOrderEvidence = workOrderFields.has(definition.id);
    const normative = definition.fieldRole === 'NORMATIVE_REFERENCE'
      && NORMATIVE_FIELD_ID.test(definition.id) && !definition.critical
      && !definition.requiresTechnicianConfirmation;
    const eligible = [
      ...(hasWorkOrderEvidence && allowed.includes('WORK_ORDER') ? ['WORK_ORDER'] : []),
      ...(allowed.includes('TECHNICIAN') ? ['TECHNICIAN'] : []),
      ...(normative && !definition.required && !definition.requiredWhen
        && knowledgeAvailable && allowed.includes('KNOWLEDGE') ? ['KNOWLEDGE'] : []),
    ];
    return {
      field_id: definition.id, label: definition.label, section: definition.section,
      required: definition.required === true, field_role: normative ? 'NORMATIVE_REFERENCE' : 'JOB_FACT',
      knowledge_available: Boolean(knowledgeAvailable),
      allowed_sources: [...allowed], eligible_sources: eligible,
      suggested_source: eligible[0] || null, basis: 'RULE_FALLBACK',
      reason: eligible[0] === 'WORK_ORDER' ? 'Reviewed work-order evidence is already bound to this field.'
        : eligible[0] === 'TECHNICIAN' ? 'Technician input is allowed by the published template.'
          : eligible[0] === 'KNOWLEDGE' ? 'Template-bound knowledge may guide this reference; it cannot establish a job fact.'
          : 'No eligible job-fact source is available in this session.',
    };
  });
}

export async function buildSourcePlan({ session, template, agentState, knowledgeAvailable = false, provider = null, model = '' } = {}) {
  const fields = ruleSourcePlan({ session, template, agentState, knowledgeAvailable });
  const choices = fields.filter((field) => field.eligible_sources.length > 1);
  const runtime = { provider: null, model: null, status: choices.length ? 'RULE_FALLBACK' : 'NO_SOURCE_CHOICE', error: null };
  if (choices.length && provider?.generateJson && model) {
    try {
      const result = await provider.generateJson({
        model, system: MODEL_SYSTEM,
        prompt: JSON.stringify({ template_id: template.templateId, template_version: template.templateVersion,
          fields: choices.map(({ field_id: fieldId, label, section, field_role: fieldRole, eligible_sources: eligibleSources }) => ({
            field_id: fieldId, label, section, field_role: fieldRole, eligible_sources: eligibleSources,
          })) }),
      });
      runtime.provider = result.provider || 'model'; runtime.model = result.model || model;
      const suggestions = new Map();
      for (const item of Array.isArray(result.data?.fields) ? result.data.fields : []) {
        if (typeof item?.field_id === 'string' && typeof item?.source === 'string' && !suggestions.has(item.field_id)) {
          suggestions.set(item.field_id, item.source);
        }
      }
      let accepted = 0;
      for (const field of fields) {
        const source = suggestions.get(field.field_id);
        if (!field.eligible_sources.includes(source) || field.eligible_sources.length < 2) continue;
        field.suggested_source = source;
        field.basis = 'MODEL_SUGGESTION';
        field.reason = source === 'KNOWLEDGE'
          ? `${runtime.model} suggested template-bound knowledge for reference guidance only; it does not establish a job fact.`
          : `${runtime.model} suggested ${source}; the server checked the manager rule and bound evidence.`;
        accepted += 1;
      }
      runtime.status = accepted ? 'MODEL_SUGGESTED' : 'MODEL_OUTPUT_REJECTED';
    } catch (error) {
      runtime.status = 'MODEL_FAILED'; runtime.error = error.code || 'MODEL_ERROR';
    }
  } else if (choices.length) runtime.status = 'MODEL_UNAVAILABLE';
  return { session_id: session.session_id, session_revision: session.revision, template_binding: session.template_binding,
    fields, model: runtime };
}
