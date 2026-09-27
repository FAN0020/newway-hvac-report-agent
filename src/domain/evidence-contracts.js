import {
  ContractValidationError,
  contentAddressedId,
  copy,
  deepFreeze,
  enumValue,
  evidenceRefs,
  hashContract,
  requiredString,
  requiredTimestamp,
  stringArray,
} from './contract-utils.js';

const EVIDENCE_TYPES = Object.freeze(['AUDIO', 'TRANSCRIPT', 'DOCUMENT', 'MANUAL_INPUT', 'SYSTEM_RECORD']);
const REVIEW_STATUSES = Object.freeze(['PENDING', 'REVIEWED']);
const REVIEW_DECISIONS = Object.freeze(['ACCEPT', 'REJECT', 'EDIT', 'NO_CHANGE']);
const VALIDATION_SEVERITIES = Object.freeze(['INFO', 'WARNING', 'ERROR', 'CRITICAL']);
const RESOLUTION_TYPES = Object.freeze([
  'MISSING',
  'UNCERTAIN',
  'CONFLICT',
  'INVALID',
  'CONDITIONAL_REQUIREMENT',
  'SAFETY_CONFIRMATION',
  'SELECT_CANDIDATE',
  'PROVIDE_VALUE',
  'CONFIRM_VALUE',
  'CORRECT_TRANSCRIPT',
]);
const RESOLUTION_STATUSES = Object.freeze(['OPEN', 'RESOLVED', 'DECLINED']);
const ANSWER_TYPES = Object.freeze(['VALUE', 'SINGLE_SELECT', 'SELECT_OR_PROVIDE', 'CONFIRM_OR_REPLACE', 'SEMANTIC_STATE', 'NONE_OR_VALUE']);

export function createEvidence(input = {}) {
  const code = 'INVALID_EVIDENCE';
  const body = {
    contract: 'Evidence',
    contract_version: '1',
    evidence_type: enumValue(input.evidence_type, EVIDENCE_TYPES, 'evidence_type', code),
    source_hash: requiredString(input.source_hash, 'source_hash', code),
    storage_ref: requiredString(input.storage_ref, 'storage_ref', code),
    created_at: requiredTimestamp(input.created_at, 'created_at', code),
    metadata: copy(input.metadata || {}),
  };
  if (!/^sha256:[a-f0-9]{64}$/u.test(body.source_hash)) {
    throw new ContractValidationError('source_hash must be a SHA-256 digest.', code);
  }
  return deepFreeze({ evidence_id: contentAddressedId('evidence', body, input.evidence_id), ...body });
}

export function createEvidenceSpan(input = {}) {
  const code = 'INVALID_EVIDENCE_SPAN';
  const evidenceId = requiredString(input.evidence_id, 'evidence_id', code);
  const start = Number(input.start_offset);
  const end = Number(input.end_offset);
  const quote = String(input.quote ?? '');
  const sourceText = String(input.source_text ?? '');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || quote.length !== end - start) {
    throw new ContractValidationError('EvidenceSpan requires exact non-empty start/end offsets matching quote length.', code);
  }
  if (sourceText.slice(start, end) !== quote) {
    throw new ContractValidationError('EvidenceSpan quote does not match the source text at the exact offsets.', 'EVIDENCE_SPAN_TEXT_MISMATCH');
  }
  const body = {
    contract: 'EvidenceSpan',
    contract_version: '1',
    evidence_id: evidenceId,
    start_offset: start,
    end_offset: end,
    offset_unit: 'UTF16_CODE_UNIT',
    quote_hash: hashContract(quote),
  };
  return deepFreeze({ span_id: contentAddressedId('span', body, input.span_id), ...body });
}

