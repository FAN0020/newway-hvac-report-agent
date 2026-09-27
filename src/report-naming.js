export function reportCreationDate(timestamp, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('A valid report creation timestamp is required.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatReportName(templateName, creationDate, dailyIndex = 1) {
  const suffix = dailyIndex > 1 ? ` (${dailyIndex})` : '';
  return `${String(templateName).trim()} · ${creationDate}${suffix}`;
}
