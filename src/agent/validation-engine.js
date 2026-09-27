import { createValidationIssue } from '../domain/index.js';
import { candidateRuleViolations } from './validation-rules.js';
import { definitionFor, fieldLabel, isSafetyField } from './template-policy.js';

function refs(candidates) {
  return candidates.flatMap((candidate) => candidate.evidence_refs || []);
}

function issue(input) {
  return createValidationIssue(input);
}

function requirementSatisfied(field) {
  return ['KNOWN_VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE'].includes(field?.state);
}

function conditionActive(requiredWhen, byField) {
  if (!requiredWhen) return false;
  const dependency = byField.get(requiredWhen.field);
  if (requiredWhen.operator === 'HAS_VALUE') return dependency?.state === 'KNOWN_VALUE';
  if (requiredWhen.operator === 'IS') return dependency?.state === 'KNOWN_VALUE' && String(dependency.value) === String(requiredWhen.value);
  return false;
}

export function validateReportFields({ session, template, definitions, report_fields: reportFields, guidance_contexts: guidanceContexts = [] } = {}) {
  if (session.template_binding.template_id !== template.templateId || session.template_binding.template_version !== template.templateVersion) {
    return Object.freeze([issue({
      code: 'TEMPLATE_VERSION_MISMATCH', issue_type: 'TEMPLATE_COMPATIBILITY', severity: 'CRITICAL', blocking: true,
      field_id: null, reason: 'ReportSession and template bindings do not match exactly.', candidate_ids: [], evidence_refs: [],
      possible_resolution_type: 'INVALID',
    })]);
  }
  const issues = [];
  const byField = new Map(reportFields.map((field) => [field.field_id, field]));
  for (const field of reportFields) {
    const definition = definitionFor(definitions, field.field_id) || { id: field.field_id };
    const candidates = field.candidates || [];
    const evidenceRefs = refs(candidates);
    const candidateIds = candidates.map((candidate) => candidate.candidate_id);
    const label = fieldLabel(field.field_id, definition);
    const conditional = conditionActive(definition.requiredWhen, byField);
    if (definition.required && field.state === 'UNKNOWN') {
      issues.push(issue({
        code: 'REQUIRED_FIELD_MISSING', issue_type: 'MISSING', severity: isSafetyField(field.field_id, definition) ? 'CRITICAL' : 'ERROR', blocking: true,
        field_id: field.field_id, candidate_ids: [], evidence_refs: [], reason: `${label} is required by the bound template.`, possible_resolution_type: isSafetyField(field.field_id, definition) ? 'SAFETY_CONFIRMATION' : 'MISSING',
      }));
    } else if (conditional && field.state === 'UNKNOWN') {
      issues.push(issue({
        code: 'CONDITIONAL_FIELD_REQUIRED', issue_type: 'CONDITIONAL_REQUIREMENT', severity: 'ERROR', blocking: true,
        field_id: field.field_id, candidate_ids: [], evidence_refs: [], reason: `${label} became required because ${definition.requiredWhen.field} is present.`, possible_resolution_type: 'CONDITIONAL_REQUIREMENT',
      }));
    }
    if (field.state === 'CONFLICT') {
      issues.push(issue({
        code: 'FIELD_CONFLICT', issue_type: 'CONFLICT', severity: isSafetyField(field.field_id, definition) ? 'CRITICAL' : 'ERROR', blocking: true,
        field_id: field.field_id, candidate_ids: field.active_candidate_ids, evidence_refs: evidenceRefs, reason: `${label} has contradictory reliable evidence.`, possible_resolution_type: 'CONFLICT',
      }));
    }
    if (field.state === 'UNCERTAIN') {
      const blocking = definition.required === true || conditional || isSafetyField(field.field_id, definition);
      issues.push(issue({
        code: 'FIELD_UNCERTAIN', issue_type: 'UNCERTAIN', severity: blocking ? 'ERROR' : 'WARNING', blocking,
        field_id: field.field_id, candidate_ids: field.active_candidate_ids, evidence_refs: evidenceRefs, reason: `${label} is supported only by uncertain evidence.`, possible_resolution_type: isSafetyField(field.field_id, definition) ? 'SAFETY_CONFIRMATION' : 'UNCERTAIN',
      }));
    }
    if (field.state === 'INFERRED') {
      const blocking = definition.required === true || conditional || isSafetyField(field.field_id, definition);
      issues.push(issue({
        code: 'AI_INFERENCE_REQUIRES_CONFIRMATION', issue_type: 'INFERRED', severity: blocking ? 'ERROR' : 'WARNING', blocking,
        field_id: field.field_id, candidate_ids: field.active_candidate_ids, evidence_refs: evidenceRefs, reason: `${label} is inferred and cannot become an official fact without technician confirmation.`, possible_resolution_type: isSafetyField(field.field_id, definition) ? 'SAFETY_CONFIRMATION' : 'UNCERTAIN',
      }));
    }
    for (const candidate of candidates.filter((item) => field.active_candidate_ids.includes(item.candidate_id))) {
      for (const violation of candidateRuleViolations(candidate, definition)) {
        issues.push(issue({
          code: violation.code, issue_type: 'INVALID', severity: isSafetyField(field.field_id, definition) ? 'CRITICAL' : 'ERROR', blocking: true,
          field_id: field.field_id, candidate_ids: [candidate.candidate_id], evidence_refs: candidate.evidence_refs, reason: violation.reason,
          possible_resolution_type: isSafetyField(field.field_id, definition) ? 'SAFETY_CONFIRMATION' : 'INVALID',
        }));
      }
    }
    if (!['UNKNOWN', 'CONFLICT'].includes(field.state)) {
      const selected = candidates.filter((candidate) => field.selected_candidate_ids.includes(candidate.candidate_id));
      const relevant = selected.length ? selected : candidates.filter((candidate) => field.active_candidate_ids.includes(candidate.candidate_id));
      const requiresConfirmation = isSafetyField(field.field_id, definition)
        || relevant.some((candidate) => candidate.risk_class === 'CRITICAL');
      if (requiresConfirmation && !relevant.some((candidate) => candidate.support_type === 'TECHNICIAN_CONFIRMATION')) {
        issues.push(issue({
          code: 'CRITICAL_CONFIRMATION_REQUIRED', issue_type: 'SAFETY_CONFIRMATION', severity: 'CRITICAL', blocking: true,
          field_id: field.field_id, candidate_ids: relevant.map((candidate) => candidate.candidate_id), evidence_refs: refs(relevant), reason: `${label} requires explicit human confirmation.`, possible_resolution_type: 'SAFETY_CONFIRMATION',
        }));
      }
    }
  }
  for (const guidance of guidanceContexts) {
    if (guidance.support_type !== 'RAG_GUIDANCE' || guidance.eligible_as_job_evidence !== false) continue;
    for (const question of guidance.follow_up_questions || []) {
      const field = byField.get(question.field);
      if (!field || field.state !== 'UNKNOWN') continue;
      if (issues.some((item) => item.field_id === question.field && ['MISSING', 'CONDITIONAL_REQUIREMENT'].includes(item.issue_type))) continue;
      issues.push(issue({
        code: 'GUIDANCE_FOLLOW_UP', issue_type: 'CONDITIONAL_REQUIREMENT', severity: 'INFO', blocking: false,
        field_id: question.field, candidate_ids: [], evidence_refs: [], reason: question.question, possible_resolution_type: 'CONDITIONAL_REQUIREMENT',
      }));
    }
  }
  return Object.freeze(issues);
}

