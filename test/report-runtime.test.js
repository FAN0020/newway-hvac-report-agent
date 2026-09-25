import assert from 'node:assert/strict';
import test from 'node:test';

let runtime = {};
try {
  runtime = await import('../web/report-runtime.js');
} catch {
  // The first RED run intentionally reaches these assertions before the runtime exists.
}

test('built-in report schemas expose stable P0 ids and versions', () => {
  assert.deepEqual(
    Object.values(runtime.REPORT_SCHEMAS || {}).map(({ scope, id, version }) => ({ scope, id, version })),
    [
      { scope: 'HVAC', id: 'hvac_service', version: '1' },
      { scope: 'SBS_BUS', id: 'sbs_bus_maintenance', version: '0' },
      { scope: 'SBS_RAIL', id: 'sbs_rail_maintenance', version: '0' },
    ],
  );
});

test('a ReportSession is schema-bound and contains the complete P0 state contract', () => {
  assert.equal(typeof runtime.createReportSession, 'function');
  const session = runtime.createReportSession({
    reportType: 'sbs_bus_maintenance',
    jobContext: { technicianId: 'TECH-1', technicianName: 'Alex' },
    id: 'session_bus',
  });
  assert.equal(session.id, 'session_bus');
  assert.equal(session.scope, 'SBS_BUS');
  assert.equal(session.schemaId, 'sbs_bus_maintenance');
  assert.equal(session.schemaVersion, '0');
  for (const key of [
    'jobContext', 'evidence', 'transcript', 'corrections', 'facts', 'structuredState',
    'fieldStates', 'unresolvedItems', 'reportDraft', 'validation', 'confirmation', 'exportState',
  ]) assert.ok(Object.hasOwn(session, key), `missing ReportSession.${key}`);
});

test('facts map to StructuredJobState with explicit field support and status', () => {
  assert.equal(typeof runtime.mapFactsToStructuredState, 'function');
  const session = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'session_bus' });
  const mapped = runtime.mapFactsToStructuredState(session, [
    { field: 'asset.bus_model', value: 'MAN A95', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript:1' },
  ]);
  assert.equal(mapped.structuredState['asset.bus_model'], 'MAN A95');
  assert.deepEqual(mapped.fieldStates['asset.bus_model'].support, ['transcript:1']);
  assert.equal(mapped.fieldStates['asset.bus_model'].status, 'SUPPORTED');
  assert.equal(mapped.fieldStates['work.type'].status, 'MISSING');
});

test('ResolveQueue normalizes terminology, critical, missing and conflict work', () => {
  assert.equal(typeof runtime.createResolveQueue, 'function');
  const queue = runtime.createResolveQueue({
    correctionCandidates: [
      { candidate_id: 'c1', source_span: { text: 'control modular' }, candidate: 'control module', status: 'PROPOSED' },
      { candidate_id: 'c2', source_span: { text: 'A ninety five' }, candidate: 'A95', status: 'NEEDS_TECHNICIAN_CONFIRMATION' },
    ],
    missingFields: ['work.type'],
    conflicts: [{ field: 'completion.state', values: ['completed', 'deferred'] }],
  });
  assert.deepEqual(new Set(queue.map((item) => item.type)), new Set(['TERMINOLOGY', 'CRITICAL_VALUE', 'MISSING_FIELD', 'CONFLICT']));
  assert.ok(queue.every((item) => item.id && item.question && item.severity && Object.hasOwn(item, 'answer')));
});

test('a critical terminology candidate creates one Resolve action, not duplicate terminology and critical items', () => {
  const queue = runtime.createResolveQueue({
    correctionCandidates: [{ candidate_id: 'critical_1', field: 'parts_used', status: 'NEEDS_TECHNICIAN_CONFIRMATION' }],
    missingFields: [],
    conflicts: [],
  });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].type, 'CRITICAL_VALUE');
});

test('session runtime scopes transient input and rejects stale async completions', () => {
  assert.equal(typeof runtime.createSessionRuntime, 'function');
  const controller = runtime.createSessionRuntime();
  const bus = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'bus' });
  const rail = runtime.createReportSession({ reportType: 'sbs_rail_maintenance', id: 'rail' });
  controller.activate(bus);
  controller.setTransient('query', 'A95 door query');
  controller.setTransient('statement', 'Bus statement');
  const busRequest = controller.beginRequest('retrieve');
  controller.activate(rail);
  assert.equal(controller.getTransient('query'), '');
  assert.equal(controller.getTransient('statement'), '');
  assert.equal(controller.accepts(busRequest), false);
  const railRequest = controller.beginRequest('retrieve');
  assert.equal(controller.accepts(railRequest), true);
  controller.activate(bus);
  assert.equal(controller.getTransient('query'), 'A95 door query');
  assert.equal(controller.getTransient('statement'), 'Bus statement');
});

