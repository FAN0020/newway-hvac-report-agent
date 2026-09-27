import crypto from 'node:crypto';

export const CONVERSATIONAL_FACTS_VERSION = 'conversational-facts.v1';

function stableId(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function lowerInitial(value) {
  const text = String(value || '').trim().replace(/[.!?]+$/u, '');
  return text ? `${text[0].toLocaleLowerCase()}${text.slice(1)}` : text;
}

export function extractConversationalFacts({ raw_text: rawText, transcript_id: transcriptId, scope_id: scopeId, capture_context: captureContext = null } = {}) {
  const text = String(rawText || '');
  const facts = [];
  const seen = new Set();
  const isAttributedReport = (start) => {
    const before = text.slice(0, start);
    const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
    return /\b(?:the\s+)?(?:driver|operator|customer|client)\s+(?:reported|complained|said)\b/iu.test(before.slice(boundary + 1));
  };
  const add = ({ semanticType, value, match, claimKind = 'VALUE', sourceRole = 'TECHNICIAN', temporality = 'CURRENT', attributes = {} }) => {
    if (!match || (claimKind === 'VALUE' && !String(value || '').trim())) return;
    const start = match.index;
    const end = start + match[0].length;
    const key = JSON.stringify([semanticType, start, end, value]);
    if (seen.has(key)) return;
    seen.add(key);
    const identity = { transcript_id: transcriptId, semantic_type: semanticType, value, char_start: start, char_end: end, claim_kind: claimKind };
    facts.push(Object.freeze({
      fact_id: `fact_${stableId(identity)}`,
      semantic_type: semanticType,
      value: claimKind === 'VALUE' ? String(value).trim() : null,
      claim_kind: claimKind,
      source_role: sourceRole,
      temporality,
      transcript_id: String(transcriptId || ''),
      segment_ids: [],
      char_start: start,
      char_end: end,
      evidence_quote: text.slice(start, end),
      support_status: 'CONFIRMED_BY_EVIDENCE',
      scope_id: String(scopeId || ''),
      capture_context: captureContext ? structuredClone(captureContext) : null,
      extraction_method: 'contextual-deterministic',
      attributes: Object.freeze({ ...attributes }),
    }));
  };

  // Explicit syntactic roles matter here: a line number and a person's name
  // mentioned in a conversation are not a fleet number or technician identity.
  for (const match of text.matchAll(/\bbus\s+(\d{1,6})\b/giu)) {
    if (/\b(?:line|route)\s*$/iu.test(text.slice(Math.max(0, match.index - 16), match.index))
      || /\bbus\s+line\b/iu.test(text.slice(match.index, match.index + 18))) continue;
    add({ semanticType: 'ASSET_IDENTITY', value: match[1], match,
      attributes: { identifier_kind: 'FLEET' } });
  }
  for (const match of text.matchAll(/\b(?:bus\s+)?(?:line|route)\s+(\d{1,6})\b/giu)) {
    add({ semanticType: 'ROUTE_IDENTITY', value: match[1], match,
      attributes: { identifier_kind: 'ROUTE' } });
  }
  for (const match of text.matchAll(/\bat\s+((?:[A-Z][\p{L}'-]*\s+){0,4}(?:Airport|Depot|Station|Terminal))\b/gu)) {
    add({ semanticType: 'LOCATION', value: match[1], match,
      attributes: { location_kind: 'DEPOT_OR_WORKSITE' } });
  }
  for (const match of text.matchAll(/\bI(?:\s+am|['’]m)\s+([A-Z][\p{L}'-]{1,40})\b/gu)) {
    if (isAttributedReport(match.index)) continue;
    if (/^(?:Ready|Done|Working|Going|Not)$/u.test(match[1])) continue;
    add({ semanticType: 'TECHNICIAN_IDENTITY', value: match[1], match,
      attributes: { identifier_kind: 'TECHNICIAN', self_identified: true } });
  }
  for (const match of text.matchAll(/\b(?:the\s+)?(driver|operator|customer)(?:\s+[A-Z][\p{L}'-]+)?\s+(?:complained\s+about|reported|said)\s+(?:about\s+)?(.+?)(?=[.!?]|$)/giu)) {
    const reported = lowerInitial(match[2]);
    const speech = /^(?:the|a|an)\s+[\p{L}-]+$/iu.test(reported)
      ? reported.replace(/^(?:the|a|an)\s+/iu, '') : reported;
    add({ semanticType: 'CUSTOMER_COMPLAINT', value: speech, match,
      sourceRole: match[1].toLocaleUpperCase(), temporality: 'PAST',
      attributes: { attributed_to: match[1].toLocaleUpperCase() } });
  }
  for (const match of text.matchAll(/\b(?:tightened|secured|repaired|replaced|installed|reseated|adjusted|cleaned|reset|refitted)\s+(.+?)(?=\s*(?:,|\band\b|\bthen\b|[.!?]|$))/giu)) {
    if (isAttributedReport(match.index)) continue;
    const before = text.slice(Math.max(0, match.index - 28), match.index);
    if (/\b(?:not|never|didn['’]?t|wasn['’]?t|weren['’]?t|should|will|would|plan(?:ned)?\s+to)\s*$/iu.test(before)) continue;
    if (/^(?:it|that)$/iu.test(match[1])) continue;
    const value = lowerInitial(match[0]);
    add({ semanticType: 'COMPLETED_ACTION', value, match,
      temporality: 'COMPLETED',
      attributes: { action_verb: match[0].split(/\s/u)[0].toLocaleLowerCase() } });
  }
  for (const match of text.matchAll(/\b(?:re[- ]?tested|ran\s+(?:a\s+)?retest|performed\s+(?:a\s+)?(?:re)?test)\b/giu)) {
    if (isAttributedReport(match.index)) continue;
    const before = text.slice(Math.max(0, match.index - 36), match.index);
    if (/\b(?:not|never|didn['’]?t|wasn['’]?t|weren['’]?t|should|will|would|need(?:ed|s)?\s+to|planned?\s+to)\s*$/iu.test(before)) continue;
    add({ semanticType: 'TEST_ACTION', value: lowerInitial(match[0]), match,
      temporality: 'COMPLETED',
      attributes: { test_kind: 'RETEST' } });
  }
  for (const match of text.matchAll(/\b((?:the\s+)?[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,3})\s+(?:was|were|is|are)\s+(?:gone|absent|no\s+longer\s+present)\s+(?:afterwards|after\s+(?:the\s+)?(?:re)?test|following\s+(?:the\s+)?(?:re)?test)\b/giu)) {
    const previousTest = [...facts].reverse().find((fact) => fact.semantic_type === 'TEST_ACTION'
      && fact.char_end <= match.index && match.index - fact.char_end < 140);
    if (!previousTest) continue;
    add({ semanticType: 'TEST_OBSERVATION', value: lowerInitial(match[0]), match,
      temporality: 'COMPLETED',
      attributes: { related_test_fact_id: previousTest.fact_id, observed_change: 'ABSENT' } });
  }
  for (const match of text.matchAll(/\b(?:I|we)\s+returned\s+(?:the\s+)?(?:bus|vehicle|asset|unit)\s+to\s+service\b/giu)) {
    if (isAttributedReport(match.index)) continue;
    const before = text.slice(Math.max(0, match.index - 42), match.index);
    if (/\b(?:should|will|would|may|might|need(?:ed|s)?\s+to|plan(?:ned)?\s+to|not|never)\s*$/iu.test(before)) continue;
    add({ semanticType: 'COMPLETION_STATE', value: 'ready', match,
      temporality: 'COMPLETED',
      attributes: { completion_kind: 'RETURNED_TO_SERVICE' } });
  }
  for (const match of text.matchAll(/\b(?:this\s+(?:morning|afternoon|evening)|today|yesterday|tonight)\b/giu)) {
    add({ semanticType: 'TEMPORAL_REFERENCE', value: lowerInitial(match[0]), match,
      temporality: 'PAST', attributes: { precision: 'DAYPART_OR_DAY', exact_clock_time: false } });
  }
  for (const match of text.matchAll(/\b(?:root\s+cause\s+(?:was|is)|caused\s+by|due\s+to)\s+([^.!?]+)/giu)) {
    if (isAttributedReport(match.index)) continue;
    add({ semanticType: 'ROOT_CAUSE', value: lowerInitial(match[1]), match, temporality: 'PAST' });
  }
  return facts.sort((a, b) => a.char_start - b.char_start || a.semantic_type.localeCompare(b.semantic_type));
}
