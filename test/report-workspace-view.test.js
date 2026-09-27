import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveWorkspaceView,
  fieldDisplay,
  resolutionControl,
} from '../web/report-workspace-view.js';

const template = {
  templateId: 'bus-defect-rectification-corrective-maintenance',
  name: 'Bus Defect Rectification',
  schema: { fields: [
    { id: 'work.work_order_id', label: 'Work Order No.', section: 'Job Identity', required: true, displayOrder: 1 },
    { id: 'asset.internal_fleet_no', label: 'Bus ID', section: 'Job Identity', required: true, displayOrder: 2 },
    { id: 'diagnosis.root_cause', label: 'Root cause', section: 'Diagnosis', required: true, displayOrder: 20 },
    { id: 'parts.part_number', label: 'Parts used', section: 'Rectification', displayOrder: 30 },
    { id: 'completion.state', label: 'Return to service', section: 'Completion & Handover', required: true, critical: true, displayOrder: 40 },
  ] },
};

const known = (fieldId, value, supportType = 'TRANSCRIPT_EVIDENCE', extractionMethod = 'deterministic-rule') => ({
  field_id: fieldId, state: 'KNOWN_VALUE', value, unit: null,
  selected_candidate_ids: [`candidate_${fieldId}`], active_candidate_ids: [`candidate_${fieldId}`],
  candidates: [{
    candidate_id: `candidate_${fieldId}`, support_type: supportType, claim: { kind: 'VALUE', value },
    extraction: { method: extractionMethod, version: 'test' },
    evidence_refs: [{ evidence_id: 'transcript_1', span_id: 'span_1' }],
  }],
});

const unknown = (fieldId) => ({
  field_id: fieldId, state: 'UNKNOWN', value: null, selected_candidate_ids: [], active_candidate_ids: [], candidates: [],
});

function agent({ fields = [], queue = [], issues = [], complete = false } = {}) {
  return {
    report_fields: fields,
    resolution_queue: queue,
    validation_issues: issues,
    completeness: {
      complete,
      complete_fields: fields.filter((field) => ['KNOWN_VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE'].includes(field.state)).map((field) => field.field_id),
      missing_required_fields: fields.filter((field) => field.state === 'UNKNOWN').map((field) => field.field_id),
      missing_optional_fields: [], uncertain_fields: [], conflicting_fields: [], invalid_fields: [], inferred_fields: [],
      conditional_required_fields: [], critical_confirmation_fields: [], blocking_issue_ids: issues.filter((issue) => issue.blocking).map((issue) => issue.issue_id),
    },
  };
}

const session = (phase = 'RESOLVE', revision = 4) => ({
  session_id: 'session_ui_1', revision, phase,
  template_binding: { template_id: template.templateId, template_version: '1.0.0' },
  job_context_ref: 'work-order:WO-111-1222',
});

const item = (type, answerType = 'VALUE', fieldId = 'diagnosis.root_cause') => ({
  resolution_id: `resolution_${type.toLowerCase()}`, issue_ids: [`issue_${type.toLowerCase()}`], type,
  field_id: fieldId, candidate_ids: [], prompt: `Resolve ${fieldId}`, reason: 'Required for this report.',
  priority: 3, priority_class: 'REQUIRED_MISSING', answer_type: answerType, options: [], allow_other: true, status: 'OPEN',
});

function view(overrides = {}) {
  return deriveWorkspaceView({
    template,
    session: session(),
    agent_state: agent({ fields: [known('work.work_order_id', 'WO-111-1222', 'AUTHORITATIVE_SYSTEM_DATA'), known('asset.internal_fleet_no', '8300-354', 'AUTHORITATIVE_SYSTEM_DATA'), unknown('diagnosis.root_cause'), { ...unknown('parts.part_number'), state: 'EXPLICIT_NONE' }, unknown('completion.state')] }),
    transcript: null,
    transcript_review: null,
    processing: null,
    recoverable_error: null,
    interaction: { statement: '', microphone_available: true },
    ...overrides,
  });
}

