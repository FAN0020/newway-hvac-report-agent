const UNCERTAINTY = /\b(?:maybe|possibly|perhaps|might|could\s+be|not\s+sure|cannot\s+confirm|can['’]?t\s+confirm|uncertain)\b/iu;

export function identifierIsCertain(text, start, end) {
  const source = String(text || '');
  const before = source.slice(0, start);
  const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
  const remaining = source.slice(end);
  const nextBoundary = remaining.search(/[.!?\n]/u);
  const clause = source.slice(boundary + 1, nextBoundary < 0 ? source.length : end + nextBoundary);
  const punctuation = nextBoundary < 0 ? '' : remaining[nextBoundary];
  return !UNCERTAINTY.test(clause) && punctuation !== '?';
}
