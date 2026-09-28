import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AudioJobQueue } from '../src/services/audio-jobs.js';
import { resolveServerConfig } from '../src/network-security.js';
import { createServer } from '../src/server.js';
import { pcmWav } from './helpers.js';

const frontend = 'https://field-report-demo.netlify.app';
const apiHost = 'temporary-backend.trycloudflare.com';
const password = 'integration-test-password';
const salt = '0123456789abcdef0123456789abcdef';
const hash = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');

test('public API requires operator login and processes uploaded audio through a durable job', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-report-public-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const captureService = {
    captureAudio: async (input) => {
      calls.push(input);
      return { session: { session_id: input.session_id, revision: 1 },
        transcript: { raw_text: 'Door controller replaced.' }, failure: null };
    },
  };
  const jobs = new AudioJobQueue({ root, captureService });
  await jobs.init();
  const config = resolveServerConfig({ HVAC_PUBLIC_API_HOST: apiHost,
    HVAC_PUBLIC_FRONTEND_ORIGIN: frontend, HVAC_PUBLIC_USER: 'operator',
    HVAC_PUBLIC_PASSWORD_HASH: `${salt}:${hash}`,
    HVAC_SESSION_SECRET: crypto.randomBytes(32).toString('base64url') });
  const server = createServer({ config, services: { audioJobs: jobs, authoritativeCapture: captureService } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (route, options = {}) => {
    const body = options.body === undefined ? null : Buffer.from(options.body);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route,
        method: options.method || 'GET', headers: { host: apiHost, origin: frontend,
          'sec-fetch-site': 'same-origin', ...(body ? { 'content-length': body.length } : {}), ...options.headers } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  };

  const denied = await request('/api/audio-jobs/' + 'a'.repeat(64));
  assert.equal(denied.status, 401);
  const wrongOrigin = await request('/session-bootstrap', { method: 'POST',
    headers: { origin: 'https://evil.example' }, body: JSON.stringify({ username: 'operator', password }) });
  assert.equal(wrongOrigin.status, 403);
  const wrongPassword = await request('/session-bootstrap', { method: 'POST',
    body: JSON.stringify({ username: 'operator', password: 'wrong' }) });
  assert.equal(wrongPassword.status, 401);
  const login = await request('/session-bootstrap', { method: 'POST',
    body: JSON.stringify({ username: 'operator', password }) });
  assert.equal(login.status, 200);
  const authorization = `Bearer ${login.body.token}`;
  const audio = pcmWav({ samples: 8000 });
  const capturePath = '/api/report-sessions/session_test/capture/audio';
  const upload = () => request(capturePath, { method: 'POST', body: audio,
    headers: { authorization, 'content-type': 'audio/wav', 'x-expected-revision': '0',
      'idempotency-key': 'first-recording' } });
  const queued = await upload();
  assert.equal(queued.status, 202);
  assert.match(queued.body.data.job_id, /^[a-f0-9]{64}$/);
  const repeated = await upload();
  assert.equal(repeated.body.data.job_id, queued.body.data.job_id);
  let job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    job = await request(`/api/audio-jobs/${queued.body.data.job_id}`, { headers: { authorization } });
    if (job.body.data.status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.body.data.status, 'complete');
  assert.equal(job.body.data.result.transcript.raw_text, 'Door controller replaced.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wav_buffer.equals(audio), true);
  const collision = await request(capturePath, { method: 'POST', body: pcmWav({ samples: 8001 }),
    headers: { authorization, 'content-type': 'audio/wav', 'x-expected-revision': '0',
      'idempotency-key': 'first-recording' } });
  assert.equal(collision.status, 409);
  const recovered = new AudioJobQueue({ root, captureService });
  await recovered.init();
  assert.equal((await recovered.get(queued.body.data.job_id)).status, 'complete');
});
