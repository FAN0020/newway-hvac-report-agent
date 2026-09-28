import crypto from 'node:crypto';
import {
  assertExpectedRevision,
  createEvidence,
  createEvidenceSpan,
  createConfirmedFieldCandidate,
  createAgentRun,
  createFieldCandidate,
  createGuidanceContext,
  createReportSnapshot,
  createTechnicianConfirmationEvent,
  createTranscriptArtifact,
  createTranscriptReview,
  hashContract,
} from '../domain/index.js';
import { buildAuthoritativeReport, buildReportHistorySummary, runAuthoritativeAgent, AGENT_PROCESSING_VERSION } from '../agent/index.js';
import { renderReportPdf } from '../export/template-pdf.js';
import { formatReportName, reportCreationDate } from '../report-naming.js';
import { reportToText } from '../tools/report-integrity.js';
import { extractAtomicFacts, ATOMIC_FACTS_VERSION } from '../semantic/atomic-facts.js';
import { extractConversationalFacts, CONVERSATIONAL_FACTS_VERSION } from '../semantic/conversational-facts.js';
import { segmentAssertions, ASSERTION_SEGMENTER_VERSION } from '../semantic/assertion-segmentation.js';
import { evaluateAssertionCoverage, unresolvedSemanticWindows, ASSERTION_COVERAGE_VERSION } from '../semantic/assertion-coverage.js';
import { SemanticExtractor, SEMANTIC_EXTRACTOR_VERSION } from '../semantic/semantic-extractor.js';
import { routeAtomicFacts } from '../semantic/field-router.js';
import { extractCuedFieldAssignments, STRUCTURED_VERIFIER_VERSION } from '../semantic/structured-proposals.js';
import { normalizeContextualTranscript, NORMALIZER_VERSION } from '../semantic/transcript-normalization.js';
import { deriveCaptureTimeAssignments } from '../semantic/temporal-fields.js';
import { buildTranscriptCorrectionCandidates } from '../tools/hvac-knowledge.js';
import { applyConfirmedTranscriptCorrections, reviewV2Transcript } from '../v2/transcript-review.js';
import { buildFollowUpQuestions } from '../v2/guided-reporting.js';
import { planV2Report } from '../v2/report-builder.js';
import { allowedScopes, resolveContext } from '../v2/scope.js';
import { ingestDocument, UPLOAD_STATUS } from '../v2/upload.js';
import { createRetriever } from '../v2/retrieval.js';
import { templateFor } from '../../web/template-catalog.js';

const PROCESSING_VERSION = 'authoritative-capture.v6';
const EXTRACTION_VERSION = 'atomic-semantic-extraction.v8';
const RETRIEVAL_VERSION = 'scope-lexical.v1';
function pipelineVersions(session) {
  return {
    normalizer: NORMALIZER_VERSION,
    ontology: 'canonical-report-facts.v1',
    segmenter: ASSERTION_SEGMENTER_VERSION,
    coverage: ASSERTION_COVERAGE_VERSION,
    deterministic: `${ATOMIC_FACTS_VERSION}+${CONVERSATIONAL_FACTS_VERSION}`,
    extractor: SEMANTIC_EXTRACTOR_VERSION,
    verifier: STRUCTURED_VERIFIER_VERSION,
    field_mapping: EXTRACTION_VERSION,
    schema: session.template_binding.template_version,
  };
}
const ATTACHMENT_PURPOSES = new Set([
  'BEFORE_WORK_PHOTO', 'AFTER_WORK_PHOTO', 'MEASUREMENT', 'PARTS_EVIDENCE',
  'CUSTOMER_DOCUMENT', 'EXISTING_SERVICE_RECORD', 'OTHER',
]);
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

function normalizedClaimValue(value) {
  if (typeof value === 'string') {
    return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  if (Array.isArray(value)) return value.map(normalizedClaimValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizedClaimValue(value[key])]));
  }
  return value;
}

function claimsByField(facts) {
  const grouped = new Map();
  for (const fact of facts || []) {
    const field = String(fact?.field || '');
    if (!field) continue;
    const claim = JSON.stringify({
      claim_kind: fact.claim_kind || 'VALUE',
      value: normalizedClaimValue(fact.value),
      unit: normalizedClaimValue(fact.unit ?? null),
    });
    if (!grouped.has(field)) grouped.set(field, []);
    grouped.get(field).push(claim);
  }
  for (const values of grouped.values()) values.sort();
  return grouped;
}

