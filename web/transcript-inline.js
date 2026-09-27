/** Append untrusted transcript as text nodes with explicit original-first edits. */
export function appendInlineTranscript(container, { rawText, corrections = [], maxLength = Infinity } = {}) {
  const raw = String(rawText || '');
  if (!corrections.length && Number.isFinite(maxLength)) {
    const compact = raw.replaceAll(/\s+/gu, ' ').trim();
    container.append(container.ownerDocument.createTextNode(compact.length > maxLength
      ? `${compact.slice(0, maxLength - 1)}…` : compact));
    return;
  }
  let end = Number.isFinite(maxLength) && raw.length > maxLength ? Math.max(0, maxLength) : raw.length;
  const ordered = [...corrections].sort((a, b) => a.sourceSpan.start - b.sourceSpan.start);
  const crossing = ordered.find((item) => item.sourceSpan.start < end && item.sourceSpan.end > end);
  if (crossing) end = crossing.sourceSpan.start;
  const text = raw.slice(0, end);
  const doc = container.ownerDocument;
  let cursor = 0;
  for (const item of ordered) {
    const { start, end: itemEnd } = item.sourceSpan || {};
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(itemEnd)
      || start < cursor || itemEnd > text.length || itemEnd <= start
      || text.slice(start, itemEnd) !== item.original) continue;
    if (start > cursor) container.append(doc.createTextNode(text.slice(cursor, start)));
    const original = doc.createElement('del');
    original.className = 'transcript-original';
    original.append(doc.createTextNode(item.original));
    const replacement = doc.createElement('ins');
    replacement.className = 'transcript-replacement';
    replacement.append(doc.createTextNode(` ${item.replacement}`));
    container.append(original, replacement);
    cursor = itemEnd;
  }
  if (cursor < text.length || (text.length === 0 && end === raw.length)) container.append(doc.createTextNode(text.slice(cursor)));
  if (end < raw.length) container.append(doc.createTextNode('…'));
}

/** Render the existing Latest input disclosure without duplicating corrected text. */
export function appendLatestStatement(container, statement) {
  if (!statement) return;
  const doc = container.ownerDocument;
  const element = (tag, className = '', text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const disclosure = element('details', 'latest-statement-row');
  disclosure.open = Boolean(statement.expanded);
  const summary = element('summary');
  const copy = element('span', 'latest-statement-copy');
  copy.append(element('strong', '', `Latest input · ${statement.status === 'Used' ? 'Applied' : statement.status}`));
  summary.append(copy, element('span', 'latest-statement-view', 'View'));
  const evidence = element('div', 'latest-statement-evidence');
  if (statement.corrections?.length) {
    const paragraph = element('p');
    appendInlineTranscript(paragraph, { rawText: statement.text, corrections: statement.corrections });
    evidence.append(paragraph);
  } else {
    evidence.append(element('strong', '', statement.origin_label || 'Original transcript'), element('p', '', statement.text));
  }
  disclosure.append(summary, evidence);
  container.append(disclosure);
}
