import { FIELD_STATES, SUPPORT_TYPES } from './constants.js';
import {
  ContractValidationError,
  canonicalJson,
  contentAddressedId,
  copy,
  deepFreeze,
  enumValue,
  evidenceRefs,
  requiredString,
  stringArray,
} from './contract-utils.js';

const CLAIM_KINDS = Object.freeze(['VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE']);
const CANDIDATE_ASSESSMENTS = Object.freeze(['VALID', 'UNCERTAIN', 'INVALID']);
const RISK_CLASSES = Object.freeze(['STANDARD', 'CRITICAL']);
const CONFIDENCE_CLASSES = Object.freeze(['DIRECT_EVIDENCE', 'UNCERTAIN', 'INFERRED', 'CONFIRMED']);

function candidateBinding(input, name, keys, code) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractValidationError(`${name} is required.`, code);
  }
  return Object.fromEntries(keys.map((key) => [
    key,
    requiredString(input[key], `${name}.${key}`, code),
  ]));
}

function rejectGuidanceReferences(references, sourceRef) {
  if (references.some((reference) => reference.evidence_id.startsWith('guidance_'))
    || String(sourceRef || '').startsWith('guidance_')) {
    throw new ContractValidationError(
      'GuidanceContext cannot be relabelled or serialized as job evidence.',
      'GUIDANCE_NOT_JOB_EVIDENCE',
    );
  }
}

function normalizeClaim(input, code) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractValidationError('claim must be an object.', code);
  }
  const kind = enumValue(input.kind, CLAIM_KINDS, 'claim.kind', code);
  if (kind === 'VALUE') {
    if (!Object.hasOwn(input, 'value') || input.value === null || input.value === undefined || (typeof input.value === 'string' && !input.value.trim())) {
      throw new ContractValidationError('VALUE claims require a non-empty value.', code);
    }
    return { kind, value: copy(input.value) };
  }
  if (Object.hasOwn(input, 'value')) {
    throw new ContractValidationError(`${kind} claims cannot carry a value.`, code);
  }
  return { kind };
}

function candidateBody(input, supportType, confirmation = {}) {
  const code = 'INVALID_FIELD_CANDIDATE';
  const references = evidenceRefs(input.evidence_refs || [], 'evidence_refs', code);
  const claim = normalizeClaim(input.claim, code);
  if (supportType !== 'AI_INFERENCE' && references.length === 0) {
    throw new ContractValidationError(`${supportType} requires at least one immutable evidence reference.`, code);
  }
  const sourceRef = input.source_ref ? requiredString(input.source_ref, 'source_ref', code) : null;
  rejectGuidanceReferences(references, sourceRef);
  const resolution = input.resolution === undefined || input.resolution === null ? null : {
    resolution_id: requiredString(input.resolution.resolution_id, 'resolution.resolution_id', code),
    issue_ids: stringArray(input.resolution.issue_ids || [], 'resolution.issue_ids', { code }),
    resolved_candidate_ids: stringArray(input.resolution.resolved_candidate_ids || [], 'resolution.resolved_candidate_ids', { code }),
    answer_kind: requiredString(input.resolution.answer_kind, 'resolution.answer_kind', code),
  };
  const correctionProvenance = input.correction_provenance === undefined || input.correction_provenance === null ? null : {
    transcript_review_id: requiredString(input.correction_provenance.transcript_review_id, 'correction_provenance.transcript_review_id', code),
    raw_text_hash: requiredString(input.correction_provenance.raw_text_hash, 'correction_provenance.raw_text_hash', code),
    effective_projection_hash: requiredString(input.correction_provenance.effective_projection_hash, 'correction_provenance.effective_projection_hash', code),
    decisions: (input.correction_provenance.decisions || []).map((decision, index) => ({
      review_item_id: requiredString(decision?.review_item_id, `correction_provenance.decisions[${index}].review_item_id`, code),
      decision: enumValue(decision?.decision, ['ACCEPT'], `correction_provenance.decisions[${index}].decision`, code),
    })),
  };
  if (correctionProvenance) {
    for (const key of ['raw_text_hash', 'effective_projection_hash']) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(correctionProvenance[key])) {
        throw new ContractValidationError(`correction_provenance.${key} must be a SHA-256 digest.`, code);
      }
    }
    if (!correctionProvenance.decisions.length) {
      throw new ContractValidationError('correction_provenance requires at least one accepted decision.', code);
    }
  }
  return {
    contract: 'FieldCandidate',
    contract_version: '1',
    session_id: requiredString(input.session_id, 'session_id', code),
    field_id: requiredString(input.field_id, 'field_id', code),
    claim,
    unit: input.unit === undefined || input.unit === null
      ? (claim.kind === 'VALUE' && claim.value && typeof claim.value === 'object' && claim.value.unit
          ? requiredString(claim.value.unit, 'claim.value.unit', code)
          : null)
      : requiredString(input.unit, 'unit', code),
    support_type: supportType,
    assessment: enumValue(input.assessment || 'VALID', CANDIDATE_ASSESSMENTS, 'assessment', code),
    evidence_refs: references,
    source_ref: sourceRef,
    extraction: candidateBinding(input.extraction, 'extraction', ['method', 'version'], code),
    risk_class: enumValue(input.risk_class, RISK_CLASSES, 'risk_class', code),
    confidence_class: enumValue(input.confidence_class, CONFIDENCE_CLASSES, 'confidence_class', code),
    source_context: candidateBinding(
      input.source_context,
      'source_context',
      ['domain', 'context_id', 'context_version', 'scope_id'],
      code,
    ),
    correction_provenance: correctionProvenance,
    confirmation_requirement_ids: stringArray(input.confirmation_requirement_ids || [], 'confirmation_requirement_ids', { code }),
    resolution,
    ...confirmation,
  };
}

