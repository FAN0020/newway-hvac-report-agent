export function normalizedText(value) {
  return String(value ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}
export function distance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[right.length];
}
export function errorRate(reference, prediction, unit = 'word') {
  const tokenize = (text) => unit === 'character' ? [...normalizedText(text).replace(/ /gu, '')] : normalizedText(text).split(' ').filter(Boolean);
  const expected = tokenize(reference);
  const actual = tokenize(prediction);
  return expected.length ? distance(expected, actual) / expected.length : (actual.length ? 1 : 0);
}
export function containsPhrase(text, phrase, mode = 'phrase') {
  if (mode === 'equipment_id') {
    const compact = (value) => normalizedText(value).replace(/[^\p{L}\p{N}]/gu, '');
    return compact(text).includes(compact(phrase));
  }
  return normalizedText(text).includes(normalizedText(phrase));
}
export function categoryHits(text, phrases, mode = 'phrase') {
  const found = phrases.filter((phrase) => containsPhrase(text, phrase, mode));
  return { matched: found.length, total: phrases.length, missed: phrases.filter((phrase) => !found.includes(phrase)) };
}
export function setCounts(expected, actual) {
  const gold = new Set(expected);
  const predicted = new Set(actual);
  return { tp: [...predicted].filter((x) => gold.has(x)).length, fp: [...predicted].filter((x) => !gold.has(x)).length, fn: [...gold].filter((x) => !predicted.has(x)).length };
}
export function scores({ tp, fp, fn }) {
  const precision = tp + fp ? tp / (tp + fp) : (fn ? 0 : 1);
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}
export function aggregateFieldScores(results) {
  const valid = results.filter((item) => item.status === 'RUN' && item.counts);
  if (!valid.length) return null;
  const total = valid.reduce((acc, item) => ({ tp: acc.tp + item.counts.tp, fp: acc.fp + item.counts.fp, fn: acc.fn + item.counts.fn }), { tp: 0, fp: 0, fn: 0 });
  return { cases: valid.length, counts: total, micro: scores(total), macro: { precision: valid.reduce((n, x) => n + scores(x.counts).precision, 0) / valid.length, recall: valid.reduce((n, x) => n + scores(x.counts).recall, 0) / valid.length, f1: valid.reduce((n, x) => n + scores(x.counts).f1, 0) / valid.length } };
}

const UNIT_ALIASES = Object.freeze({
  uf: 'µf',
  'μf': 'µf',
  microfarad: 'µf',
  microfarads: 'µf',
  c: '°c',
  '℃': '°c',
  celsius: '°c',
  megapascal: 'mpa',
  megaohm: 'mω',
  megaohms: 'mω',
});

function normalizedUnit(value) {
  const compact = String(value ?? '').trim().toLowerCase().normalize('NFKC').replace(/\s+/gu, '');
  return UNIT_ALIASES[compact] || compact;
}

function normalizedNumber(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(raw)) return null;
  return String(Number(raw));
}

function valueMatches(fact, target) {
  if (fact?.field !== target.field) return false;
  const expected = String(target.value ?? '');
  const actual = String(fact.value ?? '');
  if (target.kind === 'equipment_id') {
    const compact = (value) => normalizedText(value).replace(/[^\p{L}\p{N}]/gu, '');
    return compact(actual) === compact(expected);
  }
  if (target.kind === 'number_unit') {
    return normalizedNumber(actual) === normalizedNumber(expected)
      && normalizedUnit(fact.unit) === normalizedUnit(target.unit);
  }
  if (target.match === 'contains') return normalizedText(actual).includes(normalizedText(expected));
  return normalizedText(actual) === normalizedText(expected);
}

function targetKey(target) {
  return `${target.kind}|${target.field}|${target.value ?? ''}|${target.unit ?? ''}|${target.match ?? 'exact'}`;
}

/**
 * Scores typed fact values independently from field-presence F1.
 *
 * Positive targets use target-level P/R/F1. A target only matches a fact with
 * the same structured field; equipment IDs ignore separators, number/unit
 * targets compare a canonical decimal plus canonical unit, and action values
 * may explicitly use a phrase-containment rule. Negation targets are safety
 * assertions: they pass only when no prohibited positive fact is emitted.
 * They are deliberately reported as checks/violations rather than folded into
 * P/R/F1, where an absent forbidden fact has no predicted positive counterpart.
 */
