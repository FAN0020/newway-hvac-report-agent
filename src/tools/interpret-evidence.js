import { extractServiceFacts } from './extract-service-facts.js';
import { extractV2Facts } from './extract-v2-facts.js';
import { buildTranscriptCorrectionCandidates } from './hvac-knowledge.js';
import { applyConfirmedTranscriptCorrections, reviewV2Transcript } from '../v2/transcript-review.js';

export const EVIDENCE_APPROACHES = Object.freeze([
  'RAW_DIRECT',
  'WHOLE_TRANSCRIPT_CORRECTION',
  'FACT_CENTRIC_HYBRID',
]);

const CONTEXT_BY_SCOPE = Object.freeze({ HVAC: 'HVAC', SBS_BUS: 'SBS/BUS', SBS_RAIL: 'SBS/RAIL', OILFIELD: 'OILFIELD', POWER_GRID: 'POWER/GRID' });
const SAFE_FIELDS_BY_CATEGORY = Object.freeze({
  ASSET_IDENTIFIER: Object.freeze(['asset.', 'equipment']),
  DOMAIN_TERMINOLOGY: Object.freeze(['asset.subsystem', 'parts.part_number']),
  CRITICAL_TERMINOLOGY: Object.freeze(['asset.', 'equipment', 'parts.', 'measurements']),
  CRITICAL_VALUE: Object.freeze(['measurements']),
});

function exactNoneFact(rawText) {
  const match = /\bno parts (?:were )?(?:used|replaced)\b/iu.exec(rawText);
  return match ? {
    field: 'parts.part_number', value: null, claim_kind: 'EXPLICIT_NONE', support_status: 'DIRECT_TRANSCRIPT',
    source: 'manual', source_span: { start: match.index, end: match.index + match[0].length, text: match[0] }, critical: false,
  } : null;
}

function correctionsForScope(scopeId, rawText) {
  if (scopeId === 'HVAC') {
    return buildTranscriptCorrectionCandidates({ rawText }).then((bundle) => ({
      items: bundle.candidates.map((item) => ({
        correction_id: item.candidate_id, start: item.source_span.start, end: item.source_span.end,
        source_text: item.source_span.text, suggested_text: item.candidate, category: item.risk || 'CRITICAL_TERMINOLOGY',
        reason: item.reason, requires_confirmation: true,
      })),
      confirmations: [],
    }));
  }
  const review = reviewV2Transcript({ scopeId, rawText });
  return Promise.resolve({ items: [...review.correction_suggestions], confirmations: [...review.confirmation_questions] });
}

export function correctionProjection(rawText, corrections = []) {
  const selected = [...corrections].sort((a, b) => a.start - b.start);
  const effectiveText = applyConfirmedTranscriptCorrections(rawText, selected, selected.map((item) => item.correction_id));
  const pieces = [];
  let rawCursor = 0;
  let effectiveCursor = 0;
  const rawPiece = (start, end) => {
    if (end <= start) return;
    const length = end - start;
    pieces.push({ type: 'RAW', effective_start: effectiveCursor, effective_end: effectiveCursor + length, raw_start: start, raw_end: end, corrections: [] });
    effectiveCursor += length;
  };
  for (const correction of selected) {
    rawPiece(rawCursor, correction.start);
    const length = correction.suggested_text.length;
    pieces.push({ type: 'REPLACEMENT', effective_start: effectiveCursor, effective_end: effectiveCursor + length, raw_start: correction.start, raw_end: correction.end, corrections: [correction] });
    effectiveCursor += length;
    rawCursor = correction.end;
  }
  rawPiece(rawCursor, rawText.length);
  const mapSpan = (span) => {
    const overlapping = pieces.filter((piece) => span.start < piece.effective_end && span.end > piece.effective_start);
    if (!overlapping.length) return null;
    const rawStarts = overlapping.map((piece) => piece.type === 'RAW' ? piece.raw_start + Math.max(0, span.start - piece.effective_start) : piece.raw_start);
    const rawEnds = overlapping.map((piece) => piece.type === 'RAW' ? piece.raw_start + Math.min(piece.effective_end, span.end) - piece.effective_start : piece.raw_end);
    const start = Math.min(...rawStarts);
    const end = Math.max(...rawEnds);
    return {
      start, end, text: rawText.slice(start, end),
      corrections: overlapping.flatMap((piece) => piece.corrections),
    };
  };
  return { effectiveText, mapSpan };
}