export function createFieldCandidate(input = {}) {
  const supportType = enumValue(input.support_type, SUPPORT_TYPES, 'support_type', 'INVALID_FIELD_CANDIDATE');
  if (supportType === 'TECHNICIAN_CONFIRMATION') {
    throw new ContractValidationError(
      'Client input cannot establish technician confirmation; a server-issued confirmation event is required.',
      'UNTRUSTED_TECHNICIAN_CONFIRMATION',
    );
  }
  if (supportType === 'RAG_GUIDANCE') {
    throw new ContractValidationError(
      'GuidanceContext cannot be used as job evidence or become a report fact directly.',
      'GUIDANCE_NOT_JOB_EVIDENCE',
    );
  }
  const body = candidateBody(input, supportType);
  return deepFreeze({ candidate_id: contentAddressedId('candidate', body, input.candidate_id), ...body });
}

export function createConfirmedFieldCandidate(input = {}, { confirmation_event: event } = {}) {
  if (!event || event.contract !== 'AuditEvent' || event.event_type !== 'TECHNICIAN_CONFIRMATION'
    || event.issued_by !== 'SERVER' || !event.event_id || !event.principal_ref
    || event.payload?.field_id !== input.field_id) {
    throw new ContractValidationError(
      'Technician confirmation requires a matching server-issued AuditEvent.',
      'INVALID_CONFIRMATION_EVENT',
    );
  }
  const sessionId = requiredString(input.session_id, 'session_id', 'INVALID_FIELD_CANDIDATE');
  const confirmedCandidateId = requiredString(input.confirmed_candidate_id, 'confirmed_candidate_id', 'INVALID_FIELD_CANDIDATE');
  if (event.session_id !== sessionId || event.payload?.candidate_id !== confirmedCandidateId) {
    throw new ContractValidationError(
      'Technician confirmation event belongs to another session or candidate.',
      'CONFIRMATION_BINDING_MISMATCH',
    );
  }
  const body = candidateBody(input, 'TECHNICIAN_CONFIRMATION', {
    confirmation_event_id: event.event_id,
    technician_principal_ref: event.principal_ref,
    confirmed_candidate_id: confirmedCandidateId,
  });
  return deepFreeze({ candidate_id: contentAddressedId('candidate', body, input.candidate_id), ...body });
}

