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

test('localization browser modules are served as JavaScript', async () => {
  for (const pathname of ['/i18n.js', '/locales/en.js', '/locales/zh-CN.js', '/locales/overrides.js']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('content-type') || '', /^text\/javascript/);
    assert.ok((await response.text()).length > 100, pathname);
  }
});

test('browser shell icon is served without a console-visible 404', async () => {
  const response = await fetch(`${base}/favicon.svg`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^image\/svg\+xml/);
});

test('GET /api/v2/scopes lists three scopes with HVAC upload_allowed=false', async () => {
  const { status, body } = await json(api('/api/v2/scopes'));
  assert.equal(status, 200);
  assert.equal(body.status, 'PASS');
  const ids = body.data.scopes.map((item) => item.scope_id).sort();
  assert.deepEqual(ids, ['HVAC', 'SBS_BUS', 'SBS_RAIL']);
  const hvac = body.data.scopes.find((item) => item.scope_id === 'HVAC');
  assert.equal(hvac.upload_allowed, false);
  assert.equal(hvac.display, 'HVAC');
  const bus = body.data.scopes.find((item) => item.scope_id === 'SBS_BUS');
  assert.equal(bus.upload_allowed, true);
  assert.deepEqual(body.data.contexts, { 'SBS/BUS': 'SBS_BUS', 'SBS/RAIL': 'SBS_RAIL', HVAC: 'HVAC' });
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
  assert.ok(Array.isArray(body.data.report.sections));
  assert.ok(Array.isArray(body.data.report.missing_required_fields));
  assert.deepEqual(body.data.gates.violations, []);
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

test('GET /api/v2/scopes without a token is rejected like V1 (401 FAIL)', async () => {
  const { status, body } = await json(api('/api/v2/scopes', { token: null }));
  assert.equal(status, 401);
  assert.equal(body.status, 'FAIL');
  assert.equal(body.error_code, 'AUTHENTICATION_REQUIRED');
});
