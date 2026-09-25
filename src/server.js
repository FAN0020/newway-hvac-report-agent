import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authorizeApiRequest,
  canBootstrapLocalSession,
  resolveServerConfig,
  securityHeaders,
  startupMessages,
  validateRequestHost,
} from './network-security.js';
import { ArtifactStore } from './storage/artifacts.js';
import { ReportStore } from './storage/reports.js';
import { WhisperProvider } from './providers/whisper.js';
import { OllamaProvider } from './providers/ollama.js';
import { confirmReportDraft } from './tools/confirm-report-draft.js';
import { exportConfirmedReport } from './tools/export-confirmed-report.js';
import { normalizeHvacTranscript } from './tools/normalize-hvac-transcript.js';
import { extractServiceFacts } from './tools/extract-service-facts.js';
import { generateReportDraft } from './tools/generate-report-draft.js';
import { buildTranscriptCorrectionCandidates, retrieveHvacKnowledge, retrieveReportTemplate } from './tools/hvac-knowledge.js';
import { planReportSections } from './tools/plan-report-sections.js';
import { saveConfirmedReport } from './tools/save-confirmed-report.js';
import { toolEnvelope } from './tools/tool-envelope.js';
import { validateReportDraft } from './tools/validate-report-draft.js';
import { validateReportInput } from './tools/validate-report-input.js';
import { hashValue } from './tools/report-integrity.js';
import { extractV2Facts } from './tools/extract-v2-facts.js';
import { loadScopeRegistry, resolveContext } from './v2/scope.js';
import { createUploadStore, ingestDocument } from './v2/upload.js';
import { createRetriever } from './v2/retrieval.js';
import {
  assertNoServiceFactInvention,
  buildBusReportSections,
  buildRailReportSections,
  checkHardGates,
  planV2Report,
} from './v2/report-builder.js';

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
const whisper = new WhisperProvider({ runtimeRoot, tempRoot });
const ollama = new OllamaProvider();

// V2 wiring: one upload store and one lazily-loaded scope registry shared by
// every /api/v2/* route. Uploads land under data/v2-uploads (auto-mkdir in
// createUploadStore.put; directory is gitignored except for .gitkeep).
const v2UploadStore = createUploadStore({ baseDir: path.join(projectRoot, 'data', 'v2-uploads') });
let v2RegistryPromise = null;
function ensureV2Registry() {
  v2RegistryPromise ??= loadScopeRegistry();
  return v2RegistryPromise;
}

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

