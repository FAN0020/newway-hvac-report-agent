import { mergeFieldCandidates } from './merge-engine.js';
import { evaluateActiveCompleteness, validateReportFields } from './validation-engine.js';
import { planResolutions } from './resolution-planner.js';

export const AGENT_PROCESSING_VERSION = 'authoritative-report-agent.v1';

export function runAuthoritativeAgent({ session, template, candidates = [], guidance_contexts: guidanceContexts = [],
  semantic_trace: semanticTrace = null, created_at: createdAt } = {}) {
  const merged = mergeFieldCandidates({ session, template, candidates });
  const validationIssues = validateReportFields({
    session, template, definitions: merged.definitions, report_fields: merged.report_fields, guidance_contexts: guidanceContexts,
  });
  const completeness = evaluateActiveCompleteness({
    definitions: merged.definitions, report_fields: merged.report_fields, validation_issues: validationIssues,
  });
  const priorReasons = new Map((semanticTrace?.missing_information || []).map((item) => [item.field_id, item.reason]));
  const unresolvedInformation = merged.report_fields.filter((field) => !['KNOWN_VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE'].includes(field.state))
    .map((field) => ({
      field_id: field.field_id,
      reason: field.state === 'CONFLICT' ? 'CONFLICTING'
        : field.state === 'INVALID' ? 'MENTIONED_BUT_INVALID'
          : priorReasons.get(field.field_id) || 'NOT_MENTIONED',
      required: Boolean(merged.definitions.find((definition) => definition.id === field.field_id)?.required),
    }));
  const resolutionQueue = planResolutions({
    definitions: merged.definitions, report_fields: merged.report_fields, validation_issues: validationIssues,
    unresolved_information: unresolvedInformation,
  });
  return Object.freeze({
    contract: 'AuthoritativeAgentState',
    contract_version: '1',
    processing_version: AGENT_PROCESSING_VERSION,
    session_id: session.session_id,
    session_revision: session.revision,
    template_binding: structuredClone(session.template_binding),
    created_at: createdAt,
    report_fields: merged.report_fields,
    conflicts: merged.conflicts,
    validation_issues: validationIssues,
    completeness,
    unresolved_information: unresolvedInformation,
    resolution_queue: resolutionQueue,
  });
}

export function officialFactsFromAgentState(agentState) {
  const blocked = new Set((agentState.validation_issues || [])
    .filter((issue) => issue.blocking && issue.field_id)
    .map((issue) => issue.field_id));
  return (agentState.report_fields || []).flatMap((field) => {
    if (blocked.has(field.field_id) || !['KNOWN_VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE'].includes(field.state)) return [];
    const selected = field.candidates.filter((candidate) => field.selected_candidate_ids.includes(candidate.candidate_id));
    if (!selected.length || selected.some((candidate) => candidate.support_type === 'RAG_GUIDANCE')) return [];
    const value = field.state === 'EXPLICIT_NONE' ? 'None' : field.state === 'NOT_APPLICABLE' ? 'Not applicable' : field.value;
    const supportTypes = new Set(selected.map((candidate) => candidate.support_type));
    return [{
      fact_id: selected.at(-1).candidate_id,
      field: field.field_id,
      value,
      ...(field.unit ? { unit: field.unit } : {}),
      support_status: supportTypes.has('TECHNICIAN_CONFIRMATION') ? 'CONFIRMED_BY_TECHNICIAN' : 'CONFIRMED_BY_EVIDENCE',
      source: `report-session:${agentState.session_id}`,
      source_refs: [...new Set(selected.flatMap((candidate) => candidate.evidence_refs.map((reference) => (
        reference.span_id ? `${reference.evidence_id}#${reference.span_id}` : reference.evidence_id
      ))))],
      critical: selected.some((candidate) => candidate.risk_class === 'CRITICAL'),
    }];
  });
}