test('schema registry describes typed fields, repeating families, completeness rules and builder bindings', () => {
  const hvac = runtime.schemaFor('hvac_service');
  assert.equal(hvac.fieldDefinitions.work_order.type, 'structured');
  assert.equal(hvac.fieldDefinitions.measurements.repeating, true);
  assert.equal(hvac.builderBinding, 'hvac_v1');

  const bus = runtime.schemaFor('sbs_bus_maintenance');
  assert.equal(bus.fieldDefinitions['asset.registration_no'].type, 'string');
  assert.equal(bus.fieldDefinitions['measurement.*'].repeating, true);
  assert.equal(bus.fieldDefinitions['completion.state'].allowedValues.includes('completed'), true);
  assert.equal(bus.builderBinding, 'sbs_bus_v0');
  assert.ok(bus.requiredGroups.some((group) => group.id === 'work_performed' && group.targetField === 'work_performed'));

  const rail = runtime.schemaFor('sbs_rail_maintenance');
  assert.equal(rail.fieldDefinitions['asset.train_set'].type, 'string');
  assert.equal(rail.builderBinding, 'sbs_rail_v0');
});

test('mapping preserves explicit false, repeating facts and unsupported input without making it reportable', () => {
  const session = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'session_bus' });
  const mapped = runtime.mapFactsToStructuredState(session, [
    { fact_id: 'f1', field: 'safety.hv_isolated', value: false, source_refs: ['transcript:1'] },
    { fact_id: 'f2', field: 'measurement.voltage', value: 24, unit: 'V', source_refs: ['meter:1'] },
    { fact_id: 'f3', field: 'measurement.current', value: 8, unit: 'A', source_refs: ['meter:2'] },
    { fact_id: 'f4', field: 'invented.secret', value: 'must not render', source_refs: ['transcript:2'] },
  ]);

  assert.equal(mapped.structuredState['safety.hv_isolated'], false);
  assert.equal(mapped.fieldStates['safety.hv_isolated'].status, 'SUPPORTED');
  assert.equal(mapped.fieldStates['measurement.voltage'].value, 24);
  assert.equal(mapped.fieldStates['measurement.current'].value, 8);
  assert.equal(mapped.unsupportedFacts[0].field, 'invented.secret');
  assert.equal(runtime.factsFromStructuredState(mapped).some((fact) => fact.field === 'invented.secret'), false);
});

test('completeness distinguishes unknown from false and rejects disallowed values and units', () => {
  let session = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'session_bus' });
  session = runtime.mapFactsToStructuredState(session, [
    { fact_id: 'f1', field: 'safety.hv_isolated', value: false, source_refs: ['transcript:1'] },
    { fact_id: 'f2', field: 'completion.state', value: 'maybe', source_refs: ['transcript:2'] },
    { fact_id: 'f3', field: 'measurement.odometer_km', value: 123, unit: 'V', source_refs: ['transcript:3'] },
  ]);
  const result = runtime.evaluateCompleteness(session);

  assert.equal(result.missingFields.includes('safety.hv_isolated'), false);
  assert.ok(result.invalidValues.some((item) => item.fieldId === 'completion.state' && item.reason === 'allowed_value'));
  assert.ok(result.invalidValues.some((item) => item.fieldId === 'measurement.odometer_km' && item.reason === 'unit'));
  assert.equal(result.complete, false);
});

test('a Resolve answer updates authoritative state with technician provenance and becomes builder input', () => {
  let session = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'session_bus' });
  session = runtime.mapFactsToStructuredState(session, [
    { fact_id: 'f1', field: 'asset.bus_model', value: 'MAN A95', source_refs: ['transcript:1'] },
  ]);
  const item = {
    id: 'missing_work_performed_0',
    type: 'MISSING_FIELD',
    fieldId: 'work_performed',
    targetField: 'work_performed',
    question: 'What work was performed?',
    answer: null,
  };
  session.unresolvedItems = [item];
  const resolved = runtime.applyResolveAnswer(session, item, 'Replaced the door actuator', {
    technicianId: 'TECH-1',
    technicianName: 'Alex',
  });

  assert.equal(resolved.structuredState.work_performed, 'Replaced the door actuator');
  assert.equal(resolved.fieldStates.work_performed.status, 'SUPPORTED');
  assert.equal(resolved.fieldStates['asset.bus_model'].value, 'MAN A95');
  const fact = runtime.factsFromStructuredState(resolved).find((candidate) => candidate.field === 'work_performed');
  assert.equal(fact.value, 'Replaced the door actuator');
  assert.equal(fact.support_status, 'CONFIRMED_BY_TECHNICIAN');
  assert.equal(fact.provenance.technician_id, 'TECH-1');
  assert.equal(fact.provenance.resolve_item_id, item.id);
  assert.deepEqual(resolved.unresolvedItems.find((candidate) => candidate.id === item.id)?.answer, {
    decision: 'CONFIRM',
    value: 'Replaced the door actuator',
  });
});

