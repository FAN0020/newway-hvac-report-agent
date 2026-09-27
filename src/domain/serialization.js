import { SESSION_PHASES } from './constants.js';
import {
  ContractValidationError,
  canonicalJson,
  copy,
  deepFreeze,
  hashContract,
  requiredString,
  requiredTimestamp,
} from './contract-utils.js';
import { validatePersistedSnapshot } from './report-snapshot.js';

export function serializeContract(value) {
  if (!value || typeof value !== 'object' || !value.contract || !value.contract_version) {
    throw new ContractValidationError('Only versioned domain contracts can be serialized.', 'INVALID_SERIALIZATION_INPUT');
  }
  return canonicalJson(value);
}

function parse(serialized) {
  try {
    return typeof serialized === 'string' ? JSON.parse(serialized) : copy(serialized);
  } catch (error) {
    throw new ContractValidationError(`Serialized contract is not valid JSON: ${error.message}`, 'INVALID_SERIALIZED_CONTRACT');
  }
}

function requireTrustedHash(value, trustedHash) {
  if (!trustedHash) {
    throw new ContractValidationError(
      'Deserialization requires an out-of-band hash from trusted persistence.',
      'UNTRUSTED_DESERIALIZATION',
    );
  }
  if (hashContract(value) !== trustedHash) {
    throw new ContractValidationError('Persisted contract hash does not match trusted persistence.', 'PERSISTENCE_HASH_MISMATCH');
  }
}

function validatePersistedSession(session) {
  const code = 'INVALID_REPORT_SESSION';
  if (!session || session.contract !== 'ReportSession' || session.contract_version !== '1'
    || session.authority !== 'SERVER' || session.client_input_trusted !== false) {
    throw new ContractValidationError('Persisted value is not a server-authoritative ReportSession v1.', code);
  }
  requiredString(session.session_id, 'session_id', code);
  if (!Number.isSafeInteger(session.revision) || session.revision < 0) {
    throw new ContractValidationError('revision must be a non-negative integer.', code);
  }
  if (!SESSION_PHASES.includes(session.phase)) throw new ContractValidationError('phase is invalid.', code);
  if (!Array.isArray(session.audit_event_ids) || session.audit_event_ids.length > session.revision + 1) {
    throw new ContractValidationError('audit_event_ids cannot exceed the creation event plus the session revision.', code);
  }
  for (const key of [
    'evidence_ids',
    'transcript_ids',
    'transcript_review_ids',
    'evidence_span_ids',
    'field_candidate_ids',
    'guidance_upload_ids',
    'guidance_context_ids',
    'agent_run_ids',
  ]) {
    if (!Array.isArray(session[key])) throw new ContractValidationError(`${key} must be an array.`, code);
  }
  requiredString(session.template_binding?.template_id, 'template_binding.template_id', code);
  requiredString(session.template_binding?.template_version, 'template_binding.template_version', code);
  requiredString(session.context_binding?.context_id, 'context_binding.context_id', code);
  requiredString(session.context_binding?.context_version, 'context_binding.context_version', code);
  requiredString(session.context_binding?.scope_id, 'context_binding.scope_id', code);
  requiredTimestamp(session.created_at, 'created_at', code);
  requiredTimestamp(session.updated_at, 'updated_at', code);
  if (session.report_name !== undefined) {
    requiredString(session.report_name, 'report_name', code);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(session.report_date || '')) {
      throw new ContractValidationError('report_date must be a calendar date.', code);
    }
    if (!Number.isSafeInteger(session.report_index) || session.report_index < 1) {
      throw new ContractValidationError('report_index must be a positive integer.', code);
    }
  }
  if (session.phase === 'RECOVERABLE_ERROR' && (!session.recovery_phase || !session.last_error)) {
    throw new ContractValidationError('RECOVERABLE_ERROR sessions require recovery state.', code);
  }
  return true;
}

export function deserializeReportSession(serialized, { trusted_persistence_hash: trustedHash } = {}) {
  const parsed = parse(serialized);
  requireTrustedHash(parsed, trustedHash);
  const migrated = {
    ...parsed,
    guidance_upload_ids: parsed.guidance_upload_ids || [],
    guidance_context_ids: parsed.guidance_context_ids || [],
    agent_run_ids: parsed.agent_run_ids || [],
    current_agent_run_id: parsed.current_agent_run_id || null,
    validation_ref: parsed.validation_ref || null,
    confirmation_ref: parsed.confirmation_ref || null,
    snapshot_ref: parsed.snapshot_ref || null,
  };
  validatePersistedSession(migrated);
  return deepFreeze(migrated);
}

export function deserializeReportSnapshot(serialized, { trusted_persistence_hash: trustedHash } = {}) {
  const parsed = parse(serialized);
  requireTrustedHash(parsed, trustedHash);
  validatePersistedSnapshot(parsed);
  return deepFreeze(parsed);
}
