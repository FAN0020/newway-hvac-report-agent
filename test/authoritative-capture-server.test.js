import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { resolveServerConfig } from '../src/network-security.js';
import { createServer } from '../src/server.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';
import { createRetriever } from '../src/v2/retrieval.js';
import { loadScopeRegistry } from '../src/v2/scope.js';
import { createUploadStore } from '../src/v2/upload.js';
import { listPredefinedTemplates } from '../web/template-catalog.js';
import { pcmWav } from './helpers.js';

const TOKEN = 'authoritative-capture-token-2026';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function fixture(t, name, { whisper, speechToText, template, semanticProvider, semanticModel } = {}) {
  const root = path.resolve('.tmp-tests', `authoritative-capture-server-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  const registry = await loadScopeRegistry();
  const uploadStore = createUploadStore({ baseDir: path.join(root, 'uploads') });
  const makeService = () => new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore: new ReportSessionStore({ root: path.join(root, 'authority') }),
    whisperProvider: whisper || {
      transcribe: async (_audioPath, { model, language }) => ({
        raw_text: 'Bus MAN A95 had a door fault. Replaced the door control module.',
        language: language === 'auto' ? 'en' : language,
        segments: [{ start_ms: 0, end_ms: 1500, text: 'Bus MAN A95 had a door fault.' }],
        provider: 'fake-whisper', model,
      }),
    },
    modelResolver: speechToText ? () => speechToText.resolveModel() : undefined,
    scopeRegistry: registry,
    uploadStore,
    retriever: createRetriever({ registry, uploadStore }),
    ...(template ? { templateProvider: async (id) => id === template.templateId ? template : null } : {}),
    ...(semanticProvider ? { semanticProvider, semanticModel: semanticModel || 'test-source-model' } : {}),
    clock: () => '2026-09-27T07:00:00.000Z',
  });
  let server;
  let base;
  const start = async () => {
    const port = await freePort();
    const config = resolveServerConfig({
      HVAC_HOST: '127.0.0.1', HVAC_PORT: String(port), HVAC_DEMO_TOKEN: TOKEN,
    });
    server = createServer({ config, services: { authoritativeCapture: makeService(), ...(speechToText ? { speechToText } : {}) } });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${port}`;
  };
  const stop = () => new Promise((resolve) => server?.close(resolve));
  await start();
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const isBuffer = Buffer.isBuffer(body);
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined && !isBuffer ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBuffer ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    request,
    restart: async () => { await stop(); await start(); },
  };
}

test('HTTP speech-to-text settings are server-authoritative and expose lifecycle state', async (t) => {
  let selected = 'base';
  const installed = new Set(['base']);
  const calls = [];
  const state = () => ({
    selected_model: selected,
    default_model: 'base',
    config_recovered: false,
    warning: null,
    models: ['base', 'small', 'medium'].map((id) => ({
      id, display_name: id === 'base' ? 'Base' : id[0].toUpperCase() + id.slice(1),
      description: 'Test model', state: installed.has(id) ? 'installed' : 'not_installed',
      ready: installed.has(id), selected: id === selected,
    })),
  });
  const speechToText = {
    getState: async () => state(),
    resolveModel: async () => selected,
    selectModel: async (id) => { if (!installed.has(id)) throw Object.assign(new Error('not installed'), { code: 'STT_MODEL_NOT_INSTALLED', status: 409 }); selected = id; return state(); },
    installModel: async (id) => { installed.add(id); return state(); },
  };
  const whisper = { transcribe: async (_path, { model }) => {
    calls.push(model);
    return { raw_text: 'Bus MAN A95 had a door fault.', language: 'en', segments: [], provider: 'fake-whisper', model };
  } };
  const { request } = await fixture(t, 'stt-settings', { whisper, speechToText });

  const initial = await request('/api/settings/speech-to-text');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.selected_model, 'base');
  assert.equal(JSON.stringify(initial.body.data).includes('path'), false);
  const unavailable = await request('/api/settings/speech-to-text', { method: 'POST', body: { model: 'medium' } });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.error_code, 'STT_MODEL_NOT_INSTALLED');
  const installedState = await request('/api/speech-to-text/models/medium/install', { method: 'POST', body: {} });
  assert.equal(installedState.status, 200);
  const selectedState = await request('/api/settings/speech-to-text', { method: 'POST', body: { model: 'medium' } });
  assert.equal(selectedState.body.data.selected_model, 'medium');

  const created = await createBusSession(request, 'CONFIGURED-MODEL');
  const captured = await request(`/api/report-sessions/${created.body.data.session.session_id}/capture/audio`, {
    method: 'POST', body: pcmWav({ samples: 213 }),
    headers: {
      'content-type': 'audio/wav', 'x-expected-revision': '0', 'x-stt-model': 'tiny',
      'x-stt-language': 'en', 'idempotency-key': 'configured-http-model',
    },
  });
  assert.equal(captured.status, 201);
  assert.equal(captured.body.data.transcript.model, 'medium');
  assert.deepEqual(calls, ['medium']);
});

