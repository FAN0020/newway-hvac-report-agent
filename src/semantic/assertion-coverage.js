export const ASSERTION_COVERAGE_VERSION = 'assertion-span-coverage.v1';

const NON_REPORT = /^(?:hi|hello|okay|thanks|thank you|um|uh)[,.!?\s]*$/iu;

function overlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function uncoveredSpans(assertion, facts) {
  const intervals = facts.filter((fact) => overlap(assertion, { start: fact.char_start, end: fact.char_end }))
    .map((fact) => ({ start: Math.max(assertion.start, fact.char_start), end: Math.min(assertion.end, fact.char_end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const uncovered = [];
  let cursor = assertion.start;
  for (const interval of intervals) {
    if (interval.start > cursor) uncovered.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < assertion.end) uncovered.push({ start: cursor, end: assertion.end });
  return uncovered.filter((span) => /[\p{L}\p{N}]/u.test(assertion.text.slice(span.start - assertion.start, span.end - assertion.start)));
}

export function evaluateAssertionCoverage({ assertions = [], facts = [], text = '' } = {}) {
  return assertions.map((assertion) => {
    const supported = facts.filter((fact) => overlap(assertion, { start: fact.char_start, end: fact.char_end }));
    const uncovered = uncoveredSpans(assertion, supported).map((span) => ({ ...span, text: text.slice(span.start, span.end) }));
    const status = NON_REPORT.test(assertion.text) ? 'NON_REPORT_CONTENT'
      : supported.length === 0 ? 'UNRESOLVED'
        : uncovered.length ? 'PARTIALLY_RESOLVED' : 'RESOLVED';
    return Object.freeze({ ...assertion, status, fact_ids: supported.map((fact) => fact.fact_id), uncovered_spans: uncovered });
  });
}

export function unresolvedSemanticWindows(coverage) {
  return coverage.filter((item) => ['UNRESOLVED', 'PARTIALLY_RESOLVED', 'AMBIGUOUS'].includes(item.status));
}
