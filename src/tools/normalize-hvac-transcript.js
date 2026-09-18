import { applyCorrectionDecisions, candidateBundleHash, CRITICAL_CORRECTION_RISKS } from './correction-integrity.js';

function validateCandidate(candidate, rawText) {
  const start = Number(candidate?.source_span?.start);
  const end = Number(candidate?.source_span?.end);
  const sourceText = String(candidate?.source_span?.text || '');
  if (!candidate?.candidate_id || !candidate?.knowledge_version || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > rawText.length) return null;
  if (rawText.slice(start, end) !== sourceText) return null;
  if (!candidate.candidate || !Array.isArray(candidate.knowledge_ids) || candidate.knowledge_ids.length === 0 || !candidate.match_basis?.rule_id) return null;
  return Object.freeze({
    candidate_id: String(candidate.candidate_id),
    knowledge_version: String(candidate.knowledge_version),
    source_span: Object.freeze({ start, end, text: sourceText }),
    candidate: String(candidate.candidate),
    knowledge_ids: Object.freeze(candidate.knowledge_ids.map(String)),
    risk: String(candidate.risk || 'LOW'),
    reason: String(candidate.reason || 'Approved terminology candidate.'),
    match_basis: Object.freeze({
      knowledge_id: String(candidate.match_basis.knowledge_id || ''),
      rule_id: String(candidate.match_basis.rule_id),
      match_basis: String(candidate.match_basis.match_basis || ''),
      matched_text: String(candidate.match_basis.matched_text || ''),
    }),
  });
}

export async function normalizeHvacTranscript({ transcript, knowledgeCandidates = [], knowledgeVersion, provider, model, traceId }) {
  if (!transcript?.artifact_id || typeof transcript.raw_text !== 'string') {
    throw Object.assign(new Error('An immutable TranscriptArtifact is required.'), { code: 'INVALID_TRANSCRIPT_ARTIFACT', status: 400 });
  }
  const candidates = knowledgeCandidates.map((candidate) => validateCandidate(candidate, transcript.raw_text)).filter(Boolean);
  if (candidates.length === 0) {
    return {
      tool: 'normalize_hvac_transcript',
      trace_id: traceId,
      status: 'PASS',
      data: {
        transcript_artifact_id: transcript.artifact_id,
        raw_text: transcript.raw_text,
        proposed_text: transcript.raw_text,
        raw_text_unchanged: true,
        knowledge_version: String(knowledgeVersion || ''),
        candidate_bundle_hash: candidateBundleHash({ transcriptArtifactId: transcript.artifact_id, rawText: transcript.raw_text, knowledgeVersion, candidates: [] }),
        correction_candidates: [],
        deterministic_fallback_used: true,
      },
      warnings: ['No knowledge-backed correction candidates were supplied; raw transcript was preserved.'],
      retryable: false,
      error_code: null,
    };
  }
  const allowedIds = new Set(candidates.map((item) => item.candidate_id));
  const warnings = [];
  let selectedIds = candidates.map((item) => item.candidate_id);
  let deterministicFallbackUsed = true;
  let providerMetadata = null;
  if (provider?.generateJson && model) {
    try {
      const response = await provider.generateJson({
        model,
        system: 'You may recommend only correction candidate_id values supplied by the server. Never rewrite text, invent a candidate, or add service actions, tests, prices, models, quantities, or completion claims. Return JSON only.',
        prompt: JSON.stringify({
          raw_text: transcript.raw_text,
          candidates,
          required_output: { selected_candidate_ids: ['candidate_id'] },
        }),
      });
      const returned = response?.data?.selected_candidate_ids;
      const returnedIds = Array.isArray(returned) ? [...new Set(returned.map(String))] : null;
      const validIds = returnedIds?.filter((id) => allowedIds.has(id));
      if (returnedIds && returnedIds.length === validIds.length) {
        selectedIds = validIds;
        deterministicFallbackUsed = false;
      } else {
        warnings.push('Invalid or unsupported model output was discarded; deterministic controlled candidates were used.');
      }
      providerMetadata = { provider: response?.provider || 'unknown', model: response?.model || model };
    } catch (error) {
      warnings.push(`Model normalization failed; deterministic controlled candidates were used (${error.code || 'PROVIDER_ERROR'}).`);
    }
  }
  const corrections = candidates.map((candidate) => ({
    correction_id: `corr_${candidate.candidate_id}`,
    candidate_id: candidate.candidate_id,
    knowledge_version: candidate.knowledge_version,
    source_span: candidate.source_span,
    candidate: candidate.candidate,
    knowledge_ids: candidate.knowledge_ids,
    risk: candidate.risk,
    status: CRITICAL_CORRECTION_RISKS.has(candidate.risk) ? 'NEEDS_TECHNICIAN_CONFIRMATION' : 'PROPOSED',
    recommended: selectedIds.includes(candidate.candidate_id),
    reason: candidate.reason,
    match_basis: candidate.match_basis,
  }));
  const proposalDecisions = corrections.map((item) => ({ candidate_id: item.candidate_id, decision: item.recommended ? 'ACCEPT' : 'REJECT' }));
  const proposedText = applyCorrectionDecisions(transcript.raw_text, candidates, proposalDecisions);
  return {
    tool: 'normalize_hvac_transcript',
    trace_id: traceId,
    status: corrections.some((item) => item.status === 'NEEDS_TECHNICIAN_CONFIRMATION') ? 'NEEDS_CONFIRMATION' : 'PASS',
    data: {
      transcript_artifact_id: transcript.artifact_id,
      raw_text: transcript.raw_text,
      proposed_text: proposedText,
      raw_text_unchanged: true,
      knowledge_version: String(knowledgeVersion || candidates[0]?.knowledge_version || ''),
      candidate_bundle_hash: candidateBundleHash({ transcriptArtifactId: transcript.artifact_id, rawText: transcript.raw_text, knowledgeVersion: knowledgeVersion || candidates[0]?.knowledge_version, candidates }),
      correction_candidates: corrections,
      provider: providerMetadata,
      deterministic_fallback_used: deterministicFallbackUsed,
    },
    warnings,
    retryable: false,
    error_code: null,
  };
}
