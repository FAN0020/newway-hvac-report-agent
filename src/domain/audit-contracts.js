import {
  ContractValidationError,
  contentAddressedId,
  copy,
  deepFreeze,
  requiredString,
  requiredTimestamp,
} from './contract-utils.js';

const EVENT_TYPES = Object.freeze([
  'SESSION_CREATED',
  'PHASE_TRANSITION',
  'RECOVERABLE_ERROR_RECORDED',
  'SESSION_RECOVERED',
  'TECHNICIAN_CONFIRMATION',
]);

export function createAuditEvent(input = {}) {
  const code = 'INVALID_AUDIT_EVENT';
  const revision = Number(input.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ContractValidationError('revision must be a non-negative integer.', code);
  }
  const eventType = requiredString(input.event_type, 'event_type', code);
  if (!EVENT_TYPES.includes(eventType)) {
    throw new ContractValidationError(`Unsupported audit event type: ${eventType}.`, code);
  }
  const body = {
    contract: 'AuditEvent',
    contract_version: '1',
    session_id: requiredString(input.session_id, 'session_id', code),
    revision,
    event_type: eventType,
    issued_by: 'SERVER',
    principal_ref: input.principal_ref ? requiredString(input.principal_ref, 'principal_ref', code) : null,
    occurred_at: requiredTimestamp(input.occurred_at, 'occurred_at', code),
    payload: copy(input.payload || {}),
  };
  return deepFreeze({ event_id: contentAddressedId('event', body, input.event_id), ...body });
}

export function createTechnicianConfirmationEvent(input = {}) {
  const code = 'INVALID_CONFIRMATION_EVENT';
  const fieldId = requiredString(input.field_id, 'field_id', code);
  const candidateId = requiredString(input.candidate_id, 'candidate_id', code);
  const principalRef = requiredString(input.technician_principal_ref, 'technician_principal_ref', code);
  return createAuditEvent({
    session_id: input.session_id,
    revision: input.revision,
    event_type: 'TECHNICIAN_CONFIRMATION',
    principal_ref: principalRef,
    occurred_at: input.occurred_at,
    payload: {
      field_id: fieldId,
      candidate_id: candidateId,
      technician_principal_ref: principalRef,
    },
  });
}

export const auditContractEnums = deepFreeze({ EVENT_TYPES });
