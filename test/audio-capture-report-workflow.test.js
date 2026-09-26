import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportStore } from '../src/storage/reports.js';
import {
  captureAudioForReport,
  completeHvacAudioReport,
} from '../src/workflows/audio-capture-report.js';
import { templateFor } from '../web/template-catalog.js';
import { pcmWav } from './helpers.js';

function fakeWhisper(rawText) {
  return {
    transcribe: async (_audioPath, { model, language }) => ({
      raw_text: rawText,
      language: language === 'auto' ? 'en' : language,
      segments: [{ start_ms: 0, end_ms: 1200, text: rawText }],
      provider: 'fake-whisper',
      model,
    }),
  };
}

async function stores(t, name) {
  const root = path.resolve('.tmp-tests', `audio-capture-report-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    artifactStore: new ArtifactStore({ root }),
    reportStore: new ReportStore({ root }),
  };
}

test('captured SBS audio is preserved, transcribed, extracted, and bound to the selected template draft', async (t) => {
  const { artifactStore, reportStore } = await stores(t, 'sbs');
  const result = await captureAudioForReport({
    wavBuffer: pcmWav(),
    template: templateFor('bus-defect-rectification-corrective-maintenance'),
    reportSessionId: 'capture_session_bus_1',
    artifactStore,
    reportStore,
    whisperProvider: fakeWhisper('Bus 3050 had an intermittent door fault. Replaced the door control module. Function test passed.'),
    traceId: 'trace_capture_sbs',
  });

  assert.match(result.data.audio.audio_id, /^audio_[a-f0-9]{24}$/);
  assert.equal(await artifactStore.hasAudio(result.data.audio.audio_id), true);
  assert.equal(result.data.transcript.audio_id, result.data.audio.audio_id);
  assert.equal(result.data.transcript.input_mode, 'VOICE_TRANSCRIPT');
  assert.deepEqual(result.data.transcript.report_binding, {
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0',
    report_session_id: 'capture_session_bus_1',
  });
  assert.ok(result.data.facts.some((fact) => fact.field === 'work_performed'));
  assert.equal(result.data.draft.template_id, 'bus-defect-rectification-corrective-maintenance');
  assert.equal(result.data.draft.report_session_id, 'capture_session_bus_1');
  assert.match(result.data.validation_receipt.validator_run_id, /^trace_/);
  assert.equal(result.data.next_action, 'RESOLVE_REPORT_FIELDS');
});

test('captured HVAC audio stops at transcript review before facts or a report are generated', async (t) => {
  const { artifactStore, reportStore } = await stores(t, 'hvac-review');
  const result = await captureAudioForReport({
    wavBuffer: pcmWav(),
    template: templateFor('hvac-service-report'),
    reportSessionId: 'capture_session_hvac_1',
    artifactStore,
    reportStore,
    whisperProvider: fakeWhisper('换了一个三十五微法电容。'),
    traceId: 'trace_capture_hvac_review',
  });

  assert.equal(result.status, 'NEEDS_CONFIRMATION');
  assert.equal(result.data.next_action, 'CONFIRM_TRANSCRIPT');
  assert.match(result.data.correction_review.candidate_bundle_hash, /^sha256:/);
  assert.ok(result.data.correction_review.candidates.length > 0);
  assert.equal(Object.hasOwn(result.data, 'facts'), false);
  assert.equal(Object.hasOwn(result.data, 'draft'), false);
});

test('a transcription failure still returns the immutable audio artifact for an explicit retry', async (t) => {
  const { artifactStore, reportStore } = await stores(t, 'retry');
  const providerError = Object.assign(new Error('Whisper runtime is unavailable.'), {
    code: 'STT_RUNTIME_MISSING', status: 503, retryable: false,
  });
  const result = await captureAudioForReport({
    wavBuffer: pcmWav(),
    template: templateFor('rail-track-inspection-maintenance'),
    reportSessionId: 'capture_session_retry_1',
    artifactStore,
    reportStore,
    whisperProvider: { transcribe: async () => { throw providerError; } },
    traceId: 'trace_capture_retry',
  });

  assert.equal(result.status, 'FAIL');
  assert.equal(result.error_code, 'STT_RUNTIME_MISSING');
  assert.equal(result.data.next_action, 'RETRY_TRANSCRIPTION');
  assert.equal(await artifactStore.hasAudio(result.data.audio.audio_id), true);
  assert.equal(result.data.transcript, null);
});

test('confirmed HVAC transcript review generates facts receipt and an exact-template draft', async (t) => {
  const { artifactStore, reportStore } = await stores(t, 'hvac-complete');
  const started = await captureAudioForReport({
    wavBuffer: pcmWav(),
    template: templateFor('hvac-service-report'),
    reportSessionId: 'capture_session_hvac_2',
    artifactStore,
    reportStore,
    whisperProvider: fakeWhisper('客户反映不制冷。检查发现电容损坏。换了一个三十五微法电容。试机运行正常。问题已解决。'),
    traceId: 'trace_capture_hvac_start',
  });
  const review = started.data.correction_review;
  const completed = await completeHvacAudioReport({
    template: templateFor('hvac-service-report'),
    reportSessionId: 'capture_session_hvac_2',
    transcriptArtifactId: started.data.transcript.artifact_id,
    candidateBundleHash: review.candidate_bundle_hash,
    decisions: review.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      decision: 'ACCEPT',
      critical_value_confirmed: true,
    })),
    technicianId: 'TECH-007',
    technicianName: 'Alex Tan',
    artifactStore,
    reportStore,
    traceId: 'trace_capture_hvac_complete',
  });

  assert.match(completed.data.correction_receipt.correction_receipt_id, /^correction_/);
  assert.match(completed.data.facts_receipt_id, /^facts_/);
  assert.ok(completed.data.facts.length > 0);
  assert.equal(completed.data.draft.template_id, 'hvac-service-report');
  assert.equal(completed.data.draft.report_session_id, 'capture_session_hvac_2');
  assert.equal(completed.data.next_action, 'RESOLVE_REPORT_FIELDS');
});

test('HVAC completion rejects a transcript rebound to another report session', async (t) => {
  const { artifactStore, reportStore } = await stores(t, 'binding-mismatch');
  const started = await captureAudioForReport({
    wavBuffer: pcmWav(),
    template: templateFor('hvac-service-report'),
    reportSessionId: 'capture_session_original',
    artifactStore,
    reportStore,
    whisperProvider: fakeWhisper('换了一个三十五微法电容。'),
    traceId: 'trace_capture_binding_start',
  });
  const review = started.data.correction_review;

  await assert.rejects(completeHvacAudioReport({
    template: templateFor('hvac-service-report'),
    reportSessionId: 'capture_session_rebound',
    transcriptArtifactId: started.data.transcript.artifact_id,
    candidateBundleHash: review.candidate_bundle_hash,
    decisions: review.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      decision: 'REJECT',
      critical_value_confirmed: true,
    })),
    technicianId: 'TECH-007',
    technicianName: 'Alex Tan',
    artifactStore,
    reportStore,
    traceId: 'trace_capture_binding_complete',
  }), { code: 'CAPTURE_BINDING_MISMATCH' });
});
