import crypto from 'node:crypto';
import { SEMANTIC_TYPES } from './atomic-facts.js';

const TYPE_SET = new Set(SEMANTIC_TYPES);
const TECHNICIAN_ONLY_TYPES = new Set([
  'INSPECTION_FINDING', 'COMPLETED_ACTION', 'PART_USED', 'MEASUREMENT',
  'TEST_ACTION', 'TEST_OUTCOME', 'COMPLETION_STATE', 'RECOMMENDATION', 'FOLLOW_UP',
]);

function stableId(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function words(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function lexicallyGrounded(value, quote) {
  const available = new Map();
  for (const word of words(quote)) available.set(word, (available.get(word) || 0) + 1);
  const requested = words(value);
  if (!requested.length) return false;
  for (const word of requested) {
    const count = available.get(word) || 0;
    if (!count) return false;
    available.set(word, count - 1);
  }
  return true;
}

function evidenceRole(text, start, end) {
  const prior = text.slice(0, start);
  const boundary = Math.max(prior.lastIndexOf('.'), prior.lastIndexOf('!'), prior.lastIndexOf('?'), prior.lastIndexOf('\n'));
  const context = text.slice(boundary + 1, end);
  const markers = /\b(?:the\s+)?customer\s+(?:reported|complained|said|had)\b|\b(?:I|we)\s+(?:found|observed|inspected|checked|replaced|installed|repaired|reseated|tested|verified|did)\b/giu;
  let role = 'TECHNICIAN';
  for (const marker of context.matchAll(markers)) {
    role = /^(?:the\s+)?customer\b/iu.test(marker[0]) ? 'CUSTOMER' : 'TECHNICIAN';
  }
  return role;
}

function evidenceTemporality(quote) {
  if (/\b(?:recommend(?:ed|ing)?|suggest(?:ed|ing)?|should|will|planned?\s+to|next\s+(?:visit|service)|later|in\s+future)\b/iu.test(quote)) return 'FUTURE';
  if (/\b(?:not|never|didn['’]?t|wasn['’]?t|weren['’]?t)\s+(?:(?:actually|yet|fully|today)\s+){0,2}(?:replac\w*|install\w*|us(?:e|ed|ing)|chang\w*|repair\w*|perform\w*|complet\w*|fit(?:ted)?|test\w*)\b/iu.test(quote)) return 'NEGATED';
  return 'CURRENT';
}

function nonAtomicEvidence(quote) {
  const withoutTrailingPunctuation = quote.replace(/[.!?;\s]+$/u, '');
  return /[.!?;\n]\s*\S/u.test(withoutTrailingPunctuation)
    || /,\s*(?:(?:and|but|so)\s+)?(?:I|we|it|both|(?:the\s+)?customer|(?:the\s+)?test|(?:the\s+)?job|(?:the\s+)?completion|replaced|installed|repaired|tested|checked|verified|passed|failed)\b/iu.test(quote);
}

function hasTestContext(text, start, end, captureContext) {
  if (/(?:^|\.)(?:test_results|result)$/u.test(String(captureContext?.target_field_id || ''))) return true;
  const prior = text.slice(0, start);
  const boundary = Math.max(prior.lastIndexOf('.'), prior.lastIndexOf('!'), prior.lastIndexOf('?'), prior.lastIndexOf('\n'));
  const sentence = text.slice(boundary + 1, end);
  if (/\b(?:test(?:ed|ing|s)?|result|post[- ]?work|cycles?|verification)\b/iu.test(sentence)) return true;
  if (!/^\s*(?:it|both|they|passed|failed)\b/iu.test(text.slice(start, end))) return false;
  // A bare outcome word is supported by a preceding test only when it closes
  // its own clause and that test was in the immediately preceding sentence.
  if (text.slice(end).match(/^[^.!?;\n]*/u)?.[0].trim()) return false;
  const earlier = prior.slice(0, boundary);
  const previousBoundary = Math.max(earlier.lastIndexOf('.'), earlier.lastIndexOf('!'), earlier.lastIndexOf('?'), earlier.lastIndexOf('\n'));
  const previous = prior.slice(previousBoundary + 1, boundary);
  return /\b(?:test(?:ed|ing|s)?|cycles?|verification)\b/iu.test(previous);
}

function hasIdentifierContext(semanticType, quote, value, captureContext) {
  const target = String(captureContext?.target_field_id || '');
  if (semanticType === 'WORK_ORDER') {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,63}$/u.test(value)) return false;
    return /\b(?:work\s*order|job\s*(?:number|no\.?|id))\b/iu.test(quote)
      || (/^(?:work_order|work\.work_order_id|work\.order_id)$/u.test(target) && quote.trim() === value);
  }
  if (semanticType === 'EQUIPMENT_OR_ASSET') {
    if (words(value).length > 5) return false;
    return /\b(?:equipment|asset|fleet|registration|station|chainage|location)\b|\b(?:unit|bus|line)\s+[A-Z0-9]/iu.test(quote)
      || ((target === 'equipment' || target.startsWith('asset.')) && quote.trim() === value);
  }
  return true;
}

export function verifyStructuredFactProposals({
  scope_id: scopeId,
  transcript_id: transcriptId,
  raw_text: rawText,
  proposals = [],
  capture_context: captureContext = null,
} = {}) {
  const text = String(rawText || '');
  const facts = [];
  const rejections = [];
  for (const [index, proposal] of (Array.isArray(proposals) ? proposals : []).entries()) {
    const semanticType = proposal?.semantic_type;
    let start = proposal?.char_start;
    let end = proposal?.char_end;
    const quote = proposal?.evidence_quote;
    const value = proposal?.value;
    const claimKind = proposal?.claim_kind || 'VALUE';
    if (typeof quote === 'string' && quote.trim()
      && (!Number.isInteger(start) || !Number.isInteger(end) || text.slice(start, end) !== quote)) {
      const found = text.indexOf(quote);
      if (found >= 0 && text.indexOf(quote, found + 1) < 0) {
        start = found;
        end = found + quote.length;
      }
    }
    if (!TYPE_SET.has(semanticType)
      || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length
      || typeof quote !== 'string' || text.slice(start, end) !== quote
      || !['VALUE', 'EXPLICIT_NONE'].includes(claimKind)
      || (claimKind === 'VALUE' && (typeof value !== 'string' || !value.trim()))
      || (claimKind === 'EXPLICIT_NONE' && value !== null)) {
      rejections.push({ index, reason: 'INVALID_OR_UNSUPPORTED_PROPOSAL' });
      continue;
    }
    const normalizedValue = claimKind === 'VALUE' ? value.trim() : null;
    if (claimKind === 'VALUE' && !lexicallyGrounded(normalizedValue, quote)) {
      rejections.push({ index, reason: 'UNSUPPORTED_VALUE' });
      continue;
    }
    if (claimKind === 'VALUE' && !hasIdentifierContext(semanticType, quote, normalizedValue, captureContext)) {
      rejections.push({ index, reason: 'SEMANTIC_TYPE_MISMATCH' });
      continue;
    }
    if (claimKind === 'EXPLICIT_NONE' && !(
      (semanticType === 'PART_USED' && /\b(?:no\s+parts\s+(?:were\s+)?used|did(?:n['’]?t|\s+not)\s+(?:use|change|replace)\s+(?:any\s+)?parts)\b/iu.test(quote))
      || (semanticType === 'FOLLOW_UP' && /\b(?:no\s+follow[- ]?up\s+(?:is\s+)?required|nothing\s+else\s+needed)\b/iu.test(quote))
    )) {
      rejections.push({ index, reason: 'SEMANTIC_TYPE_MISMATCH' });
      continue;
    }
    if (nonAtomicEvidence(quote)) {
      rejections.push({ index, reason: 'NON_ATOMIC_EVIDENCE' });
      continue;
    }
    const sourceRole = evidenceRole(text, start, end);
    if (proposal.source_role !== sourceRole
      || (semanticType === 'CUSTOMER_OBSERVATION' && sourceRole !== 'CUSTOMER')
      || (TECHNICIAN_ONLY_TYPES.has(semanticType) && sourceRole === 'CUSTOMER')) {
      rejections.push({ index, reason: 'SOURCE_ROLE_MISMATCH' });
      continue;
    }
    const temporality = evidenceTemporality(quote);
    if (proposal.temporality !== temporality
      || (['COMPLETED_ACTION', 'PART_USED'].includes(semanticType) && temporality !== 'CURRENT')) {
      rejections.push({ index, reason: 'TEMPORALITY_MISMATCH' });
      continue;
    }
    if (semanticType === 'TEST_OUTCOME'
      && (!/\b(?:pass(?:ed)?|fail(?:ed)?|normal|abnormal|successful|unsuccessful|within\s+(?:specification|spec|limits|range))\b/iu.test(quote)
        || !hasTestContext(text, start, end, captureContext))) {
      rejections.push({ index, reason: 'SEMANTIC_TYPE_MISMATCH' });
      continue;
    }
    if (semanticType === 'TEST_OUTCOME'
      && /\b(?:not|never|didn['’]?t|wasn['’]?t|weren['’]?t)\s+(?:(?:actually|fully|successfully)\s+){0,2}(?:pass(?:ed)?|fail(?:ed)?|normal|abnormal|successful|unsuccessful)\b/iu.test(quote)) {
      rejections.push({ index, reason: 'NEGATED_OUTCOME' });
      continue;
    }
    if (semanticType === 'TEST_ACTION'
      && !/\b(?:tested|testing|verified|ran\s+.{0,60}\btest|performed\s+.{0,60}\btest)\b/iu.test(quote)) {
      rejections.push({ index, reason: 'SEMANTIC_TYPE_MISMATCH' });
      continue;
    }
    if (semanticType === 'INSPECTION_FINDING'
      && !/\b(?:found|observed|identified|detected)\b/iu.test(quote)
      && (/^\s*(?:(?:I|we)\s+)?(?:did|inspected|checked|tested|verified|replaced|installed|repaired|reseated|secured|sealed|cleared|cleaned|adjusted|lubricated|reset|removed|refitted|restored|completed|fixed|changed)\b/iu.test(quote)
        || /\b(?:was|were)\s+(?:replaced|installed|repaired|reseated|secured|sealed|cleared|cleaned|adjusted|lubricated|reset|removed|refitted|restored|tested|verified)\b/iu.test(quote))) {
      rejections.push({ index, reason: 'SEMANTIC_TYPE_MISMATCH' });
      continue;
    }
    if ((semanticType === 'COMPLETED_ACTION'
        && !/\b(?:replaced|installed|repaired|reseated|secured|sealed|cleared|cleaned|adjusted|lubricated|reset|removed|refitted|restored|completed|fixed|changed|did)\b/iu.test(quote))
      || (semanticType === 'PART_USED' && claimKind === 'VALUE'
        && !/\b(?:replaced|installed|refitted|fitted|used)\b/iu.test(quote))) {
      rejections.push({ index, reason: 'SEMANTIC_TYPE_MISMATCH' });
      continue;
    }
    facts.push(Object.freeze({
      fact_id: `fact_${stableId({ transcript_id: transcriptId, semantic_type: semanticType, value: normalizedValue, char_start: start, char_end: end, claim_kind: claimKind })}`,
      semantic_type: semanticType,
      value: normalizedValue,
      claim_kind: claimKind,
      source_role: sourceRole,
      temporality,
      transcript_id: String(transcriptId || ''),
      segment_ids: [`proposal_${stableId({ transcript_id: transcriptId, start, end })}`],
      char_start: start,
      char_end: end,
      evidence_quote: quote,
      support_status: 'CONFIRMED_BY_EVIDENCE',
      scope_id: String(scopeId || ''),
      capture_context: captureContext ? structuredClone(captureContext) : null,
      attributes: Object.freeze({}),
    }));
  }
  return { facts, rejections };
}

const EXTRACTION_SYSTEM = [
  'Identify atomic facts explicitly supported by the technician transcript. Return one JSON object with a facts array, or an empty facts array when uncertain.',
  'Do not write a report or choose report fields. A sentence with multiple claims needs separate small evidence spans, one per fact.',
  'Each fact requires semantic_type, extractive value, source_role (TECHNICIAN or CUSTOMER), temporality (CURRENT or FUTURE),',
  'claim_kind (VALUE or EXPLICIT_NONE), char_start, char_end, and evidence_quote. Use VALUE for every positive stated fact with a non-null value.',
  'Use EXPLICIT_NONE only when the technician explicitly says no parts were used or no follow-up is required, and set value to null. Offsets are JavaScript UTF-16 character offsets into raw_text;',
  'evidence_quote must equal raw_text.slice(char_start, char_end) exactly. Values must use words actually present in the evidence quote.',
  'Customer reports are not technician findings. A test action is not a test outcome. Mentioned, negated, or future parts are not parts used.',
  'Never infer a passed test from an action or a failed test from a failed component. Abstain instead of guessing.',
].join(' ');

const FACT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    facts: {
      type: 'array', maxItems: 80,
      items: {
        type: 'object',
        properties: {
          semantic_type: { type: 'string', enum: SEMANTIC_TYPES },
          value: { type: ['string', 'null'] },
          claim_kind: { type: 'string', enum: ['VALUE', 'EXPLICIT_NONE'] },
          source_role: { type: 'string', enum: ['TECHNICIAN', 'CUSTOMER'] },
          temporality: { type: 'string', enum: ['CURRENT', 'FUTURE', 'NEGATED'] },
          char_start: { type: 'integer', minimum: 0 },
          char_end: { type: 'integer', minimum: 1 },
          evidence_quote: { type: 'string', minLength: 1 },
        },
        required: ['semantic_type', 'value', 'claim_kind', 'source_role', 'temporality', 'char_start', 'char_end', 'evidence_quote'],
      },
    },
  },
  required: ['facts'],
});

export async function proposeStructuredAtomicFacts({
  provider,
  model,
  scope_id: scopeId,
  transcript_id: transcriptId,
  raw_text: rawText,
  capture_context: captureContext = null,
  signal,
} = {}) {
  if (!provider?.generateJson || !model || !String(rawText || '').trim()) {
    return { facts: [], rejections: [], provider: null, skipped: 'NO_PROVIDER_MODEL_OR_TEXT' };
  }
  let response;
  try {
    response = await provider.generateJson({
      model,
      system: EXTRACTION_SYSTEM,
      formatSchema: FACT_OUTPUT_SCHEMA,
      prompt: JSON.stringify({
        raw_text: rawText,
        scope_id: scopeId,
        capture_context: captureContext,
        semantic_types: SEMANTIC_TYPES,
        output_keys: ['facts'],
        required_fact_keys: ['semantic_type', 'value', 'claim_kind', 'source_role', 'temporality', 'char_start', 'char_end', 'evidence_quote'],
      }),
      signal,
    });
  } catch (error) {
    return { facts: [], rejections: [{ index: -1, reason: 'PROVIDER_ERROR' }], provider: null, provider_error: error?.code || 'PROVIDER_ERROR' };
  }
  const proposals = response?.data?.facts;
  if (!Array.isArray(proposals) || proposals.length > 80) {
    return {
      facts: [], rejections: [{ index: -1, reason: 'MALFORMED_PROVIDER_OUTPUT' }],
      provider: response?.provider || null,
    };
  }
  return {
    ...verifyStructuredFactProposals({
      scope_id: scopeId, transcript_id: transcriptId, raw_text: rawText,
      proposals, capture_context: captureContext,
    }),
    provider: response?.provider || null,
    model: response?.model || model,
  };
}
