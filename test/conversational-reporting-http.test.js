import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerConfig } from '../src/network-security.js';
import { createServer } from '../src/server.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

const token = 'semantic-trace-http-test-token';

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('HTTP capture and replayable trace expose the evidence-to-field decisions after reload', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-http-'));
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore: new ReportSessionStore({ root: path.join(root, 'sessions') }),
    whisperProvider: { transcribe: async () => { throw new Error('Unexpected audio capture'); } },
    clock: () => '2026-09-28T06:00:00.000Z',
    reportTimeZone: 'Asia/Shanghai',
  });
  const port = await freePort();
  const config = resolveServerConfig({ HVAC_HOST: '127.0.0.1', HVAC_PORT: String(port), HVAC_DEMO_TOKEN: token });
  const server = createServer({ config, services: { authoritativeCapture: service } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (pathname, method = 'GET', body = null) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const created = await request('/api/report-sessions', 'POST', {
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0', job_context_ref: 'new-report:http-semantic-trace',
  });
  assert.equal(created.status, 201);
  const sessionId = created.body.data.session.session_id;
  const before = await request(`/api/report-sessions/${sessionId}/semantic-trace`);
  assert.equal(before.status, 200);
  assert.equal(before.body.data.semantic_trace, null);
  const captured = await request(`/api/report-sessions/${sessionId}/capture/text`, 'POST', {
    expected_revision: created.body.data.session.revision,
    idempotency_key: 'http-semantic-trace',
    text: 'Work order ABCD-1334. I worked on bus 204 at Changi Airport. I am Alex. The driver complained about vibration.',
  });
  assert.equal(captured.status, 201);
  const loaded = await request(`/api/report-sessions/${sessionId}/semantic-trace`);
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.data.semantic_trace, captured.body.data.semantic_trace);
  assert.equal(loaded.body.data.semantic_trace.canonical_facts.some((fact) =>
    fact.semantic_type === 'ASSET_IDENTITY' && fact.value === '204'), true);
  const replay = await request(`/api/report-sessions/${sessionId}/transcripts/${captured.body.data.transcript.transcript_id}/semantic-replay`,
    'POST', { expected_revision: captured.body.data.session.revision });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.reused, true);
});
