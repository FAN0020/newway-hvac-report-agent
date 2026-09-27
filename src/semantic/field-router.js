const FIELD_COMPATIBILITY = Object.freeze({
  WORK_ORDER: ['work_order', 'work.work_order_id', 'work.order_id'],
  EQUIPMENT_OR_ASSET: ['equipment', 'asset.internal_fleet_no', 'asset.registration_no', 'asset.bus_model', 'asset.line', 'asset.station_section', 'asset.location'],
  TECHNICIAN_IDENTITY: ['technician.name'],
  CUSTOMER_OBSERVATION: ['customer_complaint', 'work.trigger', 'work.description'],
  INSPECTION_FINDING: ['inspection_findings', 'diagnosis.root_cause', 'check.*.observation'],
  COMPLETED_ACTION: ['work_performed', 'check.*.action'],
  PART_USED: ['parts.part_number', 'parts_used'],
  MEASUREMENT: ['measurement.*', 'measurements'],
  TEST_OUTCOME: ['test_results', 'test.result'],
  COMPLETION_STATE: ['completion_status', 'completion.state'],
  RECOMMENDATION: ['completion.follow_up'],
  FOLLOW_UP: ['completion.follow_up', 'completion.outstanding_issues'],
});

function matches(pattern, candidate) {
  if (pattern === candidate) return true;
  if (!pattern.includes('*')) return false;
  const [prefix, suffix] = pattern.split('*');
  return candidate.startsWith(prefix) && candidate.endsWith(suffix || '');
}

function compatiblePatterns(field, semanticType) {
  if (Array.isArray(field.semanticRoles)) {
    return field.semanticRoles.includes(semanticType) ? [field.id] : [];
  }
  return FIELD_COMPATIBILITY[semanticType] || [];
}

const TECHNICIAN_OWNED_FACTS = new Set([
  'INSPECTION_FINDING', 'COMPLETED_ACTION', 'PART_USED', 'MEASUREMENT',
  'TEST_ACTION', 'TEST_OUTCOME', 'COMPLETION_STATE', 'RECOMMENDATION', 'FOLLOW_UP',
]);
const COMPLETED_OR_OBSERVED_FACTS = new Set([
  'INSPECTION_FINDING', 'COMPLETED_ACTION', 'PART_USED', 'MEASUREMENT',
  'TEST_ACTION', 'TEST_OUTCOME', 'COMPLETION_STATE',
]);

function hasCompatibleContext(fact) {
  if (TECHNICIAN_OWNED_FACTS.has(fact.semantic_type) && fact.source_role !== 'TECHNICIAN') return false;
  if (COMPLETED_OR_OBSERVED_FACTS.has(fact.semantic_type)
    && !(['CURRENT', 'PAST', 'COMPLETED'].includes(fact.temporality)
      || (fact.claim_kind === 'EXPLICIT_NONE' && fact.temporality === 'NEGATED'))) return false;
  return true;
}

function checklistKind(fieldId) {
  return /^check\.[^.]+\.(?:observation|action)$/u.test(fieldId);
}

function subjectTokens(text) {
  return new Set(String(text || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)
    ?.map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token) || []);
}

function checklistSubject(fields, fact) {
  const checklists = fields.filter((field) => checklistKind(field.id));
  if (!checklists.length) return null;
  const tokenSets = checklists.map((field) => subjectTokens(field.id.split('.')[1].replaceAll('_', ' ')));
  const words = subjectTokens(`${fact.value || ''} ${fact.evidence_quote || ''}`);
  const matches = checklists.filter((_, index) => [...tokenSets[index]].some((token) => words.has(token)
    && tokenSets.filter((set) => set.has(token)).length === 1));
  return matches.length === 1 ? matches[0] : null;
}

function materializeFieldId(field, fact) {
  if (!field.id.includes('*')) return field.id;
  if (fact.semantic_type === 'MEASUREMENT') {
    return field.id.replace('*', String(fact.attributes?.measurement_kind || 'value'));
  }
  return null;
}

