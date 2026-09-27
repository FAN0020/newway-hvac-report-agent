const FIELD_UNIT_SUFFIXES = Object.freeze([
  ['_km', 'km'],
  ['_mm', 'mm'],
  ['_cm', 'cm'],
  ['_kpa', 'kPa'],
  ['_bar', 'bar'],
  ['_psi', 'psi'],
  ['_percent', '%'],
]);

function fieldUnit(fieldId) {
  const normalized = String(fieldId || '').toLowerCase();
  return FIELD_UNIT_SUFFIXES.find(([suffix]) => normalized.endsWith(suffix))?.[1];
}

export function parseTechnicianFieldAnswer({ definition, fieldId, text } = {}) {
  const normalized = String(text ?? '').trim();
  if (definition?.type !== 'number') return { value: normalized };
  const expectedUnit = fieldUnit(fieldId);
  const match = /^([-+]?(?:(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?)|(?:\d+(?:[.,]\d+)?)))\s*([^\d\s]+)?$/u.exec(normalized);
  if (!match) return { value: normalized, ...(expectedUnit ? { unit: expectedUnit } : {}) };
  const providedUnit = match[2]?.replace(/℃/gu, '°C');
  const numericText = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(match[1])
    ? match[1].replaceAll(',', '')
    : match[1].replace(',', '.');
  return {
    value: Number(numericText),
    ...(providedUnit || expectedUnit ? { unit: providedUnit || expectedUnit } : {}),
  };
}
