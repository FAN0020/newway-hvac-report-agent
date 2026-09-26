import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { resolveServerConfig } from '../src/network-security.js';
import { createServer } from '../src/server.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportStore } from '../src/storage/reports.js';
import { pcmWav } from './helpers.js';

const TOKEN = 'capture-report-token-2026';
const root = path.resolve('.tmp-tests', 'audio-capture-report-server');
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

before(async () => {
  await fs.rm(root, { recursive: true, force: true });
  const port = await findFreePort();
  const config = resolveServerConfig({
    HVAC_HOST: '127.0.0.1',
    HVAC_PORT: String(port),
    HVAC_DEMO_TOKEN: TOKEN,
  });
  server = createServer({
    config,
    services: {
      artifacts: new ArtifactStore({ root }),
      reports: new ReportStore({ root }),
      whisper: {
        transcribe: async (_file, { model }) => ({
          raw_text: '客户反映不制冷。检查发现电容损坏。换了一个三十五微法电容。试机运行正常。问题已解决。',
          language: 'zh',
          segments: [],
          provider: 'fake-whisper',
          model,
        }),
      },
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

async function request(pathname, { body, headers = {}, method = 'POST' } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    body,
  });
  return { status: response.status, body: await response.json() };
}

test('audio capture API preserves WAV and returns the staged HVAC correction review', async () => {
  const result = await request('/api/capture-reports/audio', {
    body: pcmWav(),
    headers: {
      'content-type': 'audio/wav',
      'x-template-id': 'hvac-service-report',
      'x-report-session-id': 'server_capture_hvac_1',
      'x-stt-language': 'zh',
    },
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.status, 'NEEDS_CONFIRMATION');
  assert.equal(result.body.data.next_action, 'CONFIRM_TRANSCRIPT');
  assert.match(result.body.data.audio.audio_id, /^audio_/);
  assert.match(result.body.data.transcript.artifact_id, /^transcript_/);
  assert.ok(result.body.data.correction_review.candidates.length > 0);
});

test('HVAC completion API consumes decisions and returns a template-bound report draft', async () => {
  const started = await request('/api/capture-reports/audio', {
    body: pcmWav({ samples: 161 }),
    headers: {
      'content-type': 'audio/wav',
      'x-template-id': 'hvac-service-report',
      'x-report-session-id': 'server_capture_hvac_2',
      'x-stt-language': 'zh',
    },
  });
  const review = started.body.data.correction_review;
  const result = await request('/api/capture-reports/hvac/complete', {
    body: JSON.stringify({
      template_id: 'hvac-service-report',
      report_session_id: 'server_capture_hvac_2',
      transcript_artifact_id: started.body.data.transcript.artifact_id,
      candidate_bundle_hash: review.candidate_bundle_hash,
      decisions: review.candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        decision: 'ACCEPT',
        critical_value_confirmed: true,
      })),
      technician_id: 'TECH-HTTP',
      technician_name: 'HTTP Technician',
      use_llm: false,
    }),
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.data.draft.template_id, 'hvac-service-report');
  assert.equal(result.body.data.draft.report_session_id, 'server_capture_hvac_2');
  assert.match(result.body.data.facts_receipt_id, /^facts_/);
  assert.equal(result.body.data.next_action, 'RESOLVE_REPORT_FIELDS');
});
