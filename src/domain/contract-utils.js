import crypto from 'node:crypto';

export class ContractValidationError extends TypeError {
  constructor(message, code = 'INVALID_CONTRACT') {
    super(message);
    this.name = 'ContractValidationError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashContract(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function contentId(prefix, value) {
  return `${prefix}_${hashContract(value).slice(7, 31)}`;
}

export function contentAddressedId(prefix, value, providedId) {
  const expected = contentId(prefix, value);
  if (providedId !== undefined && providedId !== null && String(providedId) !== expected) {
    throw new ContractValidationError(`${prefix} identity does not match its immutable content.`, 'CONTENT_ID_MISMATCH');
  }
  return expected;
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function copy(value) {
  return structuredClone(value);
}

export function requiredString(value, label, code = 'INVALID_CONTRACT') {
  const text = String(value ?? '').trim();
  if (!text) throw new ContractValidationError(`${label} is required.`, code);
  return text;
}

export function requiredTimestamp(value, label, code = 'INVALID_CONTRACT') {
  const text = requiredString(value, label, code);
  if (!Number.isFinite(Date.parse(text))) throw new ContractValidationError(`${label} must be an ISO timestamp.`, code);
  return text;
}

export function enumValue(value, allowed, label, code = 'INVALID_CONTRACT') {
  const text = requiredString(value, label, code);
  if (!allowed.includes(text)) {
    throw new ContractValidationError(`${label} must be one of: ${allowed.join(', ')}.`, code);
  }
  return text;
}

export function stringArray(value, label, { allowEmpty = true, code = 'INVALID_CONTRACT' } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new ContractValidationError(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array.`, code);
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`, code));
}

export function evidenceRefs(value, label = 'evidence_refs', code = 'INVALID_CONTRACT') {
  if (!Array.isArray(value)) throw new ContractValidationError(`${label} must be an array.`, code);
  return value.map((reference, index) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new ContractValidationError(`${label}[${index}] must be an object.`, code);
    }
    return {
      evidence_id: requiredString(reference.evidence_id, `${label}[${index}].evidence_id`, code),
      ...(reference.span_id ? { span_id: requiredString(reference.span_id, `${label}[${index}].span_id`, code) } : {}),
    };
  });
}
