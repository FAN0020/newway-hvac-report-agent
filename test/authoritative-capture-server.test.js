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

async function fixture(t, name, { whisper } = {}) {
  const root = path.resolve('.tmp-tests', `authoritative-capture-server-${name}`);
  await fs.rm(root, { recursive: true, force: true });
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
    clock: () => '2026-09-27T07:00:00.000Z',
  });
  let server;
  let base;
  const start = async () => {
    const port = await freePort();
    const config = resolveServerConfig({
      HVAC_HOST: '127.0.0.1', HVAC_PORT: String(port), HVAC_DEMO_TOKEN: TOKEN,
    });
    server = createServer({ config, services: { authoritativeCapture: makeService() } });
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
