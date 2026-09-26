import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { resolveServerConfig } from '../src/network-security.js';
import { createServer } from '../src/server.js';

// Real HTTP server integration tests for the /api/v2/* routes. The server is
// started on an ephemeral (random) port to avoid collisions with any other
// process, and every request carries the same Authorization: Bearer token the
// V1 routes require (authorizeApiRequest gate in src/server.js).
const TEST_TOKEN = 'v2-demo-token-2026-abc123';
const uploadsDir = path.resolve('data', 'v2-uploads');

let server;
let base;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Removes leftover test uploads while preserving the .gitkeep placeholder. */
async function cleanUploads() {
  await fs.mkdir(uploadsDir, { recursive: true });
  const entries = await fs.readdir(uploadsDir);
  for (const name of entries) {
    if (name === '.gitkeep') continue;
    await fs.rm(path.join(uploadsDir, name), { recursive: true, force: true });
  }
}

before(async () => {
  await cleanUploads();
  const port = await findFreePort();
  const config = resolveServerConfig({ HVAC_HOST: '127.0.0.1', HVAC_PORT: String(port), HVAC_DEMO_TOKEN: TEST_TOKEN });
  server = createServer({ config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await cleanUploads();
});

function api(pathname, { method = 'GET', token = TEST_TOKEN, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  const isBuffer = Buffer.isBuffer(body);
  if (body !== undefined && !isBuffer) requestHeaders['content-type'] = 'application/json';
  return fetch(`${base}${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : (isBuffer ? body : JSON.stringify(body)),
  });
}

async function json(responsePromise) {
  const response = await responsePromise;
  return { status: response.status, body: await response.json() };
}

test('browser modules are served as JavaScript', async () => {
  for (const pathname of ['/i18n.js', '/locales/en.js', '/locales/zh-CN.js', '/locales/overrides.js', '/template-catalog.js', '/template-selection.js']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('content-type') || '', /^text\/javascript/);
    assert.ok((await response.text()).length > 100, pathname);
  }
});

test('GET /api/templates exposes exact predefined immutable bindings', async () => {
  const { status, body } = await json(api('/api/templates'));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  const door = body.data.templates.find((item) => item.templateId === 'bus-passenger-door-safety-equipment-inspection');
  assert.equal(door.name, 'Bus Passenger Door / Safety Equipment Inspection');
  assert.equal(door.provenance.classification, 'research-derived prototype');
  assert.equal(door.provenance.official, false);
  assert.ok(door.schema.id && door.contextCorpus.id && door.rendererMapping.id);
});

test('template context endpoint rejects a corpus from another template', async () => {
  const valid = await json(api('/api/template-context/retrieve', { method: 'POST', body: {
    template_id: 'conductor-third-rail-preventive-inspection',
    context_corpus_id: 'conductor-third-rail-preventive-inspection-context',
    context_version: '1.0.0',
    query: 'third rail maintenance',
  } }));
  assert.equal(valid.status, 200);
  assert.equal(valid.body.data.contextCorpusId, 'conductor-third-rail-preventive-inspection-context');
  assert.equal(valid.body.data.mayAssertJobFacts, false);

  const mismatch = await json(api('/api/template-context/retrieve', { method: 'POST', body: {
    template_id: 'conductor-third-rail-preventive-inspection',
    context_corpus_id: 'plain-rail-preventive-inspection-context',
    query: 'rail',
  } }));
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.status, 'FAIL');
});

test('every predefined template passes required-field validation while legacy client confirmation is disabled', async (t) => {
  const listed = await json(api('/api/templates'));
  for (const template of listed.body.data.templates.filter((item) => item.sourceArtifact?.kind === 'research-pack-prototype')) {
    const facts = template.schema.fields.filter((field) => field.required).map((field) => ({
      field: field.id,
      value: field.type === 'number' ? 1 : field.type === 'structured' ? { value: 'Observed' }
        : field.type === 'status' ? ((field.allowedStatuses || field.allowedValues).find((value) => value !== 'NOT_CHECKED') || 'N/A') : 'Observed by technician',
      support_status: 'CONFIRMED_BY_TECHNICIAN',
      source_refs: [`resolve:${field.id}`],
    }));
    const built = await json(api('/api/template-reports/build', { method: 'POST', body: {
      template_id: template.templateId,
      report_session_id: `contract-${template.templateId}`,
      facts,
    } }));
    assert.equal(built.status, 200, template.templateId);
    assert.equal(built.body.status, 'PASS', template.templateId);
    assert.equal(built.body.data.draft.template_id, template.templateId);
    assert.equal(built.body.data.draft.template_version, template.templateVersion);
    assert.equal(built.body.data.draft.schema_id, template.schema.id);
    assert.equal(built.body.data.draft.context_corpus_id, template.contextCorpus.id);

    const confirmed = await json(api('/api/v2/reports/confirm', { method: 'POST', body: {
      draft: built.body.data.draft,
      validator_run_id: built.body.data.validation_receipt.validator_run_id,
      technician_id: 'TECH-TEMPLATE', technician_name: 'Template Technician',
    } }));
    assert.equal(confirmed.status, 410, template.templateId);
    assert.equal(confirmed.body.error_code, 'LEGACY_AUTHORITY_DISABLED', template.templateId);
    t.after(() => fs.rm(path.join('data', 'validations', `${built.body.data.validation_receipt.validator_run_id}.json`), { force: true }));
  }
});

test('browser shell icon is served without a console-visible 404', async () => {
  const response = await fetch(`${base}/favicon.svg`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^image\/svg\+xml/);
});

test('AudioWorklet module is available from the real app origin with executable JavaScript MIME', async () => {
  const response = await fetch(`${base}/pcm-capture-worklet.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/javascript/);
  const source = await response.text();
  assert.match(source, /registerProcessor\(['"]hvac-pcm-capture['"]/);
});

test('GET /api/v2/scopes lists transport and industrial scopes with HVAC upload disabled', async () => {
  const { status, body } = await json(api('/api/v2/scopes'));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  const ids = body.data.scopes.map((item) => item.scope_id).sort();
  assert.deepEqual(ids, ['HVAC', 'OILFIELD', 'POWER_GRID', 'SBS_BUS', 'SBS_RAIL']);
  const hvac = body.data.scopes.find((item) => item.scope_id === 'HVAC');
  assert.equal(hvac.upload_allowed, false);
  assert.equal(hvac.display, 'HVAC');
  const bus = body.data.scopes.find((item) => item.scope_id === 'SBS_BUS');
  assert.equal(bus.upload_allowed, true);
  assert.deepEqual(body.data.contexts, { 'SBS/BUS': 'SBS_BUS', 'SBS/RAIL': 'SBS_RAIL', HVAC: 'HVAC', OILFIELD: 'OILFIELD', 'POWER/GRID': 'POWER_GRID' });
});

test('POST /api/v2/uploads ingests a txt into SBS_BUS as READY', async () => {
  const content = 'Seletar depot bus 3050. 制动片磨损检查完成。\n';
  const { status, body } = await json(api('/api/v2/uploads', {
    method: 'POST',
    body: Buffer.from(content, 'utf8'),
    headers: {
      'x-file-name': 'bus-brake-note.txt',
      'x-scope-id': 'SBS_BUS',
      'x-uploader': 'e2e-technician',
      'x-scenario': 'v2-server-test',
    },
  }));
  assert.equal(status, 201);
  assert.equal(body.status, 'PASS');
  assert.equal(body.data.upload.status, 'READY');
  assert.equal(body.data.upload.scope_id, 'SBS_BUS');
  assert.equal(body.data.upload.filename, 'bus-brake-note.txt');
  assert.equal(body.data.upload.provenance.uploader, 'e2e-technician');
  assert.equal(body.data.upload.provenance.source, 'user-upload');
  assert.equal(body.data.upload.provenance.scenario, 'v2-server-test');
  assert.match(body.data.upload.sha256, /^[a-f0-9]{64}$/);
  assert.ok(body.data.upload.indexed.token_count > 0);
});

test('Capture upload response binds the supporting document to the initiating ReportSession and scope', async () => {
  const { status, body } = await json(api('/api/v2/uploads', {
    method: 'POST',
    body: Buffer.from('Bus report supporting note.', 'utf8'),
    headers: {
      'x-file-name': 'bus-session-note.txt',
      'x-scope-id': 'SBS_BUS',
      'x-report-session-id': 'report_session_bus_42',
      'x-scenario': 'report-capture',
    },
  }));
  assert.equal(status, 201);
  assert.deepEqual(body.data.report_binding, {
    report_session_id: 'report_session_bus_42',
    scope_id: 'SBS_BUS',
    upload_id: body.data.upload.upload_id,
  });
});

test('POST /api/v2/uploads records an unsupported .dwg as FAILED', async () => {
  const { status, body } = await json(api('/api/v2/uploads', {
    method: 'POST',
    body: Buffer.from([0x41, 0x43, 0x31, 0x30, 0x2e, 0x00, 0x00, 0x00]),
    headers: { 'x-file-name': 'drawing.dwg', 'x-scope-id': 'SBS_BUS' },
  }));
  assert.equal(status, 201);
  assert.equal(body.status, 'PASS');
  assert.equal(body.data.upload.status, 'FAILED');
  assert.ok(body.data.upload.errors.some((entry) => entry.code === 'UPLOAD_UNSUPPORTED_TYPE'));
});

test('POST /api/v2/uploads rejects HVAC scope with UPLOAD_NOT_ALLOWED', async () => {
  const { status, body } = await json(api('/api/v2/uploads', {
    method: 'POST',
    body: Buffer.from('chiller maintenance note', 'utf8'),
    headers: { 'x-file-name': 'chiller.txt', 'x-scope-id': 'HVAC' },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'FAIL');
  assert.equal(body.error_code, 'UPLOAD_NOT_ALLOWED');
});

test('GET /api/v2/uploads?scope_id=SBS_BUS lists the uploaded records', async () => {
  const { status, body } = await json(api('/api/v2/uploads?scope_id=SBS_BUS'));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.ok(Array.isArray(body.data.uploads));
  assert.ok(body.data.uploads.some((item) => item.filename === 'bus-brake-note.txt' && item.status === 'READY'));
  assert.ok(body.data.uploads.some((item) => item.filename === 'drawing.dwg' && item.status === 'FAILED'));
});

test('GET /api/v2/uploads without scope_id returns an empty array', async () => {
  const { status, body } = await json(api('/api/v2/uploads'));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.deepEqual(body.data.uploads, []);
});

test('POST /api/v2/retrieve returns SBS/BUS knowledge for A95', async () => {
  const { status, body } = await json(api('/api/v2/retrieve', {
    method: 'POST',
    body: { context_id: 'SBS/BUS', query: 'A95', top_k: 5 },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.ok(Array.isArray(body.data.results));
  assert.ok(body.data.results.length > 0, 'expected knowledge hits for "A95"');
  assert.ok(body.data.results.some((result) => result.source === 'knowledge' && /A95/i.test(result.text)));
});

test('POST /api/v2/retrieve blocks HVAC terms for SBS/BUS with CROSS_DOMAIN_BLOCKED', async () => {
  const { status, body } = await json(api('/api/v2/retrieve', {
    method: 'POST',
    body: { context_id: 'SBS/BUS', query: 'chiller', top_k: 5 },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.deepEqual(body.data.results, []);
  assert.ok(body.data.warnings.includes('CROSS_DOMAIN_BLOCKED'));
});

test('POST /api/v2/facts/extract produces facts with critical flags for SBS/BUS', async () => {
  const raw = '曼恩 A95 双层巴士。更换了刹车片。试机运行正常。问题已解决。';
  const { status, body } = await json(api('/api/v2/facts/extract', {
    method: 'POST',
    body: { context_id: 'SBS/BUS', raw_text: raw },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.equal(body.data.context_id, 'SBS/BUS');
  assert.ok(body.data.facts.length > 0);
  assert.ok(body.data.facts.some((fact) => fact.critical === true));
  assert.ok(body.data.facts.every((fact) => fact.support_status === 'DIRECT_TRANSCRIPT'));
});

test('POST /api/v2/retrieve returns only oilfield source material for pipeline checks', async () => {
  const { status, body } = await json(api('/api/v2/retrieve', {
    method: 'POST',
    body: { context_id: 'OILFIELD', query: '原油输油管道 管顶覆土 GB50253', top_k: 5 },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.ok(body.data.results.length > 0);
  assert.ok(body.data.results.every((item) => item.scope_id === 'OILFIELD'));
});

test('POST /api/v2/facts/extract and reports/build support POWER/GRID', async () => {
  const raw = '对2号主变绝缘油进行检测，电压等级220kV。依据 GB 50150-2016。击穿电压平均值62.97kV，测试通过。检测完成，安全措施已确认。';
  const extracted = await json(api('/api/v2/facts/extract', {
    method: 'POST',
    body: { context_id: 'POWER/GRID', raw_text: raw },
  }));
  assert.equal(extracted.status, 200);
  assert.equal(extracted.body.status, 'PASS');
  assert.ok(extracted.body.data.facts.some((fact) => fact.field === 'asset.equipment'));

  const built = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: { context_id: 'POWER/GRID', facts: extracted.body.data.facts, facts_receipt_id: 'facts:power:test' },
  }));
  assert.equal(built.status, 200);
  assert.equal(built.body.data.report.scope_id, 'POWER_GRID');
  assert.equal(built.body.data.report.reportVersion, 'v2-power-grid-1');
  assert.ok(Array.isArray(built.body.data.follow_up_questions));
});

test('POST /api/v2/facts/extract returns reviewable Rail ASR corrections without applying them', async () => {
  const raw = 'Corrective maintenance on train set Z751A. Inspection found the door control model 40.';
  const { status, body } = await json(api('/api/v2/facts/extract', {
    method: 'POST',
    body: { context_id: 'SBS/RAIL', raw_text: raw },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.equal(body.data.transcript_review.correction_suggestions.length, 2);
  assert.ok(body.data.transcript_review.correction_suggestions.every((item) => item.requires_confirmation));
  assert.ok(!body.data.facts.some((fact) => String(fact.value).includes('C751A')), 'unconfirmed correction must not enter facts');
});

test('POST /api/v2/facts/extract fails for HVAC with UNSUPPORTED_SCOPE', async () => {
  const { status, body } = await json(api('/api/v2/facts/extract', {
    method: 'POST',
    body: { context_id: 'HVAC', raw_text: '客户反映不制冷。' },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'FAIL');
  assert.equal(body.error_code, 'UNSUPPORTED_SCOPE');
});

test('POST /api/v2/reports/build returns PASS with no gate violations for grounded SBS/BUS facts', async () => {
  const facts = [
    { field: 'asset.bus_model', value: 'MAN A95', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: false },
    { field: 'work.type', value: 'preventive', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: false },
    { field: 'measurement.gap', value: '12', unit: 'mm', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: true },
    { field: 'completion.state', value: 'completed', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'manual', critical: true },
  ];
  const { status, body } = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: { context_id: 'SBS/BUS', facts },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.equal(body.data.report.scope_id, 'SBS_BUS');
  assert.equal(body.data.report.context_id, 'SBS/BUS');
  assert.equal(body.data.report.reportVersion, 'v2-bus-1');
  assert.match(body.data.report.facts_receipt_id, /^v2facts_[a-f0-9]{24}$/u);
  assert.ok(Array.isArray(body.data.report.sections));
  assert.ok(Array.isArray(body.data.report.missing_required_fields));
  assert.ok(!body.data.report.missing_required_fields.includes('provenance'));
  assert.ok(body.data.report.sections
    .find((section) => section.id === 'provenance')
    ?.content.some((line) => line.includes(body.data.report.facts_receipt_id)));
  assert.deepEqual(body.data.gates.violations, []);
});

test('POST /api/v2/reports/build binds a selected predefined template and reports its missing fields', async () => {
  const { status, body } = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: {
      context_id: 'SBS/BUS',
      template_id: 'bus-passenger-door-safety-equipment-inspection',
      report_session_id: 'door-template-session',
      facts: [{ field: 'work.description', value: 'Rear door did not close', support_status: 'DIRECT_TRANSCRIPT', source_refs: ['transcript:door'] }],
    },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'NEEDS_CONFIRMATION');
  assert.equal(body.data.draft.template_id, 'bus-passenger-door-safety-equipment-inspection');
  assert.equal(body.data.draft.template_version, '1.0.0');
  assert.equal(body.data.draft.schema_id, 'bus-passenger-door-safety-equipment-inspection-schema');
  assert.equal(body.data.draft.context_corpus_id, 'bus-passenger-door-safety-equipment-inspection-context');
  assert.equal(body.data.draft.context_version, '1.0.0');
  assert.ok(body.data.draft.missing_required_fields.includes('check.front_door.status'));
  assert.ok(body.data.gates.violations.some((item) => item.class === 'SCHEMA_REQUIRED_FIELD_MISSING'));
});

test('POST /api/v2/reports/build does not block on unpromoted RAG recommendations', async () => {
  const facts = [
    { field: 'asset.equipment', value: '原油输油管道', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: true },
    { field: 'inspection.result', value: '检查结果正常', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: true },
  ];
  const { status, body } = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: {
      context_id: 'OILFIELD',
      facts,
      knowledge_hits: ['作业指导书建议必要时更换密封件并安装防护装置。'],
    },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.deepEqual(body.data.gates.violations, []);
  assert.equal(body.data.knowledge_advisories.length, 1);
  assert.equal(body.data.knowledge_advisories[0].class, 'KNOWLEDGE_ACTION_NOT_PROMOTED');
  assert.ok(body.data.report.sections.some((section) => section.id === 'findings_result'));
});

test('POST /api/v2/reports/build builds a Rail report for SBS/RAIL', async () => {
  const facts = [
    { field: 'asset.train_set', value: 'C751A 7001/7002', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: true },
    { field: 'access.approval', value: 'TAMS approved', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: true },
  ];
  const { status, body } = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: { context_id: 'SBS/RAIL', facts },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  assert.equal(body.data.report.scope_id, 'SBS_RAIL');
  assert.equal(body.data.report.reportVersion, 'v2-rail-1');
  assert.ok(body.data.report.sections.some((section) => section.id === 'track_access_record'));
  assert.deepEqual(body.data.gates.violations, []);
});

test('POST /api/v2/reports/build consumes authoritative StructuredJobState and renders technician follow-up evidence', async () => {
  const facts = [
    { fact_id: 'fact_model', field: 'asset.bus_model', value: 'MAN A95', support_status: 'DIRECT_TRANSCRIPT', source_refs: ['transcript:1'] },
    {
      fact_id: 'followup_work',
      field: 'work_performed',
      value: 'Replaced the door actuator',
      support_status: 'CONFIRMED_BY_TECHNICIAN',
      source: 'technician_follow_up',
      source_refs: ['resolve:missing_work_performed_0'],
      provenance: { technician_id: 'TECH-1', resolve_item_id: 'missing_work_performed_0' },
    },
    { fact_id: 'fact_uncertain', field: 'work.description', value: 'Unconfirmed action', support_status: 'UNCERTAIN', source_refs: ['transcript:2'] },
    { fact_id: 'fact_unsupported', field: 'invented.secret', value: 'Must never render', support_status: 'DIRECT_TRANSCRIPT', source_refs: ['transcript:3'] },
  ];
  const { status, body } = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: { context_id: 'SBS/BUS', report_session_id: 'session_bus_state', facts },
  }));

  assert.equal(status, 200);
  assert.equal(body.data.structured_job_state.session_id, 'session_bus_state');
  assert.equal(body.data.structured_job_state.fields.work_performed, 'Replaced the door actuator');
  assert.deepEqual(body.data.structured_job_state.unsupported_fields, ['invented.secret']);
  const rendered = JSON.stringify(body.data.report.sections);
  assert.match(rendered, /Replaced the door actuator/);
  assert.doesNotMatch(rendered, /Unconfirmed action/);
  assert.doesNotMatch(rendered, /Must never render/);
  assert.equal(body.data.draft.report_session_id, 'session_bus_state');
  assert.match(body.data.draft.structured_state_hash, /^sha256:[a-f0-9]{64}$/);
});

test('Rail technician follow-up evidence updates state and the Rail report', async () => {
  const facts = [{
    fact_id: 'followup_access',
    field: 'access.approval',
    value: 'TAMS access approved by controller',
    support_status: 'CONFIRMED_BY_TECHNICIAN',
    source: 'technician_follow_up',
    source_refs: ['resolve:missing_track_access_0'],
    provenance: { technician_id: 'RAIL-1', resolve_item_id: 'missing_track_access_0' },
  }];
  const { body } = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: { context_id: 'SBS/RAIL', report_session_id: 'session_rail_state', facts },
  }));

  assert.equal(body.data.structured_job_state.fields['access.approval'], 'TAMS access approved by controller');
  const access = body.data.report.sections.find((section) => section.id === 'track_access_record');
  assert.match(JSON.stringify(access), /TAMS access approved by controller/);
});

test('schema conflicts independently gate V2 confirmation', async () => {
  const facts = [
    { fact_id: 'completion_1', field: 'completion.state', value: 'completed', support_status: 'CONFIRMED_BY_TECHNICIAN', source_refs: ['resolve:first'] },
    { fact_id: 'completion_2', field: 'completion.state', value: 'deferred', support_status: 'CONFIRMED_BY_TECHNICIAN', source_refs: ['resolve:second'] },
  ];
  const built = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: { context_id: 'SBS/BUS', report_session_id: 'session_conflict', facts },
  }));
  assert.equal(built.body.status, 'NEEDS_CONFIRMATION');
  assert.equal(built.body.data.validation_receipt.can_enter_technician_review, false);
  assert.ok(built.body.data.gates.violations.some((item) => item.class === 'SCHEMA_FIELD_CONFLICT'));

  const confirmed = await json(api('/api/v2/reports/confirm', {
    method: 'POST',
    body: {
      draft: built.body.data.draft,
      validator_run_id: built.body.trace_id,
      technician_id: 'TECH-1',
      technician_name: 'Alex',
    },
  }));
  assert.equal(confirmed.status, 410);
  assert.equal(confirmed.body.error_code, 'LEGACY_AUTHORITY_DISABLED');
});

test('POST /api/v2/reports/build returns NEEDS_CONFIRMATION when a test.result is knowledge-sourced', async () => {
  const facts = [
    { field: 'test.result', value: '刹车效率测试通过', support_status: 'DIRECT_TRANSCRIPT', source: 'knowledge', critical: true },
  ];
  const { status, body } = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: { context_id: 'SBS/BUS', facts },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'NEEDS_CONFIRMATION');
  assert.equal(body.retryable, false);
  assert.ok(body.data.gates.violations.length > 0);
  const classes = body.data.gates.violations.map((violation) => violation.class);
  assert.ok(classes.includes('INVENTED_TEST_RESULT'));
});

test('POST /api/v2/reports/build fails for HVAC with UNSUPPORTED_SCOPE', async () => {
  const { status, body } = await json(api('/api/v2/reports/build', {
    method: 'POST',
    body: { context_id: 'HVAC', facts: [] },
  }));
  assert.equal(status, 200);
  assert.equal(body.status, 'FAIL');
  assert.equal(body.error_code, 'UNSUPPORTED_SCOPE');
});

for (const scenario of [
  {
    name: 'Bus',
    contextId: 'SBS/BUS',
    schemaId: 'sbs_bus_maintenance',
    schemaVersion: '0',
    facts: [
      { field: 'asset.bus_model', value: 'MAN A95', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: false },
      { field: 'work.type', value: 'preventive', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: false },
      { field: 'measurement.gap', value: '12', unit: 'mm', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: true },
      { field: 'completion.state', value: 'completed', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'manual', critical: true },
    ],
  },
  {
    name: 'Rail',
    contextId: 'SBS/RAIL',
    schemaId: 'sbs_rail_maintenance',
    schemaVersion: '0',
    facts: [
      { field: 'asset.train_set', value: 'C751A 7001/7002', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: true },
      { field: 'access.approval', value: 'TAMS approved', support_status: 'DIRECT_TRANSCRIPT', source: 'manual', critical: true },
    ],
  },
]) {
  test(`${scenario.name} legacy build remains diagnostic but cannot confirm, save, or export authoritatively`, async (t) => {
    const facts = [...scenario.facts, {
      field: 'test.run_id',
      value: `${Date.now()}-${Math.random()}`,
      support_status: 'DIRECT_TRANSCRIPT',
      source: 'test',
      critical: false,
    }];
    const built = await json(api('/api/v2/reports/build', {
      method: 'POST',
      body: { context_id: scenario.contextId, facts },
    }));
    assert.equal(built.body.status, 'PASS');
    assert.equal(built.body.data.draft.schema_id, scenario.schemaId);
    assert.equal(built.body.data.draft.schema_version, scenario.schemaVersion);
    assert.equal(built.body.data.validation_receipt.schema_id, scenario.schemaId);

    const confirmed = await json(api('/api/v2/reports/confirm', {
      method: 'POST',
      body: {
        draft: built.body.data.draft,
        validator_run_id: built.body.data.validation_receipt.validator_run_id,
        technician_id: 'TECH-V2',
        technician_name: 'V2 Technician',
      },
    }));
    assert.equal(confirmed.status, 410);
    assert.equal(confirmed.body.error_code, 'LEGACY_AUTHORITY_DISABLED');
    t.after(() => fs.rm(path.join('data', 'validations', `${built.body.data.validation_receipt.validator_run_id}.json`), { force: true }));

    const saved = await json(api('/api/v2/reports/save', {
      method: 'POST',
      body: { draft: built.body.data.draft, confirmation_token: `confirm_${'a'.repeat(48)}` },
    }));
    assert.equal(saved.status, 410);
    assert.equal(saved.body.error_code, 'LEGACY_AUTHORITY_DISABLED');

    const exported = await json(api('/api/v2/reports/export', {
      method: 'POST',
      body: { draft: built.body.data.draft, confirmation_token: `confirm_${'a'.repeat(48)}` },
    }));
    assert.equal(exported.status, 410);
    assert.equal(exported.body.error_code, 'LEGACY_AUTHORITY_DISABLED');
  });
}

test('GET /api/v2/scopes without a token is rejected like V1 (401 FAIL)', async () => {
  const { status, body } = await json(api('/api/v2/scopes', { token: null }));
  assert.equal(status, 401);
  assert.equal(body.status, 'FAIL');
  assert.equal(body.error_code, 'AUTHENTICATION_REQUIRED');
});
