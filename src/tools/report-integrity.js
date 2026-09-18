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
  const lines = [
    '空调现场服务报告',
    `报告编号：${draft.report_id}`,
    `报告版本：${draft.report_version}`,
    '',
    draft.disclaimer?.text || '',
    '',
  ];
  for (const section of draft.sections || []) {
    lines.push(`【${section.title}】`);
    for (const item of section.items || []) lines.push(item.text || '未提供/待确认');
    lines.push('');
  }
  lines.push('【技师确认】');
  lines.push(`技师：${confirmation.technician_name}（${confirmation.technician_id}）`);
  lines.push(`确认时间：${confirmation.confirmed_at}`);
  lines.push(`校验记录：${confirmation.validator_run_id}`);
  lines.push(`报告哈希：${confirmation.report_hash}`);
  return `${lines.filter((line, index) => line || lines[index - 1]).join('\n').trim()}\n`;
}
