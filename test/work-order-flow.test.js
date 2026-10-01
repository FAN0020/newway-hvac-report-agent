import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { WorkOrderStore } from '../src/storage/work-orders.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';
import { createServer } from '../src/server.js';
import { resolveServerConfig } from '../src/network-security.js';
import { templateFor } from '../web/template-catalog.js';

const execFileAsync = promisify(execFile);
const templateId = 'bus-defect-rectification-corrective-maintenance';
const templateVersion = '1.0.0';
const token = 'work-order-flow-test-token';

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'servicescribe-work-order-test-'));
  let server;
  const makeStore = () => new WorkOrderStore({ root: path.join(root, 'work-orders'), clock: () => '2026-10-01T02:00:00.000Z' });
  const start = async () => {
    const port = await freePort();
    const store = makeStore();
    const capture = new AuthoritativeCaptureService({
      artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
      sessionStore: new ReportSessionStore({ root: path.join(root, 'sessions') }),
      whisperProvider: { transcribe: async () => { throw new Error('not used'); } },
      jobContextProvider: store,
      clock: () => '2026-10-01T02:00:00.000Z',
    });
    server = createServer({ config: resolveServerConfig({ HVAC_HOST: '127.0.0.1', HVAC_PORT: String(port), HVAC_DEMO_TOKEN: token }),
      services: { workOrders: store, authoritativeCapture: capture } });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${port}`;
  };
  let base = await start();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return {
    root,
    request: async (endpoint, { method = 'GET', body, filename } = {}) => {
      const binary = Buffer.isBuffer(body);
      const response = await fetch(`${base}${endpoint}`, { method,
        headers: { authorization: `Bearer ${token}`, ...(binary ? { 'x-file-name': filename, 'content-type': filename?.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/csv' } : body ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      });
      return { status: response.status, payload: await response.json() };
    },
    restart: async () => { await new Promise((resolve) => server.close(resolve)); base = await start(); },
    store: makeStore,
  };
}

test('CSV upload, human identity review, server prefill and restart preserve an exact version', async (t) => {
  const { request, restart } = await fixture(t);
  const csv = Buffer.from('Work Order No,WO-7231\nFleet ID,BUS-8300\nDepot,Hougang\nReported Defect,Passenger door will not close\n');
  const uploaded = await request('/api/work-orders/uploads', { method: 'POST', filename: 'job.csv', body: csv });
  assert.equal(uploaded.status, 201);
  const order = uploaded.payload.data.work_order;
  assert.equal(order.status, 'PENDING_REVIEW');
  assert.equal(order.candidates.work_order_id[0].value, 'WO-7231');
  assert.equal(order.candidates.vehicle_id[0].value, 'BUS-8300');
  const reference = `work-order:${order.upload_id}@1`;
  const premature = await request('/api/report-sessions', { method: 'POST', body: { template_id: templateId, template_version: templateVersion, job_context_ref: reference } });
  assert.equal(premature.status, 409);
  const reviewed = await request(`/api/work-orders/${order.upload_id}/review`, { method: 'POST', body: {
    work_order_id: 'WO-7231', vehicle_id: 'BUS-8300', field_ids: ['asset.depot', 'work.trigger'],
  } });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.payload.data.work_order.version, 1);
  await restart();
  const list = await request('/api/work-orders');
  assert.equal(list.payload.data.work_orders.find((item) => item.upload_id === order.upload_id).status, 'REVIEWED');
  const created = await request('/api/report-sessions', { method: 'POST', body: { template_id: templateId, template_version: templateVersion, job_context_ref: reference } });
  assert.equal(created.status, 201);
  const session = created.payload.data.session;
  assert.equal(session.job_context_binding.vehicle_id, 'BUS-8300');
  assert.equal(session.job_context_binding.version, '1');
  assert.equal(session.job_context_binding.source_sha256, order.source.sha256);
  const fields = created.payload.data.agent_state.report_fields;
  assert.equal(fields.find((field) => field.field_id === 'work.work_order_id').value, 'WO-7231');
  assert.equal(fields.find((field) => field.field_id === 'asset.internal_fleet_no').value, 'BUS-8300');
  assert.equal(fields.find((field) => field.field_id === 'asset.depot').value, 'Hougang');
  assert.equal(fields.find((field) => field.field_id === 'work.trigger').value, 'Passenger door will not close');
  assert.equal(fields.find((field) => field.field_id === 'work_performed').state, 'UNKNOWN');
  await restart();
  const restored = await request(`/api/report-sessions/${session.session_id}`);
  assert.equal(restored.payload.data.session.job_context_binding.review_sha256, session.job_context_binding.review_sha256);
  assert.ok(restored.payload.data.evidence.some((item) => item.metadata?.record_id === reference));
});

test('duplicate files, conflicting vehicles and wrong version do not silently bind; no-order reports still work', async (t) => {
  const { request } = await fixture(t);
  const first = Buffer.from('Work Order No,WO-800\nFleet ID,BUS-1\n');
  const upload = await request('/api/work-orders/uploads', { method: 'POST', filename: 'first.csv', body: first });
  const id = upload.payload.data.work_order.upload_id;
  assert.equal((await request('/api/work-orders/uploads', { method: 'POST', filename: 'again.csv', body: first })).payload.error_code, 'WORK_ORDER_DUPLICATE_UPLOAD');
  assert.equal((await request(`/api/work-orders/${id}/review`, { method: 'POST', body: { work_order_id: 'WO-800', vehicle_id: 'BUS-2' } })).payload.error_code, 'WORK_ORDER_CORRECTION_REASON_REQUIRED');
  assert.equal((await request(`/api/work-orders/${id}/review`, { method: 'POST', body: { work_order_id: 'WO-800', vehicle_id: 'BUS-1' } })).status, 200);
  const second = await request('/api/work-orders/uploads', { method: 'POST', filename: 'changed.csv', body: Buffer.from('Work Order No,WO-800\nFleet ID,BUS-2\n') });
  const secondId = second.payload.data.work_order.upload_id;
  assert.equal((await request(`/api/work-orders/${secondId}/review`, { method: 'POST', body: { work_order_id: 'WO-800', vehicle_id: 'BUS-2' } })).payload.error_code, 'WORK_ORDER_VEHICLE_CONFLICT');
  const wrongVersion = await request('/api/report-sessions', { method: 'POST', body: { template_id: templateId, template_version: templateVersion, job_context_ref: `work-order:${id}@2` } });
  assert.equal(wrongVersion.status, 409);
  const noOrder = await request('/api/report-sessions', { method: 'POST', body: { template_id: templateId, template_version: templateVersion, job_context_ref: 'new-report:test-no-order' } });
  assert.equal(noOrder.status, 201);
  assert.equal(noOrder.payload.data.session.job_context_binding, undefined);
});

test('a real DOCX can be extracted and binary or unsupported files fail explicitly', async (t) => {
  const { root, request } = await fixture(t);
  const docRoot = path.join(root, 'docx'); await fs.mkdir(path.join(docRoot, 'word'), { recursive: true });
  await fs.writeFile(path.join(docRoot, 'word', 'document.xml'), '<w:document><w:body><w:p><w:r><w:t>Work Order No: WO-900</w:t></w:r></w:p><w:p><w:r><w:t>Vehicle ID: BUS-9</w:t></w:r></w:p></w:body></w:document>');
  await execFileAsync('zip', ['-q', '-r', path.join(root, 'job.docx'), 'word'], { cwd: docRoot });
  const result = await request('/api/work-orders/uploads', { method: 'POST', filename: 'job.docx', body: await fs.readFile(path.join(root, 'job.docx')) });
  assert.equal(result.status, 201);
  assert.equal(result.payload.data.work_order.candidates.work_order_id[0].value, 'WO-900');
  assert.equal(result.payload.data.work_order.candidates.vehicle_id[0].value, 'BUS-9');
  const unsupported = await request('/api/work-orders/uploads', { method: 'POST', filename: 'image.pdf', body: Buffer.from('%PDF-1.4\n') });
  assert.equal(unsupported.status, 415);
  const invalid = await request('/api/work-orders/uploads', { method: 'POST', filename: 'broken.docx', body: Buffer.from('not a zip') });
  assert.equal(invalid.status, 422);
});

test('same vehicle receives a new immutable order version, and template source policy limits prefill', async (t) => {
  const { request, store } = await fixture(t);
  const first = await request('/api/work-orders/uploads', { method: 'POST', filename: 'v1.csv', body: Buffer.from('Work Order No,WO-55\nFleet ID,BUS-55\nDepot,North\n') });
  const firstId = first.payload.data.work_order.upload_id;
  await request(`/api/work-orders/${firstId}/review`, { method: 'POST', body: { work_order_id: 'WO-55', vehicle_id: 'BUS-55', field_ids: ['asset.depot'] } });
  const second = await request('/api/work-orders/uploads', { method: 'POST', filename: 'v2.csv', body: Buffer.from('Work Order No,WO-55\nFleet ID,BUS-55\nDepot,South\n') });
  const secondId = second.payload.data.work_order.upload_id;
  const reviewed = await request(`/api/work-orders/${secondId}/review`, { method: 'POST', body: { work_order_id: 'WO-55', vehicle_id: 'BUS-55', field_ids: ['asset.depot'] } });
  assert.equal(reviewed.payload.data.work_order.version, 2);
  const template = templateFor(templateId);
  const denied = structuredClone(template);
  denied.schema.fields.find((field) => field.id === 'asset.depot').allowedSources = ['TECHNICIAN'];
  const v1 = await store().resolve({ job_context_ref: `work-order:${firstId}@1`, template });
  const v2 = await store().resolve({ job_context_ref: `work-order:${secondId}@2`, template: denied });
  assert.equal(v1.fields.find((field) => field.field_id === 'asset.depot').value, 'North');
  assert.equal(v2.fields.some((field) => field.field_id === 'asset.depot'), false);
  const missingIdentity = await request('/api/work-orders/uploads', { method: 'POST', filename: 'manual.csv', body: Buffer.from('Depot,East\n') });
  const manualId = missingIdentity.payload.data.work_order.upload_id;
  assert.equal((await request(`/api/work-orders/${manualId}/review`, { method: 'POST', body: { work_order_id: 'WO-56', vehicle_id: 'BUS-56' } })).payload.error_code, 'WORK_ORDER_CORRECTION_REASON_REQUIRED');
});
