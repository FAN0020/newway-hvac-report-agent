import { extractServiceFacts } from '../tools/extract-service-facts.js';
import { extractV2Facts } from '../tools/extract-v2-facts.js';
import { buildTranscriptCorrectionCandidates } from '../tools/hvac-knowledge.js';
import { normalizeHvacTranscript } from '../tools/normalize-hvac-transcript.js';
import { buildTemplateReport } from '../tools/build-template-report.js';
import { toolEnvelope } from '../tools/tool-envelope.js';

const CONTEXT_BY_DOMAIN = Object.freeze({
  SBS_BUS: 'SBS/BUS',
  SBS_RAIL: 'SBS/RAIL',
});

function requireWorkflowInputs({ template, reportSessionId, artifactStore, reportStore }) {
  if (!template?.templateId || !template?.domain) {
    throw Object.assign(new Error('A published template version is required.'), { code: 'TEMPLATE_REQUIRED', status: 400 });
  }
  if (!String(reportSessionId || '').trim()) {
    throw Object.assign(new Error('report_session_id is required.'), { code: 'REPORT_SESSION_REQUIRED', status: 400 });
  }
  if (!artifactStore?.putAudio || !reportStore?.recordStructuredValidation) {
    throw new TypeError('Artifact and report stores are required.');
  }
}

async function transcribeStoredAudio({
  audio,
  reportBinding,
  artifactStore,
  whisperProvider,
  model,
  language,
  attempt,
  idempotencyKey,
}) {
  const key = String(idempotencyKey || [
    audio.audio_id,
    model,
    language,
    reportBinding.template_id,
    reportBinding.template_version,
    reportBinding.report_session_id,
    `attempt-${attempt}`,
  ].join(':'));
  const existing = await artifactStore.getTranscriptByKey(key);
  if (existing) {
    if (JSON.stringify(existing.report_binding || null) !== JSON.stringify(reportBinding)) {
      throw Object.assign(new Error('The transcription idempotency key belongs to another report binding.'), {
        code: 'CAPTURE_BINDING_MISMATCH', status: 409,
      });
    }
    return { transcript: existing, reused: true };
  }
  const result = await whisperProvider.transcribe(artifactStore.audioPath(audio.audio_id), { model, language });
  const transcript = await artifactStore.putTranscript({
    audio_id: audio.audio_id,
    ...result,
    source_hash: audio.source_hash,
    attempt,
    input_mode: 'VOICE_TRANSCRIPT',
    report_binding: reportBinding,
  }, { idempotencyKey: key });
  return { transcript, reused: false };
}