async function createBusSession(request, suffix = '1') {
  return request('/api/report-sessions', { method: 'POST', body: {
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0',
    job_context_ref: `job-context:WO-HTTP-${suffix}`,
  } });
}

test('HTTP text capture persists an authoritative template-bound evidence chain', async (t) => {
  const { request } = await fixture(t, 'text');
  const created = await createBusSession(request, 'TEXT');
  assert.equal(created.status, 201);
  const sessionId = created.body.data.session.session_id;
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault. Replaced the door control module.',
    language: 'en',
    idempotency_key: 'http-text-1',
  } });
  assert.equal(captured.status, 201);
  assert.equal(captured.body.data.session.phase, 'RESOLVE');
  assert.equal(captured.body.data.evidence.metadata.report_binding.template_version, '1.0.0');
  assert.ok(captured.body.data.candidates.length > 0);

  const loaded = await request(`/api/report-sessions/${sessionId}`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.data.session.session_id, sessionId);
  assert.equal(loaded.body.data.evidence.length, 1);
  assert.equal(loaded.body.data.transcripts.length, 1);
  assert.ok(loaded.body.data.audit_events.length >= 4);
});

test('HTTP lists persisted ReportSessions so the Reports workspace can recover after refresh', async (t) => {
  const { request, restart } = await fixture(t, 'list-sessions');
  const first = await createBusSession(request, 'LIST-1');
  const second = await createBusSession(request, 'LIST-2');
  await restart();

  const listed = await request('/api/report-sessions');
  assert.equal(listed.status, 200);
  assert.deepEqual(new Set(listed.body.data.sessions.map((session) => session.session_id)), new Set([
    first.body.data.session.session_id,
    second.body.data.session.session_id,
  ]));
  assert.equal(listed.body.data.sessions.every((session) => session.authority === 'SERVER'), true);
  assert.equal(Array.isArray(listed.body.data.history), true);
  assert.equal(listed.body.data.history.length, 2);
  assert.equal(listed.body.data.history.every((report) => report.template.display_name === 'Bus Defect Rectification / Corrective Maintenance'), true);
  assert.equal(listed.body.data.history.every((report) => report.status.label === 'Not started'), true);
});

test('HTTP workspace lifecycle keeps attachments non-authoritative and rejects premature review', async (t) => {
  const { request } = await fixture(t, 'workspace-lifecycle');
  const created = await createBusSession(request, 'WORKSPACE');
  const sessionId = created.body.data.session.session_id;
  const attached = await request(`/api/report-sessions/${sessionId}/attachments`, {
    method: 'POST', body: Buffer.from('after-work image bytes'), headers: {
      'content-type': 'image/jpeg', 'x-file-name': 'after-work.jpg',
      'x-attachment-purpose': 'AFTER_WORK_PHOTO', 'x-expected-revision': '0',
    },
  });
  assert.equal(attached.status, 201);
  assert.equal(attached.body.data.evidence.evidence_type, 'DOCUMENT');
  assert.equal(attached.body.data.evidence.metadata.purpose, 'AFTER_WORK_PHOTO');

  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: attached.body.data.session.revision,
    text: 'Bus MAN A95 had a door fault.',
  } });
  const review = await request(`/api/report-sessions/${sessionId}/review`, { method: 'POST', body: {
    expected_revision: captured.body.data.session.revision,
  } });
  assert.equal(review.status, 409);
  assert.equal(review.body.error_code, 'REPORT_NOT_COMPLETE');

  const chain = await request(`/api/report-sessions/${sessionId}`);
  assert.equal(chain.body.data.evidence.some((entry) => entry.evidence_id === attached.body.data.evidence.evidence_id), true);
  assert.equal(chain.body.data.field_candidates.some((entry) => entry.source_ref === attached.body.data.evidence.evidence_id), false);
});

