const MAJOR_AREAS = Object.freeze(['APP_SHELL', 'JOB_HEADER', 'REPORT_SUMMARY', 'ACTIVE_TASK_PANEL']);

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
  RECORDING: ['RECORDING', 'Listening…', 'STOP_RECORDING'],
  PREPARING_AUDIO: ['PREPARING_AUDIO', 'Finalizing recording…', null],
  UPLOADING_AUDIO: ['UPLOADING_AUDIO', 'Saving audio & transcribing…', null],
  TRANSCRIBING: ['TRANSCRIBING', 'Transcribing…', null],
  EXTRACTING: ['EXTRACTING', 'Updating report…', null],
  CHECKING_COMPLETENESS: ['CHECKING_COMPLETENESS', 'Updating report…', null],
});

const FINALIZING_STATES = new Set(['PREPARING_AUDIO', 'UPLOADING_AUDIO', 'TRANSCRIBING']);
const REPORT_UPDATE_STATES = new Set(['EXTRACTING', 'CHECKING_COMPLETENESS']);

function action(id, label) {
  return id ? { id, label } : null;
}

export function sessionRecoveryError(session, chain) {
  if (session?.phase !== 'RECOVERABLE_ERROR') return null;
  if (session.recovery_phase === 'PROCESSING') {
    const audio = chain?.evidence?.filter((item) => item.evidence_type === 'AUDIO'
      && session.evidence_ids?.includes(item.evidence_id)).at(-1);
    return {
      kind: 'STT', message: 'Recording saved, but transcription could not finish.',
      retry_action: 'RETRY_TRANSCRIPTION', evidence_id: audio?.evidence_id || null,
    };
  }
  return {
    kind: 'SESSION', message: session.last_error?.message || 'This report needs attention.',
    retry_action: 'REFRESH_SESSION',
  };
}

function captureFeedback(processing) {
  if (processing === 'RECORDING') {
    return {
      state: 'RECORDING',
      label: 'Listening…',
      elapsed: true,
      provisional_available: false,
      provisional_text: null,
      help: 'Final transcript appears after you stop recording.',
    };
  }
  if (FINALIZING_STATES.has(processing)) {
    return {
      state: 'FINALIZING',
      label: processing === 'TRANSCRIBING' ? 'Transcribing…'
        : processing === 'UPLOADING_AUDIO' ? 'Saving audio & transcribing…' : 'Finalizing recording…',
      elapsed: false,
      provisional_available: false,
      provisional_text: null,
      help: 'Your finalized statement will appear here when transcription finishes.',
    };
  }
  return null;
}

function authoritativeTranscript(input) {
  const transcript = input.transcript;
  const transcriptId = transcript?.transcript_id;
  if (transcript?.contract !== 'TranscriptArtifact'
    || !transcriptId
    || !input.session?.transcript_ids?.includes(transcriptId)
    || !transcript.raw_text) return null;
  return transcript;
}

export function transcriptCorrections(transcript, candidateReview = null) {
  const review = candidateReview?.status === 'REVIEWED'
    && candidateReview.transcript_id === transcript.transcript_id ? candidateReview : null;
  const accepted = new Set((review?.decisions || [])
    .filter((decision) => decision.decision === 'ACCEPT').map((decision) => decision.review_item_id));
  const corrections = [
    ...(transcript.corrections || []),
    ...(review?.items || []).filter((item) => item.kind === 'CORRECTION' && accepted.has(item.review_item_id))
      .map((item) => ({
        original: item.source_span.quote,
        replacement: item.proposed_text,
        sourceSpan: { start: item.source_span.start, end: item.source_span.end },
        method: 'technician-review',
        reviewId: review.review_id,
      })),
  ].sort((left, right) => left.sourceSpan.start - right.sourceSpan.start);
  let normalizedText = '';
  let cursor = 0;
  const mappedCorrections = [];
  for (const correction of corrections) {
    if (correction.sourceSpan.start < cursor
      || transcript.raw_text.slice(correction.sourceSpan.start, correction.sourceSpan.end) !== correction.original) continue;
    normalizedText += transcript.raw_text.slice(cursor, correction.sourceSpan.start);
    const start = normalizedText.length;
    normalizedText += correction.replacement;
    mappedCorrections.push({
      ...correction,
      normalizedSpan: { start, end: normalizedText.length },
    });
    cursor = correction.sourceSpan.end;
  }
  normalizedText += transcript.raw_text.slice(cursor);
  return { normalizedText, corrections: mappedCorrections };
}

