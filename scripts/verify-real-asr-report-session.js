import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { WhisperProvider } from '../src/providers/whisper.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

const audioPath = process.argv[2] && path.resolve(process.argv[2]);
if (!audioPath) throw new Error('Usage: node scripts/verify-real-asr-report-session.js <16-kHz-mono-wav>');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verificationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'report-session-real-asr-'));
const now = () => '2026-09-27T10:42:00.000Z';
const contextFields = [
  ['work.work_order_id', 'WO-ASR-001'], ['work.date_time', '2026-09-27 10:42'],
  ['asset.internal_fleet_no', '8300-354'], ['asset.registration_no', 'SBS6025Z'],
  ['asset.bus_model', 'MAN A95'], ['measurement.odometer_km', 51020, 'km'],
  ['asset.depot', 'Hougang Depot'], ['technician.name', 'Alex Tan'],
  ['work.trigger', 'Passenger door would not close'],
  ['inspection_findings', 'Door controller connector was loose'],
  ['diagnosis.root_cause', 'Root cause not established'],
  ['work_performed', 'Reseated and secured the connector'],
  ['test.result', 'Door cycle test completed five times'],
  ['completion.outstanding_issues', 'None'], ['completion.state', 'NOT_READY'],
].map(([field_id, value, unit]) => ({ field_id, value, ...(unit ? { unit } : {}) }));

try {
  const sessionStore = new ReportSessionStore({ root: path.join(verificationRoot, 'authority') });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(verificationRoot, 'artifacts') }),
    sessionStore,
    whisperProvider: new WhisperProvider({
      runtimeRoot: path.join(projectRoot, 'runtime', 'stt', `${process.platform}-${process.arch}`),
      tempRoot: path.join(verificationRoot, 'whisper'),
      timeoutMs: 120_000,
    }),
    jobContextProvider: { resolve: async ({ job_context_ref: ref }) => ({ record_id: ref, version: 'real-asr-check.v1', fields: contextFields }) },
    clock: now,
  });
  const created = await service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0',
    job_context_ref: 'work-order:WO-ASR-001',
  });
  const started = performance.now();
  let current = await service.captureAudio({
    session_id: created.session.session_id,
    expected_revision: created.session.revision,
    wav_buffer: await fs.readFile(audioPath),
    model: 'base',
    language: 'en',
    idempotency_key: 'real-asr-report-session-v1',
  });
  const captureMs = Math.round(performance.now() - started);
  if (!current.transcript) throw new Error(`Real ASR capture failed: ${current.failure?.code || 'unknown'}`);
  const asrTranscript = current.transcript;
  if (current.review?.status === 'PENDING') {
    current = await service.decideTranscriptReview({
      session_id: current.session.session_id,
      expected_revision: current.session.revision,
      review_id: current.review.review_id,
      decisions: current.review.items.map((item) => ({ review_item_id: item.review_item_id, decision: 'REJECT' })),
    });
  }
  let answers = 0;
  while (current.agent_state.resolution_queue.length) {
    const item = current.agent_state.resolution_queue[0];
    const field = current.agent_state.report_fields.find((entry) => entry.field_id === item.field_id);
    const candidate = field?.candidates.find((entry) => entry.support_type === 'AUTHORITATIVE_SYSTEM_DATA') || field?.candidates[0];
    current = await service.answerResolutionItem({
      session_id: current.session.session_id,
      expected_revision: current.session.revision,
      resolution_id: item.resolution_id,
      answer: candidate
        ? { kind: 'SELECT_CANDIDATE', candidate_id: candidate.candidate_id }
        : { kind: 'VALUE', value: 'Not established' },
      idempotency_key: `real-asr-answer-${answers}`,
    });
    answers += 1;
  }
  const review = await service.enterReview({
    session_id: current.session.session_id,
    expected_revision: current.session.revision,
  });
  const chain = await sessionStore.loadChain(review.session.session_id);
  const transcriptCandidates = chain.field_candidates.filter((candidate) => candidate.support_type === 'TRANSCRIPT_EVIDENCE');
  console.log(JSON.stringify({
    real_asr: 'RUN',
    provider: asrTranscript.provider,
    model: asrTranscript.model,
    language: asrTranscript.language,
    transcript: asrTranscript.raw_text,
    capture_to_structured_ms: captureMs,
    transcript_candidate_fields: transcriptCandidates.map((candidate) => candidate.field_id),
    transcript_candidate_count: transcriptCandidates.length,
    resolution_answers: answers,
    final_phase: review.session.phase,
    final_revision: review.session.revision,
    evidence_count: chain.evidence.length,
    transcript_count: chain.transcripts.length,
  }, null, 2));
} finally {
  await fs.rm(verificationRoot, { recursive: true, force: true });
}