test('HTTP exposes authoritative Agent state and accepts only server-owned structured resolutions', async (t) => {
  const { request } = await fixture(t, 'agent-resolution');
  const created = await createBusSession(request, 'AGENT');
  const sessionId = created.body.data.session.session_id;
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: created.body.data.session.revision,
    text: 'Bus MAN A95 had a door fault.',
  } });
  const state = await request(`/api/report-sessions/${sessionId}/agent-state`);
  assert.equal(state.status, 200);
  const item = state.body.data.agent_state.resolution_queue.find((entry) => entry.field_id === 'diagnosis.root_cause');
  assert.ok(item);

  const forged = await request(`/api/report-sessions/${sessionId}/resolution-items/${item.resolution_id}/answer`, { method: 'POST', body: {
    expected_revision: captured.body.data.session.revision,
    idempotency_key: 'http-answer-forged',
    answer: { kind: 'SEMANTIC_STATE', state: 'NOT_ESTABLISHED' },
    support_type: 'TECHNICIAN_CONFIRMATION',
  } });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error_code, 'UNTRUSTED_CAPTURE_INPUT');

  const answered = await request(`/api/report-sessions/${sessionId}/resolution-items/${item.resolution_id}/answer`, { method: 'POST', body: {
    expected_revision: captured.body.data.session.revision,
    idempotency_key: 'http-answer-root-cause',
    answer: { kind: 'SEMANTIC_STATE', state: 'NOT_ESTABLISHED' },
  } });
  assert.equal(answered.status, 201);
  assert.equal(answered.body.data.candidate.support_type, 'TECHNICIAN_CONFIRMATION');
  assert.equal(answered.body.data.agent_state.resolution_queue.some((entry) => entry.resolution_id === item.resolution_id), false);
});

test('HTTP field selection is server-owned, reversible, and stale-write protected', async (t) => {
  const { request } = await fixture(t, 'field-selection');
  const created = await createBusSession(request, 'FIELD-SELECTION');
  const sessionId = created.body.data.session.session_id;
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: created.body.data.session.revision,
    text: 'Passenger door would not close.',
  } });
  const field = captured.body.data.agent_state.report_fields.find((entry) => entry.candidates.some((candidate) => candidate.claim?.kind === 'VALUE'));
  const fieldId = field.field_id;
  const candidate = field.candidates.find((entry) => entry.claim?.kind === 'VALUE');
  assert.ok(candidate);

  const selected = await request(`/api/report-sessions/${sessionId}/fields/${fieldId}/select`, { method: 'POST', body: {
    expected_revision: captured.body.data.session.revision,
    idempotency_key: 'http-field-select-draft',
    selection: { kind: 'CANDIDATE', candidate_id: candidate.candidate_id },
  } });
  assert.equal(selected.status, 201);
  assert.equal(selected.body.data.candidate.support_type, 'TECHNICIAN_CONFIRMATION');
  assert.equal(selected.body.data.agent_state.report_fields.find((entry) => entry.field_id === fieldId).value, candidate.claim.value);

  const forged = await request(`/api/report-sessions/${sessionId}/fields/${fieldId}/select`, { method: 'POST', body: {
    expected_revision: selected.body.data.session.revision,
    idempotency_key: 'http-field-select-forged',
    selection: { kind: 'CANDIDATE', candidate_id: candidate.candidate_id },
    support_type: 'TECHNICIAN_CONFIRMATION',
  } });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error_code, 'UNTRUSTED_CAPTURE_INPUT');

  const stale = await request(`/api/report-sessions/${sessionId}/fields/${fieldId}/select`, { method: 'POST', body: {
    expected_revision: captured.body.data.session.revision,
    idempotency_key: 'http-field-select-stale',
    selection: { kind: 'MANUAL', value: 'SBS6027Z' },
  } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error_code, 'STALE_REVISION');
});

test('authoritative template build never renders a planned action blocked by Agent validation', async (t) => {
  const { request } = await fixture(t, 'blocked-render');
  const created = await createBusSession(request, 'BLOCKED');
  const sessionId = created.body.data.session.session_id;
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: created.body.data.session.revision,
    text: 'Bus MAN A95 had a door fault.',
  } });
  const answered = await request(`/api/report-sessions/${sessionId}/fields/work_performed/answer`, { method: 'POST', body: {
    expected_revision: captured.body.data.session.revision,
    value: 'Will replace the door control module tomorrow.',
  } });
  assert.equal(answered.body.data.agent_state.validation_issues.some((issue) => issue.code === 'PLANNED_ACTION_NOT_COMPLETED'), true);

  const built = await request('/api/template-reports/build', { method: 'POST', body: {
    template_id: 'bus-defect-rectification-corrective-maintenance',
    report_session_id: sessionId,
  } });
  const rendered = built.body.data.draft.sections.flatMap((section) => section.content).find((field) => field.field === 'work_performed');
  assert.equal(rendered.value, null);
  assert.equal(rendered.status, 'MISSING');
});