async function extract(scopeId, text, confirmedCorrections = []) {
  if (scopeId === 'HVAC') {
    const result = await extractServiceFacts({ transcript: { artifact_id: 'evaluation', raw_text: text }, confirmedCorrections });
    return result.data.facts.map((fact) => ({ ...fact, claim_kind: fact.claim_kind || 'VALUE' }));
  }
  const result = await extractV2Facts({ contextId: CONTEXT_BY_SCOPE[scopeId], rawText: text });
  return result.facts.map((fact) => ({ ...fact, claim_kind: fact.claim_kind || 'VALUE' }));
}

function factKey(fact) {
  return `${fact.field}|${fact.claim_kind || 'VALUE'}|${JSON.stringify(fact.value)}`;
}

function categoryAllows(field, corrections) {
  return corrections.some((correction) => (SAFE_FIELDS_BY_CATEGORY[correction.category] || []).some((prefix) => field === prefix || field.startsWith(prefix)));
}

function exactRawProvenance(fact, rawText) {
  const span = fact.source_span;
  return Boolean(span && Number.isInteger(span.start) && Number.isInteger(span.end)
    && rawText.slice(span.start, span.end) === span.text);
}

export async function interpretEvidence({ scope_id: scopeId, raw_text: rawText, approach = 'FACT_CENTRIC_HYBRID' } = {}) {
  if (!EVIDENCE_APPROACHES.includes(approach)) throw new TypeError(`Unsupported evidence approach: ${approach}`);
  const text = String(rawText || '');
  const review = await correctionsForScope(scopeId, text);
  const projection = correctionProjection(text, review.items);
  const none = exactNoneFact(text);
  let facts;
  if (approach === 'RAW_DIRECT') {
    facts = await extract(scopeId, text);
  } else if (approach === 'WHOLE_TRANSCRIPT_CORRECTION') {
    facts = (await extract(scopeId, projection.effectiveText, review.items.map((item) => ({
      correction_id: item.correction_id, source_span: { start: item.start, end: item.end, text: item.source_text }, candidate: item.suggested_text, status: 'CONFIRMED_BY_TECHNICIAN',
    })))).map((fact) => {
      const mapped = projection.mapSpan(fact.source_span);
      return mapped ? { ...fact, source_span: { start: mapped.start, end: mapped.end, text: mapped.text }, correction_ids: mapped.corrections.map((item) => item.correction_id) } : fact;
    });
  } else {
    const rawFacts = await extract(scopeId, text, review.items.map((item) => ({
      correction_id: item.correction_id, source_span: { start: item.start, end: item.end, text: item.source_text }, candidate: item.suggested_text, status: 'CONFIRMED_BY_TECHNICIAN',
    })));
    const correctedFacts = await extract(scopeId, projection.effectiveText, review.items);
    facts = [...rawFacts];
    const existing = new Set(facts.map(factKey));
    for (const fact of correctedFacts) {
      const mapped = projection.mapSpan(fact.source_span);
      if (!mapped?.corrections.length || !categoryAllows(fact.field, mapped.corrections)) continue;
      const projected = { ...fact, source_span: { start: mapped.start, end: mapped.end, text: mapped.text }, correction_ids: mapped.corrections.map((item) => item.correction_id) };
      if (!existing.has(factKey(projected))) {
        facts.push(projected);
        existing.add(factKey(projected));
      }
    }
  }
  if (none) {
    facts = facts.filter((fact) => fact.field !== none.field);
    facts.push(none);
  }
  return Object.freeze({
    approach,
    raw_text: text,
    effective_text: approach === 'RAW_DIRECT' ? text : projection.effectiveText,
    facts: Object.freeze(facts.map((fact) => Object.freeze(fact))),
    corrections: Object.freeze(review.items),
    confirmation_questions: Object.freeze(review.confirmations),
    intervention_count: approach === 'RAW_DIRECT' ? 0 : Number(review.items.length + review.confirmations.length > 0),
    provenance_valid: facts.every((fact) => exactRawProvenance(fact, text)),
  });
}
