const FIELD_LINE = /^(?:[-*]\s+|\d+[.)]\s+)?([^:：|\n]{2,80})\s*[:：]\s*(?:_{2,}|\.{2,}|\[\s*\]|$)/u;
const BULLET_LINE = /^(?:[-*]\s+|\d+[.)]\s+)([^:：|\n]{2,80})\s*$/u;

function idFor(label) {
  return label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 64);
}

export function proposeTextFields(text) {
  const fields = [];
  const seen = new Set();
  let section = 'Report fields';
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,4}\s+\S/u.test(line)) { section = line.replace(/^#+\s*/u, '').trim(); continue; }
    const match = line.match(FIELD_LINE) || line.match(BULLET_LINE);
    if (!match) continue;
    const label = match[1].replace(/\s+/gu, ' ').trim();
    const id = idFor(label);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    fields.push({ id, label, section, type: 'string', required: false,
      allowedSources: ['TECHNICIAN'], critical: false, requiresTechnicianConfirmation: false,
      allowExplicitNone: false, allowNotApplicable: false, proposalOrigin: 'TEXT_HEURISTIC' });
  }
  return fields;
}

export function decodeTemplateText({ filename, mimeType, bytes }) {
  const extension = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/u)?.[0];
  const textual = ['.txt', '.md', '.csv'].includes(extension) && (/^text\//u.test(String(mimeType || '')) || !mimeType || mimeType === 'application/octet-stream');
  if (!textual) return { status: 'MANUAL_REVIEW_REQUIRED', reason: 'This file format has no reliable text parser. Define fields manually.' };
  if (bytes.length > 1_000_000) return { status: 'MANUAL_REVIEW_REQUIRED', reason: 'Text source is too large for field suggestion. Define fields manually.' };
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
    return { status: 'MANUAL_REVIEW_REQUIRED', reason: 'Text decoding failed. Define fields manually.' };
  }
  const fields = proposeTextFields(text);
  if (!fields.length) return { status: 'MANUAL_REVIEW_REQUIRED', reason: 'No reliable field labels were found. Define fields manually.' };
  return { status: 'PROPOSED_FOR_REVIEW', parser: 'text-field-lines-v1', fields };
}