test('20-field report immediately asks for exactly two missing technician details after six extracted facts, then records answers', async (t) => {
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];
  const base = listPredefinedTemplates().find((item) => item.domain === 'SBS_BUS');
  const template = {
    ...base, templateId: 'batch-three-twenty-field-acceptance', templateVersion: '1.0.0', name: 'Twenty field acceptance',
    schema: { ...base.schema, id: 'batch_three_twenty_fields', version: '1.0.0', fields: names.map((name, index) => ({
      id: `detail.${name}`, label: `${name[0].toUpperCase()}${name.slice(1)} detail`, section: 'Inspection',
      displayOrder: index + 1, type: 'string', required: index < 8,
      allowedSources: index < 8 ? ['TECHNICIAN'] : ['TECHNICIAN', 'WORK_ORDER', 'KNOWLEDGE'],
      critical: false, requiresTechnicianConfirmation: false,
    })) },
  };
  const { request } = await fixture(t, 'twenty-eight-six-two', { template });
  const created = await request('/api/report-sessions', { method: 'POST', body: {
    template_id: template.templateId, template_version: template.templateVersion,
    job_context_ref: 'new-report:batch-three-acceptance',
  } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.agent_state.report_fields.length, 20);
  assert.equal(created.body.data.agent_state.completeness.missing_required_fields.length, 8);
  const sessionId = created.body.data.session.session_id;
  const sourcePlan = await request(`/api/report-sessions/${sessionId}/source-plan`);
  assert.equal(sourcePlan.status, 200);
  assert.equal(sourcePlan.body.data.fields.length, 20);
  assert.equal(sourcePlan.body.data.session_revision, created.body.data.session.revision);
  assert.deepEqual(sourcePlan.body.data.fields.filter((field) => field.required).map((field) => field.suggested_source), Array(8).fill('TECHNICIAN'));
  assert.equal(sourcePlan.body.data.model.status, 'NO_SOURCE_CHOICE');
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: created.body.data.session.revision,
    text: 'Alpha: steady. Bravo: inspected. Charlie: clear. Delta: dry. Echo: intact. Foxtrot: clean.',
    language: 'en', idempotency_key: 'twenty-eight-six-two-capture',
  } });
  assert.equal(captured.status, 201);
  assert.equal(captured.body.data.session.phase, 'RESOLVE');
  const afterCapture = await request(`/api/report-sessions/${sessionId}`);
  const refreshedPlan = await request(`/api/report-sessions/${sessionId}/source-plan`);
  assert.equal(refreshedPlan.body.data.session_revision, afterCapture.body.data.session.revision);
  const firstState = afterCapture.body.data.agent_state;
  assert.deepEqual(firstState.completeness.missing_required_fields.sort(), ['detail.golf', 'detail.hotel']);
  assert.equal(firstState.report_fields.filter((field) => field.state === 'KNOWN_VALUE' && names.slice(0, 8).some((name) => field.field_id === `detail.${name}`)).length, 6);
  assert.deepEqual(firstState.resolution_queue.filter((item) => item.type === 'MISSING').map((item) => item.field_id).sort(), ['detail.golf', 'detail.hotel']);
  assert.ok(afterCapture.body.data.transcripts[0].raw_text.includes('Alpha: steady'));
  let revision = afterCapture.body.data.session.revision;
  for (const [fieldId, value] of [['detail.golf', 'checked'], ['detail.hotel', 'stable']]) {
    const answered = await request(`/api/report-sessions/${sessionId}/fields/${fieldId}/answer`, { method: 'POST', body: {
      expected_revision: revision, value,
    } });
    assert.equal(answered.status, 201);
    revision = answered.body.data.session.revision;
  }
  const finalChain = (await request(`/api/report-sessions/${sessionId}`)).body.data;
  const finalPlan = await request(`/api/report-sessions/${sessionId}/source-plan`);
  assert.equal(finalPlan.body.data.session_revision, finalChain.session.revision);
  assert.deepEqual(finalChain.agent_state.completeness.missing_required_fields, []);
  assert.equal(finalChain.agent_state.completeness.complete, true);
  assert.equal(finalChain.transcripts[0].raw_text, afterCapture.body.data.transcripts[0].raw_text);
  assert.equal(finalChain.evidence.filter((item) => item.metadata?.input_kind === 'TECHNICIAN_FIELD_ANSWER').length, 2);
});