function latestStatement(input, transcript = authoritativeTranscript(input)) {
  if (!transcript) return null;
  const updating = REPORT_UPDATE_STATES.has(input.processing);
  const needsReview = input.session?.phase === 'CORRECTION_IF_NEEDED';
  const { normalizedText, corrections } = transcriptCorrections(transcript, input.transcript_review);
  return {
    transcript_id: transcript.transcript_id,
    text: transcript.raw_text,
    ...(transcript.provider === 'technician-text' ? { origin_label: 'Original typed input' } : {}),
    ...(corrections.length ? {
      normalized_text: normalizedText,
      corrections,
    } : {}),
    authoritative: true,
    label: updating || needsReview ? 'Final transcript' : 'Latest statement',
    status: updating ? 'Updating report…' : needsReview ? 'Review needed' : 'Used',
    expanded: updating || needsReview,
    used: !updating && !needsReview,
  };
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

function reportValue(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/u);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute)) return value;
  const monthName = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(date);
  return `${Number(day)} ${monthName} ${year} · ${hour}:${minute}`;
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

export function showFieldStateLabel(field = {}) {
  return Boolean(field.actionable) || !['Confirmed', 'None', 'Not applicable'].includes(field.label);
}

export function fieldControlKind(phase, field = {}) {
  if (['RESOLVE', 'REVIEW'].includes(phase)) return 'EDIT';
  if (['READY', 'CONFIRMED'].includes(phase) && field.has_provenance) return 'SOURCE';
  return null;
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

export function fieldAction(field = {}) {
  if (field.state === 'UNKNOWN') return { kind: 'ADD', label: '+ Add' };
  if (field.resolution_item || ['UNCERTAIN', 'CONFLICT', 'INVALID', 'INFERRED'].includes(field.state)) {
    const label = field.state === 'CONFLICT' ? 'Resolve'
      : field.resolution_item?.type === 'SAFETY_CONFIRMATION' || ['UNCERTAIN', 'INFERRED'].includes(field.state) ? 'Confirm'
        : 'Check';
    return { kind: 'REVIEW', label };
  }
  return { kind: 'EDIT', label: 'Edit' };
}

export function showResolutionPrompt(item = {}) {
  return !['MISSING', 'CONDITIONAL_REQUIREMENT'].includes(item.type);
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

function splitReportName(value) {
  const name = String(value || 'Service report');
  const match = name.match(/^(.*) · (\d{4}-\d{2}-\d{2})(?: \((\d+)\))?$/u);
  if (!match) return { title: name, metadata: '' };
  return { title: match[1], metadata: `${historyDate(match[2])}${match[3] ? ` · Report ${match[3]}` : ''}` };
}

export function deriveReportHistoryRow(summary = {}, { timeZone } = {}) {
  const name = splitReportName(summary.report_name || summary.template?.display_name || 'Service report');
  const identity = [summary.work_order, summary.asset].filter(Boolean);
  identity.unshift(...(name.metadata ? [name.metadata] : []));
  const updatedAt = historyDate(summary.updated_at || summary.created_at, timeZone);
  const reportDay = name.metadata.split(' · ')[0];
  identity.push(`Updated ${reportDay && updatedAt.startsWith(`${reportDay}, `) ? updatedAt.slice(reportDay.length + 2) : updatedAt}`);
  return {
    title: name.title,
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
      RETRY_MICROPHONE: 'Try microphone again', RETRY_RECORDING: 'Record again',
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
    return {
      kind,
      title,
      capture_feedback: captureFeedback(processing),
      primary_action: action(primary, primary === 'STOP_RECORDING' ? 'Stop & fill report' : null),
      secondary_action: processing === 'RECORDING' ? action('CANCEL_RECORDING', 'Cancel') : null,
    };
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
  if (session.phase === 'REVIEW' || session.phase === 'READY') {
    return { kind: 'READY', title: session.phase === 'REVIEW' ? 'Add information' : 'Report actions', composer_visible: session.phase === 'REVIEW', primary_action: action('SUBMIT_REPORT', 'Submit report') };
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

function buildSections(template, agentState, sessionPhase, processing, chain, changeSummary) {
  const fieldMap = new Map((agentState?.report_fields || []).map((field) => [field.field_id, field]));
  const resolutionByField = new Map((agentState?.resolution_queue || []).map((item) => [item.field_id, item]));
  const unresolved = new Set(resolutionByField.keys());
  const updated = new Set(changeSummary?.field_ids || []);
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
    const required = Boolean(definition.required || ['MISSING', 'CONDITIONAL_REQUIREMENT'].includes(resolutionItem?.type));
    const critical = resolutionItem?.type === 'SAFETY_CONFIRMATION';
    const activeCandidates = (field.candidates || []).filter((candidate) => field.active_candidate_ids?.includes(candidate.candidate_id));
    const confirmCandidate = !critical && resolutionItem?.answer_type === 'CONFIRM_OR_REPLACE'
      && activeCandidates.length === 1 && claimValue(activeCandidates[0]) === display.value
      ? activeCandidates[0] : null;
    let uiKind = 'SUPPORTED';
    if (sessionPhase === 'CONFIRMED') uiKind = 'CONFIRMED';
    if (field.state === 'UNKNOWN') uiKind = required ? 'MISSING_REQUIRED' : 'OPTIONAL_EMPTY';
    if (['UNCERTAIN', 'INFERRED'].includes(field.state) || (resolutionItem && field.state !== 'UNKNOWN')) uiKind = 'NEEDS_CONFIRMATION';
    if (field.state === 'INVALID') uiKind = 'ERROR';
    if (field.state === 'CONFLICT') uiKind = 'CONFLICT';
    if (critical) uiKind = 'CRITICAL';
    const displayHint = uiKind === 'OPTIONAL_EMPTY' ? 'Optional'
      : uiKind === 'CONFLICT' ? `${new Set((resolutionItem?.options || activeCandidates).map((option) => `${option.value ?? claimValue(option)}${option.unit || ''}`)).size} values found`
        : uiKind === 'ERROR' ? 'Invalid value'
          : uiKind === 'CRITICAL' ? display.value === '—' ? 'Safety confirmation' : 'Critical value'
            : uiKind === 'NEEDS_CONFIRMATION' ? 'Needs confirmation' : null;
    const projected = {
      ...display,
      name: definition.label,
      state: field.state,
      ui_kind: uiKind,
      required,
      critical,
      display_value: display.value === '—' ? null : reportValue(display.value),
      display_hint: displayHint,
      confirm_selection: confirmCandidate ? { kind: 'CANDIDATE', candidate_id: confirmCandidate.candidate_id } : null,
      updated: updated.has(field.field_id),
      editing: false,
      has_provenance: Boolean(field.candidates?.some((candidate) => candidate.evidence_refs?.length)),
      definition: {
        type: definition.type || 'string',
        unit: definition.unit || null,
        allowed_values: definition.allowedValues || definition.allowedStatuses || [],
      },
      resolution_item: resolutionItem,
      resolution_control: resolutionItem ? resolutionControl(resolutionItem) : null,
    };
    projected.action = fieldAction(projected);
    projected.requires_review = projected.action.kind === 'REVIEW';
    groups.get(title).push(projected);
  }
  const collapsible = groups.size > 1;
  return [...groups].map(([title, fields]) => {
    const needsAttention = fields.filter((field) => unresolved.has(field.field_id)).length;
    const recordingWithBlanks = processing === 'RECORDING' && fields.some((field) => field.state === 'UNKNOWN');
    return {
      title,
      status: needsAttention
        ? `${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`
        : 'Complete',
      needs_attention: needsAttention,
      collapsible,
      review_priority: 0,
      expanded: processing === 'RECORDING'
        ? recordingWithBlanks || needsAttention > 0
        : needsAttention > 0 || ['CONTEXT', 'RESOLVE', 'REVIEW', 'READY', 'CONFIRMED'].includes(sessionPhase),
      fields,
    };
  });
}

function definitionForField(template, fieldId) {
  const definitions = template?.schema?.fields || [];
  return definitions.find((definition) => definition.id === fieldId)
    || definitions.find((definition) => definition.id.endsWith('.*') && fieldId.startsWith(definition.id.slice(0, -1)))
    || null;
}

function fieldName(template, fieldId) {
  const definition = definitionForField(template, fieldId);
  const wildcardPrefix = definition?.id?.endsWith('.*') ? definition.id.slice(0, -1) : null;
  return wildcardPrefix
    ? `${definition.label} — ${fieldId.slice(wildcardPrefix.length).replaceAll('_', ' ')}`
    : definition?.label || fieldId;
}

function fieldSignature(field) {
  if (!field) return null;
  return JSON.stringify({
    state: field.state || 'UNKNOWN',
    value: field.value ?? null,
    unit: field.unit ?? null,
  });
}

export function deriveChangeSummary({ template, before, after } = {}) {
  const beforeByField = new Map((before?.report_fields || []).map((field) => [field.field_id, field]));
  const afterFields = after?.report_fields || [];
  const fieldIds = afterFields
    .filter((field) => fieldSignature(field) !== fieldSignature(beforeByField.get(field.field_id)))
    .map((field) => field.field_id);
  const categories = after?.completeness || {};
  const missingIds = [
    ...(categories.missing_required_fields || []),
    ...(categories.conditional_required_fields || []),
  ];
  const reviewIds = [
    ...(categories.uncertain_fields || []),
    ...(categories.conflicting_fields || []),
    ...(categories.invalid_fields || []),
    ...(categories.inferred_fields || []),
    ...(categories.critical_confirmation_fields || []),
  ];
  const names = (ids) => [...new Set(ids)].map((fieldId) => fieldName(template, fieldId));
  return {
    count: fieldIds.length,
    summary: `Updated ${fieldIds.length} ${fieldIds.length === 1 ? 'detail' : 'details'}`,
    field_ids: fieldIds,
    field_names: names(fieldIds),
    remaining: {
      missing: names(missingIds),
      review: names(reviewIds),
    },
  };
}

function missingHint(template, agentState, hasPriorCapture) {
  const missingIds = [...new Set(agentState?.completeness?.missing_required_fields || [])];
  const grouped = new Map();
  for (const fieldId of missingIds) {
    const definition = definitionForField(template, fieldId);
    const section = definition?.section || 'Report';
    const wildcardPrefix = definition?.id?.endsWith('.*') ? definition.id.slice(0, -1) : null;
    const label = wildcardPrefix
      ? `${definition.label} — ${fieldId.slice(wildcardPrefix.length).replaceAll('_', ' ')}`
      : definition?.label || fieldId;
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(label);
  }
  const count = missingIds.length;
  return {
    count,
    summary: `${count} ${count === 1 ? 'detail' : 'details'} missing`,
    lead: hasPriorCapture ? 'Still missing:' : 'Missing:',
    groups: [...grouped].map(([section, fields]) => ({ section, fields })),
  };
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
  const finalizedTranscript = authoritativeTranscript(input);
  const authoritativeInput = {
    ...input, transcript: finalizedTranscript,
    recoverable_error: input.recoverable_error || sessionRecoveryError(input.session, input.chain),
  };
  const authoritativeMissingHint = missingHint(input.template, input.agent_state, Boolean(finalizedTranscript));
  const finalizedStatement = latestStatement(authoritativeInput, finalizedTranscript);
  const reportName = splitReportName(input.session?.report_name || input.history?.report_name || input.template?.name);
  const requiredIds = new Set(declaredFields.filter((field) => field.required && !field.id.endsWith('.*')).map((field) => field.id));
  for (const definition of declaredFields.filter((field) => field.required && field.id.endsWith('.*'))) {
    for (const field of fields) if (field.field_id.startsWith(definition.id.slice(0, -1))) requiredIds.add(field.field_id);
  }
  for (const fieldId of [...(completeness.missing_required_fields || []), ...(completeness.conditional_required_fields || [])]) requiredIds.add(fieldId);
  const required = requiredIds.size;
  const completed = [...requiredIds].filter((fieldId) => completeness.complete_fields?.includes(fieldId)).length;
  const phase = input.session?.phase;
  const ready = ['REVIEW', 'READY'].includes(phase) && completeness.complete && !(input.agent_state?.resolution_queue?.length);
  const readiness = { completed, required, label: phase === 'CONFIRMED' ? 'Confirmed' : ready ? 'Ready' : 'Needs information' };
  return {
    major_areas: [...MAJOR_AREAS],
    session_id: input.session?.session_id || null,
    session_phase: input.session?.phase || null,
    revision: input.session?.revision ?? null,
    readiness,
    composer_density: ['READY', 'CONFIRMED'].includes(phase) ? 'hidden' : ready ? 'compact' : phase === 'CONTEXT' ? 'prominent' : input.agent_state?.resolution_queue?.length ? 'contextual' : 'standard',
    job_header: {
      title: reportName.title,
      metadata: reportName.metadata,
      identity_line: identity,
      complete,
      total,
      need_input: input.agent_state?.resolution_queue?.length || 0,
    },
    active_task: { ...deriveActiveTask(authoritativeInput), missing_hint: authoritativeMissingHint },
    missing_hint: authoritativeMissingHint,
    latest_change: input.change_summary || null,
    latest_statement: finalizedStatement,
    report_sections: buildSections(
      input.template,
      input.agent_state,
      input.session?.phase,
      input.processing,
      input.chain,
      input.change_summary,
    ),
  };
}
