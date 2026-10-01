import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authorizeApiRequest,
  canBootstrapLocalSession,
  issuePublicSession,
  resolveServerConfig,
  securityHeaders,
  startupMessages,
  validateRequestContext,
  validateRequestHost,
  verifyPublicPassword,
} from './network-security.js';
import { ArtifactStore } from './storage/artifacts.js';
import { ReportStore } from './storage/reports.js';
import { TemplateStore } from './storage/templates.js';
import { ReportSessionStore } from './storage/report-sessions.js';
import { WorkOrderStore } from './storage/work-orders.js';
import { WhisperProvider } from './providers/whisper.js';
import { WhisperModelManager } from './providers/whisper-model-manager.js';
import { SpeechToTextConfigStore } from './config/speech-to-text.js';
import { LocalSpeechToTextService } from './services/local-speech-to-text.js';
import { AudioJobQueue } from './services/audio-jobs.js';
import { OllamaProvider } from './providers/ollama.js';
import { normalizeHvacTranscript } from './tools/normalize-hvac-transcript.js';
import { extractServiceFacts } from './tools/extract-service-facts.js';
import { generateReportDraft } from './tools/generate-report-draft.js';
import { buildTranscriptCorrectionCandidates, retrieveHvacKnowledge, retrieveReportTemplate } from './tools/hvac-knowledge.js';
import { planReportSections } from './tools/plan-report-sections.js';
import { toolEnvelope } from './tools/tool-envelope.js';
import { validateReportDraft } from './tools/validate-report-draft.js';
import { validateReportInput } from './tools/validate-report-input.js';
import { hashValue } from './tools/report-integrity.js';
import { extractV2Facts } from './tools/extract-v2-facts.js';
import { loadScopeRegistry, resolveContext } from './v2/scope.js';
import { createUploadStore, ingestDocument } from './v2/upload.js';
import { createRetriever } from './v2/retrieval.js';
import { reviewV2Transcript } from './v2/transcript-review.js';
import { retrieveTemplateContext } from './templates/context.js';
import { buildFollowUpQuestions, buildGateConfirmationQuestions } from './v2/guided-reporting.js';
import {
  assertNoServiceFactInvention,
  buildBusReportSections,
  buildIndustrialReportSections,
  buildRailReportSections,
  checkHardGates,
  planV2Report,
} from './v2/report-builder.js';
import {
  createReportSession,
  evaluateCompleteness,
  factsFromStructuredState,
  mapFactsToStructuredState,
  structuredStateSnapshot,
} from '../web/report-runtime.js';
import { listPredefinedTemplates, templateFor } from '../web/template-catalog.js';
import { AuthoritativeCaptureService } from './workflows/authoritative-capture.js';
import { officialFactsFromAgentState } from './agent/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(projectRoot, 'web');
const dataRoot = path.join(projectRoot, 'data');
const tempRoot = path.join(projectRoot, '.tmp', 'stt');
const runtimeRoot = path.join(projectRoot, 'runtime', 'stt', `${process.platform}-${process.arch}`);
const maxAudioBytes = 20 * 1024 * 1024;
const maxJsonBytes = 512 * 1024;
const maxUploadBytes = 20 * 1024 * 1024;

const artifacts = new ArtifactStore({ root: dataRoot });
const reports = new ReportStore({ root: dataRoot });
const templates = new TemplateStore({ root: path.join(dataRoot, 'templates') });
const whisperModelManager = new WhisperModelManager({ runtimeRoot });
const speechToTextConfig = new SpeechToTextConfigStore({ filePath: path.join(dataRoot, 'settings', 'speech-to-text.json') });
const speechToText = new LocalSpeechToTextService({ configStore: speechToTextConfig, modelManager: whisperModelManager });
const whisper = new WhisperProvider({ runtimeRoot, tempRoot, modelManager: whisperModelManager });
const ollama = new OllamaProvider();
const reportSessions = new ReportSessionStore({ root: path.join(dataRoot, 'report-session-authority') });
const workOrders = new WorkOrderStore({ root: path.join(dataRoot, 'work-orders') });
// V2 wiring: one upload store and one lazily-loaded scope registry shared by
// every /api/v2/* route. Uploads land under data/v2-uploads (auto-mkdir in
// createUploadStore.put; directory is gitignored except for .gitkeep).
const v2UploadStore = createUploadStore({ baseDir: path.join(projectRoot, 'data', 'v2-uploads') });
let v2RegistryPromise = null;
function ensureV2Registry() {
  v2RegistryPromise ??= loadScopeRegistry();
  return v2RegistryPromise;
}

const authoritativeCapture = new AuthoritativeCaptureService({
  artifactStore: artifacts,
  sessionStore: reportSessions,
  whisperProvider: whisper,
  modelResolver: () => speechToText.resolveModel(),
  semanticProvider: ollama,
  semanticModel: String(process.env.HVAC_OLLAMA_MODEL || ''),
  principalRef: process.env.HVAC_PUBLIC_USER ? `principal:${process.env.HVAC_PUBLIC_USER}` : 'principal:demo-technician',
  scopeRegistryProvider: ensureV2Registry,
  uploadStore: v2UploadStore,
  templateProvider: async (templateId) => (
    (await templates.listPublished()).find((item) => item.templateId === templateId) || null
  ),
  jobContextProvider: workOrders,
});

function resolveV2ContextOrThrow(contextId, registry) {
  try {
    return resolveContext(contextId, registry);
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: 'UNKNOWN_CONTEXT', status: 400 });
  }
}

function writeJson(response, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...securityHeaders({ api: true }),
  });
  response.end(body);
}

function safeDownloadFilename(value) {
  const filename = String(value || 'confirmed-report.pdf').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return filename && filename.toLowerCase().endsWith('.pdf') ? filename : 'confirmed-report.pdf';
}

