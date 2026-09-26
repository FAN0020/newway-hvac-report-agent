import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultRegistryPath = path.join(projectRoot, 'data', 'knowledge', 'v2', 'scope-registry.v1.json');

const UPLOAD_SCOPE_PREFIX = 'USER_UPLOADED:';

/**
 * Raised when a candidate scope is consulted from a context that does not
 * inherit it (critical-error taxonomy class 8: cross-domain knowledge
 * leakage). Carries the offending context/candidate pair and the hard-gate
 * category so callers and tests can assert on the violation without parsing
 * the message.
 */
export class ScopeIsolationError extends Error {
  /**
   * @param {{ contextId: string, candidateScopeId: string }} params
   */
  constructor({ contextId, candidateScopeId }) {
    const context = String(contextId ?? '');
    const candidate = String(candidateScopeId ?? '');
    super(`Scope isolation violation: scope "${candidate}" is not allowed for context "${context}".`);
    this.name = 'ScopeIsolationError';
    this.code = 'SCOPE_ISOLATION';
    this.category = 'CROSS_DOMAIN_LEAKAGE';
    this.contextId = context;
    this.candidateScopeId = candidate;
  }
}

/**
 * Loads and validates the V2 scope registry (schema: scope-registry.v1).
 * Defaults to data/knowledge/v2/scope-registry.v1.json relative to the
 * repository root (located via import.meta.url). Throws a descriptive error
 * when the file is missing or does not carry the expected top-level sections.
 *
 * @param {{ registryPath?: string, fsModule?: object }} [options]
 * @returns {Promise<object>} parsed registry JSON
 */
export async function loadScopeRegistry({ registryPath = defaultRegistryPath, fsModule = fs } = {}) {
  const absolute = path.resolve(String(registryPath || defaultRegistryPath));
  let raw;
  try {
    raw = await fsModule.readFile(absolute, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(
        `V2 scope registry not found at ${absolute}. Expected the file produced by the scope-registry builder ` +
        `(data/knowledge/v2/scope-registry.v1.json).`,
      );
    }
    throw error;
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new Error(`V2 scope registry at ${absolute} is not valid JSON: ${error.message}`);
  }
  if (registry?.schema_version !== 'scope-registry.v1') {
    throw new Error(`V2 scope registry at ${absolute} has unsupported schema_version ${JSON.stringify(registry?.schema_version)}.`);
  }
  for (const section of ['scopes', 'isolation', 'context_ids', 'knowledge_files']) {
    if (!registry[section] || typeof registry[section] !== 'object') {
      throw new Error(`V2 scope registry at ${absolute} is missing required section "${section}".`);
    }
  }
  return registry;
}

function scopeEntry(scopeId, registry) {
  const entry = registry?.scopes?.[scopeId];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Scope "${scopeId}" is not defined in the scope registry.`);
  }
  return entry;
}

/**
 * Resolves a human context id ('SBS/BUS' | 'SBS/RAIL' | 'HVAC') into its
 * scope descriptor. Unknown contexts throw instead of silently degrading to
 * an empty scope.
 *
 * @param {string} contextId
 * @param {object} registry
 * @returns {{ scopeId: string, display: string, uploadAllowed: boolean }}
 */
export function resolveContext(contextId, registry) {
  const context = String(contextId ?? '');
  const scopeId = registry?.context_ids?.[context];
  if (!scopeId) {
    const contextKeys = Object.keys(registry?.context_ids || {});
    throw new Error(`Unknown V2 context "${context}". Expected one of: ${contextKeys.join(', ')}.`);
  }
  const entry = scopeEntry(scopeId, registry);
  return {
    scopeId,
    display: String(entry.display ?? scopeId),
    uploadAllowed: entry.upload_allowed === true,
  };
}

/**
 * Returns the isolation.allowed scope ids for a context, including
 * USER_UPLOADED:<scope> entries. Always returns a fresh copy so callers
 * cannot mutate the registry.
 *
 * @param {string} contextId
 * @param {object} registry
 * @returns {string[]}
 */
export function allowedScopes(contextId, registry) {
  const { scopeId } = resolveContext(contextId, registry);
  const allowed = registry?.isolation?.[scopeId]?.allowed;
  if (!Array.isArray(allowed)) {
    throw new Error(`Scope registry has no isolation.allowed list for scope "${scopeId}".`);
  }
  return allowed.map((item) => String(item));
}

/**
 * Hard gate for classes 8/10 (cross-domain leakage / upload contamination):
 * throws ScopeIsolationError when candidateScopeId is not in the context's
 * allowed set. Returns true when the candidate is allowed.
 *
 * @param {{ contextId: string, candidateScopeId: string, registry: object }} params
 * @returns {boolean}
 */
export function assertIsolation({ contextId, candidateScopeId, registry }) {
  const allowed = allowedScopes(contextId, registry);
  const candidate = String(candidateScopeId ?? '');
  if (!allowed.includes(candidate)) {
    throw new ScopeIsolationError({ contextId, candidateScopeId: candidate });
  }
  return true;
}

/**
 * Parses and validates an upload-bound scope id of the form
 * 'USER_UPLOADED:X', returning the underlying scope id X. Anything else
 * throws, so upload scopes can never be confused with knowledge scopes.
 *
 * @param {string} uploadScopeId
 * @returns {string} the scope id inside the USER_UPLOADED wrapper
 */
export function scopeOfUpload(uploadScopeId) {
  const value = String(uploadScopeId ?? '');
  if (!value.startsWith(UPLOAD_SCOPE_PREFIX)) {
    throw new Error(`Invalid upload scope id "${value}"; expected "USER_UPLOADED:<scopeId>".`);
  }
  const scope = value.slice(UPLOAD_SCOPE_PREFIX.length).trim();
  if (!scope) {
    throw new Error(`Invalid upload scope id "${value}"; the scope part must not be empty.`);
  }
  return scope;
}
