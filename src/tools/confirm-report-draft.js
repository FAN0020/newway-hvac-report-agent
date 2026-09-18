import { toolEnvelope, toolFailure } from './tool-envelope.js';

export async function confirmReportDraft({ draft, validatorRunId, technicianId, technicianName, store, traceId } = {}) {
  try {
    if (!store?.createConfirmation) throw new TypeError('ReportStore is required');
    const confirmation = await store.createConfirmation({ draft, validatorRunId, technicianId, technicianName });
    return toolEnvelope('confirm_report_draft', traceId, 'PASS', { confirmation });
  } catch (error) {
    return toolFailure('confirm_report_draft', traceId, error, error.code || 'CONFIRMATION_FAILED');
  }
}
