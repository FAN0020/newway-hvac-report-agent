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

const TOKEN = 'final-report-http-token-2026';
const FIELDS = [
  ['work.work_order_id', 'WO-P0-HTTP'], ['work.date_time', '2026-09-27 10:42'],
  ['asset.internal_fleet_no', '8300-354'], ['asset.registration_no', 'SBS6025Z'],
  ['asset.bus_model', 'MAN A95'], ['asset.depot', 'Hougang Depot'], ['technician.name', 'Alex Tan'],
  ['work.trigger', 'Passenger door would not close'], ['inspection_findings', 'Connector was loose'],
  ['diagnosis.root_cause', 'Root cause not established'], ['work_performed', 'Reseated the connector'],
  ['test.result', 'Door cycle test completed five times'], ['completion.outstanding_issues', 'None'],
  ['completion.state', 'NOT_READY'],
].map(([field_id, value]) => ({ field_id, value }));
FIELDS.splice(5, 0, { field_id: 'measurement.odometer_km', value: 51020, unit: 'km' });

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function fixture(t, name) {
  const root = path.resolve('.tmp-tests', `final-report-http-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore: new ReportSessionStore({ root: path.join(root, 'authority') }),
    whisperProvider: { transcribe: async () => { throw new Error('Not used.'); } },
    jobContextProvider: { resolve: async ({ job_context_ref: ref }) => ({ record_id: ref, version: 'work-order.v1', fields: FIELDS }) },
    clock: () => '2026-09-27T10:42:00.000Z',
  });
  const port = await freePort();
  const config = resolveServerConfig({ HVAC_HOST: '127.0.0.1', HVAC_PORT: String(port), HVAC_DEMO_TOKEN: TOKEN });
  const server = createServer({ config, services: { authoritativeCapture: service } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const requestRaw = async (pathname, body = {}, method = 'POST', headers = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
  const request = async (pathname, body = {}, method = 'POST') => {
    const response = await requestRaw(pathname, body, method);
    return { status: response.status, body: await response.json() };
  };
  return { request, requestRaw, base: `http://127.0.0.1:${port}` };
}

async function readyReport(request, suffix = '1') {
  const created = await request('/api/report-sessions', {
    template_id: 'bus-defect-rectification-corrective-maintenance', template_version: '1.0.0',
    job_context_ref: `work-order:WO-P0-HTTP-${suffix}`,
  });
  const sessionId = created.body.data.session.session_id;
  let current = await request(`/api/report-sessions/${sessionId}/capture/text`, {
    expected_revision: created.body.data.session.revision, text: 'No parts were used.', idempotency_key: `capture-${suffix}`,
  });
  while (current.body.data.agent_state.resolution_queue.length) {
    const state = current.body.data.agent_state;
    const item = state.resolution_queue[0];
    const field = state.report_fields.find((entry) => entry.field_id === item.field_id);
    const system = field.candidates.find((candidate) => candidate.support_type === 'AUTHORITATIVE_SYSTEM_DATA');
    current = await request(`/api/report-sessions/${sessionId}/resolution-items/${item.resolution_id}/answer`, {
      expected_revision: current.body.data.session.revision,
      idempotency_key: `answer-${suffix}-${item.resolution_id}`,
      answer: system ? { kind: 'SELECT_CANDIDATE', candidate_id: system.candidate_id } : { kind: 'VALUE', value: 'Not established' },
    });
  }
  const review = await request(`/api/report-sessions/${sessionId}/review`, { expected_revision: current.body.data.session.revision });
  const ready = await request(`/api/report-sessions/${sessionId}/review/complete`, { expected_revision: review.body.data.session.revision });
  return { sessionId, ready: ready.body.data };
}

test('final HTTP confirmation exports a complete snapshot-bound PDF download and supports repetition', async (t) => {
  const { request, requestRaw, base } = await fixture(t, 'confirm');
  const { sessionId, ready } = await readyReport(request);
  const premature = await request(`/api/report-sessions/${sessionId}/export`, { expected_revision: ready.session.revision });
  assert.equal(premature.status, 409);
  assert.equal(premature.body.error_code, 'REPORT_NOT_CONFIRMED');
  const confirmed = await request(`/api/report-sessions/${sessionId}/confirm`, { expected_revision: ready.session.revision });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.session.phase, 'CONFIRMED');
  assert.equal(confirmed.body.data.snapshot.session_id, sessionId);
  assert.equal(confirmed.body.data.confirmation.technician_principal_ref, 'principal:demo-technician');
  const first = await requestRaw(`/api/report-sessions/${sessionId}/export`, { expected_revision: confirmed.body.data.session.revision });
  const firstBytes = Buffer.from(await first.arrayBuffer());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'application/pdf');
  assert.match(first.headers.get('content-disposition') || '', /^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/u);
  assert.equal(first.headers.get('x-report-snapshot-id'), confirmed.body.data.snapshot.snapshot_id);
  assert.equal(Number(first.headers.get('content-length')), firstBytes.length);
  assert.equal(firstBytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(firstBytes.length > 5_000);

  const second = await requestRaw(`/api/report-sessions/${sessionId}/export`, { expected_revision: confirmed.body.data.session.revision });
  const secondBytes = Buffer.from(await second.arrayBuffer());
  assert.equal(second.status, 200);
  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(second.headers.get('x-report-snapshot-id'), confirmed.body.data.snapshot.snapshot_id);

  const prepared = await requestRaw(
    `/api/report-sessions/${sessionId}/export`,
    { expected_revision: confirmed.body.data.session.revision },
    'POST',
    { accept: 'application/json' },
  );
  const preparedBody = await prepared.json();
  assert.equal(prepared.status, 200);
  assert.match(preparedBody.data.download_url, /^\/report-download\/[a-f0-9-]+$/u);
  assert.equal(preparedBody.data.snapshot_id, confirmed.body.data.snapshot.snapshot_id);
  assert.doesNotMatch(preparedBody.data.download_url, /token|authorization/iu);

  const browserDownload = await fetch(`${base}${preparedBody.data.download_url}`);
  const browserBytes = Buffer.from(await browserDownload.arrayBuffer());
  assert.equal(browserDownload.status, 200);
  assert.equal(browserDownload.headers.get('content-type'), 'application/pdf');
  assert.match(browserDownload.headers.get('content-disposition') || '', /^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/u);
  assert.equal(browserDownload.headers.get('x-report-snapshot-id'), confirmed.body.data.snapshot.snapshot_id);
  assert.deepEqual(browserBytes, firstBytes);
});

