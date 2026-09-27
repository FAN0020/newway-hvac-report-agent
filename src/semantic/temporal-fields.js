function localDateTime(timestamp, timeZone) {
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function deriveCaptureTimeAssignments({ raw_text: rawText, template, captured_at: capturedAt, time_zone: timeZone } = {}) {
  const fields = (template?.schema?.fields || []).filter((field) =>
    field.id === 'work.date_time' || (/date/u.test(`${field.id} ${field.label}`.toLowerCase())
      && /time/u.test(`${field.id} ${field.label}`.toLowerCase())));
  if (fields.length !== 1) return [];
  const value = localDateTime(capturedAt, timeZone);
  if (!value) return [];
  const text = String(rawText || '');
  for (const segment of text.matchAll(/[^.!?;\n]+/gu)) {
    const clause = segment[0].trim();
    if (!clause || /\b(?:will|would|should|plan(?:ned)?|tomorrow|yesterday|not|never|didn['’]?t|wasn['’]?t|isn['’]?t)\b/iu.test(clause)) continue;
    if (!/\b(?:today|just|now)\b/iu.test(clause)) continue;
    if (!/\b(?:it(?:'s| is| was)\s+(?:finished|completed|complete|done)|(?:i|we)\s+(?:(?:have|had)\s+)?(?:just\s+)?(?:finished|completed)\b|(?:the\s+)?(?:maintenance|work|job)\s+(?:is|was)\s+(?:finished|completed|complete|done)|(?:finished|completed)\s+today)\b/iu.test(clause)) continue;
    const start = segment.index + segment[0].indexOf(clause);
    return [{
      field_id: fields[0].id, value, claim_kind: 'VALUE', support_status: 'INFERRED',
      semantic_type: 'CAPTURE_TIME_DERIVATION',
      source_span: { start, end: start + clause.length, text: clause },
      extraction_method: 'capture-time-derivation',
      critical: Boolean(fields[0].critical || fields[0].requiresTechnicianConfirmation),
    }];
  }
  return [];
}
