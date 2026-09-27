import crypto from 'node:crypto';

export const ASSERTION_SEGMENTER_VERSION = 'semantic-assertions.v2';

const SENTENCE = /[^.!?\n]+(?:[.!?]+|$)/gu;
const BOUNDARIES = [
  /[,;]\s*(?=(?:(?:the|my)\s+)?[\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*){0,2}\s+(?:is|was|are|were|reads?|measured)\b)/giu,
  /[,;]\s*(?=(?:(?:I|we)\s+)?(?:found|observed|identified|detected|re[- ]?tested|tested|verified|ran|returned|replaced|installed|repaired|reseated|secured|sealed|tightened|cleared|cleaned|adjusted|lubricated|reset|removed|refitted|restored)\b)/giu,
  /(?:[,;]\s*|\s+)(?:and|but|so|then)\s+(?=(?:(?:I|we)\s+)?(?:found|observed|identified|detected|re[- ]?tested|tested|verified|ran|returned|replaced|installed|repaired|reseated|secured|sealed|tightened|cleared|cleaned|adjusted|lubricated|reset|removed|refitted|restored|did|passed|failed|recommend(?:ed)?|suggest(?:ed)?|should)\b)/giu,
  /(?:[,;]\s*|\s+)(?:and|but|so|then)\s+(?=(?:I|we|the\s+customer|the\s+driver|the\s+operator|no\s+outstanding|no\s+follow[- ]?up)\b)/giu,
  /\s+(?=\b(?:this\s+(?:morning|afternoon|evening)|today|yesterday|tonight)\b)/giu,
  /\s+(?=\bat\s+(?:the\s+)?[A-Z][\p{L}])/gu,
];

function stableId(transcriptId, start, end) {
  return crypto.createHash('sha256').update(JSON.stringify([transcriptId, start, end])).digest('hex').slice(0, 24);
}

function actorFor(text) {
  if (/^(?:the\s+)?driver\s+(?:reported|complained|said)\b/iu.test(text)) return 'DRIVER';
  if (/^(?:the\s+)?operator\s+(?:reported|complained|said)\b/iu.test(text)) return 'OPERATOR';
  if (/^(?:the\s+)?(?:customer|client)\s+(?:reported|complained|said)\b/iu.test(text)) return 'CUSTOMER';
  return 'TECHNICIAN';
}

export function segmentAssertions({ text: input, transcript_id: transcriptId = '' } = {}) {
  const text = String(input || '');
  const assertions = [];
  for (const sentence of text.matchAll(SENTENCE)) {
    const source = sentence[0];
    const boundaries = BOUNDARIES.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => ({
      left: match.index,
      right: match.index + match[0].length,
    }))).sort((a, b) => a.left - b.left || b.right - a.right);
    let cursor = 0;
    const push = (end, next = end) => {
      const piece = source.slice(cursor, end);
      const first = piece.search(/\S/u);
      if (first < 0) { cursor = next; return; }
      const trailing = piece.match(/\s*$/u)?.[0].length || 0;
      const start = sentence.index + cursor + first;
      const stop = sentence.index + end - trailing;
      const assertionText = text.slice(start, stop);
      assertions.push(Object.freeze({
        assertion_id: `assertion_${stableId(transcriptId, start, stop)}`,
        text: assertionText,
        start,
        end: stop,
        actor: actorFor(assertionText),
      }));
      cursor = next;
    };
    for (const boundary of boundaries) {
      if (boundary.left <= cursor || boundary.right >= source.length) continue;
      push(boundary.left, boundary.right);
    }
    push(source.length);
  }
  return assertions;
}
