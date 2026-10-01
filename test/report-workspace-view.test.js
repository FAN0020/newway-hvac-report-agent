import assert from 'node:assert/strict';
import test from 'node:test';
import * as workspaceView from '../web/report-workspace-view.js';
import { listPredefinedTemplates } from '../web/template-catalog.js';
import {
  deriveWorkspaceView,
  sessionRecoveryError,
  fieldAction,
  fieldDisplay,
  resolutionControl,
  showResolutionPrompt,
} from '../web/report-workspace-view.js';

test('dated report identity separates the template name from a human-readable instance label', () => {
  const seventh = view({ session: { ...session(), report_name: 'QA Pump Checklist 1445 · 2026-09-28 (7)' } });
  assert.equal(seventh.job_header.title, 'QA Pump Checklist 1445');
  assert.equal(seventh.job_header.metadata, '28 Sep 2026 · Report 7');
  const first = view({ session: { ...session(), report_name: 'HVAC Service Report · 2026-09-28' } });
  assert.equal(first.job_header.title, 'HVAC Service Report');
  assert.equal(first.job_header.metadata, '28 Sep 2026');
});

test('saved transcription failure restores the retry action and its audio evidence', () => {
  const failedSession = {
    ...session('RECOVERABLE_ERROR'), recovery_phase: 'PROCESSING',
    last_error: { code: 'NO_SPEECH', message: 'Transcription failed; immutable audio remains available for retry.', retryable: true },
    evidence_ids: ['evidence_work', 'evidence_audio'],
  };
  const chain = { evidence: [
    { evidence_id: 'evidence_work', evidence_type: 'SYSTEM_RECORD' },
    { evidence_id: 'evidence_audio', evidence_type: 'AUDIO' },
  ] };
  assert.deepEqual(sessionRecoveryError(failedSession, chain), {
    kind: 'STT', message: 'Recording saved, but transcription could not finish.',
    retry_action: 'RETRY_TRANSCRIPTION', evidence_id: 'evidence_audio',
  });
  const restored = view({ session: failedSession, chain });
  assert.equal(restored.active_task.kind, 'RECOVERABLE_ERROR');
  assert.equal(restored.active_task.primary_action.id, 'RETRY_TRANSCRIPTION');
  assert.equal(sessionRecoveryError(session('REVIEW'), chain), null);
});

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
  transcript_ids: ['transcript_1'],
  template_binding: { template_id: template.templateId, template_version: '1.0.0' },
  job_context_ref: 'work-order:WO-111-1222',
});

