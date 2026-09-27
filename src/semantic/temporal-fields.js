function localDate(timestamp, timeZone) {
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function clockMinute(clause) {
  const match = /\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\b/iu.exec(clause);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  if (match[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (match[3].toLocaleLowerCase() === 'pm' ? 12 : 0);
  } else if (hour <= 12 && match[1].length < 2) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function deriveCaptureTimeAssignments({ raw_text: rawText, template, captured_at: capturedAt, time_zone: timeZone } = {}) {
  const fields = (template?.schema?.fields || []).filter((field) =>
    field.id === 'work.date_time' || (/date/u.test(`${field.id} ${field.label}`.toLowerCase())
      && /time/u.test(`${field.id} ${field.label}`.toLowerCase())));
  if (fields.length !== 1) return [];
  const localDay = localDate(capturedAt, timeZone);
  if (!localDay) return [];
  const field = fields[0];
  const precision = field.precisionRequirement || 'MINUTE';
  const text = String(rawText || '');
  for (const segment of text.matchAll(/[^.!?;\n]+/gu)) {
    const clause = segment[0].trim();
    if (!clause || /\b(?:will|would|should|plan(?:ned)?|tomorrow|yesterday|not|never|didn['’]?t|wasn['’]?t|isn['’]?t)\b/iu.test(clause)) continue;
    const explicitDay = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(clause)?.[1];
    const relativeDay = /\b(?:today|this\s+(?:morning|afternoon|evening)|tonight)\b/iu.test(clause);
    if (!explicitDay && !relativeDay) continue;
    const day = explicitDay || localDay;
    if (precision === 'MINUTE' && !clockMinute(clause)) continue;
    const value = precision === 'DAY' ? day : `${day} ${clockMinute(clause)}`;
    const start = segment.index + segment[0].indexOf(clause);
    return [{
      field_id: field.id, value, claim_kind: 'VALUE', support_status: explicitDay ? 'CONFIRMED_BY_EVIDENCE' : 'INFERRED',
      semantic_type: 'CAPTURE_TIME_DERIVATION',
      source_span: { start, end: start + clause.length, text: clause },
      extraction_method: 'precision-aware-temporal-derivation',
      critical: Boolean(field.critical || field.requiresTechnicianConfirmation),
    }];
  }
  return [];
}