test('workspace field semantics remain truthful and actionable without confidence percentages', () => {
  const cases = [
    ['KNOWN_VALUE', 'Confirmed'], ['UNKNOWN', 'Needs information'], ['UNCERTAIN', 'Needs confirmation'],
    ['CONFLICT', 'Resolve conflict'], ['INVALID', 'Check value'], ['INFERRED', 'Needs confirmation'],
    ['EXPLICIT_NONE', 'None'], ['NOT_APPLICABLE', 'Not applicable'],
  ];
  for (const [state, label] of cases) {
    const display = fieldDisplay({ ...unknown('field'), state, value: state === 'KNOWN_VALUE' ? 'Observed value' : null });
    assert.equal(display.label, label);
    assert.equal(JSON.stringify(display).includes('%'), false);
  }
  assert.equal(fieldDisplay({ ...known('measurement.odometer_km', 51020), unit: 'km' }).value, '51020 km');
});

test('ResolutionItem answer contracts map to structured controls before free text', () => {
  assert.equal(resolutionControl(item('CONFLICT', 'SELECT_OR_PROVIDE')).kind, 'CHOICE_WITH_OTHER');
  assert.equal(resolutionControl(item('SAFETY_CONFIRMATION', 'SINGLE_SELECT')).kind, 'BUTTON_GROUP');
  assert.equal(resolutionControl(item('MISSING', 'SEMANTIC_STATE')).kind, 'BUTTON_GROUP');
  assert.equal(resolutionControl(item('MISSING', 'NONE_OR_VALUE')).kind, 'NONE_OR_DETAIL');
  assert.equal(resolutionControl(item('INVALID', 'CONFIRM_OR_REPLACE')).kind, 'CONFIRM_OR_REPLACE');
  assert.equal(resolutionControl(item('MISSING', 'VALUE')).kind, 'COMPACT_INPUT');
});

