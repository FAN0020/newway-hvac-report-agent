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

function projectResolutionItem(item, field) {
  if (!item) return null;
  return {
    ...item,
    options: (item.options || []).map((option) => {
      const candidate = field?.candidates?.find((entry) => entry.candidate_id === option.candidate_id);
      return {
        ...option,
        source_label: candidate
          ? sourceLabel({ ...field, state: 'KNOWN_VALUE', candidates: [candidate], selected_candidate_ids: [candidate.candidate_id] })
          : option.source_label || null,
      };
    }),
  };
}

function claimValue(candidate) {
  if (candidate?.claim?.kind === 'EXPLICIT_NONE') return 'None';
  if (candidate?.claim?.kind === 'NOT_APPLICABLE') return 'Not applicable';
  const raw = candidate?.claim?.value;
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'value')) return `${raw.value}${raw.unit ? ` ${raw.unit}` : ''}`;
  return raw === null || raw === undefined ? '' : String(raw);
}

function fieldRepresentations(field, chain) {
  const transcripts = new Map((chain?.transcripts || []).map((item) => [item.transcript_id, item]));
  const spans = new Map((chain?.evidence_spans || []).map((item) => [item.span_id, item]));
  const candidates = field?.candidates || [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const selectedCandidateIds = new Set(field?.selected_candidate_ids || []);
  const selectedSourceIds = new Set();
  const selectedTranscriptSpanIds = new Set();
  for (const selected of candidates.filter((candidate) => selectedCandidateIds.has(candidate.candidate_id))) {
    const source = selected.support_type === 'TECHNICIAN_CONFIRMATION' && selected.confirmed_candidate_id
      ? candidateById.get(selected.confirmed_candidate_id)
      : selected;
    if (!source) continue;
    selectedSourceIds.add(source.candidate_id);
    if (source.extraction?.method === 'technician-transcript-selection') {
      for (const reference of source.evidence_refs || []) {
        if (reference.span_id) selectedTranscriptSpanIds.add(reference.span_id);
      }
    }
  }
  const drafts = [];
  const originalWords = [];
  const manual = [];
  const seenDrafts = new Set();
  const seenWords = new Set();
  const seenManual = new Set();
  for (const candidate of candidates) {
    const method = candidate.extraction?.method || '';
    const value = claimValue(candidate);
    if (candidate.support_type !== 'TECHNICIAN_CONFIRMATION'
      && !['technician-field-selection', 'technician-resolution-answer', 'technician-transcript-selection'].includes(method)
      && value && !seenDrafts.has(`${candidate.candidate_id}:${value}`)) {
      seenDrafts.add(`${candidate.candidate_id}:${value}`);
      drafts.push({
        kind: 'CANDIDATE', candidate_id: candidate.candidate_id, value,
        source_label: sourceLabel({ ...field, candidates: [candidate], selected_candidate_ids: [candidate.candidate_id] }) || 'Report evidence',
        selected: selectedSourceIds.has(candidate.candidate_id),
      });
    }
    if (candidate.support_type !== 'TECHNICIAN_CONFIRMATION' && ['technician-field-selection', 'technician-resolution-answer'].includes(method)
      && value && !seenManual.has(value)) {
      seenManual.add(value);
      manual.push({
        kind: 'CANDIDATE', candidate_id: candidate.candidate_id, value, source_label: 'My edit',
        selected: selectedSourceIds.has(candidate.candidate_id),
      });
    }
    for (const reference of candidate.evidence_refs || []) {
      const span = spans.get(reference.span_id);
      const transcript = transcripts.get(reference.evidence_id);
      if (!span || !transcript) continue;
      const words = transcript.raw_text.slice(span.start_offset, span.end_offset);
      const key = `${reference.span_id}:${words}`;
      if (!words || seenWords.has(key)) continue;
      seenWords.add(key);
      originalWords.push({
        kind: 'TRANSCRIPT_SPAN', candidate_id: candidate.candidate_id, span_id: reference.span_id,
        value: words, source_label: 'Original words', selected: selectedTranscriptSpanIds.has(reference.span_id),
      });
    }
  }
  return { drafts, original_words: originalWords, manual };
}

export function fieldDisplay(field = {}, chain = null) {
  return {
    field_id: field.field_id || '',
    label: FIELD_LABELS[field.state] || 'Needs information',
    value: displayValue(field),
    source_label: sourceLabel(field),
    actionable: ['UNKNOWN', 'UNCERTAIN', 'CONFLICT', 'INVALID', 'INFERRED'].includes(field.state),
    representations: fieldRepresentations(field, chain),
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

function historyDate(value, timeZone) {
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/iu.test(String(value || ''))) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        ...(timeZone ? { timeZone } : {}),
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(date).map(({ type, value: part }) => [type, part]));
      return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
    }
  }
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/u);
  if (!match) return 'Date unavailable';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
  return match[4] ? `${date}, ${match[4]}:${match[5]}` : date;
}

