import { WhisperProvider } from '../src/providers/whisper.js';
import { buildTranscriptCorrectionCandidates } from '../src/tools/hvac-knowledge.js';
import { normalizeHvacTranscript } from '../src/tools/normalize-hvac-transcript.js';
import { reviewV2Transcript, applyConfirmedTranscriptCorrections } from '../src/v2/transcript-review.js';
import { extractServiceFacts } from '../src/tools/extract-service-facts.js';
import { extractV2Facts } from '../src/tools/extract-v2-facts.js';
import { validateReportInput } from '../src/tools/validate-report-input.js';
import { planV2Report } from '../src/v2/report-builder.js';

const contexts = Object.freeze({ SBS_BUS: 'SBS/BUS', SBS_RAIL: 'SBS/RAIL', OILFIELD: 'OILFIELD', POWER_GRID: 'POWER/GRID' });
export function whisperAdapter(root) {
  return new WhisperProvider({ runtimeRoot: `${root}/runtime/stt/${process.platform}-${process.arch}`, tempRoot: `${root}/.tmp/component-eval-whisper` });
}
export async function correctionAdapter(scope, rawText, caseId) {
  if (scope === 'HVAC') {
    const bundle = await buildTranscriptCorrectionCandidates({ rawText });
    const result = await normalizeHvacTranscript({ transcript: { artifact_id: caseId, raw_text: rawText }, knowledgeCandidates: bundle.candidates, knowledgeVersion: bundle.knowledge_version });
    return { text: result.data.proposed_text, review_status: result.status, candidates: result.data.correction_candidates.length };
  }
  if (scope === 'SBS_BUS' || scope === 'SBS_RAIL') {
    const review = reviewV2Transcript({ scopeId: scope, rawText });
    return { text: applyConfirmedTranscriptCorrections(rawText, review.correction_suggestions, review.correction_suggestions.map((item) => item.correction_id)), review_status: review.correction_suggestions.some((item) => item.requires_confirmation) ? 'NEEDS_CONFIRMATION' : 'PASS', candidates: review.correction_suggestions.length };
  }
  return null;
}
export async function factsAdapter(scope, reference, caseId) {
  if (scope === 'HVAC') {
    const result = await extractServiceFacts({ transcript: { artifact_id: caseId, raw_text: reference } });
    return { status: result.status, facts: result.data?.facts || [], error_code: result.error_code };
  }
  const result = await extractV2Facts({ contextId: contexts[scope], rawText: reference });
  return { status: 'PASS', facts: result.facts, warnings: result.warnings };
}
export async function missingAdapter(scope, facts, caseId) {
  if (scope === 'HVAC') {
    const result = await validateReportInput({ facts, traceId: caseId });
    return { status: result.status, missing: result.data?.missing_required_fields || [], error_code: result.error_code };
  }
  const result = planV2Report({ scopeId: scope, facts });
  return { status: 'PASS', missing: result.missing_required_fields };
}
