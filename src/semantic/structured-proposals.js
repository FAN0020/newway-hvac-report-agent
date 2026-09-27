import crypto from 'node:crypto';
import { SEMANTIC_TYPES } from './atomic-facts.js';
import { identifierIsCertain } from './identifier-certainty.js';

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
  if (/\b(?:the\s+)?customer\s+(?:said|reported|complained)\s*$/iu.test(context)) role = 'CUSTOMER';
  return role;
}

function evidenceTemporality(quote) {
  if (/\b(?:recommend(?:ed|ing)?|suggest(?:ed|ing)?|should|will|planned?\s+to|next\s+(?:visit|service)|later|in\s+future)\b/iu.test(quote)) return 'FUTURE';
  if (/\b(?:not|never|didn['’]?t|wasn['’]?t|weren['’]?t)\s+(?:(?:actually|yet|fully|today)\s+){0,2}(?:replac\w*|install\w*|us(?:e|ed|ing)|chang\w*|repair\w*|perform\w*|complet\w*|fit(?:ted)?|test\w*)\b/iu.test(quote)) return 'NEGATED';
  return 'CURRENT';
}

function nonAtomicEvidence(quote) {
  const withoutTrailingPunctuation = quote.replace(/[.!?;\s]+$/u, '');
  if (/^[^.!?;\n]+,\s*(?:the\s+)?customer\s+(?:said|reported|complained)$/iu.test(withoutTrailingPunctuation)) return false;
  return /[.!?;\n]\s*\S/u.test(withoutTrailingPunctuation)
    || /,\s*(?:(?:and|but|so)\s+)?(?:I|we|it|both|(?:the\s+)?customer|(?:the\s+)?test|(?:the\s+)?job|(?:the\s+)?completion|replaced|installed|repaired|tested|checked|verified|passed|failed)\b/iu.test(quote);
}

function hasTestContext(text, start, end, captureContext) {
  if (/(?:^|\.)(?:test_results|result)$/u.test(String(captureContext?.target_field_id || ''))) return true;
  const prior = text.slice(0, start);
  const boundary = Math.max(prior.lastIndexOf('.'), prior.lastIndexOf('!'), prior.lastIndexOf('?'), prior.lastIndexOf('\n'));
  const sentence = text.slice(boundary + 1, end);
  if (/\b(?:test(?:ed|ing|s)?|result|post[- ]?work|cycles?|verification)\b/iu.test(sentence)) return true;
  const outcome = text.slice(start, end);
  const recent = text.slice(Math.max(0, start - 160), start);
  if (/^\s*(?:it|they|both)\s+(?:passed|failed)\b/iu.test(outcome)
    && /\b(?:test(?:ed|ing|s)?|cycles?|verification)\b[\s\S]{0,140}\b(?:after|then|retest(?:ed)?|again)\b/iu.test(recent)) return true;
  const earlier = prior.slice(0, boundary);
  const previousBoundary = Math.max(earlier.lastIndexOf('.'), earlier.lastIndexOf('!'), earlier.lastIndexOf('?'), earlier.lastIndexOf('\n'));
  const previous = prior.slice(previousBoundary + 1, boundary).toLocaleLowerCase();
  const namedOutcome = /^\s*(?:the\s+)?([\p{L}][\p{L}-]{1,30})\s+(?:was|is)\s+(?:normal|abnormal|within\s+(?:specification|spec|limits|range))\b/iu.exec(outcome);
  if (namedOutcome && !/\b(?:no\s+test|test\s+(?:not|wasn['’]?t)\s+performed)\b/iu.test(previous)) {
    const subject = namedOutcome[1].toLocaleLowerCase();
    if (previous.includes(`${subject} test`) || previous.includes(`test ${subject}`)) return true;
  }
  if (!/^\s*(?:it|both|they|passed|failed)\b/iu.test(text.slice(start, end))) return false;
  // A bare outcome word is supported by a preceding test only when it closes
  // its own clause and that test was in the immediately preceding sentence.
  if (text.slice(end).match(/^[^.!?;\n]*/u)?.[0].trim()) return false;
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
    return /\b(?:equipment|asset|fleet|registration|station|chainage|location)\b|\b(?:unit|bus|line)\s+[A-Z0-9]|\b[A-Z0-9][A-Z0-9-]*\s+(?:is|was)\s+(?:the\s+)?(?:unit|bus|asset)\b/iu.test(quote)
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
    if (['WORK_ORDER', 'EQUIPMENT_OR_ASSET'].includes(semanticType)
      && !identifierIsCertain(text, start, end)) {
      rejections.push({ index, reason: 'UNCERTAIN_IDENTIFIER' });
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
    if ((proposal.source_role && proposal.source_role !== sourceRole)
      || (semanticType === 'CUSTOMER_OBSERVATION' && sourceRole !== 'CUSTOMER')
      || (TECHNICIAN_ONLY_TYPES.has(semanticType) && sourceRole === 'CUSTOMER')) {
      rejections.push({ index, reason: 'SOURCE_ROLE_MISMATCH' });
      continue;
    }
    const temporality = evidenceTemporality(quote);
    if ((proposal.temporality && proposal.temporality !== temporality)
      || (['COMPLETED_ACTION', 'PART_USED'].includes(semanticType) && temporality !== 'CURRENT')) {
      rejections.push({ index, reason: 'TEMPORALITY_MISMATCH' });
      continue;
    }
    if (semanticType === 'COMPLETION_STATE'
      && !/\b(?:completion\s+status|final\s+condition|return\s+to\s+service|handover\s+status|ready\s+(?:for|to)\s+service)\b/iu.test(quote)) {
      rejections.push({ index, reason: 'COMPLETION_STATUS_NOT_STATED' });
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

const FIELD_CUE_STOP_WORDS = new Set(['asset', 'work', 'report', 'field', 'the', 'and', 'for', 'of', 'to', 'a', 'id', 'number']);
const PROTECTED_FIELD = /^(?:work_order$|work\.(?:work_order_id|order_id)$|equipment$|asset\.(?:internal_fleet_no|registration_no|bus_model)$|customer_complaint$|inspection_findings$|diagnosis\.root_cause$|completion\.|completion_status$|test\.|test_results$|parts\.|parts_used$|work_performed$|check\.|handover\.)/u;

function cueToken(token) {
  const lower = token.toLocaleLowerCase();
  return lower.replace(/(?:ing|ed|es|s)$/u, '');
}

function fieldCues(field) {
  const aliases = field.id === 'work.trigger' ? 'fault' : '';
  return new Set(words(`${field.id.replaceAll(/[._]/gu, ' ')} ${field.label || ''} ${aliases}`)
    .map(cueToken).filter((token) => token.length > 3 && !FIELD_CUE_STOP_WORDS.has(token)));
}

export function extractCuedFieldAssignments({ template, raw_text: rawText } = {}) {
  const text = String(rawText || '');
  const proposals = [];
  const fields = (template?.schema?.fields || []).filter((field) => !field.id.includes('*')
    && !PROTECTED_FIELD.test(field.id) && ['string', 'text'].includes(field.type));
  const allCues = [...new Set(fields.flatMap((field) => [...fieldCues(field)]))];
  const nextField = allCues.length
    ? new RegExp(`\\s*,?\\s*(?:and|but|then|so)\\s+(?=(?:the\\s+)?(?:${allCues.join('|')})(?:s|ed|ing)?\\s+(?:is|was|are|were|by|:|=)\\b)`, 'iu')
    : null;
  for (const segment of text.matchAll(/[^.!?;\n]+/gu)) {
    const clause = segment[0].trim();
    if (!clause || evidenceTemporality(clause) !== 'CURRENT' || /\b(?:not|never|no|unknown|unclear|unconfirmed|suspected|mentioned)\b/iu.test(clause)) continue;
    for (const field of fields) {
      const cues = [...fieldCues(field)];
      for (const cue of cues) {
        const pattern = new RegExp(`\\b${cue}(?:s|ed|ing)?\\b\\s*(?:(?:is|was|are|were|:|=)\\s*|(?:by|due\\s+to)\\s+)`, 'iu');
        const match = pattern.exec(clause);
        if (!match) continue;
        const valueStart = match.index + match[0].length;
        const remaining = clause.slice(valueStart);
        const boundary = nextField?.exec(remaining)?.index ?? remaining.length;
        const value = remaining.slice(0, boundary).trim();
        if (!value || words(value).length > 12) continue;
        proposals.push({ field_id: field.id, value, evidence_quote: clause.slice(match.index, valueStart + boundary).trim() });
        break;
      }
    }
  }
  return verifySchemaFieldProposals({ template, raw_text: text, proposals });
}

export function verifySchemaFieldProposals({ template, raw_text: rawText, proposals = [] } = {}) {
  const text = String(rawText || '');
  const fields = (template?.schema?.fields || []).filter((field) => !field.id.includes('*'));
  const assignments = [];
  const rejections = [];
  for (const [index, proposal] of (Array.isArray(proposals) ? proposals : []).entries()) {
    const field = fields.find((item) => item.id === proposal?.field_id);
    const quote = proposal?.evidence_quote;
    const value = proposal?.value;
    const start = typeof quote === 'string' ? text.indexOf(quote) : -1;
    if (!field || PROTECTED_FIELD.test(field.id) || !['string', 'text'].includes(field.type)
      || Array.isArray(field.allowedValues) || Array.isArray(field.allowedStatuses)
      || typeof quote !== 'string' || !quote.trim() || start < 0 || text.indexOf(quote, start + 1) >= 0
      || typeof value !== 'string' || !value.trim()) {
      rejections.push({ index, reason: 'INVALID_OR_PROTECTED_FIELD_PROPOSAL' });
      continue;
    }
    if (!lexicallyGrounded(value, quote) || nonAtomicEvidence(quote)
      || evidenceTemporality(quote) !== 'CURRENT'
      || /\b(?:not|never|no|didn['’]?t|wasn['’]?t|isn['’]?t|unknown|unclear|unconfirmed|suspected|mentioned)\b/iu.test(quote)) {
      rejections.push({ index, reason: 'UNSUPPORTED_FIELD_VALUE' });
      continue;
    }
    const quoteWords = new Set(words(quote).map(cueToken));
    const cues = fieldCues(field);
    const matched = [...cues].filter((cue) => quoteWords.has(cue));
    if (!matched.length || matched.some((cue) => fields.some((other) => other.id !== field.id && fieldCues(other).has(cue)))) {
      rejections.push({ index, reason: 'AMBIGUOUS_OR_MISSING_FIELD_CUE' });
      continue;
    }
    assignments.push({
      field_id: field.id, value: value.trim(), claim_kind: 'VALUE', support_status: 'CONFIRMED_BY_EVIDENCE',
      semantic_type: 'SCHEMA_FIELD_VALUE', source_span: { start, end: start + quote.length, text: quote },
      extraction_method: 'structured-schema-field-proposal',
      critical: Boolean(field.critical || field.requiresTechnicianConfirmation),
    });
  }
  return { assignments, rejections };
}

const EXTRACTION_SYSTEM = [
  'Extract atomic facts and schema-specific values from messy, out-of-order technician speech. Return JSON with facts and field_values arrays, empty when nothing is reliable.',
  'For each fact return semantic_type, an extractive value, claim_kind, and evidence_quote. For explicit template-specific blanks not covered by a semantic fact, return field_id, extractive value, and evidence_quote in field_values.',
  'The evidence_quote must be an exact short contiguous substring of raw_text. Copy its spelling and punctuation exactly. The value must use only words present in that quote.',
  'Use separate short quotes for separate claims even when they occur in one sentence. Do not copy a whole multi-fact narration into one fact.',
  'Classify work orders, assets, customer observations, technician findings, completed actions, used parts, measurements, test actions, test outcomes, completion states, recommendations and follow-up separately.',
  'A fragment can still be meaningful: "AC-104 is the unit" is equipment; "Room felt warm, customer said" is a customer observation; "Testing after seal, passed" contains a test outcome "passed".',
  'Use VALUE with a non-null value for stated facts. Use EXPLICIT_NONE with null only for explicit no parts used or no follow-up required.',
  'A customer report is not a technician finding. A test action is not a passed result. Mentioned, negated or future parts are not used parts.',
  'Never guess an unclear identifier, invent an action or result, or turn an earlier failure into a later pass. Abstain when unsupported.',
  'Only raw_text is evidence; scope and schema metadata are not spoken facts. Do not output one fact per semantic type. EXPLICIT_NONE requires null and is only for explicitly no parts used or no follow-up.',
  'Use only field IDs supplied in template_fields. Match the meaning of the spoken phrase to the field label. For example "triggered by a faulty sensor" can fill a Trigger / fault field with "a faulty sensor". Never infer return-to-service or test success from work merely being finished.',
  'Do not invent clock times in field_values. The server separately handles phrases such as "finished today" using the recording time and marks the derived time for technician review.',
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
          evidence_quote: { type: 'string', minLength: 1 },
        },
        required: ['semantic_type', 'value', 'claim_kind', 'evidence_quote'],
      },
    },
    field_values: {
      type: 'array', maxItems: 80,
      items: {
        type: 'object',
        properties: {
          field_id: { type: 'string' }, value: { type: 'string' }, evidence_quote: { type: 'string', minLength: 1 },
        },
        required: ['field_id', 'value', 'evidence_quote'],
      },
    },
  },
  required: ['facts', 'field_values'],
});

export async function proposeStructuredAtomicFacts({
  provider,
  model,
  scope_id: scopeId,
  transcript_id: transcriptId,
  raw_text: rawText,
  capture_context: captureContext = null,
  template = null,
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
        capture_context: captureContext,
        template_fields: (template?.schema?.fields || []).filter((field) => !field.id.includes('*'))
          .map((field) => ({ id: field.id, label: field.label, type: field.type, allowedValues: field.allowedValues || field.allowedStatuses || null })),
        output_keys: ['facts', 'field_values'],
        required_fact_keys: ['semantic_type', 'value', 'claim_kind', 'evidence_quote'],
      }),
      signal,
    });
  } catch (error) {
    return { facts: [], rejections: [{ index: -1, reason: 'PROVIDER_ERROR' }], provider: null, provider_error: error?.code || 'PROVIDER_ERROR' };
  }
  const proposals = response?.data?.facts;
  const fieldProposals = response?.data?.field_values ?? [];
  if (!Array.isArray(proposals) || proposals.length > 80 || !Array.isArray(fieldProposals) || fieldProposals.length > 80) {
    return {
      facts: [], rejections: [{ index: -1, reason: 'MALFORMED_PROVIDER_OUTPUT' }],
      provider: response?.provider || null,
    };
  }
  const verifiedFacts = verifyStructuredFactProposals({
      scope_id: scopeId, transcript_id: transcriptId, raw_text: rawText,
      proposals, capture_context: captureContext,
    });
  const verifiedFields = verifySchemaFieldProposals({ template, raw_text: rawText, proposals: fieldProposals });
  return {
    facts: verifiedFacts.facts,
    field_assignments: verifiedFields.assignments,
    rejections: [...verifiedFacts.rejections, ...verifiedFields.rejections.map((item) => ({ ...item, kind: 'FIELD_VALUE' }))],
    provider: response?.provider || null,
    model: response?.model || model,
  };
}
