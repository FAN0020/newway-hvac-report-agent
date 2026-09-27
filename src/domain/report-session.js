import { SESSION_PHASES } from './constants.js';
import { createAuditEvent } from './audit-contracts.js';
import {
  ContractValidationError,
  copy,
  deepFreeze,
  requiredString,
  requiredTimestamp,
} from './contract-utils.js';

const ALLOWED_TRANSITIONS = Object.freeze({
  CONTEXT: Object.freeze(['CAPTURE']),
  CAPTURE: Object.freeze(['PROCESSING']),
  PROCESSING: Object.freeze(['CORRECTION_IF_NEEDED', 'RESOLVE']),
  CORRECTION_IF_NEEDED: Object.freeze(['RESOLVE']),
  RESOLVE: Object.freeze(['CAPTURE', 'REVIEW']),
  REVIEW: Object.freeze(['CAPTURE', 'READY']),
  READY: Object.freeze(['CONFIRMED']),
  CONFIRMED: Object.freeze([]),
  RECOVERABLE_ERROR: Object.freeze([]),
});

const ERRORABLE_PHASES = new Set([
  'CAPTURE',
  'PROCESSING',
  'CORRECTION_IF_NEEDED',
  'RESOLVE',
  'REVIEW',
  'READY',
]);

export class StaleRevisionError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`Stale ReportSession revision: expected ${expectedRevision}, current revision is ${actualRevision}.`);
    this.name = 'StaleRevisionError';
    this.code = 'STALE_REVISION';
    this.status = 409;
    this.expected_revision = expectedRevision;
    this.actual_revision = actualRevision;
  }
}

export class InvalidTransitionError extends Error {
  constructor(fromPhase, toPhase, code = 'INVALID_PHASE_TRANSITION') {
    super(`ReportSession cannot transition from ${fromPhase} to ${toPhase}.`);
    this.name = 'InvalidTransitionError';
    this.code = code;
    this.status = 409;
    this.from_phase = fromPhase;
    this.to_phase = toPhase;
  }
}

function binding(input, name, requiredKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractValidationError(`${name} is required.`, 'INVALID_REPORT_SESSION');
  }
  return Object.fromEntries(requiredKeys.map((key) => [
    key,
    requiredString(input[key], `${name}.${key}`, 'INVALID_REPORT_SESSION'),
  ]));
}

export function createReportSession(input = {}) {
  const createdAt = requiredTimestamp(input.created_at, 'created_at', 'INVALID_REPORT_SESSION');
  return deepFreeze({
    contract: 'ReportSession',
    contract_version: '1',
    authority: 'SERVER',
    client_input_trusted: false,
    session_id: requiredString(input.session_id, 'session_id', 'INVALID_REPORT_SESSION'),
    template_binding: binding(input.template_binding, 'template_binding', ['template_id', 'template_version']),
    context_binding: binding(input.context_binding, 'context_binding', ['context_id', 'context_version', 'scope_id']),
    revision: 0,
    phase: 'CONTEXT',
    status: 'ACTIVE',
    job_context_ref: requiredString(input.job_context_ref, 'job_context_ref', 'INVALID_REPORT_SESSION'),
    created_at: createdAt,
    updated_at: createdAt,
    audit_event_ids: [],
    evidence_ids: [],
    transcript_ids: [],
    transcript_review_ids: [],
    evidence_span_ids: [],
    field_candidate_ids: [],
    guidance_upload_ids: [],
    guidance_context_ids: [],
    agent_run_ids: [],
    current_agent_run_id: null,
    validation_ref: null,
    confirmation_ref: null,
    snapshot_ref: null,
    recovery_phase: null,
    last_error: null,
  });
}

