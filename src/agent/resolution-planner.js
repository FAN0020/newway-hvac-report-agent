import { createResolutionItem } from '../domain/index.js';
import { candidateValue } from './validation-rules.js';
import { definitionFor, fieldLabel, isSafetyField } from './template-policy.js';

function priorityFor(issues, definition, fieldId) {
  if (isSafetyField(fieldId, definition) || issues.some((issue) => issue.issue_type === 'SAFETY_CONFIRMATION')) return { rank: 1, name: 'SAFETY' };
  if (issues.some((issue) => issue.issue_type === 'CONFLICT')) return { rank: 2, name: 'CONFLICT' };
  if (issues.some((issue) => issue.issue_type === 'MISSING' && issue.blocking)) return { rank: 3, name: 'REQUIRED_MISSING' };
  if (issues.some((issue) => ['UNCERTAIN', 'INFERRED'].includes(issue.issue_type) && issue.blocking)) return { rank: 4, name: 'REQUIRED_UNCERTAIN' };
  if (issues.some((issue) => issue.blocking)) return { rank: 5, name: 'DETERMINISTIC_RULE_VIOLATION' };
  return { rank: 6, name: 'OPTIONAL_CLARIFICATION' };
}

function typeFor(issues, definition, fieldId) {
  if (isSafetyField(fieldId, definition) || issues.some((issue) => issue.issue_type === 'SAFETY_CONFIRMATION')) return 'SAFETY_CONFIRMATION';
  if (issues.some((issue) => issue.issue_type === 'CONFLICT')) return 'CONFLICT';
  if (issues.some((issue) => issue.issue_type === 'MISSING')) return 'MISSING';
  if (issues.some((issue) => issue.issue_type === 'CONDITIONAL_REQUIREMENT')) return 'CONDITIONAL_REQUIREMENT';
  if (issues.some((issue) => issue.issue_type === 'INVALID')) return 'INVALID';
  return 'UNCERTAIN';
}

function answerSpec(type, field, definition) {
  const allowed = definition.allowedValues || definition.allowedStatuses;
  if (type === 'CONFLICT') {
    return {
      answer_type: 'SELECT_OR_PROVIDE',
      options: field.active_candidate_ids.map((id) => {
        const candidate = field.candidates.find((item) => item.candidate_id === id);
        const { value, unit } = candidateValue(candidate);
        return { candidate_id: id, value, unit, support_type: candidate.support_type };
      }),
      allow_other: true,
    };
  }
  if (allowed?.length) return { answer_type: 'SINGLE_SELECT', options: allowed.map((value) => ({ value })), allow_other: false };
  if (definition.allowNotEstablished) {
    return {
      answer_type: 'SEMANTIC_STATE',
      options: [
        { value: 'NOT_ESTABLISHED', label: 'Root cause not established' },
        { value: 'FURTHER_INVESTIGATION_REQUIRED', label: 'Further investigation required' },
        { value: 'SUSPECTED', label: 'Suspected root cause' },
        { value: 'CONFIRMED', label: 'Confirmed root cause' },
      ],
      allow_other: true,
    };
  }
  if (/outstanding_issues/u.test(field.field_id)) return { answer_type: 'NONE_OR_VALUE', options: [{ value: 'NONE', label: 'None' }], allow_other: true };
  if (type === 'UNCERTAIN' || type === 'SAFETY_CONFIRMATION') return { answer_type: 'CONFIRM_OR_REPLACE', options: [], allow_other: true };
  return { answer_type: 'VALUE', options: [], allow_other: true };
}

function promptFor(type, field, definition, issues) {
  const label = fieldLabel(field.field_id, definition);
  if (type === 'CONFLICT') return `Which supported value is correct for ${label}?`;
  if (type === 'SAFETY_CONFIRMATION') return `Confirm the observed ${label}.`;
  if (type === 'CONDITIONAL_REQUIREMENT') return issues.find((issue) => issue.code === 'GUIDANCE_FOLLOW_UP')?.reason || `Provide ${label} because it is now required.`;
  if (type === 'INVALID') return `Correct ${label}; the current value violates a deterministic rule.`;
  if (type === 'UNCERTAIN') return `Confirm or correct the observed ${label}.`;
  return `Provide the required ${label}.`;
}

export function planResolutions({ definitions, report_fields: reportFields, validation_issues: issues } = {}) {
  const byField = new Map();
  for (const issue of issues) {
    if (!issue.field_id) continue;
    if (!byField.has(issue.field_id)) byField.set(issue.field_id, []);
    byField.get(issue.field_id).push(issue);
  }
  const queue = [];
  for (const [fieldId, fieldIssues] of byField) {
    const field = reportFields.find((item) => item.field_id === fieldId);
    if (!field) continue;
    const definition = definitionFor(definitions, fieldId) || { id: fieldId };
    const type = typeFor(fieldIssues, definition, fieldId);
    const priority = priorityFor(fieldIssues, definition, fieldId);
    const answer = answerSpec(type, field, definition);
    queue.push(createResolutionItem({
      issue_ids: fieldIssues.map((issue) => issue.issue_id),
      type,
      field_id: fieldId,
      candidate_ids: [...new Set(fieldIssues.flatMap((issue) => issue.candidate_ids))],
      prompt: promptFor(type, field, definition, fieldIssues),
      reason: fieldIssues.map((issue) => issue.reason).join(' '),
      priority: priority.rank,
      priority_class: priority.name,
      answer_type: answer.answer_type,
      options: answer.options,
      allow_other: answer.allow_other,
      status: 'OPEN',
    }));
  }
  return Object.freeze(queue.sort((a, b) => a.priority - b.priority || a.field_id.localeCompare(b.field_id)));
}

