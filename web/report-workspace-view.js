const MAJOR_AREAS = Object.freeze(['APP_SHELL', 'JOB_HEADER', 'ACTIVE_TASK_PANEL', 'REPORT_SUMMARY']);

const FIELD_LABELS = Object.freeze({
  KNOWN_VALUE: 'Confirmed',
  UNKNOWN: 'Needs information',
  UNCERTAIN: 'Needs confirmation',
  CONFLICT: 'Resolve conflict',
  INVALID: 'Check value',
  INFERRED: 'Needs confirmation',
  EXPLICIT_NONE: 'None',
  NOT_APPLICABLE: 'Not applicable',
});

const RESOLUTION_CONTROLS = Object.freeze({
  SELECT_OR_PROVIDE: 'CHOICE_WITH_OTHER',
  SINGLE_SELECT: 'BUTTON_GROUP',
  SEMANTIC_STATE: 'BUTTON_GROUP',
  NONE_OR_VALUE: 'NONE_OR_DETAIL',
  CONFIRM_OR_REPLACE: 'CONFIRM_OR_REPLACE',
  VALUE: 'COMPACT_INPUT',
});

const PROCESSING_COPY = Object.freeze({
  RECORDING: ['RECORDING', 'Recording…', 'STOP_RECORDING'],
  PREPARING_AUDIO: ['PREPARING_AUDIO', 'Preparing recording…', null],
  UPLOADING_AUDIO: ['UPLOADING_AUDIO', 'Uploading recording…', null],
  TRANSCRIBING: ['TRANSCRIBING', 'Transcribing…', null],
  EXTRACTING: ['EXTRACTING', 'Extracting report details…', null],
  CHECKING_COMPLETENESS: ['CHECKING_COMPLETENESS', 'Checking completeness…', null],
});

function action(id, label) {
  return id ? { id, label } : null;
}

function displayValue(field) {
  if (field?.state === 'EXPLICIT_NONE') return 'None';
  if (field?.state === 'NOT_APPLICABLE') return 'Not applicable';
  const raw = field?.value;
  if (raw && typeof raw === 'object' && 'value' in raw) {
    return `${raw.value}${raw.unit ? ` ${raw.unit}` : ''}`;
  }
  if (raw !== null && raw !== undefined && raw !== '') return `${raw}${field?.unit ? ` ${field.unit}` : ''}`;
  return '—';
}

function sourceLabel(field) {
  if (field?.state === 'CONFLICT') return null;
  const selected = new Set(field?.selected_candidate_ids || []);
  const candidate = (field?.candidates || []).find((entry) => selected.has(entry.candidate_id))
    || field?.candidates?.[0];
  if (candidate?.extraction?.method === 'deterministic-rule') return 'Technician statement';
  const labels = {
    AUTHORITATIVE_SYSTEM_DATA: 'Work order',
    TRANSCRIPT_EVIDENCE: 'Technician statement',
    MANUAL_TECHNICIAN_INPUT: 'Technician answer',
    TECHNICIAN_CONFIRMATION: 'Confirmed by technician',
    DOCUMENT_EVIDENCE: 'Attached evidence',
    AI_INFERENCE: 'Needs technician confirmation',
  };
  return labels[candidate?.support_type] || null;
}

export function fieldDisplay(field = {}) {
  return {
    field_id: field.field_id || '',
    label: FIELD_LABELS[field.state] || 'Needs information',
    value: displayValue(field),
    source_label: sourceLabel(field),
    actionable: ['UNKNOWN', 'UNCERTAIN', 'CONFLICT', 'INVALID', 'INFERRED'].includes(field.state),
  };
}

export function resolutionControl(item = {}) {
  return {
    kind: RESOLUTION_CONTROLS[item.answer_type] || 'COMPACT_INPUT',
    options: (item.options || []).map((option) => ({
      value: option.value ?? option.candidate_id ?? option,
      label: option.label ?? String(option.value ?? option.candidate_id ?? option),
      source_label: option.source_label || null,
    })),
    allow_other: Boolean(item.allow_other),
  };
}

