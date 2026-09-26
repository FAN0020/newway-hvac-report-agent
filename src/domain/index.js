export { FIELD_STATES, SESSION_PHASES, SUPPORT_TYPES } from './constants.js';

export {
  ContractValidationError,
  canonicalJson,
  deepFreeze,
  hashContract,
} from './contract-utils.js';

export {
  createEvidence,
  createEvidenceSpan,
  createGuidanceContext,
  createResolutionItem,
  createTranscriptArtifact,
  createTranscriptReview,
  createValidationIssue,
  evidenceContractEnums,
} from './evidence-contracts.js';

export {
  auditContractEnums,
  createAuditEvent,
  createTechnicianConfirmationEvent,
} from './audit-contracts.js';

export {
  createConfirmedFieldCandidate,
  createFieldCandidate,
  createReportField,
  fieldContractEnums,
} from './field-contracts.js';

export {
  InvalidTransitionError,
  StaleRevisionError,
  assertExpectedRevision,
  createReportSession,
  reportSessionTransitions,
  transitionReportSession,
} from './report-session.js';

export {
  createReportSnapshot,
  validatePersistedSnapshot,
} from './report-snapshot.js';

export {
  deserializeReportSession,
  deserializeReportSnapshot,
  serializeContract,
} from './serialization.js';