const finalizedTranscript = (rawText, transcriptId = 'transcript_1') => ({
  contract: 'TranscriptArtifact',
  transcript_id: transcriptId,
  raw_text: rawText,
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

test('technician view shows the complete 20-field checklist and exact 8/6/2 follow-up with bounded source advice', () => {
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];
  const fields = names.map((name, index) => ({
    id: `detail.${name}`, label: `${name} detail`, section: 'Inspection', displayOrder: index + 1,
    type: 'string', required: index < 8,
    allowedSources: index < 8 ? ['TECHNICIAN'] : ['WORK_ORDER', 'KNOWLEDGE'],
  }));
  const reportFields = names.map((name, index) => index < 6
    ? known(`detail.${name}`, `value ${name}`) : unknown(`detail.${name}`));
  reportFields[0].candidates[0].extraction.method = 'structured-semantic-proposal';
  reportFields[0].candidates[0].source_ref = 'transcript_1';
  const queue = ['golf', 'hotel'].map((name) => item('MISSING', 'VALUE', `detail.${name}`));
  const initial = deriveWorkspaceView({
    template: { templateId: 'twenty', name: 'Twenty', schema: { fields } },
    session: session(), agent_state: {
      report_fields: reportFields, resolution_queue: queue,
      completeness: { complete: false, complete_fields: names.slice(0, 6).map((name) => `detail.${name}`),
        missing_required_fields: ['detail.golf', 'detail.hotel'], conditional_required_fields: [] },
    },
    transcript: finalizedTranscript('Alpha: value alpha.'),
    semantic_trace: { transcript_id: 'transcript_1', model: { provider: 'ollama', model: 'local-test-model', skipped: null, error: null } },
    interaction: { statement: '', microphone_available: true },
  });
  assert.equal(initial.report_sections.flatMap((section) => section.fields).length, 20);
  assert.deepEqual(initial.readiness, { completed: 6, required: 8, label: 'Needs information' });
  assert.deepEqual(initial.missing_hint.items.map((entry) => entry.field_id), ['detail.golf', 'detail.hotel']);
  assert.deepEqual(initial.missing_hint.items.map((entry) => entry.question), ['Resolve detail.golf', 'Resolve detail.hotel']);
  assert.equal(initial.report_sections[0].fields[0].source_advice.basis, 'MODEL_ASSISTED_EVIDENCE');
  assert.equal(initial.report_sections[0].fields[0].source_advice.model, 'local-test-model');
  assert.equal(initial.report_sections[0].fields[8].source_advice.suggested_source, null);
  assert.equal(initial.report_sections[0].fields[8].source_advice.allowed_sources.includes('TECHNICIAN'), false);
  const resolved = deriveWorkspaceView({
    template: { templateId: 'twenty', name: 'Twenty', schema: { fields } }, session: session(),
    agent_state: { report_fields: reportFields.map((field, index) => index === 6 || index === 7
      ? known(field.field_id, 'answered', 'MANUAL_TECHNICIAN_INPUT') : field), resolution_queue: [],
    completeness: { complete: true, complete_fields: names.slice(0, 8).map((name) => `detail.${name}`),
      missing_required_fields: [], conditional_required_fields: [] } },
    transcript: finalizedTranscript('Alpha: value alpha.'), interaction: { statement: '', microphone_available: true },
  });
  assert.equal(resolved.missing_hint.count, 0);
  assert.equal(resolved.readiness.completed, 8);
});

test('source-plan model advice is visibly distinct from accepted job evidence', () => {
  const result = deriveWorkspaceView({
    template: { templateId: 'reference', name: 'Reference', schema: { fields: [
      { id: 'standard.reference', label: 'Standard reference', section: 'Reference', type: 'string',
        fieldRole: 'NORMATIVE_REFERENCE', allowedSources: ['TECHNICIAN', 'KNOWLEDGE'], required: false },
    ] } },
    session: { ...session('CONTEXT'), template_binding: { template_id: 'reference', template_version: '1' } },
    agent_state: { report_fields: [unknown('standard.reference')], resolution_queue: [],
      completeness: { complete: true, complete_fields: [], missing_required_fields: [], conditional_required_fields: [] } },
    source_plan: { model: { provider: 'ollama', model: 'local-test', status: 'MODEL_SUGGESTED' }, fields: [
      { field_id: 'standard.reference', required: false, suggested_source: 'KNOWLEDGE', basis: 'MODEL_SUGGESTION' },
    ] },
  });
  const advice = result.report_sections[0].fields[0].source_advice;
  assert.equal(advice.suggested_source, 'KNOWLEDGE');
  assert.equal(advice.basis, 'MODEL_SUGGESTION');
  assert.equal(advice.actual_source, null);
  assert.equal(result.report_sections[0].fields[0].state, 'UNKNOWN');
});

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

test('compact report rows derive Add, Edit, and Review actions from authoritative field state', () => {
  assert.deepEqual(fieldAction({ ...unknown('missing'), resolution_item: item('MISSING', 'VALUE', 'missing') }), {
    kind: 'ADD',
    label: '+ Add',
  });
  assert.deepEqual(fieldAction({ ...known('known', 'Observed value'), resolution_item: null }), {
    kind: 'EDIT',
    label: 'Edit',
  });
  assert.deepEqual(fieldAction({ ...unknown('conflict'), state: 'CONFLICT', resolution_item: item('CONFLICT', 'SELECT_OR_PROVIDE', 'conflict') }), {
    kind: 'REVIEW',
    label: 'Resolve',
  });
  assert.deepEqual(fieldAction({ ...known('completion.state', 'READY'), resolution_item: item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state') }), {
    kind: 'REVIEW', label: 'Confirm',
  });
});

test('shared field presentation keeps ordinary blanks, confirmation, conflict, and safety distinct', () => {
  const uncertain = { ...known('work.date_time', '2026-09-28 03:42'), state: 'UNCERTAIN' };
  const conflicting = { ...unknown('asset.internal_fleet_no'), state: 'CONFLICT', candidates: [
    { candidate_id: 'candidate_a', claim: { kind: 'VALUE', value: '8300-354' } },
    { candidate_id: 'candidate_b', claim: { kind: 'VALUE', value: '8300-355' } },
  ] };
  const safety = { ...known('completion.state', 'READY'), state: 'UNCERTAIN' };
  const result = view({
    template: { ...template, schema: { fields: [
      ...template.schema.fields,
      { id: 'work.date_time', label: 'Date / Time', section: 'Job Identity', required: true },
    ] } },
    agent_state: agent({
      fields: [unknown('work.work_order_id'), conflicting, unknown('diagnosis.root_cause'), unknown('parts.part_number'), safety, uncertain],
      queue: [
        item('MISSING', 'VALUE', 'work.work_order_id'),
        { ...item('CONFLICT', 'SELECT_OR_PROVIDE', 'asset.internal_fleet_no'), options: [
          { candidate_id: 'candidate_a', value: '8300-354' }, { candidate_id: 'candidate_b', value: '8300-355' },
        ] },
        item('SAFETY_CONFIRMATION', 'CONFIRM_OR_REPLACE', 'completion.state'),
        item('UNCERTAIN', 'CONFIRM_OR_REPLACE', 'work.date_time'),
      ],
    }),
  });
  const fields = result.report_sections.flatMap((section) => section.fields);
  const byId = (id) => fields.find((field) => field.field_id === id);
  assert.deepEqual([byId('work.work_order_id').ui_kind, byId('work.work_order_id').display_value, byId('work.work_order_id').required], ['MISSING_REQUIRED', null, true]);
  assert.deepEqual([byId('parts.part_number').ui_kind, byId('parts.part_number').display_value, byId('parts.part_number').display_hint], ['OPTIONAL_EMPTY', null, 'Optional']);
  assert.deepEqual([byId('work.date_time').ui_kind, byId('work.date_time').display_value, byId('work.date_time').confirm_selection], [
    'NEEDS_CONFIRMATION', '28 Sep 2026 · 03:42', { kind: 'CANDIDATE', candidate_id: 'candidate_work.date_time' },
  ]);
  assert.deepEqual([byId('asset.internal_fleet_no').ui_kind, byId('asset.internal_fleet_no').display_hint], ['CONFLICT', '2 values found']);
  assert.deepEqual([byId('completion.state').ui_kind, byId('completion.state').confirm_selection], ['CRITICAL', null]);
  assert.equal(result.report_sections.find((section) => section.title === 'Job Identity').needs_attention, 3);
});

test('a missing safety field keeps its structured confirmation action', () => {
  const result = view({
    agent_state: agent({
      fields: [unknown('completion.state')],
      queue: [{ ...item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state'), options: [{ value: 'READY' }, { value: 'NOT_READY' }] }],
    }),
  });
  const field = result.report_sections.flatMap((section) => section.fields).find((entry) => entry.field_id === 'completion.state');
  assert.equal(field.ui_kind, 'CRITICAL');
  assert.equal(field.resolution_control.kind, 'BUTTON_GROUP');
  assert.equal(field.confirm_selection, null);
});

test('the same compact field projection preserves order and optional semantics in dense templates', () => {
  const predefined = listPredefinedTemplates();
  const templates = [
    predefined.find((entry) => entry.templateId === 'hvac-service-report'),
    predefined.find((entry) => entry.templateId === 'bus-preventive-maintenance-inspection'),
    predefined.find((entry) => entry.templateId === 'plain-rail-preventive-inspection'),
    { ...template, schema: { fields: Array.from({ length: 50 }, (_, index) => ({
      id: `dense.field_${index}`, label: `Field ${index + 1}`, section: `Section ${Math.floor(index / 10) + 1}`,
      required: index % 5 !== 0, displayOrder: index,
    })) } },
  ];
  assert.deepEqual(templates.map((entry) => entry.schema.fields.length), [7, 32, 39, 50]);
  for (const reportTemplate of templates) {
    const fields = reportTemplate.schema.fields.filter((definition) => !definition.id.endsWith('.*'));
    const result = deriveWorkspaceView({
      template: reportTemplate, session: session(),
      agent_state: agent({ fields: fields.map((definition) => unknown(definition.id)) }),
      interaction: { statement: '', microphone_available: true },
    });
    const rendered = result.report_sections.flatMap((section) => section.fields);
    assert.deepEqual(rendered.map((field) => field.field_id), fields.map((definition) => definition.id));
    assert.ok(rendered.every((field) => field.display_value === null));
    assert.ok(rendered.every((field) => field.ui_kind === (field.required ? 'MISSING_REQUIRED' : 'OPTIONAL_EMPTY')));
  }
});

test('field state copy appears only when it adds information beyond the value', () => {
  assert.equal(typeof workspaceView.showFieldStateLabel, 'function');
  assert.equal(workspaceView.showFieldStateLabel(fieldDisplay({ ...unknown('parts.part_number'), state: 'EXPLICIT_NONE' })), false);
  assert.equal(workspaceView.showFieldStateLabel(fieldDisplay({ ...unknown('parts.part_number'), state: 'NOT_APPLICABLE' })), false);
  assert.equal(workspaceView.showFieldStateLabel(fieldDisplay(known('asset.id', 'ABCD1234'))), false);
  assert.equal(workspaceView.showFieldStateLabel(fieldDisplay(unknown('asset.id'))), true);
  assert.equal(workspaceView.showFieldStateLabel(fieldDisplay({ ...unknown('asset.id'), state: 'CONFLICT' })), true);
});

test('confirmed and exact-version ready fields expose provenance without an edit action', () => {
  assert.equal(typeof workspaceView.fieldControlKind, 'function');
  const sourced = { has_provenance: true };
  assert.equal(workspaceView.fieldControlKind('REVIEW', sourced), 'EDIT');
  assert.equal(workspaceView.fieldControlKind('READY', sourced), 'SOURCE');
  assert.equal(workspaceView.fieldControlKind('CONFIRMED', sourced), 'SOURCE');
  assert.equal(workspaceView.fieldControlKind('CONFIRMED', { has_provenance: false }), null);
  assert.equal(workspaceView.fieldControlKind('CONTEXT', sourced), null);
});

test('only fields requiring technician review receive the explicit review emphasis', () => {
  const result = view({
    agent_state: agent({
      fields: [
        known('work.work_order_id', 'WO-111-1222', 'AUTHORITATIVE_SYSTEM_DATA'),
        { ...known('asset.internal_fleet_no', '8300-354'), state: 'UNCERTAIN' },
        unknown('diagnosis.root_cause'),
      ],
      queue: [
        item('UNCERTAIN', 'CONFIRM_OR_REPLACE', 'asset.internal_fleet_no'),
        item('MISSING', 'VALUE', 'diagnosis.root_cause'),
      ],
    }),
  });
  const fields = result.report_sections.flatMap((section) => section.fields);

  assert.equal(fields.find((field) => field.field_id === 'asset.internal_fleet_no').requires_review, true);
  assert.equal(fields.find((field) => field.field_id === 'work.work_order_id').requires_review, false);
  assert.equal(fields.find((field) => field.field_id === 'diagnosis.root_cause').requires_review, false);
});

test('expanded missing rows do not repeat a prompt already communicated by the row label and state', () => {
  assert.equal(showResolutionPrompt(item('MISSING')), false);
  assert.equal(showResolutionPrompt(item('CONDITIONAL_REQUIREMENT')), false);
  assert.equal(showResolutionPrompt(item('CONFLICT', 'SELECT_OR_PROVIDE')), true);
  assert.equal(showResolutionPrompt(item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state')), true);
});

test('report presentation counts required fields once and keeps fields open from an empty session', () => {
  const result = view({
    session: session('CONTEXT'),
    agent_state: agent({ fields: [unknown('work.work_order_id'), unknown('asset.internal_fleet_no'), unknown('diagnosis.root_cause'), unknown('completion.state')] }),
  });
  assert.deepEqual(result.readiness, { completed: 0, required: 4, label: 'Needs information' });
  assert.equal(result.composer_density, 'prominent');
  assert.ok(result.report_sections.every((section) => section.expanded));
});

test('one report section stays visible as report content, while multiple sections may collapse', () => {
  const oneSection = view({
    template: { name: 'QA Pump Checklist', schema: { fields: [
      { id: 'asset.id', label: 'Asset ID', section: 'Report fields', required: true },
      { id: 'inspection.result', label: 'Inspection result', section: 'Report fields', required: true },
    ] } },
    agent_state: agent({ fields: [unknown('asset.id'), unknown('inspection.result')] }),
  });
  assert.equal(oneSection.report_sections.length, 1);
  assert.equal(oneSection.report_sections[0].collapsible, false);
  assert.ok(view().report_sections.length > 1);
  assert.ok(view().report_sections.every((section) => section.collapsible));
});

test('unresolved report fields receive contextual composer density after the initial capture', () => {
  const result = view({ agent_state: agent({
    fields: [known('asset.internal_fleet_no', '8300-354'), unknown('diagnosis.root_cause')],
    queue: [item('MISSING')],
  }) });
  assert.equal(result.active_task.kind, 'REPORT_REVIEW');
  assert.equal(result.composer_density, 'contextual');
});

test('complete review and exact-version ready phases share a ready status without offering invalid capture', () => {
  for (const phase of ['REVIEW', 'READY']) {
    const result = view({
      session: session(phase),
      agent_state: agent({ fields: [
        known('work.work_order_id', 'WO-111-1222'), known('asset.internal_fleet_no', '8300-354'),
        known('diagnosis.root_cause', 'Not established'), known('completion.state', 'NOT_READY'),
      ], complete: true }),
    });
    assert.deepEqual(result.readiness, { completed: 4, required: 4, label: 'Ready' });
    assert.equal(result.composer_density, phase === 'REVIEW' ? 'compact' : 'hidden');
    assert.equal(result.active_task.kind, 'READY');
    assert.equal(result.active_task.composer_visible, phase === 'REVIEW');
    assert.ok(result.report_sections.every((section) => section.expanded));
  }
});

test('confirmed report has one confirmed status and no additional-input composer', () => {
  const result = view({ session: session('CONFIRMED') });
  assert.equal(result.readiness.label, 'Confirmed');
  assert.equal(result.composer_density, 'hidden');
  assert.ok(result.report_sections.every((section) => section.expanded));
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
  ['successful initial extraction', { transcript: finalizedTranscript('Door fault inspected.') }, 'CAPTURED', 'CAPTURE_MORE'],
  ['material transcript correction required', { session: session('CORRECTION_IF_NEEDED'), transcript_review: { status: 'PENDING', items: [{ review_item_id: 'review_1', source_span: { quote: 'Z751A' }, proposed_text: 'C751A', reason: 'Rail terminology' }] } }, 'CORRECTION', 'DECIDE_CORRECTION'],
  ['correction accepted', { transcript_review: { status: 'REVIEWED', decisions: [{ decision: 'ACCEPT' }] }, transcript: finalizedTranscript('C751A inspected.') }, 'CAPTURED', 'CAPTURE_MORE'],
  ['correction rejected', { transcript_review: { status: 'REVIEWED', decisions: [{ decision: 'REJECT' }] }, transcript: finalizedTranscript('Z751A inspected.') }, 'CAPTURED', 'CAPTURE_MORE'],
  ['required field missing', { agent_state: agent({ fields: [unknown('diagnosis.root_cause')], queue: [item('MISSING')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['uncertain field', { agent_state: agent({ fields: [{ ...known('measurement.odometer_km', 51020), state: 'UNCERTAIN' }], queue: [item('UNCERTAIN', 'CONFIRM_OR_REPLACE', 'measurement.odometer_km')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['conflicting field', { agent_state: agent({ fields: [{ ...unknown('asset.internal_fleet_no'), state: 'CONFLICT' }], queue: [item('CONFLICT', 'SELECT_OR_PROVIDE', 'asset.internal_fleet_no')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['invalid field', { agent_state: agent({ fields: [{ ...known('measurement.odometer_km', 9999999), state: 'INVALID' }], queue: [item('INVALID', 'VALUE', 'measurement.odometer_km')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['conditional requirement', { agent_state: agent({ fields: [unknown('test.result')], queue: [item('CONDITIONAL_REQUIREMENT', 'VALUE', 'test.result')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['safety confirmation', { agent_state: agent({ fields: [known('completion.state', 'NOT_READY')], queue: [item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['explicit none', { agent_state: agent({ fields: [{ ...unknown('parts.part_number'), state: 'EXPLICIT_NONE' }] }), transcript: finalizedTranscript('No parts were used.') }, 'CAPTURED', 'CAPTURE_MORE'],
  ['not applicable', { agent_state: agent({ fields: [{ ...unknown('parts.part_number'), state: 'NOT_APPLICABLE' }] }), transcript: finalizedTranscript('Parts do not apply.') }, 'CAPTURED', 'CAPTURE_MORE'],
  ['partially complete report', { agent_state: agent({ fields: [known('asset.internal_fleet_no', '8300-354'), unknown('diagnosis.root_cause')], queue: [item('MISSING')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['multiple remaining items', { agent_state: agent({ fields: [unknown('diagnosis.root_cause'), unknown('completion.state')], queue: [item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state'), item('MISSING')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['final resolution item', { agent_state: agent({ fields: [unknown('diagnosis.root_cause')], queue: [item('MISSING')] }) }, 'REPORT_REVIEW', 'CAPTURE_MISSING_DETAILS'],
  ['review state', { session: session('REVIEW'), agent_state: agent({ fields: [known('diagnosis.root_cause', 'Not established')], complete: true }) }, 'READY', 'SUBMIT_REPORT'],
  ['ready to confirm', { session: session('READY'), agent_state: agent({ fields: [known('diagnosis.root_cause', 'Not established')], complete: true }) }, 'READY', 'SUBMIT_REPORT'],
  ['confirmed', { session: session('CONFIRMED'), agent_state: agent({ fields: [known('diagnosis.root_cause', 'Not established')], complete: true }), confirmation: { confirmation_token: 'confirmed' } }, 'CONFIRMED', 'EXPORT_REPORT'],
  ['STT recoverable failure', { session: session('RECOVERABLE_ERROR'), recoverable_error: { kind: 'STT', message: 'Recording saved.', retry_action: 'RETRY_TRANSCRIPTION' } }, 'RECOVERABLE_ERROR', 'RETRY_TRANSCRIPTION'],
  ['microphone permission failure', { recoverable_error: { kind: 'MICROPHONE', message: 'Microphone permission is unavailable.', retry_action: 'RETRY_MICROPHONE' } }, 'RECOVERABLE_ERROR', 'RETRY_MICROPHONE'],
  ['recorder finalization failure', { recoverable_error: { kind: 'RECORDER', message: 'Recording could not be finalized.', retry_action: 'RETRY_RECORDING' } }, 'RECOVERABLE_ERROR', 'RETRY_RECORDING'],
  ['upload recoverable failure', { recoverable_error: { kind: 'UPLOAD', message: 'Attachment was not added.', retry_action: 'RETRY_ATTACHMENT' } }, 'RECOVERABLE_ERROR', 'RETRY_ATTACHMENT'],
  ['network recoverable failure', { recoverable_error: { kind: 'NETWORK', message: 'Connection interrupted.', retry_action: 'RETRY_CONNECTION' } }, 'RECOVERABLE_ERROR', 'RETRY_CONNECTION'],
  ['stale revision response', { recoverable_error: { kind: 'STALE_REVISION', message: 'Report changed. Refreshing current state.', retry_action: 'REFRESH_SESSION' } }, 'RECOVERABLE_ERROR', 'REFRESH_SESSION'],
  ['export after confirmation', { session: session('CONFIRMED'), agent_state: agent({ fields: [known('diagnosis.root_cause', 'Not established')], complete: true }), confirmation: { confirmation_token: 'confirmed' }, interaction: { export_ready: true } }, 'CONFIRMED', 'EXPORT_REPORT'],
];

for (const [name, overrides, expectedKind, primaryId] of stateCases) {
  test(`workspace state: ${name}`, () => {
    const result = view(overrides);
    assert.deepEqual(result.major_areas, ['APP_SHELL', 'JOB_HEADER', 'REPORT_SUMMARY', 'ACTIVE_TASK_PANEL']);
    assert.equal(result.active_task.kind, expectedKind);
    assert.equal(result.active_task.primary_action?.id || null, primaryId);
    assert.ok((result.active_task.primary_action ? 1 : 0) <= 1);
    assert.equal(result.active_task.primary_action?.id === 'SUBMIT_REPORT', ['REVIEW', 'READY'].includes(result.session_phase));
    assert.equal(JSON.stringify(result).match(/confidence|chunk_id|trace_id|provider/giu), null);
  });
}

test('recording exposes one explicit stop-and-fill action', () => {
  const result = view({ processing: 'RECORDING' });
  assert.deepEqual(result.active_task.primary_action, {
    id: 'STOP_RECORDING',
    label: 'Stop & fill report',
  });
});

test('microphone and recorder failures expose accurate recovery actions', () => {
  const microphone = view({ recoverable_error: {
    kind: 'MICROPHONE', message: 'Permission denied.', retry_action: 'RETRY_MICROPHONE',
  } });
  assert.deepEqual(microphone.active_task.primary_action, {
    id: 'RETRY_MICROPHONE',
    label: 'Try microphone again',
  });

  const recorder = view({ recoverable_error: {
    kind: 'RECORDER', message: 'Recorder stopped unexpectedly.', retry_action: 'RETRY_RECORDING',
  } });
  assert.deepEqual(recorder.active_task.primary_action, {
    id: 'RETRY_RECORDING',
    label: 'Record again',
  });
});

test('recording is honest about non-streaming STT and offers cancellation', () => {
  const result = view({
    processing: 'RECORDING',
    interaction: {
      statement: '',
      microphone_available: true,
      streaming_transcription_available: false,
      provisional_transcript: 'This must never become evidence.',
    },
  });

  assert.deepEqual(result.active_task.capture_feedback, {
    state: 'RECORDING',
    label: 'Listening…',
    elapsed: true,
    provisional_available: false,
    provisional_text: null,
    help: 'Final transcript appears after you stop recording.',
  });
  assert.deepEqual(result.active_task.secondary_action, {
    id: 'CANCEL_RECORDING',
    label: 'Cancel',
  });
  assert.equal(JSON.stringify(result).includes('This must never become evidence.'), false);
});

test('finalizing audio reserves the statement area without inventing provisional words', () => {
  const result = view({
    session: session('PROCESSING'),
    processing: 'TRANSCRIBING',
    interaction: {
      statement: '',
      microphone_available: true,
      streaming_transcription_available: false,
      provisional_transcript: 'Untrusted partial words',
    },
  });

  assert.deepEqual(result.active_task.capture_feedback, {
    state: 'FINALIZING',
    label: 'Transcribing…',
    elapsed: false,
    provisional_available: false,
    provisional_text: null,
    help: 'Your finalized statement will appear here when transcription finishes.',
  });
  assert.equal(result.latest_statement, null);
  assert.equal(JSON.stringify(result).includes('Untrusted partial words'), false);
});

test('unattached transcript-shaped text never becomes an authoritative latest statement', () => {
  const result = view({
    session: { ...session('PROCESSING'), transcript_ids: [] },
    transcript: {
      contract: 'TranscriptArtifact',
      transcript_id: 'transcript_unattached',
      raw_text: 'Partial words that have not completed the authoritative path.',
    },
    processing: 'CHECKING_COMPLETENESS',
  });

  assert.equal(result.latest_statement, null);
  assert.equal(result.missing_hint.lead, 'Missing:');
  assert.equal(JSON.stringify(result).includes('Partial words that have not completed the authoritative path.'), false);
});

test('finalized transcript stays exact while the report updates, then collapses as the used latest statement', () => {
  const transcript = finalizedTranscript(
    'Work order 112234: replaced the failed contactor and tested cooling.',
    'transcript_final_1',
  );
  const updating = view({
    session: { ...session('PROCESSING'), transcript_ids: [transcript.transcript_id] },
    transcript,
    processing: 'CHECKING_COMPLETENESS',
  });
  assert.deepEqual(updating.latest_statement, {
    transcript_id: 'transcript_final_1',
    text: transcript.raw_text,
    authoritative: true,
    label: 'Final transcript',
    status: 'Updating report…',
    expanded: true,
    used: false,
  });

  const processed = view({
    session: { ...session(), transcript_ids: [transcript.transcript_id] },
    transcript,
    processing: null,
  });
  assert.deepEqual(processed.latest_statement, {
    transcript_id: 'transcript_final_1',
    text: transcript.raw_text,
    authoritative: true,
    label: 'Latest statement',
    status: 'Used',
    expanded: false,
    used: true,
  });
});

test('latest statement carries accepted correction spans alongside immutable raw text', () => {
  const transcript = {
    ...finalizedTranscript('The AZERT ID is ABCD1234.', 'transcript_inline_1'),
    normalized_text: 'The Asset ID is ABCD1234.',
    corrections: [{ original: 'AZERT', replacement: 'Asset', sourceSpan: { start: 4, end: 9 }, normalizedSpan: { start: 4, end: 9 } }],
  };
  const result = view({ session: { ...session(), transcript_ids: [transcript.transcript_id] }, transcript });
  assert.equal(result.latest_statement.text, transcript.raw_text);
  assert.equal(result.latest_statement.normalized_text, transcript.normalized_text);
  assert.deepEqual(result.latest_statement.corrections, transcript.corrections);
});

test('typed evidence is identified as typed input inside the provenance disclosure', () => {
  const transcript = { ...finalizedTranscript('The AZERT ID is ABCD1234.', 'typed_1'), provider: 'technician-text' };
  const result = view({ session: { ...session(), transcript_ids: [transcript.transcript_id] }, transcript });
  assert.equal(result.latest_statement.origin_label, 'Original typed input');
});

test('reviewed technician corrections also render inline without showing rejected suggestions', () => {
  const transcript = finalizedTranscript('The door control model was checked.', 'transcript_reviewed_inline');
  const result = view({
    session: { ...session(), transcript_ids: [transcript.transcript_id] }, transcript,
    transcript_review: {
      transcript_id: transcript.transcript_id, status: 'REVIEWED',
      items: [
        { review_item_id: 'accepted', kind: 'CORRECTION', source_span: { start: 17, end: 22, quote: 'model' }, proposed_text: 'module' },
        { review_item_id: 'rejected', kind: 'CORRECTION', source_span: { start: 27, end: 34, quote: 'checked' }, proposed_text: 'replaced' },
      ],
      decisions: [
        { review_item_id: 'accepted', decision: 'ACCEPT' },
        { review_item_id: 'rejected', decision: 'REJECT' },
      ],
    },
  });
  assert.deepEqual(result.latest_statement.corrections.map(({ original, replacement }) => [original, replacement]), [['model', 'module']]);
  assert.deepEqual(result.latest_statement.corrections[0].normalizedSpan, { start: 17, end: 23 });
  assert.equal(result.latest_statement.normalized_text, 'The door control module was checked.');
});

test('text and microphone composer remains available after the first capture until final submission', () => {
  const states = [
    view({ transcript: finalizedTranscript('I checked the unit.') }),
    view({ agent_state: agent({ fields: [unknown('diagnosis.root_cause')], queue: [item('MISSING')] }) }),
    view({ session: session('REVIEW'), agent_state: agent({ complete: true }) }),
    view({ session: session('CONTEXT') }),
  ];
  for (const state of states) assert.equal(state.active_task.composer_visible, true, state.active_task.kind);
  for (const phase of ['READY']) {
    const state = view({ session: session(phase), agent_state: agent({ complete: true }) });
    assert.equal(state.active_task.composer_visible, false, phase);
  }
  assert.notEqual(view({ session: session('CONFIRMED') }).active_task.composer_visible, true);
});

test('missing hint uses only server-authoritative completeness and current schema labels', () => {
  const result = view({
    transcript: finalizedTranscript('I inspected the bus.'),
    agent_state: {
      ...agent({
        fields: [
          known('work.work_order_id', 'WO-111-1222'),
          known('asset.internal_fleet_no', '8300-354'),
          unknown('diagnosis.root_cause'),
          { ...unknown('parts.part_number'), state: 'CONFLICT' },
          unknown('completion.state'),
        ],
        queue: [
          item('MISSING', 'SEMANTIC_STATE', 'diagnosis.root_cause'),
          item('CONFLICT', 'SELECT_OR_PROVIDE', 'parts.part_number'),
          item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state'),
        ],
      }),
      completeness: {
        complete: false,
        complete_fields: ['work.work_order_id', 'asset.internal_fleet_no'],
        missing_required_fields: ['diagnosis.root_cause', 'completion.state'],
        missing_optional_fields: [],
        uncertain_fields: [],
        conflicting_fields: ['parts.part_number'],
        invalid_fields: [],
        inferred_fields: [],
        conditional_required_fields: [],
        critical_confirmation_fields: [],
        blocking_issue_ids: ['issue_missing', 'issue_conflict'],
      },
    },
  });

  assert.deepEqual(result.missing_hint, {
    count: 2,
    summary: '2 required technician details missing',
    lead: 'Still missing:',
    groups: [
      { section: 'Diagnosis', fields: ['Root cause'] },
      { section: 'Completion & Handover', fields: ['Return to service'] },
    ],
    items: [
      { field_id: 'diagnosis.root_cause', label: 'Root cause', section: 'Diagnosis', question: 'Resolve diagnosis.root_cause' },
      { field_id: 'completion.state', label: 'Return to service', section: 'Completion & Handover', question: 'Resolve completion.state' },
    ],
  });
});

test('missing hint recomputes immediately when one statement resolves several fields', () => {
  const before = view({
    transcript: finalizedTranscript('Initial statement.'),
    agent_state: agent({
      fields: [unknown('diagnosis.root_cause'), unknown('completion.state')],
      queue: [item('MISSING'), item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state')],
    }),
  });
  const after = view({
    transcript: finalizedTranscript('Root cause not established and unit returned to service.'),
    agent_state: agent({
      fields: [known('diagnosis.root_cause', 'Not established'), unknown('completion.state')],
      queue: [item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state')],
    }),
  });

  assert.deepEqual(before.missing_hint.groups.flatMap((group) => group.fields), ['Root cause', 'Return to service']);
  assert.deepEqual(after.missing_hint.groups.flatMap((group) => group.fields), ['Return to service']);
  assert.equal(after.missing_hint.summary, '1 required technician detail missing');
});

test('recording expands exactly the report sections that still contain blank fields', () => {
  const result = view({
    session: session('CONTEXT'),
    processing: 'RECORDING',
    agent_state: agent({ fields: [
      known('work.work_order_id', 'WO-111-1222', 'AUTHORITATIVE_SYSTEM_DATA'),
      known('asset.internal_fleet_no', '8300-354', 'AUTHORITATIVE_SYSTEM_DATA'),
      unknown('diagnosis.root_cause'),
      { ...unknown('parts.part_number'), state: 'EXPLICIT_NONE' },
      unknown('completion.state'),
    ] }),
  });

  assert.deepEqual(Object.fromEntries(result.report_sections.map((section) => [section.title, section.expanded])), {
    'Job Identity': false,
    Diagnosis: true,
    Rectification: false,
    'Completion & Handover': true,
  });
});

test('schema wildcard families render materialized evidence fields in their declared section', () => {
  const wildcardTemplate = {
    ...template,
    schema: { fields: [
      ...template.schema.fields,
      { id: 'measurement.*', label: 'Measurements', section: 'Rectification', type: 'measurement', repeating: true, displayOrder: 31 },
    ] },
  };
  const result = view({
    template: wildcardTemplate,
    agent_state: agent({ fields: [
      known('work.work_order_id', 'WO-111-1222', 'AUTHORITATIVE_SYSTEM_DATA'),
      known('asset.internal_fleet_no', '8300-354', 'AUTHORITATIVE_SYSTEM_DATA'),
      { ...known('measurement.pressure', 120), unit: 'psi' },
    ] }),
  });
  const measurement = result.report_sections.flatMap((section) => section.fields)
    .find((field) => field.field_id === 'measurement.pressure');

  assert.ok(measurement);
  assert.equal(measurement.name, 'Measurements — pressure');
  assert.equal(measurement.value, '120 psi');
  assert.equal(result.report_sections.find((section) => section.title === 'Rectification').fields.includes(measurement), true);
});

test('correction task ignores non-material items and shows the next material interpretation', () => {
  const result = view({
    session: session('CORRECTION_IF_NEEDED'),
    transcript_review: {
      status: 'PENDING',
      items: [
        { review_item_id: 'cosmetic', material: false, impact_class: 'NON_MATERIAL', source_span: { quote: 'coil.' }, proposed_text: 'Coil', reason: 'Capitalization only' },
        { review_item_id: 'material', material: true, impact_class: 'MATERIAL', source_span: { quote: '25 psi' }, proposed_text: '125 psi', reason: 'Measurement changed' },
      ],
    },
  });

  assert.equal(result.active_task.kind, 'CORRECTION');
  assert.equal(result.active_task.correction.review_item_id, 'material');
});

test('report history row displays the authoritative persisted update time', async () => {
  const module = await import('../web/report-workspace-view.js');
  assert.equal(typeof module.deriveReportHistoryRow, 'function');
  const base = {
    template: { display_name: 'HVAC Service Report' },
    work_order: 'WO-10482',
    asset: 'AHU-03',
    service_date: null,
    created_at: '2026-09-27T04:30:00.000Z',
    updated_at: '2026-09-27T05:45:00.000Z',
    status: { code: 'NEEDS_INPUT', label: 'Needs your input' },
  };

  assert.deepEqual(module.deriveReportHistoryRow(base, { timeZone: 'Asia/Shanghai' }), {
    title: 'HVAC Service Report',
    secondary: 'WO-10482 · AHU-03 · Updated 27 Sep 2026, 13:45',
    status: 'Needs your input',
  });
  assert.equal(module.deriveReportHistoryRow({
    ...base,
    service_date: '2026-09-26 10:42',
  }, { timeZone: 'Asia/Shanghai' }).secondary, 'WO-10482 · AHU-03 · Updated 27 Sep 2026, 13:45');
  assert.equal(module.deriveReportHistoryRow({
    ...base,
    updated_at: '2026-09-26T17:30:00.000Z',
  }, { timeZone: 'Asia/Shanghai' }).secondary, 'WO-10482 · AHU-03 · Updated 27 Sep 2026, 01:30');
});

test('the report title identifies its creation day and same-day instance in both views', async () => {
  const { deriveReportHistoryRow } = await import('../web/report-workspace-view.js');
  const reportName = 'Bus Defect Rectification · 2026-09-27 (2)';
  const workspace = view({ session: { ...session(), report_name: reportName } });
  assert.equal(workspace.job_header.title, 'Bus Defect Rectification');
  assert.equal(workspace.job_header.metadata, '27 Sep 2026 · Report 2');
  const history = deriveReportHistoryRow({
    report_name: reportName,
    template: { display_name: 'Bus Defect Rectification' },
    created_at: '2026-09-27T03:00:00.000Z',
  }, { timeZone: 'Asia/Shanghai' });
  assert.equal(history.title, 'Bus Defect Rectification');
  assert.equal(history.secondary, '27 Sep 2026 · Report 2 · Updated 11:00');
  assert.equal(deriveReportHistoryRow({
    report_name: reportName,
    updated_at: '2026-09-28T03:00:00.000Z',
  }, { timeZone: 'Asia/Shanghai' }).secondary, '27 Sep 2026 · Report 2 · Updated 28 Sep 2026, 11:00');
});

test('report history keeps the most recently updated report first', async () => {
  const module = await import('../web/report-workspace-view.js');
  assert.equal(typeof module.sortReportHistoryItems, 'function');
  const items = [
    { key: 'older', workspace: { history: { updated_at: '2026-09-26T12:00:00.000Z' } } },
    { key: 'newer', workspace: { history: { updated_at: '2026-09-27T12:00:00.000Z' } } },
    { key: 'fallback', workspace: { session: { updated_at: '2026-09-25T12:00:00.000Z' } } },
  ];

  assert.deepEqual(module.sortReportHistoryItems(items).map((item) => item.key), ['newer', 'older', 'fallback']);
  assert.deepEqual(items.map((item) => item.key), ['older', 'newer', 'fallback']);
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

test('HVAC report header shows captured work order and equipment instead of stale empty copy', () => {
  const result = deriveWorkspaceView({
    template: { name: 'HVAC Service Report', schema: { fields: [
      { id: 'work_order', label: 'Work order', section: 'Job identity' },
      { id: 'equipment', label: 'Equipment', section: 'Job identity' },
    ] } },
    session: session(),
    agent_state: agent({ fields: [known('work_order', '1122345'), known('equipment', 'ABCD')] }),
  });
  assert.equal(result.job_header.identity_line, '1122345 · ABCD');
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

test('report fields stay visible before capture and through completion in schema order', () => {
  const fields = [
    known('work.work_order_id', 'WO-111-1222', 'AUTHORITATIVE_SYSTEM_DATA'),
    known('diagnosis.root_cause', 'Not established', 'MANUAL_TECHNICIAN_INPUT', 'technician-resolution-answer'),
    known('completion.state', 'NOT_READY', 'TECHNICIAN_CONFIRMATION'),
  ];
  const capture = view({
    session: session('CONTEXT'),
    agent_state: agent({ fields, queue: [item('SAFETY_CONFIRMATION', 'SINGLE_SELECT', 'completion.state')] }),
  });
  assert.equal(capture.report_sections.every((section) => section.expanded), true);

  const review = view({ session: session('REVIEW'), agent_state: agent({ fields, complete: true }) });
  assert.equal(review.report_sections.find((section) => section.title === 'Job Identity').expanded, true);
  assert.equal(review.report_sections.find((section) => section.title === 'Diagnosis').expanded, true);
  assert.equal(review.report_sections.find((section) => section.title === 'Completion & Handover').expanded, true);
});

test('sections with unresolved fields stay open during intermediate session phases', () => {
  const result = view({
    session: session('PROCESSING'),
    agent_state: agent({ fields: [unknown('diagnosis.root_cause')], queue: [item('MISSING')] }),
  });
  assert.equal(result.report_sections.find((section) => section.title === 'Diagnosis').expanded, true);
});
