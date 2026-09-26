function ordered(fields) {
  return [...fields].sort((left, right) => Number(left.displayOrder || 0) - Number(right.displayOrder || 0));
}

export function groupTemplateFields(fields = []) {
  const sections = new Map();
  for (const field of ordered(fields)) {
    if (!sections.has(field.section)) sections.set(field.section, []);
    sections.get(field.section).push(field);
  }

  return [...sections].map(([name, sectionFields]) => {
    const checklist = new Map();
    const rows = [];
    for (const field of sectionFields) {
      const match = /^check\.([^.]+)\.(status|observation|action)$/u.exec(field.id);
      if (!match) {
        rows.push({ id: field.id, kind: 'field', label: field.label, order: field.displayOrder, fields: [field] });
        continue;
      }
      const [, slug, role] = match;
      if (!checklist.has(slug)) checklist.set(slug, { id: `check.${slug}`, kind: 'checklist', label: field.label, order: field.displayOrder, fieldsByRole: {} });
      const row = checklist.get(slug);
      row.order = Math.min(row.order, field.displayOrder);
      row.fieldsByRole[role] = field;
      if (role === 'status') row.label = field.label;
    }
    for (const row of checklist.values()) {
      row.fields = ['status', 'observation', 'action'].map((role) => row.fieldsByRole[role]).filter(Boolean);
      delete row.fieldsByRole;
      rows.push(row);
    }
    rows.sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
    return { name, layout: checklist.size ? 'checklist' : 'compact', rows };
  });
}

export function reportStatusSummary(completeness = {}, confirmed = false) {
  const requiredFields = completeness.requiredFields || [];
  const required = requiredFields.length;
  const missingFields = completeness.missingFields || [];
  const missing = missingFields.length;
  const blockedRequired = new Set([
    ...missingFields,
    ...(completeness.conflicts || []),
    ...(completeness.needsConfirmation || []),
  ].filter((fieldId) => requiredFields.includes(fieldId)));
  const resolved = Math.max(0, required - blockedRequired.size);
  let state = 'NEEDS_INFORMATION';
  let stateLabel = 'Needs information';
  if (confirmed) {
    state = 'CONFIRMED';
    stateLabel = 'Confirmed';
  } else if (missing === 0 && ((completeness.conflicts?.length || 0) > 0 || (completeness.needsConfirmation?.length || 0) > 0)) {
    state = 'NEEDS_CONFIRMATION';
    stateLabel = 'Needs confirmation';
  } else if (completeness.complete) {
    state = 'READY';
    stateLabel = 'Ready';
  }
  return { resolved, required, countLabel: `${resolved} / ${required} required`, state, stateLabel };
}

export function controlValueForField(field = {}, value) {
  if (field.type === 'status' && (value === null || value === undefined || value === '')) return 'NOT_CHECKED';
  return value ?? '';
}

export function fieldStatusPresentation(fieldState, field = {}) {
  if (fieldState?.status === 'CONFLICT') return { tone: 'conflict', label: 'Conflict', detail: 'Choose the observed value' };
  if (fieldState?.status === 'NEEDS_CONFIRMATION') return { tone: 'confirmation', label: 'Needs confirmation', detail: field.critical ? 'Critical value' : 'Confirm this value' };
  if (fieldState?.status === 'SUPPORTED' && fieldState.value !== null && fieldState.value !== '') return { tone: 'supported', label: '✓ Supported', detail: '' };
  if (field.required) return { tone: 'missing', label: 'Missing', detail: '' };
  return { tone: 'optional', label: 'Optional', detail: '' };
}
