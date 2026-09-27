// Only terminology in the active report context may supply replacement words.
// This deliberately does not infer facts or change values following field cues.
export const NORMALIZER_VERSION = 'contextual-transcript-normalization.v1';
const WORD = /[\p{L}][\p{L}\p{M}]*/gu;
const ASSIGNMENT = /^\s*(?:(?:is|was|are|were)\b|[:=])/iu;
const FACT_WORDS = new Set([
  'no', 'not', 'never', 'none', 'pass', 'passed', 'fail', 'failed', 'pending',
  'complete', 'completed', 'incomplete', 'replace', 'replaced', 'repair',
  'repaired', 'next', 'future', 'yesterday', 'today', 'tomorrow',
  'psi', 'bar', 'kpa', 'km', 'mm', 'cm', 'volt', 'volts', 'amp', 'amps',
]);

function words(text) {
  return [...String(text || '').matchAll(WORD)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

function distance(left, right) {
  const a = left.toLocaleLowerCase();
  const b = right.toLocaleLowerCase();
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

// A schema match alone cannot make a nearby English word a spelling error.
// Automatic changes are limited to recognizable omissions and STT letter
// confusions; other candidates remain raw for the existing review workflow.
function plausibleTerminologyError(original, replacement, edits) {
  const source = original.toLocaleLowerCase();
  const target = replacement.toLocaleLowerCase();
  if (edits === 1 && target.length === source.length + 1) {
    for (let index = 0; index < target.length; index += 1) {
      if (target.slice(0, index) + target.slice(index + 1) !== source) continue;
      const letter = target[index];
      if (/[aeiou]/u.test(letter) || letter === target[index - 1] || letter === target[index + 1]) return true;
    }
    return false;
  }
  if (edits === 1 && target.length === source.length) {
    const changed = [...source].findIndex((letter, index) => letter !== target[index]);
    return changed >= 0 && (source[changed] === 'x' && target[changed] === 'c'
      || source[changed] === 'z' && target[changed] === 's');
  }
  return edits <= 3 && source[0] === target[0] && source.at(-1) === target.at(-1)
    && source.includes('z') && target.includes('s')
    && distance(source.replaceAll('z', 's'), target) <= 2;
}

function contextualPhrases(template) {
  const phrases = [];
  for (const field of template?.schema?.fields || []) {
    const sources = [
      ['schema-field-label', field.label],
      ...(Array.isArray(field.aliases) ? field.aliases.map((alias) => ['schema-field-alias', alias]) : []),
      ['schema-field-description', field.description],
    ];
    for (const [contextSource, value] of sources) {
      const terms = words(value).map((word) => word.text);
      if (terms.length < 2 || terms.length > 4 || terms.some((term) => /^\d/u.test(term))) continue;
      phrases.push({ fieldId: field.id, contextSource, terms });
    }
  }
  return phrases;
}

function candidateForWindow(rawWords, phrase) {
  const changes = [];
  let exact = 0;
  for (let index = 0; index < phrase.terms.length; index += 1) {
    const original = rawWords[index].text;
    const replacement = phrase.terms[index];
    if (original.toLocaleLowerCase() === replacement.toLocaleLowerCase()) {
      exact += 1;
      continue;
    }
    const lowerOriginal = original.toLocaleLowerCase();
    const lowerReplacement = replacement.toLocaleLowerCase();
    if (FACT_WORDS.has(lowerOriginal) || FACT_WORDS.has(lowerReplacement)
      || original.length < 5 || replacement.length < 5) return null;
    const edits = distance(original, replacement);
    if (edits > 1 && !(edits <= 3 && lowerOriginal[0] === lowerReplacement[0]
      && lowerOriginal.at(-1) === lowerReplacement.at(-1))) return null;
    changes.push({ index, original, replacement, edits,
      eligible: plausibleTerminologyError(original, replacement, edits) });
  }
  if (!changes.length) return { ...phrase, changes };
  if (changes.some((change) => change.edits > 1) && exact === 0) return null;
  return { ...phrase, changes };
}

export function normalizeContextualTranscript({ rawText, template } = {}) {
  const text = String(rawText || '');
  const tokens = words(text);
  const phrases = contextualPhrases(template);
  const selected = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const matches = [];
    for (const phrase of phrases) {
      const window = tokens.slice(index, index + phrase.terms.length);
      if (window.length !== phrase.terms.length) continue;
      if (window.some((token, offset) => offset > 0 && !/^\s+$/u.test(text.slice(window[offset - 1].end, token.start)))) continue;
      if (!ASSIGNMENT.test(text.slice(window.at(-1).end))) continue;
      const candidate = candidateForWindow(window, phrase);
      if (candidate) matches.push({ ...candidate, window });
    }
    if (matches.some((match) => !match.changes.length)) continue;
    const distinct = new Map(matches.filter((match) => match.changes.length)
      .map((match) => [match.terms.join('\u0000').toLocaleLowerCase(), match]));
    if (distinct.size !== 1) continue; // Ambiguous active schema context: abstain.
    const [chosen] = distinct.values();
    if (chosen.changes.some((change) => !change.eligible)) continue;
    if (selected.some((item) => item.end > chosen.window[0].start)) continue;
    for (const change of chosen.changes) {
      const token = chosen.window[change.index];
      selected.push({
        start: token.start, end: token.end,
        original: change.original, replacement: change.replacement,
        fieldId: chosen.fieldId, contextSource: chosen.contextSource,
      });
    }
    index += chosen.window.length - 1;
  }
  let normalizedText = '';
  let cursor = 0;
  const corrections = [];
  for (const selectedChange of selected.sort((a, b) => a.start - b.start)) {
    normalizedText += text.slice(cursor, selectedChange.start);
    const start = normalizedText.length;
    normalizedText += selectedChange.replacement;
    corrections.push({
      original: selectedChange.original,
      replacement: selectedChange.replacement,
      sourceSpan: { start: selectedChange.start, end: selectedChange.end },
      normalizedSpan: { start, end: normalizedText.length },
      method: 'active-schema-phrase-similarity.v2',
      contextSource: selectedChange.contextSource,
      fieldId: selectedChange.fieldId,
      confidence: 'HIGH',
      reason: `Active field terminology near an assignment cue in ${template?.templateId || 'the current report'}.`,
    });
    cursor = selectedChange.end;
  }
  normalizedText += text.slice(cursor);
  return { normalizedText, corrections };
}