test('untrusted authority fields cannot bypass final confirmation', async (t) => {
  const { request } = await fixture(t, 'forgery');
  const { sessionId, ready } = await readyReport(request);
  for (const [field, value] of [
    ['draft', { report_id: 'forged' }], ['facts', []], ['support_status', 'CONFIRMED_BY_TECHNICIAN'],
    ['provenance', { evidence_id: 'forged' }], ['validated', true], ['resolved', true],
    ['knowledge_hits', [{ text: 'test passed' }]], ['snapshot_ref', 'snapshot_forged'],
  ]) {
    const response = await request(`/api/report-sessions/${sessionId}/confirm`, { expected_revision: ready.session.revision, [field]: value });
    assert.equal(response.status, 400, field);
    assert.equal(response.body.error_code, 'UNTRUSTED_CAPTURE_INPUT', field);
  }
  const unchanged = await request(`/api/report-sessions/${sessionId}`, {}, 'GET');
  assert.equal(unchanged.body.data.session.phase, 'READY');
  assert.equal(unchanged.body.data.session.revision, ready.session.revision);
});

test('stale confirmation and stale export are rejected without mutating the report', async (t) => {
  const { request } = await fixture(t, 'stale');
  const { sessionId, ready } = await readyReport(request);
  const stale = await request(`/api/report-sessions/${sessionId}/confirm`, { expected_revision: ready.session.revision - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error_code, 'STALE_REVISION');
  const confirmed = await request(`/api/report-sessions/${sessionId}/confirm`, { expected_revision: ready.session.revision });
  const staleExport = await request(`/api/report-sessions/${sessionId}/export`, { expected_revision: ready.session.revision });
  assert.equal(staleExport.status, 409);
  assert.equal(staleExport.body.error_code, 'STALE_REVISION');
  const loaded = await request(`/api/report-sessions/${sessionId}`, {}, 'GET');
  assert.equal(loaded.body.data.report_snapshot.snapshot_id, confirmed.body.data.snapshot.snapshot_id);
});

test('all public client-draft confirmation/save/export routes are retired', async (t) => {
  const { request } = await fixture(t, 'legacy');
  for (const route of [
    '/api/reports/confirm', '/api/reports/save', '/api/reports/export',
    '/api/v2/reports/confirm', '/api/v2/reports/save', '/api/v2/reports/export',
    '/api/report-sessions/session_forged/confirmation',
  ]) {
    const response = await request(route, { draft: { forged: true }, confirmation_token: `confirm_${'a'.repeat(48)}` });
    assert.equal(response.status, 410, route);
    assert.equal(response.body.error_code, 'LEGACY_AUTHORITY_DISABLED', route);
  }
});

test('the obsolete browser-authority bundle is not served by the product shell', async (t) => {
  const { base } = await fixture(t, 'legacy-browser');
  const response = await fetch(`${base}/app.js`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});