export function createTranscriptArtifact(input = {}) {
  const code = 'INVALID_TRANSCRIPT_ARTIFACT';
  const rawText = requiredString(input.raw_text, 'raw_text', code);
  const sourceHash = requiredString(input.source_hash, 'source_hash', code);
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceHash)) {
    throw new ContractValidationError('source_hash must be a SHA-256 digest.', code);
  }
  const normalizeBinding = (value, label, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ContractValidationError(`${label} is required.`, code);
    }
    return Object.fromEntries(keys.map((key) => [key, requiredString(value[key], `${label}.${key}`, code)]));
  };
  const segments = (input.segments || []).map((segment, index) => {
    const start = Number(segment?.start_ms);
    const end = Number(segment?.end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new ContractValidationError(`segments[${index}] requires increasing non-negative millisecond offsets.`, code);
    }
    return { start_ms: start, end_ms: end, text: requiredString(segment.text, `segments[${index}].text`, code) };
  });
  const body = {
    contract: 'TranscriptArtifact',
    contract_version: '1',
    session_id: requiredString(input.session_id, 'session_id', code),
    source_evidence_id: requiredString(input.source_evidence_id, 'source_evidence_id', code),
    source_hash: sourceHash,
    raw_text: rawText,
    text_hash: hashContract(rawText),
    language: String(input.language || 'und'),
    provider: requiredString(input.provider, 'provider', code),
    model: requiredString(input.model, 'model', code),
    processing_version: requiredString(input.processing_version, 'processing_version', code),
    template_binding: normalizeBinding(input.template_binding, 'template_binding', ['template_id', 'template_version']),
    context_binding: normalizeBinding(input.context_binding, 'context_binding', ['context_id', 'context_version', 'scope_id']),
    created_at: requiredTimestamp(input.created_at, 'created_at', code),
    segments,
  };
  return deepFreeze({ transcript_id: contentAddressedId('transcript', body, input.transcript_id), ...body });
}

export function createTranscriptReview(input = {}) {
  const code = 'INVALID_TRANSCRIPT_REVIEW';
  const status = enumValue(input.status, REVIEW_STATUSES, 'status', code);
  const transcriptText = String(input.transcript_text ?? '');
  const items = (input.items || []).map((item, index) => {
    const start = Number(item?.source_span?.start);
    const end = Number(item?.source_span?.end);
    const quote = String(item?.source_span?.quote ?? '');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
      || quote.length !== end - start || transcriptText.slice(start, end) !== quote) {
      throw new ContractValidationError(`items[${index}] requires an exact transcript source span.`, code);
    }
    const material = item.material === true;
    return {
      review_item_id: requiredString(item.review_item_id, `items[${index}].review_item_id`, code),
      kind: enumValue(item.kind, ['CORRECTION', 'CONFIRMATION'], `items[${index}].kind`, code),
      material,
      impact_class: enumValue(item.impact_class || (material ? 'MATERIAL' : 'NON_MATERIAL'), ['MATERIAL', 'NON_MATERIAL'], `items[${index}].impact_class`, code),
      affected_fields: stringArray(item.affected_fields || [], `items[${index}].affected_fields`, { code }),
      source_span: { start, end, quote },
      proposed_text: item.proposed_text === null || item.proposed_text === undefined ? null : requiredString(item.proposed_text, `items[${index}].proposed_text`, code),
      category: requiredString(item.category || 'CRITICAL_TERMINOLOGY', `items[${index}].category`, code),
      reason: requiredString(item.reason, `items[${index}].reason`, code),
    };
  });
  const decisions = (input.decisions || []).map((decision, index) => ({
    review_item_id: requiredString(decision?.review_item_id, `decisions[${index}].review_item_id`, code),
    decision: enumValue(decision?.decision, REVIEW_DECISIONS, `decisions[${index}].decision`, code),
    ...(decision?.corrected_text !== undefined ? { corrected_text: String(decision.corrected_text) } : {}),
  }));
  const confirmationRequirements = (input.confirmation_requirements || []).map((item, index) => {
    const start = Number(item?.source_span?.start);
    const end = Number(item?.source_span?.end);
    const quote = String(item?.source_span?.quote ?? '');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
      || quote.length !== end - start || transcriptText.slice(start, end) !== quote) {
      throw new ContractValidationError(`confirmation_requirements[${index}] requires an exact transcript source span.`, code);
    }
    return {
      requirement_id: requiredString(item.requirement_id, `confirmation_requirements[${index}].requirement_id`, code),
      field_id: requiredString(item.field_id, `confirmation_requirements[${index}].field_id`, code),
      source_span: { start, end, quote },
      reason: requiredString(item.reason, `confirmation_requirements[${index}].reason`, code),
    };
  });
  if (items.length) {
    const itemIds = new Set(items.map((item) => item.review_item_id));
    const decisionIds = new Set(decisions.map((decision) => decision.review_item_id));
    if (itemIds.size !== items.length || (status === 'PENDING' && decisions.length !== 0)
      || (status === 'REVIEWED' && (decisionIds.size !== itemIds.size || [...itemIds].some((id) => !decisionIds.has(id))))) {
      throw new ContractValidationError('TranscriptReview decisions must match every unique review item exactly once.', code);
    }
  }
  const body = {
    contract: 'TranscriptReview',
    contract_version: '1',
    session_id: requiredString(input.session_id, 'session_id', code),
    transcript_id: requiredString(input.transcript_id, 'transcript_id', code),
    raw_text_hash: hashContract(transcriptText),
    status,
    items,
    decisions,
    confirmation_requirements: confirmationRequirements,
    effective_projection_hash: status === 'REVIEWED'
      ? requiredString(input.effective_projection_hash || hashContract(transcriptText), 'effective_projection_hash', code)
      : null,
    reviewer_principal_ref: status === 'REVIEWED'
      ? requiredString(input.reviewer_principal_ref, 'reviewer_principal_ref', code)
      : null,
    reviewed_at: status === 'REVIEWED' ? requiredTimestamp(input.reviewed_at, 'reviewed_at', code) : null,
  };
  return deepFreeze({ review_id: contentAddressedId('transcript_review', body, input.review_id), ...body });
}