export function deriveReportHistoryRow(summary = {}, { timeZone } = {}) {
  const identity = [summary.work_order, summary.asset].filter(Boolean);
  const dateLabel = summary.service_date ? 'Service' : 'Created';
  identity.push(`${dateLabel} ${historyDate(summary.service_date || summary.created_at, timeZone)}`);
  return {
    title: summary.report_name || summary.template?.display_name || 'Service report',
    secondary: identity.join(' · '),
    status: summary.status?.label || 'In progress',
  };
}

export function sortReportHistoryItems(items = []) {
  return [...items].sort((left, right) => {
    const leftUpdated = left?.workspace?.history?.updated_at || left?.workspace?.session?.updated_at || '';
    const rightUpdated = right?.workspace?.history?.updated_at || right?.workspace?.session?.updated_at || '';
    return String(rightUpdated).localeCompare(String(leftUpdated)) || String(left?.key || '').localeCompare(String(right?.key || ''));
  });
}

function deriveActiveTask(input) {
  const { session, agent_state: agentState, transcript, transcript_review: review, processing, recoverable_error: error } = input;
  if (!session) return { kind: 'LOADING_CONTEXT', title: 'Loading job…', primary_action: null };
  if (error) {
    const labels = {
      RETRY_TRANSCRIPTION: 'Retry transcription', RETRY_ATTACHMENT: 'Try attachment again',
      RETRY_AUDIO_UPLOAD: 'Choose another recording',
      RETRY_CONNECTION: 'Try again', RETRY_INPUT: 'Edit answer', REFRESH_SESSION: 'Refresh report',
    };
    return {
      kind: 'RECOVERABLE_ERROR', title: error.message || 'Something interrupted this step.',
      message: 'Your saved work is still available.',
      error_kind: error.kind,
      primary_action: action(error.retry_action, labels[error.retry_action] || 'Try again'),
    };
  }
  const processingBelongsToSession = !input.processing_session_id || input.processing_session_id === session.session_id;
  if (processing && processingBelongsToSession && PROCESSING_COPY[processing]) {
    const [kind, title, primary] = PROCESSING_COPY[processing];
    return { kind, title, primary_action: action(primary, primary === 'STOP_RECORDING' ? 'Stop & fill report' : null) };
  }
  if (session.phase === 'CONTEXT') {
    return {
      kind: 'CAPTURE', title: 'Tell us what happened', composer_visible: true,
      microphone_available: input.interaction?.microphone_available !== false,
      primary_action: action('CAPTURE_STATEMENT', 'Submit statement'),
    };
  }
  const pendingCorrection = session.phase === 'CORRECTION_IF_NEEDED' && review?.status === 'PENDING';
  if (pendingCorrection) {
    const correction = review.items?.find((item) => item.material !== false && item.impact_class !== 'NON_MATERIAL') || null;
    return {
      kind: 'CORRECTION', title: 'Check what we heard', correction,
      primary_action: action('DECIDE_CORRECTION', 'Apply decision'),
    };
  }
  const next = agentState?.resolution_queue?.[0];
  if (next) {
    return {
      kind: 'REPORT_REVIEW', title: `${agentState.resolution_queue.length} ${agentState.resolution_queue.length === 1 ? 'detail needs' : 'details need'} attention`, composer_visible: true,
      remaining: agentState.resolution_queue.length,
      primary_action: action('CAPTURE_MISSING_DETAILS', 'Fill missing details'),
    };
  }
  if (session.phase === 'REVIEW') {
    return { kind: 'REVIEW', title: 'Review the completed report', composer_visible: true, primary_action: action('SUBMIT_REPORT', 'Submit report') };
  }
  if (session.phase === 'READY') {
    return { kind: 'READY', title: 'Report is ready to submit', primary_action: action('SUBMIT_REPORT', 'Submit report') };
  }
  if (session.phase === 'CONFIRMED') {
    return { kind: 'CONFIRMED', title: 'Report confirmed', primary_action: action('EXPORT_REPORT', 'Export report') };
  }
  if (transcript) {
    return {
      kind: 'CAPTURED', title: 'Initial statement captured', transcript_available: true, composer_visible: true,
      primary_action: action('CAPTURE_MORE', 'Add more detail'),
    };
  }
  return {
    kind: 'CAPTURE', title: 'Tell us what happened', composer_visible: true,
    microphone_available: input.interaction?.microphone_available !== false,
    primary_action: action('CAPTURE_STATEMENT', 'Submit statement'),
  };
}

function valueFor(fields, id, conflictLabel = 'Needs resolution') {
  const field = fields.find((entry) => entry.field_id === id);
  return field?.state === 'CONFLICT' ? conflictLabel : displayValue(field);
}

