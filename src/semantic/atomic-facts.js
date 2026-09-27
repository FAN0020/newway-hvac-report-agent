import crypto from 'node:crypto';
import { identifierIsCertain } from './identifier-certainty.js';

export const ATOMIC_FACTS_VERSION = 'atomic-facts.v8';

export const SEMANTIC_TYPES = Object.freeze([
  'WORK_ORDER',
  'EQUIPMENT_OR_ASSET',
  'ASSET_IDENTITY',
  'ROUTE_IDENTITY',
  'LOCATION',
  'TECHNICIAN_IDENTITY',
  'CUSTOMER_OBSERVATION',
  'CUSTOMER_COMPLAINT',
  'INSPECTION_FINDING',
  'ROOT_CAUSE',
  'COMPLETED_ACTION',
  'PART_USED',
  'PART_REFERENCE',
  'MEASUREMENT',
  'TEST_ACTION',
  'TEST_MEASUREMENT',
  'TEST_OUTCOME',
  'TEST_OBSERVATION',
  'TEMPORAL_REFERENCE',
  'COMPLETION_STATE',
  'RECOMMENDATION',
  'FOLLOW_UP',
]);

const ACTION_VERBS = 'cleared|replaced|installed|repaired|reseated|secured|sealed|tightened|cleaned|adjusted|lubricated|reset|removed|refitted|restored|completed|did';
const TEST_VERBS = 'tested|verified|ran';
const TECHNICIAN_OWNED_FACTS = new Set([
  'INSPECTION_FINDING', 'COMPLETED_ACTION', 'PART_USED', 'MEASUREMENT',
  'TEST_ACTION', 'TEST_OUTCOME', 'COMPLETION_STATE', 'RECOMMENDATION', 'FOLLOW_UP',
]);

function normalize(value) {
  return String(value || '').trim().replace(/[.,;:!?]+$/u, '').replace(/\s+/gu, ' ');
}

function lowerInitial(value) {
  const text = normalize(value);
  return text ? `${text[0].toLocaleLowerCase()}${text.slice(1)}` : text;
}