function deriveActiveTask(input) {
  const { session, agent_state: agentState, transcript, transcript_review: review, processing, recoverable_error: error } = input;
  if (!session) return { kind: 'LOADING_CONTEXT', title: 'Loading job…', primary_action: null };
  if (error) {
    const labels = {
      RETRY_TRANSCRIPTION: 'Retry transcription', RETRY_ATTACHMENT: 'Try attachment again',
      RETRY_CONNECTION: 'Try again', REFRESH_SESSION: 'Refresh report',
    };
    return {
      kind: 'RECOVERABLE_ERROR', title: error.message || 'Something interrupted this step.',
      message: 'Your saved work is still available.',
      error_kind: error.kind,
      primary_action: action(error.retry_action, labels[error.retry_action] || 'Try again'),
    };
  }
  if (processing && PROCESSING_COPY[processing]) {
    const [kind, title, primary] = PROCESSING_COPY[processing];
    return { kind, title, primary_action: action(primary, primary === 'STOP_RECORDING' ? 'Stop recording' : null) };
  }
  if (session.phase === 'CONTEXT') {
    return {
      kind: 'CAPTURE', title: 'Tell us what happened',
      microphone_available: input.interaction?.microphone_available !== false,
      primary_action: action('CAPTURE_STATEMENT', 'Submit statement'),
    };
  }
  const pendingCorrection = session.phase === 'CORRECTION_IF_NEEDED' && review?.status === 'PENDING';
  if (pendingCorrection) {
    return {
      kind: 'CORRECTION', title: 'Check what we heard', correction: review.items?.[0] || null,
      primary_action: action('DECIDE_CORRECTION', 'Apply decision'),
    };
  }
  const next = agentState?.resolution_queue?.[0];
  if (next) {
    return {
      kind: 'RESOLUTION', title: next.prompt, reason: next.reason, item: next,
      remaining: agentState.resolution_queue.length,
      control: resolutionControl(next),
      primary_action: action('ANSWER_RESOLUTION', 'Continue'),
    };
  }
  if (session.phase === 'REVIEW') {
    return { kind: 'REVIEW', title: 'Review exceptions and critical details', primary_action: action('COMPLETE_REVIEW', 'Finish review') };
  }
  if (session.phase === 'READY') {
    return { kind: 'READY', title: 'Report is ready to confirm', primary_action: action('CONFIRM_REPORT', 'Confirm report') };
  }
  if (session.phase === 'CONFIRMED') {
    return { kind: 'CONFIRMED', title: 'Report confirmed', primary_action: action('EXPORT_REPORT', 'Export report') };
  }
  if (transcript) {
    return {
      kind: 'CAPTURED', title: 'Initial statement captured', transcript_available: true,
      primary_action: action('CAPTURE_MORE', 'Add more detail'),
    };
  }
  return {
    kind: 'CAPTURE', title: 'Tell us what happened',
    microphone_available: input.interaction?.microphone_available !== false,
    primary_action: action('CAPTURE_STATEMENT', 'Submit statement'),
  };
}

function valueFor(fields, id, conflictLabel = 'Needs resolution') {
  const field = fields.find((entry) => entry.field_id === id);
  return field?.state === 'CONFLICT' ? conflictLabel : displayValue(field);
}

function buildSections(template, agentState, sessionPhase) {
  const fieldMap = new Map((agentState?.report_fields || []).map((field) => [field.field_id, field]));
  const unresolved = new Set((agentState?.resolution_queue || []).map((item) => item.field_id));
  const activeFieldId = agentState?.resolution_queue?.[0]?.field_id;
  const groups = new Map();
  for (const definition of template?.schema?.fields || []) {
    if (definition.id.endsWith('.*')) continue;
    const title = definition.section || 'Report';
    if (!groups.has(title)) groups.set(title, []);
    const field = fieldMap.get(definition.id) || { field_id: definition.id, state: 'UNKNOWN', value: null, candidates: [] };
    const display = fieldDisplay(field);
    if (!definition.required && field.state === 'UNKNOWN' && !unresolved.has(field.field_id)) {
      display.label = 'Optional · not provided';
      display.actionable = false;
    }
    groups.get(title).push({
      ...display,
      name: definition.label,
      state: field.state,
      editing: false,
      review_priority: Boolean(definition.critical || definition.requiresTechnicianConfirmation
        || field.candidates?.some((candidate) => candidate.extraction?.method === 'technician-resolution-answer')),
      has_provenance: Boolean(field.candidates?.some((candidate) => candidate.evidence_refs?.length)),
    });
  }
  return [...groups].map(([title, fields]) => {
    const needsAttention = fields.filter((field) => unresolved.has(field.field_id)).length;
    const reviewPriority = fields.filter((field) => field.review_priority).length;
    const activeIssueIsHere = fields.some((field) => field.field_id === activeFieldId);
    const reviewing = sessionPhase === 'REVIEW';
    return {
      title,
      status: needsAttention
        ? `${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`
        : reviewing && reviewPriority ? `${reviewPriority} to review` : 'Complete',
      needs_attention: needsAttention,
      review_priority: reviewPriority,
      expanded: sessionPhase === 'CONTEXT' ? false : reviewing ? reviewPriority > 0 : activeIssueIsHere,
      fields,
    };
  });
}

export function deriveWorkspaceView(input = {}) {
  const fields = input.agent_state?.report_fields || [];
  const completeness = input.agent_state?.completeness || {};
  const complete = completeness.complete_fields?.length || 0;
  const total = input.template?.schema?.fields?.filter((field) => !field.id.endsWith('.*')).length || fields.length;
  const identity = [
    valueFor(fields, 'work.work_order_id'),
    valueFor(fields, 'asset.internal_fleet_no', 'Bus ID needs resolution'),
    valueFor(fields, 'technician.name'),
  ].filter((value) => value !== '—').join(' · ');
  return {
    major_areas: [...MAJOR_AREAS],
    session_id: input.session?.session_id || null,
    session_phase: input.session?.phase || null,
    revision: input.session?.revision ?? null,
    job_header: {
      title: input.template?.name || 'Service report',
      identity_line: identity,
      complete,
      total,
      need_input: input.agent_state?.resolution_queue?.length || 0,
    },
    active_task: deriveActiveTask(input),
    report_sections: buildSections(input.template, input.agent_state, input.session?.phase),
  };
}
