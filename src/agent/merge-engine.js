import { createReportField } from '../domain/index.js';
import { activeCandidates, detectFieldConflicts } from './conflict-engine.js';
import { candidateRuleViolations } from './validation-rules.js';
import { definitionFor, definitionsForTemplate } from './template-policy.js';

export function mergeFieldCandidates({ session, template, candidates = [] } = {}) {
  const definitions = definitionsForTemplate(template);
  const fieldIds = [
    ...definitions.filter((definition) => !definition.id.endsWith('.*')).map((definition) => definition.id),
    ...candidates.map((candidate) => candidate.field_id),
  ];
  const ordered = [...new Set(fieldIds)];
  const conflicts = detectFieldConflicts(candidates);
  const conflictFields = new Set(conflicts.map((conflict) => conflict.field_id));
  const reportFields = ordered.map((fieldId) => {
    const fieldCandidates = candidates.filter((candidate) => candidate.field_id === fieldId);
    const { active, superseded_candidate_ids: superseded } = activeCandidates(fieldCandidates);
    const definition = definitionFor(definitions, fieldId) || { id: fieldId, type: 'string' };
    const invalid = active
      .filter((candidate) => candidateRuleViolations(candidate, definition).length > 0)
      .map((candidate) => candidate.candidate_id);
    return createReportField({
      session_id: session.session_id,
      field_id: fieldId,
      candidates: fieldCandidates,
      active_candidate_ids: active.map((candidate) => candidate.candidate_id),
      superseded_candidate_ids: superseded,
      invalid_candidate_ids: conflictFields.has(fieldId) ? [] : invalid,
    });
  });
  return Object.freeze({ report_fields: Object.freeze(reportFields), conflicts: Object.freeze(conflicts), definitions: Object.freeze(definitions) });
}

