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
