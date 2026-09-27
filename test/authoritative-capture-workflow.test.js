import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { hashContract } from '../src/domain/index.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';
import { pcmWav } from './helpers.js';

async function fixture(t, name, { whisper, templateProvider, modelResolver } = {}) {
  const root = path.resolve('.tmp-tests', `authoritative-capture-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'authority') });
  const service = new AuthoritativeCaptureService({
    artifactStore,
    sessionStore,
    whisperProvider: whisper || { transcribe: async () => { throw new Error('Unexpected transcription.'); } },
    modelResolver,
    templateProvider,
    clock: () => '2026-09-27T06:00:00.000Z',
  });
  return { root, artifactStore, sessionStore, service };
}

test('published manual-schema templates open in the authoritative workflow and remain technician-resolvable', async (t) => {
  const customTemplate = {
    templateId: 'qa-pump-checklist', name: 'QA Pump Checklist', status: 'PUBLISHED', templateVersion: '1.0.0',
    domain: 'CUSTOM',
    schema: {
      id: 'qa-pump-checklist-schema', version: '1.0.0',
      fields: [
        { id: 'asset.id', label: 'Asset ID', section: 'Report fields', type: 'string', required: true },
        { id: 'inspection.result', label: 'Inspection result', section: 'Report fields', type: 'text', required: true },
      ],
    },
    contextCorpus: { id: 'qa-pump-checklist-context', version: '1.0.0', sources: [] },
    adapter: { id: 'manual-schema-v1', version: '1.0.0' },
  };
  const { service } = await fixture(t, 'custom-template', {
    templateProvider: async (templateId) => (templateId === customTemplate.templateId ? structuredClone(customTemplate) : null),
  });

  const created = await service.createSession({
    template_id: customTemplate.templateId,
    template_version: customTemplate.templateVersion,
    job_context_ref: 'new-report:custom-template-test',
  });
  assert.equal(created.session.context_binding.scope_id, 'CUSTOM');
  assert.equal(created.agent_state.resolution_queue.length, 2);

  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'Pump P-101 was inspected.',
    language: 'en',
    idempotency_key: 'custom-template-capture',
  });
  assert.equal(captured.transcript.raw_text, 'Pump P-101 was inspected.');
  assert.equal(captured.candidates.length, 0);
  assert.equal(captured.agent_state.resolution_queue.length, 2);

  let current = captured;
  for (const value of ['P-101', 'Inspection completed; no leak observed.']) {
    const item = current.agent_state.resolution_queue[0];
    current = await service.answerResolutionItem({
      session_id: created.session.session_id,
      expected_revision: current.session.revision,
      resolution_id: item.resolution_id,
      answer: { kind: 'VALUE', value },
      idempotency_key: `custom-template-answer-${item.field_id}`,
    });
  }
  assert.equal(current.agent_state.completeness.complete, true);
  assert.equal(current.agent_state.resolution_queue.length, 0);
});

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

test('transcript measurements become numeric server candidates while preserving exact units', async (t) => {
  const { service } = await fixture(t, 'numeric-measurement');
  const created = await busSession(service, 'MEASUREMENT');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'The odometer was 51020 km.',
    language: 'en',
    idempotency_key: 'measurement-capture-1',
  });
  const candidate = result.candidates.find((entry) => entry.field_id === 'measurement.odometer_km');
  assert.deepEqual(candidate.claim.value, { value: 51020, unit: 'km' });
  const field = result.agent_state.report_fields.find((entry) => entry.field_id === 'measurement.odometer_km');
  assert.equal(field.state, 'KNOWN_VALUE');
  const issue = result.agent_state.validation_issues.find((entry) => entry.field_id === 'measurement.odometer_km');
  assert.equal(issue.code, 'CRITICAL_CONFIRMATION_REQUIRED');
  assert.equal(issue.blocking, true);
  const resolution = result.agent_state.resolution_queue.find((entry) => entry.field_id === 'measurement.odometer_km');
  assert.equal(resolution.type, 'SAFETY_CONFIRMATION');
});

test('ordinary text capture uses the selected fact-centric interpretation even without a correction screen', async (t) => {
  const { service } = await fixture(t, 'fact-centric-no-review');
  const created = await busSession(service, 'NO-REVIEW');
  const result = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: 'The passenger door would not close. Inspection found a loose connector. No outstanding issues.',
    language: 'en',
    idempotency_key: 'fact-centric-no-review-1',
  });
  assert.equal(result.review, null);
  assert.deepEqual(
    result.candidates.filter((candidate) => candidate.field_id === 'inspection_findings').map((candidate) => candidate.claim.value),
    ['Inspection found a loose connector'],
  );
  const outstanding = result.agent_state.report_fields.find((field) => field.field_id === 'completion.outstanding_issues');
  assert.equal(outstanding.state, 'EXPLICIT_NONE');
  assert.equal(result.agent_state.resolution_queue.some((item) => item.field_id === 'completion.outstanding_issues'), false);
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

test('audio capture snapshots the server-configured model for an in-flight job and ignores a client override', async (t) => {
  const used = [];
  let selected = 'small';
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  let continueFirst;
  const firstCanFinish = new Promise((resolve) => { continueFirst = resolve; });
  const whisper = { transcribe: async (_audioPath, { model }) => {
    used.push(model);
    if (used.length === 1) {
      releaseFirst();
      await firstCanFinish;
    }
    return { raw_text: 'Bus MAN A95 had a door fault.', language: 'en', segments: [], provider: 'fake-whisper', model };
  } };
  const { service } = await fixture(t, 'configured-model', { whisper, modelResolver: async () => selected });
  const firstSession = await busSession(service, 'CONFIGURED-ONE');
  const firstPending = service.captureAudio({
    session_id: firstSession.session.session_id, expected_revision: 0,
    wav_buffer: pcmWav({ samples: 177 }), model: 'tiny', language: 'en', idempotency_key: 'configured-one',
  });
  await firstStarted;
  selected = 'medium';
  continueFirst();
  const first = await firstPending;
  const secondSession = await busSession(service, 'CONFIGURED-TWO');
  const second = await service.captureAudio({
    session_id: secondSession.session.session_id, expected_revision: 0,
    wav_buffer: pcmWav({ samples: 179 }), model: 'tiny', language: 'en', idempotency_key: 'configured-two',
  });
  assert.deepEqual(used, ['small', 'medium']);
  assert.equal(first.transcript.model, 'small');
  assert.equal(second.transcript.model, 'medium');
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
  assert.equal(item.impact_class, 'MATERIAL');
  assert.deepEqual(item.affected_fields, ['asset.bus_model', 'inspection_findings']);
  assert.equal(result.transcript.raw_text.slice(item.source_span.start, item.source_span.end), item.source_span.quote);
});

test('a correction outside mapped report claims does not interrupt the technician', async (t) => {
  const { service } = await fixture(t, 'non-material-review');
  const created = await service.createSession({
    template_id: 'hvac-service-report',
    template_version: '1.0.0',
    job_context_ref: 'job-context:HVAC-NON-MATERIAL',
  });
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: '备注：制冷记。',
    language: 'zh',
  });

  assert.equal(captured.session.phase, 'RESOLVE');
  assert.equal(captured.review, null);
  assert.equal(captured.next_action, 'RESOLVE_REPORT_FIELDS');
  assert.deepEqual(captured.candidates, []);
});

test('fact confirmations use ResolveQueue instead of masquerading as transcript corrections', async (t) => {
  const { service } = await fixture(t, 'fact-confirmation');
  const created = await busSession(service, 'FACT-CONFIRMATION');
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus SG3050Z had a door fault.',
    language: 'en',
  });

  assert.equal(captured.session.phase, 'RESOLVE');
  assert.equal(captured.review, null);
  const resolution = captured.agent_state.resolution_queue.find((item) => item.field_id === 'asset.registration_no');
  assert.equal(resolution.type, 'SAFETY_CONFIRMATION');
  assert.equal(resolution.answer_type, 'CONFIRM_OR_REPLACE');
  const source = captured.candidates.find((candidate) => candidate.field_id === 'asset.registration_no');
  const confirmed = await service.answerResolutionItem({
    session_id: captured.session.session_id,
    expected_revision: captured.session.revision,
    resolution_id: resolution.resolution_id,
    answer: { kind: 'SELECT_CANDIDATE', candidate_id: source.candidate_id },
    idempotency_key: 'confirm-registration-identity',
  });

  assert.equal(confirmed.candidate.support_type, 'TECHNICIAN_CONFIRMATION');
  assert.equal(confirmed.candidate.confirmed_candidate_id, confirmed.source_candidate.candidate_id);
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
  assert.equal(model.correction_provenance.transcript_review_id, decided.review.review_id);
  assert.equal(model.correction_provenance.raw_text_hash, decided.transcript.text_hash);
  assert.match(model.correction_provenance.effective_projection_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(model.correction_provenance.decisions, [{
    review_item_id: item.review_item_id,
    decision: 'ACCEPT',
  }]);
  assert.equal(rawText.slice(span.start_offset, span.end_offset), 'Bus MAN 9-5 had a door fault');
  assert.equal(span.quote_hash.startsWith('sha256:'), true);
  assert.equal((await sessionStore.loadChain(created.session.session_id)).transcripts[0].raw_text, rawText);
});

test('accepted terminology correction adds only correction-eligible facts and cannot invent an inspection action', async (t) => {
  const { service, sessionStore } = await fixture(t, 'fact-centric-correction');
  const created = await service.createSession({
    template_id: 'rail-maintenance-completion-handover',
    template_version: '1.0.0',
    job_context_ref: 'job-context:RAIL-SEMANTIC-TRAP',
  });
  const rawText = 'Door control module 40 was mentioned during inspection.';
  const pending = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    text: rawText,
    language: 'en',
  });
  assert.equal(pending.session.phase, 'CORRECTION_IF_NEEDED');

  const decided = await service.decideTranscriptReview({
    session_id: created.session.session_id,
    expected_revision: pending.session.revision,
    review_id: pending.review.review_id,
    decisions: pending.review.items.map((item) => ({
      review_item_id: item.review_item_id,
      decision: item.kind === 'CORRECTION' ? 'ACCEPT' : 'NO_CHANGE',
    })),
  });

  const fields = new Set(decided.candidates.map((candidate) => candidate.field_id));
  assert.ok(fields.has('parts.part_number'));
  assert.ok(!fields.has('inspection_findings'));
  assert.ok(!fields.has('work_performed'));
  for (const candidate of decided.candidates) {
    const span = await sessionStore.readRecord('evidence-spans', candidate.evidence_refs[0].span_id);
    assert.equal(span.quote_hash, hashContract(rawText.slice(span.start_offset, span.end_offset)));
  }
});