const stateCases = [
  ['loading context', { session: null, agent_state: null }, 'LOADING_CONTEXT', null],
  ['empty capture', { session: session('CONTEXT'), agent_state: agent() }, 'CAPTURE', 'CAPTURE_STATEMENT'],
  ['capture before queued questions', { session: session('CONTEXT'), agent_state: agent({ queue: [item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state')] }) }, 'CAPTURE', 'CAPTURE_STATEMENT'],
  ['typing technician statement', { interaction: { statement: 'Door would not close', microphone_available: true } }, 'CAPTURE', 'CAPTURE_STATEMENT'],
  ['microphone ready', { interaction: { statement: '', microphone_available: true } }, 'CAPTURE', 'CAPTURE_STATEMENT'],
  ['actively recording', { processing: 'RECORDING' }, 'RECORDING', 'STOP_RECORDING'],
  ['recording stopped', { processing: 'PREPARING_AUDIO' }, 'PREPARING_AUDIO', null],
  ['uploading audio', { processing: 'UPLOADING_AUDIO' }, 'UPLOADING_AUDIO', null],
  ['processing transcription', { session: session('PROCESSING'), processing: 'TRANSCRIBING' }, 'TRANSCRIBING', null],
  ['extracting structured information', { processing: 'EXTRACTING' }, 'EXTRACTING', null],
  ['checking completeness', { processing: 'CHECKING_COMPLETENESS' }, 'CHECKING_COMPLETENESS', null],
  ['successful initial extraction', { transcript: { raw_text: 'Door fault inspected.' } }, 'CAPTURED', 'CAPTURE_MORE'],
  ['material transcript correction required', { session: session('CORRECTION_IF_NEEDED'), transcript_review: { status: 'PENDING', items: [{ review_item_id: 'review_1', source_span: { quote: 'Z751A' }, proposed_text: 'C751A', reason: 'Rail terminology' }] } }, 'CORRECTION', 'DECIDE_CORRECTION'],
  ['correction accepted', { transcript_review: { status: 'REVIEWED', decisions: [{ decision: 'ACCEPT' }] }, transcript: { raw_text: 'C751A inspected.' } }, 'CAPTURED', 'CAPTURE_MORE'],
  ['correction rejected', { transcript_review: { status: 'REVIEWED', decisions: [{ decision: 'REJECT' }] }, transcript: { raw_text: 'Z751A inspected.' } }, 'CAPTURED', 'CAPTURE_MORE'],
  ['required field missing', { agent_state: agent({ fields: [unknown('diagnosis.root_cause')], queue: [item('MISSING')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['uncertain field', { agent_state: agent({ fields: [{ ...known('measurement.odometer_km', 51020), state: 'UNCERTAIN' }], queue: [item('UNCERTAIN', 'CONFIRM_OR_REPLACE', 'measurement.odometer_km')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['conflicting field', { agent_state: agent({ fields: [{ ...unknown('asset.internal_fleet_no'), state: 'CONFLICT' }], queue: [item('CONFLICT', 'SELECT_OR_PROVIDE', 'asset.internal_fleet_no')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['invalid field', { agent_state: agent({ fields: [{ ...known('measurement.odometer_km', 9999999), state: 'INVALID' }], queue: [item('INVALID', 'VALUE', 'measurement.odometer_km')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['conditional requirement', { agent_state: agent({ fields: [unknown('test.result')], queue: [item('CONDITIONAL_REQUIREMENT', 'VALUE', 'test.result')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['safety confirmation', { agent_state: agent({ fields: [known('completion.state', 'NOT_READY')], queue: [item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['explicit none', { agent_state: agent({ fields: [{ ...unknown('parts.part_number'), state: 'EXPLICIT_NONE' }] }), transcript: { raw_text: 'No parts were used.' } }, 'CAPTURED', 'CAPTURE_MORE'],
  ['not applicable', { agent_state: agent({ fields: [{ ...unknown('parts.part_number'), state: 'NOT_APPLICABLE' }] }), transcript: { raw_text: 'Parts do not apply.' } }, 'CAPTURED', 'CAPTURE_MORE'],
  ['partially complete report', { agent_state: agent({ fields: [known('asset.internal_fleet_no', '8300-354'), unknown('diagnosis.root_cause')], queue: [item('MISSING')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['multiple remaining items', { agent_state: agent({ fields: [unknown('diagnosis.root_cause'), unknown('completion.state')], queue: [item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state'), item('MISSING')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['final resolution item', { agent_state: agent({ fields: [unknown('diagnosis.root_cause')], queue: [item('MISSING')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['review state', { session: session('REVIEW'), agent_state: agent({ fields: [known('diagnosis.root_cause', 'Not established')], complete: true }) }, 'REVIEW', 'SUBMIT_REPORT'],
  ['ready to confirm', { session: session('READY'), agent_state: agent({ fields: [known('diagnosis.root_cause', 'Not established')], complete: true }) }, 'READY', 'SUBMIT_REPORT'],
  ['confirmed', { session: session('CONFIRMED'), agent_state: agent({ fields: [known('diagnosis.root_cause', 'Not established')], complete: true }), confirmation: { confirmation_token: 'confirmed' } }, 'CONFIRMED', 'EXPORT_REPORT'],
  ['STT recoverable failure', { session: session('RECOVERABLE_ERROR'), recoverable_error: { kind: 'STT', message: 'Recording saved.', retry_action: 'RETRY_TRANSCRIPTION' } }, 'RECOVERABLE_ERROR', 'RETRY_TRANSCRIPTION'],
  ['upload recoverable failure', { recoverable_error: { kind: 'UPLOAD', message: 'Attachment was not added.', retry_action: 'RETRY_ATTACHMENT' } }, 'RECOVERABLE_ERROR', 'RETRY_ATTACHMENT'],
  ['network recoverable failure', { recoverable_error: { kind: 'NETWORK', message: 'Connection interrupted.', retry_action: 'RETRY_CONNECTION' } }, 'RECOVERABLE_ERROR', 'RETRY_CONNECTION'],
  ['stale revision response', { recoverable_error: { kind: 'STALE_REVISION', message: 'Report changed. Refreshing current state.', retry_action: 'REFRESH_SESSION' } }, 'RECOVERABLE_ERROR', 'REFRESH_SESSION'],
  ['export after confirmation', { session: session('CONFIRMED'), agent_state: agent({ fields: [known('diagnosis.root_cause', 'Not established')], complete: true }), confirmation: { confirmation_token: 'confirmed' }, interaction: { export_ready: true } }, 'CONFIRMED', 'EXPORT_REPORT'],
];

for (const [name, overrides, expectedKind, primaryId] of stateCases) {
  test(`workspace state: ${name}`, () => {
    const result = view(overrides);
    assert.deepEqual(result.major_areas, ['APP_SHELL', 'JOB_HEADER', 'ACTIVE_TASK_PANEL', 'REPORT_SUMMARY']);
    assert.equal(result.active_task.kind, expectedKind);
    assert.equal(result.active_task.primary_action?.id || null, primaryId);
    assert.ok((result.active_task.primary_action ? 1 : 0) <= 1);
    assert.equal(result.active_task.primary_action?.id === 'SUBMIT_REPORT', ['REVIEW', 'READY'].includes(result.session_phase));
    assert.equal(JSON.stringify(result).match(/confidence|chunk_id|trace_id|model|provider/giu), null);
  });
}

test('recording exposes one explicit stop-and-fill action', () => {
  const result = view({ processing: 'RECORDING' });
  assert.deepEqual(result.active_task.primary_action, {
    id: 'STOP_RECORDING',
    label: 'Stop & fill report',
  });
});

test('recording state belongs only to the ReportSession that started it', () => {
  const owner = view({
    processing: 'RECORDING',
    processing_session_id: 'session_ui_1',
  });
  assert.equal(owner.active_task.kind, 'RECORDING');

  const anotherReport = view({
    session: { ...session('CONTEXT'), session_id: 'session_ui_2' },
    processing: 'RECORDING',
    processing_session_id: 'session_ui_1',
  });
  assert.equal(anotherReport.active_task.kind, 'CAPTURE');
  assert.equal(anotherReport.active_task.primary_action.id, 'CAPTURE_STATEMENT');
});

test('header and report summary use only authoritative Agent state and place unresolved work in the report', () => {
  const result = view({
    agent_state: agent({
      fields: [known('work.work_order_id', 'WO-111-1222', 'AUTHORITATIVE_SYSTEM_DATA'), known('asset.internal_fleet_no', 'LONG-BUS-IDENTIFIER-8300-354', 'AUTHORITATIVE_SYSTEM_DATA'), unknown('diagnosis.root_cause')],
      queue: [item('MISSING')],
    }),
  });
  assert.equal(result.job_header.title, 'Bus Defect Rectification');
  assert.match(result.job_header.identity_line, /WO-111-1222.*LONG-BUS-IDENTIFIER-8300-354/u);
  assert.equal(result.job_header.need_input, 1);
  assert.equal(result.report_sections.find((section) => section.title === 'Diagnosis').expanded, true);
  assert.equal(result.report_sections.find((section) => section.title === 'Job Identity').expanded, true);
  const rootCause = result.report_sections.flatMap((section) => section.fields).find((field) => field.field_id === 'diagnosis.root_cause');
  assert.equal(rootCause.resolution_item.type, 'MISSING');
  assert.equal(rootCause.resolution_control.kind, 'COMPACT_INPUT');
  assert.equal(result.report_sections.flatMap((section) => section.fields).some((field) => field.editing), false);
});

test('inline conflict choices identify their authoritative and technician sources', () => {
  const system = known('asset.internal_fleet_no', '8300-354', 'AUTHORITATIVE_SYSTEM_DATA').candidates[0];
  const transcript = known('asset.internal_fleet_no', '8300-345').candidates[0];
  transcript.candidate_id = 'candidate_transcript_bus';
  const conflictField = {
    ...unknown('asset.internal_fleet_no'),
    state: 'CONFLICT',
    candidates: [system, transcript],
    active_candidate_ids: [system.candidate_id, transcript.candidate_id],
  };
  const conflictItem = {
    ...item('CONFLICT', 'SELECT_OR_PROVIDE', 'asset.internal_fleet_no'),
    candidate_ids: [system.candidate_id, transcript.candidate_id],
    options: [
      { candidate_id: system.candidate_id, value: '8300-354', support_type: 'AUTHORITATIVE_SYSTEM_DATA' },
      { candidate_id: transcript.candidate_id, value: '8300-345', support_type: 'TRANSCRIPT_EVIDENCE' },
    ],
  };
  const result = view({
    agent_state: agent({ fields: [conflictField], queue: [conflictItem] }),
  });
  const projected = result.report_sections.flatMap((section) => section.fields)
    .find((field) => field.field_id === 'asset.internal_fleet_no');
  assert.deepEqual(projected.resolution_item.options.map((option) => option.source_label), [
    'Work order',
    'Technician statement',
  ]);
});

test('field representations identify the currently selected source without discarding alternatives', () => {
  const draft = {
    candidate_id: 'candidate_draft', support_type: 'TRANSCRIPT_EVIDENCE',
    claim: { kind: 'VALUE', value: 'Secured the connector' },
    extraction: { method: 'deterministic-rule', version: 'test' },
    evidence_refs: [{ evidence_id: 'transcript_1', span_id: 'span_work' }],
  };
  const manual = {
    candidate_id: 'candidate_manual', support_type: 'MANUAL_TECHNICIAN_INPUT',
    claim: { kind: 'VALUE', value: 'Reseated and secured the loose connector' },
    extraction: { method: 'technician-field-selection', version: 'test' },
    evidence_refs: [{ evidence_id: 'evidence_manual', span_id: 'span_manual' }],
  };
  const confirmation = {
    candidate_id: 'candidate_confirmation', support_type: 'TECHNICIAN_CONFIRMATION',
    confirmed_candidate_id: manual.candidate_id,
    claim: manual.claim,
    extraction: { method: 'technician-field-selection-confirmation', version: 'test' },
    evidence_refs: manual.evidence_refs,
  };
  const field = {
    field_id: 'work_performed', state: 'KNOWN_VALUE', value: manual.claim.value,
    selected_candidate_ids: [confirmation.candidate_id],
    active_candidate_ids: [confirmation.candidate_id],
    candidates: [draft, manual, confirmation],
  };
  const chain = {
    transcripts: [{ transcript_id: 'transcript_1', raw_text: 'I secured the loose connector.' }],
    evidence_spans: [{ span_id: 'span_work', evidence_id: 'transcript_1', start_offset: 2, end_offset: 29 }],
  };

  const projected = fieldDisplay(field, chain).representations;

  assert.equal(projected.drafts[0].selected, false);
  assert.equal(projected.original_words[0].selected, false);
  assert.equal(projected.manual[0].selected, true);
  assert.equal(projected.drafts[0].value, 'Secured the connector');
  assert.equal(projected.original_words[0].value, 'secured the loose connector');
  assert.equal(projected.manual[0].value, 'Reseated and secured the loose connector');
});

test('selecting original transcript words is projected as the active reversible representation', () => {
  const draft = {
    candidate_id: 'candidate_draft', support_type: 'TRANSCRIPT_EVIDENCE',
    claim: { kind: 'VALUE', value: 'Secured the connector' },
    extraction: { method: 'deterministic-rule', version: 'test' },
    evidence_refs: [{ evidence_id: 'transcript_1', span_id: 'span_work' }],
  };
  const transcriptSelection = {
    candidate_id: 'candidate_words', support_type: 'MANUAL_TECHNICIAN_INPUT',
    claim: { kind: 'VALUE', value: 'secured the loose connector' },
    extraction: { method: 'technician-transcript-selection', version: 'test' },
    evidence_refs: draft.evidence_refs,
  };
  const confirmation = {
    candidate_id: 'candidate_words_confirmation', support_type: 'TECHNICIAN_CONFIRMATION',
    confirmed_candidate_id: transcriptSelection.candidate_id,
    claim: transcriptSelection.claim,
    extraction: { method: 'technician-field-selection-confirmation', version: 'test' },
    evidence_refs: transcriptSelection.evidence_refs,
  };
  const field = {
    field_id: 'work_performed', state: 'KNOWN_VALUE', value: transcriptSelection.claim.value,
    selected_candidate_ids: [confirmation.candidate_id],
    active_candidate_ids: [confirmation.candidate_id],
    candidates: [draft, transcriptSelection, confirmation],
  };
  const chain = {
    transcripts: [{ transcript_id: 'transcript_1', raw_text: 'I secured the loose connector.' }],
    evidence_spans: [{ span_id: 'span_work', evidence_id: 'transcript_1', start_offset: 2, end_offset: 29 }],
  };

  const projected = fieldDisplay(field, chain).representations;

  assert.equal(projected.drafts[0].selected, false);
  assert.equal(projected.original_words[0].selected, true);
});

test('capture stays compact while generated report review exposes the complete schema in order', () => {
  const fields = [
    known('work.work_order_id', 'WO-111-1222', 'AUTHORITATIVE_SYSTEM_DATA'),
    known('diagnosis.root_cause', 'Not established', 'MANUAL_TECHNICIAN_INPUT', 'technician-resolution-answer'),
    known('completion.state', 'NOT_READY', 'TECHNICIAN_CONFIRMATION'),
  ];
  const capture = view({
    session: session('CONTEXT'),
    agent_state: agent({ fields, queue: [item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state')] }),
  });
  assert.equal(capture.report_sections.some((section) => section.expanded), false);

  const review = view({ session: session('REVIEW'), agent_state: agent({ fields, complete: true }) });
  assert.equal(review.report_sections.find((section) => section.title === 'Job Identity').expanded, true);
  assert.equal(review.report_sections.find((section) => section.title === 'Diagnosis').expanded, true);
  assert.equal(review.report_sections.find((section) => section.title === 'Completion & Handover').expanded, true);
});