export function evaluateActiveCompleteness({ definitions, report_fields: reportFields, validation_issues: issues } = {}) {
  const blockingFields = new Set(issues.filter((issue) => issue.blocking && issue.field_id).map((issue) => issue.field_id));
  const conditional = new Set(issues.filter((issue) => issue.code === 'CONDITIONAL_FIELD_REQUIRED').map((issue) => issue.field_id));
  const required = new Set(definitions.filter((definition) => definition.required).map((definition) => definition.id));
  const categories = {
    complete_fields: [], missing_required_fields: [], missing_optional_fields: [], uncertain_fields: [],
    conflicting_fields: [], invalid_fields: [], inferred_fields: [], conditional_required_fields: [...conditional], critical_confirmation_fields: [],
  };
  for (const field of reportFields) {
    const definition = definitionFor(definitions, field.field_id) || {};
    if (field.state === 'UNKNOWN') {
      if (required.has(field.field_id) || conditional.has(field.field_id)) categories.missing_required_fields.push(field.field_id);
      else categories.missing_optional_fields.push(field.field_id);
    } else if (field.state === 'UNCERTAIN') categories.uncertain_fields.push(field.field_id);
    else if (field.state === 'CONFLICT') categories.conflicting_fields.push(field.field_id);
    else if (field.state === 'INVALID') categories.invalid_fields.push(field.field_id);
    else if (field.state === 'INFERRED') categories.inferred_fields.push(field.field_id);
    else if (!blockingFields.has(field.field_id) && requirementSatisfied(field)) categories.complete_fields.push(field.field_id);
    if (issues.some((issue) => issue.field_id === field.field_id && issue.issue_type === 'SAFETY_CONFIRMATION')) {
      categories.critical_confirmation_fields.push(field.field_id);
    }
    if (definition.requiredWhen && conditional.has(field.field_id) && !categories.conditional_required_fields.includes(field.field_id)) {
      categories.conditional_required_fields.push(field.field_id);
    }
  }
  const blocking_issue_ids = issues.filter((issue) => issue.blocking).map((issue) => issue.issue_id);
  return Object.freeze({ ...categories, blocking_issue_ids, complete: blocking_issue_ids.length === 0 });
}