test('HTTP source plan accepts a model knowledge suggestion only for a manager-classified reference field', async (t) => {
  const base = listPredefinedTemplates().find((item) => item.domain === 'SBS_BUS');
  const template = { ...base, templateId: 'source-plan-http-acceptance', templateVersion: '1.0.0',
    schema: { ...base.schema, id: 'source_plan_http', version: '1.0.0', fields: [
      { id: 'work.action', label: 'Completed action', section: 'Job', type: 'string', required: true,
        fieldRole: 'JOB_FACT', allowedSources: ['TECHNICIAN', 'KNOWLEDGE'] },
      { id: 'standard.reference', label: 'Maintenance standard', section: 'Reference', type: 'string', required: false,
        fieldRole: 'NORMATIVE_REFERENCE', allowedSources: ['TECHNICIAN', 'KNOWLEDGE'] },
    ] } };
  const provider = { generateJson: async () => ({ provider: 'ollama-test', model: 'test-source-model', data: { fields: [
    { field_id: 'work.action', source: 'KNOWLEDGE' },
    { field_id: 'standard.reference', source: 'KNOWLEDGE' },
  ] } }) };
  const { request } = await fixture(t, 'source-plan-http', { template, semanticProvider: provider });
  const created = await request('/api/report-sessions', { method: 'POST', body: {
    template_id: template.templateId, template_version: template.templateVersion, job_context_ref: 'new-report:source-plan-http',
  } });
  assert.equal(created.status, 201);
  const result = await request(`/api/report-sessions/${created.body.data.session.session_id}/source-plan`);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.fields[0].suggested_source, 'TECHNICIAN');
  assert.equal(result.body.data.fields[0].basis, 'RULE_FALLBACK');
  assert.equal(result.body.data.fields[1].suggested_source, 'KNOWLEDGE');
  assert.equal(result.body.data.fields[1].basis, 'MODEL_SUGGESTION');
  assert.equal(result.body.data.model.status, 'MODEL_SUGGESTED');
  assert.equal(created.body.data.agent_state.report_fields.every((field) => field.state === 'UNKNOWN'), true);
});

test('HTTP guidance upload derives scope from ReportSession and exposes only minimal on-demand guidance', async (t) => {
  const { request } = await fixture(t, 'guidance');
  const created = await createBusSession(request, 'GUIDANCE');
  const sessionId = created.body.data.session.session_id;

  const forged = await request(`/api/report-sessions/${sessionId}/guidance/uploads`, {
    method: 'POST',
    body: Buffer.from('Rail-only instructions must not enter this bus session.', 'utf8'),
    headers: {
      'content-type': 'text/plain',
      'x-file-name': 'forged.txt',
      'x-expected-revision': '0',
      'x-scope-id': 'SBS_RAIL',
    },
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error_code, 'UNTRUSTED_GUIDANCE_UPLOAD_INPUT');

  const uploaded = await request(`/api/report-sessions/${sessionId}/guidance/uploads`, {
    method: 'POST',
    body: Buffer.from('Door control module ZX-47 connector inspection procedure.', 'utf8'),
    headers: {
      'content-type': 'text/plain',
      'x-file-name': 'bus-door-sop.txt',
      'x-expected-revision': '0',
    },
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.data.upload.scope_id, 'SBS_BUS');
  assert.equal(uploaded.body.data.upload.provenance.report_session_id, sessionId);

  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: uploaded.body.data.session.revision,
    text: 'Bus MAN A95 had a ZX-47 door control module fault.',
    language: 'en',
  } });
  assert.equal(captured.status, 201);
  assert.ok(captured.body.data.guidance_context.passages.some((item) => item.source_type === 'upload'));

  const viewed = await request(`/api/report-sessions/${sessionId}/guidance`);
  assert.equal(viewed.status, 200);
  assert.ok(viewed.body.data.guidance.length >= 1);
  assert.ok(viewed.body.data.guidance[0].follow_up_questions.length >= 1);
  assert.equal(Object.hasOwn(viewed.body.data.guidance[0].passages[0], 'score'), false);
  assert.equal(Object.hasOwn(viewed.body.data.guidance[0].passages[0], 'chunk_id'), false);
  assert.equal(Object.hasOwn(viewed.body.data.guidance[0].passages[0], 'provenance'), false);
});

