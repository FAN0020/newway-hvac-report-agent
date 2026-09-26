import crypto from 'node:crypto';
import {
  assertExpectedRevision,
  createEvidence,
  createEvidenceSpan,
  createConfirmedFieldCandidate,
  createAgentRun,
  createFieldCandidate,
  createGuidanceContext,
  createTechnicianConfirmationEvent,
  createTranscriptArtifact,
  createTranscriptReview,
  hashContract,
} from '../domain/index.js';
import { runAuthoritativeAgent, AGENT_PROCESSING_VERSION } from '../agent/index.js';
import { extractServiceFacts } from '../tools/extract-service-facts.js';
import { extractV2Facts } from '../tools/extract-v2-facts.js';
import { buildTranscriptCorrectionCandidates } from '../tools/hvac-knowledge.js';
import { applyConfirmedTranscriptCorrections, reviewV2Transcript } from '../v2/transcript-review.js';
import { buildFollowUpQuestions } from '../v2/guided-reporting.js';
import { planV2Report } from '../v2/report-builder.js';
import { allowedScopes, resolveContext } from '../v2/scope.js';
import { ingestDocument, UPLOAD_STATUS } from '../v2/upload.js';
import { createRetriever } from '../v2/retrieval.js';
import { mapFactsForTemplate, templateFor } from '../../web/template-catalog.js';

const PROCESSING_VERSION = 'authoritative-capture.v1';
const EXTRACTION_VERSION = 'deterministic-extraction.v2';
const RETRIEVAL_VERSION = 'scope-lexical.v1';
const CONTEXT_BY_SCOPE = Object.freeze({
  HVAC: 'HVAC',
  SBS_BUS: 'SBS/BUS',
  SBS_RAIL: 'SBS/RAIL',
  OILFIELD: 'OILFIELD',
  POWER_GRID: 'POWER/GRID',
});

function workflowError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reportBinding(session) {
  return {
    report_session_id: session.session_id,
    template_id: session.template_binding.template_id,
    template_version: session.template_binding.template_version,
    context_id: session.context_binding.context_id,
    context_version: session.context_binding.context_version,
    scope_id: session.context_binding.scope_id,
  };
}

function transcriptInput({ session, evidence, rawText, language, provider, model, segments, createdAt }) {
  return {
    session_id: session.session_id,
    source_evidence_id: evidence.evidence_id,
    source_hash: evidence.source_hash,
    raw_text: rawText,
    language,
    provider,
    model,
    processing_version: PROCESSING_VERSION,
    template_binding: session.template_binding,
    context_binding: session.context_binding,
    created_at: createdAt,
    segments,
  };
}

function exactFactSpan(fact, rawText) {
  const span = fact.source_span;
  if (!span || rawText.slice(span.start, span.end) !== span.text) {
    throw workflowError('Extractor returned fact provenance that does not match the transcript.', 'INVALID_EXTRACTED_PROVENANCE', 409);
  }
  return span;
}

function correctedTextProjection(rawText, items, decisions) {
  const accepted = new Set(decisions.filter((item) => item.decision === 'ACCEPT').map((item) => item.review_item_id));
  const suggestions = items
    .filter((item) => item.kind === 'CORRECTION' && accepted.has(item.review_item_id))
    .map((item) => ({
      correction_id: item.review_item_id,
      start: item.source_span.start,
      end: item.source_span.end,
      source_text: item.source_span.quote,
      suggested_text: item.proposed_text,
    }))
    .sort((a, b) => a.start - b.start);
  const effectiveText = applyConfirmedTranscriptCorrections(rawText, suggestions, suggestions.map((item) => item.correction_id));
  const pieces = [];
  let rawCursor = 0;
  let effectiveCursor = 0;
  const appendRaw = (start, end) => {
    if (end <= start) return;
    const length = end - start;
    pieces.push({ type: 'RAW', effective_start: effectiveCursor, effective_end: effectiveCursor + length, raw_start: start, raw_end: end });
    effectiveCursor += length;
  };
  for (const suggestion of suggestions) {
    appendRaw(rawCursor, suggestion.start);
    const length = suggestion.suggested_text.length;
    pieces.push({
      type: 'REPLACEMENT',
      effective_start: effectiveCursor,
      effective_end: effectiveCursor + length,
      raw_start: suggestion.start,
      raw_end: suggestion.end,
    });
    effectiveCursor += length;
    rawCursor = suggestion.end;
  }
  appendRaw(rawCursor, rawText.length);
  const mapSpan = (span) => {
    const overlapping = pieces.filter((piece) => span.start < piece.effective_end && span.end > piece.effective_start);
    if (!overlapping.length) throw workflowError('Corrected transcript span cannot be mapped to raw evidence.', 'INVALID_EXTRACTED_PROVENANCE', 409);
    const rawStarts = overlapping.map((piece) => piece.type === 'RAW'
      ? piece.raw_start + Math.max(0, span.start - piece.effective_start)
      : piece.raw_start);
    const rawEnds = overlapping.map((piece) => piece.type === 'RAW'
      ? piece.raw_start + Math.min(piece.effective_end, span.end) - piece.effective_start
      : piece.raw_end);
    const start = Math.min(...rawStarts);
    const end = Math.max(...rawEnds);
    return { start, end, text: rawText.slice(start, end) };
  };
  return { effectiveText, mapSpan };
}

export class AuthoritativeCaptureService {
  constructor({
    artifactStore,
    sessionStore,
    whisperProvider,
    scopeRegistry,
    scopeRegistryProvider,
    uploadStore,
    retriever,
    jobContextProvider,
    clock = () => new Date().toISOString(),
  } = {}) {
    if (!artifactStore || !sessionStore || !whisperProvider?.transcribe) {
      throw new TypeError('Artifact, ReportSession, and Whisper services are required.');
    }
    this.artifactStore = artifactStore;
    this.sessionStore = sessionStore;
    this.whisperProvider = whisperProvider;
    this.scopeRegistry = scopeRegistry || null;
    this.scopeRegistryProvider = scopeRegistryProvider || null;
    this.uploadStore = uploadStore || null;
    this.retriever = retriever || null;
    this.jobContextProvider = jobContextProvider || null;
    this.clock = clock;
  }

  async guidanceDependencies() {
    const registry = this.scopeRegistry || (this.scopeRegistryProvider ? await this.scopeRegistryProvider() : null);
    if (!registry) return null;
    return {
      registry,
      retriever: this.retriever || createRetriever({ registry, uploadStore: this.uploadStore }),
    };
  }

