import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';
import { pcmWav } from './helpers.js';

async function fixture(t, name, { whisper } = {}) {
  const root = path.resolve('.tmp-tests', `authoritative-capture-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'authority') });
  const service = new AuthoritativeCaptureService({
    artifactStore,
    sessionStore,
    whisperProvider: whisper || { transcribe: async () => { throw new Error('Unexpected transcription.'); } },
    clock: () => '2026-09-27T06:00:00.000Z',
  });
  return { root, artifactStore, sessionStore, service };
}

async function busSession(service, suffix = '1') {
  return service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0',
    job_context_ref: `job-context:WO-CAPTURE-${suffix}`,
  });
}

test('technician text is persisted, report-bound, reviewed harmlessly, and converted to structured candidates', async (t) => {
  const { service, sessionStore } = await fixture(t, 'text');
  const created = await busSession(service, 'TEXT');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault. Replaced the door control module.',
    language: 'en',
    idempotency_key: 'text-capture-1',
  });

  assert.equal(result.reused, false);
  assert.equal(result.session.phase, 'RESOLVE');
  assert.equal(result.next_action, 'RESOLVE_REPORT_FIELDS');
  assert.equal(result.evidence.evidence_type, 'MANUAL_INPUT');
  assert.equal(result.evidence.metadata.report_binding.report_session_id, created.session.session_id);
  assert.equal(result.evidence.metadata.report_binding.template_id, 'bus-defect-rectification-corrective-maintenance');
  assert.equal(result.evidence.metadata.report_binding.template_version, '1.0.0');
  assert.equal(result.evidence.metadata.report_binding.scope_id, 'SBS_BUS');
  assert.equal(result.transcript.source_evidence_id, result.evidence.evidence_id);
  assert.equal(result.transcript.source_hash, result.evidence.source_hash);
  assert.equal(result.transcript.session_id, created.session.session_id);
  assert.equal(result.transcript.template_binding.template_version, '1.0.0');
  assert.equal(result.review, null);
  assert.ok(result.candidates.some((candidate) => candidate.field_id === 'asset.bus_model'));
  assert.ok(result.candidates.every((candidate) => candidate.support_type === 'MANUAL_TECHNICIAN_INPUT'));
  assert.ok(result.candidates.every((candidate) => candidate.evidence_refs[0].span_id));
  assert.deepEqual(await sessionStore.load(created.session.session_id), result.session);
  assert.deepEqual((await sessionStore.listAuditEvents(created.session.session_id)).map((event) => event.event_type), [
    'SESSION_CREATED',
    'EVIDENCE_CAPTURED',
    'PROCESSING_STARTED',
    'STRUCTURED_CANDIDATES_CREATED',
  ]);
});

test('audio bytes exist before Whisper and the transcript preserves provider timestamps and exact bindings', async (t) => {
  let persistedBytes = null;
  const whisper = {
    transcribe: async (audioPath, { model, language }) => {
      persistedBytes = await fs.readFile(audioPath);
      return {
        raw_text: 'Bus MAN A95 had a door fault. Replaced the door control module.',
        language: language === 'auto' ? 'en' : language,
        segments: [
          { start_ms: 0, end_ms: 900, text: 'Bus MAN A95 had a door fault.' },
          { start_ms: 900, end_ms: 1900, text: 'Replaced the door control module.' },
        ],
        provider: 'fake-whisper',
        model,
      };
    },
  };
  const { service, artifactStore } = await fixture(t, 'audio', { whisper });
  const created = await busSession(service, 'AUDIO');
  const wav = pcmWav({ samples: 333 });
  const result = await service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: wav,
    model: 'base.en',
    language: 'auto',
    idempotency_key: 'audio-capture-1',
  });

  assert.deepEqual(persistedBytes, wav);
  assert.equal(await artifactStore.hasAudio(result.audio.audio_id), true);
  assert.equal(result.evidence.source_hash, result.audio.source_hash);
  assert.equal(result.transcript.provider, 'fake-whisper');
  assert.equal(result.transcript.model, 'base.en');
  assert.equal(result.transcript.language, 'en');
  assert.deepEqual(result.transcript.segments, [
    { start_ms: 0, end_ms: 900, text: 'Bus MAN A95 had a door fault.' },
    { start_ms: 900, end_ms: 1900, text: 'Replaced the door control module.' },
  ]);
  assert.equal(result.transcript.context_binding.context_id, 'SBS/BUS');
  assert.equal(result.session.phase, 'RESOLVE');
});

test('same-source retry is idempotent and never duplicates audio, evidence, transcript, or candidates', async (t) => {
  let calls = 0;
  const whisper = {
    transcribe: async (_audioPath, { model }) => {
      calls += 1;
      return {
        raw_text: 'Bus MAN A95 had a door fault.',
        language: 'en', segments: [], provider: 'fake-whisper', model,
      };
    },
  };
  const { service, sessionStore } = await fixture(t, 'same-source', { whisper });
  const created = await busSession(service, 'SAME');
  const input = {
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: pcmWav({ samples: 401 }),
    model: 'base.en', language: 'en', idempotency_key: 'same-source-key',
  };
  const first = await service.captureAudio(input);
  const second = await service.captureAudio({ ...input, expected_revision: first.session.revision });
  const chain = await sessionStore.loadChain(created.session.session_id);

  assert.equal(calls, 1);
  assert.equal(second.reused, true);
  assert.equal(second.session.revision, first.session.revision);
  assert.equal(second.evidence.evidence_id, first.evidence.evidence_id);
  assert.equal(second.transcript.transcript_id, first.transcript.transcript_id);
  assert.deepEqual(second.candidates.map((item) => item.candidate_id), first.candidates.map((item) => item.candidate_id));
  assert.equal(chain.evidence.length, 1);
  assert.equal(chain.transcripts.length, 1);
  assert.equal(chain.field_candidates.length, first.candidates.length);
});

test('same technician text identity reuses the authoritative chain without another revision', async (t) => {
  const { service, sessionStore } = await fixture(t, 'same-text');
  const created = await busSession(service, 'SAME-TEXT');
  const input = {
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault.',
    language: 'en',
    idempotency_key: 'same-text-key',
  };
  const first = await service.captureText(input);
  const second = await service.captureText({ ...input, expected_revision: first.session.revision });
  const chain = await sessionStore.loadChain(created.session.session_id);

  assert.equal(second.reused, true);
  assert.equal(second.session.revision, first.session.revision);
  assert.equal(second.evidence.evidence_id, first.evidence.evidence_id);
  assert.equal(second.transcript.transcript_id, first.transcript.transcript_id);
  assert.equal(chain.evidence.length, 1);
  assert.equal(chain.transcripts.length, 1);
});

test('a custom idempotency key cannot reuse a transcript for different audio bytes', async (t) => {
  let calls = 0;
  const whisper = {
    transcribe: async (_audioPath, { model }) => {
      calls += 1;
      return { raw_text: 'Bus MAN A95 had a door fault.', language: 'en', segments: [], provider: 'fake-whisper', model };
    },
  };
  const { service } = await fixture(t, 'key-reuse', { whisper });
  const created = await busSession(service, 'KEY');
  const first = await service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: pcmWav({ samples: 402 }),
    model: 'base.en', language: 'en', idempotency_key: 'adversarial-key',
  });

  await assert.rejects(service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: first.session.revision,
    wav_buffer: pcmWav({ samples: 403 }),
    model: 'base.en', language: 'en', idempotency_key: 'adversarial-key',
  }), { code: 'IDEMPOTENCY_KEY_REUSE' });
  assert.equal(calls, 1);
});

test('STT failure preserves bound audio and retry succeeds without duplicating evidence', async (t) => {
  let calls = 0;
  const whisper = {
    transcribe: async (_audioPath, { model }) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('Whisper unavailable.'), {
          code: 'STT_RUNTIME_MISSING', status: 503, retryable: true,
        });
      }
      return { raw_text: 'Bus MAN A95 had a door fault.', language: 'en', segments: [], provider: 'fake-whisper', model };
    },
  };
  const { service, artifactStore, sessionStore } = await fixture(t, 'failure-retry', { whisper });
  const created = await busSession(service, 'RETRY');
  const failed = await service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: pcmWav({ samples: 404 }),
    model: 'base.en', language: 'en', idempotency_key: 'retry-key',
  });

  assert.equal(failed.session.phase, 'RECOVERABLE_ERROR');
  assert.equal(failed.session.recovery_phase, 'PROCESSING');
  assert.equal(failed.failure.code, 'STT_RUNTIME_MISSING');
  assert.equal(failed.next_action, 'RETRY_TRANSCRIPTION');
  assert.equal(failed.transcript, null);
  assert.equal(await artifactStore.hasAudio(failed.audio.audio_id), true);
  assert.equal((await sessionStore.loadChain(created.session.session_id)).transcripts.length, 0);

  const recovered = await service.retryTranscription({
    session_id: created.session.session_id,
    expected_revision: failed.session.revision,
    evidence_id: failed.evidence.evidence_id,
  });
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(recovered.session.phase, 'RESOLVE');
  assert.equal(recovered.evidence.evidence_id, failed.evidence.evidence_id);
  assert.equal(calls, 2);
  assert.equal(chain.evidence.length, 1);
  assert.equal(chain.transcripts.length, 1);

  const duplicate = await service.retryTranscription({
    session_id: created.session.session_id,
    expected_revision: recovered.session.revision,
    evidence_id: failed.evidence.evidence_id,
  });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.session.revision, recovered.session.revision);
  assert.equal(calls, 2);
});

test('malformed audio creates no session mutation or evidence binding', async (t) => {
  const { service, sessionStore } = await fixture(t, 'malformed');
  const created = await busSession(service, 'MALFORMED');

  await assert.rejects(service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: 0,
    wav_buffer: Buffer.from('not a wave file'),
    idempotency_key: 'malformed-key',
  }));
  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.equal(chain.session.phase, 'CONTEXT');
  assert.equal(chain.session.revision, 0);
  assert.deepEqual(chain.evidence, []);
  assert.deepEqual(chain.transcripts, []);
});

test('material domain terminology enters CORRECTION_IF_NEEDED without creating structured candidates', async (t) => {
  const { service } = await fixture(t, 'material-review');
  const created = await busSession(service, 'MATERIAL');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus MAN 9-5 had a door fault. Replaced the door control module.',
    language: 'en',
  });

  assert.equal(result.session.phase, 'CORRECTION_IF_NEEDED');
  assert.equal(result.next_action, 'REVIEW_TRANSCRIPT');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.review.status, 'PENDING');
  assert.ok(result.review.items.some((item) => item.proposed_text === 'MAN A95'));
  const item = result.review.items.find((candidate) => candidate.proposed_text === 'MAN A95');
  assert.equal(result.transcript.raw_text.slice(item.source_span.start, item.source_span.end), item.source_span.quote);
});

test('rejecting a material correction preserves raw text and records immutable server-owned decision history', async (t) => {
  const { service, sessionStore } = await fixture(t, 'reject-review');
  const created = await busSession(service, 'REJECT');
  const rawText = 'Bus MAN 9-5 had a door fault. Replaced the door control module.';
  const pending = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: rawText,
    language: 'en',
  });
  const item = pending.review.items.find((candidate) => candidate.proposed_text === 'MAN A95');
  const decided = await service.decideTranscriptReview({
    session_id: created.session.session_id,
    expected_revision: pending.session.revision,
    review_id: pending.review.review_id,
    decisions: [{ review_item_id: item.review_item_id, decision: 'REJECT' }],
  });
  const chain = await sessionStore.loadChain(created.session.session_id);

  assert.equal(decided.session.phase, 'RESOLVE');
  assert.equal(decided.transcript.raw_text, rawText);
  assert.equal(decided.review.status, 'REVIEWED');
  assert.equal(decided.review.reviewer_principal_ref, 'principal:demo-technician');
  assert.deepEqual(decided.review.decisions, [{ review_item_id: item.review_item_id, decision: 'REJECT' }]);
  assert.equal(chain.transcript_reviews.length, 2);
  assert.equal(chain.transcripts.length, 1);
  assert.equal(chain.transcripts[0].raw_text, rawText);
  assert.equal(decided.candidates.some((candidate) => candidate.field_id === 'asset.bus_model'), false);
  assert.deepEqual(chain.audit_events.map((event) => event.event_type), [
    'SESSION_CREATED',
    'EVIDENCE_CAPTURED',
    'PROCESSING_STARTED',
    'TRANSCRIPT_REVIEW_REQUESTED',
    'TRANSCRIPT_REVIEW_DECIDED',
  ]);
});

test('accepting a material correction preserves raw evidence while candidates retain raw-span provenance', async (t) => {
  const { service, sessionStore } = await fixture(t, 'accept-review');
  const created = await busSession(service, 'ACCEPT');
  const rawText = 'Bus MAN 9-5 had a door fault. Replaced the door control module.';
  const pending = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: rawText,
    language: 'en',
  });
  const item = pending.review.items.find((candidate) => candidate.proposed_text === 'MAN A95');
  const decided = await service.decideTranscriptReview({
    session_id: created.session.session_id,
    expected_revision: pending.session.revision,
    review_id: pending.review.review_id,
    decisions: [{ review_item_id: item.review_item_id, decision: 'ACCEPT' }],
  });
  const model = decided.candidates.find((candidate) => candidate.field_id === 'asset.bus_model');
  const span = await sessionStore.readRecord('evidence-spans', model.evidence_refs[0].span_id);

  assert.equal(decided.transcript.raw_text, rawText);
  assert.equal(decided.review.decisions[0].corrected_text, 'MAN A95');
  assert.equal(model.claim.value, 'MAN A95');
  assert.equal(rawText.slice(span.start_offset, span.end_offset), 'Bus MAN 9-5 had a door fault');
  assert.equal(span.quote_hash.startsWith('sha256:'), true);
  assert.equal((await sessionStore.loadChain(created.session.session_id)).transcripts[0].raw_text, rawText);
});