function buildSections(template, agentState, sessionPhase, processing, chain) {
  const fieldMap = new Map((agentState?.report_fields || []).map((field) => [field.field_id, field]));
  const resolutionByField = new Map((agentState?.resolution_queue || []).map((item) => [item.field_id, item]));
  const unresolved = new Set(resolutionByField.keys());
  const groups = new Map();
  const declared = template?.schema?.fields || [];
  const declaredIds = new Set(declared.filter((definition) => !definition.id.endsWith('.*')).map((definition) => definition.id));
  const definitions = declared.flatMap((definition) => {
    if (!definition.id.endsWith('.*')) return [definition];
    const prefix = definition.id.slice(0, -1);
    return [...fieldMap.keys()]
      .filter((fieldId) => fieldId.startsWith(prefix) && !declaredIds.has(fieldId))
      .sort()
      .map((fieldId) => ({
        ...definition,
        id: fieldId,
        label: `${definition.label} — ${fieldId.slice(prefix.length).replaceAll('_', ' ')}`,
      }));
  });
  for (const definition of definitions) {
    const title = definition.section || 'Report';
    if (!groups.has(title)) groups.set(title, []);
    const field = fieldMap.get(definition.id) || { field_id: definition.id, state: 'UNKNOWN', value: null, candidates: [] };
    const display = fieldDisplay(field, chain);
    if (!definition.required && field.state === 'UNKNOWN' && !unresolved.has(field.field_id)) {
      display.label = 'Optional · not provided';
      display.actionable = false;
    }
    const resolutionItem = projectResolutionItem(resolutionByField.get(field.field_id), field);
    groups.get(title).push({
      ...display,
      name: definition.label,
      state: field.state,
      editing: false,
      review_priority: Boolean(definition.critical || definition.requiresTechnicianConfirmation
        || field.candidates?.some((candidate) => candidate.extraction?.method === 'technician-resolution-answer')),
      has_provenance: Boolean(field.candidates?.some((candidate) => candidate.evidence_refs?.length)),
      definition: {
        type: definition.type || 'string',
        unit: definition.unit || null,
        allowed_values: definition.allowedValues || definition.allowedStatuses || [],
      },
      resolution_item: resolutionItem,
      resolution_control: resolutionItem ? resolutionControl(resolutionItem) : null,
    });
  }
  return [...groups].map(([title, fields]) => {
    const needsAttention = fields.filter((field) => unresolved.has(field.field_id)).length;
    const reviewPriority = fields.filter((field) => field.review_priority).length;
    const reviewing = sessionPhase === 'REVIEW';
    const recordingWithBlanks = processing === 'RECORDING' && fields.some((field) => field.state === 'UNKNOWN');
    return {
      title,
      status: needsAttention
        ? `${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`
        : reviewing && reviewPriority ? `${reviewPriority} to review` : 'Complete',
      needs_attention: needsAttention,
      review_priority: reviewPriority,
      expanded: processing === 'RECORDING'
        ? recordingWithBlanks
        : ['RESOLVE', 'REVIEW', 'READY'].includes(sessionPhase),
      fields,
    };
  });
}

export function deriveWorkspaceView(input = {}) {
  const fields = input.agent_state?.report_fields || [];
  const completeness = input.agent_state?.completeness || {};
  const complete = completeness.complete_fields?.length || 0;
  const declaredFields = input.template?.schema?.fields || [];
  const fixedIds = new Set(declaredFields.filter((field) => !field.id.endsWith('.*')).map((field) => field.id));
  const materialized = fields.filter((field) => !fixedIds.has(field.field_id)
    && declaredFields.some((definition) => definition.id.endsWith('.*') && field.field_id.startsWith(definition.id.slice(0, -1)))).length;
  const total = declaredFields.filter((field) => !field.id.endsWith('.*')).length + materialized || fields.length;
  const workOrder = valueFor(fields, 'work.work_order_id');
  const asset = valueFor(fields, 'asset.internal_fleet_no', 'Bus ID needs resolution');
  const identity = [
    workOrder === '—' ? valueFor(fields, 'work_order') : workOrder,
    asset === '—' ? valueFor(fields, 'equipment') : asset,
    valueFor(fields, 'technician.name'),
  ].filter((value) => value !== '—').join(' · ');
  return {
    major_areas: [...MAJOR_AREAS],
    session_id: input.session?.session_id || null,
    session_phase: input.session?.phase || null,
    revision: input.session?.revision ?? null,
    job_header: {
      title: input.session?.report_name || input.history?.report_name || input.template?.name || 'Service report',
      identity_line: identity,
      complete,
      total,
      need_input: input.agent_state?.resolution_queue?.length || 0,
    },
    active_task: deriveActiveTask(input),
    report_sections: buildSections(input.template, input.agent_state, input.session?.phase, input.processing, input.chain),
  };
}
