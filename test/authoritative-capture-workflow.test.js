import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { hashContract } from '../src/domain/index.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';
import { pcmWav } from './helpers.js';

async function fixture(t, name, { whisper, templateProvider, modelResolver, semanticProvider, semanticModel, clock = () => '2026-09-27T06:00:00.000Z', reportTimeZone } = {}) {
  const root = path.resolve('.tmp-tests', `authoritative-capture-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'authority') });
  const service = new AuthoritativeCaptureService({
    artifactStore,
    sessionStore,
    whisperProvider: whisper || { transcribe: async () => { throw new Error('Unexpected transcription.'); } },
    modelResolver,
    semanticProvider,
    semanticModel,
    templateProvider,
    clock,
    reportTimeZone,
  });
  return { root, artifactStore, sessionStore, service };
}

test('published manual-schema templates open in the authoritative workflow and remain technician-resolvable', async (t) => {
  const customTemplate = {
    templateId: 'qa-pump-checklist', name: 'QA Pump Checklist', status: 'PUBLISHED', templateVersion: '1.0.0',
    domain: 'CUSTOM',
    schema: {
      id: 'qa-pump-checklist-schema', version: '1.0.0',
      fields: [
        { id: 'asset.id', label: 'Asset ID', section: 'Report fields', type: 'string', required: true },
        { id: 'inspection.result', label: 'Inspection result', section: 'Report fields', type: 'text', required: true },
      ],
    },
    contextCorpus: { id: 'qa-pump-checklist-context', version: '1.0.0', sources: [] },
    adapter: { id: 'manual-schema-v1', version: '1.0.0' },
  };
  const { service } = await fixture(t, 'custom-template', {
    templateProvider: async (templateId) => (templateId === customTemplate.templateId ? structuredClone(customTemplate) : null),
  });

  const created = await service.createSession({
    template_id: customTemplate.templateId,
    template_version: customTemplate.templateVersion,
    job_context_ref: 'new-report:custom-template-test',
  });
  assert.equal(created.session.context_binding.scope_id, 'CUSTOM');
  assert.equal(created.agent_state.resolution_queue.length, 2);

  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Pump P-101 was inspected.',
    language: 'en',
    idempotency_key: 'custom-template-capture',
  });
  assert.equal(captured.transcript.raw_text, 'Pump P-101 was inspected.');
  assert.equal(captured.candidates.length, 0);
  assert.equal(captured.agent_state.resolution_queue.length, 2);

  let current = captured;
  for (const value of ['P-101', 'Inspection completed; no leak observed.']) {
    const item = current.agent_state.resolution_queue[0];
    current = await service.answerResolutionItem({
      session_id: created.session.session_id,
      expected_revision: current.session.revision,
      resolution_id: item.resolution_id,
      answer: { kind: 'VALUE', value },
      idempotency_key: `custom-template-answer-${item.field_id}`,
    });
  }
  assert.equal(current.agent_state.completeness.complete, true);
  assert.equal(current.agent_state.resolution_queue.length, 0);
});

test('explicit lowercase Asset ID from ASR auto-fills a published custom schema without a model', async (t) => {
  const customTemplate = {
    templateId: 'qa-pump-checklist', name: 'QA Pump Checklist', status: 'PUBLISHED', templateVersion: '1.0.0',
    domain: 'CUSTOM',
    schema: {
      id: 'qa-pump-checklist-schema', version: '1.0.0',
      fields: [
        { id: 'asset.id', label: 'Asset ID', section: 'Report fields', type: 'string', required: true },
        { id: 'inspection.result', label: 'Inspection result', section: 'Report fields', type: 'text', required: true },
      ],
    },
    contextCorpus: { id: 'qa-pump-checklist-context', version: '1.0.0', sources: [] },
    adapter: { id: 'manual-schema-v1', version: '1.0.0' },
  };
  const { service, sessionStore } = await fixture(t, 'custom-template-asset-id-autofill', {
    templateProvider: async (templateId) => (templateId === customTemplate.templateId ? structuredClone(customTemplate) : null),
  });
  const created = await service.createSession({
    template_id: customTemplate.templateId,
    template_version: customTemplate.templateVersion,
    job_context_ref: 'new-report:custom-template-asset-id-autofill',
  });
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'the asset id is abcd1234',
    language: 'en',
    idempotency_key: 'custom-template-asset-id-autofill',
  });

  const asset = captured.agent_state.report_fields.find((field) => field.field_id === 'asset.id');
  assert.equal(asset.state, 'KNOWN_VALUE');
  assert.equal(asset.value, 'ABCD1234');
  const candidate = captured.candidates.find((item) => item.field_id === 'asset.id');
  assert.equal(candidate.claim.value, 'ABCD1234');
  const span = await sessionStore.readRecord('evidence-spans', candidate.evidence_refs[0].span_id);
  assert.equal(captured.transcript.raw_text.slice(span.start_offset, span.end_offset), 'the asset id is abcd1234');
});

test('schema-supported STT terminology is normalized before extraction without changing raw evidence', async (t) => {
  const customTemplate = {
    templateId: 'qa-pump-checklist', name: 'QA Pump Checklist', status: 'PUBLISHED', templateVersion: '1.0.0',
    domain: 'CUSTOM',
    schema: { id: 'qa-pump-checklist-schema', version: '1.0.0', fields: [
      { id: 'asset.id', label: 'Asset ID', section: 'Report fields', type: 'string', required: true },
      { id: 'inspection.result', label: 'Inspection result', section: 'Report fields', type: 'text', required: true },
    ] },
    contextCorpus: { id: 'qa-pump-checklist-context', version: '1.0.0', sources: [] },
    adapter: { id: 'manual-schema-v1', version: '1.0.0' },
  };
  const unrelatedTemplate = {
    ...customTemplate,
    templateId: 'qa-motor-checklist', name: 'QA Motor Checklist',
    schema: { ...customTemplate.schema, id: 'qa-motor-checklist-schema', fields: [
      { id: 'motor.id', label: 'Motor ID', section: 'Report fields', type: 'string', required: true },
    ] },
    contextCorpus: { ...customTemplate.contextCorpus, id: 'qa-motor-checklist-context' },
  };
  const { service, sessionStore } = await fixture(t, 'schema-stt-correction', {
    templateProvider: async (id) => {
      const found = [customTemplate, unrelatedTemplate].find((item) => item.templateId === id);
      return found ? structuredClone(found) : null;
    },
    whisper: { transcribe: async () => ({
      raw_text: 'The AZERT ID is ABCD1234.', language: 'en', provider: 'fake-whisper', model: 'base', segments: [],
    }) },
  });
  const created = await service.createSession({
    template_id: customTemplate.templateId, template_version: customTemplate.templateVersion,
    job_context_ref: 'new-report:schema-stt-correction',
  });
  const extractionInputs = [];
  const extractFacts = service.extractFacts.bind(service);
  service.extractFacts = (input) => {
    extractionInputs.push(input.extractionText);
    return extractFacts(input);
  };
  const rawText = 'Hello, this is Alex. The AZERT ID is ABCD1234 and the inspection result is various. No problem.';
  const captured = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: rawText, language: 'en', idempotency_key: 'schema-stt-correction',
  });
  assert.equal(captured.transcript.raw_text, rawText);
  assert.equal(captured.transcript.normalized_text,
    'Hello, this is Alex. The Asset ID is ABCD1234 and the inspection result is various. No problem.');
  assert.deepEqual(captured.transcript.corrections.map(({ original, replacement }) => [original, replacement]), [['AZERT', 'Asset']]);
  assert.equal(captured.session.phase, 'RESOLVE');
  const asset = captured.agent_state.report_fields.find((field) => field.field_id === 'asset.id');
  assert.equal(asset.state, 'KNOWN_VALUE');
  assert.equal(asset.value, 'ABCD1234');
  const candidate = captured.candidates.find((item) => item.field_id === 'asset.id');
  const span = await sessionStore.readRecord('evidence-spans', candidate.evidence_refs[0].span_id);
  assert.match(rawText.slice(span.start_offset, span.end_offset), /AZERT ID is ABCD1234/u);
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(chain.transcripts[0].raw_text, rawText);
  assert.equal(chain.transcripts[0].normalized_text, captured.transcript.normalized_text);
  assert.deepEqual(extractionInputs, [captured.transcript.normalized_text]);
  assert.equal(extractionInputs.some((text) => text.includes('AZERT Asset')), false);
  assert.deepEqual(captured.candidates.map((item) => item.field_id).sort(), ['asset.id', 'inspection.result']);

  const next = await service.createSession({
    template_id: customTemplate.templateId, template_version: customTemplate.templateVersion,
    job_context_ref: 'new-report:schema-stt-multiple',
  });
  const multiple = await service.captureText({
    session_id: next.session.session_id, expected_revision: next.session.revision,
    text: 'The AZERT ID is ABCD1234 and the inspextion reslt is various.',
    language: 'en', idempotency_key: 'schema-stt-multiple',
  });
  assert.equal(multiple.transcript.normalized_text, 'The Asset ID is ABCD1234 and the Inspection result is various.');
  assert.equal(multiple.transcript.corrections.length, 3);
  assert.deepEqual(extractionInputs.at(-1), multiple.transcript.normalized_text);
  assert.deepEqual(multiple.candidates.map((item) => item.field_id).sort(), ['asset.id', 'inspection.result']);

  const audioSession = await service.createSession({
    template_id: customTemplate.templateId, template_version: customTemplate.templateVersion,
    job_context_ref: 'new-report:schema-stt-audio',
  });
  const audio = await service.captureAudio({
    session_id: audioSession.session.session_id, expected_revision: audioSession.session.revision,
    wav_buffer: pcmWav({ samples: 333 }), model: 'base', language: 'en', idempotency_key: 'schema-stt-audio',
  });
  assert.equal(audio.transcript.raw_text, 'The AZERT ID is ABCD1234.');
  assert.equal(audio.transcript.normalized_text, 'The Asset ID is ABCD1234.');
  assert.equal(audio.candidates.find((item) => item.field_id === 'asset.id')?.claim.value, 'ABCD1234');
  assert.equal(extractionInputs.at(-1), audio.transcript.normalized_text);

  const otherSession = await service.createSession({
    template_id: unrelatedTemplate.templateId, template_version: unrelatedTemplate.templateVersion,
    job_context_ref: 'new-report:unrelated-stt-context',
  });
  const unrelated = await service.captureText({
    session_id: otherSession.session.session_id, expected_revision: otherSession.session.revision,
    text: 'The AZERT ID is ABCD1234.', language: 'en', idempotency_key: 'unrelated-stt-context',
  });
  assert.equal(unrelated.transcript.normalized_text, unrelated.transcript.raw_text);
  assert.deepEqual(unrelated.transcript.corrections, []);

  const meaningfulSession = await service.createSession({
    template_id: customTemplate.templateId, template_version: customTemplate.templateVersion,
    job_context_ref: 'new-report:meaningful-alternative',
  });
  const meaningful = await service.captureText({
    session_id: meaningfulSession.session.session_id, expected_revision: meaningfulSession.session.revision,
    text: 'The Agent ID is ABCD1234.', language: 'en', idempotency_key: 'meaningful-alternative',
  });
  assert.equal(meaningful.transcript.normalized_text, meaningful.transcript.raw_text);
  assert.deepEqual(meaningful.transcript.corrections, []);
  assert.equal(meaningful.candidates.some((item) => item.field_id === 'asset.id'), false);
});

async function busSession(service, suffix = '1') {
  return service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0',
    job_context_ref: `job-context:WO-CAPTURE-${suffix}`,
  });
}

test('opening the same template creates distinct dated report names with a daily index', async (t) => {
  let now = '2026-09-26T16:30:00.000Z';
  const { service, sessionStore } = await fixture(t, 'dated-report-names', {
    clock: () => now,
    reportTimeZone: 'Asia/Shanghai',
  });
  const baseName = 'Bus Defect Rectification / Corrective Maintenance';
  const first = await busSession(service, 'NAME-1');
  const second = await busSession(service, 'NAME-2');

  assert.notEqual(first.session.session_id, second.session.session_id);
  assert.equal(first.session.report_name, `${baseName} · 2026-09-27`);
  assert.equal(second.session.report_name, `${baseName} · 2026-09-27 (2)`);
  assert.equal(second.session.phase, 'CONTEXT');
  assert.deepEqual(second.session.transcript_ids, []);
  assert.equal((await sessionStore.load(second.session.session_id)).report_name, second.session.report_name);

  const history = await service.listReportHistory();
  assert.equal(history.find((item) => item.session_id === second.session.session_id).report_name, second.session.report_name);

  const simultaneous = await Promise.all([busSession(service, 'NAME-4'), busSession(service, 'NAME-5')]);
  assert.deepEqual(new Set(simultaneous.map((item) => item.session.report_name)), new Set([
    `${baseName} · 2026-09-27 (3)`,
    `${baseName} · 2026-09-27 (4)`,
  ]));

  now = '2026-09-27T16:30:00.000Z';
  const nextDay = await busSession(service, 'NAME-3');
  assert.equal(nextDay.session.report_name, `${baseName} · 2026-09-28`);
});

test('history gives previously saved unnamed reports distinct dated titles', async (t) => {
  const { service, sessionStore } = await fixture(t, 'legacy-report-names', { reportTimeZone: 'Asia/Shanghai' });
  const common = {
    template_binding: { template_id: 'bus-defect-rectification-corrective-maintenance', template_version: '1.0.0' },
    context_binding: { context_id: 'SBS/BUS', context_version: 'scope-registry.v1', scope_id: 'SBS_BUS' },
    job_context_ref: 'new-report:legacy',
    created_at: '2026-09-26T16:30:00.000Z',
  };
  await sessionStore.create({ ...common, session_id: 'session_legacy_one' });
  await sessionStore.create({ ...common, session_id: 'session_legacy_two' });

  const titles = (await service.listReportHistory()).map((item) => item.report_name);
  assert.deepEqual(new Set(titles), new Set([
    'Bus Defect Rectification / Corrective Maintenance · 2026-09-27',
    'Bus Defect Rectification / Corrective Maintenance · 2026-09-27 (2)',
  ]));
});

test('technician text is persisted, report-bound, reviewed harmlessly, and converted to structured candidates', async (t) => {
  const { service, sessionStore } = await fixture(t, 'text');
  const created = await busSession(service, 'TEXT');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault. Replaced the door control module.',
    language: 'en',
    idempotency_key: 'text-capture-1',
  });

  assert.equal(result.reused, false);
  assert.equal(result.session.phase, 'RESOLVE');
  assert.equal(result.next_action, 'RESOLVE_REPORT_FIELDS');
  assert.equal(result.evidence.evidence_type, 'MANUAL_INPUT');
  assert.equal(result.evidence.metadata.report_binding.report_session_id, created.session.session_id);
  assert.equal(result.evidence.metadata.report_binding.template_id, 'bus-defect-rectification-corrective-maintenance');
  assert.equal(result.evidence.metadata.report_binding.template_version, '1.0.0');
  assert.equal(result.evidence.metadata.report_binding.scope_id, 'SBS_BUS');
  assert.equal(result.transcript.source_evidence_id, result.evidence.evidence_id);
  assert.equal(result.transcript.source_hash, result.evidence.source_hash);
  assert.equal(result.transcript.session_id, created.session.session_id);
  assert.equal(result.transcript.template_binding.template_version, '1.0.0');
  assert.equal(result.review, null);
  assert.ok(result.candidates.some((candidate) => candidate.field_id === 'asset.bus_model'));
  assert.ok(result.candidates.every((candidate) => candidate.support_type === 'MANUAL_TECHNICIAN_INPUT'));
  assert.ok(result.candidates.every((candidate) => candidate.evidence_refs[0].span_id));
  assert.deepEqual(await sessionStore.load(created.session.session_id), result.session);
  assert.deepEqual((await sessionStore.listAuditEvents(created.session.session_id)).map((event) => event.event_type), [
    'SESSION_CREATED',
    'EVIDENCE_CAPTURED',
    'PROCESSING_STARTED',
    'STRUCTURED_CANDIDATES_CREATED',
  ]);
});

test('transcript measurements become numeric server candidates while preserving exact units', async (t) => {
  const { service } = await fixture(t, 'numeric-measurement');
  const created = await busSession(service, 'MEASUREMENT');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'The odometer was 51020 km.',
    language: 'en',
    idempotency_key: 'measurement-capture-1',
  });
  const candidate = result.candidates.find((entry) => entry.field_id === 'measurement.odometer_km');
  assert.deepEqual(candidate.claim.value, { value: 51020, unit: 'km' });
  const field = result.agent_state.report_fields.find((entry) => entry.field_id === 'measurement.odometer_km');
  assert.equal(field.state, 'KNOWN_VALUE');
  const issue = result.agent_state.validation_issues.find((entry) => entry.field_id === 'measurement.odometer_km');
  assert.equal(issue.code, 'CRITICAL_CONFIRMATION_REQUIRED');
  assert.equal(issue.blocking, true);
  const resolution = result.agent_state.resolution_queue.find((entry) => entry.field_id === 'measurement.odometer_km');
  assert.equal(resolution.type, 'SAFETY_CONFIRMATION');
});

test('ordinary text capture uses the selected fact-centric interpretation even without a correction screen', async (t) => {
  const { service } = await fixture(t, 'fact-centric-no-review');
  const created = await busSession(service, 'NO-REVIEW');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'The passenger door would not close. Inspection found a loose connector. No outstanding issues.',
    language: 'en',
    idempotency_key: 'fact-centric-no-review-1',
  });
  assert.equal(result.review, null);
  assert.deepEqual(
    result.candidates.filter((candidate) => candidate.field_id === 'inspection_findings').map((candidate) => candidate.claim.value),
    ['Inspection found a loose connector'],
  );
  const outstanding = result.agent_state.report_fields.find((field) => field.field_id === 'completion.outstanding_issues');
  assert.equal(outstanding.state, 'EXPLICIT_NONE');
  assert.equal(result.agent_state.resolution_queue.some((item) => item.field_id === 'completion.outstanding_issues'), false);
});

test('natural HVAC narration populates clause-specific fields without whole-narration contamination', async (t) => {
  const { service } = await fixture(t, 'semantic-hvac-regression');
  const created = await service.createSession({
    template_id: 'hvac-service-report',
    template_version: '1.0.0',
    job_context_ref: 'job-context:SEMANTIC-HVAC',
  });
  const narration = [
    'Hello, this is technician Alex and the work order is 1122344.',
    'The equipment needed is ABCD.',
    'The customer complained that the office was not cooling.',
    'I inspected the drain line and found a blockage.',
    'I cleared the drain line.',
    'The completion status is done.',
    'The test result is passed.',
  ].join(' ');

  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: narration,
    language: 'en',
    idempotency_key: 'semantic-hvac-regression-1',
  });
  const values = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field.value]));

  assert.equal(values.work_order, '1122344');
  assert.equal(values.equipment, 'ABCD');
  assert.equal(values.customer_complaint, 'the office was not cooling');
  assert.equal(values.inspection_findings, 'a blockage');
  assert.equal(values.work_performed, 'cleared the drain line');
  assert.equal(values.completion_status, 'done');
  assert.equal(values.test_results, 'passed');
  for (const fieldId of ['customer_complaint', 'inspection_findings', 'work_performed', 'completion_status', 'test_results']) {
    assert.notEqual(values[fieldId], narration, `${fieldId} must not receive the whole narration`);
  }
});

test('a natural sealed repair is preserved as completed work', async (t) => {
  const { service } = await fixture(t, 'semantic-sealed-work');
  const created = await service.createSession({
    template_id: 'hvac-service-report', template_version: '1.0.0',
    job_context_ref: 'job-context:SEMANTIC-SEALED-WORK',
  });
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'I inspected the return-air flange and found a hairline crack. I sealed the flange with approved sealant.',
    language: 'en', idempotency_key: 'semantic-sealed-work-1',
  });
  const work = result.agent_state.report_fields.find((field) => field.field_id === 'work_performed');
  assert.match(work?.value || '', /sealed the flange with approved sealant/iu);
});

test('configured structured extraction proposes a grounded natural finding before deterministic fallback', async (t) => {
  const input = 'The return-air flange had a hairline crack.';
  const semanticProvider = { generateJson: async () => ({ data: { facts: [{
    semantic_type: 'INSPECTION_FINDING', value: 'hairline crack', evidence_quote: input,
    char_start: 0, char_end: input.length, source_role: 'TECHNICIAN', temporality: 'CURRENT',
  }] } }) };
  const { service } = await fixture(t, 'structured-grounded-finding', { semanticProvider, semanticModel: 'local-test-model' });
  const created = await service.createSession({
    template_id: 'hvac-service-report', template_version: '1.0.0',
    job_context_ref: 'job-context:STRUCTURED-GROUNDED-FINDING',
  });
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: input, language: 'en', idempotency_key: 'structured-grounded-finding-1',
  });
  const candidate = result.candidates.find((item) => item.field_id === 'inspection_findings');
  assert.equal(candidate.claim.value, 'hairline crack');
  assert.equal(candidate.extraction.method, 'structured-semantic-proposal');
  assert.equal(result.agent_state.report_fields.find((field) => field.field_id === 'test_results').state, 'UNKNOWN');
});

test('capture saves an evidence-backed report-field JSON artifact, omitting unsupported model guesses', async (t) => {
  const input = 'Work order 7712. AC-104 is the unit. Room felt warm, customer said. I sealed the flange.';
  const semanticProvider = { generateJson: async () => ({ data: { facts: [
    { semantic_type: 'EQUIPMENT_OR_ASSET', value: 'AC-104', claim_kind: 'VALUE', evidence_quote: 'AC-104 is the unit' },
    { semantic_type: 'CUSTOMER_OBSERVATION', value: 'Room felt warm', claim_kind: 'VALUE', evidence_quote: 'Room felt warm, customer said' },
    { semantic_type: 'COMPLETED_ACTION', value: 'sealed the flange', claim_kind: 'VALUE', evidence_quote: 'I sealed the flange' },
    { semantic_type: 'TEST_OUTCOME', value: 'passed', claim_kind: 'VALUE', evidence_quote: 'I sealed the flange' },
  ] } }) };
  const { service, root } = await fixture(t, 'semantic-json-artifact', { semanticProvider, semanticModel: 'local-test-model' });
  const created = await service.createSession({
    template_id: 'hvac-service-report', template_version: '1.0.0', job_context_ref: 'new-report:semantic-json-artifact',
  });
  const captured = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: input, language: 'en', idempotency_key: 'semantic-json-artifact-1',
  });
  const directory = path.join(root, 'authority', 'records', 'semantic-extractions');
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const artifact = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'));
  assert.equal(artifact.schema_version, 'report-field-extraction.v1');
  assert.equal(artifact.session_id, created.session.session_id);
  assert.equal(artifact.transcript_id, captured.transcript.transcript_id);
  assert.equal(artifact.model, 'local-test-model');
  assert.equal(artifact.model_contributed, true);
  assert.deepEqual(artifact.fields.map((field) => field.field_id).sort(),
    captured.candidates.map((candidate) => candidate.field_id).sort());
  assert.equal(artifact.fields.some((field) => field.field_id === 'test_results'), false);
  for (const field of artifact.fields) {
    assert.equal(input.slice(field.evidence.start, field.evidence.end), field.evidence.quote);
    assert.equal(field.value, captured.candidates.find((candidate) => candidate.field_id === field.field_id)?.claim.value);
  }
});

test('completion today uses capture time and schema-matched trigger and depot phrases fill their blanks', async (t) => {
  const input = 'It is finished today. This is triggered by a faulty door sensor. Depot is Ang Mo Kio.';
  const semanticProvider = { generateJson: async () => ({ data: {
    facts: [{ semantic_type: 'COMPLETION_STATE', value: 'finished today', claim_kind: 'VALUE', evidence_quote: 'It is finished today' }],
    field_values: [
      { field_id: 'work.trigger', value: 'a faulty door sensor', evidence_quote: 'This is triggered by a faulty door sensor' },
      { field_id: 'asset.depot', value: 'Ang Mo Kio', evidence_quote: 'Depot is Ang Mo Kio' },
    ],
  } }) };
  const { service, root } = await fixture(t, 'schema-aware-natural-blanks', {
    semanticProvider, semanticModel: 'local-test-model',
    clock: () => '2026-09-27T06:23:00.000Z', reportTimeZone: 'Asia/Shanghai',
  });
  const created = await busSession(service, 'SCHEMA-AWARE');
  const captured = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: input, language: 'en', idempotency_key: 'schema-aware-natural-blanks-1',
  });
  const byField = Object.fromEntries(captured.candidates.map((candidate) => [candidate.field_id, candidate]));
  assert.equal(byField['work.date_time']?.claim.value, '2026-09-27 14:23');
  assert.equal(byField['work.date_time']?.support_type, 'AI_INFERENCE');
  assert.equal(captured.agent_state.report_fields.find((field) => field.field_id === 'work.date_time')?.state, 'INFERRED');
  assert.equal(captured.agent_state.report_fields.find((field) => field.field_id === 'work.date_time')?.value, '2026-09-27 14:23');
  assert.equal(byField['work.trigger']?.claim.value, 'a faulty door sensor');
  assert.equal(byField['asset.depot']?.claim.value, 'Ang Mo Kio');
  assert.equal(byField['completion.state'], undefined, 'finished maintenance does not prove safe return to service');
  const expectedQuotes = {
    'work.date_time': 'It is finished today',
    'work.trigger': 'This is triggered by a faulty door sensor',
    'asset.depot': 'Depot is Ang Mo Kio',
  };
  for (const fieldId of ['work.date_time', 'work.trigger', 'asset.depot']) {
    const span = await service.sessionStore.readRecord('evidence-spans', byField[fieldId].evidence_refs[0].span_id);
    assert.equal(input.slice(span.start_offset, span.end_offset), expectedQuotes[fieldId]);
  }
  const files = await fs.readdir(path.join(root, 'authority', 'records', 'semantic-extractions'));
  assert.equal(files.length, 1);
  const artifact = JSON.parse(await fs.readFile(path.join(root, 'authority', 'records', 'semantic-extractions', files[0]), 'utf8'));
  assert.equal(artifact.fields.find((field) => field.field_id === 'work.date_time')?.value, '2026-09-27 14:23');
});

test('future or negated completion never derives a current date/time', async (t) => {
  const { service } = await fixture(t, 'no-speculative-completion-time', {
    clock: () => '2026-09-27T06:23:00.000Z', reportTimeZone: 'Asia/Shanghai',
  });
  for (const [index, statement] of ['It will be finished today.', 'It was not finished today.'].entries()) {
    const created = await busSession(service, `NO-TIME-${index}`);
    const captured = await service.captureText({
      session_id: created.session.session_id, expected_revision: created.session.revision,
      text: statement, language: 'en', idempotency_key: `no-speculative-time-${index}`,
    });
    assert.equal(captured.candidates.some((candidate) => candidate.field_id === 'work.date_time'), false, statement);
  }
});

test('natural completion paraphrases derive the capture timestamp for review', async (t) => {
  const { service } = await fixture(t, 'completion-time-paraphrases', {
    clock: () => '2026-09-27T06:23:00.000Z', reportTimeZone: 'Asia/Shanghai',
  });
  for (const [index, statement] of ["It's finished today.", 'I just finished this maintenance.', 'It’s finished today.'].entries()) {
    const created = await busSession(service, `DATE-PARAPHRASE-${index}`);
    const captured = await service.captureText({
      session_id: created.session.session_id, expected_revision: created.session.revision,
      text: statement, language: 'en', idempotency_key: `date-paraphrase-${index}`,
    });
    const field = captured.agent_state.report_fields.find((item) => item.field_id === 'work.date_time');
    assert.equal(field?.state, 'INFERRED', statement);
    assert.equal(field?.value, '2026-09-27 14:23', statement);
    assert.equal(captured.agent_state.report_fields.find((item) => item.field_id === 'completion.state')?.state, 'UNKNOWN', statement);
  }
});

test('the original mixed-sentence narration keeps the inspection object separate from completed work', async (t) => {
  const { service } = await fixture(t, 'semantic-original-mixed-sentence');
  const created = await service.createSession({
    template_id: 'hvac-service-report', template_version: '1.0.0',
    job_context_ref: 'job-context:SEMANTIC-ORIGINAL-MIXED',
  });
  const narration = 'Hello, this is technician Alex and the work order is 1122344. The equipment needed is ABCD and the customer complained that the office was not cooling. I inspected the BFGH and I did HIJM. The completion status is done and the test result is passed.';
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: narration, language: 'en', idempotency_key: 'semantic-original-mixed-1',
  });
  const values = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field.value]));
  assert.equal(values.work_order, '1122344');
  assert.equal(values.equipment, 'ABCD');
  assert.equal(values.customer_complaint, 'the office was not cooling');
  assert.equal(values.inspection_findings, 'the BFGH');
  assert.equal(values.work_performed, 'HIJM');
  assert.equal(values.completion_status, 'done');
  assert.equal(values.test_results, 'passed');
  assert.equal(result.candidates.filter((candidate) => candidate.field_id === 'work_performed').length, 1);
});

test('a recommendation in the same sentence does not erase completed repair evidence', async (t) => {
  const { service } = await fixture(t, 'semantic-mixed-future');
  const created = await busSession(service, 'SEMANTIC-MIXED-FUTURE');
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: 'I replaced the leaking valve, but recommend replacing the compressor next visit.',
    language: 'en', idempotency_key: 'semantic-mixed-future-1',
  });
  const fields = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field]));
  assert.equal(fields.work_performed.value, 'replaced the leaking valve');
  assert.equal(fields['parts.part_number'].value, 'leaking valve');
  assert.equal(result.candidates.some((candidate) => candidate.field_id === 'parts.part_number' && String(candidate.claim.value).includes('compressor')), false);
});

test('a negated action in one clause does not erase a different completed action', async (t) => {
  const { service } = await fixture(t, 'semantic-mixed-negation');
  const created = await busSession(service, 'SEMANTIC-MIXED-NEGATION');
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: 'The compressor was not replaced, but I installed the valve.',
    language: 'en', idempotency_key: 'semantic-mixed-negation-1',
  });
  const values = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field.value]));
  assert.equal(values.work_performed, 'installed the valve');
  assert.equal(values['parts.part_number'], 'the valve');
  assert.equal(result.candidates.some((candidate) => String(candidate.claim.value).includes('compressor')), false);
});

test('a customer-reported failure does not become a technician test result', async (t) => {
  const { service } = await fixture(t, 'semantic-customer-failure');
  const created = await service.createSession({
    template_id: 'hvac-service-report', template_version: '1.0.0',
    job_context_ref: 'job-context:SEMANTIC-CUSTOMER-FAILURE',
  });
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: 'The customer reported that the compressor failed.',
    language: 'en', idempotency_key: 'semantic-customer-failure-1',
  });
  const fields = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field]));
  assert.equal(fields.customer_complaint.value, 'the compressor failed');
  assert.equal(fields.test_results.state, 'UNKNOWN');
});

test('a technician test outcome before a customer statement keeps technician ownership', async (t) => {
  const { service } = await fixture(t, 'semantic-speaker-transition');
  const created = await service.createSession({
    template_id: 'hvac-service-report', template_version: '1.0.0',
    job_context_ref: 'job-context:SEMANTIC-SPEAKER-TRANSITION',
  });
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: 'The post-work test passed and the customer reported no further cooling complaints.',
    language: 'en', idempotency_key: 'semantic-speaker-transition-1',
  });
  const values = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field.value]));
  assert.equal(values.test_results, 'passed');
  assert.equal(values.customer_complaint, 'no further cooling complaints');
});

test('a negated test pass does not become a passing result', async (t) => {
  const { service } = await fixture(t, 'semantic-negated-test');
  const created = await busSession(service, 'SEMANTIC-NEGATED-TEST');
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: 'I tested the door. The door did not pass the post-work test.',
    language: 'en', idempotency_key: 'semantic-negated-test-1',
  });
  const field = result.agent_state.report_fields.find((entry) => entry.field_id === 'test.result');
  assert.notEqual(field.value, 'passed');
  assert.equal(result.candidates.some((candidate) => candidate.field_id === 'test.result' && candidate.claim.value === 'passed'), false);
});

test('customer report, finding, work, test action and outcome remain semantically separate', async (t) => {
  const { service } = await fixture(t, 'semantic-bus-separation');
  const created = await busSession(service, 'SEMANTIC-SEPARATION');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'The customer reported that the front door would not close. I inspected the door controller and found a loose connector. I reseated the connector. I tested the door opening and closing. Both cycles passed.',
    language: 'en',
    idempotency_key: 'semantic-bus-separation-1',
  });
  const values = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field.value]));

  assert.equal(values['work.trigger'], 'the front door would not close');
  assert.equal(values.inspection_findings, 'a loose connector');
  assert.equal(values.work_performed, 'reseated the connector');
  assert.equal(values['test.result'], 'passed');
});

test('natural compound speech keeps multiple completed actions without creating a false field conflict', async (t) => {
  const { service } = await fixture(t, 'semantic-natural-compound');
  const created = await busSession(service, 'SEMANTIC-NATURAL-COMPOUND');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: "Okay, I'm done with bus 354. Customer said the front door was sticking earlier. I checked it and found the connector at the controller was loose, so I reseated that and secured it. Didn't change any parts. Ran the door open-close test twice afterward and both were normal. Bus is okay to return to service, nothing else needed.",
    language: 'en',
    idempotency_key: 'semantic-natural-compound-1',
  });
  const fields = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field]));

  assert.equal(fields['asset.internal_fleet_no'].value, '354');
  assert.equal(fields['work.trigger'].value, 'the front door was sticking earlier');
  assert.match(fields.inspection_findings.value, /connector at the controller was loose/iu);
  assert.equal(fields.work_performed.state, 'KNOWN_VALUE');
  assert.notEqual(fields.work_performed.state, 'CONFLICT');
  assert.match(fields.work_performed.value, /reseated/iu);
  assert.match(fields.work_performed.value, /secured/iu);
  assert.equal(fields['parts.part_number'].state, 'EXPLICIT_NONE');
  assert.equal(fields['test.result'].value, 'passed');
  assert.equal(fields['completion.state'].value, 'READY');
  assert.equal(fields['completion.outstanding_issues'].state, 'EXPLICIT_NONE');
});

test('coalesced work retains separate original-word spans instead of swallowing intervening complaint', async (t) => {
  const { service, sessionStore } = await fixture(t, 'semantic-additive-spans');
  const created = await busSession(service, 'SEMANTIC-ADDITIVE-SPANS');
  const input = 'I replaced the valve. The customer reported no cooling. I tightened the contactor.';
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: input, language: 'en', idempotency_key: 'semantic-additive-spans-1',
  });
  const candidate = result.candidates.find((item) => item.field_id === 'work_performed');
  assert.equal(candidate.claim.value, 'replaced the valve; tightened the contactor');
  assert.equal(candidate.evidence_refs.length, 2);
  const quotes = await Promise.all(candidate.evidence_refs.map(async (ref) => {
    const span = await sessionStore.readRecord('evidence-spans', ref.span_id);
    return result.transcript.raw_text.slice(span.start_offset, span.end_offset);
  }));
  assert.deepEqual(quotes, ['I replaced the valve', 'I tightened the contactor']);
});

test('test action without an outcome leaves test result unknown', async (t) => {
  const { service } = await fixture(t, 'semantic-test-abstention');
  const created = await busSession(service, 'SEMANTIC-TEST-ABSTENTION');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'I tested the front door opening and closing.',
    language: 'en',
    idempotency_key: 'semantic-test-abstention-1',
  });

  assert.equal(result.candidates.some((candidate) => candidate.field_id === 'test.result'), false);
  assert.equal(result.agent_state.report_fields.find((field) => field.field_id === 'test.result').state, 'UNKNOWN');
});

test('recommended and negated replacement does not become work performed or a part used', async (t) => {
  const { service } = await fixture(t, 'semantic-part-temporality');
  const created = await busSession(service, 'SEMANTIC-PART-TEMPORALITY');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Recommend replacing the door control module next visit. The door control module was not replaced today.',
    language: 'en',
    idempotency_key: 'semantic-part-temporality-1',
  });

  assert.equal(result.candidates.some((candidate) => candidate.field_id === 'parts.part_number'), false);
  assert.equal(result.candidates.some((candidate) => candidate.field_id === 'work_performed'), false);
});

test('field-specific capture context is preserved without overriding semantic compatibility', async (t) => {
  const { service } = await fixture(t, 'semantic-field-context');
  const created = await busSession(service, 'SEMANTIC-FIELD-CONTEXT');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'We replaced the door control module.',
    language: 'en',
    idempotency_key: 'semantic-field-context-1',
    target_field_id: 'test.result',
    target_section_id: 'Completion and handover',
    capture_mode: 'FIELD_DICTATION',
  });

  assert.deepEqual(result.evidence.metadata.capture_context, {
    target_field_id: 'test.result',
    target_section_id: 'Completion and handover',
    capture_mode: 'FIELD_DICTATION',
  });
  assert.deepEqual(result.transcript.capture_context, result.evidence.metadata.capture_context);
  assert.equal(result.candidates.some((candidate) => candidate.field_id === 'test.result'), false);
  assert.equal(result.candidates.some((candidate) => candidate.field_id === 'work_performed'), true);
});

test('standalone completion dictation is interpreted only in its compatible target field', async (t) => {
  const { service } = await fixture(t, 'semantic-targeted-completion');
  const created = await busSession(service, 'SEMANTIC-TARGETED-COMPLETION');
  const result = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: 'Completed.', language: 'en', idempotency_key: 'semantic-targeted-completion-1',
    target_field_id: 'completion.state', target_section_id: 'Completion and handover', capture_mode: 'FIELD_DICTATION',
  });
  const fields = Object.fromEntries(result.agent_state.report_fields.map((field) => [field.field_id, field]));
  assert.equal(fields['completion.state'].value, 'READY');
  for (const fieldId of ['work.trigger', 'inspection_findings', 'work_performed', 'test.result', 'parts.part_number']) {
    assert.equal(fields[fieldId].state, 'UNKNOWN');
  }
});

test('a compatible dictated correction supersedes the prior AI field value without losing it', async (t) => {
  const { service, sessionStore } = await fixture(t, 'semantic-dictated-supersession');
  const created = await busSession(service, 'SEMANTIC-DICTATED-SUPERSESSION');
  const first = await service.captureText({
    session_id: created.session.session_id, expected_revision: created.session.revision,
    text: 'The post-work test failed.', language: 'en', idempotency_key: 'semantic-dictated-first',
  });
  assert.equal(first.agent_state.report_fields.find((field) => field.field_id === 'test.result').value, 'failed');
  const second = await service.captureText({
    session_id: created.session.session_id, expected_revision: first.session.revision,
    text: 'Passed.', language: 'en', idempotency_key: 'semantic-dictated-second',
    target_field_id: 'test.result', target_section_id: 'Completion and handover', capture_mode: 'FIELD_DICTATION',
  });
  const field = second.agent_state.report_fields.find((entry) => entry.field_id === 'test.result');
  assert.equal(field.value, 'passed');
  assert.notEqual(field.state, 'CONFLICT');
  assert.equal(field.candidates.some((candidate) => candidate.claim.value === 'failed'), true);
  assert.equal(field.candidates.some((candidate) => candidate.claim.value === 'passed'), true);
  assert.ok(field.superseded_candidate_ids.length);
  const reloaded = await sessionStore.loadChain(created.session.session_id);
  assert.equal(reloaded.agent_state.report_fields.find((entry) => entry.field_id === 'test.result').value, 'passed');
});

test('audio bytes exist before Whisper and the transcript preserves provider timestamps and exact bindings', async (t) => {
  let persistedBytes = null;
  const whisper = {
    transcribe: async (audioPath, { model, language }) => {
      persistedBytes = await fs.readFile(audioPath);
      return {
        raw_text: 'Bus MAN A95 had a door fault. Replaced the door control module.',
        language: language === 'auto' ? 'en' : language,
        segments: [
          { start_ms: 0, end_ms: 900, text: 'Bus MAN A95 had a door fault.' },
          { start_ms: 900, end_ms: 1900, text: 'Replaced the door control module.' },
        ],
        provider: 'fake-whisper',
        model,
      };
    },
  };
  const { service, artifactStore } = await fixture(t, 'audio', { whisper });
  const created = await busSession(service, 'AUDIO');
  const wav = pcmWav({ samples: 333 });
  const result = await service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: wav,
    model: 'base.en',
    language: 'auto',
    idempotency_key: 'audio-capture-1',
  });

  assert.deepEqual(persistedBytes, wav);
  assert.equal(await artifactStore.hasAudio(result.audio.audio_id), true);
  assert.equal(result.evidence.source_hash, result.audio.source_hash);
  assert.equal(result.transcript.provider, 'fake-whisper');
  assert.equal(result.transcript.model, 'base.en');
  assert.equal(result.transcript.language, 'en');
  assert.deepEqual(result.transcript.segments, [
    { start_ms: 0, end_ms: 900, text: 'Bus MAN A95 had a door fault.' },
    { start_ms: 900, end_ms: 1900, text: 'Replaced the door control module.' },
  ]);
  assert.equal(result.transcript.context_binding.context_id, 'SBS/BUS');
  assert.equal(result.session.phase, 'RESOLVE');
});

test('audio capture snapshots the server-configured model for an in-flight job and ignores a client override', async (t) => {
  const used = [];
  let selected = 'small';
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  let continueFirst;
  const firstCanFinish = new Promise((resolve) => { continueFirst = resolve; });
  const whisper = { transcribe: async (_audioPath, { model }) => {
    used.push(model);
    if (used.length === 1) {
      releaseFirst();
      await firstCanFinish;
    }
    return { raw_text: 'Bus MAN A95 had a door fault.', language: 'en', segments: [], provider: 'fake-whisper', model };
  } };
  const { service } = await fixture(t, 'configured-model', { whisper, modelResolver: async () => selected });
  const firstSession = await busSession(service, 'CONFIGURED-ONE');
  const firstPending = service.captureAudio({
    session_id: firstSession.session.session_id, expected_revision: 0,
    wav_buffer: pcmWav({ samples: 177 }), model: 'tiny', language: 'en', idempotency_key: 'configured-one',
  });
  await firstStarted;
  selected = 'medium';
  continueFirst();
  const first = await firstPending;
  const secondSession = await busSession(service, 'CONFIGURED-TWO');
  const second = await service.captureAudio({
    session_id: secondSession.session.session_id, expected_revision: 0,
    wav_buffer: pcmWav({ samples: 179 }), model: 'tiny', language: 'en', idempotency_key: 'configured-two',
  });
  assert.deepEqual(used, ['small', 'medium']);
  assert.equal(first.transcript.model, 'small');
  assert.equal(second.transcript.model, 'medium');
});

test('same-source retry is idempotent and never duplicates audio, evidence, transcript, or candidates', async (t) => {
  let calls = 0;
  const whisper = {
    transcribe: async (_audioPath, { model }) => {
      calls += 1;
      return {
        raw_text: 'Bus MAN A95 had a door fault.',
        language: 'en', segments: [], provider: 'fake-whisper', model,
      };
    },
  };
  const { service, sessionStore } = await fixture(t, 'same-source', { whisper });
  const created = await busSession(service, 'SAME');
  const input = {
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: pcmWav({ samples: 401 }),
    model: 'base.en', language: 'en', idempotency_key: 'same-source-key',
  };
  const first = await service.captureAudio(input);
  const second = await service.captureAudio({ ...input, expected_revision: first.session.revision });
  const chain = await sessionStore.loadChain(created.session.session_id);

  assert.equal(calls, 1);
  assert.equal(second.reused, true);
  assert.equal(second.session.revision, first.session.revision);
  assert.equal(second.evidence.evidence_id, first.evidence.evidence_id);
  assert.equal(second.transcript.transcript_id, first.transcript.transcript_id);
  assert.deepEqual(second.candidates.map((item) => item.candidate_id), first.candidates.map((item) => item.candidate_id));
  assert.equal(chain.evidence.length, 1);
  assert.equal(chain.transcripts.length, 1);
  assert.equal(chain.field_candidates.length, first.candidates.length);
});

test('same technician text identity reuses the authoritative chain without another revision', async (t) => {
  const { service, sessionStore } = await fixture(t, 'same-text');
  const created = await busSession(service, 'SAME-TEXT');
  const input = {
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault.',
    language: 'en',
    idempotency_key: 'same-text-key',
  };
  const first = await service.captureText(input);
  const second = await service.captureText({ ...input, expected_revision: first.session.revision });
  const chain = await sessionStore.loadChain(created.session.session_id);

  assert.equal(second.reused, true);
  assert.equal(second.session.revision, first.session.revision);
  assert.equal(second.evidence.evidence_id, first.evidence.evidence_id);
  assert.equal(second.transcript.transcript_id, first.transcript.transcript_id);
  assert.equal(chain.evidence.length, 1);
  assert.equal(chain.transcripts.length, 1);
});

test('a custom idempotency key cannot reuse a transcript for different audio bytes', async (t) => {
  let calls = 0;
  const whisper = {
    transcribe: async (_audioPath, { model }) => {
      calls += 1;
      return { raw_text: 'Bus MAN A95 had a door fault.', language: 'en', segments: [], provider: 'fake-whisper', model };
    },
  };
  const { service } = await fixture(t, 'key-reuse', { whisper });
  const created = await busSession(service, 'KEY');
  const first = await service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: pcmWav({ samples: 402 }),
    model: 'base.en', language: 'en', idempotency_key: 'adversarial-key',
  });

  await assert.rejects(service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: first.session.revision,
    wav_buffer: pcmWav({ samples: 403 }),
    model: 'base.en', language: 'en', idempotency_key: 'adversarial-key',
  }), { code: 'IDEMPOTENCY_KEY_REUSE' });
  assert.equal(calls, 1);
});

test('STT failure preserves bound audio and retry succeeds without duplicating evidence', async (t) => {
  let calls = 0;
  const whisper = {
    transcribe: async (_audioPath, { model }) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('Whisper unavailable.'), {
          code: 'STT_RUNTIME_MISSING', status: 503, retryable: true,
        });
      }
      return { raw_text: 'Bus MAN A95 had a door fault.', language: 'en', segments: [], provider: 'fake-whisper', model };
    },
  };
  const { service, artifactStore, sessionStore } = await fixture(t, 'failure-retry', { whisper });
  const created = await busSession(service, 'RETRY');
  const failed = await service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: pcmWav({ samples: 404 }),
    model: 'base.en', language: 'en', idempotency_key: 'retry-key',
  });

  assert.equal(failed.session.phase, 'RECOVERABLE_ERROR');
  assert.equal(failed.session.recovery_phase, 'PROCESSING');
  assert.equal(failed.failure.code, 'STT_RUNTIME_MISSING');
  assert.equal(failed.next_action, 'RETRY_TRANSCRIPTION');
  assert.equal(failed.transcript, null);
  assert.equal(await artifactStore.hasAudio(failed.audio.audio_id), true);
  assert.equal((await sessionStore.loadChain(created.session.session_id)).transcripts.length, 0);

  const recovered = await service.retryTranscription({
    session_id: created.session.session_id,
    expected_revision: failed.session.revision,
    evidence_id: failed.evidence.evidence_id,
  });
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(recovered.session.phase, 'RESOLVE');
  assert.equal(recovered.evidence.evidence_id, failed.evidence.evidence_id);
  assert.equal(calls, 2);
  assert.equal(chain.evidence.length, 1);
  assert.equal(chain.transcripts.length, 1);

  const duplicate = await service.retryTranscription({
    session_id: created.session.session_id,
    expected_revision: recovered.session.revision,
    evidence_id: failed.evidence.evidence_id,
  });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.session.revision, recovered.session.revision);
  assert.equal(calls, 2);
});

test('malformed audio creates no session mutation or evidence binding', async (t) => {
  const { service, sessionStore } = await fixture(t, 'malformed');
  const created = await busSession(service, 'MALFORMED');

  await assert.rejects(service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: Buffer.from('not a wave file'),
    idempotency_key: 'malformed-key',
  }));
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(chain.session.phase, 'CONTEXT');
  assert.equal(chain.session.revision, 0);
  assert.deepEqual(chain.evidence, []);
  assert.deepEqual(chain.transcripts, []);
});

test('material domain terminology enters CORRECTION_IF_NEEDED without creating structured candidates', async (t) => {
  const { service } = await fixture(t, 'material-review');
  const created = await busSession(service, 'MATERIAL');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus MAN 9-5 had a door fault. Replaced the door control module.',
    language: 'en',
  });

  assert.equal(result.session.phase, 'CORRECTION_IF_NEEDED');
  assert.equal(result.next_action, 'REVIEW_TRANSCRIPT');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.review.status, 'PENDING');
  assert.ok(result.review.items.some((item) => item.proposed_text === 'MAN A95'));
  const item = result.review.items.find((candidate) => candidate.proposed_text === 'MAN A95');
  assert.equal(item.impact_class, 'MATERIAL');
  assert.deepEqual(item.affected_fields, ['asset.bus_model', 'inspection_findings']);
  assert.equal(result.transcript.raw_text.slice(item.source_span.start, item.source_span.end), item.source_span.quote);
});

test('a correction outside mapped report claims does not interrupt the technician', async (t) => {
  const { service } = await fixture(t, 'non-material-review');
  const created = await service.createSession({
    template_id: 'hvac-service-report',
    template_version: '1.0.0',
    job_context_ref: 'job-context:HVAC-NON-MATERIAL',
  });
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: '备注：制冷记。',
    language: 'zh',
  });

  assert.equal(captured.session.phase, 'RESOLVE');
  assert.equal(captured.review, null);
  assert.equal(captured.next_action, 'RESOLVE_REPORT_FIELDS');
  assert.deepEqual(captured.candidates, []);
});

test('fact confirmations use ResolveQueue instead of masquerading as transcript corrections', async (t) => {
  const { service } = await fixture(t, 'fact-confirmation');
  const created = await busSession(service, 'FACT-CONFIRMATION');
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus SG3050Z had a door fault.',
    language: 'en',
  });

  assert.equal(captured.session.phase, 'RESOLVE');
  assert.equal(captured.review, null);
  const resolution = captured.agent_state.resolution_queue.find((item) => item.field_id === 'asset.registration_no');
  assert.equal(resolution.type, 'SAFETY_CONFIRMATION');
  assert.equal(resolution.answer_type, 'CONFIRM_OR_REPLACE');
  const source = captured.candidates.find((candidate) => candidate.field_id === 'asset.registration_no');
  const confirmed = await service.answerResolutionItem({
    session_id: captured.session.session_id,
    expected_revision: captured.session.revision,
    resolution_id: resolution.resolution_id,
    answer: { kind: 'SELECT_CANDIDATE', candidate_id: source.candidate_id },
    idempotency_key: 'confirm-registration-identity',
  });

  assert.equal(confirmed.candidate.support_type, 'TECHNICIAN_CONFIRMATION');
  assert.equal(confirmed.candidate.confirmed_candidate_id, confirmed.source_candidate.candidate_id);
});

test('rejecting a material correction preserves raw text and records immutable server-owned decision history', async (t) => {
  const { service, sessionStore } = await fixture(t, 'reject-review');
  const created = await busSession(service, 'REJECT');
  const rawText = 'Bus MAN 9-5 had a door fault. Replaced the door control module.';
  const pending = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: rawText,
    language: 'en',
  });
  const item = pending.review.items.find((candidate) => candidate.proposed_text === 'MAN A95');
  const decided = await service.decideTranscriptReview({
    session_id: created.session.session_id,
    expected_revision: pending.session.revision,
    review_id: pending.review.review_id,
    decisions: [{ review_item_id: item.review_item_id, decision: 'REJECT' }],
  });
  const chain = await sessionStore.loadChain(created.session.session_id);

  assert.equal(decided.session.phase, 'RESOLVE');
  assert.equal(decided.transcript.raw_text, rawText);
  assert.equal(decided.review.status, 'REVIEWED');
  assert.equal(decided.review.reviewer_principal_ref, 'principal:demo-technician');
  assert.deepEqual(decided.review.decisions, [{ review_item_id: item.review_item_id, decision: 'REJECT' }]);
  assert.equal(chain.transcript_reviews.length, 2);
  assert.equal(chain.transcripts.length, 1);
  assert.equal(chain.transcripts[0].raw_text, rawText);
  assert.equal(decided.candidates.some((candidate) => candidate.field_id === 'asset.bus_model'), false);
  assert.deepEqual(chain.audit_events.map((event) => event.event_type), [
    'SESSION_CREATED',
    'EVIDENCE_CAPTURED',
    'PROCESSING_STARTED',
    'TRANSCRIPT_REVIEW_REQUESTED',
    'TRANSCRIPT_REVIEW_DECIDED',
  ]);
});

test('accepting a material correction preserves raw evidence while candidates retain raw-span provenance', async (t) => {
  const { service, sessionStore } = await fixture(t, 'accept-review');
  const created = await busSession(service, 'ACCEPT');
  const rawText = 'Bus MAN 9-5 had a door fault. Replaced the door control module.';
  const pending = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: rawText,
    language: 'en',
  });
  const item = pending.review.items.find((candidate) => candidate.proposed_text === 'MAN A95');
  const decided = await service.decideTranscriptReview({
    session_id: created.session.session_id,
    expected_revision: pending.session.revision,
    review_id: pending.review.review_id,
    decisions: [{ review_item_id: item.review_item_id, decision: 'ACCEPT' }],
  });
  const model = decided.candidates.find((candidate) => candidate.field_id === 'asset.bus_model');
  const span = await sessionStore.readRecord('evidence-spans', model.evidence_refs[0].span_id);

  assert.equal(decided.transcript.raw_text, rawText);
  assert.equal(decided.review.decisions[0].corrected_text, 'MAN A95');
  assert.equal(model.claim.value, 'MAN A95');
  assert.equal(model.correction_provenance.transcript_review_id, decided.review.review_id);
  assert.equal(model.correction_provenance.raw_text_hash, decided.transcript.text_hash);
  assert.match(model.correction_provenance.effective_projection_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(model.correction_provenance.decisions, [{
    review_item_id: item.review_item_id,
    decision: 'ACCEPT',
  }]);
  assert.equal(rawText.slice(span.start_offset, span.end_offset), 'Bus MAN 9-5 had a door fault');
  assert.equal(span.quote_hash.startsWith('sha256:'), true);
  assert.equal((await sessionStore.loadChain(created.session.session_id)).transcripts[0].raw_text, rawText);
});

test('a corrected component mention cannot become a used part or completed action', async (t) => {
  const { service } = await fixture(t, 'fact-centric-correction');
  const created = await service.createSession({
    template_id: 'rail-maintenance-completion-handover',
    template_version: '1.0.0',
    job_context_ref: 'job-context:RAIL-SEMANTIC-TRAP',
  });
  const rawText = 'Door control module 40 was mentioned during inspection.';
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: rawText,
    language: 'en',
  });
  assert.equal(captured.session.phase, 'RESOLVE');
  assert.equal(captured.review, null);
  assert.equal(captured.transcript.raw_text, rawText);
  assert.equal(captured.candidates.some((candidate) => ['parts.part_number', 'inspection_findings', 'work_performed'].includes(candidate.field_id)), false);
  assert.equal(captured.agent_state.report_fields.find((field) => field.field_id === 'parts.part_number').state, 'UNKNOWN');
});