test('factsFromStructuredState excludes missing, conflicting and unconfirmed values', () => {
  let session = runtime.createReportSession({ reportType: 'sbs_rail_maintenance', id: 'session_rail' });
  session = runtime.mapFactsToStructuredState(session, [
    { fact_id: 'f1', field: 'asset.train_set', value: 'TS-1', source_refs: ['transcript:1'] },
    { fact_id: 'f2', field: 'completion.state', value: 'completed', source_refs: ['transcript:2'] },
    { fact_id: 'f3', field: 'completion.state', value: 'deferred', source_refs: ['transcript:3'] },
    { fact_id: 'f4', field: 'work.fault_code', value: 'D01', support_status: 'UNCERTAIN', source_refs: ['transcript:4'] },
  ]);
  const fields = runtime.factsFromStructuredState(session).map((fact) => fact.field);
  assert.ok(fields.includes('asset.train_set'));
  assert.equal(fields.includes('completion.state'), false);
  assert.equal(fields.includes('work.fault_code'), false);
});

test('SBS builder facts include deterministic provenance derived from verified state support', () => {
  let session = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'session_bus' });
  session = runtime.mapFactsToStructuredState(session, [
    { fact_id: 'fact_model', field: 'asset.bus_model', value: 'MAN A95', support_status: 'DIRECT_TRANSCRIPT', source_refs: ['transcript:1'] },
  ]);
  const provenance = runtime.factsFromStructuredState(session).find((fact) => fact.field === 'provenance.source');
  assert.deepEqual(provenance.value, { fact_ids: ['fact_model'], source_refs: ['transcript:1'] });
  assert.equal(provenance.source, 'structured_state_mapper');
});

test('schema-declared completion confirmation stays unresolved until technician evidence is applied', () => {
  let session = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'session_bus' });
  session = runtime.mapFactsToStructuredState(session, [
    { fact_id: 'completion_direct', field: 'completion.state', value: 'completed', support_status: 'DIRECT_TRANSCRIPT', source_refs: ['transcript:1'] },
  ]);
  assert.equal(session.fieldStates['completion.state'].status, 'NEEDS_CONFIRMATION');
  const item = runtime.createResolveQueue(session).find((candidate) => candidate.fieldId === 'completion.state');
  const resolved = runtime.applyResolveAnswer(session, item, 'completed', { technicianId: 'TECH-1' });
  assert.equal(resolved.fieldStates['completion.state'].status, 'SUPPORTED');
});

test('critical correction decisions use the backend confirmation contract', () => {
  assert.deepEqual(runtime.correctionDecisionPayload({
    candidateId: 'candidate_1',
    action: 'accept',
    critical: true,
  }), {
    candidate_id: 'candidate_1',
    decision: 'accept',
    critical_value_confirmed: true,
  });
});

test('ReportSession owns capture, manual, processing and complete-page state', () => {
  const session = runtime.createReportSession({ reportType: 'HVAC', id: 'session_hvac' });
  assert.deepEqual(session.manualFields, {});
  assert.deepEqual(session.capture, {
    audioBlob: null,
    audioId: null,
    previewUrl: null,
    attachment: null,
    language: 'auto',
    model: 'base',
  });
  assert.deepEqual(session.processing, { status: 'idle', error: null });
  assert.deepEqual(session.complete, { summary: '', meta: '', copyableText: '' });
});

test('session runtime rejects an older request in the same session and scope', () => {
  const controller = runtime.createSessionRuntime();
  const session = runtime.createReportSession({ reportType: 'HVAC', id: 'hvac' });
  controller.activate(session);
  const older = controller.beginRequest('process');
  const newer = controller.beginRequest('process');
  assert.equal(controller.accepts(older), false);
  assert.equal(controller.accepts(newer), true);
});