test('HTTP audio capture exposes timestamped transcript provenance and source-bound idempotency', async (t) => {
  let calls = 0;
  const { request } = await fixture(t, 'audio', { whisper: {
    transcribe: async (_audioPath, { model }) => {
      calls += 1;
      return {
        raw_text: 'Bus MAN A95 had a door fault.', language: 'en', provider: 'fake-whisper', model,
        segments: [{ start_ms: 10, end_ms: 810, text: 'Bus MAN A95 had a door fault.' }],
      };
    },
  } });
  const created = await createBusSession(request, 'AUDIO');
  const sessionId = created.body.data.session.session_id;
  const wav = pcmWav({ samples: 511 });
  const first = await request(`/api/report-sessions/${sessionId}/capture/audio`, {
    method: 'POST', body: wav,
    headers: {
      'content-type': 'audio/wav', 'x-expected-revision': '0', 'x-stt-model': 'base.en',
      'x-stt-language': 'en', 'idempotency-key': 'http-audio-key',
    },
  });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.data.transcript.segments, [
    { start_ms: 10, end_ms: 810, text: 'Bus MAN A95 had a door fault.' },
  ]);
  const second = await request(`/api/report-sessions/${sessionId}/capture/audio`, {
    method: 'POST', body: wav,
    headers: {
      'content-type': 'audio/wav',
      'x-expected-revision': String(first.body.data.session.revision),
      'x-stt-model': 'base.en', 'x-stt-language': 'en', 'idempotency-key': 'http-audio-key',
    },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.reused, true);
  assert.equal(calls, 1);
  const chain = await request(`/api/report-sessions/${sessionId}`);
  assert.equal(chain.body.data.evidence.length, 1);
  assert.equal(chain.body.data.transcripts.length, 1);
});

test('HTTP field dictation preserves target context without forcing an incompatible assignment', async (t) => {
  const { request } = await fixture(t, 'field-dictation', { whisper: {
    transcribe: async (_audioPath, { model }) => ({
      raw_text: 'We replaced the door control module.', language: 'en', provider: 'fake-whisper', model, segments: [],
    }),
  } });
  const created = await createBusSession(request, 'FIELD-DICTATION');
  const sessionId = created.body.data.session.session_id;
  const captured = await request(`/api/report-sessions/${sessionId}/capture/audio`, {
    method: 'POST', body: pcmWav({ samples: 511 }),
    headers: {
      'content-type': 'audio/wav', 'x-expected-revision': '0', 'x-stt-language': 'en',
      'idempotency-key': 'http-field-dictation', 'x-target-field-id': 'test.result',
      'x-target-section-id': 'Completion and handover', 'x-capture-mode': 'FIELD_DICTATION',
    },
  });

  const context = { target_field_id: 'test.result', target_section_id: 'Completion and handover', capture_mode: 'FIELD_DICTATION' };
  assert.equal(captured.status, 201);
  assert.deepEqual(captured.body.data.evidence.metadata.capture_context, context);
  assert.deepEqual(captured.body.data.transcript.capture_context, context);
  assert.equal(captured.body.data.candidates.some((candidate) => candidate.field_id === 'test.result'), false);
  assert.equal(captured.body.data.candidates.some((candidate) => candidate.field_id === 'work_performed'), true);
});

test('HTTP STT failure preserves audio and an explicit retry completes the same evidence chain', async (t) => {
  let calls = 0;
  const { request } = await fixture(t, 'failure-retry', { whisper: {
    transcribe: async (_audioPath, { model }) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Provider unavailable.'), { code: 'STT_RUNTIME_MISSING', status: 503, retryable: true });
      return { raw_text: 'Bus MAN A95 had a door fault.', language: 'en', segments: [], provider: 'fake-whisper', model };
    },
  } });
  const created = await createBusSession(request, 'FAILURE');
  const sessionId = created.body.data.session.session_id;
  const failed = await request(`/api/report-sessions/${sessionId}/capture/audio`, {
    method: 'POST', body: pcmWav({ samples: 512 }),
    headers: {
      'content-type': 'audio/wav', 'x-expected-revision': '0',
      'x-stt-model': 'base.en', 'x-stt-language': 'en', 'idempotency-key': 'http-retry-key',
    },
  });
  assert.equal(failed.status, 202);
  assert.equal(failed.body.status, 'RETRYABLE_ERROR');
  assert.equal(failed.body.data.session.phase, 'RECOVERABLE_ERROR');
  assert.equal(failed.body.data.next_action, 'RETRY_TRANSCRIPTION');
  assert.equal(failed.body.data.transcript, null);

  const retried = await request(`/api/report-sessions/${sessionId}/transcription/retry`, { method: 'POST', body: {
    expected_revision: failed.body.data.session.revision,
    evidence_id: failed.body.data.evidence.evidence_id,
  } });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.data.session.phase, 'RESOLVE');
  assert.equal(retried.body.data.evidence.evidence_id, failed.body.data.evidence.evidence_id);
  const chain = await request(`/api/report-sessions/${sessionId}`);
  assert.equal(chain.body.data.evidence.length, 1);
  assert.equal(chain.body.data.transcripts.length, 1);
});

