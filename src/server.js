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
import { TemplateStore } from './storage/templates.js';
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
    const facts = Array.isArray(input.facts) ? input.facts : [];
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
    const reportSessionId = String(input.report_session_id || `server_${traceId}`).slice(0, 160);
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
  ['/template-catalog.js', ['template-catalog.js', 'text/javascript; charset=utf-8']],
  ['/template-workspace.js', ['template-workspace.js', 'text/javascript; charset=utf-8']],
  ['/template-app.js', ['template-app.js', 'text/javascript; charset=utf-8']],
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