test('an unchanged confirmed report stays confirmed while a material change makes it stale', () => {
  assert.equal(typeof runtime.bindSessionConfirmation, 'function');
  assert.equal(typeof runtime.hasMaterialReportChange, 'function');
  assert.equal(typeof runtime.invalidateSessionConfirmation, 'function');
  assert.equal(typeof runtime.confirmationViewState, 'function');

  const session = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'confirmed_bus' });
  session.transcript = { original: 'Inspected MAN A95.', normalized: 'Inspected MAN A95.', hash: 'sha256:statement' };
  session.structuredState = { 'asset.bus_model': 'MAN A95' };
  session.reportDraft = { report_id: 'report-1', sections: [{ id: 'asset', content: ['Bus model: MAN A95.'] }] };
  runtime.bindSessionConfirmation(session, { confirmation_token: 'confirm-1', confirmed_at: '2026-09-26T00:00:00.000Z' });

  assert.equal(runtime.hasMaterialReportChange(session), false);
  assert.deepEqual(runtime.confirmationViewState(session, { reviewable: true }), {
    confirmed: true,
    checkboxChecked: true,
    confirmationDisabled: true,
    canFinalize: true,
    message: 'Confirmed at 2026-09-26T00:00:00.000Z. This exact report version remains official.',
  });

  session.structuredState['asset.bus_model'] = 'MAN A22';
  assert.equal(runtime.hasMaterialReportChange(session), true);
  runtime.invalidateSessionConfirmation(session);
  assert.equal(session.confirmation, null);
  assert.equal(session.status, 'REVIEW');
  assert.deepEqual(session.complete, { summary: '', meta: '', copyableText: '' });
  assert.deepEqual(session.exportState, { saved: false, files: [], error: null });
});

test('report search includes authoritative asset values as well as report and technician identity', () => {
  assert.equal(typeof runtime.reportSearchText, 'function');
  const session = runtime.createReportSession({
    reportType: 'sbs_bus_maintenance',
    id: 'report_bus_47',
    jobContext: { technicianName: 'Alex Tan' },
  });
  session.structuredState = {
    'asset.registration_no': 'SG3050Z',
    'asset.bus_model': 'MAN A95',
  };
  const text = runtime.reportSearchText(session);
  for (const expected of ['report_bus_47', 'alex tan', 'sg3050z', 'man a95']) assert.match(text, new RegExp(expected, 'i'));
});

test('Knowledge search requires a non-empty trimmed query', () => {
  assert.equal(typeof runtime.knowledgeQueryState, 'function');
  assert.deepEqual(runtime.knowledgeQueryState('   '), { valid: false, query: '' });
  assert.deepEqual(runtime.knowledgeQueryState('  MAN A95 door  '), { valid: true, query: 'MAN A95 door' });
});

test('global surfaces expose their own context instead of the last report scope', () => {
  assert.equal(typeof runtime.globalViewStatus, 'function');
  assert.equal(runtime.globalViewStatus('reports'), 'Local report workspace');
  assert.equal(runtime.globalViewStatus('new-report'), 'Choose a report type');
  assert.equal(runtime.globalViewStatus('knowledge', 'SBS_RAIL'), 'Knowledge · SBS Rail Maintenance · scope isolated');
  assert.equal(runtime.globalViewStatus('settings'), 'Local runtime settings');
  assert.equal(runtime.globalViewStatus('help'), 'Demo help and walkthroughs');
});

test('transcript provenance preserves immutable voice evidence when the statement is edited', () => {
  assert.equal(typeof runtime.applyTranscriptArtifact, 'function');
  assert.equal(typeof runtime.transcriptSourceLabel, 'function');
  const session = runtime.createReportSession({ reportType: 'HVAC', id: 'capture_hvac' });
  const voice = {
    artifact_id: 'transcript_voice',
    raw_text: 'Replaced a 35 microfarad capacitor.',
    source_hash: 'sha256:voice',
    input_mode: 'VOICE_TRANSCRIPT',
  };
  const edited = {
    artifact_id: 'transcript_edit',
    raw_text: 'Replaced a 35 µF capacitor.',
    source_hash: 'sha256:edit',
    input_mode: 'EDITED_TRANSCRIPT',
    edited_from_artifact_id: voice.artifact_id,
  };

  runtime.applyTranscriptArtifact(session, voice);
  runtime.applyTranscriptArtifact(session, edited);

  assert.equal(session.transcriptArtifact.artifact_id, edited.artifact_id);
  assert.equal(session.originalTranscriptArtifact.artifact_id, voice.artifact_id);
  assert.deepEqual(session.transcriptHistory.map((artifact) => artifact.artifact_id), [voice.artifact_id]);
  assert.equal(runtime.transcriptSourceLabel(voice), 'Voice transcript');
  assert.equal(runtime.transcriptSourceLabel({ input_mode: 'MANUAL_TRANSCRIPT' }), 'Manual input');
  assert.equal(runtime.transcriptSourceLabel(edited), 'Edited transcript');
});