  async ingestGuidanceUpload({ session_id: sessionId, expected_revision: expectedRevision, filename, mime_type: mimeType, buffer } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'CONTEXT') {
      throw workflowError('Guidance uploads are only accepted before capture begins.', 'GUIDANCE_UPLOAD_PHASE_CLOSED', 409);
    }
    const dependencies = await this.guidanceDependencies();
    if (!dependencies || !this.uploadStore) {
      throw workflowError('Guidance ingestion is not configured.', 'GUIDANCE_INGESTION_UNAVAILABLE', 503);
    }
    const resolved = resolveContext(session.context_binding.context_id, dependencies.registry);
    if (resolved.scopeId !== session.context_binding.scope_id) {
      throw workflowError('ReportSession scope does not match the scope registry.', 'REPORT_SESSION_SCOPE_MISMATCH', 409);
    }
    if (!resolved.uploadAllowed) {
      throw workflowError('This ReportSession scope does not allow guidance uploads.', 'UPLOAD_NOT_ALLOWED', 409);
    }
    const upload = await ingestDocument({
      scopeId: session.context_binding.scope_id,
      filename,
      buffer,
      mimeType,
      metadata: {
        uploader: 'principal:demo-technician',
        source: 'report-session-guidance-upload',
        scenario: 'authoritative-report-session',
        report_session_id: session.session_id,
      },
      store: this.uploadStore,
    });
    if (upload.status !== UPLOAD_STATUS.READY) {
      throw workflowError(
        upload.errors?.[0]?.message || 'Guidance upload could not be indexed.',
        upload.errors?.[0]?.code || 'GUIDANCE_UPLOAD_FAILED',
        422,
      );
    }
    await this.sessionStore.putRecord('guidance-uploads', upload.upload_id, upload);
    const recorded = await this.sessionStore.recordEvent({
      session_id: session.session_id,
      expected_revision: session.revision,
      event_type: 'GUIDANCE_UPLOAD_INGESTED',
      occurred_at: this.clock(),
      details: {
        upload_id: upload.upload_id,
        scope_id: upload.scope_id,
        document_version: upload.document_version,
      },
      additions: { guidance_upload_ids: [upload.upload_id] },
    });
    return { session: recorded.session, upload };
  }

  async createSession({ template_id: templateId, template_version: templateVersion, job_context_ref: jobContextRef } = {}) {
    let template;
    try {
      template = templateFor(templateId);
    } catch {
      throw workflowError('Published template was not found.', 'TEMPLATE_NOT_FOUND', 404);
    }
    if (template.templateVersion !== String(templateVersion || '')) {
      throw workflowError('Requested template version does not match the published template.', 'TEMPLATE_VERSION_MISMATCH', 409);
    }
    const scopeId = template.domain;
    let created = await this.sessionStore.create({
      session_id: `session_${crypto.randomUUID()}`,
      template_binding: { template_id: template.templateId, template_version: template.templateVersion },
      context_binding: {
        context_id: CONTEXT_BY_SCOPE[scopeId],
        context_version: template.contextCorpus.version,
        scope_id: scopeId,
      },
      job_context_ref: jobContextRef,
      created_at: this.clock(),
    });
    if (this.jobContextProvider?.resolve) {
      const context = await this.jobContextProvider.resolve({
        job_context_ref: jobContextRef,
        template_id: template.templateId,
        template_version: template.templateVersion,
      });
      const fields = Array.isArray(context?.fields) ? context.fields : [];
      if (fields.length) {
        const lines = fields.map((item) => `${item.field_id}=${item.value}${item.unit ? ` ${item.unit}` : ''}`);
        const sourceText = lines.join('\n');
        const sourceDigest = digest(Buffer.from(sourceText, 'utf8'));
        const storageRef = await this.sessionStore.putTextSource(sourceDigest, sourceText);
        const evidence = createEvidence({
          evidence_type: 'SYSTEM_RECORD', source_hash: `sha256:${sourceDigest}`, storage_ref: storageRef, created_at: this.clock(),
          metadata: { record_id: context.record_id, version: context.version, report_binding: reportBinding(created.session) },
        });
        await this.sessionStore.putRecord('evidence', evidence.evidence_id, evidence);
        const spans = [];
        const candidates = [];
        let cursor = 0;
        for (let index = 0; index < fields.length; index += 1) {
          const item = fields[index];
          const line = lines[index];
          const renderedValue = `${item.value}${item.unit ? ` ${item.unit}` : ''}`;
          const start = cursor + line.indexOf(renderedValue);
          const span = createEvidenceSpan({
            evidence_id: evidence.evidence_id, start_offset: start, end_offset: start + renderedValue.length,
            quote: renderedValue, source_text: sourceText,
          });
          const definition = template.schema.fields.find((entry) => entry.id === item.field_id || (entry.id.endsWith('.*') && item.field_id.startsWith(entry.id.slice(0, -1))));
          const candidate = createFieldCandidate({
            session_id: created.session.session_id,
            field_id: item.field_id,
            claim: { kind: 'VALUE', value: item.unit ? { value: item.value, unit: item.unit } : item.value },
            unit: item.unit,
            support_type: 'AUTHORITATIVE_SYSTEM_DATA',
            assessment: 'VALID',
            evidence_refs: [{ evidence_id: evidence.evidence_id, span_id: span.span_id }],
            source_ref: evidence.evidence_id,
            extraction: { method: 'authoritative-job-context', version: String(context.version || PROCESSING_VERSION) },
            risk_class: definition?.critical || definition?.requiresTechnicianConfirmation ? 'CRITICAL' : 'STANDARD',
            confidence_class: 'DIRECT_EVIDENCE',
            source_context: {
              domain: created.session.context_binding.scope_id,
              context_id: created.session.context_binding.context_id,
              context_version: created.session.context_binding.context_version,
              scope_id: created.session.context_binding.scope_id,
            },
          });
          await this.sessionStore.putRecord('evidence-spans', span.span_id, span);
          await this.sessionStore.putRecord('field-candidates', candidate.candidate_id, candidate);
          spans.push(span);
          candidates.push(candidate);
          cursor += line.length + 1;
        }
        created = await this.sessionStore.recordEvent({
          session_id: created.session.session_id,
          expected_revision: created.session.revision,
          event_type: 'AUTHORITATIVE_CONTEXT_INGESTED',
          occurred_at: this.clock(),
          details: { evidence_id: evidence.evidence_id, record_id: context.record_id, field_candidate_ids: candidates.map((item) => item.candidate_id) },
          additions: {
            evidence_ids: [evidence.evidence_id], evidence_span_ids: spans.map((item) => item.span_id), field_candidate_ids: candidates.map((item) => item.candidate_id),
          },
        });
      }
    }
    const computed = await this.persistAgentState(created.session);
    return { ...created, session: computed.session, agent_state: computed.agent_state };
  }

  async persistAgentState(session) {
    const chain = await this.sessionStore.loadChain(session.session_id);
    const agentState = runAuthoritativeAgent({
      session,
      template: templateFor(session.template_binding.template_id),
      candidates: chain.field_candidates,
      guidance_contexts: chain.guidance_contexts,
      created_at: this.clock(),
    });
    const run = createAgentRun({
      session_id: session.session_id,
      session_revision: session.revision,
      processing_version: AGENT_PROCESSING_VERSION,
      created_at: agentState.created_at,
      agent_state: agentState,
    });
    const attached = await this.sessionStore.attachAgentRun({
      session_id: session.session_id, expected_revision: session.revision, run,
    });
    return { session: attached, agent_state: agentState, agent_run: run };
  }

  async getAgentState(sessionId) {
    const chain = await this.sessionStore.loadChain(sessionId);
    if (chain.agent_state?.session_revision === chain.session.revision) {
      return { session: chain.session, agent_state: chain.agent_state };
    }
    return this.persistAgentState(chain.session);
  }

  async extractCandidates({ session, transcript, supportType, extractionText = transcript.raw_text, mapSourceSpan = (span) => span, confirmedCorrections = [] }) {
    const template = templateFor(session.template_binding.template_id);
    let facts;
    if (session.context_binding.scope_id === 'HVAC') {
      const extracted = await extractServiceFacts({
        transcript: { artifact_id: transcript.transcript_id, raw_text: transcript.raw_text },
        confirmedCorrections,
      });
      if (extracted.status !== 'PASS') throw workflowError('HVAC candidate extraction failed.', extracted.error_code || 'CANDIDATE_EXTRACTION_FAILED', 409);
      facts = extracted.data.facts;
    } else {
      facts = (await extractV2Facts({
        contextId: session.context_binding.context_id,
        rawText: extractionText,
      })).facts;
    }
    const accepted = mapFactsForTemplate(template.templateId, facts).facts;
    const noParts = /\bno parts (?:were )?used\b/iu.exec(extractionText);
    if (noParts && template.schema.fields.some((field) => field.id === 'parts.part_number')
      && !accepted.some((fact) => fact.field === 'parts.part_number')) {
      accepted.push({
        field: 'parts.part_number',
        value: null,
        claim_kind: 'EXPLICIT_NONE',
        support_status: 'CONFIRMED_BY_EVIDENCE',
        critical: false,
        source_span: { start: noParts.index, end: noParts.index + noParts[0].length, text: noParts[0] },
      });
    }
    const spans = [];
    const candidates = [];
    for (const fact of accepted) {
      const extractedSource = exactFactSpan(fact, extractionText);
      const source = mapSourceSpan(extractedSource);
      const span = createEvidenceSpan({
        evidence_id: transcript.transcript_id,
        start_offset: source.start,
        end_offset: source.end,
        quote: source.text,
        source_text: transcript.raw_text,
      });
      const candidate = createFieldCandidate({
        session_id: session.session_id,
        field_id: fact.field,
        claim: fact.claim_kind === 'EXPLICIT_NONE'
          ? { kind: 'EXPLICIT_NONE' }
          : { kind: 'VALUE', value: fact.unit === undefined ? fact.value : { value: fact.value, unit: fact.unit } },
        unit: fact.unit,
        support_type: supportType,
        assessment: fact.support_status === 'UNCERTAIN' ? 'UNCERTAIN' : 'VALID',
        evidence_refs: [{ evidence_id: transcript.transcript_id, span_id: span.span_id }],
        source_ref: transcript.transcript_id,
        extraction: { method: 'deterministic-rule', version: EXTRACTION_VERSION },
        risk_class: fact.critical ? 'CRITICAL' : 'STANDARD',
        confidence_class: fact.support_status === 'UNCERTAIN' ? 'UNCERTAIN' : 'DIRECT_EVIDENCE',
        source_context: {
          domain: session.context_binding.scope_id,
          context_id: session.context_binding.context_id,
          context_version: session.context_binding.context_version,
          scope_id: session.context_binding.scope_id,
        },
      });
      await this.sessionStore.putRecord('evidence-spans', span.span_id, span);
      await this.sessionStore.putRecord('field-candidates', candidate.candidate_id, candidate);
      spans.push(span);
      candidates.push(candidate);
    }
    return { spans, candidates, facts: accepted };
  }

  async retrieveGuidance({ session, transcript, facts, query = transcript.raw_text }) {
    const dependencies = await this.guidanceDependencies();
    if (!dependencies) return { session, guidanceContext: null };
    const retrieval = await dependencies.retriever({
      contextId: session.context_binding.context_id,
      query,
      topK: 3,
      includeUploads: true,
      permittedUploadIds: session.guidance_upload_ids,
    });
    const permittedKnowledge = allowedScopes(session.context_binding.context_id, dependencies.registry)
      .filter((scopeId) => !scopeId.startsWith('USER_UPLOADED:'))
      .filter((scopeId) => (dependencies.registry.knowledge_files?.[scopeId] || []).length > 0)
      .map((scopeId) => `knowledge:${scopeId}`);
    const permittedCorpora = [
      ...permittedKnowledge,
      ...session.guidance_upload_ids.map((uploadId) => `upload:${uploadId}`),
    ];
    let applicableModules = [];
    let followUpQuestions = [];
    if (session.context_binding.scope_id !== 'HVAC') {
      const plan = planV2Report({
        scopeId: session.context_binding.scope_id,
        facts,
        factsReceiptId: transcript.transcript_id,
      });
      applicableModules = plan.sections.map((section) => section.id);
      followUpQuestions = buildFollowUpQuestions({
        scopeId: session.context_binding.scope_id,
        missingSections: plan.missing_required_fields,
      });
    }
    const guidanceContext = createGuidanceContext({
      session_id: session.session_id,
      context_id: session.context_binding.context_id,
      scope_id: session.context_binding.scope_id,
      context_version: session.context_binding.context_version,
      query,
      retrieval_method: 'LEXICAL_DETERMINISTIC',
      retrieval_version: RETRIEVAL_VERSION,
      permitted_corpora: permittedCorpora,
      retrieved_at: this.clock(),
      passages: retrieval.results.map((item) => ({
        source_type: item.source,
        scope_id: item.scope_id,
        document_id: item.doc_id,
        chunk_id: item.chunk_id,
        document_version: item.source === 'upload'
          ? item.provenance.document_version
          : item.provenance.knowledge_version || item.provenance.schema_version,
        text: item.text,
        score: item.score,
        provenance: item.provenance,
      })),
      applicable_modules: applicableModules,
      follow_up_questions: followUpQuestions,
    });
    await this.sessionStore.putRecord('guidance-contexts', guidanceContext.guidance_context_id, guidanceContext);
    const recorded = await this.sessionStore.recordEvent({
      session_id: session.session_id,
      expected_revision: session.revision,
      event_type: 'GUIDANCE_RETRIEVED',
      occurred_at: this.clock(),
      details: {
        guidance_context_id: guidanceContext.guidance_context_id,
        query_source: transcript.transcript_id,
        result_count: guidanceContext.passages.length,
        warnings: retrieval.warnings,
      },
      additions: { guidance_context_ids: [guidanceContext.guidance_context_id] },
    });
    return { session: recorded.session, guidanceContext };
  }

  async submitFieldAnswer({ session_id: sessionId, expected_revision: expectedRevision, field_id: fieldId, value, unit } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'RESOLVE') {
      throw workflowError('Technician field answers are accepted only during Resolve.', 'FIELD_ANSWER_PHASE_MISMATCH', 409);
    }
    const template = templateFor(session.template_binding.template_id);
    const normalizedFieldId = String(fieldId || '').trim();
    const definition = template.schema.fields.find((item) => (
      item.id.endsWith('.*') ? normalizedFieldId.startsWith(item.id.slice(0, -1)) : normalizedFieldId === item.id
    ));
    if (!definition) throw workflowError('Field is outside the bound template version.', 'FIELD_NOT_IN_TEMPLATE', 400);
    const normalizedValue = typeof value === 'string' ? value.trim() : value;
    const explicitlyCleared = normalizedValue === '' || normalizedValue === null || normalizedValue === undefined || normalizedValue === 'NOT_CHECKED';
    const allowed = definition.allowedValues || definition.allowedStatuses;
    if (!explicitlyCleared && allowed && !allowed.includes(String(normalizedValue))) {
      throw workflowError('Technician field answer is outside the template allowed values.', 'FIELD_ANSWER_INVALID', 400);
    }
    const sourceText = explicitlyCleared ? '[technician explicitly cleared this field]' : String(normalizedValue);
    const sourceDigest = digest(Buffer.from(sourceText, 'utf8'));
    const storageRef = await this.sessionStore.putTextSource(sourceDigest, sourceText);
    const evidence = createEvidence({
      evidence_type: 'MANUAL_INPUT',
      source_hash: `sha256:${digest(Buffer.from(sourceText, 'utf8'))}`,
      storage_ref: storageRef,
      created_at: this.clock(),
      metadata: {
        input_kind: 'TECHNICIAN_FIELD_ANSWER',
        field_id: normalizedFieldId,
        report_binding: reportBinding(session),
      },
    });
    const span = createEvidenceSpan({
      evidence_id: evidence.evidence_id,
      start_offset: 0,
      end_offset: sourceText.length,
      quote: sourceText,
      source_text: sourceText,
    });
    const candidate = createFieldCandidate({
      session_id: session.session_id,
      field_id: normalizedFieldId,
      claim: explicitlyCleared ? { kind: 'EXPLICIT_NONE' } : {
        kind: 'VALUE', value: unit === undefined ? normalizedValue : { value: normalizedValue, unit: String(unit) },
      },
      unit: explicitlyCleared || unit === undefined ? undefined : String(unit),
      support_type: 'MANUAL_TECHNICIAN_INPUT',
      assessment: 'VALID',
      evidence_refs: [{ evidence_id: evidence.evidence_id, span_id: span.span_id }],
      source_ref: evidence.evidence_id,
      extraction: { method: 'technician-field-answer', version: PROCESSING_VERSION },
      risk_class: definition.critical || definition.requiresTechnicianConfirmation ? 'CRITICAL' : 'STANDARD',
      confidence_class: 'DIRECT_EVIDENCE',
      source_context: {
        domain: session.context_binding.scope_id,
        context_id: session.context_binding.context_id,
        context_version: session.context_binding.context_version,
        scope_id: session.context_binding.scope_id,
      },
    });
    await this.sessionStore.putRecord('evidence', evidence.evidence_id, evidence);
    await this.sessionStore.putRecord('evidence-spans', span.span_id, span);
    await this.sessionStore.putRecord('field-candidates', candidate.candidate_id, candidate);
    const recorded = await this.sessionStore.recordEvent({
      session_id: session.session_id,
      expected_revision: session.revision,
      event_type: 'FIELD_CANDIDATE_RECORDED',
      occurred_at: this.clock(),
      details: { field_id: normalizedFieldId, candidate_id: candidate.candidate_id, evidence_id: evidence.evidence_id },
      additions: {
        evidence_ids: [evidence.evidence_id],
        evidence_span_ids: [span.span_id],
        field_candidate_ids: [candidate.candidate_id],
      },
    });
    const computed = await this.persistAgentState(recorded.session);
    return { session: computed.session, evidence, span, candidate, agent_state: computed.agent_state };
  }

  async confirmFieldCandidate({ session_id: sessionId, expected_revision: expectedRevision, candidate_id: candidateId } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'RESOLVE' || !session.field_candidate_ids.includes(String(candidateId || ''))) {
      throw workflowError('Candidate belongs to another ReportSession or phase.', 'FIELD_CANDIDATE_BINDING_MISMATCH', 409);
    }
    const source = await this.sessionStore.readRecord('field-candidates', candidateId);
    if (source.session_id !== session.session_id || source.support_type === 'RAG_GUIDANCE') {
      throw workflowError('Candidate belongs to another ReportSession.', 'FIELD_CANDIDATE_BINDING_MISMATCH', 409);
    }
    const principalRef = 'principal:demo-technician';
    const event = createTechnicianConfirmationEvent({
      session_id: session.session_id,
      revision: session.revision + 1,
      field_id: source.field_id,
      candidate_id: source.candidate_id,
      technician_principal_ref: principalRef,
      occurred_at: this.clock(),
    });
    const candidate = createConfirmedFieldCandidate({
      session_id: session.session_id,
      field_id: source.field_id,
      confirmed_candidate_id: source.candidate_id,
      claim: source.claim,
      unit: source.unit,
      evidence_refs: source.evidence_refs,
      source_ref: source.source_ref,
      extraction: { method: 'technician-confirmation', version: PROCESSING_VERSION },
      risk_class: source.risk_class,
      confidence_class: 'CONFIRMED',
      source_context: source.source_context,
    }, { confirmation_event: event });
    await this.sessionStore.putRecord('field-candidates', candidate.candidate_id, candidate);
    const recorded = await this.sessionStore.recordEvent({
      session_id: session.session_id,
      expected_revision: session.revision,
      event_type: 'TECHNICIAN_CONFIRMATION',
      principal_ref: principalRef,
      occurred_at: event.occurred_at,
      details: event.payload,
      additions: { field_candidate_ids: [candidate.candidate_id] },
    });
    if (recorded.event.event_id !== event.event_id) {
      throw workflowError('Technician confirmation event identity mismatch.', 'CONFIRMATION_EVENT_MISMATCH', 409);
    }
    const computed = await this.persistAgentState(recorded.session);
    return { session: computed.session, event: recorded.event, candidate, agent_state: computed.agent_state };
  }

  async answerResolutionItem({ session_id: sessionId, expected_revision: expectedRevision, resolution_id: resolutionId, answer, idempotency_key: idempotencyKey } = {}) {
    const requestHash = hashContract({ session_id: sessionId, resolution_id: resolutionId, answer });
    const reused = await this.sessionStore.claimAnswer({
      session_id: sessionId, idempotency_key: idempotencyKey, request_hash: requestHash,
    });
    if (reused) return { ...reused, reused: true };
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'RESOLVE') {
      throw workflowError('Resolution answers are accepted only during Resolve.', 'RESOLUTION_ANSWER_PHASE_MISMATCH', 409);
    }
    const current = await this.getAgentState(sessionId);
    const item = current.agent_state.resolution_queue.find((entry) => entry.resolution_id === String(resolutionId || ''));
    if (!item) throw workflowError('Resolution item is not open in the current Agent state.', 'RESOLUTION_ITEM_NOT_OPEN', 409);
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      throw workflowError('A structured resolution answer is required.', 'INVALID_RESOLUTION_ANSWER');
    }
    const kind = String(answer.kind || '');
    let claim;
    let unit;
    let selectedSource = null;
    if (kind === 'SELECT_CANDIDATE') {
      const candidateId = String(answer.candidate_id || '');
      if (!item.candidate_ids.includes(candidateId)) {
        throw workflowError('Selected candidate is outside the resolution item.', 'INVALID_RESOLUTION_ANSWER');
      }
      selectedSource = await this.sessionStore.readRecord('field-candidates', candidateId);
      claim = selectedSource.claim;
      unit = selectedSource.unit || undefined;
    } else if (kind === 'VALUE') {
      const value = typeof answer.value === 'string' ? answer.value.trim() : answer.value;
      if (value === '' || value === null || value === undefined) throw workflowError('Resolution value is required.', 'INVALID_RESOLUTION_ANSWER');
      unit = answer.unit === undefined ? undefined : String(answer.unit);
      claim = { kind: 'VALUE', value: unit ? { value, unit } : value };
    } else if (kind === 'SEMANTIC_STATE') {
      const semantic = String(answer.state || '');
      const values = {
        NOT_ESTABLISHED: 'Root cause not established',
        FURTHER_INVESTIGATION_REQUIRED: 'Further investigation required',
        SUSPECTED: answer.value ? `Suspected root cause: ${String(answer.value).trim()}` : 'Suspected root cause',
        CONFIRMED: answer.value ? String(answer.value).trim() : 'Confirmed root cause',
      };
      if (!values[semantic]) throw workflowError('Semantic resolution state is invalid.', 'INVALID_RESOLUTION_ANSWER');
      claim = { kind: 'VALUE', value: values[semantic] };
    } else if (kind === 'EXPLICIT_NONE') {
      claim = { kind: 'EXPLICIT_NONE' };
    } else if (kind === 'NOT_APPLICABLE') {
      claim = { kind: 'NOT_APPLICABLE' };
    } else {
      throw workflowError('Resolution answer kind is invalid.', 'INVALID_RESOLUTION_ANSWER');
    }

    const sourceText = JSON.stringify({ resolution_id: item.resolution_id, answer });
    const sourceDigest = digest(Buffer.from(sourceText, 'utf8'));
    const storageRef = await this.sessionStore.putTextSource(sourceDigest, sourceText);
    const evidence = createEvidence({
      evidence_type: 'MANUAL_INPUT', source_hash: `sha256:${sourceDigest}`, storage_ref: storageRef, created_at: this.clock(),
      metadata: { input_kind: 'TECHNICIAN_RESOLUTION_ANSWER', resolution_id: item.resolution_id, field_id: item.field_id, report_binding: reportBinding(session) },
    });
    const span = createEvidenceSpan({
      evidence_id: evidence.evidence_id, start_offset: 0, end_offset: sourceText.length, quote: sourceText, source_text: sourceText,
    });
    const template = templateFor(session.template_binding.template_id);
    const definition = template.schema.fields.find((entry) => entry.id === item.field_id || (entry.id.endsWith('.*') && item.field_id.startsWith(entry.id.slice(0, -1))));
    const sourceCandidate = createFieldCandidate({
      session_id: session.session_id, field_id: item.field_id, claim, unit,
      support_type: 'MANUAL_TECHNICIAN_INPUT', assessment: kind === 'SEMANTIC_STATE' && answer.state === 'SUSPECTED' ? 'UNCERTAIN' : 'VALID',
      evidence_refs: [{ evidence_id: evidence.evidence_id, span_id: span.span_id }], source_ref: evidence.evidence_id,
      extraction: { method: 'technician-resolution-answer', version: PROCESSING_VERSION },
      risk_class: definition?.critical || definition?.requiresTechnicianConfirmation ? 'CRITICAL' : 'STANDARD',
      confidence_class: kind === 'SEMANTIC_STATE' && answer.state === 'SUSPECTED' ? 'UNCERTAIN' : 'DIRECT_EVIDENCE',
      source_context: {
        domain: session.context_binding.scope_id, context_id: session.context_binding.context_id,
        context_version: session.context_binding.context_version, scope_id: session.context_binding.scope_id,
      },
    });
    const principalRef = 'principal:demo-technician';
    const event = createTechnicianConfirmationEvent({
      session_id: session.session_id, revision: session.revision + 1, field_id: item.field_id,
      candidate_id: sourceCandidate.candidate_id, technician_principal_ref: principalRef, occurred_at: this.clock(),
    });
    const linkedRefs = [
      ...sourceCandidate.evidence_refs,
      ...(selectedSource?.evidence_refs || []),
    ].filter((reference, index, values) => values.findIndex((value) => hashContract(value) === hashContract(reference)) === index);
    const resolvedCandidateIds = [...new Set([...item.candidate_ids, sourceCandidate.candidate_id])];
    const candidate = createConfirmedFieldCandidate({
      session_id: session.session_id, field_id: item.field_id, confirmed_candidate_id: sourceCandidate.candidate_id,
      claim, unit, evidence_refs: linkedRefs, source_ref: evidence.evidence_id,
      extraction: { method: 'technician-resolution-confirmation', version: PROCESSING_VERSION },
      risk_class: sourceCandidate.risk_class, confidence_class: 'CONFIRMED', source_context: sourceCandidate.source_context,
      resolution: {
        resolution_id: item.resolution_id, issue_ids: item.issue_ids,
        resolved_candidate_ids: resolvedCandidateIds, answer_kind: kind,
      },
    }, { confirmation_event: event });
    await this.sessionStore.putRecord('evidence', evidence.evidence_id, evidence);
    await this.sessionStore.putRecord('evidence-spans', span.span_id, span);
    await this.sessionStore.putRecord('field-candidates', sourceCandidate.candidate_id, sourceCandidate);
    await this.sessionStore.putRecord('field-candidates', candidate.candidate_id, candidate);
    const recorded = await this.sessionStore.recordEvent({
      session_id: session.session_id, expected_revision: session.revision, event_type: 'TECHNICIAN_CONFIRMATION',
      principal_ref: principalRef, occurred_at: event.occurred_at, details: event.payload,
      additions: {
        evidence_ids: [evidence.evidence_id], evidence_span_ids: [span.span_id],
        field_candidate_ids: [sourceCandidate.candidate_id, candidate.candidate_id],
      },
    });
    if (recorded.event.event_id !== event.event_id) throw workflowError('Technician confirmation event identity mismatch.', 'CONFIRMATION_EVENT_MISMATCH', 409);
    const computed = await this.persistAgentState(recorded.session);
    const response = {
      session: computed.session, evidence, span, candidate, source_candidate: sourceCandidate,
      confirmation_event: recorded.event, agent_state: computed.agent_state, reused: false,
    };
    await this.sessionStore.saveAnswer({
      session_id: sessionId, idempotency_key: idempotencyKey, request_hash: requestHash, response,
    });
    return response;
  }

  async reviewItems(session, transcript) {
    if (session.context_binding.scope_id === 'HVAC') {
      const review = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
      return review.candidates.map((candidate) => ({
        review_item_id: candidate.candidate_id,
        kind: 'CORRECTION',
        material: true,
        source_span: {
          start: candidate.source_span.start,
          end: candidate.source_span.end,
          quote: candidate.source_span.text,
        },
        proposed_text: candidate.candidate,
        category: candidate.risk || 'CRITICAL_TERMINOLOGY',
        reason: candidate.reason,
      }));
    }
    const review = reviewV2Transcript({ scopeId: session.context_binding.scope_id, rawText: transcript.raw_text });
    const corrections = review.correction_suggestions.map((item) => ({
      review_item_id: item.correction_id,
      kind: 'CORRECTION',
      material: true,
      source_span: { start: item.start, end: item.end, quote: item.source_text },
      proposed_text: item.suggested_text,
      category: item.category,
      reason: item.reason,
    }));
    const confirmations = review.confirmation_questions.flatMap((item) => {
      const quote = String(item.source_text || '');
      const start = transcript.raw_text.indexOf(quote);
      if (!quote || start < 0) return [];
      return [{
        review_item_id: item.question_id,
        kind: 'CONFIRMATION',
        material: true,
        source_span: { start, end: start + quote.length, quote },
        proposed_text: null,
        category: item.field || 'CRITICAL_TERMINOLOGY',
        reason: item.reason,
      }];
    });
    return [...corrections, ...confirmations];
  }

  async finishTranscript({ session, evidence, transcript, supportType }) {
    await this.sessionStore.putRecord('transcripts', transcript.transcript_id, transcript);
    const items = await this.reviewItems(session, transcript);
    if (items.length) {
      const review = createTranscriptReview({
        session_id: session.session_id,
        transcript_id: transcript.transcript_id,
        transcript_text: transcript.raw_text,
        status: 'PENDING',
        items,
        decisions: [],
      });
      await this.sessionStore.putRecord('transcript-reviews', review.review_id, review);
      const pending = await this.sessionStore.transition({
        session_id: session.session_id,
        expected_revision: session.revision,
        to_phase: 'CORRECTION_IF_NEEDED',
        event_type: 'TRANSCRIPT_REVIEW_REQUESTED',
        occurred_at: this.clock(),
        details: { transcript_id: transcript.transcript_id, transcript_review_id: review.review_id },
        additions: {
          transcript_ids: [transcript.transcript_id],
          transcript_review_ids: [review.review_id],
        },
      });
      return {
        session: pending.session,
        evidence,
        transcript,
        review,
        spans: [],
        candidates: [],
        reused: false,
        next_action: 'REVIEW_TRANSCRIPT',
      };
    }
    const { spans, candidates, facts } = await this.extractCandidates({ session, transcript, supportType });
    const guided = await this.retrieveGuidance({ session, transcript, facts });
    const completed = await this.sessionStore.transition({
      session_id: session.session_id,
      expected_revision: guided.session.revision,
      to_phase: 'RESOLVE',
      event_type: 'STRUCTURED_CANDIDATES_CREATED',
      occurred_at: this.clock(),
      details: {
        transcript_id: transcript.transcript_id,
        field_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      },
      additions: {
        transcript_ids: [transcript.transcript_id],
        evidence_span_ids: spans.map((span) => span.span_id),
        field_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      },
    });
    const computed = await this.persistAgentState(completed.session);
    return {
      session: computed.session,
      evidence,
      transcript,
      review: null,
      spans,
      candidates,
      guidance_context: guided.guidanceContext,
      reused: false,
      next_action: 'RESOLVE_REPORT_FIELDS',
      agent_state: computed.agent_state,
    };
  }

  async decideTranscriptReview({ session_id: sessionId, expected_revision: expectedRevision, review_id: reviewId, decisions } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'CORRECTION_IF_NEEDED' || !session.transcript_review_ids.includes(String(reviewId))) {
      throw workflowError('Transcript review belongs to another ReportSession or phase.', 'TRANSCRIPT_REVIEW_BINDING_MISMATCH', 409);
    }
    const pending = await this.sessionStore.readRecord('transcript-reviews', reviewId);
    if (pending.session_id !== session.session_id || pending.status !== 'PENDING') {
      throw workflowError('Transcript review belongs to another ReportSession or is no longer pending.', 'TRANSCRIPT_REVIEW_BINDING_MISMATCH', 409);
    }
    const transcript = await this.sessionStore.readRecord('transcripts', pending.transcript_id);
    if (transcript.session_id !== session.session_id) {
      throw workflowError('Transcript belongs to another ReportSession.', 'CAPTURE_BINDING_MISMATCH', 409);
    }
    const itemMap = new Map(pending.items.map((item) => [item.review_item_id, item]));
    if (!Array.isArray(decisions) || decisions.length !== itemMap.size) {
      throw workflowError('Every transcript review item requires exactly one decision.', 'INCOMPLETE_TRANSCRIPT_REVIEW', 400);
    }
    const normalized = decisions.map((decision) => {
      const item = itemMap.get(String(decision?.review_item_id || ''));
      const value = String(decision?.decision || '');
      if (!item || !['ACCEPT', 'REJECT', 'NO_CHANGE'].includes(value)) {
        throw workflowError('Transcript review decision is invalid.', 'INVALID_TRANSCRIPT_REVIEW_DECISION', 400);
      }
      return {
        review_item_id: item.review_item_id,
        decision: value,
        ...(value === 'ACCEPT' && item.kind === 'CORRECTION' ? { corrected_text: item.proposed_text } : {}),
      };
    });
    if (new Set(normalized.map((item) => item.review_item_id)).size !== itemMap.size) {
      throw workflowError('Transcript review decisions contain duplicates.', 'INVALID_TRANSCRIPT_REVIEW_DECISION', 400);
    }
    const review = createTranscriptReview({
      session_id: session.session_id,
      transcript_id: transcript.transcript_id,
      transcript_text: transcript.raw_text,
      status: 'REVIEWED',
      items: pending.items,
      decisions: normalized,
      reviewer_principal_ref: 'principal:demo-technician',
      reviewed_at: this.clock(),
    });
    await this.sessionStore.putRecord('transcript-reviews', review.review_id, review);
    const projection = correctedTextProjection(transcript.raw_text, pending.items, normalized);
    const confirmedCorrections = normalized.flatMap((decision) => {
      const item = itemMap.get(decision.review_item_id);
      if (decision.decision !== 'ACCEPT' || item.kind !== 'CORRECTION') return [];
      return [{
        correction_id: item.review_item_id,
        source_span: { start: item.source_span.start, end: item.source_span.end, text: item.source_span.quote },
        candidate: item.proposed_text,
        status: 'CONFIRMED_BY_TECHNICIAN',
      }];
    });
    const supportType = transcript.provider === 'technician-text' ? 'MANUAL_TECHNICIAN_INPUT' : 'TRANSCRIPT_EVIDENCE';
    const extraction = await this.extractCandidates({
      session,
      transcript,
      supportType,
      extractionText: session.context_binding.scope_id === 'HVAC' ? transcript.raw_text : projection.effectiveText,
      mapSourceSpan: session.context_binding.scope_id === 'HVAC' ? (span) => span : projection.mapSpan,
      confirmedCorrections,
    });
    const { spans, candidates, facts } = extraction;
    const guided = await this.retrieveGuidance({
      session,
      transcript,
      facts,
      query: session.context_binding.scope_id === 'HVAC' ? transcript.raw_text : projection.effectiveText,
    });
    const completed = await this.sessionStore.transition({
      session_id: session.session_id,
      expected_revision: guided.session.revision,
      to_phase: 'RESOLVE',
      event_type: 'TRANSCRIPT_REVIEW_DECIDED',
      occurred_at: this.clock(),
      details: {
        transcript_id: transcript.transcript_id,
        transcript_review_id: review.review_id,
        field_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
        guidance_context_ids: guided.guidanceContext ? [guided.guidanceContext.guidance_context_id] : [],
      },
      additions: {
        transcript_review_ids: [review.review_id],
        evidence_span_ids: spans.map((span) => span.span_id),
        field_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
        guidance_context_ids: guided.guidanceContext ? [guided.guidanceContext.guidance_context_id] : [],
      },
    });
    const record = await this.sessionStore.readCaptureByEvidence(transcript.source_evidence_id).catch(() => null);
    if (record) {
      await this.sessionStore.saveCapture({
        ...record,
        status: 'SUCCEEDED',
        review_id: review.review_id,
        transcript_id: transcript.transcript_id,
        evidence_span_ids: spans.map((span) => span.span_id),
        field_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
        guidance_context_ids: guided.guidanceContext ? [guided.guidanceContext.guidance_context_id] : [],
        next_action: 'RESOLVE_REPORT_FIELDS',
        failure: null,
      });
    }
    const computed = await this.persistAgentState(completed.session);
    return {
      session: computed.session,
      evidence: await this.sessionStore.readRecord('evidence', transcript.source_evidence_id),
      transcript,
      review,
      spans,
      candidates,
      guidance_context: guided.guidanceContext,
      reused: false,
      next_action: 'RESOLVE_REPORT_FIELDS',
      agent_state: computed.agent_state,
    };
  }

  captureIdentity({ session, sourceHash, model, language }) {
    return hashContract({
      source_hash: sourceHash,
      report_session_id: session.session_id,
      template_id: session.template_binding.template_id,
      template_version: session.template_binding.template_version,
      stt_model: model,
      stt_language: language,
      processing_version: PROCESSING_VERSION,
    }).slice(7);
  }

  async reuseCapture(record) {
    const chain = await this.sessionStore.loadChain(record.session_id);
    const session = chain.session;
    const evidence = await this.sessionStore.readRecord('evidence', record.evidence_id);
    const audio = record.audio_id ? await this.artifactStore.readAudioMetadata(record.audio_id) : null;
    if (record.status === 'FAILED') {
      return {
        session,
        audio,
        evidence,
        transcript: null,
        review: null,
        spans: [],
        candidates: [],
        failure: record.failure,
        reused: true,
        next_action: 'RETRY_TRANSCRIPTION',
      };
    }
    const transcript = await this.sessionStore.readRecord('transcripts', record.transcript_id);
    const review = record.review_id
      ? await this.sessionStore.readRecord('transcript-reviews', record.review_id)
      : null;
    const spans = await Promise.all((record.evidence_span_ids || []).map((id) => this.sessionStore.readRecord('evidence-spans', id)));
    const candidates = await Promise.all((record.field_candidate_ids || []).map((id) => this.sessionStore.readRecord('field-candidates', id)));
    const guidanceContexts = await Promise.all((record.guidance_context_ids || []).map((id) => this.sessionStore.readRecord('guidance-contexts', id)));
    return {
      session,
      audio,
      evidence,
      transcript,
      review,
      spans,
      candidates,
      guidance_context: guidanceContexts.at(-1) || null,
      agent_state: chain.agent_state,
      reused: true,
      next_action: record.next_action,
    };
  }

  async transcribeAudioRecord({ record, session, evidence }) {
    try {
      const result = await this.whisperProvider.transcribe(this.artifactStore.audioPath(record.audio_id), {
        model: record.model,
        language: record.language,
      });
      const transcript = createTranscriptArtifact(transcriptInput({
        session,
        evidence,
        rawText: result.raw_text,
        language: result.language || record.language || 'und',
        provider: result.provider || 'whisper',
        model: result.model || record.model,
        segments: Array.isArray(result.segments) ? result.segments : [],
        createdAt: this.clock(),
      }));
      const completed = await this.finishTranscript({ session, evidence, transcript, supportType: 'TRANSCRIPT_EVIDENCE' });
      await this.sessionStore.saveCapture({
        ...record,
        status: 'SUCCEEDED',
        transcript_id: transcript.transcript_id,
        review_id: completed.review?.review_id || null,
        evidence_span_ids: completed.spans.map((span) => span.span_id),
        field_candidate_ids: completed.candidates.map((candidate) => candidate.candidate_id),
        guidance_context_ids: completed.guidance_context ? [completed.guidance_context.guidance_context_id] : [],
        next_action: completed.next_action,
        failure: null,
      });
      return { audio: await this.artifactStore.readAudioMetadata(record.audio_id), ...completed };
    } catch (error) {
      const current = await this.sessionStore.load(record.session_id);
      if (current.phase !== 'PROCESSING') throw error;
      const failed = await this.sessionStore.transition({
        session_id: record.session_id,
        expected_revision: current.revision,
        to_phase: 'RECOVERABLE_ERROR',
        occurred_at: this.clock(),
        error: {
          code: error?.code || 'TRANSCRIPTION_FAILED',
          message: 'Transcription failed; immutable audio remains available for retry.',
        },
        details: { evidence_id: evidence.evidence_id, retry_action: 'RETRY_TRANSCRIPTION' },
      });
      const failure = {
        code: error?.code || 'TRANSCRIPTION_FAILED',
        message: Number(error?.status) >= 500
          ? 'Transcription failed; immutable audio remains available for retry.'
          : String(error?.message || 'Transcription failed.'),
      };
      await this.sessionStore.saveCapture({ ...record, status: 'FAILED', failure, next_action: 'RETRY_TRANSCRIPTION' });
      return {
        session: failed.session,
        audio: await this.artifactStore.readAudioMetadata(record.audio_id),
        evidence,
        transcript: null,
        review: null,
        spans: [],
        candidates: [],
        failure,
        reused: false,
        next_action: 'RETRY_TRANSCRIPTION',
      };
    }
  }

  async beginCapture({ sessionId, expectedRevision, evidence, source }) {
    await this.sessionStore.putRecord('evidence', evidence.evidence_id, evidence);
    const captured = await this.sessionStore.transition({
      session_id: sessionId,
      expected_revision: expectedRevision,
      to_phase: 'CAPTURE',
      event_type: 'EVIDENCE_CAPTURED',
      occurred_at: this.clock(),
      details: { source, evidence_id: evidence.evidence_id },
      additions: { evidence_ids: [evidence.evidence_id] },
    });
    return this.sessionStore.transition({
      session_id: sessionId,
      expected_revision: captured.session.revision,
      to_phase: 'PROCESSING',
      event_type: 'PROCESSING_STARTED',
      occurred_at: this.clock(),
      details: { evidence_id: evidence.evidence_id, processing_version: PROCESSING_VERSION },
    });
  }

  async captureText({ session_id: sessionId, expected_revision: expectedRevision, text, language = 'und', idempotency_key: idempotencyKey } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    const rawText = String(text || '').trim();
    if (!rawText) throw workflowError('Technician text is required.', 'TECHNICIAN_TEXT_REQUIRED');
    if (rawText.length > 20_000) throw workflowError('Technician text exceeds 20000 characters.', 'TECHNICIAN_TEXT_TOO_LARGE', 413);
    const sourceDigest = digest(Buffer.from(rawText, 'utf8'));
    const normalizedLanguage = String(language || 'und');
    const identityHash = this.captureIdentity({
      session,
      sourceHash: `sha256:${sourceDigest}`,
      model: 'manual-entry',
      language: normalizedLanguage,
    });
    const existing = await this.sessionStore.claimCapture({ identity_hash: identityHash, idempotency_key: idempotencyKey });
    if (existing) return this.reuseCapture(existing);
    const storageRef = await this.sessionStore.putTextSource(sourceDigest, rawText);
    const evidence = createEvidence({
      evidence_type: 'MANUAL_INPUT',
      source_hash: `sha256:${sourceDigest}`,
      storage_ref: storageRef,
      created_at: this.clock(),
      metadata: { language: normalizedLanguage, report_binding: reportBinding(session) },
    });
    const record = {
      identity_hash: identityHash,
      session_id: session.session_id,
      source_hash: evidence.source_hash,
      audio_id: null,
      evidence_id: evidence.evidence_id,
      model: 'manual-entry',
      language: normalizedLanguage,
      processing_version: PROCESSING_VERSION,
      status: 'CAPTURED',
      transcript_id: null,
      review_id: null,
      evidence_span_ids: [],
      field_candidate_ids: [],
      guidance_context_ids: [],
      next_action: 'PROCESS_TEXT',
      failure: null,
    };
    await this.sessionStore.saveCapture(record);
    const processing = await this.beginCapture({ sessionId, expectedRevision, evidence, source: 'TECHNICIAN_TEXT' });
    const transcript = createTranscriptArtifact(transcriptInput({
      session: processing.session,
      evidence,
      rawText,
      language: normalizedLanguage,
      provider: 'technician-text',
      model: 'manual-entry',
      segments: [],
      createdAt: this.clock(),
    }));
    const completed = await this.finishTranscript({ session: processing.session, evidence, transcript, supportType: 'MANUAL_TECHNICIAN_INPUT' });
    await this.sessionStore.saveCapture({
      ...record,
      status: 'SUCCEEDED',
      transcript_id: transcript.transcript_id,
      review_id: completed.review?.review_id || null,
      evidence_span_ids: completed.spans.map((span) => span.span_id),
      field_candidate_ids: completed.candidates.map((candidate) => candidate.candidate_id),
      guidance_context_ids: completed.guidance_context ? [completed.guidance_context.guidance_context_id] : [],
      next_action: completed.next_action,
      failure: null,
    });
    return completed;
  }

  async captureAudio({ session_id: sessionId, expected_revision: expectedRevision, wav_buffer: wavBuffer, model = 'base', language = 'auto', idempotency_key: idempotencyKey } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (!Buffer.isBuffer(wavBuffer)) throw workflowError('Audio must be supplied as WAV bytes.', 'INVALID_WAV');
    const audio = await this.artifactStore.putAudio(wavBuffer);
    const normalizedModel = String(model || 'base');
    const normalizedLanguage = String(language || 'auto');
    const identityHash = this.captureIdentity({
      session,
      sourceHash: audio.source_hash,
      model: normalizedModel,
      language: normalizedLanguage,
    });
    const existing = await this.sessionStore.claimCapture({ identity_hash: identityHash, idempotency_key: idempotencyKey });
    if (existing) return this.reuseCapture(existing);
    const evidence = createEvidence({
      evidence_type: 'AUDIO',
      source_hash: audio.source_hash,
      storage_ref: `artifact://audio/${audio.audio_id}.wav`,
      created_at: this.clock(),
      metadata: { bytes: audio.bytes, wav: audio.wav, report_binding: reportBinding(session) },
    });
    const record = {
      identity_hash: identityHash,
      session_id: session.session_id,
      source_hash: audio.source_hash,
      audio_id: audio.audio_id,
      evidence_id: evidence.evidence_id,
      model: normalizedModel,
      language: normalizedLanguage,
      processing_version: PROCESSING_VERSION,
      status: 'CAPTURED',
      transcript_id: null,
      evidence_span_ids: [],
      field_candidate_ids: [],
      guidance_context_ids: [],
      next_action: 'PROCESS_TRANSCRIPTION',
      failure: null,
    };
    await this.sessionStore.saveCapture(record);
    const processing = await this.beginCapture({ sessionId, expectedRevision, evidence, source: 'MICROPHONE_AUDIO' });
    return this.transcribeAudioRecord({ record, session: processing.session, evidence });
  }

  async retryTranscription({ session_id: sessionId, expected_revision: expectedRevision, evidence_id: evidenceId } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    const record = await this.sessionStore.readCaptureByEvidence(evidenceId);
    if (record.session_id !== session.session_id || !session.evidence_ids.includes(record.evidence_id)) {
      throw workflowError('Capture evidence belongs to another ReportSession.', 'CAPTURE_BINDING_MISMATCH', 409);
    }
    if (record.status === 'SUCCEEDED') return this.reuseCapture(record);
    if (session.phase !== 'RECOVERABLE_ERROR' || session.recovery_phase !== 'PROCESSING') {
      throw workflowError('ReportSession is not awaiting a transcription retry.', 'TRANSCRIPTION_RETRY_NOT_AVAILABLE', 409);
    }
    const recovered = await this.sessionStore.transition({
      session_id: session.session_id,
      expected_revision: session.revision,
      to_phase: 'PROCESSING',
      occurred_at: this.clock(),
      details: { evidence_id: record.evidence_id, retry_action: 'RETRY_TRANSCRIPTION' },
    });
    const evidence = await this.sessionStore.readRecord('evidence', record.evidence_id);
    return this.transcribeAudioRecord({ record, session: recovered.session, evidence });
  }
}

export const authoritativeCaptureVersion = PROCESSING_VERSION;