export function createReportField(input = {}) {
  const code = 'INVALID_REPORT_FIELD';
  const sessionId = requiredString(input.session_id, 'session_id', code);
  const fieldId = requiredString(input.field_id, 'field_id', code);
  if (!Array.isArray(input.candidates)) throw new ContractValidationError('candidates must be an array.', code);
  const candidates = input.candidates.map((candidate, index) => {
    if (!candidate || candidate.contract !== 'FieldCandidate' || candidate.field_id !== fieldId) {
      throw new ContractValidationError(`candidates[${index}] must be a FieldCandidate for ${fieldId}.`, code);
    }
    if (candidate.session_id !== sessionId) {
      throw new ContractValidationError(`candidates[${index}] belongs to another ReportSession.`, 'CROSS_SESSION_CANDIDATE');
    }
    rejectGuidanceReferences(candidate.evidence_refs || [], candidate.source_ref);
    if (candidate.support_type === 'RAG_GUIDANCE') {
      throw new ContractValidationError('GuidanceContext cannot become a ReportField candidate.', 'GUIDANCE_NOT_JOB_EVIDENCE');
    }
    return copy(candidate);
  });
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidate_id));
  const subset = (values, name) => stringArray(values || [], name, { code }).map((id) => {
    if (!candidateIds.has(id)) throw new ContractValidationError(`${name} contains an unknown candidate.`, code);
    return id;
  });
  const activeCandidateIds = input.active_candidate_ids === undefined
    ? candidates.map((candidate) => candidate.candidate_id)
    : subset(input.active_candidate_ids, 'active_candidate_ids');
  const supersededCandidateIds = subset(input.superseded_candidate_ids, 'superseded_candidate_ids');
  const invalidCandidateIds = new Set(subset(input.invalid_candidate_ids, 'invalid_candidate_ids'));
  const active = candidates.filter((candidate) => activeCandidateIds.includes(candidate.candidate_id));
  let state = 'UNKNOWN';
  let value = null;
  let unit = null;
  let selectedCandidateIds = [];
  if (active.length) {
    const reliable = active.filter((candidate) => candidate.support_type !== 'AI_INFERENCE');
    const considered = reliable.length ? reliable : active;
    const distinctClaims = new Set(considered.map((candidate) => canonicalJson(candidate.claim)));
    if (distinctClaims.size > 1) {
      state = 'CONFLICT';
    } else if (considered.some((candidate) => candidate.assessment === 'INVALID' || invalidCandidateIds.has(candidate.candidate_id))) {
      state = 'INVALID';
    } else if (considered.some((candidate) => candidate.assessment === 'UNCERTAIN')) {
      state = 'UNCERTAIN';
    } else {
      const claim = considered[0].claim;
      if (claim.kind === 'EXPLICIT_NONE') state = 'EXPLICIT_NONE';
      else if (claim.kind === 'NOT_APPLICABLE') state = 'NOT_APPLICABLE';
      else if (considered.every((candidate) => candidate.support_type === 'AI_INFERENCE')) state = 'INFERRED';
      else state = 'KNOWN_VALUE';
      if (claim.kind === 'VALUE') {
        const composite = claim.value && typeof claim.value === 'object' && !Array.isArray(claim.value)
          && Object.hasOwn(claim.value, 'value')
          ? claim.value
          : { value: claim.value, unit: considered[0].unit };
        value = copy(composite.value);
        unit = composite.unit || considered[0].unit || null;
      }
      selectedCandidateIds = considered
        .filter((candidate) => canonicalJson(candidate.claim) === canonicalJson(claim))
        .map((candidate) => candidate.candidate_id);
    }
  }
  if (!FIELD_STATES.includes(state)) throw new ContractValidationError(`Unknown field state: ${state}.`, code);
  return deepFreeze({
    contract: 'ReportField',
    contract_version: '1',
    session_id: sessionId,
    field_id: fieldId,
    state,
    value,
    unit,
    candidate_ids: candidates.map((candidate) => candidate.candidate_id),
    active_candidate_ids: activeCandidateIds,
    superseded_candidate_ids: supersededCandidateIds,
    selected_candidate_ids: selectedCandidateIds,
    candidates,
  });
}

export const fieldContractEnums = deepFreeze({
  CLAIM_KINDS,
  CANDIDATE_ASSESSMENTS,
  RISK_CLASSES,
  CONFIDENCE_CLASSES,
});
