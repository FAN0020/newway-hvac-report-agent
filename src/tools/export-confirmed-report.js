import { reportToText } from './report-integrity.js';
import { toolEnvelope, toolFailure } from './tool-envelope.js';

export async function exportConfirmedReport({ draft, confirmationToken, store, traceId } = {}) {
  try {
    if (!store?.verifyConfirmation) throw new TypeError('ReportStore is required');
    const confirmation = await store.verifyConfirmation({ draft, confirmationToken });
    const text = reportToText(draft, confirmation);
    const exported = await store.writeOfficialText({ draft, confirmation, text });
    return toolEnvelope('export_confirmed_report', traceId, 'PASS', {
      report_id: draft.report_id,
      report_version: draft.report_version,
      report_hash: confirmation.report_hash,
      format: 'text/plain',
      file: exported.file,
      copyable_text: text,
      reused: !exported.created,
    });
  } catch (error) {
    return toolFailure('export_confirmed_report', traceId, error, error.code || 'EXPORT_CONFIRMED_REPORT_FAILED');
  }
}
