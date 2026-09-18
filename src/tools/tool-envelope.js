import crypto from 'node:crypto';

export const TOOL_STATUSES = new Set([
  'PASS',
  'NEEDS_CONFIRMATION',
  'NEEDS_MORE_INFO',
  'FAIL',
  'RETRYABLE_ERROR',
  'OUTCOME_UNKNOWN',
]);

export function boundedString(value, maxLength = 2_000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

export function toolEnvelope(tool, traceId, status, data = {}, extras = {}) {
  const safeStatus = TOOL_STATUSES.has(status) ? status : 'FAIL';
  return {
    tool: boundedString(tool, 80),
    trace_id: boundedString(traceId, 120) || `trace_${crypto.randomUUID()}`,
    status: safeStatus,
    data,
    warnings: Array.isArray(extras.warnings) ? extras.warnings.slice(0, 50).map((item) => boundedString(item, 500)) : [],
    retryable: Boolean(extras.retryable),
    error_code: extras.error_code ? boundedString(extras.error_code, 100) : null,
  };
}

export function toolFailure(tool, traceId, error, fallbackCode = 'TOOL_FAILED') {
  const retryable = Boolean(error?.retryable);
  return toolEnvelope(tool, traceId, retryable ? 'RETRYABLE_ERROR' : 'FAIL', {
    message: boundedString(error?.message || 'Tool failed.', 1_000),
  }, { retryable, error_code: error?.code || fallbackCode });
}

export function stableId(prefix, ...values) {
  return `${prefix}_${crypto.createHash('sha256').update(values.map((item) => JSON.stringify(item)).join('|')).digest('hex').slice(0, 12)}`;
}