async function handleApi(request, response, url, traceId, config) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    const [stt, llm] = await Promise.all([whisper.health(), ollama.health()]);
    writeJson(response, 200, toolEnvelope('provider_health', traceId, stt.ready ? 'PASS' : 'FAIL', {
      server: { ready: true, bound_to: `${config.host}:${config.port}`, mode: config.lanMode ? 'lan-demo' : 'local-only' },
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
    const model = String(input.model || 'base');
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
    const result = await whisper.transcribe(artifacts.audioPath(input.audio_id), { model, language });
    const transcript = await artifacts.putTranscript({
      audio_id: input.audio_id,
      ...result,
      source_hash: audioMetadata.source_hash,
      attempt,
    }, { idempotencyKey });
    writeJson(response, 201, toolEnvelope('transcribe_audio', traceId, 'PASS', { transcript, reused: false }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/transcripts/manual') {
    const input = await readJson(request);
    const rawText = String(input.raw_text || '').trim();
    const keyHash = crypto.createHash('sha256').update(`${input.language || 'zh'}:${rawText}`).digest('hex');
    const transcript = await artifacts.putManualTranscript({ raw_text: rawText, language: input.language }, {
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
    const input = await readJson(request);
    writeJson(response, 200, await confirmReportDraft({
      draft: input.draft,
      validatorRunId: input.validator_run_id,
      technicianId: input.technician_id,
      technicianName: input.technician_name,
      store: reports,
      traceId,
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/save') {
    const input = await readJson(request);
    writeJson(response, 200, await saveConfirmedReport({
      draft: input.draft,
      confirmationToken: input.confirmation_token,
      store: reports,
      traceId,
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reports/export') {
    const input = await readJson(request);
    writeJson(response, 200, await exportConfirmedReport({
      draft: input.draft,
      confirmationToken: input.confirmation_token,
      store: reports,
      traceId,
    }));
    return;
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
    writeJson(response, 201, toolEnvelope('v2_upload', traceId, 'PASS', { upload: record }));
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
        warnings: [`Context "${contextId}" resolves to HVAC; deterministic V2 fact extraction is only available for SBS/BUS and SBS/RAIL (HVAC stays on the V1 flow).`],
      }));
      return;
    }
    const result = await extractV2Facts({ contextId, rawText: input.raw_text, registry });
    writeJson(response, 200, toolEnvelope('v2_facts_extract', traceId, 'PASS', {
      facts: result.facts,
      warnings: result.warnings,
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
        warnings: [`Context "${contextId}" resolves to HVAC; V2 report building is only available for SBS/BUS and SBS/RAIL.`],
      }));
      return;
    }
    const facts = Array.isArray(input.facts) ? input.facts : [];
    const factsReceiptId = input.facts_receipt_id ? String(input.facts_receipt_id) : undefined;
    const knowledgeHits = Array.isArray(input.knowledge_hits) ? input.knowledge_hits : [];
    const build = resolved.scopeId === 'SBS_BUS' ? buildBusReportSections : buildRailReportSections;
    const report = build({ facts, factsReceiptId });
    const plan = planV2Report({ scopeId: resolved.scopeId, facts, factsReceiptId });
    const violations = [
      ...assertNoServiceFactInvention({ facts, knowledgeHits }),
      ...checkHardGates({ scopeId: resolved.scopeId, facts }).violations,
    ];
    const schema = resolved.scopeId === 'SBS_BUS'
      ? { id: 'sbs_bus_maintenance', version: '0' }
      : { id: 'sbs_rail_maintenance', version: '0' };
    const draftFingerprint = hashValue({ contextId, facts, sections: report.sections });
    const draft = {
      report_id: `report_${draftFingerprint.slice(7, 19)}`,
      report_version: 1,
      schema_id: schema.id,
      schema_version: schema.version,
      scope_id: resolved.scopeId,
      context_id: contextId,
      template_version: report.reportVersion,
      facts_hash: hashValue(facts),
      sections: report.sections,
      missing_required_fields: plan.missing_required_fields,
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
    const validationReceipt = await reports.recordStructuredValidation({ draft, validation, facts });
    writeJson(response, 200, toolEnvelope('v2_report_build', traceId, status, {
      report: {
        scope_id: resolved.scopeId,
        context_id: contextId,
        reportVersion: report.reportVersion,
        sections: report.sections,
        missing_required_fields: plan.missing_required_fields,
      },
      draft,
      validation_receipt: validationReceipt,
      gates: { violations },
    }, { retryable: false }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/reports/confirm') {
    const input = await readJson(request);
    writeJson(response, 200, await confirmReportDraft({
      draft: input.draft,
      validatorRunId: input.validator_run_id,
      technicianId: input.technician_id,
      technicianName: input.technician_name,
      store: reports,
      traceId,
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/reports/save') {
    const input = await readJson(request);
    writeJson(response, 200, await saveConfirmedReport({
      draft: input.draft,
      confirmationToken: input.confirmation_token,
      store: reports,
      traceId,
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v2/reports/export') {
    const input = await readJson(request);
    writeJson(response, 200, await exportConfirmedReport({
      draft: input.draft,
      confirmationToken: input.confirmation_token,
      store: reports,
      traceId,
    }));
    return;
  }

  writeJson(response, 404, toolEnvelope('http_router', traceId, 'FAIL', {}, { error_code: 'NOT_FOUND' }));
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/locales/en.js', ['locales/en.js', 'text/javascript; charset=utf-8']],
  ['/locales/zh-CN.js', ['locales/zh-CN.js', 'text/javascript; charset=utf-8']],
  ['/locales/overrides.js', ['locales/overrides.js', 'text/javascript; charset=utf-8']],
  ['/report-runtime.js', ['report-runtime.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/audio-recorder.js', ['audio-recorder.js', 'text/javascript; charset=utf-8']],
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

export function createServer({ config = resolveServerConfig() } = {}) {
  return http.createServer(async (request, response) => {
    const traceId = `trace_${crypto.randomUUID()}`;
    const url = new URL(request.url, 'http://server.invalid');
    try {
      if (url.pathname.startsWith('/api/')) {
        const authorization = authorizeApiRequest(request, config);
        if (!authorization.ok) {
          denyRequest(response, traceId, authorization.status, authorization.code);
          return;
        }
        await handleApi(request, response, url, traceId, config);
      } else if (request.method === 'POST' && url.pathname === '/session-bootstrap') {
        if (!canBootstrapLocalSession(request, config)) {
          denyRequest(response, traceId, 403, 'REQUEST_DENIED');
          return;
        }
        writeJson(response, 200, { status: 'PASS', token: config.token, mode: 'local-only' });
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
        message: status >= 500 ? 'Internal server error.' : String(error.message),
      }, { retryable: error.retryable, error_code: error.code || 'INTERNAL_ERROR' }));
    }
  });
}

export async function startServer({ env = process.env } = {}) {
  const config = resolveServerConfig(env);
  await fs.mkdir(tempRoot, { recursive: true });
  const server = createServer({ config });
  server.listen(config.port, config.host, () => {
    for (const message of startupMessages(config)) console.log(message);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
}
