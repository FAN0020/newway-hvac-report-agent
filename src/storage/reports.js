import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashReportDraft, hashValue } from '../tools/report-integrity.js';

async function writeExclusive(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, body, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function safeId(value, label, pattern) {
  const text = String(value || '');
  if (!pattern.test(text)) throw Object.assign(new Error(`Invalid ${label}.`), { code: `INVALID_${label.toUpperCase()}`, status: 400 });
  return text;
}

export class ReportStore {
  constructor({ root }) {
    if (!root) throw new TypeError('ReportStore root is required');
    this.root = path.resolve(root);
    this.validationRoot = path.join(this.root, 'validations');
    this.confirmationRoot = path.join(this.root, 'confirmations');
    this.reportRoot = path.join(this.root, 'reports');
  }

  async recordValidation({ draft, validation, factsReceipt }) {
    const validatorRunId = safeId(validation?.trace_id, 'validator_run_id', /^trace_[A-Za-z0-9_-]{1,110}$/);
    const factsReceiptId = safeId(factsReceipt?.facts_receipt_id, 'facts_receipt_id', /^facts_[a-f0-9]{24}$/);
    if (!/^sha256:[a-f0-9]{64}$/.test(String(factsReceipt?.facts_hash || ''))) {
      throw Object.assign(new Error('Invalid facts_hash.'), { code: 'INVALID_FACTS_HASH', status: 400 });
    }
    const correctionReceiptId = safeId(factsReceipt?.correction_receipt_id, 'correction_receipt_id', /^correction_[a-f0-9]{24}$/);
    if (!/^sha256:[a-f0-9]{64}$/.test(String(factsReceipt?.correction_receipt_hash || ''))) {
      throw Object.assign(new Error('Invalid correction_receipt_hash.'), { code: 'INVALID_CORRECTION_RECEIPT_HASH', status: 400 });
    }
    const receipt = Object.freeze({
      validator_run_id: validatorRunId,
      report_id: String(draft?.report_id || ''),
      report_version: Number(draft?.report_version || 0),
      report_hash: hashReportDraft(draft),
      facts_receipt_id: factsReceiptId,
      facts_hash: factsReceipt.facts_hash,
      correction_receipt_id: correctionReceiptId,
      correction_receipt_hash: factsReceipt.correction_receipt_hash,
      schema_id: String(draft?.schema_id || 'hvac_service'),
      schema_version: String(draft?.report_schema_version || '1'),
      report_session_id: String(draft?.report_session_id || ''),
      structured_state_hash: String(draft?.structured_state_hash || ''),
      validator_status: String(validation?.status || ''),
      can_enter_technician_review: Boolean(validation?.data?.can_enter_technician_review),
      validated_at: new Date().toISOString(),
    });
    const file = path.join(this.validationRoot, `${validatorRunId}.json`);
    const created = await writeExclusive(file, `${JSON.stringify(receipt, null, 2)}\n`);
    if (!created) {
      const existing = JSON.parse(await fs.readFile(file, 'utf8'));
      if (existing.report_hash !== receipt.report_hash || existing.validator_status !== receipt.validator_status
        || existing.facts_receipt_id !== receipt.facts_receipt_id || existing.facts_hash !== receipt.facts_hash
        || existing.correction_receipt_id !== receipt.correction_receipt_id || existing.correction_receipt_hash !== receipt.correction_receipt_hash
        || existing.schema_id !== receipt.schema_id || existing.schema_version !== receipt.schema_version
        || existing.report_session_id !== receipt.report_session_id || existing.structured_state_hash !== receipt.structured_state_hash) {
        throw Object.assign(new Error('Validator run ID was already used for different content.'), { code: 'VALIDATOR_RUN_COLLISION', status: 409 });
      }
      return existing;
    }
    return receipt;
  }

  async recordStructuredValidation({ draft, validation, facts }) {
    const validatorRunId = safeId(validation?.trace_id, 'validator_run_id', /^trace_[A-Za-z0-9_-]{1,110}$/);
    const schemaId = safeId(draft?.schema_id, 'schema_id', /^[a-z][a-z0-9_-]{2,100}$/);
    const schemaVersion = safeId(draft?.schema_version, 'schema_version', /^[A-Za-z0-9._-]{1,40}$/);
    const receipt = Object.freeze({
      validator_run_id: validatorRunId,
      report_id: String(draft?.report_id || ''),
      report_version: Number(draft?.report_version || 0),
      report_hash: hashReportDraft(draft),
      schema_id: schemaId,
      schema_version: schemaVersion,
      report_session_id: String(draft?.report_session_id || ''),
      structured_state_hash: String(draft?.structured_state_hash || ''),
      facts_hash: hashValue(Array.isArray(facts) ? facts : []),
      validator_status: String(validation?.status || ''),
      can_enter_technician_review: Boolean(validation?.data?.can_enter_technician_review),
      validated_at: new Date().toISOString(),
    });
    const file = path.join(this.validationRoot, `${validatorRunId}.json`);
    const created = await writeExclusive(file, `${JSON.stringify(receipt, null, 2)}\n`);
    if (!created) {
      const existing = JSON.parse(await fs.readFile(file, 'utf8'));
      if (existing.report_hash !== receipt.report_hash || existing.validator_status !== receipt.validator_status
        || existing.schema_id !== receipt.schema_id || existing.schema_version !== receipt.schema_version
        || existing.report_session_id !== receipt.report_session_id || existing.structured_state_hash !== receipt.structured_state_hash
        || existing.facts_hash !== receipt.facts_hash) {
        throw Object.assign(new Error('Validator run ID was already used for different content.'), { code: 'VALIDATOR_RUN_COLLISION', status: 409 });
      }
      return existing;
    }
    return receipt;
  }

  async readValidation(validatorRunId) {
    const id = safeId(validatorRunId, 'validator_run_id', /^trace_[A-Za-z0-9_-]{1,110}$/);
    try {
      return JSON.parse(await fs.readFile(path.join(this.validationRoot, `${id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('Validation receipt was not found.'), { code: 'VALIDATION_NOT_FOUND', status: 404 });
      throw error;
    }
  }

  async createConfirmation({ draft, validatorRunId, technicianId, technicianName }) {
    const receipt = await this.readValidation(validatorRunId);
    const reportHash = hashReportDraft(draft);
    if (!receipt.can_enter_technician_review || !['PASS', 'NEEDS_MORE_INFO'].includes(receipt.validator_status)) {
      throw Object.assign(new Error('The latest validation is not eligible for technician review.'), { code: 'VALIDATION_NOT_REVIEWABLE', status: 409 });
    }
    if (receipt.report_hash !== reportHash || receipt.report_version !== Number(draft?.report_version || 0)) {
      throw Object.assign(new Error('The draft changed after validation. Validate it again.'), { code: 'STALE_VALIDATION', status: 409 });
    }
    const id = String(technicianId || '').trim().slice(0, 120);
    const name = String(technicianName || '').trim().slice(0, 120);
    if (!id || !name) throw Object.assign(new Error('Technician ID and name are required.'), { code: 'TECHNICIAN_REQUIRED', status: 400 });
    const token = `confirm_${crypto.randomBytes(24).toString('hex')}`;
    const confirmation = Object.freeze({
      confirmation_token: token,
      report_id: receipt.report_id,
      report_version: receipt.report_version,
      report_hash: receipt.report_hash,
      validator_run_id: receipt.validator_run_id,
      facts_receipt_id: receipt.facts_receipt_id,
      facts_hash: receipt.facts_hash,
      correction_receipt_id: receipt.correction_receipt_id,
      correction_receipt_hash: receipt.correction_receipt_hash,
      schema_id: receipt.schema_id,
      schema_version: receipt.schema_version,
      report_session_id: receipt.report_session_id,
      structured_state_hash: receipt.structured_state_hash,
      technician_id: id,
      technician_name: name,
      confirmed_at: new Date().toISOString(),
    });
    await writeExclusive(path.join(this.confirmationRoot, `${token}.json`), `${JSON.stringify(confirmation, null, 2)}\n`);
    return confirmation;
  }

  async verifyConfirmation({ draft, confirmationToken }) {
    const token = safeId(confirmationToken, 'confirmation_token', /^confirm_[a-f0-9]{48}$/);
    let confirmation;
    try {
      confirmation = JSON.parse(await fs.readFile(path.join(this.confirmationRoot, `${token}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('Confirmation token was not found.'), { code: 'CONFIRMATION_NOT_FOUND', status: 404 });
      throw error;
    }
    const currentHash = hashReportDraft(draft);
    if (confirmation.report_hash !== currentHash || confirmation.report_id !== draft?.report_id || confirmation.report_version !== Number(draft?.report_version || 0)) {
      throw Object.assign(new Error('Confirmation is stale because the report content or version changed.'), { code: 'STALE_CONFIRMATION', status: 409 });
    }
    return confirmation;
  }

  reportBasePath(draft, reportHash, confirmationToken) {
    const reportId = safeId(draft?.report_id, 'report_id', /^report_[a-f0-9]{12}$/);
    const version = Number(draft?.report_version || 0);
    if (!Number.isInteger(version) || version < 1) throw Object.assign(new Error('Invalid report version.'), { code: 'INVALID_REPORT_VERSION', status: 400 });
    const confirmationId = safeId(confirmationToken, 'confirmation_token', /^confirm_[a-f0-9]{48}$/).slice(-12);
    return path.join(this.reportRoot, `${reportId}.v${version}.${reportHash.slice(7, 19)}.${confirmationId}`);
  }

  async writeOfficialJson({ draft, confirmation }) {
    const body = `${JSON.stringify({
      schema_version: draft?.schema_id && draft.schema_id !== 'hvac_service' ? 'newway-confirmed-report.v1' : 'hvac-confirmed-report.v1',
      report_hash: confirmation.report_hash,
      confirmation,
      report: draft,
    }, null, 2)}\n`;
    const file = `${this.reportBasePath(draft, confirmation.report_hash, confirmation.confirmation_token)}.json`;
    const created = await writeExclusive(file, body);
    if (!created && await fs.readFile(file, 'utf8') !== body) throw Object.assign(new Error('Official report path collision.'), { code: 'REPORT_PATH_COLLISION', status: 409 });
    return { file, created };
  }

  async writeOfficialText({ draft, confirmation, text }) {
    const file = `${this.reportBasePath(draft, confirmation.report_hash, confirmation.confirmation_token)}.txt`;
    const created = await writeExclusive(file, text);
    if (!created && await fs.readFile(file, 'utf8') !== text) throw Object.assign(new Error('Export path collision.'), { code: 'EXPORT_PATH_COLLISION', status: 409 });
    return { file, created };
  }
}