export function scoreFactValues(targets, facts) {
  const positive = (targets || []).filter((target) => target.kind !== 'negation');
  const negation = (targets || []).filter((target) => target.kind === 'negation');
  const byCategory = {};
  for (const kind of ['equipment_id', 'number_unit', 'action', 'completion']) byCategory[kind] = { tp: 0, fp: 0, fn: 0 };
  const matchedFacts = new Set();
  const targetResults = [];
  for (const target of positive) {
    if (!byCategory[target.kind]) byCategory[target.kind] = { tp: 0, fp: 0, fn: 0 };
    const index = (facts || []).findIndex((fact, factIndex) => !matchedFacts.has(factIndex) && valueMatches(fact, target));
    if (index >= 0) {
      matchedFacts.add(index);
      byCategory[target.kind].tp += 1;
      targetResults.push({ target: targetKey(target), kind: target.kind, passed: true, matched_fact_index: index });
    } else {
      byCategory[target.kind].fn += 1;
      targetResults.push({ target: targetKey(target), kind: target.kind, passed: false });
    }
  }
  const targetFields = new Set(positive.map((target) => target.field));
  for (let index = 0; index < (facts || []).length; index += 1) {
    const fact = facts[index];
    if (matchedFacts.has(index) || !targetFields.has(fact.field)) continue;
    const kinds = [...new Set(positive.filter((target) => target.field === fact.field).map((target) => target.kind))];
    for (const kind of kinds) byCategory[kind].fp += 1;
  }
  const negationChecks = negation.map((target) => {
    const violations = (target.prohibited || []).filter((prohibited) => (facts || []).some((fact) => valueMatches(fact, prohibited)));
    return { target: targetKey(target), passed: violations.length === 0, violations };
  });
  const total = Object.values(byCategory).reduce((acc, counts) => ({ tp: acc.tp + counts.tp, fp: acc.fp + counts.fp, fn: acc.fn + counts.fn }), { tp: 0, fp: 0, fn: 0 });
  return {
    counts: total,
    metrics: scores(total),
    target_results: targetResults,
    categories: Object.fromEntries(Object.entries(byCategory).map(([kind, counts]) => [kind, { counts, targets: counts.tp + counts.fn, metrics: scores(counts) }])),
    negation: {
      checks: negationChecks.length,
      correct: negationChecks.filter((check) => check.passed).length,
      violations: negationChecks.filter((check) => !check.passed),
    },
  };
}

export function aggregateFactValueScores(results) {
  const valid = results.filter((item) => item.status === 'RUN' && item.value_scores);
  if (!valid.length) return null;
  const categories = {};
  for (const item of valid) {
    for (const [kind, score] of Object.entries(item.value_scores.categories)) {
      if (score.targets === 0) continue;
      const current = categories[kind] || { tp: 0, fp: 0, fn: 0 };
      categories[kind] = { tp: current.tp + score.counts.tp, fp: current.fp + score.counts.fp, fn: current.fn + score.counts.fn };
    }
  }
  const total = Object.values(categories).reduce((acc, counts) => ({ tp: acc.tp + counts.tp, fp: acc.fp + counts.fp, fn: acc.fn + counts.fn }), { tp: 0, fp: 0, fn: 0 });
  const negation = valid.reduce((acc, item) => ({
    checks: acc.checks + item.value_scores.negation.checks,
    correct: acc.correct + item.value_scores.negation.correct,
    violations: [...acc.violations, ...item.value_scores.negation.violations],
  }), { checks: 0, correct: 0, violations: [] });
  return {
    cases: valid.length,
    counts: total,
    micro: scores(total),
    categories: Object.fromEntries(Object.entries(categories).map(([kind, counts]) => [kind, { counts, targets: counts.tp + counts.fn, micro: scores(counts) }])),
    negation: { ...negation, accuracy: negation.checks ? negation.correct / negation.checks : 1 },
  };
}