export function appendReportSessionEvent(session, command = {}) {
  if (!session || session.contract !== 'ReportSession' || session.authority !== 'SERVER') {
    throw new ContractValidationError('A server-authoritative ReportSession is required.', 'INVALID_REPORT_SESSION');
  }
  assertExpectedRevision(session, command.expected_revision);
  const occurredAt = requiredTimestamp(command.occurred_at, 'occurred_at', 'INVALID_SESSION_EVENT');
  const eventType = requiredString(command.event_type, 'event_type', 'INVALID_SESSION_EVENT');
  const nextRevision = session.revision + 1;
  const event = createAuditEvent({
    session_id: session.session_id,
    revision: nextRevision,
    event_type: eventType,
    principal_ref: command.principal_ref,
    occurred_at: occurredAt,
    payload: copy(command.details || {}),
  });
  const next = deepFreeze({
    ...copy(session),
    revision: nextRevision,
    updated_at: occurredAt,
    audit_event_ids: [...session.audit_event_ids, event.event_id],
  });
  return deepFreeze({ session: next, event });
}

export function assertExpectedRevision(session, expectedRevision) {
  const expected = Number(expectedRevision);
  const actual = Number(session?.revision);
  if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(actual) || expected !== actual) {
    throw new StaleRevisionError(expectedRevision, session?.revision);
  }
  return true;
}

function errorRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractValidationError('Recoverable transitions require an error object.', 'INVALID_RECOVERABLE_ERROR');
  }
  return {
    code: requiredString(input.code, 'error.code', 'INVALID_RECOVERABLE_ERROR'),
    message: requiredString(input.message, 'error.message', 'INVALID_RECOVERABLE_ERROR'),
    retryable: true,
  };
}

export function transitionReportSession(session, command = {}) {
  if (!session || session.contract !== 'ReportSession' || session.authority !== 'SERVER') {
    throw new ContractValidationError('A server-authoritative ReportSession is required.', 'INVALID_REPORT_SESSION');
  }
  assertExpectedRevision(session, command.expected_revision);
  const toPhase = requiredString(command.to_phase, 'to_phase', 'INVALID_PHASE_TRANSITION');
  if (!SESSION_PHASES.includes(toPhase)) throw new InvalidTransitionError(session.phase, toPhase);
  const occurredAt = requiredTimestamp(command.occurred_at, 'occurred_at', 'INVALID_PHASE_TRANSITION');
  const nextRevision = session.revision + 1;
  let eventType = command.event_type || 'PHASE_TRANSITION';
  let recoveryPhase = null;
  let lastError = null;

  if (session.phase === 'RECOVERABLE_ERROR') {
    if (toPhase !== session.recovery_phase) {
      throw new InvalidTransitionError(session.phase, toPhase, 'INVALID_RECOVERY_TRANSITION');
    }
    eventType = 'SESSION_RECOVERED';
  } else if (toPhase === 'RECOVERABLE_ERROR') {
    if (!ERRORABLE_PHASES.has(session.phase)) throw new InvalidTransitionError(session.phase, toPhase);
    recoveryPhase = session.phase;
    lastError = errorRecord(command.error);
    eventType = 'RECOVERABLE_ERROR_RECORDED';
  } else if (!ALLOWED_TRANSITIONS[session.phase]?.includes(toPhase)) {
    throw new InvalidTransitionError(session.phase, toPhase);
  }

  const event = createAuditEvent({
    session_id: session.session_id,
    revision: nextRevision,
    event_type: eventType,
    occurred_at: occurredAt,
    payload: {
      ...copy(command.details || {}),
      from_phase: session.phase,
      to_phase: toPhase,
      ...(lastError ? { error: lastError, recovery_phase: recoveryPhase } : {}),
    },
  });
  const next = deepFreeze({
    ...copy(session),
    revision: nextRevision,
    phase: toPhase,
    status: toPhase === 'CONFIRMED' ? 'CONFIRMED' : toPhase === 'RECOVERABLE_ERROR' ? 'ERROR' : 'ACTIVE',
    updated_at: occurredAt,
    audit_event_ids: [...session.audit_event_ids, event.event_id],
    recovery_phase: toPhase === 'RECOVERABLE_ERROR' ? recoveryPhase : null,
    last_error: toPhase === 'RECOVERABLE_ERROR' ? lastError : null,
    confirmation_ref: command.confirmation_ref || session.confirmation_ref || null,
    validation_ref: command.validation_ref || session.validation_ref || null,
    snapshot_ref: command.snapshot_ref || session.snapshot_ref || null,
  });
  return deepFreeze({ session: next, event });
}

export const reportSessionTransitions = ALLOWED_TRANSITIONS;