test('HTTP rejects different audio under one idempotency key and malformed audio leaves CONTEXT unchanged', async (t) => {
  const { request } = await fixture(t, 'adversarial-audio');
  const created = await createBusSession(request, 'ADVERSARIAL');
  const sessionId = created.body.data.session.session_id;
  const first = await request(`/api/report-sessions/${sessionId}/capture/audio`, {
    method: 'POST', body: pcmWav({ samples: 513 }),
    headers: {
      'content-type': 'audio/wav', 'x-expected-revision': '0',
      'x-stt-model': 'base.en', 'x-stt-language': 'en', 'idempotency-key': 'one-key',
    },
  });
  const collision = await request(`/api/report-sessions/${sessionId}/capture/audio`, {
    method: 'POST', body: pcmWav({ samples: 514 }),
    headers: {
      'content-type': 'audio/wav', 'x-expected-revision': String(first.body.data.session.revision),
      'x-stt-model': 'base.en', 'x-stt-language': 'en', 'idempotency-key': 'one-key',
    },
  });
  assert.equal(collision.status, 409);
  assert.equal(collision.body.error_code, 'IDEMPOTENCY_KEY_REUSE');

  const other = await createBusSession(request, 'MALFORMED');
  const otherId = other.body.data.session.session_id;
  const malformed = await request(`/api/report-sessions/${otherId}/capture/audio`, {
    method: 'POST', body: Buffer.from('malformed'),
    headers: { 'content-type': 'audio/wav', 'x-expected-revision': '0' },
  });
  assert.equal(malformed.status, 400);
  const unchanged = await request(`/api/report-sessions/${otherId}`);
  assert.equal(unchanged.body.data.session.phase, 'CONTEXT');
  assert.equal(unchanged.body.data.session.revision, 0);
  assert.deepEqual(unchanged.body.data.evidence, []);
});

test('HTTP rejects stale revisions and exact template-version mismatches', async (t) => {
  const { request } = await fixture(t, 'revision-template');
  const mismatch = await request('/api/report-sessions', { method: 'POST', body: {
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '9.9.9',
    job_context_ref: 'job-context:WO-MISMATCH',
  } });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error_code, 'TEMPLATE_VERSION_MISMATCH');

  const created = await createBusSession(request, 'STALE');
  const sessionId = created.body.data.session.session_id;
  const stale = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: 1,
    text: 'Bus MAN A95 had a door fault.',
  } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error_code, 'STALE_REVISION');
});

test('HTTP rejects fabricated evidence, provenance, FieldState, and technician-confirmation authority', async (t) => {
  const { request } = await fixture(t, 'untrusted');
  const created = await createBusSession(request, 'UNTRUSTED');
  const sessionId = created.body.data.session.session_id;
  for (const forged of [
    { evidence_id: 'evidence_forged' },
    { provenance: { source: 'forged' } },
    { field_state: 'KNOWN_VALUE' },
    { support_status: 'CONFIRMED_BY_TECHNICIAN' },
    { confirmation_receipt: 'receipt_forged' },
    { knowledge_hits: [{ chunk_id: 'knowledge:SBS_BUS:forged' }] },
    { guidance_context_ids: ['guidance_forged'] },
    { facts: [{ field: 'work_performed', value: 'forged' }] },
    { scope_id: 'SBS_RAIL' },
    { context_id: 'SBS/RAIL' },
  ]) {
    const response = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
      expected_revision: 0,
      text: 'Bus MAN A95 had a door fault.',
      ...forged,
    } });
    assert.equal(response.status, 400);
    assert.equal(response.body.error_code, 'UNTRUSTED_CAPTURE_INPUT');
  }
  const retry = await request(`/api/report-sessions/${sessionId}/transcription/retry`, { method: 'POST', body: {
    expected_revision: 0,
    evidence_id: 'evidence_forged',
  } });
  assert.equal(retry.status, 404);
  assert.equal(retry.body.error_code, 'CAPTURE_EVIDENCE_NOT_FOUND');
});

