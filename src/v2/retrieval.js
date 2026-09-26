import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIsolation, allowedScopes, resolveContext, ScopeIsolationError } from './scope.js';
import { tokenize, UPLOAD_STATUS } from './upload.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultKnowledgeRoot = path.join(projectRoot, 'data', 'knowledge');

const CROSS_DOMAIN_BLOCKED = 'CROSS_DOMAIN_BLOCKED';

/**
 * Flattens a knowledge-record field into plain searchable text. Arrays are
 * joined with ', '; objects are flattened to "key: value" pairs joined with
 * spaces (nested values flattened recursively); scalars are String()-ified.
 */
function flattenValue(value) {
  if (Array.isArray(value)) return value.map(flattenValue).join(', ');
  if (value != null && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${flattenValue(entry)}`)
      .join(' ');
  }
  return String(value ?? '');
}

function serializeKnowledgeRecord(record) {
  if (record == null) return '';
  const parts = [];
  for (const key of ['id', 'name', 'description', 'category', 'risk', 'canonical']) {
    if (record[key] != null && String(record[key]).trim()) parts.push(String(record[key]).trim());
  }
  if (Array.isArray(record.terms)) parts.push(record.terms.map(String).join(', '));
  if (Array.isArray(record.aliases)) parts.push(record.aliases.map(String).join(', '));
  if (Array.isArray(record.parts)) parts.push(record.parts.map((item) => serializeKnowledgeRecord(item)).join('; '));
  // Structured field coverage: attributes / normalization_rules /
  // allowed_spec_patterns carry searchable spec text (e.g. "engine: D 2066",
  // "euro_class: Euro VI"); correction_rules contribute their source/target
  // text so ASR-correction knowledge is also retrievable.
  if (record.attributes != null && typeof record.attributes === 'object' && !Array.isArray(record.attributes)) {
    const text = flattenValue(record.attributes);
    if (text.trim()) parts.push(text.trim());
  }
  if (record.normalization_rules != null) {
    const text = flattenValue(record.normalization_rules);
    if (text.trim()) parts.push(text.trim());
  }
  if (Array.isArray(record.allowed_spec_patterns)) {
    const text = record.allowed_spec_patterns.map(String).join(', ');
    if (text.trim()) parts.push(text.trim());
  }
  if (Array.isArray(record.correction_rules)) {
    const text = record.correction_rules
      .map((rule) => {
        const source = rule?.source != null ? String(rule.source).trim() : '';
        const target = rule?.target != null ? String(rule.target).trim() : '';
        return [source, target].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join(', ');
    if (text.trim()) parts.push(text.trim());
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text || JSON.stringify(record);
}

async function readKnowledgeDocument(filename, scopeId, knowledgeRoot, fsModule) {
  const absolute = path.resolve(knowledgeRoot, filename);
  const raw = await fsModule.readFile(absolute, 'utf8');
  const document = JSON.parse(raw);
  const records = document.records || [...(document.fixed_sections || []), ...(document.conditional_sections || [])];
  return {
    schema_version: String(document.schema_version || 'unknown'),
    knowledge_version: String(document.knowledge_version || 'unknown'),
    records: Array.isArray(records) ? records : [],
  };
}

async function knowledgeCandidates({ contextId, registry, knowledgeRoot, fsModule }) {
  const allowed = new Set(allowedScopes(contextId, registry));
  const candidates = [];
  const warnings = [];
  for (const [scopeId, files] of Object.entries(registry?.knowledge_files || {})) {
    // Hierarchical scopes (GLOBAL/ORGANIZATION/SBS) carry an empty file list;
    // they are not leak sources, so they must not produce CROSS_DOMAIN_BLOCKED.
    if (Array.isArray(files) && files.length > 0 && !allowed.has(scopeId)) {
      warnings.push(CROSS_DOMAIN_BLOCKED);
      continue;
    }
    for (const file of Array.isArray(files) ? files : []) {
      let document;
      try {
        document = await readKnowledgeDocument(file, scopeId, knowledgeRoot, fsModule);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          warnings.push(`KNOWLEDGE_FILE_MISSING:${file}`);
          continue;
        }
        throw error;
      }
      document.records.forEach((record, index) => {
        const text = serializeKnowledgeRecord(record);
        if (!text) return;
        const recordKey = record?.id != null ? String(record.id) : String(index);
        candidates.push({
          source: 'knowledge',
          scope_id: scopeId,
          doc_id: file,
          chunk_id: `knowledge:${scopeId}:${file}:${recordKey}`,
          text,
          provenance: {
            file,
            scope_id: scopeId,
            schema_version: document.schema_version,
            knowledge_version: document.knowledge_version,
          },
        });
      });
    }
  }
  return { candidates, warnings };
}

async function uploadCandidates({ contextId, registry, uploadStore, permittedUploadIds }) {
  const allowed = new Set(allowedScopes(contextId, registry));
  const permitted = permittedUploadIds === undefined
    ? null
    : new Set((permittedUploadIds || []).map(String));
  const candidates = [];
  const warnings = [];
  const uploads = await uploadStore.list({});
  for (const upload of uploads) {
    if (upload.status !== UPLOAD_STATUS.READY) continue;
    if (permitted && !permitted.has(upload.upload_id)) continue;
    const candidateScopeId = `USER_UPLOADED:${upload.scope_id}`;
    if (!allowed.has(candidateScopeId)) {
      warnings.push(CROSS_DOMAIN_BLOCKED);
      continue;
    }
    const chunks = await uploadStore.getChunks(upload.upload_id);
    chunks.forEach((chunk) => {
      candidates.push({
        source: 'upload',
        scope_id: upload.scope_id,
        doc_id: upload.upload_id,
        chunk_id: `${upload.upload_id}:chunk:${chunk.index}`,
        text: String(chunk?.text ?? ''),
        provenance: {
          file: upload.filename,
          scope_id: upload.scope_id,
          uploaded_at: upload.provenance?.uploaded_at,
          source: upload.provenance?.source,
          uploader: upload.provenance?.uploader,
          scenario: upload.provenance?.scenario,
          report_session_id: upload.provenance?.report_session_id,
          document_version: upload.document_version || `sha256:${upload.sha256}`,
        },
      });
    });
  }
  return { candidates, warnings };
}

function scoreChunk(text, queryTerms, rawQuery = '') {
  const terms = tokenize(text);
  if (terms.length === 0 || queryTerms.length === 0) return { score: 0, matchedTerms: [] };
  const termSet = new Set(terms);
  const uniqueQueryTerms = [...new Set(queryTerms)];
  const matchedTerms = uniqueQueryTerms.filter((term) => termSet.has(term));
  const coverage = matchedTerms.length / uniqueQueryTerms.length;
  const density = matchedTerms.length / Math.sqrt(terms.length);
  // Exact mixed letter/number identifiers (C751A, SBS6025J, GB50253) are
  // substantially more discriminative than generic words such as "car" or
  // "inspection". Reward exact identity matches so a nearby asset family
  // cannot outrank the explicitly dictated identifier merely by being short.
  const identifierTerms = uniqueQueryTerms.filter((term) => /[a-z]/iu.test(term) && /\d/u.test(term) && term.length >= 3);
  const identifierMatches = identifierTerms.filter((term) => termSet.has(term));
  const identifierBonus = identifierMatches.length * 0.35;
  const normalizedQuery = String(rawQuery).toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedText = String(text).toLowerCase().replace(/\s+/g, ' ');
  const phraseBonus = normalizedQuery.length >= 3 && normalizedText.includes(normalizedQuery) ? 0.5 : 0;
  return {
    score: coverage + (0.25 * density) + phraseBonus + identifierBonus,
    matchedTerms,
  };
}

/**
 * Scope-gated retrieval. Every candidate source — a knowledge file's scope
 * or an upload's USER_UPLOADED:<scope> — is checked against the context's
 * isolation list through assertIsolation; any forbidden source is hard
 * blocked (critical-error classes 8/10): it contributes zero results and
 * records a 'CROSS_DOMAIN_BLOCKED' warning. Cross-domain content is never
 * returned.
 *
 * @param {{ registry: object, uploadStore?: object, knowledgeRoot?: string, fsModule?: object }} [options]
 * @returns {(params: { contextId: string, query?: string, topK?: number, includeUploads?: boolean, permittedUploadIds?: string[] }) => Promise<{ results: object[], warnings: string[] }>}
 */
export function createRetriever({ registry, uploadStore, knowledgeRoot = defaultKnowledgeRoot, fsModule = fs } = {}) {
  if (!registry || typeof registry !== 'object') throw new TypeError('createRetriever requires a scope registry.');
  return async function retrieve({ contextId, query = '', topK = 5, includeUploads = true, permittedUploadIds } = {}) {
    const context = String(contextId ?? '');
    const resolved = resolveContext(context, registry);
    const limit = Math.max(0, Math.floor(Number(topK) || 0));
    const queryTerms = tokenize(query);
    const warnings = [];

    const { candidates: knowledgeItems, warnings: knowledgeWarnings } = await knowledgeCandidates({
      contextId: context,
      registry,
      knowledgeRoot,
      fsModule,
    });
    warnings.push(...knowledgeWarnings);

    let uploadItems = [];
    if (includeUploads && uploadStore) {
      const { candidates: uploadCands, warnings: uploadWarnings } = await uploadCandidates({
        contextId: context,
        registry,
        uploadStore,
        permittedUploadIds,
      });
      uploadItems = uploadCands;
      warnings.push(...uploadWarnings);
    }

    // assertIsolation re-check doubles as the hard gate even if a source was
    // somehow added by a future caller: forbidden sources must yield 0 hits.
    const combined = [];
    for (const candidate of [...knowledgeItems, ...uploadItems]) {
      try {
        assertIsolation({
          contextId: context,
          candidateScopeId: candidate.source === 'upload' ? `USER_UPLOADED:${candidate.scope_id}` : candidate.scope_id,
          registry,
        });
        combined.push(candidate);
      } catch (error) {
        if (error instanceof ScopeIsolationError) {
          warnings.push(CROSS_DOMAIN_BLOCKED);
        } else {
          throw error;
        }
      }
    }

    const scored = combined
      .map((candidate) => {
        const scoring = scoreChunk(candidate.text, queryTerms, query);
        return { ...candidate, score: scoring.score, matched_terms: scoring.matchedTerms };
      })
      .filter((candidate) => queryTerms.length === 0 || candidate.score > 0);

    scored.sort((a, b) => b.score - a.score || String(a.chunk_id).localeCompare(String(b.chunk_id)));

    const results = scored.slice(0, limit).map((candidate) => Object.freeze({
      source: candidate.source,
      scope_id: candidate.scope_id,
      doc_id: candidate.doc_id,
      chunk_id: candidate.chunk_id,
      text: candidate.text,
      score: candidate.score,
      matched_terms: Object.freeze([...(candidate.matched_terms || [])]),
      provenance: Object.freeze({ ...candidate.provenance }),
    }));

    return Object.freeze({
      results: Object.freeze(results),
      warnings: Object.freeze([...new Set(warnings)]),
    });
  };
}