function schemaValue(field, fact) {
  if (fact.semantic_type !== 'COMPLETION_STATE' || !Array.isArray(field.allowedValues)) return fact.value;
  const allowed = new Map(field.allowedValues.map((value) => [String(value).toLocaleUpperCase(), value]));
  const normalized = String(fact.value || '').trim().toLocaleLowerCase();
  if (['done', 'complete', 'completed', 'ready', 'ready for service'].includes(normalized) && allowed.has('READY')) {
    return allowed.get('READY');
  }
  if (['not ready', 'incomplete'].includes(normalized) && allowed.has('NOT_READY')) return allowed.get('NOT_READY');
  if (allowed.has(normalized.toLocaleUpperCase())) return allowed.get(normalized.toLocaleUpperCase());
  return fact.value;
}

function eligibleFields(template, fact) {
  return (template?.schema?.fields || []).filter((field) => compatiblePatterns(field, fact.semantic_type)
    .some((pattern) => matches(pattern, field.id) || matches(field.id, pattern)));
}

function chooseField(fields, fact, captureContext) {
  const target = String(captureContext?.target_field_id || '');
  if (target) {
    const selected = fields.find((field) => matches(field.id, target) || matches(target, field.id));
    if (selected) return selected;
  }
  if (['INSPECTION_FINDING', 'COMPLETED_ACTION'].includes(fact.semantic_type)
    && fields.some((field) => checklistKind(field.id))) {
    const specific = checklistSubject(fields, fact);
    if (specific) return specific;
    return fields.find((field) => field.id === (fact.semantic_type === 'INSPECTION_FINDING'
      ? 'inspection_findings' : 'work_performed')) || null;
  }
  if (fact.semantic_type === 'EQUIPMENT_OR_ASSET') {
    const kind = fact.attributes?.identifier_kind;
    const preferred = kind === 'FLEET' ? 'asset.internal_fleet_no'
      : kind === 'EQUIPMENT' ? 'equipment'
        : kind === 'MODEL' ? 'asset.bus_model'
          : kind === 'REGISTRATION' ? 'asset.registration_no' : null;
    if (preferred) return fields.find((field) => field.id === preferred) || fields[0] || null;
  }
  if (fact.semantic_type === 'MEASUREMENT') {
    const exact = `measurement.${String(fact.attributes?.measurement_kind || '')}`;
    const fixed = fields.find((field) => field.id === exact);
    if (fixed) return fixed;
    return fields.find((field) => field.id === 'measurement.*') || fields[0] || null;
  }
  if (fact.semantic_type === 'FOLLOW_UP' && fact.attributes?.follow_up_kind === 'OUTSTANDING_ISSUES') {
    return fields.find((field) => field.id === 'completion.outstanding_issues') || fields[0] || null;
  }
  return fields[0] || null;
}

export function routeAtomicFacts({ facts = [], template, capture_context: captureContext = null } = {}) {
  const assignments = [];
  const unassigned = [];
  for (const fact of facts) {
    if (!hasCompatibleContext(fact)) {
      unassigned.push({ fact, reason: 'INCOMPATIBLE_SEMANTIC_CONTEXT' });
      continue;
    }
    const fields = eligibleFields(template, fact);
    const selected = chooseField(fields, fact, captureContext);
    const fieldId = selected ? materializeFieldId(selected, fact) : null;
    if (!fieldId) {
      const reason = !fields.length ? 'NO_COMPATIBLE_FIELD'
        : !selected && fields.some((field) => checklistKind(field.id))
          ? 'AMBIGUOUS_CHECKLIST_SUBJECT' : 'UNMATERIALIZED_SCHEMA_FIELD';
      unassigned.push({ fact, reason });
      continue;
    }
    assignments.push({
      field_id: fieldId,
      value: schemaValue(selected, fact),
      ...(fact.unit ? { unit: fact.unit } : {}),
      claim_kind: fact.claim_kind || 'VALUE',
      support_status: fact.support_status,
      semantic_type: fact.semantic_type,
      source_span: { start: fact.char_start, end: fact.char_end, text: fact.evidence_quote },
      fact,
      critical: Boolean(selected.critical || selected.requiresTechnicianConfirmation || fact.attributes?.critical),
    });
  }
  return { assignments, unassigned };
}

export function semanticCompatibilityForField(fieldId) {
  return Object.entries(FIELD_COMPATIBILITY)
    .filter(([, patterns]) => patterns.some((pattern) => matches(pattern, fieldId) || matches(fieldId, pattern)))
    .map(([semanticType]) => semanticType);
}