function stableId(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function sentences(rawText) {
  const result = [];
  const matcher = /[^.!?\n]+(?:[.!?]+|$)/gu;
  for (const match of rawText.matchAll(matcher)) {
    const leading = match[0].search(/\S/u);
    if (leading < 0) continue;
    const trailing = match[0].match(/\s*$/u)?.[0].length || 0;
    const start = match.index + leading;
    const end = match.index + match[0].length - trailing;
    result.push({ text: rawText.slice(start, end), start, end });
  }
  return result;
}

// A punctuation-delimited sentence can contain several different job claims. Keep
// offsets in the original transcript while separating independent predicates.
function clauses(rawText) {
  const result = [];
  const boundary = /(?:[,;]\s*(?:(?:and|but|so)\s+)?|\s+\b(?:and|but|so)\s+)(?=(?:I|we|my|it|both|customer|the customer|the job|completion|the completion|test|the test|no follow[- ]?up|nothing else|recommend(?:ed)?|suggest(?:ed)?|replaced|installed|repaired|reseated|secured|sealed|tightened|cleared|cleaned|adjusted|lubricated|reset|removed|refitted|restored|did|tested|checked|verified|ran|passed|failed)\b)/giu;
  for (const sentence of sentences(rawText)) {
    let cursor = 0;
    let speaker = /^(?:the\s+)?customer\s+(?:reported|complained|said)\b/iu.test(sentence.text) ? 'CUSTOMER' : 'TECHNICIAN';
    const push = (start, end) => {
      const piece = sentence.text.slice(start, end);
      const leading = piece.search(/\S/u);
      if (leading < 0) return;
      const trailing = piece.match(/\s*$/u)?.[0].length || 0;
      const charStart = sentence.start + start + leading;
      const charEnd = sentence.start + end - trailing;
      const text = rawText.slice(charStart, charEnd);
      if (/^(?:I|we|my|no\s+follow[- ]?up|nothing\s+else)\b/iu.test(text)) speaker = 'TECHNICIAN';
      if (/^(?:the\s+)?customer\b/iu.test(text)) speaker = 'CUSTOMER';
      result.push({ text, start: charStart, end: charEnd, sourceRole: speaker });
    };
    for (const match of sentence.text.matchAll(boundary)) {
      push(cursor, match.index);
      cursor = match.index + match[0].length;
    }
    push(cursor, sentence.text.length);
  }
  return result;
}

function trimCaptured(value) {
  return normalize(String(value || '')
    .replace(/^(?:that\s+)/iu, '')
    .replace(/\s+(?:and|so)\s+(?=(?:I|we|it|the|both|then)\b)/iu, ''));
}

function antecedentObject(facts) {
  const prior = [...facts].reverse().find((fact) => ['INSPECTION_FINDING', 'COMPLETED_ACTION'].includes(fact.semantic_type));
  if (!prior) return null;
  const value = String(prior.value || '');
  const findingObject = value.match(/^(?:a|an|the)\s+(.+)$/iu);
  if (findingObject) return `the ${findingObject[1]
    .replace(/^(?:blocked|loose|leaking|damaged|failed|faulty)\s+/iu, '')
    .replace(/\s+(?:was|is)\s+(?:blocked|loose|leaking|damaged|failed|faulty)$/iu, '')}`;
  const actionObject = value.match(new RegExp(`^(?:${ACTION_VERBS})\\s+(.+)$`, 'iu'));
  return actionObject ? actionObject[1] : value;
}

function resolvePronouns(value, facts) {
  const prior = antecedentObject(facts);
  if (!prior) return value;
  return value.replace(/\b(?:it|that)\b/iu, prior);
}

export async function extractAtomicFacts({ scope_id: scopeId, raw_text: rawText, transcript_id: transcriptId,
  capture_context: captureContext = null, assertions = null } = {}) {
  const text = String(rawText || '');
  if (!text.trim()) return [];
  const facts = [];
  const seen = new Set();

  const add = ({ semanticType, value, unit, match, sentence, claimKind = 'VALUE', temporality = 'CURRENT', sourceRole = 'TECHNICIAN', attributes = {} }) => {
    if (!match) return;
    if (sentence.sourceRole !== 'TECHNICIAN' && TECHNICIAN_OWNED_FACTS.has(semanticType)) return;
    const start = sentence.start + match.index;
    const quote = match[0];
    const end = start + quote.length;
    if (['WORK_ORDER', 'EQUIPMENT_OR_ASSET'].includes(semanticType)
      && !identifierIsCertain(text, start, end)) return;
    const normalizedValue = claimKind === 'VALUE' ? normalize(value) : null;
    if (claimKind === 'VALUE' && !normalizedValue) return;
    const key = JSON.stringify([semanticType, normalizedValue, unit || null, start, end, claimKind]);
    if (seen.has(key)) return;
    seen.add(key);
    const identity = { version: ATOMIC_FACTS_VERSION, transcript_id: transcriptId, semantic_type: semanticType,
      value: normalizedValue, unit: unit || null, char_start: start, char_end: end, claim_kind: claimKind };
    facts.push(Object.freeze({
      fact_id: `fact_${stableId(identity)}`,
      semantic_type: semanticType,
      value: normalizedValue,
      ...(unit ? { unit } : {}),
      claim_kind: claimKind,
      source_role: sourceRole,
      temporality: semanticType === 'COMPLETED_ACTION' && temporality === 'CURRENT' ? 'COMPLETED' : temporality,
      transcript_id: String(transcriptId || ''),
      segment_ids: [`clause_${stableId({ transcript_id: transcriptId, start: sentence.start, end: sentence.end })}`],
      char_start: start,
      char_end: end,
      evidence_quote: quote,
      support_status: 'CONFIRMED_BY_EVIDENCE',
      scope_id: String(scopeId || ''),
      capture_context: captureContext ? structuredClone(captureContext) : null,
      attributes: Object.freeze({ ...attributes }),
    }));
  };

  for (const sentence of Array.isArray(assertions)
    ? assertions.map((assertion) => ({ ...assertion, start: assertion.start, end: assertion.end,
      sourceRole: assertion.actor === 'TECHNICIAN' ? 'TECHNICIAN' : assertion.actor }))
    : clauses(text)) {
    const body = sentence.text;
    const customerSpeech = sentence.sourceRole !== 'TECHNICIAN';
    let match;

    match = /\bwork\s+order(?:\s+(?:number|no\.?))?\s*(?:is|was|:|#)?\s*([A-Z0-9-]+)/iu.exec(body);
    if (match) add({ semanticType: 'WORK_ORDER', value: match[1], match, sentence, attributes: { identifier_kind: 'WORK_ORDER' } });

    match = /\btechnician\s+(?:is\s+)?([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)(?=\s+(?:and|with|for)\b|[.,;!?]|$)/iu.exec(body);
    if (match) add({ semanticType: 'TECHNICIAN_IDENTITY', value: match[1], match, sentence, attributes: { identifier_kind: 'TECHNICIAN' } });

    match = /\bequipment(?:\s+(?:needed|required))?\s*(?:is|was|:)?\s*([A-Z0-9][A-Z0-9._/-]*)/iu.exec(body);
    if (match) add({ semanticType: 'EQUIPMENT_OR_ASSET', value: match[1], match, sentence, attributes: { identifier_kind: 'EQUIPMENT' } });
    match = /\bunit\s+([A-Z]{1,8}[ -]?\d+[A-Z0-9-]*)\b/iu.exec(body);
    if (match) add({ semanticType: 'EQUIPMENT_OR_ASSET', value: match[1], match, sentence, attributes: { identifier_kind: 'EQUIPMENT' } });

    match = /\bbus\s+(.+?)\s+had\s+.+?(?=[.!?]|$)/iu.exec(body)
      || /\bbus\s+(.+?)(?=\s+(?:has|with|was|is)\b|[.,;!?]|$)/iu.exec(body);
    if (match) {
      const identifier = normalize(match[1]);
      const identifierKind = /^SG\d+[A-Z]$/iu.test(identifier)
        ? 'REGISTRATION'
        : /^(?:MAN|VOLVO|SCANIA|MERCEDES|BYD)\s+[A-Z0-9]+$/iu.test(identifier)
          ? 'MODEL'
          : /^\d+$/u.test(identifier) ? 'FLEET' : null;
      if (identifierKind) add({ semanticType: 'EQUIPMENT_OR_ASSET', value: identifier, match, sentence, attributes: { identifier_kind: identifierKind, critical: identifierKind === 'REGISTRATION' } });
    }
    match = /\bfleet(?:\s+(?:number|no\.?|id))?\s*(?:is|was|:|#)?\s*([A-Z0-9-]+)/iu.exec(body);
    if (match) add({ semanticType: 'EQUIPMENT_OR_ASSET', value: match[1], match, sentence, attributes: { identifier_kind: 'FLEET' } });
    match = /\bregistration(?:\s+(?:number|no\.?))?\s*(?:is|was|:|#)?\s*([A-Z]{1,3}\d+[A-Z])/iu.exec(body);
    if (match) add({ semanticType: 'EQUIPMENT_OR_ASSET', value: match[1], match, sentence, attributes: { identifier_kind: 'REGISTRATION', critical: true } });

    match = /\b(?:the\s+)?customer\s+(?:reported|complained|said)(?:\s+that)?\s+(.+?)(?=[.;!?]|\s+(?:I|we)\s+(?:found|inspected|checked|repaired|replaced|cleared)\b|$)/iu.exec(body);
    if (match) add({ semanticType: 'CUSTOMER_OBSERVATION', value: trimCaptured(match[1]), match, sentence, sourceRole: 'CUSTOMER' });
    if (!match) {
      match = /\b(?:the\s+)?customer\s+had\s+(no\s+further\s+complaints)\b/iu.exec(body);
      if (match) add({ semanticType: 'CUSTOMER_OBSERVATION', value: lowerInitial(match[1]), match, sentence, sourceRole: 'CUSTOMER' });
    }
    if (!match) {
      match = /\b((?:passenger|front|rear)?\s*door\s+(?:would|will|does|did|could)\s+not\s+.+?)(?=[.;!?]|$)/iu.exec(body);
      if (match) add({ semanticType: 'CUSTOMER_OBSERVATION', value: trimCaptured(match[1]), match, sentence, sourceRole: 'UNATTRIBUTED' });
    }

    const found = /\b(?:I|we)?\s*(?:found|observed|identified|detected)\s+(.+?)(?=\s+(?:and|so)\s+(?:I|we)?\s*(?:cleared|replaced|installed|repaired|reseated|secured|tightened|tested|checked|verified|ran)\b|,\s*(?:I|we)\s+(?:cleared|replaced|installed|repaired|reseated|secured|tightened|tested|checked|verified|ran)\b|[.;!?]|$)/iu.exec(body);
    if (found && !customerSpeech && !/\bInspection\s+found\b/u.test(body)) add({ semanticType: 'INSPECTION_FINDING', value: trimCaptured(found[1]), match: found, sentence });
    match = /\bInspection\s+found\s+(.+?)(?=[.;!?]|$)/u.exec(body);
    if (match && !customerSpeech) add({ semanticType: 'INSPECTION_FINDING', value: normalize(match[0]), match, sentence });
    match = /\bBus\s+.+?\s+had\s+(.+?)(?=[.;!?]|$)/iu.exec(body);
    if (match && !customerSpeech) add({ semanticType: 'INSPECTION_FINDING', value: normalize(match[0]), match, sentence });
    if (!found && !customerSpeech) {
      match = /\b(?:I|we)\s+(?:inspected|checked)\s+(.+?)(?=\s*[,;]|\s+and\s+(?:I|we)?\s*(?:replaced|installed|repaired|reseated|secured|cleared|tested|ran)\b|[.!?]|$)/iu.exec(body);
      if (match && !/^(?:bus\s+)?(?:line|route)\s+\d+\b/iu.test(trimCaptured(match[1]))) {
        add({ semanticType: 'INSPECTION_FINDING', value: trimCaptured(match[1]), match, sentence });
      }
    }

    match = /\b(?:recommend(?:ed)?|suggest(?:ed)?|should)\s+(?:to\s+)?(.+?)(?=[.;!?]|$)/iu.exec(body);
    if (match) {
      const recommended = trimCaptured(match[1]).replace(/^replacing\b/iu, 'replacing');
      add({ semanticType: 'RECOMMENDATION', value: recommended, match, sentence, temporality: 'FUTURE' });
    } else {
      match = /\b(replace|install|repair|check|inspect|test)\s+(.+?\b(?:next\s+(?:visit|week|service)|later|in\s+future))(?=[.;!?]|$)/iu.exec(body);
      if (match) add({ semanticType: 'RECOMMENDATION', value: lowerInitial(`${match[1]} ${match[2]}`), match, sentence, temporality: 'FUTURE' });
    }

    const negatedAction = new RegExp(`\\b(?:was|were|is|are|did|do|does|have|has|had)?\\s*(?:not|never|didn't|did not)\\s+(?:${ACTION_VERBS}|replace|install|change)\\b`, 'iu').test(body)
      || /\b(?:was|were|is|are)\s+not\s+(?:replaced|installed|repaired|changed)\b/iu.test(body);
    const futureAction = /\b(?:recommend|suggest|should|next\s+(?:visit|week|service)|later|in\s+future)\b/iu.test(body);
    if (!customerSpeech && !negatedAction && !futureAction) {
      const passiveActionPattern = new RegExp(`\\b(?:the\\s+)?(.+?)\\s+was\\s+(installed|replaced|repaired|reseated|secured|refitted)\\b`, 'igu');
      for (const action of body.matchAll(passiveActionPattern)) {
        const object = normalize(action[1]).replace(/^(?:the|a|an)\s+/iu, '');
        const verb = action[2].toLocaleLowerCase();
        add({ semanticType: 'COMPLETED_ACTION', value: `${verb} ${object}`, match: action, sentence, attributes: { action_verb: verb, voice: 'PASSIVE' } });
        if (['installed', 'replaced', 'refitted'].includes(verb)) add({ semanticType: 'PART_USED', value: object, match: action, sentence, attributes: { action_verb: verb, voice: 'PASSIVE' } });
      }
      const actionPattern = new RegExp(`\\b(?:I|we)\\s+(${ACTION_VERBS})\\s+(.+?)(?=\\s*[,;]|\\s+and\\s+(?:(?:I|we|it|the|both)\\s+)?(?:${ACTION_VERBS}|${TEST_VERBS}|pass(?:ed)?|fail(?:ed)?)\\b|[.!?]|$)`, 'igu');
      for (const action of body.matchAll(actionPattern)) {
        let object = trimCaptured(action[2]);
        const verb = action[1].toLocaleLowerCase();
        object = resolvePronouns(object, facts);
        if (verb === 'did' && /^not\b/iu.test(object)) continue;
        const value = verb === 'did' ? object : `${verb} ${object}`;
        add({ semanticType: 'COMPLETED_ACTION', value, match: action, sentence, attributes: { action_verb: verb } });
        if (['replaced', 'installed', 'refitted'].includes(verb)) {
          const part = object
            .replace(/^(?:one|two|three|a|an)\s+/iu, '')
            .replace(/^the\s+(?=(?:leaking|damaged|failed|faulty)\b)/iu, '');
          add({ semanticType: 'PART_USED', value: part, match: action, sentence, attributes: { action_verb: verb } });
        }
      }
      const continuedActionPattern = new RegExp(`(?:,\\s*|\\band\\s+)(?:(?:I|we)\\s+)?(${ACTION_VERBS})\\s+(.+?)(?=\\s*[,;]|\\s+and\\s+(?:(?:I|we|it|the|both)\\s+)?(?:${ACTION_VERBS}|${TEST_VERBS}|pass(?:ed)?|fail(?:ed)?)\\b|[.!?]|$)`, 'igu');
      for (const action of body.matchAll(continuedActionPattern)) {
        const verb = action[1].toLocaleLowerCase();
        const object = resolvePronouns(trimCaptured(action[2]), facts);
        if (verb === 'did' && /^not\b/iu.test(object)) continue;
        const value = verb === 'did' ? object : `${verb} ${object}`;
        add({ semanticType: 'COMPLETED_ACTION', value, match: action, sentence, attributes: { action_verb: verb } });
        if (['replaced', 'installed', 'refitted'].includes(verb)) {
          const part = object
            .replace(/^(?:one|two|three|a|an)\s+/iu, '')
            .replace(/^the\s+(?=(?:leaking|damaged|failed|faulty)\b)/iu, '');
          add({ semanticType: 'PART_USED', value: part, match: action, sentence, attributes: { action_verb: verb } });
        }
      }
      const leadingAction = new RegExp(`^(?:okay,?\\s*)?(?:then\\s+)?(${ACTION_VERBS})\\s+(.+?)(?=\\s*[,;]|\\s+and\\s+(?:${TEST_VERBS}|pass(?:ed)?|fail(?:ed)?)\\b|[.!?]|$)`, 'iu').exec(body);
      if (leadingAction) {
        const verb = leadingAction[1].toLocaleLowerCase();
        const object = resolvePronouns(trimCaptured(leadingAction[2]), facts);
        if (verb === 'did' && /^not\b/iu.test(object)) continue;
        const value = verb === 'did' ? object : `${verb} ${object}`;
        add({ semanticType: 'COMPLETED_ACTION', value, match: leadingAction, sentence, attributes: { action_verb: verb } });
        if (['replaced', 'installed', 'refitted'].includes(verb)) add({
          semanticType: 'PART_USED',
          value: object.replace(/^(?:one|two|three|a|an)\s+/iu, '').replace(/^the\s+(?=(?:leaking|damaged|failed|faulty)\b)/iu, ''),
          match: leadingAction,
          sentence,
          attributes: { action_verb: verb },
        });
      }
    }

    for (const tested of customerSpeech ? [] : body.matchAll(/\b([\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*){0,3})\s+was\s+tested\b/igu)) {
      const object = normalize(tested[1]).replace(/^(?:the|a|an)\s+/iu, '');
      add({ semanticType: 'TEST_ACTION', value: `tested ${object}`, match: tested, sentence, attributes: { action_verb: 'tested', voice: 'PASSIVE' } });
    }
    const testPattern = new RegExp(`\\b(?:I|we)?\\s*(${TEST_VERBS})\\s+(.+?)(?=\\s+and\\s+(?:it|the|both)(?:\\s+(?:was|were|is))?\\s*(?:pass(?:ed)?|fail(?:ed)?|normal|okay|ok)\\b|[,.;!?]|$)`, 'igu');
    for (const tested of customerSpeech ? [] : body.matchAll(testPattern)) {
      const verb = tested[1].toLocaleLowerCase();
      const object = trimCaptured(tested[2]);
      add({ semanticType: 'TEST_ACTION', value: `${verb} ${object}`, match: tested, sentence, attributes: { action_verb: verb } });
    }

    const explicitTestContext = /\b(?:test(?:ed|ing|s)?|result|cycles?|post-work)\b/iu.test(body);
    const priorTestAction = [...facts].reverse().find((fact) => fact.semantic_type === 'TEST_ACTION');
    const standaloneOutcome = /^(?:(?:it|both|they)\s+(?:(?:was|were|is|are)\s+)?)?(?:passed|failed|normal|successful|unsuccessful)[.!?]*$/iu.test(body.trim());
    const adjacentToTest = priorTestAction
      && /^(?:[\s,.;!?]|\band\b)*$/iu.test(text.slice(priorTestAction.char_end, sentence.start));
    const impliedTestContext = standaloneOutcome && adjacentToTest;
    const targetedTestResult = captureContext?.target_field_id && /(?:^|\.)(?:test_results|result)$/u.test(captureContext.target_field_id);
    for (const outcome of customerSpeech || !(explicitTestContext || impliedTestContext || targetedTestResult)
      ? [] : body.matchAll(/\b(pass(?:ed)?|fail(?:ed)?|normal|successful|unsuccessful)\b/igu)) {
      const raw = outcome[1].toLocaleLowerCase();
      const before = body.slice(Math.max(0, outcome.index - 24), outcome.index);
      const negated = /\b(?:not|never|didn['’]?t|wasn['’]?t|weren['’]?t)\s*$/iu.test(before);
      if (negated && !raw.startsWith('pass')) continue;
      const value = negated ? 'failed' : raw.startsWith('pass') || ['normal', 'successful'].includes(raw) ? 'passed' : 'failed';
      add({ semanticType: 'TEST_OUTCOME', value, match: outcome, sentence });
    }

    for (const measured of body.matchAll(/\b(?:pressure\s+(?:measured|was)|measured\s+pressure\s+(?:at|of)?|pressure:)\s*([-+]?\d+(?:[.,]\d+)?)\s*(psi|kpa|bar|pa)\b/igu)) {
      add({ semanticType: 'MEASUREMENT', value: measured[1].replace(',', '.'), unit: measured[2].toLocaleLowerCase(), match: measured, sentence, attributes: { measurement_kind: 'pressure' } });
    }
    match = /\bodometer\s+(?:was|is|read(?:ing)?)\s*([-+]?\d+(?:[.,]\d+)?)\s*(km|mi|miles?)\b/iu.exec(body);
    if (match) add({ semanticType: 'MEASUREMENT', value: match[1].replace(',', '.'), unit: /^mi/iu.test(match[2]) ? 'mi' : 'km', match, sentence, attributes: { measurement_kind: 'odometer_km', critical: true } });

    match = /\b(?:completion\s+status|final\s+condition|return\s+to\s+service(?:\s+status)?)\s*(?:is|was|:)?\s*(done|complete(?:d)?|ready|not\s+ready|deferred|okay|ok)\b/iu.exec(body);
    if (match) add({ semanticType: 'COMPLETION_STATE', value: lowerInitial(match[1]), match, sentence });
    match = /\bbus\s+is\s+(?:okay|ok|ready)\s+to\s+return\s+to\s+service\b/iu.exec(body);
    if (match) add({ semanticType: 'COMPLETION_STATE', value: 'ready', match, sentence });
    match = /\bI['’]?m\s+done\s+with\s+bus\s+\d+\b/iu.exec(body);
    if (match) add({ semanticType: 'COMPLETION_STATE', value: 'done', match, sentence });
    match = /\b(?:the\s+)?job\s+is\s+(complete|completed|done)\b/iu.exec(body);
    if (match) add({ semanticType: 'COMPLETION_STATE', value: match[1].toLocaleLowerCase().replace('completed', 'complete'), match, sentence });
    if (captureContext?.capture_mode === 'FIELD_DICTATION'
      && /(?:^|\.)(?:completion_status|state)$/u.test(String(captureContext.target_field_id || ''))
      && /^(?:done|complete|completed|ready|not ready)[.!?]?$/iu.test(body.trim())) {
      add({ semanticType: 'COMPLETION_STATE', value: lowerInitial(body), match: { 0: body, index: 0 }, sentence });
    }

    match = /\bno\s+parts\s+(?:were\s+)?(?:used|changed)\b|\bdid(?:n't|\s+not)\s+(?:change|use|replace)\s+(?:any\s+)?parts\b/iu.exec(body);
    if (match) add({ semanticType: 'PART_USED', value: null, match, sentence, claimKind: 'EXPLICIT_NONE' });

    match = /\bdoor\s+control\s+module\s+faulty\b(?=\s+was\s+mentioned\b)/iu.exec(body);
    if (match) add({ semanticType: 'PART_REFERENCE', value: 'door control module', match, sentence, attributes: { reference_kind: 'MENTIONED_COMPONENT' } });

    match = /\bno\s+follow[- ]?up\s+(?:is\s+)?required\b|\bnothing\s+else\s+needed\b/iu.exec(body);
    if (match) add({ semanticType: 'FOLLOW_UP', value: null, match, sentence, claimKind: 'EXPLICIT_NONE' });
    match = /\bno\s+outstanding\s+(?:issues|items|defects)\b/iu.exec(body);
    if (match) add({ semanticType: 'FOLLOW_UP', value: null, match, sentence, claimKind: 'EXPLICIT_NONE', attributes: { follow_up_kind: 'OUTSTANDING_ISSUES' } });
  }

  return facts.filter((fact) => {
    if (fact.semantic_type !== 'INSPECTION_FINDING'
      || !/^\s*(?:I|we)\s+(?:checked|inspected)\b/iu.test(fact.evidence_quote)) return true;
    if (/^(?:it|this|that)$/iu.test(fact.value)) return false;
    return !facts.some((later) => later.semantic_type === 'INSPECTION_FINDING'
      && later.char_start >= fact.char_end && later.char_start - fact.char_end < 80
      && /^\s*(?:(?:I|we)\s+)?(?:found|observed|identified|detected)\b/iu.test(later.evidence_quote));
  }).sort((a, b) => a.char_start - b.char_start || a.semantic_type.localeCompare(b.semantic_type));
}
