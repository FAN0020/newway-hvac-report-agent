const NEGATED_ACTION_RE = /\b(?:did\s+not|never)\s+(?:replace|install|remove|repair|perform|complete)|\bnot\s+(?:replaced|installed|removed|repaired|performed|completed)|未更换|没有更换|未完成/iu;
const PLANNED_ACTION_RE = /\b(?:will|plan(?:ned)?\s+to|recommend(?:ed|s)?|should|to\s+be)\s+(?:replace|install|remove|repair|perform|complete)|建议|计划|将(?:要)?/iu;
const NEGATED_RETURN_RE = /\b(?:not|never|did\s+not)\s+(?:returned?|return|back)\s+(?:to\s+)?service|未回役|没有恢复运行|未恢复运行/iu;
const GARBLED_RE = /[\uFFFD\uFFFE\uFFFF]|\?\?\?|\u0000/u;

export function candidateValue(candidate) {
  if (candidate.claim?.kind !== 'VALUE') return { value: null, unit: candidate.unit || null };
  const raw = candidate.claim.value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'value')) {
    return { value: raw.value, unit: raw.unit || candidate.unit || null };
  }
  return { value: raw, unit: candidate.unit || null };
}

function normalizedUnit(unit) {
  return String(unit ?? '').trim().toLowerCase().replaceAll('℃', '°c').replaceAll(' ', '');
}

export function candidateRuleViolations(candidate, definition = {}) {
  const violations = [];
  const push = (code, reason) => violations.push({ code, reason });
  const semantic = candidate.semantic;
  if (semantic?.semantic_type) {
    if (candidate.claim?.kind === 'EXPLICIT_NONE' && !['PART_USED', 'FOLLOW_UP'].includes(semantic.semantic_type)) {
      push('EXPLICIT_NONE_SEMANTIC_MISMATCH', `${semantic.semantic_type} cannot establish explicit none.`);
    }
    if (Array.isArray(definition.semanticRoles) && !definition.semanticRoles.includes(semantic.semantic_type)) {
      push('SEMANTIC_FIELD_MISMATCH', `${semantic.semantic_type} is not compatible with ${definition.id || candidate.field_id}.`);
    }
    if (['CUSTOMER', 'CLIENT', 'DRIVER', 'OPERATOR'].includes(semantic.source_role)
      && !['CUSTOMER_OBSERVATION', 'CUSTOMER_COMPLAINT'].includes(semantic.semantic_type)) {
      push('SEMANTIC_SOURCE_MISMATCH', 'A reported issue cannot establish technician-observed or performed work.');
    }
    if (['COMPLETED_ACTION', 'PART_USED', 'TEST_ACTION', 'TEST_OUTCOME', 'TEST_OBSERVATION', 'COMPLETION_STATE'].includes(semantic.semantic_type)
      && ['FUTURE', 'NEGATED', 'RECOMMENDED'].includes(semantic.temporality)) {
      push('SEMANTIC_TEMPORALITY_MISMATCH', 'Future, recommended, or negated work cannot establish a completed job fact.');
    }
  }
  if (candidate.support_type === 'RAG_GUIDANCE' || candidate.evidence_refs?.some((ref) => String(ref.evidence_id).startsWith('guidance_'))) {
    push('INELIGIBLE_EVIDENCE', 'GuidanceContext is not eligible job evidence.');
  }
  if (candidate.claim?.kind !== 'VALUE') return violations;
  const { value, unit } = candidateValue(candidate);
  const type = definition.type || 'string';
  if ((type === 'number' || type === 'measurement') && (typeof value !== 'number' || !Number.isFinite(value))) {
    push('TYPE_MISMATCH', `${definition.id || candidate.field_id} requires a finite numeric value.`);
  } else if ((type === 'string' || type === 'text' || type === 'status') && typeof value !== 'string') {
    push('TYPE_MISMATCH', `${definition.id || candidate.field_id} requires a string value.`);
  } else if (type === 'boolean' && typeof value !== 'boolean') {
    push('TYPE_MISMATCH', `${definition.id || candidate.field_id} requires a boolean value.`);
  } else if (type === 'structured' && (value === null || typeof value !== 'object')) {
    push('TYPE_MISMATCH', `${definition.id || candidate.field_id} requires structured data.`);
  }
  const allowed = definition.allowedValues || definition.allowedStatuses;
  if (allowed && !allowed.includes(String(value))) {
    push('VALUE_NOT_ALLOWED', `${String(value)} is outside the template allow-list.`);
  }
  if (definition.allowedUnits && unit && !definition.allowedUnits.map(normalizedUnit).includes(normalizedUnit(unit))) {
    push('UNIT_NOT_ALLOWED', `${unit} is not permitted for this field.`);
  }
  if (typeof value === 'number' && Number.isFinite(definition.minimum) && value < definition.minimum) {
    push('VALUE_BELOW_MINIMUM', `${value} is below the defined minimum ${definition.minimum}.`);
  }
  if (typeof value === 'number' && Number.isFinite(definition.maximum) && value > definition.maximum) {
    push('VALUE_ABOVE_MAXIMUM', `${value} is above the defined maximum ${definition.maximum}.`);
  }
  const text = typeof value === 'string' ? value : '';
  if (/^(work_performed|parts\.replaced|test\.result)$/u.test(candidate.field_id) && NEGATED_ACTION_RE.test(text)) {
    push('NEGATED_ACTION_NOT_PERFORMED', 'A negated action cannot be rendered as completed work.');
  }
  if (/^(work_performed|parts\.replaced|test\.result)$/u.test(candidate.field_id) && PLANNED_ACTION_RE.test(text)) {
    push('PLANNED_ACTION_NOT_COMPLETED', 'Planned or recommended work cannot be rendered as completed work.');
  }
  if (candidate.field_id === 'completion.state' && NEGATED_RETURN_RE.test(text)) {
    push('NEGATED_RETURN_TO_SERVICE', 'A negative return-to-service statement cannot establish a positive completion state.');
  }
  if (/^(asset\.|work\.(?:work_order_id|order_id)$)/u.test(candidate.field_id) && (typeof value !== 'string' || !value.trim() || GARBLED_RE.test(value))) {
    push('INVALID_IDENTITY', 'Asset and work-order identities must be non-empty and non-garbled.');
  }
  return violations;
}
