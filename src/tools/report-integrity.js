import crypto from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashValue(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function hashReportDraft(draft) {
  return hashValue(draft);
}

export function reportToText(draft, confirmation) {
  const reportTitle = draft.template_name || {
    sbs_bus_maintenance: 'SBS Bus Maintenance Report',
    sbs_rail_maintenance: 'SBS Rail Maintenance Report',
    hvac_service: 'HVAC Service Report',
  }[draft.schema_id] || 'Maintenance Report';
  const lines = [
    reportTitle,
    `报告编号：${draft.report_id}`,
    `报告版本：${draft.report_version}`,
    '',
    draft.disclaimer?.text || '',
    '',
  ];
  for (const section of draft.sections || []) {
    lines.push(`【${section.title}】`);
    for (const item of section.items || section.content || []) {
      if (typeof item === 'string') lines.push(item);
      else if (item.text) lines.push(item.text);
      else if (item.label) {
        const renderedValue = item.value === null || item.value === undefined || item.value === ''
          ? 'Not provided / needs confirmation'
          : typeof item.value === 'object' ? JSON.stringify(item.value) : String(item.value);
        const rendered = item.unit && renderedValue !== 'Not provided / needs confirmation'
          ? `${renderedValue} ${item.unit}`
          : renderedValue;
        lines.push(`${item.label}: ${rendered}`);
      } else lines.push('Not provided / needs confirmation');
    }
    lines.push('');
  }
  lines.push('【技师确认】');
  lines.push(`技师：${confirmation.technician_name}（${confirmation.technician_id}）`);
  lines.push(`确认时间：${confirmation.confirmed_at}`);
  lines.push(`校验记录：${confirmation.validator_run_id}`);
  lines.push(`报告哈希：${confirmation.report_hash}`);
  return `${lines.filter((line, index) => line || lines[index - 1]).join('\n').trim()}\n`;
}