export async function captureAudioForReport({
  wavBuffer,
  template,
  reportSessionId,
  artifactStore,
  reportStore,
  whisperProvider,
  normalizationProvider,
  normalizationModel = '',
  model = 'base',
  language = 'auto',
  attempt = 1,
  idempotencyKey,
  traceId,
}) {
  requireWorkflowInputs({ template, reportSessionId, artifactStore, reportStore });
  if (!Buffer.isBuffer(wavBuffer)) {
    throw Object.assign(new Error('Audio must be supplied as WAV bytes.'), { code: 'INVALID_WAV', status: 400 });
  }
  if (!whisperProvider?.transcribe) throw new TypeError('A transcription provider is required.');

  const audio = await artifactStore.putAudio(wavBuffer);
  const reportBinding = {
    template_id: template.templateId,
    template_version: template.templateVersion,
    report_session_id: String(reportSessionId),
  };
  let transcription;
  try {
    transcription = await transcribeStoredAudio({
      audio,
      reportBinding,
      artifactStore,
      whisperProvider,
      model: String(model || 'base'),
      language: String(language || 'auto'),
      attempt: Math.max(1, Math.min(2, Number(attempt) || 1)),
      idempotencyKey,
    });
  } catch (error) {
    return toolEnvelope('capture_audio_report', traceId, error?.retryable ? 'RETRYABLE_ERROR' : 'FAIL', {
      audio,
      transcript: null,
      next_action: 'RETRY_TRANSCRIPTION',
      failure: {
        code: error?.code || 'TRANSCRIPTION_FAILED',
        message: Number(error?.status) >= 500
          ? 'Transcription failed; audio was preserved for retry.'
          : String(error?.message || 'Transcription failed.'),
      },
    }, { retryable: error?.retryable, error_code: error?.code || 'TRANSCRIPTION_FAILED' });
  }

  const { transcript, reused } = transcription;
  if (template.domain === 'HVAC') {
    const knowledge = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
    const normalization = await normalizeHvacTranscript({
      transcript,
      knowledgeCandidates: knowledge.candidates,
      knowledgeVersion: knowledge.knowledge_version,
      provider: normalizationProvider,
      model: normalizationModel,
      traceId,
    });
    return toolEnvelope('capture_audio_report', traceId, 'NEEDS_CONFIRMATION', {
      audio,
      transcript,
      transcript_reused: reused,
      template_binding: {
        template_id: template.templateId,
        template_version: template.templateVersion,
        report_session_id: reportSessionId,
      },
      correction_review: {
        knowledge_version: normalization.data.knowledge_version,
        candidate_bundle_hash: normalization.data.candidate_bundle_hash,
        proposed_text: normalization.data.proposed_text,
        candidates: normalization.data.correction_candidates,
      },
      next_action: 'CONFIRM_TRANSCRIPT',
    }, { warnings: normalization.warnings });
  }

  const contextId = CONTEXT_BY_DOMAIN[template.domain];
  if (!contextId) {
    return toolEnvelope('capture_audio_report', traceId, 'NEEDS_CONFIRMATION', {
      audio,
      transcript,
      transcript_reused: reused,
      next_action: 'ENTER_REPORT_FIELDS',
    }, { warnings: [`No deterministic capture adapter is registered for ${template.domain}.`] });
  }
  const extracted = await extractV2Facts({ contextId, rawText: transcript.raw_text });
  const built = await buildTemplateReport({
    template,
    facts: extracted.facts,
    reportSessionId,
    traceId,
    reportStore,
  });
  return toolEnvelope('capture_audio_report', traceId, built.status, {
    audio,
    transcript,
    transcript_reused: reused,
    facts: extracted.facts,
    extraction_warnings: extracted.warnings,
    ...built.data,
    next_action: 'RESOLVE_REPORT_FIELDS',
  });
}

export async function completeHvacAudioReport({
  template,
  reportSessionId,
  transcriptArtifactId,
  candidateBundleHash,
  decisions,
  technicianId,
  technicianName,
  artifactStore,
  reportStore,
  factsProvider,
  factsModel = '',
  traceId,
}) {
  requireWorkflowInputs({ template, reportSessionId, artifactStore, reportStore });
  if (template.domain !== 'HVAC') {
    throw Object.assign(new Error('This completion path is only valid for HVAC templates.'), { code: 'TEMPLATE_SCOPE_MISMATCH', status: 400 });
  }
  const transcript = await artifactStore.readTranscript(transcriptArtifactId);
  const expectedBinding = {
    template_id: template.templateId,
    template_version: template.templateVersion,
    report_session_id: String(reportSessionId),
  };
  if (JSON.stringify(transcript.report_binding || null) !== JSON.stringify(expectedBinding)) {
    throw Object.assign(new Error('The transcript belongs to another template version or report session.'), {
      code: 'CAPTURE_BINDING_MISMATCH', status: 409,
    });
  }
  const knowledge = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
  const correctionReceipt = await artifactStore.putCorrectionReceipt({
    transcriptArtifactId: transcript.artifact_id,
    knowledgeVersion: knowledge.knowledge_version,
    candidates: knowledge.candidates,
    candidatesHash: candidateBundleHash,
    decisions,
    technicianId,
    technicianName,
  });
  const extracted = await extractServiceFacts({
    transcript: { ...transcript, raw_text: correctionReceipt.final_text },
    correctionReceipt,
    confirmedCorrections: correctionReceipt.decisions,
    provider: factsProvider,
    model: factsModel,
    traceId,
  });
  if (extracted.status !== 'PASS') return extracted;
  const factsReceipt = await artifactStore.putFacts({
    correctionReceipt,
    facts: extracted.data.facts,
  });
  const built = await buildTemplateReport({
    template,
    facts: factsReceipt.facts,
    reportSessionId,
    traceId,
    reportStore,
  });
  return toolEnvelope('complete_hvac_audio_report', traceId, built.status, {
    transcript,
    correction_receipt: correctionReceipt,
    facts_receipt_id: factsReceipt.facts_receipt_id,
    facts_hash: factsReceipt.facts_hash,
    facts: factsReceipt.facts,
    ...built.data,
    next_action: 'RESOLVE_REPORT_FIELDS',
  }, { warnings: extracted.warnings });
}
