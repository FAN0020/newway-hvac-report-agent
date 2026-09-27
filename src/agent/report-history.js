const STATUS_BY_PHASE = Object.freeze({
  CONTEXT: Object.freeze({ code: 'NOT_STARTED', label: 'Not started' }),
  CAPTURE: Object.freeze({ code: 'IN_PROGRESS', label: 'In progress' }),
  PROCESSING: Object.freeze({ code: 'PROCESSING', label: 'Processing' }),
  CORRECTION_IF_NEEDED: Object.freeze({ code: 'NEEDS_INPUT', label: 'Needs your input' }),
  RESOLVE: Object.freeze({ code: 'NEEDS_INPUT', label: 'Needs your input' }),
  REVIEW: Object.freeze({ code: 'IN_REVIEW', label: 'In review' }),
  READY: Object.freeze({ code: 'READY_TO_CONFIRM', label: 'Ready to confirm' }),
  CONFIRMED: Object.freeze({ code: 'CONFIRMED', label: 'Confirmed' }),
  RECOVERABLE_ERROR: Object.freeze({ code: 'NEEDS_ATTENTION', label: 'Needs attention' }),
});

function fieldValue(agentState, fieldIds) {
  for (const fieldId of fieldIds || []) {
    const field = agentState?.report_fields?.find((item) => item.field_id === fieldId);
    if (!field || !['KNOWN_VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE'].includes(field.state)) continue;
    if (field.state !== 'KNOWN_VALUE') continue;
    const value = field.value && typeof field.value === 'object' && 'value' in field.value
      ? `${field.value.value}${field.value.unit ? ` ${field.value.unit}` : ''}`
      : field.value;
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return null;
}

export function buildReportHistorySummary({
  session,
  template,
  agentState,
  confirmation = null,
  reportSnapshot = null,
  outputArtifacts = [],
} = {}) {
  if (!session?.session_id || !template?.templateId) throw new TypeError('Report history requires a ReportSession and template.');
  const bindings = template.historySummary || {};
  const serviceDate = fieldValue(agentState, bindings.serviceDateFields);
  const technician = fieldValue(agentState, bindings.technicianFields) || confirmation?.technician_name || null;
  const status = session.status === 'ERROR'
    ? STATUS_BY_PHASE.RECOVERABLE_ERROR
    : STATUS_BY_PHASE[session.phase] || Object.freeze({ code: 'IN_PROGRESS', label: 'In progress' });
  return Object.freeze({
    session_id: session.session_id,
    report_id: reportSnapshot?.report?.report_id || null,
    template: Object.freeze({
      template_id: template.templateId,
      display_name: template.presentation?.displayName || template.name,
      version: session.template_binding.template_version,
    }),
    created_at: session.created_at,
    updated_at: session.updated_at,
    service_date: serviceDate,
    display_date: serviceDate || session.created_at,
    display_date_source: serviceDate ? 'SERVICE_DATE' : 'CREATED_AT',
    technician,
    work_order: fieldValue(agentState, bindings.workOrderFields),
    asset: fieldValue(agentState, bindings.assetFields),
    status: Object.freeze({ ...status }),
    confirmed_at: confirmation?.confirmed_at || reportSnapshot?.confirmed_at || null,
    report_version: reportSnapshot?.report?.report_version ?? null,
    snapshot_id: reportSnapshot?.snapshot_id || null,
    output_artifacts: Object.freeze(structuredClone(outputArtifacts)),
  });
}
