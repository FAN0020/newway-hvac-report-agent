import { boundedString } from './tool-envelope.js';

export const ALLOWED_FACT_FIELDS = new Set([
  'work_order', 'equipment', 'customer_complaint', 'inspection_findings',
  'work_performed', 'parts_used', 'test_results', 'completion_status',
  'unresolved_issues', 'follow_up_recommendations', 'refrigerant_record',
  'measurements', 'attachments', 'cost_quote', 'warranty', 'customer_feedback',
]);

export const SUPPORT_STATUSES = new Set([
  'DIRECT_TRANSCRIPT', 'MANUAL_ENTRY', 'CONFIRMED_BY_TECHNICIAN', 'UNCERTAIN',
]);

export const MANUAL_ONLY_FIELDS = new Set(['cost_quote', 'warranty']);

export const FIELD_TO_SECTION = Object.freeze({
  work_order: 'job_information',
  equipment: 'equipment_information',
  customer_complaint: 'customer_complaint',
  inspection_findings: 'inspection_findings',
  work_performed: 'work_performed',
  parts_used: 'parts_and_materials',
  test_results: 'test_results',
  completion_status: 'completion_status',
  unresolved_issues: 'unresolved_and_follow_up',
  follow_up_recommendations: 'unresolved_and_follow_up',
  refrigerant_record: 'refrigerant_record',
  measurements: 'measurements',
  attachments: 'attachments',
  cost_quote: 'cost_quote',
  warranty: 'warranty',
  customer_feedback: 'customer_feedback',
});

function compactObject(value, depth = 0) {
  if (depth > 4) return null;
  if (typeof value === 'string') return boundedString(value, 1_000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => compactObject(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [boundedString(key, 80), compactObject(item, depth + 1)]));
  }
  return boundedString(value, 1_000);
}

export function sanitizeValue(value) {
  return compactObject(value);
}

function readable(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('、');
  if (!value || typeof value !== 'object') return String(value ?? '');
  return Object.entries(value).filter(([, item]) => item !== '' && item !== null && item !== undefined)
    .map(([key, item]) => `${key}: ${readable(item)}`).join('，');
}

export function renderFact(fact) {
  const value = fact?.value;
  if (fact?.field === 'parts_used' && value && typeof value === 'object') {
    const action = boundedString(value.action || '更换');
    const name = boundedString(value.name || '零部件');
    const specification = boundedString(value.specification || '');
    const quantity = Number.isFinite(Number(value.quantity)) ? Number(value.quantity) : null;
    return `${action}${specification ? ` ${specification}` : ''} ${name}${quantity === null ? '' : ` ${quantity} 个`}。`.replace(/\s+/g, ' ').trim();
  }
  const labels = {
    work_order: '工单信息', equipment: '设备信息', customer_complaint: '客户反映',
    inspection_findings: '现场检查', work_performed: '已完成工作', test_results: '测试结果',
    completion_status: '完成状态', unresolved_issues: '未解决事项',
    follow_up_recommendations: '后续建议', refrigerant_record: '制冷剂记录',
    measurements: '测量读数', attachments: '附件', cost_quote: '成本与报价',
    warranty: '保修情况', customer_feedback: '客户现场意见',
  };
  return `${labels[fact?.field] || fact?.field}：${readable(value)}。`;
}