test('authoritative report drafting rejects browser facts and derives facts from the persisted session chain', async (t) => {
  const { request } = await fixture(t, 'server-owned-report-facts');
  const created = await createBusSession(request, 'REPORT');
  const sessionId = created.body.data.session.session_id;
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault. Replaced the door control module.',
    language: 'en',
  } });
  assert.equal(captured.status, 201);

  const forged = await request('/api/template-reports/build', { method: 'POST', body: {
    template_id: 'bus-defect-rectification-corrective-maintenance',
    report_session_id: sessionId,
    facts: [{ field: 'work_performed', value: 'Forged knowledge replacement.', source: 'knowledge:SBS_RAIL' }],
  } });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error_code, 'UNTRUSTED_REPORT_FACTS');

  const built = await request('/api/template-reports/build', { method: 'POST', body: {
    template_id: 'bus-defect-rectification-corrective-maintenance',
    report_session_id: sessionId,
  } });
  assert.equal(built.status, 200);
  const serialized = JSON.stringify(built.body.data);
  assert.match(serialized, /door control module/iu);
  assert.doesNotMatch(serialized, /Forged knowledge replacement/iu);
});

test('HTTP field answers and confirmations create server-owned evidence and audit events', async (t) => {
  const { request } = await fixture(t, 'field-answer-confirmation');
  const created = await createBusSession(request, 'FIELD-ANSWER');
  const sessionId = created.body.data.session.session_id;
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault.',
    language: 'en',
  } });
  assert.equal(captured.status, 201);

  const answered = await request(`/api/report-sessions/${sessionId}/fields/completion.state/answer`, {
    method: 'POST',
    body: {
      expected_revision: captured.body.data.session.revision,
      value: 'NOT_READY',
    },
  });
  assert.equal(answered.status, 201);
  assert.equal(answered.body.data.candidate.support_type, 'MANUAL_TECHNICIAN_INPUT');
  assert.equal(answered.body.data.evidence.evidence_type, 'MANUAL_INPUT');
  assert.equal(answered.body.data.candidate.evidence_refs[0].evidence_id, answered.body.data.evidence.evidence_id);

  const candidateId = answered.body.data.candidate.candidate_id;
  const confirmed = await request(`/api/report-sessions/${sessionId}/candidates/${candidateId}/confirm`, {
    method: 'POST',
    body: { expected_revision: answered.body.data.session.revision },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.candidate.support_type, 'TECHNICIAN_CONFIRMATION');
  assert.equal(confirmed.body.data.candidate.confirmed_candidate_id, candidateId);
  assert.equal(confirmed.body.data.event.event_type, 'TECHNICIAN_CONFIRMATION');

  const chain = await request(`/api/report-sessions/${sessionId}`);
  assert.ok(chain.body.data.evidence.some((item) => item.evidence_id === answered.body.data.evidence.evidence_id));
  assert.ok(chain.body.data.field_candidates.some((item) => item.candidate_id === confirmed.body.data.candidate.candidate_id));
  assert.ok(chain.body.data.audit_events.some((item) => item.event_type === 'TECHNICIAN_CONFIRMATION'));
});

test('HTTP rejects a transcript review rebound to another ReportSession', async (t) => {
  const { request } = await fixture(t, 'review-rebind');
  const first = await createBusSession(request, 'REVIEW-A');
  const second = await createBusSession(request, 'REVIEW-B');
  const firstId = first.body.data.session.session_id;
  const secondId = second.body.data.session.session_id;
  const pending = await request(`/api/report-sessions/${firstId}/capture/text`, { method: 'POST', body: {
    expected_revision: 0,
    text: 'Bus MAN 9-5 had a door fault.',
  } });
  const review = pending.body.data.review;
  const rebound = await request(`/api/report-sessions/${secondId}/transcript-reviews/${review.review_id}/decide`, {
    method: 'POST', body: {
      expected_revision: 0,
      decisions: review.items.map((item) => ({ review_item_id: item.review_item_id, decision: 'REJECT' })),
    },
  });
  assert.equal(rebound.status, 409);
  assert.equal(rebound.body.error_code, 'TRANSCRIPT_REVIEW_BINDING_MISMATCH');
});

test('HTTP restart reloads the exact authoritative session and evidence chain', async (t) => {
  const { request, restart } = await fixture(t, 'restart');
  const created = await createBusSession(request, 'RESTART');
  const sessionId = created.body.data.session.session_id;
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, { method: 'POST', body: {
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault.',
  } });
  const expectedRevision = captured.body.data.session.revision;
  const expectedTranscript = captured.body.data.transcript.transcript_id;

  await restart();
  const loaded = await request(`/api/report-sessions/${sessionId}`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.data.session.revision, expectedRevision);
  assert.equal(loaded.body.data.transcripts[0].transcript_id, expectedTranscript);
  assert.equal(loaded.body.data.field_candidates.length, captured.body.data.candidates.length);
});
