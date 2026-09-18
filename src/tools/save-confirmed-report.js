import { toolEnvelope, toolFailure } from './tool-envelope.js';

export async function saveConfirmedReport({ draft, confirmationToken, store, traceId } = {}) {
  try {
    if (!store?.verifyConfirmation) throw new TypeError('ReportStore is required');
    const confirmation = await store.verifyConfirmation({ draft, confirmationToken });
    const saved = await store.writeOfficialJson({ draft, confirmation });
    return toolEnvelope('save_confirmed_report', traceId, 'PASS', {
      report_id: draft.report_id,
      report_version: draft.report_version,
      report_hash: confirmation.report_hash,
      format: 'json',
      file: saved.file,
      reused: !saved.created,
    });
  } catch (error) {
    return toolFailure('save_confirmed_report', traceId, error, error.code || 'SAVE_CONFIRMED_REPORT_FAILED');
  }
}
