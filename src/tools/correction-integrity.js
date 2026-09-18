import { hashValue } from './report-integrity.js';

export const CRITICAL_CORRECTION_RISKS = new Set([
  'CRITICAL_VALUE',
  'NEGATION',
  'MODEL_OR_PART_NUMBER',
  'REFRIGERANT',
  'MEASUREMENT',
  'COMPLETION_STATUS',
  'PRICE_OR_COMMITMENT',
]);

export function transcriptTextHash(rawText) {
  return hashValue(String(rawText || ''));
}

export function candidateBundleHash({ transcriptArtifactId, rawText, knowledgeVersion, candidates }) {
  return hashValue({
    transcript_artifact_id: String(transcriptArtifactId || ''),
    raw_text_hash: transcriptTextHash(rawText),
    knowledge_version: String(knowledgeVersion || ''),
    candidates,
  });
}

export function applyCorrectionDecisions(rawText, candidates, decisions) {
  const text = String(rawText || '');
  const candidateMap = new Map(candidates.map((candidate) => [String(candidate.candidate_id), candidate]));
  const accepted = decisions
    .filter((decision) => decision.decision === 'ACCEPT')
    .map((decision) => candidateMap.get(String(decision.candidate_id)))
    .filter(Boolean)
    .sort((a, b) => a.source_span.start - b.source_span.start || a.source_span.end - b.source_span.end);
  for (let index = 1; index < accepted.length; index += 1) {
    if (accepted[index].source_span.start < accepted[index - 1].source_span.end) {
      throw Object.assign(new Error('Accepted corrections overlap.'), { code: 'OVERLAPPING_CORRECTIONS', status: 409 });
    }
  }
  let result = text;
  for (const candidate of accepted.toReversed()) {
    const { start, end, text: sourceText } = candidate.source_span;
    if (result.slice(start, end) !== sourceText) {
      throw Object.assign(new Error('Correction source span does not match the immutable raw transcript.'), { code: 'CORRECTION_SOURCE_MISMATCH', status: 409 });
    }
    result = `${result.slice(0, start)}${candidate.candidate}${result.slice(end)}`;
  }
  return result;
}