function writePdfDownload(response, result) {
  const body = Buffer.from(String(result?.content_base64 || ''), 'base64');
  if (result?.mime_type !== 'application/pdf' || body.length < 5 || body.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw Object.assign(new Error('The confirmed report export is not a valid PDF.'), {
      code: 'INVALID_PDF_EXPORT', status: 500,
    });
  }
  response.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': body.length,
    'content-disposition': `attachment; filename="${safeDownloadFilename(result.filename)}"`,
    'cache-control': 'no-store',
    'x-report-snapshot-id': result.snapshot_id,
    'x-report-export-hash': result.export_hash,
    ...securityHeaders({ api: true }),
  });
  response.end(body);
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(Object.assign(new Error(`Request exceeds ${limit} bytes.`), { code: 'REQUEST_TOO_LARGE', status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const body = await readBody(request, maxJsonBytes);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON request: ${error.message}`), { code: 'INVALID_JSON', status: 400 });
  }
}

/** Collects raw request bytes (binary uploads, not JSON); routed by URL so readJson paths are untouched. */
async function readRawBody(request, limit = maxUploadBytes) {
  return readBody(request, limit);
}

const UNTRUSTED_CAPTURE_FIELDS = new Set([
  'session_id', 'revision', 'evidence_id', 'transcript_id', 'provenance', 'evidence_refs',
  'field_state', 'field_states', 'support_type', 'support_status', 'confirmed_by_technician',
  'confirmation', 'confirmation_receipt', 'server_receipt', 'reviewer_principal_ref', 'corrected_text',
  'confirmed', 'validated', 'resolved', 'draft', 'final_draft', 'report_fields', 'field_candidates',
  'snapshot', 'snapshot_ref', 'validation_ref', 'confirmation_ref',
  'facts', 'knowledge_hit', 'knowledge_hits', 'guidance_context', 'guidance_context_id',
  'guidance_context_ids', 'guidance', 'retrieval_results', 'retrieval_score', 'chunk_id',
  'scope_id', 'context_id', 'scope', 'context_binding', 'template_binding',
]);

function rejectUntrustedAuthority(input, { allow = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const allowed = new Set(allow);
  const pending = [input];
  let forged;
  while (pending.length && !forged) {
    const current = pending.pop();
    for (const [key, value] of Object.entries(current)) {
      if (UNTRUSTED_CAPTURE_FIELDS.has(key) && !allowed.has(key)) {
        forged = key;
        break;
      }
      if (value && typeof value === 'object') pending.push(value);
    }
  }
  if (forged) {
    throw Object.assign(new Error(`Client field "${forged}" cannot establish server authority.`), {
      code: 'UNTRUSTED_CAPTURE_INPUT', status: 400,
    });
  }
}

async function handleApi(request, response, url, traceId, config, services) {
  const captureService = services.authoritativeCapture;
  const workOrderService = services.workOrders || workOrders;
  const speechService = services.speechToText;
  const whisperProvider = services.whisper || whisper;
  const audioJobs = services.audioJobs;
  if (request.method === 'GET' && url.pathname === '/api/work-orders') {
    writeJson(response, 200, toolEnvelope('list_work_orders', traceId, 'PASS', { work_orders: await workOrderService.list() }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/work-orders/uploads') {
    const filename = String(request.headers['x-file-name'] || '').trim();
    const result = await workOrderService.upload({ filename, mime_type: request.headers['content-type'], bytes: await readRawBody(request, 10 * 1024 * 1024) });
    writeJson(response, 201, toolEnvelope('upload_work_order', traceId, 'PASS', { work_order: result }));
    return;
  }
  const workOrderReviewMatch = url.pathname.match(/^\/api\/work-orders\/(wo_[a-f0-9-]{36})\/review$/u);
  if (request.method === 'POST' && workOrderReviewMatch) {
    const result = await workOrderService.review(workOrderReviewMatch[1], await readJson(request));
    writeJson(response, 200, toolEnvelope('review_work_order', traceId, 'PASS', { work_order: result }));
    return;
  }
  const audioJobMatch = url.pathname.match(/^\/api\/audio-jobs\/([a-f0-9]{64})$/u);
  if (request.method === 'GET' && audioJobMatch && config.publicMode) {
    const job = await audioJobs.get(audioJobMatch[1]);
    writeJson(response, 200, toolEnvelope('get_audio_job', traceId, 'PASS', job));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/settings/speech-to-text') {
    writeJson(response, 200, toolEnvelope('speech_to_text_settings', traceId, 'PASS', await speechService.getState()));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/settings/speech-to-text') {
    const input = await readJson(request);
    const state = await speechService.selectModel(input.model);
    writeJson(response, 200, toolEnvelope('select_speech_to_text_model', traceId, 'PASS', state));
    return;
  }
  const modelInstallMatch = url.pathname.match(/^\/api\/speech-to-text\/models\/([^/]+)\/install$/u);
  if (request.method === 'POST' && modelInstallMatch) {
    await readJson(request);
    const state = await speechService.installModel(decodeURIComponent(modelInstallMatch[1]));
    writeJson(response, 200, toolEnvelope('install_speech_to_text_model', traceId, 'PASS', state));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/report-sessions') {
    const sessions = await captureService.sessionStore.listSessions();
    const reports = await Promise.all(sessions.map(async (session) => ({
      session,
      agent_state: session.current_agent_run_id
        ? (await captureService.sessionStore.readRecord('agent-runs', session.current_agent_run_id)).agent_state
        : null,
    })));
    const history = await captureService.listReportHistory();
    const historyBySession = new Map(history.map((item) => [item.session_id, item]));
    writeJson(response, 200, toolEnvelope('list_report_sessions', traceId, 'PASS', {
      sessions,
      reports: reports.map((item) => ({ ...item, history: historyBySession.get(item.session.session_id) || null })),
      history,
    }));
    return;
  }
  const vehicleHistoryMatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)\/reports$/u);
  if (request.method === 'GET' && vehicleHistoryMatch) {
    const result = await captureService.listVehicleHistory(decodeURIComponent(vehicleHistoryMatch[1]));
    writeJson(response, 200, toolEnvelope('list_vehicle_history', traceId, 'PASS', result));
    return;
  }
  const vehicleIdentityMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/vehicle-identity-review$/u);
  if (request.method === 'POST' && vehicleIdentityMatch) {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['vehicle_id', 'review_note', 'attested'].includes(key))) {
      throw Object.assign(new Error('Vehicle identity review accepts only vehicle_id, review_note and attested.'), {
        code: 'INVALID_VEHICLE_IDENTITY_REVIEW', status: 400,
      });
    }
    const link = await captureService.reviewVehicleIdentity(decodeURIComponent(vehicleIdentityMatch[1]), input);
    writeJson(response, 200, toolEnvelope('review_vehicle_identity', traceId, 'PASS', { link }));
    return;
  }
  const structuredExportMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/structured-export$/u);
  if (request.method === 'GET' && structuredExportMatch) {
    const result = await captureService.exportStructuredConfirmedSession(decodeURIComponent(structuredExportMatch[1]));
    writeJson(response, 200, toolEnvelope('export_structured_confirmed_report', traceId, 'PASS', result));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/report-sessions') {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.createSession(input);
    writeJson(response, 201, toolEnvelope('create_report_session', traceId, 'PASS', result));
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)$/u);
  if (request.method === 'GET' && sessionMatch) {
    const chain = await captureService.sessionStore.loadChain(decodeURIComponent(sessionMatch[1]));
    writeJson(response, 200, toolEnvelope('get_report_session', traceId, 'PASS', chain));
    return;
  }

  const semanticTraceMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/semantic-trace$/u);
  if (request.method === 'GET' && semanticTraceMatch) {
    const result = await captureService.getSemanticTrace(decodeURIComponent(semanticTraceMatch[1]));
    writeJson(response, 200, toolEnvelope('get_semantic_trace', traceId, 'PASS', result));
    return;
  }

  const semanticReplayMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/transcripts\/([^/]+)\/semantic-replay$/u);
  if (request.method === 'POST' && semanticReplayMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.applySemanticReplay({
      session_id: decodeURIComponent(semanticReplayMatch[1]),
      transcript_id: decodeURIComponent(semanticReplayMatch[2]),
      expected_revision: input.expected_revision,
    });
    writeJson(response, 200, toolEnvelope('apply_semantic_replay', traceId, 'PASS', result));
    return;
  }

  const agentStateMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/agent-state$/u);
  if (request.method === 'GET' && agentStateMatch) {
    const result = await captureService.getAgentState(decodeURIComponent(agentStateMatch[1]));
    writeJson(response, 200, toolEnvelope('get_report_agent_state', traceId, 'PASS', result));
    return;
  }

  const reviewStartMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/review$/u);
  if (request.method === 'POST' && reviewStartMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.enterReview({
      session_id: decodeURIComponent(reviewStartMatch[1]), expected_revision: input.expected_revision,
    });
    writeJson(response, 200, toolEnvelope('start_report_review', traceId, 'PASS', result));
    return;
  }

  const reviewCompleteMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/review\/complete$/u);
  if (request.method === 'POST' && reviewCompleteMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.completeReview({
      session_id: decodeURIComponent(reviewCompleteMatch[1]), expected_revision: input.expected_revision,
    });
    writeJson(response, 200, toolEnvelope('complete_report_review', traceId, 'PASS', result));
    return;
  }

  const attachmentMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/attachments$/u);
  if (request.method === 'POST' && attachmentMatch) {
    const filename = String(request.headers['x-file-name'] || '').trim();
    const purpose = String(request.headers['x-attachment-purpose'] || '').trim();
    const result = await captureService.attachEvidence({
      session_id: decodeURIComponent(attachmentMatch[1]), expected_revision: request.headers['x-expected-revision'],
      filename, mime_type: request.headers['content-type'], purpose, buffer: await readRawBody(request),
    });
    writeJson(response, 201, toolEnvelope('attach_report_evidence', traceId, 'PASS', result));
    return;
  }

  const sessionConfirmMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/confirm$/u);
  if (request.method === 'POST' && sessionConfirmMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.confirmSession({
      session_id: decodeURIComponent(sessionConfirmMatch[1]), expected_revision: input.expected_revision,
    });
    writeJson(response, 200, toolEnvelope('confirm_report_session', traceId, 'PASS', result));
    return;
  }

  const sessionExportMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/export$/u);
  if (request.method === 'POST' && sessionExportMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.exportConfirmedSession({
      session_id: decodeURIComponent(sessionExportMatch[1]), expected_revision: input.expected_revision,
    });
    if (String(request.headers.accept || '').split(',').map((value) => value.trim()).includes('application/json')) {
      const prepared = services.reportDownloads.issue(result);
      writeJson(response, 200, toolEnvelope('prepare_report_download', traceId, 'PASS', prepared));
    } else {
      writePdfDownload(response, result);
    }
    return;
  }

  const legacySessionConfirmationMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/confirmation$/u);
  if (request.method === 'POST' && legacySessionConfirmationMatch) {
    throw Object.assign(new Error('Legacy token-binding confirmation is disabled; confirm the authoritative ReportSession.'), {
      code: 'LEGACY_AUTHORITY_DISABLED', status: 410,
    });
    return;
  }

  const resolutionAnswerMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/resolution-items\/([^/]+)\/answer$/u);
  if (request.method === 'POST' && resolutionAnswerMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.answerResolutionItem({
      ...input,
      session_id: decodeURIComponent(resolutionAnswerMatch[1]),
      resolution_id: decodeURIComponent(resolutionAnswerMatch[2]),
    });
    writeJson(response, result.reused ? 200 : 201, toolEnvelope('answer_report_resolution', traceId, 'PASS', result));
    return;
  }

  const guidanceUploadMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/guidance\/uploads$/u);
  if (request.method === 'POST' && guidanceUploadMatch) {
    if (request.headers['x-scope-id'] || request.headers['x-context-id']
      || request.headers['x-uploader'] || request.headers['x-report-session-id']) {
      throw Object.assign(new Error('Guidance upload scope and provenance are derived from the ReportSession.'), {
        code: 'UNTRUSTED_GUIDANCE_UPLOAD_INPUT', status: 400,
      });
    }
    const filename = String(request.headers['x-file-name'] || '').trim();
    if (!filename) {
      throw Object.assign(new Error('X-File-Name header is required for guidance uploads.'), { code: 'FILE_NAME_REQUIRED', status: 400 });
    }
    const result = await captureService.ingestGuidanceUpload({
      session_id: decodeURIComponent(guidanceUploadMatch[1]),
      expected_revision: request.headers['x-expected-revision'],
      filename,
      mime_type: request.headers['content-type'],
      buffer: await readRawBody(request),
    });
    writeJson(response, 201, toolEnvelope('ingest_report_guidance', traceId, 'PASS', result));
    return;
  }

  const guidanceViewMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/guidance$/u);
  if (request.method === 'GET' && guidanceViewMatch) {
    const chain = await captureService.sessionStore.loadChain(decodeURIComponent(guidanceViewMatch[1]));
    const guidance = chain.guidance_contexts.map((context) => ({
      guidance_context_id: context.guidance_context_id,
      applicable_modules: context.applicable_modules,
      follow_up_questions: context.follow_up_questions,
      passages: context.passages.map((passage) => ({
        source_type: passage.source_type,
        text: passage.text,
      })),
    }));
    writeJson(response, 200, toolEnvelope('view_report_guidance', traceId, 'PASS', { guidance }));
    return;
  }

  const fieldAnswerMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/fields\/([^/]+)\/answer$/u);
  if (request.method === 'POST' && fieldAnswerMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.submitFieldAnswer({
      ...input,
      session_id: decodeURIComponent(fieldAnswerMatch[1]),
      field_id: decodeURIComponent(fieldAnswerMatch[2]),
    });
    writeJson(response, 201, toolEnvelope('record_report_field_answer', traceId, 'PASS', result));
    return;
  }

  const fieldSelectionMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/fields\/([^/]+)\/select$/u);
  if (request.method === 'POST' && fieldSelectionMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.selectFieldRepresentation({
      ...input,
      session_id: decodeURIComponent(fieldSelectionMatch[1]),
      field_id: decodeURIComponent(fieldSelectionMatch[2]),
    });
    writeJson(response, result.reused ? 200 : 201, toolEnvelope('select_report_field_representation', traceId, 'PASS', result));
    return;
  }

  const candidateConfirmMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/candidates\/([^/]+)\/confirm$/u);
  if (request.method === 'POST' && candidateConfirmMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.confirmFieldCandidate({
      ...input,
      session_id: decodeURIComponent(candidateConfirmMatch[1]),
      candidate_id: decodeURIComponent(candidateConfirmMatch[2]),
    });
    writeJson(response, 200, toolEnvelope('confirm_report_field_candidate', traceId, 'PASS', result));
    return;
  }

  const textCaptureMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/capture\/text$/u);
  if (request.method === 'POST' && textCaptureMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.captureText({
      ...input,
      session_id: decodeURIComponent(textCaptureMatch[1]),
    });
    writeJson(response, result.reused ? 200 : 201, toolEnvelope('capture_report_text', traceId, 'PASS', result));
    return;
  }

  const audioCaptureMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/capture\/audio$/u);
  if (request.method === 'POST' && audioCaptureMatch) {
    if (!String(request.headers['content-type'] || '').startsWith('audio/wav')) {
      throw Object.assign(new Error('Upload Content-Type must be audio/wav.'), { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
    }
    if (request.headers['x-evidence-id'] || request.headers['x-support-status'] || request.headers['x-field-state']
      || request.headers['x-confirmation-receipt']) {
      throw Object.assign(new Error('Client capture headers cannot establish server authority.'), {
        code: 'UNTRUSTED_CAPTURE_INPUT', status: 400,
      });
    }
    const input = {
      session_id: decodeURIComponent(audioCaptureMatch[1]),
      expected_revision: request.headers['x-expected-revision'],
      wav_buffer: await readBody(request, maxAudioBytes),
      model: request.headers['x-stt-model'],
      language: request.headers['x-stt-language'],
      idempotency_key: request.headers['idempotency-key'],
      target_field_id: request.headers['x-target-field-id'],
      target_section_id: request.headers['x-target-section-id'],
      capture_mode: request.headers['x-capture-mode'],
    };
    if (config.publicMode) {
      const job = await audioJobs.enqueue(input);
      writeJson(response, 202, toolEnvelope('queue_report_audio', traceId, 'PASS', job));
      return;
    }
    const result = await captureService.captureAudio(input);
    const status = result.failure ? 'RETRYABLE_ERROR' : 'PASS';
    writeJson(response, result.reused ? 200 : result.failure ? 202 : 201, toolEnvelope('capture_report_audio', traceId, status, result, {
      retryable: Boolean(result.failure),
      error_code: result.failure?.code,
    }));
    return;
  }

  const retryMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/transcription\/retry$/u);
  if (request.method === 'POST' && retryMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input, { allow: ['evidence_id'] });
    if (config.publicMode) {
      const job = await audioJobs.enqueue({ kind: 'retry', session_id: decodeURIComponent(retryMatch[1]),
        expected_revision: input.expected_revision, evidence_id: input.evidence_id,
        idempotency_key: crypto.randomUUID() });
      writeJson(response, 202, toolEnvelope('queue_report_transcription_retry', traceId, 'PASS', job));
      return;
    }
    const result = await captureService.retryTranscription({
      ...input,
      session_id: decodeURIComponent(retryMatch[1]),
    });
    writeJson(response, 200, toolEnvelope('retry_report_transcription', traceId, result.failure ? 'RETRYABLE_ERROR' : 'PASS', result, {
      retryable: Boolean(result.failure),
      error_code: result.failure?.code,
    }));
    return;
  }

  const reviewMatch = url.pathname.match(/^\/api\/report-sessions\/([^/]+)\/transcript-reviews\/([^/]+)\/decide$/u);
  if (request.method === 'POST' && reviewMatch) {
    const input = await readJson(request);
    rejectUntrustedAuthority(input);
    const result = await captureService.decideTranscriptReview({
      ...input,
      session_id: decodeURIComponent(reviewMatch[1]),
      review_id: decodeURIComponent(reviewMatch[2]),
    });
    writeJson(response, 200, toolEnvelope('decide_transcript_review', traceId, 'PASS', result));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/templates') {
    const custom = await templates.listPublished();
    writeJson(response, 200, toolEnvelope('list_templates', traceId, 'PASS', {
      templates: [...listPredefinedTemplates(), ...custom],
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/template-context/retrieve') {
    const input = await readJson(request);
    writeJson(response, 200, toolEnvelope('retrieve_template_context', traceId, 'PASS', retrieveTemplateContext({
      templateId: input.template_id,
      contextCorpusId: input.context_corpus_id,
      contextVersion: input.context_version,
      query: input.query,
    })));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/template-reports/build') {
    const input = await readJson(request);
    const templateId = String(input.template_id || '').trim();
    let selectedTemplate;
    try {
      selectedTemplate = templateFor(templateId);
    } catch {
      selectedTemplate = (await templates.listPublished()).find((item) => item.templateId === templateId);
    }
    if (!selectedTemplate) throw Object.assign(new Error('Template version was not found.'), { code: 'TEMPLATE_NOT_FOUND', status: 404 });
    const reportSessionId = String(input.report_session_id || `server_${traceId}`).slice(0, 160);
    let facts;
    let authoritativeAgentState = null;
    if (reportSessionId.startsWith('session_')) {
      const chain = await captureService.sessionStore.loadChain(reportSessionId);
      if (chain.session.template_binding.template_id !== templateId) {
        throw Object.assign(new Error('ReportSession is bound to another template.'), { code: 'REPORT_SESSION_TEMPLATE_MISMATCH', status: 409 });
      }
      if (Object.hasOwn(input, 'facts')) {
        throw Object.assign(new Error('Authoritative report facts are derived from the persisted ReportSession.'), {
          code: 'UNTRUSTED_REPORT_FACTS', status: 400,
        });
      }
      const authoritative = chain.agent_state ? { agent_state: chain.agent_state } : await captureService.getAgentState(reportSessionId);
      authoritativeAgentState = authoritative.agent_state;
      facts = officialFactsFromAgentState(authoritativeAgentState);
    } else {
      facts = Array.isArray(input.facts) ? input.facts : [];
    }
    const definitions = selectedTemplate.schema.fields;
    const matches = (pattern, candidate) => pattern.endsWith('.*') ? candidate.startsWith(pattern.slice(0, -1)) : pattern === candidate;
    const accepted = facts.filter((fact) => definitions.some((definition) => matches(definition.id, String(fact.field || ''))));
    const unsupported = facts.filter((fact) => !definitions.some((definition) => matches(definition.id, String(fact.field || ''))));
    const state = new Map();
    for (const fact of accepted) state.set(String(fact.field), fact);
    const provided = (definition) => {
      const candidates = [...state.entries()].filter(([fieldId]) => matches(definition.id, fieldId)).map(([, fact]) => fact);
      return candidates.some((fact) => fact.value !== null && fact.value !== undefined && String(fact.value).trim() !== '' && fact.value !== 'NOT_CHECKED');
    };
    const missing = definitions.filter((definition) => definition.required && !provided(definition)).map((definition) => definition.id);
    const violations = [
      ...missing.map((field) => ({ class: 'SCHEMA_REQUIRED_FIELD_MISSING', field, message: `${field} requires technician evidence or explicit input.` })),
      ...unsupported.map((fact) => ({ class: 'SCHEMA_UNSUPPORTED_FIELD', field: fact.field, message: `${fact.field} is outside this template version.` })),
      ...(authoritativeAgentState?.validation_issues || []).filter((issue) => issue.blocking).map((issue) => ({
        class: issue.code,
        field: issue.field_id,
        message: issue.reason,
        blocking: issue.blocking,
        issue_id: issue.issue_id,
      })),
    ];
    for (const definition of definitions) {
      const fact = [...state.entries()].find(([fieldId]) => matches(definition.id, fieldId))?.[1];
      if (!fact) continue;
      const support = String(fact.support_status || '').toUpperCase();
      const sources = Array.isArray(fact.source_refs) ? fact.source_refs : [];
      if ((definition.critical || definition.requiresTechnicianConfirmation) && support !== 'CONFIRMED_BY_TECHNICIAN') {
        violations.push({ class: 'SCHEMA_FIELD_NEEDS_CONFIRMATION', field: definition.id, message: `${definition.id} requires technician confirmation.` });
      }
      if (sources.length > 0 && sources.every((source) => /^(knowledge|context|rag):/iu.test(String(source)))) {
        violations.push({ class: 'CONTEXT_NOT_JOB_EVIDENCE', field: definition.id, message: 'Template context cannot assert a job fact.' });
      }
      const allowed = definition.allowedValues || definition.allowedStatuses;
      if (allowed && !allowed.includes(String(fact.value))) violations.push({ class: 'SCHEMA_INVALID_VALUE', field: definition.id, message: `${fact.value} is not allowed for ${definition.id}.` });
    }
    const sections = [...new Set(definitions.map((definition) => definition.section))].map((section, index) => ({
      id: `section_${index + 1}`,
      title: section,
      content: definitions.filter((definition) => definition.section === section).map((definition) => {
        const fact = [...state.entries()].find(([fieldId]) => matches(definition.id, fieldId))?.[1];
        return { field: definition.id, label: definition.label, value: fact?.value ?? null, status: fact ? 'SUPPORTED' : 'MISSING' };
      }),
    }));
    const stateSnapshot = { session_id: reportSessionId, schema_id: selectedTemplate.schema.id, schema_version: selectedTemplate.schema.version, fields: Object.fromEntries([...state].map(([key, fact]) => [key, fact.value])), unsupported_fields: unsupported.map((fact) => fact.field) };
    const draft = {
      report_id: `report_${hashValue({ templateId, reportSessionId, accepted }).slice(7, 19)}`,
      report_version: 1,
      report_session_id: reportSessionId,
      template_id: selectedTemplate.templateId,
      template_name: selectedTemplate.name,
      template_version: selectedTemplate.templateVersion,
      schema_id: selectedTemplate.schema.id,
      schema_version: selectedTemplate.schema.version,
      context_corpus_id: selectedTemplate.contextCorpus.id,
      context_version: selectedTemplate.contextCorpus.version,
      renderer_id: selectedTemplate.rendererMapping.id,
      renderer_version: selectedTemplate.rendererMapping.version,
      facts_hash: hashValue(accepted),
      structured_state_hash: hashValue(stateSnapshot),
      sections,
      missing_required_fields: missing,
      provenance: selectedTemplate.provenance,
      disclaimer: { text: 'Prototype form. Technician confirmation covers only this exact version. Template context is not evidence that work occurred.' },
    };
    const status = violations.length ? 'NEEDS_CONFIRMATION' : 'PASS';
    const validation = { trace_id: traceId, status, data: { can_enter_technician_review: violations.length === 0, gates: { violations } } };
    const validationReceipt = await reports.recordStructuredValidation({ draft, validation, facts: accepted });
    writeJson(response, 200, toolEnvelope('build_template_report', traceId, status, {
      structured_job_state: stateSnapshot,
      draft,
      validation_receipt: validationReceipt,
      gates: { violations },
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/templates/drafts/source') {
    const draft = await templates.createDraft({
      name: url.searchParams.get('name'),
      filename: url.searchParams.get('filename'),
      mimeType: request.headers['content-type'],
      bytes: await readRawBody(request),
    });
    writeJson(response, 201, toolEnvelope('upload_template_source', traceId, 'PASS', { draft }));
    return;
  }

  const proposalMatch = url.pathname.match(/^\/api\/templates\/drafts\/([^/]+)\/propose$/u);
  if (request.method === 'POST' && proposalMatch) {
    await readJson(request);
    const draft = await templates.proposeWithModel(decodeURIComponent(proposalMatch[1]), {
      provider: ollama, model: String(process.env.HVAC_OLLAMA_MODEL || '').trim(),
    });
    writeJson(response, 200, toolEnvelope('propose_template_fields', traceId, 'PASS', { draft }));
    return;
  }

  const contextMatch = url.pathname.match(/^\/api\/templates\/drafts\/([^/]+)\/context$/u);
  if (request.method === 'POST' && contextMatch) {
    const draft = await templates.addContext(decodeURIComponent(contextMatch[1]), {
      filename: url.searchParams.get('filename'),
      mimeType: request.headers['content-type'],
      bytes: await readRawBody(request),
    });
    writeJson(response, 200, toolEnvelope('upload_template_context', traceId, 'PASS', { draft }));
    return;
  }

  const contextWaiverMatch = url.pathname.match(/^\/api\/templates\/drafts\/([^/]+)\/context\/waive$/u);
  if (request.method === 'POST' && contextWaiverMatch) {
    const input = await readJson(request);
    const draft = await templates.waiveContext(decodeURIComponent(contextWaiverMatch[1]), input.reason);
    writeJson(response, 200, toolEnvelope('waive_template_context', traceId, 'PASS', { draft }));
    return;
  }

  const schemaMatch = url.pathname.match(/^\/api\/templates\/drafts\/([^/]+)\/schema$/u);
  if (request.method === 'POST' && schemaMatch) {
    const draft = await templates.saveSchema(decodeURIComponent(schemaMatch[1]), await readJson(request));
    writeJson(response, 200, toolEnvelope('review_template_schema', traceId, 'PASS', { draft }));
    return;
  }

  const testMatch = url.pathname.match(/^\/api\/templates\/drafts\/([^/]+)\/test$/u);
  if (request.method === 'POST' && testMatch) {
    await readJson(request);
    const draft = await templates.runContractTest(decodeURIComponent(testMatch[1]));
    writeJson(response, 200, toolEnvelope('test_template_draft', traceId, draft.test.status === 'PASSED' ? 'PASS' : 'FAIL', { draft }));
    return;
  }

  const publishMatch = url.pathname.match(/^\/api\/templates\/drafts\/([^/]+)\/publish$/u);
  if (request.method === 'POST' && publishMatch) {
    const template = await templates.publish(decodeURIComponent(publishMatch[1]));
    writeJson(response, 201, toolEnvelope('publish_template_version', traceId, 'PASS', { template }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    const selectedModel = await speechService.resolveModel();
    const [stt, llm] = await Promise.all([whisperProvider.health({ model: selectedModel }), ollama.health()]);
    writeJson(response, 200, toolEnvelope('provider_health', traceId, stt.ready ? 'PASS' : 'FAIL', {
      server: { ready: true, bound_to: `${config.host}:${config.port}`, mode: config.publicMode ? 'public' : config.lanMode ? 'lan-demo' : 'local-only' },
      whisper: stt,
      ollama: llm,
    }, { warnings: [!stt.ready ? stt.message : null, !llm.ready ? llm.message : null].filter(Boolean) }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/audio') {
    if (!String(request.headers['content-type'] || '').startsWith('audio/wav')) {
      throw Object.assign(new Error('Upload Content-Type must be audio/wav.'), { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
    }
    const audio = await artifacts.putAudio(await readBody(request, maxAudioBytes));
    writeJson(response, 201, toolEnvelope('store_audio', traceId, 'PASS', audio));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/transcriptions') {
    const input = await readJson(request);
    const model = await speechService.resolveModel();
    const language = String(input.language || 'auto');
    const attempt = Math.max(1, Math.min(2, Number(input.attempt) || 1));
    const idempotencyKey = String(input.idempotency_key || `${input.audio_id}:${model}:${language}:attempt-${attempt}`);
    const existing = await artifacts.getTranscriptByKey(idempotencyKey);
    if (existing) {
      writeJson(response, 200, toolEnvelope('transcribe_audio', traceId, 'PASS', { transcript: existing, reused: true }));
      return;
    }
    if (!await artifacts.hasAudio(input.audio_id)) {
      throw Object.assign(new Error('Audio artifact was not found.'), { code: 'AUDIO_NOT_FOUND', status: 404 });
    }
    const audioMetadata = await artifacts.readAudioMetadata(input.audio_id);
    const result = await whisperProvider.transcribe(artifacts.audioPath(input.audio_id), { model, language });
    const transcript = await artifacts.putTranscript({
      audio_id: input.audio_id,
      ...result,
      source_hash: audioMetadata.source_hash,
      attempt,
      input_mode: 'VOICE_TRANSCRIPT',
    }, { idempotencyKey });
    writeJson(response, 201, toolEnvelope('transcribe_audio', traceId, 'PASS', { transcript, reused: false }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/transcripts/manual') {
    const input = await readJson(request);
    const rawText = String(input.raw_text || '').trim();
    const editedFromArtifactId = String(input.edited_from_artifact_id || '').trim() || null;
    const inputMode = editedFromArtifactId ? 'EDITED_TRANSCRIPT' : 'MANUAL_TRANSCRIPT';
    if (input.input_mode && input.input_mode !== inputMode) {
      throw Object.assign(new Error('Transcript source mode does not match its evidence binding.'), { code: 'TRANSCRIPT_SOURCE_MISMATCH', status: 400 });
    }
    const keyHash = crypto.createHash('sha256').update(`${input.language || 'zh'}:${inputMode}:${editedFromArtifactId || ''}:${rawText}`).digest('hex');
    const transcript = await artifacts.putManualTranscript({ raw_text: rawText, language: input.language, input_mode: inputMode, edited_from_artifact_id: editedFromArtifactId }, {
      idempotencyKey: String(input.idempotency_key || `manual:${keyHash}`),
    });
    writeJson(response, 201, toolEnvelope('create_manual_transcript', traceId, 'PASS', { transcript }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/normalizations') {
    const input = await readJson(request);
    if (Object.hasOwn(input, 'knowledge_candidates') || Object.hasOwn(input, 'corrected_text') || Object.hasOwn(input, 'model')) {
      throw Object.assign(new Error('Correction candidates, corrected text, and normalization model are server-controlled.'), { code: 'UNTRUSTED_NORMALIZATION_INPUT', status: 400 });
    }
    const transcript = await artifacts.readTranscript(input.transcript_artifact_id);
    const knowledge = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
    const result = await normalizeHvacTranscript({
      transcript,
      knowledgeCandidates: knowledge.candidates,
      knowledgeVersion: knowledge.knowledge_version,
      provider: ollama,
      model: String(process.env.HVAC_OLLAMA_MODEL || ''),
      traceId,
    });
    writeJson(response, 200, result);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/corrections/confirm') {
    const input = await readJson(request);
    if (Object.hasOwn(input, 'corrected_text') || Object.hasOwn(input, 'corrections') || Object.hasOwn(input, 'knowledge_candidates')) {
      throw Object.assign(new Error('Client-declared corrected text and correction objects are rejected.'), { code: 'UNTRUSTED_CORRECTIONS', status: 400 });
    }
    const transcript = await artifacts.readTranscript(input.transcript_artifact_id);
    const knowledge = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
    const receipt = await artifacts.putCorrectionReceipt({
      transcriptArtifactId: transcript.artifact_id,
      knowledgeVersion: knowledge.knowledge_version,
      candidates: knowledge.candidates,
      candidatesHash: input.candidate_bundle_hash,
      decisions: input.decisions,
      technicianId: input.technician_id,
      technicianName: input.technician_name,
    });
    writeJson(response, 201, toolEnvelope('confirm_transcript_corrections', traceId, 'PASS', { correction_receipt: receipt }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/knowledge/retrieve') {
    const input = await readJson(request);
    writeJson(response, 200, await retrieveHvacKnowledge({ ...input, traceId }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/facts/extract') {
    const input = await readJson(request);
    if (Object.hasOwn(input, 'transcript_artifact_id') || Object.hasOwn(input, 'transcript')
      || Object.hasOwn(input, 'corrected_text') || Object.hasOwn(input, 'confirmed_corrections') || Object.hasOwn(input, 'corrections')) {
      throw Object.assign(new Error('Facts extraction accepts only a server-verified correction_receipt_id, not client transcript or correction content.'), { code: 'CORRECTION_RECEIPT_REQUIRED', status: 400 });
    }
    const preliminaryReceipt = await artifacts.readCorrectionReceipt(input.correction_receipt_id);
    const transcript = await artifacts.readTranscript(preliminaryReceipt.transcript_artifact_id);
    const knowledge = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
    const correctionReceipt = await artifacts.readCorrectionReceipt(input.correction_receipt_id, {
      expectedKnowledgeVersion: knowledge.knowledge_version,
      expectedCandidates: knowledge.candidates,
    });
    const model = String(process.env.HVAC_OLLAMA_MODEL || '');
    const result = await extractServiceFacts({
      transcript: { ...transcript, raw_text: correctionReceipt.final_text },
      correctionReceipt,
      confirmedCorrections: correctionReceipt.decisions,
      manualFields: input.manual_fields,
      provider: input.use_llm === false || !model ? undefined : ollama,
      model,
      traceId,
    });
    if (result.status !== 'PASS') {
      writeJson(response, 200, result);
      return;
    }
    const factsReceipt = await artifacts.putFacts({
      correctionReceipt,
      facts: result.data.facts,
    });
    result.data.facts_receipt_id = factsReceipt.facts_receipt_id;
    result.data.facts_hash = factsReceipt.facts_hash;
    writeJson(response, 200, result);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/validate-input') {
    const input = await readJson(request);
    const factsReceipt = await artifacts.readFacts(input.facts_receipt_id);
    writeJson(response, 200, await validateReportInput({ facts: factsReceipt.facts, traceId }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/plan') {
    const input = await readJson(request);
    const factsReceipt = await artifacts.readFacts(input.facts_receipt_id);
    writeJson(response, 200, await planReportSections({ facts: factsReceipt.facts, serviceType: input.service_type, traceId }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/template') {
    const input = await readJson(request);
    writeJson(response, 200, await retrieveReportTemplate({ templateId: input.template_id, version: input.version, traceId }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/generate') {
    const input = await readJson(request);
    const factsReceipt = await artifacts.readFacts(input.facts_receipt_id);
    const model = String(process.env.HVAC_OLLAMA_MODEL || '');
    const result = await generateReportDraft({
      facts: factsReceipt.facts,
      plan: input.plan,
      template: input.template,
      provider: input.use_llm === false || !model ? undefined : ollama,
      model,
      traceId,
      reportSessionId: input.report_session_id,
    });
    writeJson(response, 200, result);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/validate-draft') {
    const input = await readJson(request);
    const factsReceipt = await artifacts.readFacts(input.facts_receipt_id);
    const validation = await validateReportDraft({ draft: input.draft, facts: factsReceipt.facts, traceId });
    const receipt = await reports.recordValidation({ draft: input.draft, validation, factsReceipt });
    validation.data.validation_receipt = receipt;
    writeJson(response, 200, validation);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/confirm') {
    throw Object.assign(new Error('Client-draft confirmation is disabled.'), { code: 'LEGACY_AUTHORITY_DISABLED', status: 410 });
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/save') {
    throw Object.assign(new Error('Client-draft official save is disabled.'), { code: 'LEGACY_AUTHORITY_DISABLED', status: 410 });
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/export') {
    throw Object.assign(new Error('Client-draft export is disabled.'), { code: 'LEGACY_AUTHORITY_DISABLED', status: 410 });
  }

  if (request.method === 'GET' && url.pathname === '/api/v2/scopes') {
    const registry = await ensureV2Registry();
    const scopes = Object.entries(registry?.scopes || {})
      .filter(([, entry]) => entry?.kind === 'domain')
      .map(([scopeId, entry]) => ({
        scope_id: scopeId,
        display: String(entry?.display ?? scopeId),
        upload_allowed: entry?.upload_allowed === true,
      }));
    writeJson(response, 200, toolEnvelope('v2_scopes', traceId, 'PASS', {
      scopes,
      contexts: { ...(registry?.context_ids || {}) },
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/uploads') {
    const registry = await ensureV2Registry();
    const scopeId = String(request.headers['x-scope-id'] || '').trim();
    const scopeEntry = registry?.scopes?.[scopeId];
    if (!scopeEntry || typeof scopeEntry !== 'object') {
      throw Object.assign(new Error(`Unknown V2 scope "${scopeId}" for upload.`), { code: 'UNKNOWN_SCOPE', status: 400 });
    }
    if (scopeEntry.upload_allowed !== true) {
      writeJson(response, 200, toolEnvelope('v2_upload', traceId, 'FAIL', {}, {
        error_code: 'UPLOAD_NOT_ALLOWED',
        warnings: [`Scope "${scopeId}" does not allow user uploads.`],
      }));
      return;
    }
    const filename = String(request.headers['x-file-name'] || '').trim();
    if (!filename) {
      throw Object.assign(new Error('X-File-Name header is required for uploads.'), { code: 'FILE_NAME_REQUIRED', status: 400 });
    }
    const uploader = String(request.headers['x-uploader'] || '').trim() || 'demo-technician';
    const scenario = String(request.headers['x-scenario'] || '').trim() || 'demo';
    const reportSessionId = String(request.headers['x-report-session-id'] || '').trim().slice(0, 160);
    const mimeType = String(request.headers['x-mime-type'] || '').trim() || undefined;
    const buffer = await readRawBody(request);
    const record = await ingestDocument({
      scopeId,
      filename,
      buffer,
      mimeType,
      metadata: { uploader, source: 'user-upload', scenario },
      store: v2UploadStore,
    });
    const reportBinding = reportSessionId ? {
      report_session_id: reportSessionId,
      scope_id: scopeId,
      upload_id: record.upload_id,
    } : undefined;
    writeJson(response, 201, toolEnvelope('v2_upload', traceId, 'PASS', {
      upload: record,
      ...(reportBinding ? { report_binding: reportBinding } : {}),
    }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v2/uploads') {
    const scopeId = String(url.searchParams.get('scope_id') || '').trim();
    const uploads = scopeId ? await v2UploadStore.list({ scopeId }) : [];
    writeJson(response, 200, toolEnvelope('v2_uploads', traceId, 'PASS', { uploads }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/retrieve') {
    const input = await readJson(request);
    const registry = await ensureV2Registry();
    resolveV2ContextOrThrow(input.context_id, registry);
    const retriever = createRetriever({ registry, uploadStore: v2UploadStore });
    const result = await retriever({
      contextId: input.context_id,
      query: input.query,
      topK: input.top_k,
      includeUploads: input.include_uploads,
    });
    writeJson(response, 200, toolEnvelope('v2_retrieve', traceId, 'PASS', result));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/facts/extract') {
    const input = await readJson(request);
    const registry = await ensureV2Registry();
    const contextId = String(input.context_id || '').trim();
    const resolved = resolveV2ContextOrThrow(contextId, registry);
    if (resolved.scopeId === 'HVAC') {
      writeJson(response, 200, toolEnvelope('v2_facts_extract', traceId, 'FAIL', {}, {
        error_code: 'UNSUPPORTED_SCOPE',
        warnings: [`Context "${contextId}" resolves to HVAC; deterministic V2 fact extraction is available for SBS/BUS, SBS/RAIL, OILFIELD, and POWER/GRID (HVAC stays on the V1 flow).`],
      }));
      return;
    }
    const result = await extractV2Facts({ contextId, rawText: input.raw_text, registry });
    const transcriptReview = reviewV2Transcript({ scopeId: resolved.scopeId, rawText: input.raw_text });
    writeJson(response, 200, toolEnvelope('v2_facts_extract', traceId, 'PASS', {
      facts: result.facts,
      warnings: result.warnings,
      transcript_review: transcriptReview,
      context_id: contextId,
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/reports/build') {
    const input = await readJson(request);
    const registry = await ensureV2Registry();
    const contextId = String(input.context_id || '').trim();
    const resolved = resolveV2ContextOrThrow(contextId, registry);
    if (resolved.scopeId === 'HVAC') {
      writeJson(response, 200, toolEnvelope('v2_report_build', traceId, 'FAIL', {}, {
        error_code: 'UNSUPPORTED_SCOPE',
        warnings: [`Context "${contextId}" resolves to HVAC; V2 report building is available for SBS/BUS, SBS/RAIL, OILFIELD, and POWER/GRID.`],
      }));
      return;
    }
    const facts = Array.isArray(input.facts) ? input.facts : [];
    // V2 accepts technician-reviewed facts directly from the browser. Issue a
    // deterministic, system-managed receipt for the exact fact bundle used to
    // build this draft so provenance is always present and changes whenever a
    // technician edits or confirms a fact.
    const factsReceiptId = input.facts_receipt_id
      ? String(input.facts_receipt_id)
      : `v2facts_${crypto.createHash('sha256')
        .update(JSON.stringify({ context_id: contextId, facts }))
        .digest('hex')
        .slice(0, 24)}`;
    const knowledgeHits = Array.isArray(input.knowledge_hits) ? input.knowledge_hits : [];
    const requestedSessionId = String(input.report_session_id || '').trim().slice(0, 160);
    const reportSessionId = requestedSessionId || `server_${traceId}`;
    const reportTypes = {
      SBS_BUS: 'sbs_bus_maintenance',
      SBS_RAIL: 'sbs_rail_maintenance',
      OILFIELD: 'oilfield_inspection',
      POWER_GRID: 'power_grid_inspection',
    };
    const reportType = reportTypes[resolved.scopeId];
    const requestedTemplateId = String(input.template_id || '').trim();
    const selectedTemplate = requestedTemplateId ? templateFor(requestedTemplateId) : null;
    if (selectedTemplate && selectedTemplate.domain !== resolved.scopeId) {
      throw Object.assign(new Error(`Template ${requestedTemplateId} belongs to ${selectedTemplate.domain}, not ${resolved.scopeId}.`), { code: 'TEMPLATE_SCOPE_MISMATCH', status: 400 });
    }
    const mappedSession = mapFactsToStructuredState(createReportSession({
      id: reportSessionId,
      ...(selectedTemplate ? { templateId: selectedTemplate.templateId } : { reportType }),
    }), facts);
    const completeness = evaluateCompleteness(mappedSession);
    const authoritativeFacts = factsFromStructuredState(mappedSession);
    const report = resolved.scopeId === 'SBS_BUS'
      ? buildBusReportSections({ facts: authoritativeFacts, factsReceiptId })
      : resolved.scopeId === 'SBS_RAIL'
        ? buildRailReportSections({ facts: authoritativeFacts, factsReceiptId })
        : buildIndustrialReportSections({ scopeId: resolved.scopeId, facts: authoritativeFacts, factsReceiptId });
    const plan = planV2Report({ scopeId: resolved.scopeId, facts: authoritativeFacts, factsReceiptId });
    const schemaViolations = [
      ...(selectedTemplate ? completeness.missingFields.map((field) => ({ class: 'SCHEMA_REQUIRED_FIELD_MISSING', field, message: `${field} requires technician evidence or explicit input.` })) : []),
      ...completeness.conflicts.map((field) => ({ class: 'SCHEMA_FIELD_CONFLICT', field, message: `Conflicting values for ${field} require technician resolution.` })),
      ...completeness.needsConfirmation.map((field) => ({ class: 'SCHEMA_FIELD_NEEDS_CONFIRMATION', field, message: `${field} requires technician confirmation.` })),
      ...completeness.invalidValues.map((item) => ({ class: 'SCHEMA_INVALID_VALUE', field: item.fieldId, message: `${item.fieldId} failed the schema ${item.reason} constraint.` })),
    ];
    // Retrieved procedures remain visible as advice. They never become proof
    // that the technician performed an action, so retrieval alone must not
    // block a grounded report.
    const knowledgeAdvisories = assertNoServiceFactInvention({ facts: authoritativeFacts, knowledgeHits })
      .map((item) => Object.freeze({
        class: 'KNOWLEDGE_ACTION_NOT_PROMOTED',
        detail: item.detail,
      }));
    const violations = [
      ...schemaViolations,
      ...checkHardGates({ scopeId: resolved.scopeId, facts: authoritativeFacts }).violations,
    ];
    const followUpQuestions = [
      ...buildFollowUpQuestions({
        scopeId: resolved.scopeId,
        missingSections: plan.missing_required_fields,
      }),
      ...buildGateConfirmationQuestions({ violations }),
    ];
    const schema = { id: mappedSession.schemaId, version: mappedSession.schemaVersion };
    const stateSnapshot = structuredStateSnapshot(mappedSession);
    const structuredStateHash = hashValue(stateSnapshot);
    const draftFingerprint = hashValue({ contextId, reportSessionId, structuredStateHash, sections: report.sections });
    const draft = {
      report_id: `report_${draftFingerprint.slice(7, 19)}`,
      report_version: 1,
      report_session_id: reportSessionId,
      schema_id: schema.id,
      schema_version: schema.version,
      scope_id: resolved.scopeId,
      context_id: contextId,
      template_id: selectedTemplate?.templateId || null,
      template_version: selectedTemplate?.templateVersion || report.reportVersion,
      context_corpus_id: selectedTemplate?.contextCorpus.id || contextId,
      context_version: selectedTemplate?.contextCorpus.version || resolved.contextVersion || 'scope-registry-v1',
      renderer_id: selectedTemplate?.rendererMapping.id || 'legacy-v2-sections',
      renderer_version: selectedTemplate?.rendererMapping.version || report.reportVersion,
      facts_hash: hashValue(authoritativeFacts),
      structured_state_hash: structuredStateHash,
      sections: report.sections,
      missing_required_fields: [...new Set([...plan.missing_required_fields, ...(selectedTemplate ? completeness.missingFields : [])])],
      disclaimer: {
        text: 'Technician review and confirmation are required. Knowledge references do not prove that work was performed.',
      },
    };
    const status = violations.length ? 'NEEDS_CONFIRMATION' : 'PASS';
    const validation = {
      trace_id: traceId,
      status,
      data: { can_enter_technician_review: violations.length === 0, gates: { violations } },
    };
    const validationReceipt = await reports.recordStructuredValidation({ draft, validation, facts: authoritativeFacts });
    writeJson(response, 200, toolEnvelope('v2_report_build', traceId, status, {
      structured_job_state: stateSnapshot,
      report: {
        scope_id: resolved.scopeId,
        context_id: contextId,
        facts_receipt_id: factsReceiptId,
        reportVersion: report.reportVersion,
        sections: report.sections,
        missing_required_fields: draft.missing_required_fields,
      },
      draft,
      validation_receipt: validationReceipt,
      gates: { violations },
      knowledge_advisories: knowledgeAdvisories,
      follow_up_questions: followUpQuestions,
    }, { retryable: false }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/reports/confirm') {
    throw Object.assign(new Error('Client-draft confirmation is disabled.'), { code: 'LEGACY_AUTHORITY_DISABLED', status: 410 });
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/reports/save') {
    throw Object.assign(new Error('Client-draft official save is disabled.'), { code: 'LEGACY_AUTHORITY_DISABLED', status: 410 });
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/reports/export') {
    throw Object.assign(new Error('Client-draft export is disabled.'), { code: 'LEGACY_AUTHORITY_DISABLED', status: 410 });
  }

  writeJson(response, 404, toolEnvelope('http_router', traceId, 'FAIL', {}, { error_code: 'NOT_FOUND' }));
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/vehicle-history.html', ['vehicle-history.html', 'text/html; charset=utf-8']],
  ['/vehicle-history.js', ['vehicle-history.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/locales/en.js', ['locales/en.js', 'text/javascript; charset=utf-8']],
  ['/locales/zh-CN.js', ['locales/zh-CN.js', 'text/javascript; charset=utf-8']],
  ['/locales/overrides.js', ['locales/overrides.js', 'text/javascript; charset=utf-8']],
  ['/report-runtime.js', ['report-runtime.js', 'text/javascript; charset=utf-8']],
  ['/template-catalog.js', ['template-catalog.js', 'text/javascript; charset=utf-8']],
  ['/template-selection.js', ['template-selection.js', 'text/javascript; charset=utf-8']],
  ['/template-workspace.js', ['template-workspace.js', 'text/javascript; charset=utf-8']],
  ['/report-workspace-view.js', ['report-workspace-view.js', 'text/javascript; charset=utf-8']],
  ['/report-input.js', ['report-input.js', 'text/javascript; charset=utf-8']],
  ['/transcript-inline.js', ['transcript-inline.js', 'text/javascript; charset=utf-8']],
  ['/template-app.js', ['template-app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/audio-recorder.js', ['audio-recorder.js', 'text/javascript; charset=utf-8']],
  ['/speech-to-text-settings.js', ['speech-to-text-settings.js', 'text/javascript; charset=utf-8']],
  ['/pcm-capture-worklet.js', ['pcm-capture-worklet.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

async function serveStatic(response, pathname) {
  const record = staticFiles.get(pathname);
  if (!record) return false;
  const [filename, contentType] = record;
  const body = await fs.readFile(path.join(webRoot, filename));
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    ...securityHeaders(),
  });
  response.end(body);
  return true;
}

function denyRequest(response, traceId, status, code) {
  writeJson(response, status, toolEnvelope('request', traceId, 'FAIL', {
    message: status === 401 ? 'Authentication required.' : 'Request denied.',
  }, { error_code: code }));
}

export function createServer({ config = resolveServerConfig(), services = {} } = {}) {
  const loginAttempts = [];
  const reportDownloadTickets = new Map();
  const reportDownloads = {
    issue(result) {
      const now = Date.now();
      for (const [ticket, entry] of reportDownloadTickets) {
        if (entry.expires_at <= now) reportDownloadTickets.delete(ticket);
      }
      const ticket = crypto.randomUUID();
      reportDownloadTickets.set(ticket, { result, expires_at: now + 60_000 });
      return {
        download_url: `/report-download/${ticket}`,
        filename: safeDownloadFilename(result.filename),
        mime_type: result.mime_type,
        snapshot_id: result.snapshot_id,
        export_hash: result.export_hash,
      };
    },
    consume(ticket) {
      const entry = reportDownloadTickets.get(ticket);
      reportDownloadTickets.delete(ticket);
      return entry && entry.expires_at > Date.now() ? entry.result : null;
    },
  };
  const resolvedServices = { authoritativeCapture, workOrders, speechToText, whisper, reportDownloads, ...services };
  if (config.publicMode && !resolvedServices.audioJobs) {
    resolvedServices.audioJobs = new AudioJobQueue({ root: path.join(dataRoot, 'audio-jobs'),
      captureService: resolvedServices.authoritativeCapture });
  }
  const server = http.createServer(async (request, response) => {
    const traceId = `trace_${crypto.randomUUID()}`;
    const url = new URL(request.url, 'http://server.invalid');
    try {
      if (url.pathname.startsWith('/api/')) {
        const authorization = authorizeApiRequest(request, config);
        if (!authorization.ok) {
          denyRequest(response, traceId, authorization.status, authorization.code);
          return;
        }
        await handleApi(request, response, url, traceId, config, resolvedServices);
      } else if (request.method === 'POST' && url.pathname === '/session-bootstrap') {
        if (config.publicMode) {
          if (request.headers.origin !== config.publicFrontendOrigin || !validateRequestContext(request, config).ok) {
            denyRequest(response, traceId, 403, 'REQUEST_DENIED');
            return;
          }
          const now = Date.now();
          while (loginAttempts.length && loginAttempts[0] <= now - 60_000) loginAttempts.shift();
          if (loginAttempts.length >= 10) {
            denyRequest(response, traceId, 429, 'LOGIN_RATE_LIMITED');
            return;
          }
          let credentials;
          try { credentials = JSON.parse((await readBody(request, 2048)).toString('utf8')); }
          catch { credentials = {}; }
          if (!verifyPublicPassword(credentials.username, credentials.password, config)) {
            loginAttempts.push(now);
            denyRequest(response, traceId, 401, 'AUTHENTICATION_REQUIRED');
            return;
          }
          writeJson(response, 200, { status: 'PASS', token: issuePublicSession(config), mode: 'public', principal: config.publicUser });
        } else {
          if (!canBootstrapLocalSession(request, config)) {
            denyRequest(response, traceId, 403, 'REQUEST_DENIED');
            return;
          }
          writeJson(response, 200, { status: 'PASS', token: config.token, mode: 'local-only' });
        }
      } else if (request.method === 'GET' && /^\/report-download\/[a-f0-9-]+$/u.test(url.pathname)) {
        if (!validateRequestHost(request.headers.host, config).ok) {
          denyRequest(response, traceId, 403, 'REQUEST_DENIED');
          return;
        }
        const result = reportDownloads.consume(url.pathname.slice('/report-download/'.length));
        if (!result) {
          writeJson(response, 404, toolEnvelope('report_download', traceId, 'FAIL', {
            message: 'This report download is unavailable or expired.',
          }, { error_code: 'REPORT_DOWNLOAD_UNAVAILABLE' }));
          return;
        }
        writePdfDownload(response, result);
      } else if (config.publicMode) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...securityHeaders() });
        response.end('Not found');
      } else if (!validateRequestHost(request.headers.host, config).ok) {
        denyRequest(response, traceId, 403, 'REQUEST_DENIED');
      } else if (!await serveStatic(response, url.pathname)) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...securityHeaders() });
        response.end('Not found');
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = Number(error.status) || 500;
      writeJson(response, status, toolEnvelope('request', traceId, error.retryable ? 'RETRYABLE_ERROR' : 'FAIL', {
        message: status >= 500 && error.expose !== true ? 'Internal server error.' : String(error.message),
      }, { retryable: error.retryable, error_code: error.code || 'INTERNAL_ERROR' }));
    }
  });
  server.audioJobs = resolvedServices.audioJobs;
  return server;
}

export async function startServer({ env = process.env } = {}) {
  const config = resolveServerConfig(env);
  await fs.mkdir(tempRoot, { recursive: true });
  const server = createServer({ config });
  if (config.publicMode) await server.audioJobs.init();
  server.listen(config.port, config.host, () => {
    for (const message of startupMessages(config)) console.log(message);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
}
