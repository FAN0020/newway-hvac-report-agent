import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';
import { createServer } from '../src/server.js';
import { resolveServerConfig } from '../src/network-security.js';

const TOKEN = 'vehicle-identity-http-test-token';
const template = {
  templateId: 'vehicle-identity-qa', name: 'Vehicle Identity QA', status: 'PUBLISHED', templateVersion: '1.0.0', domain: 'CUSTOM',
  schema: { id: 'vehicle-identity-qa-schema', version: '1.0.0', fields: [
    { id: 'vehicle_id', label: 'Vehicle ID', section: 'Report fields', type: 'string', required: true },
    { id: 'inspection.result', label: 'Inspection result', section: 'Report fields', type: 'text', required: true },
  ] },
  contextCorpus: { id: 'vehicle-identity-qa-context', version: '1.0.0', sources: [] },
  adapter: { id: 'manual-schema-v1', version: '1.0.0' },
  rendererMapping: { id: 'manual-schema-renderer', version: '1.0.0' },
};

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('no-order report confirms, is manually linked through API, survives restart, and rejects conflicting identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'servicescribe-vehicle-identity-'));
  let server;
  let base;
  async function start() {
    const port = await freePort();
    const service = new AuthoritativeCaptureService({
      artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
      sessionStore: new ReportSessionStore({ root: path.join(root, 'sessions') }),
      whisperProvider: { transcribe: async () => { throw new Error('Not used'); } },
      templateProvider: async (id) => id === template.templateId ? structuredClone(template) : null,
      clock: () => '2026-10-01T02:00:00.000Z',
    });
    server = createServer({ config: resolveServerConfig({ HVAC_HOST: '127.0.0.1', HVAC_PORT: String(port), HVAC_DEMO_TOKEN: TOKEN }),
      services: { authoritativeCapture: service } });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${port}`;
  }
  await start();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const page = await fetch(`${base}/vehicle-history.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Vehicle identity review/u);
  assert.equal((await fetch(`${base}/vehicle-history.js`)).status, 200);
  const request = async (url, body) => {
    const response = await fetch(`${base}${url}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
  async function confirmed(suffix) {
    const created = await request('/api/report-sessions', { template_id: template.templateId,
      template_version: template.templateVersion, job_context_ref: `new-report:${suffix}` });
    assert.equal(created.status, 201);
    const id = created.payload.data.session.session_id;
    let current = await request(`/api/report-sessions/${id}/capture/text`, { expected_revision: created.payload.data.session.revision,
      text: 'I inspected the vehicle.', idempotency_key: `capture-${suffix}` });
    assert.equal(current.status, 201);
    for (const [fieldId, value] of [['vehicle_id', 'BUS-101'], ['inspection.result', 'Inspection completed']]) {
      const item = current.payload.data.agent_state.resolution_queue.find((entry) => entry.field_id === fieldId);
      current = await request(`/api/report-sessions/${id}/resolution-items/${item.resolution_id}/answer`, {
        expected_revision: current.payload.data.session.revision, answer: { kind: 'VALUE', value },
        idempotency_key: `answer-${suffix}-${fieldId}` });
      assert.ok([200, 201].includes(current.status), JSON.stringify(current.payload));
    }
    const review = await request(`/api/report-sessions/${id}/review`, { expected_revision: current.payload.data.session.revision });
    assert.equal(review.status, 200, JSON.stringify(review.payload));
    const ready = await request(`/api/report-sessions/${id}/review/complete`, { expected_revision: review.payload.data.session.revision });
    assert.equal(ready.status, 200, JSON.stringify(ready.payload));
    const confirmation = await request(`/api/report-sessions/${id}/confirm`, { expected_revision: ready.payload.data.session.revision });
    assert.equal(confirmation.status, 200, JSON.stringify(confirmation.payload));
    return { id, snapshot: confirmation.payload.data.snapshot };
  }
  const first = await confirmed('one');
  const second = await confirmed('two');
  assert.equal((await request(`/api/vehicles/BUS-101/reports`)).payload.data.reports.length, 0);
  assert.equal((await request(`/api/report-sessions/${first.id}/vehicle-identity-review`, {
    vehicle_id: 'BUS-101', review_note: 'Fleet register BUS-101', attested: false })).payload.error_code, 'VEHICLE_IDENTITY_REVIEW_REQUIRED');
  assert.equal((await request(`/api/report-sessions/${first.id}/vehicle-identity-review`, {
    vehicle_id: 'BUS-101', review_note: 'Fleet register BUS-101', attested: true, reviewer_principal_ref: 'principal:forged' })).payload.error_code,
  'INVALID_VEHICLE_IDENTITY_REVIEW');
  assert.equal((await request(`/api/report-sessions/${first.id}/vehicle-identity-review`, {
    vehicle_id: 'BUS-202', review_note: 'Fleet register BUS-202', attested: true })).payload.error_code, 'VEHICLE_ID_MISMATCH');
  for (const report of [first, second]) {
    const reviewed = await request(`/api/report-sessions/${report.id}/vehicle-identity-review`, {
      vehicle_id: 'BUS-101', review_note: 'Fleet register BUS-101', attested: true });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.payload));
    assert.equal(reviewed.payload.data.link.snapshot_id, report.snapshot.snapshot_id);
  }
  await new Promise((resolve) => server.close(resolve));
  await start();
  const history = await request('/api/vehicles/BUS-101/reports');
  assert.deepEqual(history.payload.data.reports.map((item) => item.snapshot_id).sort(),
    [first.snapshot.snapshot_id, second.snapshot.snapshot_id].sort());
  assert.equal((await request(`/api/report-sessions/${first.id}/structured-export`)).payload.data.vehicle_identity_status, 'VERIFIED');
  assert.equal((await request(`/api/report-sessions/${first.id}`)).payload.data.report_snapshot.snapshot_hash, first.snapshot.snapshot_hash);
});