export function createGuidanceContext(input = {}) {
  const code = 'INVALID_GUIDANCE_CONTEXT';
  const passages = (input.passages || []).map((passage, index) => {
    const score = Number(passage?.score);
    if (!Number.isFinite(score)) throw new ContractValidationError(`passages[${index}].score must be finite.`, code);
    return {
      source_type: enumValue(passage.source_type, ['knowledge', 'upload'], `passages[${index}].source_type`, code),
      scope_id: requiredString(passage.scope_id, `passages[${index}].scope_id`, code),
      document_id: requiredString(passage.document_id, `passages[${index}].document_id`, code),
      chunk_id: requiredString(passage.chunk_id, `passages[${index}].chunk_id`, code),
      document_version: requiredString(passage.document_version, `passages[${index}].document_version`, code),
      text: requiredString(passage.text, `passages[${index}].text`, code),
      score,
      provenance: copy(passage.provenance || {}),
    };
  });
  const followUpQuestions = (input.follow_up_questions || []).map((question, index) => ({
    section_id: requiredString(question.section_id, `follow_up_questions[${index}].section_id`, code),
    field: requiredString(question.field, `follow_up_questions[${index}].field`, code),
    question: requiredString(question.question, `follow_up_questions[${index}].question`, code),
    answer_source: enumValue(
      question.answer_source,
      ['technician_confirmation'],
      `follow_up_questions[${index}].answer_source`,
      code,
    ),
  }));
  const body = {
    contract: 'GuidanceContext',
    contract_version: '1',
    session_id: requiredString(input.session_id, 'session_id', code),
    context_id: requiredString(input.context_id, 'context_id', code),
    scope_id: requiredString(input.scope_id, 'scope_id', code),
    context_version: requiredString(input.context_version, 'context_version', code),
    query: requiredString(input.query, 'query', code),
    retrieval_method: enumValue(input.retrieval_method, ['LEXICAL_DETERMINISTIC'], 'retrieval_method', code),
    retrieval_version: requiredString(input.retrieval_version, 'retrieval_version', code),
    permitted_corpora: stringArray(input.permitted_corpora || [], 'permitted_corpora', { code }),
    retrieved_at: requiredTimestamp(input.retrieved_at, 'retrieved_at', code),
    passages,
    applicable_modules: stringArray(input.applicable_modules || [], 'applicable_modules', { code }),
    follow_up_questions: followUpQuestions,
    support_type: 'RAG_GUIDANCE',
    eligible_as_job_evidence: false,
  };
  return deepFreeze({ guidance_context_id: contentAddressedId('guidance', body, input.guidance_context_id), ...body });
}

