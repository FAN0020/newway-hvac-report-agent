export function matchesField(pattern, fieldId) {
  return pattern.endsWith('.*') ? fieldId.startsWith(pattern.slice(0, -1)) : pattern === fieldId;
}

const POLICY_OVERRIDES = Object.freeze({
  'bus-defect-rectification-corrective-maintenance': Object.freeze({
    'measurement.odometer_km': Object.freeze({ minimum: 0, maximum: 2_000_000 }),
    'diagnosis.root_cause': Object.freeze({ allowNotEstablished: true }),
    'test.result': Object.freeze({
      required: false,
      requiredWhen: Object.freeze({ field: 'work_performed', operator: 'HAS_VALUE' }),
    }),
  }),
});

export function definitionsForTemplate(template) {
  const overrides = POLICY_OVERRIDES[template.templateId] || {};
  return (template.schema?.fields || []).map((definition) => Object.freeze({
    ...structuredClone(definition),
    ...(overrides[definition.id] || {}),
  }));
}

export function definitionFor(definitions, fieldId) {
  return definitions.find((definition) => matchesField(definition.id, fieldId)) || null;
}

export function isSafetyField(fieldId, definition = {}) {
  return definition.critical === true
    || definition.requiresTechnicianConfirmation === true
    || /^(safety\.|completion\.state$|handover\.)/u.test(fieldId);
}

export function fieldLabel(fieldId, definition = {}) {
  return definition.label || fieldId.replaceAll(/[._]/gu, ' ');
}