export function compareReportClaimImpact({ rawFacts = [], proposedFacts = [] } = {}) {
  const raw = claimsByField(rawFacts);
  const proposed = claimsByField(proposedFacts);
  const affectedFields = [...new Set([...raw.keys(), ...proposed.keys()])]
    .filter((field) => JSON.stringify(raw.get(field) || []) !== JSON.stringify(proposed.get(field) || []))
    .sort();
  return affectedFields.length
    ? { impact_class: 'MATERIAL', material: true, affected_fields: affectedFields }
    : { impact_class: 'NON_MATERIAL', material: false, affected_fields: [] };
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

function transcriptInput({ session, evidence, rawText, normalizedText, corrections, language, provider, model, segments, captureContext = null, createdAt }) {
  return {
    session_id: session.session_id,
    source_evidence_id: evidence.evidence_id,
    source_hash: evidence.source_hash,
    raw_text: rawText,
    normalized_text: normalizedText,
    corrections,
    language,
    provider,
    model,
    processing_version: PROCESSING_VERSION,
    template_binding: session.template_binding,
    context_binding: session.context_binding,
    created_at: createdAt,
    segments,
    capture_context: captureContext,
  };
}

function exactFactSpan(fact, rawText) {
  const span = fact.source_span;
  if (!span || rawText.slice(span.start, span.end) !== span.text) {
    throw workflowError('Extractor returned fact provenance that does not match the transcript.', 'INVALID_EXTRACTED_PROVENANCE', 409);
  }
  return span;
}

const ADDITIVE_FIELD_SEMANTICS = new Set(['COMPLETED_ACTION', 'PART_USED']);

function coalesceAdditiveAssignments(assignments) {
  const groups = new Map();
  for (const assignment of assignments) {
    if (assignment.claim_kind !== 'VALUE' || !ADDITIVE_FIELD_SEMANTICS.has(assignment.semantic_type)) continue;
    const key = `${assignment.field}\u0000${assignment.semantic_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(assignment);
  }
  const consumed = new Set();
  const replacements = new Map();
  const completionGroups = new Map();
  for (const assignment of assignments.filter((item) => item.semantic_type === 'COMPLETION_STATE' && item.claim_kind === 'VALUE')) {
    if (!completionGroups.has(assignment.field)) completionGroups.set(assignment.field, []);
    completionGroups.get(assignment.field).push(assignment);
  }
  const equivalentCompletionValues = new Set(['done', 'complete', 'completed', 'ready', 'ready for service']);
  for (const group of completionGroups.values()) {
    if (group.length < 2 || group.some((item) => !equivalentCompletionValues.has(String(item.value).toLocaleLowerCase()))) continue;
    for (const item of group.slice(0, -1)) consumed.add(item);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const values = [...new Set(group.map((item) => String(item.value).trim()).filter(Boolean))];
    if (values.length < 2) continue;
    const [first] = group;
    const factIds = group.map((item) => item.fact?.fact_id).filter(Boolean);
    replacements.set(first, {
      ...first,
      value: values.join('; '),
      source_spans: group.map((item) => item.source_span),
      fact_ids: factIds,
    });
    for (const item of group.slice(1)) consumed.add(item);
  }
  return assignments
    .filter((assignment) => !consumed.has(assignment))
    .map((assignment) => replacements.get(assignment) || assignment);
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

function transcriptProjection(transcript, items = [], decisions = []) {
  const automatic = (transcript.corrections || []).map((correction, index) => ({
    review_item_id: `automatic:${index}`,
    kind: 'CORRECTION',
    source_span: { start: correction.sourceSpan.start, end: correction.sourceSpan.end, quote: correction.original },
    proposed_text: correction.replacement,
  }));
  return correctedTextProjection(transcript.raw_text, [...automatic, ...items], [
    ...automatic.map((item) => ({ review_item_id: item.review_item_id, decision: 'ACCEPT' })),
    ...decisions,
  ]);
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
    templateProvider,
    modelResolver,
    semanticProvider,
    semanticModel,
    principalRef = 'principal:demo-technician',
    exportWriter,
    pdfRenderer = renderReportPdf,
    clock = () => new Date().toISOString(),
    reportTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
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
    this.templateProvider = templateProvider || null;
    this.modelResolver = modelResolver || null;
    this.semanticProvider = semanticProvider || null;
    this.semanticModel = String(semanticModel || '');
    this.principalRef = String(principalRef);
    this.exportWriter = exportWriter || ((snapshotId, payload) => this.sessionStore.writeOfficialExport(snapshotId, payload));
    this.pdfRenderer = pdfRenderer;
    this.clock = clock;
    this.reportTimeZone = reportTimeZone;
  }

  async resolveTemplate(templateId) {
    try {
      return templateFor(templateId);
    } catch {
      const provided = this.templateProvider ? await this.templateProvider(templateId) : null;
      if (!provided) throw workflowError('Published template was not found.', 'TEMPLATE_NOT_FOUND', 404);
      return structuredClone(provided);
    }
  }

  async createCapturedTranscript(input) {
    const template = await this.resolveTemplate(input.session.template_binding.template_id);
    const normalization = normalizeContextualTranscript({ rawText: input.rawText, template });
    return createTranscriptArtifact(transcriptInput({
      ...input,
      normalizedText: normalization.normalizedText,
      corrections: normalization.corrections,
    }));
  }

  async captureContext(session, { target_field_id: targetFieldId, target_section_id: targetSectionId, capture_mode: captureMode } = {}) {
    const requested = [targetFieldId, targetSectionId, captureMode].some((value) => value !== undefined && value !== null && String(value).trim());
    if (!requested) return null;
    const mode = String(captureMode || 'FIELD_DICTATION').trim().toUpperCase();
    if (!['FIELD_DICTATION', 'GLOBAL_NARRATION', 'AUDIO_UPLOAD'].includes(mode)) {
      throw workflowError('Capture mode is invalid.', 'INVALID_CAPTURE_CONTEXT', 400);
    }
    const fieldId = String(targetFieldId || '').trim();
    if (mode === 'FIELD_DICTATION' && !fieldId) {
      throw workflowError('Field dictation requires a target field.', 'INVALID_CAPTURE_CONTEXT', 400);
    }
    const template = await this.resolveTemplate(session.template_binding.template_id);
    const definition = fieldId ? template.schema.fields.find((field) => (
      field.id === fieldId || (field.id.endsWith('.*') && fieldId.startsWith(field.id.slice(0, -1)))
    )) : null;
    if (fieldId && !definition) throw workflowError('Capture target is not part of the bound template.', 'CAPTURE_TARGET_NOT_IN_TEMPLATE', 409);
    const sectionId = String(targetSectionId || definition?.section || '').trim();
    if (definition && sectionId && definition.section !== sectionId) {
      throw workflowError('Capture target section does not match the bound template.', 'CAPTURE_TARGET_SECTION_MISMATCH', 409);
    }
    return Object.freeze({
      ...(fieldId ? { target_field_id: fieldId } : {}),
      ...(sectionId ? { target_section_id: sectionId } : {}),
      capture_mode: mode,
    });
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
        uploader: this.principalRef,
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
    const template = await this.resolveTemplate(templateId);
    if (template.templateVersion !== String(templateVersion || '')) {
      throw workflowError('Requested template version does not match the published template.', 'TEMPLATE_VERSION_MISMATCH', 409);
    }
    const scopeId = template.domain;
    let created = await this.sessionStore.create({
      session_id: `session_${crypto.randomUUID()}`,
      template_binding: { template_id: template.templateId, template_version: template.templateVersion },
      context_binding: {
        context_id: CONTEXT_BY_SCOPE[scopeId] || template.contextCorpus.id,
        context_version: template.contextCorpus.version,
        scope_id: scopeId,
      },
      job_context_ref: jobContextRef,
      created_at: this.clock(),
      report_name_base: template.presentation?.displayName || template.name,
      report_time_zone: this.reportTimeZone,
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
    const supersededCandidateIds = new Set(chain.audit_events.flatMap((event) =>
      event.payload?.superseded_field_candidate_ids || []));
    const latestTraceId = [...chain.audit_events].reverse()
      .map((event) => event.payload?.semantic_trace_id).find(Boolean);
    const semanticTrace = latestTraceId
      ? await this.sessionStore.readRecord('semantic-traces', latestTraceId) : null;
    const agentState = runAuthoritativeAgent({
      session,
      template: await this.resolveTemplate(session.template_binding.template_id),
      candidates: chain.field_candidates.filter((candidate) => !supersededCandidateIds.has(candidate.candidate_id)),
      guidance_contexts: chain.guidance_contexts,
      semantic_trace: semanticTrace,
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

  async getSemanticTrace(sessionId) {
    const chain = await this.sessionStore.loadChain(sessionId);
    const traceId = [...chain.audit_events].reverse()
      .map((event) => event.payload?.semantic_trace_id).find(Boolean);
    if (!traceId) return { session_id: chain.session.session_id, semantic_trace: null };
    const semanticTrace = await this.sessionStore.readRecord('semantic-traces', traceId);
    if (semanticTrace.session_id !== chain.session.session_id) {
      throw workflowError('Semantic trace belongs to another ReportSession.', 'SEMANTIC_TRACE_BINDING_MISMATCH', 409);
    }
    const transcript = chain.transcripts.find((item) => item.transcript_id === semanticTrace.transcript_id);
    const agentState = chain.agent_state;
    return {
      session_id: chain.session.session_id,
      semantic_trace: semanticTrace,
      normalization: transcript ? {
        raw_text: transcript.raw_text,
        normalized_text: transcript.normalized_text,
        corrections: transcript.corrections || [],
        review_decisions: chain.transcript_reviews
          .filter((review) => review.transcript_id === transcript.transcript_id)
          .flatMap((review) => review.decisions || []),
      } : null,
      report_state: agentState ? {
        session_revision: agentState.session_revision,
        report_fields: agentState.report_fields,
        conflicts: agentState.conflicts,
        validation_issues: agentState.validation_issues,
        completeness: agentState.completeness,
        unresolved_information: agentState.unresolved_information,
      } : null,
      clarification_queue: agentState?.resolution_queue || [],
    };
  }

  async replaySemanticTrace({ session_id: sessionId, transcript_id: transcriptId } = {}) {
    const chain = await this.sessionStore.loadChain(sessionId);
    const transcript = chain.transcripts.find((item) => item.transcript_id === transcriptId);
    if (!transcript) throw workflowError('Transcript does not belong to this ReportSession.', 'TRANSCRIPT_BINDING_MISMATCH', 404);
    const review = chain.transcript_reviews.find((item) => item.transcript_id === transcriptId && item.decisions?.length);
    const projection = transcriptProjection(transcript, review?.items || [], review?.decisions || []);
    const traceSink = {};
    await this.extractFacts({ session: chain.session, transcript, extractionText: projection.effectiveText, traceSink });
    const priorEvent = [...chain.audit_events].reverse().find((event) =>
      event.payload?.transcript_id === transcriptId && event.payload?.semantic_trace_id);
    const previous = priorEvent
      ? await this.sessionStore.readRecord('semantic-traces', priorEvent.payload.semantic_trace_id) : null;
    const current = traceSink.value;
    const factKeys = (trace) => new Set((trace?.canonical_facts || []).map((fact) =>
      JSON.stringify([fact.semantic_type, fact.value, fact.char_start, fact.char_end, fact.source_role, fact.temporality])));
    const before = factKeys(previous);
    const after = factKeys(current);
    return {
      session_id: sessionId, transcript_id: transcriptId,
      previous_trace_id: previous?.trace_id || null, replayed_trace: current,
      comparison: {
        facts_added: [...after].filter((key) => !before.has(key)),
        facts_removed: [...before].filter((key) => !after.has(key)),
        previous_rejections: previous?.model.rejections || [],
        replayed_rejections: current.model.rejections,
        previous_field_assignments: previous?.field_assignments || [],
        replayed_field_assignments: current.field_assignments,
        previous_missing_information: previous?.missing_information || [],
        replayed_missing_information: current.missing_information,
      },
    };
  }

  async applySemanticReplay({ session_id: sessionId, transcript_id: transcriptId,
    expected_revision: expectedRevision } = {}) {
    const chain = await this.sessionStore.loadChain(sessionId);
    const session = chain.session;
    if (session.phase !== 'RESOLVE') {
      throw workflowError('Semantic replay requires a report in Resolve.', 'SEMANTIC_REPLAY_PHASE_MISMATCH', 409);
    }
    const transcript = chain.transcripts.find((item) => item.transcript_id === transcriptId);
    if (!transcript) throw workflowError('Transcript does not belong to this ReportSession.', 'TRANSCRIPT_BINDING_MISMATCH', 404);
    const review = chain.transcript_reviews.find((item) => item.transcript_id === transcriptId && item.decisions?.length);
    const projection = transcriptProjection(transcript, review?.items || [], review?.decisions || []);
    const priorEvent = [...chain.audit_events].reverse().find((event) =>
      event.payload?.transcript_id === transcriptId && event.payload?.semantic_trace_id);
    const previous = priorEvent
      ? await this.sessionStore.readRecord('semantic-traces', priorEvent.payload.semantic_trace_id) : null;
    if (previous && Object.entries(pipelineVersions(session)).every(([stage, version]) =>
      previous.pipeline_versions?.[stage] === version)
      && previous.input_text_sha256 === `sha256:${digest(projection.effectiveText)}`
      && (!this.semanticModel || previous.model.model === this.semanticModel)
      && !previous.model.error) {
      return { session, semantic_trace: previous, agent_state: chain.agent_state, reused: true };
    }
    assertExpectedRevision(session, expectedRevision);
    const acceptedItems = (review?.items || []).filter((item) => review.decisions.some((decision) =>
      decision.review_item_id === item.review_item_id && decision.decision === 'ACCEPT'));
    const oldSuperseded = new Set(chain.audit_events.flatMap((event) =>
      event.payload?.superseded_field_candidate_ids || []));
    const previousCandidateIds = chain.field_candidates.filter((candidate) =>
      candidate.source_ref === transcriptId && !oldSuperseded.has(candidate.candidate_id))
      .map((candidate) => candidate.candidate_id);
    const extraction = await this.extractCandidates({
      session, transcript,
      supportType: transcript.provider === 'technician-text' ? 'MANUAL_TECHNICIAN_INPUT' : 'TRANSCRIPT_EVIDENCE',
      extractionText: projection.effectiveText,
      mapSourceSpan: projection.mapSpan,
      confirmationRequirements: review?.confirmation_requirements || [],
      correctionContext: acceptedItems.length ? {
        transcript_review_id: review.review_id,
        effective_projection_hash: review.effective_projection_hash,
        items: acceptedItems,
      } : null,
    });
    if (previous?.trace_id === extraction.semantic_trace?.trace_id) {
      return { session, semantic_trace: previous, agent_state: chain.agent_state, reused: true };
    }
    const newIds = new Set(extraction.candidates.map((candidate) => candidate.candidate_id));
    const superseded = previousCandidateIds.filter((id) => !newIds.has(id));
    const recorded = await this.sessionStore.recordEvent({
      session_id: sessionId, expected_revision: session.revision,
      event_type: 'STRUCTURED_CANDIDATES_CREATED', occurred_at: this.clock(),
      details: {
        transcript_id: transcriptId, semantic_trace_id: extraction.semantic_trace.trace_id,
        replayed_from_trace_id: previous?.trace_id || null,
        field_candidate_ids: extraction.candidates.map((candidate) => candidate.candidate_id),
        superseded_field_candidate_ids: superseded,
      },
      additions: {
        evidence_span_ids: extraction.spans.map((span) => span.span_id),
        field_candidate_ids: [...newIds],
      },
    });
    const computed = await this.persistAgentState(recorded.session);
    return {
      session: computed.session, transcript, semantic_trace: extraction.semantic_trace,
      candidates: extraction.candidates, superseded_field_candidate_ids: superseded,
      agent_state: computed.agent_state, reused: false,
    };
  }

  async listReportHistory() {
    const sessions = await this.sessionStore.listSessions();
    const names = new Map();
    const dailyCounts = new Map();
    for (const session of [...sessions].sort((left, right) => (
      String(left.created_at).localeCompare(String(right.created_at))
      || left.session_id.localeCompare(right.session_id)
    ))) {
      const date = session.report_date || reportCreationDate(session.created_at, this.reportTimeZone);
      const key = `${session.template_binding.template_id}:${date}`;
      const index = session.report_index || (dailyCounts.get(key) || 0) + 1;
      dailyCounts.set(key, Math.max(dailyCounts.get(key) || 0, index));
      if (!session.report_name) names.set(session.session_id, { date, index });
    }
    return Promise.all(sessions.map(async (session) => {
      const template = await this.resolveTemplate(session.template_binding.template_id);
      const legacyName = names.get(session.session_id);
      const agentState = session.current_agent_run_id
        ? (await this.sessionStore.readRecord('agent-runs', session.current_agent_run_id)).agent_state
        : null;
      const confirmation = session.confirmation_ref
        ? await this.sessionStore.readRecord('confirmations', session.confirmation_ref)
        : null;
      const reportSnapshot = session.snapshot_ref
        ? await this.sessionStore.readRecord('report-snapshots', session.snapshot_ref)
        : null;
      const outputArtifacts = reportSnapshot
        ? await this.sessionStore.listOutputArtifacts(reportSnapshot.snapshot_id)
        : [];
      return buildReportHistorySummary({
        session,
        template,
        reportName: session.report_name || formatReportName(template.presentation?.displayName || template.name, legacyName.date, legacyName.index),
        agentState,
        confirmation,
        reportSnapshot,
        outputArtifacts,
      });
    }));
  }

  async enterReview({ session_id: sessionId, expected_revision: expectedRevision } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'RESOLVE') {
      throw workflowError('Review can begin only after report resolution.', 'REVIEW_PHASE_MISMATCH', 409);
    }
    const current = await this.getAgentState(sessionId);
    if (!current.agent_state.completeness.complete || current.agent_state.resolution_queue.length) {
      throw workflowError('The report still has blocking items to resolve.', 'REPORT_NOT_COMPLETE', 409);
    }
    const transitioned = await this.sessionStore.transition({
      session_id: sessionId, expected_revision: session.revision, to_phase: 'REVIEW',
      event_type: 'REPORT_REVIEW_STARTED', occurred_at: this.clock(),
      details: { blocking_issue_count: 0 },
    });
    return this.persistAgentState(transitioned.session);
  }

  async completeReview({ session_id: sessionId, expected_revision: expectedRevision } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'REVIEW') {
      throw workflowError('Review completion requires an active review.', 'REVIEW_PHASE_MISMATCH', 409);
    }
    const current = await this.getAgentState(sessionId);
    if (!current.agent_state.completeness.complete || current.agent_state.resolution_queue.length) {
      throw workflowError('The report changed and requires resolution.', 'REPORT_NOT_COMPLETE', 409);
    }
    const transitioned = await this.sessionStore.transition({
      session_id: sessionId, expected_revision: session.revision, to_phase: 'READY',
      event_type: 'REPORT_REVIEW_COMPLETED', occurred_at: this.clock(),
      details: { ready_for_confirmation: true, technician_principal_ref: this.principalRef },
    });
    const computed = await this.persistAgentState(transitioned.session);
    const output = buildAuthoritativeReport({
      session: computed.session,
      agentState: computed.agent_state,
      template: await this.resolveTemplate(computed.session.template_binding.template_id),
    });
    const validationBody = {
      contract: 'ValidationReceipt', contract_version: '1', authority: 'SERVER',
      session_id: computed.session.session_id,
      session_revision: computed.session.revision,
      template_binding: computed.session.template_binding,
      agent_run_id: computed.session.current_agent_run_id,
      structured_state_hash: output.structured_state_hash,
      status: 'PASS',
      blocking_issue_ids: [],
      resolution_item_ids: [],
      validated_at: this.clock(),
    };
    const validationReceipt = Object.freeze({
      validation_id: `validation_${hashContract(validationBody).slice(7, 31)}`,
      ...validationBody,
    });
    await this.sessionStore.putRecord('validation-receipts', validationReceipt.validation_id, validationReceipt);
    const finalizedSession = await this.sessionStore.attachFinalization({
      session_id: computed.session.session_id,
      expected_revision: computed.session.revision,
      validation_ref: validationReceipt.validation_id,
    });
    return { ...computed, session: finalizedSession, validation_receipt: validationReceipt };
  }

  async confirmSession({ session_id: sessionId, expected_revision: expectedRevision } = {}) {
    const session = await this.sessionStore.load(sessionId);
    if (session.phase === 'CONFIRMED' && session.confirmation_ref && session.snapshot_ref) {
      const existingConfirmation = await this.sessionStore.readRecord('confirmations', session.confirmation_ref);
      if (Number(expectedRevision) !== session.revision && Number(expectedRevision) !== existingConfirmation.expected_revision) {
        assertExpectedRevision(session, expectedRevision);
      }
      return {
        session,
        agent_state: (await this.getAgentState(sessionId)).agent_state,
        confirmation: existingConfirmation,
        snapshot: await this.sessionStore.readRecord('report-snapshots', session.snapshot_ref),
        reused: true,
      };
    }
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'READY') {
      throw workflowError('Only a ready report can be confirmed.', 'REPORT_NOT_READY', 409);
    }
    if (!session.validation_ref) throw workflowError('The current revision has no validation receipt.', 'STALE_VALIDATION', 409);
    const chain = await this.sessionStore.loadChain(sessionId);
    const current = chain.agent_state?.session_revision === session.revision
      ? { session, agent_state: chain.agent_state }
      : await this.getAgentState(sessionId);
    const output = buildAuthoritativeReport({
      session: current.session,
      agentState: current.agent_state,
      template: await this.resolveTemplate(session.template_binding.template_id),
    });
    const validation = await this.sessionStore.readRecord('validation-receipts', session.validation_ref);
    if (validation.session_id !== session.session_id
      || validation.session_revision !== session.revision
      || validation.structured_state_hash !== output.structured_state_hash
      || validation.template_binding.template_id !== session.template_binding.template_id
      || validation.template_binding.template_version !== session.template_binding.template_version
      || validation.status !== 'PASS') {
      throw workflowError('The validation receipt is stale for the current report state.', 'STALE_VALIDATION', 409);
    }
    if (!chain.audit_events.some((event) => event.event_type === 'REPORT_REVIEW_COMPLETED' && event.revision === session.revision)) {
      throw workflowError('Technician review acknowledgement is missing.', 'REVIEW_ACKNOWLEDGEMENT_REQUIRED', 409);
    }
    const technicianField = current.agent_state.report_fields.find((field) => field.field_id === 'technician.name');
    const confirmationBody = {
      contract: 'ReportConfirmation', contract_version: '1', authority: 'SERVER',
      session_id: session.session_id,
      expected_revision: session.revision,
      confirmed_revision: session.revision + 1,
      template_binding: session.template_binding,
      structured_state_hash: output.structured_state_hash,
      validation_ref: validation.validation_id,
      technician_principal_ref: this.principalRef,
      technician_name: String(technicianField?.value || 'Demo technician'),
      confirmed_at: this.clock(),
    };
    const confirmation = Object.freeze({
      confirmation_id: `confirmation_${hashContract(confirmationBody).slice(7, 31)}`,
      ...confirmationBody,
    });
    await this.sessionStore.putRecord('confirmations', confirmation.confirmation_id, confirmation);
    const transitioned = await this.sessionStore.transition({
      session_id: sessionId, expected_revision: session.revision, to_phase: 'CONFIRMED',
      event_type: 'REPORT_CONFIRMED', occurred_at: this.clock(),
      confirmation_ref: confirmation.confirmation_id,
      validation_ref: validation.validation_id,
      details: {
        confirmation_id: confirmation.confirmation_id,
        validation_ref: validation.validation_id,
        structured_state_hash: output.structured_state_hash,
        technician_principal_ref: confirmation.technician_principal_ref,
      },
    });
    const computed = await this.persistAgentState(transitioned.session);
    const confirmedChain = await this.sessionStore.loadChain(sessionId);
    const snapshot = createReportSnapshot({
      session: computed.session,
      fields: computed.agent_state.report_fields,
      evidence_ids: computed.session.evidence_ids,
      transcript_ids: computed.session.transcript_ids,
      guidance_context_ids: computed.session.guidance_context_ids,
      validation_issues: computed.agent_state.validation_issues,
      resolution_items: computed.agent_state.resolution_queue,
      structured_state_hash: output.structured_state_hash,
      validation_ref: validation.validation_id,
      confirmation_ref: confirmation.confirmation_id,
      technician_principal_ref: confirmation.technician_principal_ref,
      confirmed_at: confirmation.confirmed_at,
      report: output.report,
      created_at: this.clock(),
    });
    await this.sessionStore.putRecord('report-snapshots', snapshot.snapshot_id, snapshot);
    const finalizedSession = await this.sessionStore.attachFinalization({
      session_id: sessionId,
      expected_revision: computed.session.revision,
      validation_ref: validation.validation_id,
      confirmation_ref: confirmation.confirmation_id,
      snapshot_ref: snapshot.snapshot_id,
    });
    return {
      session: finalizedSession,
      agent_state: computed.agent_state,
      confirmation,
      snapshot,
      evidence_count: confirmedChain.evidence.length,
      reused: false,
    };
  }

  async exportConfirmedSession({ session_id: sessionId, expected_revision: expectedRevision } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase !== 'CONFIRMED' || !session.snapshot_ref || !session.confirmation_ref) {
      throw workflowError('Only an immutable confirmed snapshot can be exported.', 'REPORT_NOT_CONFIRMED', 409);
    }
    const snapshot = await this.sessionStore.readRecord('report-snapshots', session.snapshot_ref);
    const confirmation = await this.sessionStore.readRecord('confirmations', session.confirmation_ref);
    if (snapshot.session_id !== session.session_id || snapshot.session_revision !== session.revision
      || snapshot.confirmation_ref !== confirmation.confirmation_id
      || snapshot.snapshot_hash !== hashContract(Object.fromEntries(Object.entries(snapshot).filter(([key]) => !['snapshot_id', 'snapshot_hash'].includes(key))))) {
      throw workflowError('The confirmed snapshot failed its integrity binding.', 'SNAPSHOT_IDENTITY_MISMATCH', 409);
    }
    const exportConfirmation = {
      technician_id: confirmation.technician_principal_ref,
      technician_name: confirmation.technician_name,
      confirmed_at: confirmation.confirmed_at,
      validator_run_id: confirmation.validation_ref,
      report_hash: snapshot.snapshot_hash,
    };
    const text = reportToText(snapshot.report, exportConfirmation);
    const template = await this.resolveTemplate(snapshot.template_binding.template_id);
    if (template.templateVersion !== snapshot.template_binding.template_version) {
      throw workflowError('The confirmed snapshot template version is unavailable.', 'SNAPSHOT_TEMPLATE_VERSION_MISMATCH', 409);
    }
    const existing = await this.sessionStore.readOfficialExport(snapshot.snapshot_id, 'pdf');
    const rendered = existing ? null : await this.pdfRenderer({
      report: snapshot.report,
      confirmation: { ...confirmation, snapshot_hash: snapshot.snapshot_hash },
      template,
    });
    const exported = existing || await this.exportWriter(snapshot.snapshot_id, { bytes: rendered.bytes, extension: 'pdf' });
    const exportBytes = exported.bytes || rendered.bytes;
    const exportHash = `sha256:${digest(exportBytes)}`;
    const existingOutputs = await this.sessionStore.listOutputArtifacts(snapshot.snapshot_id);
    let outputArtifact = existingOutputs.find((item) => item.format === 'application/pdf') || null;
    if (!outputArtifact) {
      const identity = { snapshot_id: snapshot.snapshot_id, format: 'application/pdf' };
      outputArtifact = await this.sessionStore.recordOutputArtifact(Object.freeze({
        contract: 'ReportOutputArtifact',
        contract_version: '1',
        output_id: `output_${hashContract(identity).slice(7, 31)}`,
        session_id: session.session_id,
        snapshot_id: snapshot.snapshot_id,
        report_id: snapshot.report.report_id,
        report_version: snapshot.report.report_version,
        format: 'application/pdf',
        storage_ref: `authority://official-exports/${snapshot.snapshot_id}.pdf`,
        content_hash: exportHash,
        created_at: this.clock(),
      }));
    }
    return {
      session,
      snapshot_id: snapshot.snapshot_id,
      export_hash: exportHash,
      format: 'application/pdf',
      mime_type: 'application/pdf',
      filename: rendered?.filename || `${snapshot.template_binding.template_id}.pdf`,
      file: exported.file,
      output_artifact: outputArtifact,
      content_base64: exportBytes.toString('base64'),
      export_text: text,
      reused: !exported.created,
    };
  }

  async attachEvidence({ session_id: sessionId, expected_revision: expectedRevision, filename, mime_type: mimeType, purpose, buffer } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    const normalizedPurpose = String(purpose || '').trim().toUpperCase();
    if (!ATTACHMENT_PURPOSES.has(normalizedPurpose)) {
      throw workflowError('Attachment purpose is invalid.', 'INVALID_ATTACHMENT_PURPOSE', 400);
    }
    const name = String(filename || '').trim();
    if (!name || name.length > 240 || /[\\/\0]/u.test(name)) {
      throw workflowError('Attachment filename is invalid.', 'INVALID_ATTACHMENT_FILENAME', 400);
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw workflowError('Attachment content is required.', 'EMPTY_ATTACHMENT', 400);
    }
    const sourceDigest = digest(buffer);
    const storageRef = await this.sessionStore.putBinarySource(sourceDigest, buffer);
    const evidence = createEvidence({
      evidence_type: 'DOCUMENT', source_hash: `sha256:${sourceDigest}`, storage_ref: storageRef,
      created_at: this.clock(),
      metadata: {
        filename: name, mime_type: String(mimeType || 'application/octet-stream'), purpose: normalizedPurpose,
        uploader: this.principalRef, report_binding: reportBinding(session),
      },
    });
    await this.sessionStore.putRecord('evidence', evidence.evidence_id, evidence);
    const recorded = await this.sessionStore.recordEvent({
      session_id: sessionId, expected_revision: session.revision, event_type: 'EVIDENCE_ATTACHED',
      principal_ref: this.principalRef, occurred_at: this.clock(),
      details: { evidence_id: evidence.evidence_id, filename: name, purpose: normalizedPurpose },
      additions: { evidence_ids: [evidence.evidence_id] },
    });
    const computed = await this.persistAgentState(recorded.session);
    return { session: computed.session, evidence, agent_state: computed.agent_state };
  }

  async extractFacts({ session, transcript, extractionText = transcript.normalized_text ?? transcript.raw_text, traceSink = null }) {
    const template = await this.resolveTemplate(session.template_binding.template_id);
    const assertions = segmentAssertions({ text: extractionText, transcript_id: transcript.transcript_id });
    const deterministic = await extractAtomicFacts({
      scope_id: session.context_binding.scope_id,
      raw_text: extractionText,
      transcript_id: transcript.transcript_id,
      capture_context: transcript.capture_context,
      assertions,
    });
    const conversational = extractConversationalFacts({
      scope_id: session.context_binding.scope_id,
      raw_text: extractionText,
      transcript_id: transcript.transcript_id,
      capture_context: transcript.capture_context,
    });
    const overlaps = (a, b) => a.char_start < b.char_end && b.char_start < a.char_end;
    const deterministicFacts = [
      ...deterministic.filter((fact) => !conversational.some((supplement) => (
        (supplement.semantic_type === 'COMPLETED_ACTION' && fact.semantic_type === 'COMPLETED_ACTION'
          && overlaps(supplement, fact) && /\b(?:re[- ]?test|test(?:ed|ing)?)\b/iu.test(fact.value))
        || (supplement.semantic_type === 'ASSET_IDENTITY' && fact.semantic_type === 'EQUIPMENT_OR_ASSET'
          && overlaps(supplement, fact) && supplement.value === fact.value)
        || (supplement.semantic_type === 'TEST_ACTION' && fact.semantic_type === 'TEST_ACTION'
          && overlaps(supplement, fact) && supplement.value === fact.value)
      ))),
      ...conversational.filter((fact) => !deterministic.some((prior) => (
        (fact.semantic_type !== 'TEST_ACTION' && prior.semantic_type === fact.semantic_type
          && overlaps(prior, fact) && prior.value === fact.value)
        || (fact.semantic_type === 'CUSTOMER_COMPLAINT' && fact.source_role === 'CUSTOMER'
          && prior.semantic_type === 'CUSTOMER_OBSERVATION' && overlaps(prior, fact))
      ))),
    ].sort((a, b) => a.char_start - b.char_start || a.semantic_type.localeCompare(b.semantic_type));
    const firstPassCoverage = evaluateAssertionCoverage({ assertions, facts: deterministicFacts, text: extractionText });
    const semanticWindows = unresolvedSemanticWindows(firstPassCoverage).map((window) => {
      const index = assertions.findIndex((assertion) => assertion.assertion_id === window.assertion_id);
      return {
        assertion_id: window.assertion_id, text: window.text, start: window.start, end: window.end,
        uncovered_spans: window.uncovered_spans,
        previous: assertions[index - 1]?.text || null,
        next: assertions[index + 1]?.text || null,
      };
    });
    const proposed = await new SemanticExtractor({ provider: this.semanticProvider, model: this.semanticModel }).extract({
      scope_id: session.context_binding.scope_id,
      transcript_id: transcript.transcript_id,
      raw_text: extractionText,
      capture_context: transcript.capture_context,
      semantic_windows: semanticWindows,
      established_facts: deterministicFacts,
    });
    const modelFacts = proposed.facts
      .filter((fact) => !deterministicFacts.some((established) => established.semantic_type === fact.semantic_type
        && established.value === fact.value && established.claim_kind === fact.claim_kind
        && established.source_role === fact.source_role && overlaps(established, fact)))
      .map((fact) => ({ ...fact, extraction_method: 'structured-semantic-proposal' }));
    const atomicFacts = [
      ...modelFacts,
      ...deterministicFacts,
    ].sort((a, b) => a.char_start - b.char_start || a.semantic_type.localeCompare(b.semantic_type));
    const relationships = atomicFacts.filter((fact) => fact.semantic_type === 'TEST_OBSERVATION'
      && fact.attributes?.observed_change === 'ABSENT').flatMap((observation) => {
      const complaint = [...atomicFacts].reverse().find((fact) => ['CUSTOMER_COMPLAINT', 'CUSTOMER_OBSERVATION'].includes(fact.semantic_type)
        && fact.char_end < observation.char_start
        && String(fact.value || '').toLocaleLowerCase().match(/[\p{L}]{4,}/gu)
          ?.some((word) => new RegExp(`\\b${word}\\b`, 'iu').test(observation.value)));
      if (!complaint) return [];
      return [{ relationship_type: 'SYMPTOM_RESOLUTION', complaint_fact_id: complaint.fact_id,
        observation_fact_id: observation.fact_id, test_fact_id: observation.attributes.related_test_fact_id }];
    });
    const routing = routeAtomicFacts({
      facts: atomicFacts,
      template,
      capture_context: transcript.capture_context,
    });
    const routed = routing.assignments.filter((assignment) => assignment.semantic_type !== 'TEST_ACTION'
      || !routing.assignments.some((other) => other.field_id === assignment.field_id
        && ['TEST_MEASUREMENT', 'TEST_OBSERVATION', 'TEST_OUTCOME'].includes(other.semantic_type)))
      .map((assignment) => {
      if (assignment.semantic_type !== 'TEST_OBSERVATION') return assignment;
      const action = atomicFacts.find((fact) => fact.fact_id === assignment.fact.attributes?.related_test_fact_id);
      if (!action) return assignment;
      return {
        ...assignment,
        value: `${action.value}; ${assignment.value}`,
        source_spans: [action, assignment.fact].map((fact) => ({
          start: fact.char_start, end: fact.char_end, text: fact.evidence_quote,
        })),
        fact_ids: [action.fact_id, assignment.fact.fact_id],
      };
    });
    const usedFields = new Set(routed.map((assignment) => assignment.field_id));
    const modelFields = (proposed.field_assignments || []).filter((assignment) => {
      if (usedFields.has(assignment.field_id)) return false;
      usedFields.add(assignment.field_id);
      return true;
    });
    const cuedFields = extractCuedFieldAssignments({
      template, raw_text: extractionText, capture_context: transcript.capture_context,
    }).assignments
      .filter((assignment) => {
        if (usedFields.has(assignment.field_id)) return false;
        usedFields.add(assignment.field_id);
        return true;
      }).map((assignment) => ({ ...assignment, extraction_method: 'deterministic-schema-cue' }));
    const evidence = await this.sessionStore.readRecord('evidence', transcript.source_evidence_id);
    const dateFields = deriveCaptureTimeAssignments({
      raw_text: extractionText, template, captured_at: evidence?.created_at || transcript.created_at,
      time_zone: this.reportTimeZone,
    }).filter((assignment) => !usedFields.has(assignment.field_id));
    const assignments = [...routed, ...modelFields, ...cuedFields, ...dateFields]
      .map((assignment) => ({ ...assignment, field: assignment.field_id }));
    if (traceSink) {
      const assigned = new Set(assignments.map((assignment) => assignment.field_id));
      const byField = new Map();
      for (const assignment of assignments) {
        if (!byField.has(assignment.field_id)) byField.set(assignment.field_id, []);
        byField.get(assignment.field_id).push(assignment);
      }
      const conflicts = [...byField].flatMap(([fieldId, items]) => {
        if (items.every((item) => ['COMPLETED_ACTION', 'PART_USED'].includes(item.semantic_type))) return [];
        const values = [...new Set(items.map((item) => JSON.stringify([item.claim_kind, item.value ?? null])))];
        return values.length > 1 ? [{ field_id: fieldId, values: items.map((item) => item.value ?? null),
          fact_ids: items.flatMap((item) => item.fact_ids || (item.fact ? [item.fact.fact_id] : [])) }] : [];
      });
      const conflictFields = new Set(conflicts.map((item) => item.field_id));
      const unresolvedDefect = semanticWindows.some((window) =>
        /\b(?:crack|loose|leak|fault|broken|damage|worn|failed|defect)\b/iu.test(window.text));
      const missing = (template?.schema?.fields || []).filter((field) =>
        !field.id.includes('*') && (!assigned.has(field.id) || conflictFields.has(field.id)))
        .map((field) => ({
          field_id: field.id,
          reason: conflictFields.has(field.id) ? 'CONFLICTING'
            : proposed.provider_error && field.id === 'inspection_findings' && unresolvedDefect
              ? 'EXTRACTION_FAILED'
              : field.id === 'work.date_time' && atomicFacts.some((fact) => fact.semantic_type === 'TEMPORAL_REFERENCE')
            ? 'MENTIONED_BUT_INVALID'
            : field.id === 'diagnosis.root_cause' && atomicFacts.some((fact) => fact.semantic_type === 'INSPECTION_FINDING')
              ? 'AMBIGUOUS' : 'NOT_MENTIONED',
        }));
      const conflictedFactIds = new Set(conflicts.flatMap((item) => item.fact_ids));
      const finalCoverage = evaluateAssertionCoverage({ assertions, facts: atomicFacts, text: extractionText })
        .map((assertion) => assertion.fact_ids.some((id) => conflictedFactIds.has(id))
          ? { ...assertion, status: 'AMBIGUOUS' } : assertion);
      const traceBody = {
        session_id: session.session_id,
        transcript_id: transcript.transcript_id,
        input_text_sha256: `sha256:${digest(extractionText)}`,
        pipeline_versions: pipelineVersions(session),
        assertions: finalCoverage,
        unresolved_semantic_windows: semanticWindows,
        first_pass_coverage: firstPassCoverage.map(({ assertion_id, status, uncovered_spans: uncoveredSpans }) => ({
          assertion_id, status, uncovered_spans: uncoveredSpans,
        })),
        canonical_facts: atomicFacts,
        relationships,
        deterministic_proposals: deterministicFacts.map((fact) => fact.fact_id),
        semantic_proposals: proposed.proposals || [],
        accepted_semantic_fact_ids: modelFacts.map((fact) => fact.fact_id),
        model: { provider: proposed.provider || null, model: proposed.model || null,
          skipped: proposed.skipped || null, error: proposed.provider_error || null, rejections: proposed.rejections || [] },
        field_assignments: assignments.map((assignment) => ({
          field_id: assignment.field_id, semantic_type: assignment.semantic_type,
          fact_ids: assignment.fact_ids || (assignment.fact ? [assignment.fact.fact_id] : []),
          value: assignment.value ?? null, claim_kind: assignment.claim_kind,
        })),
        unassigned_facts: routing.unassigned.map(({ fact, reason }) => ({ fact_id: fact.fact_id, reason })),
        conflicts,
        missing_information: missing,
      };
      traceSink.value = { trace_id: `trace_${digest(JSON.stringify(traceBody))}`, ...traceBody };
    }
    return assignments;
  }

  async extractCandidates({
    session,
    transcript,
    supportType,
    extractionText = transcript.normalized_text ?? transcript.raw_text,
    mapSourceSpan = (span) => span,
    confirmedCorrections = [],
    correctionContext = null,
    confirmationRequirements = [],
    preExtractedFacts = null,
  }) {
    const traceSink = {};
    const extractedFacts = await this.extractFacts({
      session,
      transcript,
      extractionText,
      confirmedCorrections,
      preExtractedFacts,
      traceSink,
    });
    const facts = coalesceAdditiveAssignments(extractedFacts);
    const spans = [];
    const candidates = [];
    const fields = [];
    for (const fact of facts) {
      const extractedSources = (fact.source_spans || [fact.source_span])
        .map((sourceSpan) => exactFactSpan({ source_span: sourceSpan }, extractionText));
      const sources = extractedSources.map(mapSourceSpan);
      const requiredConfirmations = confirmationRequirements.filter((item) => item.field_id === fact.field);
      const correctionItems = (correctionContext?.items || []).filter((item) => (
        item.affected_fields?.includes(fact.field)
        || sources.some((source) => source.start < item.source_span.end && source.end > item.source_span.start)
      ));
      const correctionProvenance = correctionItems.length ? {
        transcript_review_id: correctionContext.transcript_review_id,
        raw_text_hash: transcript.text_hash,
        effective_projection_hash: correctionContext.effective_projection_hash,
        decisions: correctionItems.map((item) => ({ review_item_id: item.review_item_id, decision: 'ACCEPT' })),
      } : null;
      const factSpans = sources.map((source) => createEvidenceSpan({
        evidence_id: transcript.transcript_id,
        start_offset: source.start,
        end_offset: source.end,
        quote: source.text,
        source_text: transcript.raw_text,
      }));
      const measuredValue = fact.unit !== undefined && /^[-+]?\d+(?:[.,]\d+)?$/u.test(String(fact.value))
        ? Number(String(fact.value).replace(',', '.'))
        : fact.value;
      const candidate = createFieldCandidate({
        session_id: session.session_id,
        field_id: fact.field,
        claim: fact.claim_kind === 'EXPLICIT_NONE'
          ? { kind: 'EXPLICIT_NONE' }
          : { kind: 'VALUE', value: fact.unit === undefined ? fact.value : { value: measuredValue, unit: fact.unit } },
        unit: fact.unit,
        support_type: fact.semantic_type === 'CAPTURE_TIME_DERIVATION' ? 'AI_INFERENCE' : supportType,
        assessment: fact.support_status === 'UNCERTAIN' ? 'UNCERTAIN' : 'VALID',
        evidence_refs: factSpans.map((span) => ({ evidence_id: transcript.transcript_id, span_id: span.span_id })),
        source_ref: transcript.transcript_id,
        extraction: { method: fact.extraction_method || fact.fact?.extraction_method || 'deterministic-rule', version: EXTRACTION_VERSION },
        risk_class: fact.critical || requiredConfirmations.length ? 'CRITICAL' : 'STANDARD',
        confidence_class: fact.support_status === 'INFERRED' ? 'INFERRED'
          : fact.support_status === 'UNCERTAIN' ? 'UNCERTAIN' : 'DIRECT_EVIDENCE',
        source_context: {
          domain: session.context_binding.scope_id,
          context_id: session.context_binding.context_id,
          context_version: session.context_binding.context_version,
          scope_id: session.context_binding.scope_id,
        },
        semantic: fact.fact ? {
          fact_id: fact.fact.fact_id,
          fact_ids: fact.fact_ids || [fact.fact.fact_id],
          semantic_type: fact.fact.semantic_type,
          source_role: fact.fact.source_role,
          temporality: fact.fact.temporality,
        } : null,
        correction_provenance: correctionProvenance,
        confirmation_requirement_ids: requiredConfirmations.map((item) => item.requirement_id),
      });
      for (const span of factSpans) await this.sessionStore.putRecord('evidence-spans', span.span_id, span);
      await this.sessionStore.putRecord('field-candidates', candidate.candidate_id, candidate);
      spans.push(...factSpans);
      candidates.push(candidate);
      fields.push({
        field_id: fact.field,
        semantic_type: fact.semantic_type,
        claim_kind: candidate.claim.kind,
        value: candidate.claim.kind === 'VALUE' ? candidate.claim.value : null,
        extraction_method: candidate.extraction.method,
        evidence: {
          transcript_id: transcript.transcript_id,
          start: sources[0].start, end: sources[0].end, quote: sources[0].text,
        },
        evidence_spans: sources.map((source) => ({ start: source.start, end: source.end, quote: source.text })),
      });
    }
    const artifact = {
      schema_version: 'report-field-extraction.v1',
      artifact_role: 'evidence-backed-projection',
      session_id: session.session_id,
      transcript_id: transcript.transcript_id,
      template_id: session.template_binding.template_id,
      model: this.semanticModel || null,
      model_contributed: fields.some((field) => ['structured-semantic-proposal', 'structured-schema-field-proposal'].includes(field.extraction_method)),
      input_text_sha256: `sha256:${digest(extractionText)}`,
      fields,
    };
    const artifactId = `extraction_${digest(JSON.stringify(artifact))}`;
    await this.sessionStore.putRecord('semantic-extractions', artifactId, { artifact_id: artifactId, ...artifact });
    const semanticTrace = traceSink.value;
    if (semanticTrace) {
      for (const fact of semanticTrace.canonical_facts) {
        await this.sessionStore.putRecord('canonical-facts', fact.fact_id, fact);
      }
      await this.sessionStore.putRecord('semantic-traces', semanticTrace.trace_id, semanticTrace);
    }
    return { spans, candidates, facts, semantic_trace: semanticTrace };
  }

  async retrieveGuidance({ session, transcript, facts, query = transcript.normalized_text ?? transcript.raw_text }) {
    if (!CONTEXT_BY_SCOPE[session.context_binding.scope_id]) return { session, guidanceContext: null };
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
    const template = await this.resolveTemplate(session.template_binding.template_id);
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
    const principalRef = this.principalRef;
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

  async selectFieldRepresentation({ session_id: sessionId, expected_revision: expectedRevision, field_id: fieldId, selection, idempotency_key: idempotencyKey } = {}) {
    const normalizedFieldId = String(fieldId || '').trim();
    const requestHash = hashContract({ session_id: sessionId, field_id: normalizedFieldId, selection });
    const reused = await this.sessionStore.claimAnswer({
      session_id: sessionId, idempotency_key: idempotencyKey, request_hash: requestHash,
    });
    if (reused) return { ...reused, reused: true };

    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (!['RESOLVE', 'REVIEW'].includes(session.phase)) {
      throw workflowError('Report fields can be reviewed only after extraction and before confirmation.', 'FIELD_SELECTION_PHASE_MISMATCH', 409);
    }
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      throw workflowError('A structured field selection is required.', 'INVALID_FIELD_SELECTION');
    }
    const template = await this.resolveTemplate(session.template_binding.template_id);
    const definition = template.schema.fields.find((item) => (
      item.id.endsWith('.*') ? normalizedFieldId.startsWith(item.id.slice(0, -1)) : normalizedFieldId === item.id
    ));
    if (!definition) throw workflowError('Field is outside the bound template version.', 'FIELD_NOT_IN_TEMPLATE', 400);

    const current = await this.getAgentState(sessionId);
    const field = current.agent_state.report_fields.find((entry) => entry.field_id === normalizedFieldId);
    if (!field) throw workflowError('Field is absent from the authoritative report state.', 'FIELD_NOT_IN_REPORT', 400);

    const kind = String(selection.kind || '');
    let claim;
    let unit;
    let sourceCandidate = null;
    let evidence = null;
    let span = null;
    let selectedSource = null;
    let selectedSpan = null;
    let selectedQuote = null;

    const readBoundCandidate = async () => {
      const candidateId = String(selection.candidate_id || '');
      if (!session.field_candidate_ids.includes(candidateId)) {
        throw workflowError('Candidate belongs to another ReportSession.', 'FIELD_CANDIDATE_BINDING_MISMATCH', 409);
      }
      const candidate = await this.sessionStore.readRecord('field-candidates', candidateId);
      if (candidate.session_id !== session.session_id || candidate.field_id !== normalizedFieldId || candidate.support_type === 'RAG_GUIDANCE') {
        throw workflowError('Candidate belongs to another ReportSession or field.', 'FIELD_CANDIDATE_BINDING_MISMATCH', 409);
      }
      return candidate;
    };

    if (kind === 'CANDIDATE') {
      selectedSource = await readBoundCandidate();
      claim = selectedSource.claim;
      unit = selectedSource.unit || undefined;
    } else if (kind === 'TRANSCRIPT_SPAN') {
      selectedSource = await readBoundCandidate();
      const spanId = String(selection.span_id || '');
      const reference = selectedSource.evidence_refs.find((item) => item.span_id === spanId);
      const sourceBelongsToSession = session.evidence_ids.includes(reference?.evidence_id)
        || session.transcript_ids.includes(reference?.evidence_id);
      if (!reference || !session.evidence_span_ids.includes(spanId) || !sourceBelongsToSession) {
        throw workflowError('Transcript words are outside this field or ReportSession.', 'FIELD_SPAN_BINDING_MISMATCH', 409);
      }
      selectedSpan = await this.sessionStore.readRecord('evidence-spans', spanId);
      if (selectedSpan.evidence_id !== reference.evidence_id || !session.transcript_ids.includes(reference.evidence_id)) {
        throw workflowError('Transcript words do not match the selected field evidence.', 'FIELD_SPAN_BINDING_MISMATCH', 409);
      }
      const sourceTranscript = await this.sessionStore.readRecord('transcripts', reference.evidence_id);
      selectedQuote = sourceTranscript.raw_text.slice(selectedSpan.start_offset, selectedSpan.end_offset);
      if (!selectedQuote.trim() || hashContract(selectedQuote) !== selectedSpan.quote_hash) {
        throw workflowError('Transcript words do not match the immutable evidence span.', 'FIELD_SPAN_BINDING_MISMATCH', 409);
      }
      claim = { kind: 'VALUE', value: selectedQuote };
    } else if (kind === 'MANUAL') {
      const value = typeof selection.value === 'string' ? selection.value.trim() : selection.value;
      if (value === '' || value === null || value === undefined) throw workflowError('Manual field value is required.', 'INVALID_FIELD_SELECTION');
      unit = selection.unit === undefined || selection.unit === null || selection.unit === '' ? undefined : String(selection.unit);
      claim = { kind: 'VALUE', value: unit ? { value, unit } : value };
    } else if (kind === 'SEMANTIC_STATE') {
      const semantic = String(selection.state || '');
      const values = {
        NOT_ESTABLISHED: 'Root cause not established',
        FURTHER_INVESTIGATION_REQUIRED: 'Further investigation required',
        SUSPECTED: selection.value ? `Suspected root cause: ${String(selection.value).trim()}` : 'Suspected root cause',
        CONFIRMED: selection.value ? String(selection.value).trim() : 'Confirmed root cause',
      };
      if (!values[semantic]) throw workflowError('Semantic field state is invalid.', 'INVALID_FIELD_SELECTION');
      claim = { kind: 'VALUE', value: values[semantic] };
    } else if (kind === 'EXPLICIT_NONE') {
      claim = { kind: 'EXPLICIT_NONE' };
    } else if (kind === 'NOT_APPLICABLE') {
      claim = { kind: 'NOT_APPLICABLE' };
    } else {
      throw workflowError('Field selection kind is invalid.', 'INVALID_FIELD_SELECTION');
    }

    const allowed = definition.allowedValues || definition.allowedStatuses;
    const claimValue = claim.kind === 'VALUE'
      ? (claim.value && typeof claim.value === 'object' && Object.hasOwn(claim.value, 'value') ? claim.value.value : claim.value)
      : null;
    if (allowed && claim.kind === 'VALUE' && !allowed.includes(String(claimValue))) {
      throw workflowError('Technician field selection is outside the template allowed values.', 'FIELD_ANSWER_INVALID', 400);
    }

    if (kind !== 'CANDIDATE') {
      const sourceText = kind === 'TRANSCRIPT_SPAN'
        ? selectedQuote
        : JSON.stringify({ field_id: normalizedFieldId, selection });
      const sourceDigest = digest(Buffer.from(sourceText, 'utf8'));
      if (kind === 'TRANSCRIPT_SPAN') {
        sourceCandidate = createFieldCandidate({
          session_id: session.session_id, field_id: normalizedFieldId, claim,
          support_type: 'MANUAL_TECHNICIAN_INPUT', assessment: 'VALID',
          evidence_refs: selectedSource.evidence_refs.filter((reference) => reference.span_id === selectedSpan.span_id),
          source_ref: selectedSource.source_ref,
          extraction: { method: 'technician-transcript-selection', version: PROCESSING_VERSION },
          risk_class: definition.critical || definition.requiresTechnicianConfirmation ? 'CRITICAL' : 'STANDARD',
          confidence_class: 'DIRECT_EVIDENCE',
          source_context: selectedSource.source_context,
        });
      } else {
        const storageRef = await this.sessionStore.putTextSource(sourceDigest, sourceText);
        evidence = createEvidence({
          evidence_type: 'MANUAL_INPUT', source_hash: `sha256:${sourceDigest}`, storage_ref: storageRef, created_at: this.clock(),
          metadata: { input_kind: 'TECHNICIAN_FIELD_SELECTION', field_id: normalizedFieldId, selection_kind: kind, report_binding: reportBinding(session) },
        });
        span = createEvidenceSpan({
          evidence_id: evidence.evidence_id, start_offset: 0, end_offset: sourceText.length, quote: sourceText, source_text: sourceText,
        });
        sourceCandidate = createFieldCandidate({
          session_id: session.session_id, field_id: normalizedFieldId, claim, unit,
          support_type: 'MANUAL_TECHNICIAN_INPUT',
          assessment: kind === 'SEMANTIC_STATE' && selection.state === 'SUSPECTED' ? 'UNCERTAIN' : 'VALID',
          evidence_refs: [{ evidence_id: evidence.evidence_id, span_id: span.span_id }], source_ref: evidence.evidence_id,
          extraction: { method: 'technician-field-selection', version: PROCESSING_VERSION },
          risk_class: definition.critical || definition.requiresTechnicianConfirmation ? 'CRITICAL' : 'STANDARD',
          confidence_class: kind === 'SEMANTIC_STATE' && selection.state === 'SUSPECTED' ? 'UNCERTAIN' : 'DIRECT_EVIDENCE',
          source_context: {
            domain: session.context_binding.scope_id, context_id: session.context_binding.context_id,
            context_version: session.context_binding.context_version, scope_id: session.context_binding.scope_id,
          },
        });
      }
    }

    const confirmationSource = sourceCandidate || selectedSource;
    const principalRef = this.principalRef;
    const event = createTechnicianConfirmationEvent({
      session_id: session.session_id, revision: session.revision + 1, field_id: normalizedFieldId,
      candidate_id: confirmationSource.candidate_id, technician_principal_ref: principalRef, occurred_at: this.clock(),
    });
    const issueIds = current.agent_state.validation_issues
      .filter((issue) => issue.field_id === normalizedFieldId)
      .map((issue) => issue.issue_id);
    const candidate = createConfirmedFieldCandidate({
      session_id: session.session_id, field_id: normalizedFieldId,
      confirmed_candidate_id: confirmationSource.candidate_id,
      claim, unit,
      assessment: kind === 'SEMANTIC_STATE' && selection.state === 'SUSPECTED' ? 'UNCERTAIN' : 'VALID',
      evidence_refs: confirmationSource.evidence_refs,
      source_ref: confirmationSource.source_ref,
      extraction: { method: 'technician-field-selection-confirmation', version: PROCESSING_VERSION },
      risk_class: confirmationSource.risk_class,
      confidence_class: 'CONFIRMED',
      source_context: confirmationSource.source_context,
      resolution: {
        resolution_id: `field-selection:${normalizedFieldId}:${session.revision + 1}`,
        issue_ids: issueIds,
        resolved_candidate_ids: field.candidates.map((entry) => entry.candidate_id),
        answer_kind: kind,
      },
    }, { confirmation_event: event });

    if (evidence) await this.sessionStore.putRecord('evidence', evidence.evidence_id, evidence);
    if (span) await this.sessionStore.putRecord('evidence-spans', span.span_id, span);
    if (sourceCandidate) await this.sessionStore.putRecord('field-candidates', sourceCandidate.candidate_id, sourceCandidate);
    await this.sessionStore.putRecord('field-candidates', candidate.candidate_id, candidate);
    const recorded = await this.sessionStore.recordEvent({
      session_id: session.session_id, expected_revision: session.revision, event_type: 'TECHNICIAN_CONFIRMATION',
      principal_ref: principalRef, occurred_at: event.occurred_at,
      details: event.payload,
      additions: {
        evidence_ids: evidence ? [evidence.evidence_id] : [],
        evidence_span_ids: span ? [span.span_id] : [],
        field_candidate_ids: [sourceCandidate?.candidate_id, candidate.candidate_id].filter(Boolean),
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
    const template = await this.resolveTemplate(session.template_binding.template_id);
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
    const principalRef = this.principalRef;
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
      claim, unit,
      assessment: kind === 'SEMANTIC_STATE' && answer.state === 'SUSPECTED' ? 'UNCERTAIN' : 'VALID',
      evidence_refs: linkedRefs, source_ref: evidence.evidence_id,
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
    let proposedItems;
    let confirmationRequirements = [];
    if (session.context_binding.scope_id === 'HVAC') {
      const review = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
      proposedItems = review.candidates.map((candidate) => ({
        review_item_id: candidate.candidate_id,
        kind: 'CORRECTION',
        source_span: {
          start: candidate.source_span.start,
          end: candidate.source_span.end,
          quote: candidate.source_span.text,
        },
        proposed_text: candidate.candidate,
        category: candidate.risk || 'CRITICAL_TERMINOLOGY',
        reason: candidate.reason,
      }));
    } else {
      const review = reviewV2Transcript({ scopeId: session.context_binding.scope_id, rawText: transcript.raw_text });
      proposedItems = review.correction_suggestions.map((item) => ({
        review_item_id: item.correction_id,
        kind: 'CORRECTION',
        source_span: { start: item.start, end: item.end, quote: item.source_text },
        proposed_text: item.suggested_text,
        category: item.category,
        reason: item.reason,
      }));
      confirmationRequirements = review.confirmation_questions.flatMap((item) => {
        const quote = String(item.source_text || '');
        const start = transcript.raw_text.indexOf(quote);
        if (!quote || start < 0) return [];
        return [{
          requirement_id: item.question_id,
          field_id: item.field,
          source_span: { start, end: start + quote.length, quote },
          reason: item.reason,
        }];
      });
    }
    const automatic = transcript.corrections || [];
    proposedItems = proposedItems.filter((item) => !automatic.some((correction) => (
      item.source_span.start < correction.sourceSpan.end && item.source_span.end > correction.sourceSpan.start
    )));
    if (!proposedItems.length) return { items: [], confirmationRequirements };
    const rawFacts = await this.extractFacts({ session, transcript, extractionText: transcript.normalized_text });
    const items = [];
    for (const item of proposedItems) {
      const projection = transcriptProjection(transcript, [item], [{ review_item_id: item.review_item_id, decision: 'ACCEPT' }]);
      const confirmedCorrections = [{
        correction_id: item.review_item_id,
        source_span: { start: item.source_span.start, end: item.source_span.end, text: item.source_span.quote },
        candidate: item.proposed_text,
        status: 'CONFIRMED_BY_TECHNICIAN',
      }];
      const proposedFacts = await this.extractFacts({
        session,
        transcript,
        extractionText: projection.effectiveText,
      });
      const impact = compareReportClaimImpact({ rawFacts, proposedFacts });
      if (impact.material) items.push({ ...item, ...impact });
    }
    return { items, confirmationRequirements };
  }

  async finishTranscript({ session, evidence, transcript, supportType }) {
    await this.sessionStore.putRecord('transcripts', transcript.transcript_id, transcript);
    const { items, confirmationRequirements } = await this.reviewItems(session, transcript);
    if (items.length) {
      const review = createTranscriptReview({
        session_id: session.session_id,
        transcript_id: transcript.transcript_id,
        transcript_text: transcript.raw_text,
        status: 'PENDING',
        items,
        decisions: [],
        confirmation_requirements: confirmationRequirements,
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
    const projection = transcriptProjection(transcript);
    const { spans, candidates, facts, semantic_trace: semanticTrace } = await this.extractCandidates({
      session,
      transcript,
      supportType,
      extractionText: projection.effectiveText,
      mapSourceSpan: projection.mapSpan,
      confirmationRequirements,
    });
    const guided = await this.retrieveGuidance({ session, transcript, facts, query: projection.effectiveText });
    const completed = await this.sessionStore.transition({
      session_id: session.session_id,
      expected_revision: guided.session.revision,
      to_phase: 'RESOLVE',
      event_type: 'STRUCTURED_CANDIDATES_CREATED',
      occurred_at: this.clock(),
      details: {
        transcript_id: transcript.transcript_id,
        semantic_trace_id: semanticTrace?.trace_id || null,
        field_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      },
      additions: {
        transcript_ids: [transcript.transcript_id],
        evidence_span_ids: spans.map((span) => span.span_id),
        field_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      },
    });
    let computed = await this.persistAgentState(completed.session);
    const targetFieldId = transcript.capture_context?.capture_mode === 'FIELD_DICTATION'
      ? transcript.capture_context.target_field_id : null;
    const dictated = targetFieldId
      ? candidates.filter((candidate) => candidate.field_id === targetFieldId)
      : [];
    if (dictated.length === 1) {
      const selected = await this.selectFieldRepresentation({
        session_id: completed.session.session_id,
        expected_revision: computed.session.revision,
        field_id: targetFieldId,
        selection: { kind: 'CANDIDATE', candidate_id: dictated[0].candidate_id },
        idempotency_key: `field-dictation:${transcript.transcript_id}`,
      });
      computed = { session: selected.session, agent_state: selected.agent_state };
    }
    return {
      session: computed.session,
      evidence,
      transcript,
      review: null,
      spans,
      candidates,
      semantic_trace: semanticTrace,
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
      confirmation_requirements: pending.confirmation_requirements,
      reviewer_principal_ref: this.principalRef,
      reviewed_at: this.clock(),
      effective_projection_hash: hashContract(transcriptProjection(transcript, pending.items, normalized).effectiveText),
    });
    await this.sessionStore.putRecord('transcript-reviews', review.review_id, review);
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
    const projection = transcriptProjection(transcript, pending.items, normalized);
    const supportType = transcript.provider === 'technician-text' ? 'MANUAL_TECHNICIAN_INPUT' : 'TRANSCRIPT_EVIDENCE';
    const acceptedItems = pending.items.filter((item) => normalized.some((decision) => (
      decision.review_item_id === item.review_item_id && decision.decision === 'ACCEPT'
    )));
    const extraction = await this.extractCandidates({
      session,
      transcript,
      supportType,
      extractionText: projection.effectiveText,
      mapSourceSpan: projection.mapSpan,
      confirmedCorrections,
      confirmationRequirements: pending.confirmation_requirements,
      correctionContext: acceptedItems.length ? {
        transcript_review_id: review.review_id,
        effective_projection_hash: review.effective_projection_hash,
        items: acceptedItems,
      } : null,
    });
    const { spans, candidates, facts, semantic_trace: semanticTrace } = extraction;
    const guided = await this.retrieveGuidance({
      session,
      transcript,
      facts,
      query: projection.effectiveText,
    });
    const completed = await this.sessionStore.transition({
      session_id: session.session_id,
      expected_revision: guided.session.revision,
      to_phase: 'RESOLVE',
      event_type: 'TRANSCRIPT_REVIEW_DECIDED',
      occurred_at: this.clock(),
      details: {
        transcript_id: transcript.transcript_id,
        semantic_trace_id: semanticTrace?.trace_id || null,
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
      semantic_trace: semanticTrace,
      guidance_context: guided.guidanceContext,
      reused: false,
      next_action: 'RESOLVE_REPORT_FIELDS',
      agent_state: computed.agent_state,
    };
  }

  captureIdentity({ session, sourceHash, model, language, captureContext = null }) {
    return hashContract({
      source_hash: sourceHash,
      report_session_id: session.session_id,
      template_id: session.template_binding.template_id,
      template_version: session.template_binding.template_version,
      stt_model: model,
      stt_language: language,
      capture_context: captureContext,
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
      const transcript = await this.createCapturedTranscript({
        session,
        evidence,
        rawText: result.raw_text,
        language: result.language || record.language || 'und',
        provider: result.provider || 'whisper',
        model: result.model || record.model,
        segments: Array.isArray(result.segments) ? result.segments : [],
        captureContext: record.capture_context,
        createdAt: this.clock(),
      });
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

  async captureText({ session_id: sessionId, expected_revision: expectedRevision, text, language = 'und', idempotency_key: idempotencyKey, target_field_id: targetFieldId, target_section_id: targetSectionId, capture_mode: captureMode } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase === 'CONFIRMED') throw workflowError('Confirmed reports are immutable.', 'REPORT_SESSION_FINAL', 409);
    const rawText = String(text || '').trim();
    if (!rawText) throw workflowError('Technician text is required.', 'TECHNICIAN_TEXT_REQUIRED');
    if (rawText.length > 20_000) throw workflowError('Technician text exceeds 20000 characters.', 'TECHNICIAN_TEXT_TOO_LARGE', 413);
    const sourceDigest = digest(Buffer.from(rawText, 'utf8'));
    const normalizedLanguage = String(language || 'und');
    const captureContext = await this.captureContext(session, { target_field_id: targetFieldId, target_section_id: targetSectionId, capture_mode: captureMode });
    const identityHash = this.captureIdentity({
      session,
      sourceHash: `sha256:${sourceDigest}`,
      model: 'manual-entry',
      language: normalizedLanguage,
      captureContext,
    });
    const existing = await this.sessionStore.claimCapture({ identity_hash: identityHash, idempotency_key: idempotencyKey });
    if (existing) return this.reuseCapture(existing);
    const storageRef = await this.sessionStore.putTextSource(sourceDigest, rawText);
    const evidence = createEvidence({
      evidence_type: 'MANUAL_INPUT',
      source_hash: `sha256:${sourceDigest}`,
      storage_ref: storageRef,
      created_at: this.clock(),
      metadata: { language: normalizedLanguage, report_binding: reportBinding(session), capture_context: captureContext },
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
      capture_context: captureContext,
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
    const transcript = await this.createCapturedTranscript({
      session: processing.session,
      evidence,
      rawText,
      language: normalizedLanguage,
      provider: 'technician-text',
      model: 'manual-entry',
      segments: [],
      captureContext,
      createdAt: this.clock(),
    });
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

  async captureAudio({ session_id: sessionId, expected_revision: expectedRevision, wav_buffer: wavBuffer, model = 'base', language = 'auto', idempotency_key: idempotencyKey, target_field_id: targetFieldId, target_section_id: targetSectionId, capture_mode: captureMode } = {}) {
    const session = await this.sessionStore.load(sessionId);
    assertExpectedRevision(session, expectedRevision);
    if (session.phase === 'CONFIRMED') throw workflowError('Confirmed reports are immutable.', 'REPORT_SESSION_FINAL', 409);
    if (!Buffer.isBuffer(wavBuffer)) throw workflowError('Audio must be supplied as WAV bytes.', 'INVALID_WAV');
    const audio = await this.artifactStore.putAudio(wavBuffer);
    const normalizedModel = String(this.modelResolver ? await this.modelResolver() : (model || 'base'));
    const normalizedLanguage = String(language || 'auto');
    const captureContext = await this.captureContext(session, { target_field_id: targetFieldId, target_section_id: targetSectionId, capture_mode: captureMode });
    const identityHash = this.captureIdentity({
      session,
      sourceHash: audio.source_hash,
      model: normalizedModel,
      language: normalizedLanguage,
      captureContext,
    });
    const existing = await this.sessionStore.claimCapture({ identity_hash: identityHash, idempotency_key: idempotencyKey });
    if (existing) {
      if (existing.status === 'CAPTURED') {
        const current = await this.sessionStore.load(sessionId);
        const previousEvidence = await this.sessionStore.readRecord('evidence', existing.evidence_id).catch(async (error) => {
          if (error.code !== 'IMMUTABLE_RECORD_NOT_FOUND' || !existing.evidence_created_at) throw error;
          const metadata = await this.artifactStore.readAudioMetadata(existing.audio_id);
          return createEvidence({ evidence_type: 'AUDIO', source_hash: existing.source_hash,
            storage_ref: `artifact://audio/${existing.audio_id}.wav`, created_at: existing.evidence_created_at,
            metadata: { bytes: metadata.bytes, wav: metadata.wav, report_binding: reportBinding(current), capture_context: existing.capture_context } });
        });
        const processing = current.phase === 'PROCESSING' ? { session: current }
          : current.phase === 'CAPTURE' && current.evidence_ids.includes(existing.evidence_id)
            ? await this.sessionStore.transition({ session_id: sessionId, expected_revision: current.revision,
              to_phase: 'PROCESSING', event_type: 'PROCESSING_STARTED', occurred_at: this.clock(),
              details: { evidence_id: existing.evidence_id, processing_version: PROCESSING_VERSION } })
            : await this.beginCapture({ sessionId, expectedRevision: current.revision, evidence: previousEvidence, source: 'MICROPHONE_AUDIO' });
        return this.transcribeAudioRecord({ record: existing, session: processing.session, evidence: previousEvidence });
      }
      return this.reuseCapture(existing);
    }
    const evidence = createEvidence({
      evidence_type: 'AUDIO',
      source_hash: audio.source_hash,
      storage_ref: `artifact://audio/${audio.audio_id}.wav`,
      created_at: this.clock(),
      metadata: { bytes: audio.bytes, wav: audio.wav, report_binding: reportBinding(session), capture_context: captureContext },
    });
    const record = {
      identity_hash: identityHash,
      session_id: session.session_id,
      source_hash: audio.source_hash,
      audio_id: audio.audio_id,
      evidence_id: evidence.evidence_id,
      evidence_created_at: evidence.created_at,
      model: normalizedModel,
      language: normalizedLanguage,
      processing_version: PROCESSING_VERSION,
      capture_context: captureContext,
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