export function createValidationIssue(input = {}) {
  const code = 'INVALID_VALIDATION_ISSUE';
  const body = {
    contract: 'ValidationIssue',
    contract_version: '1',
    code: requiredString(input.code, 'code', code),
    issue_type: requiredString(input.issue_type || input.code, 'issue_type', code),
    severity: enumValue(input.severity, VALIDATION_SEVERITIES, 'severity', code),
    blocking: input.blocking === true,
    field_id: input.field_id ? requiredString(input.field_id, 'field_id', code) : null,
    candidate_ids: stringArray(input.candidate_ids || [], 'candidate_ids', { code }),
    evidence_refs: evidenceRefs(input.evidence_refs || [], 'evidence_refs', code),
    reason: requiredString(input.reason || input.message, 'reason', code),
    message: requiredString(input.message || input.reason, 'message', code),
    possible_resolution_type: input.possible_resolution_type
      ? enumValue(input.possible_resolution_type, RESOLUTION_TYPES, 'possible_resolution_type', code)
      : null,
  };
  const issueId = input.issue_id === undefined
    ? contentAddressedId('issue', body)
    : requiredString(input.issue_id, 'issue_id', code);
  return deepFreeze({ issue_id: issueId, ...body });
}

export function createResolutionItem(input = {}) {
  const code = 'INVALID_RESOLUTION_ITEM';
  const issueIds = stringArray(input.issue_ids || (input.issue_id ? [input.issue_id] : []), 'issue_ids', { code });
  if (!issueIds.length) throw new ContractValidationError('ResolutionItem requires at least one issue.', code);
  const priority = Number(input.priority ?? 5);
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 6) {
    throw new ContractValidationError('priority must be an integer from 1 to 6.', code);
  }
  const options = (input.options || []).map((option) => copy(option));
  const body = {
    contract: 'ResolutionItem',
    contract_version: '1',
    issue_id: issueIds[0],
    issue_ids: issueIds,
    type: enumValue(input.type, RESOLUTION_TYPES, 'type', code),
    field_id: requiredString(input.field_id, 'field_id', code),
    candidate_ids: stringArray(input.candidate_ids || [], 'candidate_ids', { code }),
    prompt: requiredString(input.prompt, 'prompt', code),
    reason: requiredString(input.reason || input.prompt, 'reason', code),
    priority,
    priority_class: requiredString(input.priority_class || 'DETERMINISTIC_RULE_VIOLATION', 'priority_class', code),
    answer_type: enumValue(input.answer_type || ({
      SELECT_CANDIDATE: 'SELECT_OR_PROVIDE',
      PROVIDE_VALUE: 'VALUE',
      CONFIRM_VALUE: 'CONFIRM_OR_REPLACE',
      CORRECT_TRANSCRIPT: 'VALUE',
    }[input.type] || 'VALUE'), ANSWER_TYPES, 'answer_type', code),
    options,
    allow_other: input.allow_other === true,
    status: enumValue(input.status, RESOLUTION_STATUSES, 'status', code),
  };
  const resolutionId = input.resolution_id === undefined
    ? contentAddressedId('resolution', body)
    : requiredString(input.resolution_id, 'resolution_id', code);
  return deepFreeze({ resolution_id: resolutionId, ...body });
}

export const evidenceContractEnums = deepFreeze({
  EVIDENCE_TYPES,
  REVIEW_STATUSES,
  REVIEW_DECISIONS,
  VALIDATION_SEVERITIES,
  RESOLUTION_TYPES,
  RESOLUTION_STATUSES,
  ANSWER_TYPES,
});
