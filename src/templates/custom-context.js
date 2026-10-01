import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_CHUNKS = 256;
const CHUNK_LENGTH = 800;
const error = (message, code) => Object.assign(new Error(message), { code, status: 409 });
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function terms(value) {
  return new Set(String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

export async function loadCustomContext({ session, template }) {
  if (session.template_binding.template_id !== template.templateId
    || session.template_binding.template_version !== template.templateVersion
    || session.context_binding.context_id !== template.contextCorpus?.id
    || session.context_binding.context_version !== template.contextCorpus?.version
    || ((template.contextCorpus.sources || []).length > 0
      && template.contextCorpus.retrievalBoundary !== 'TEMPLATE_VERSION_ONLY')) {
    throw error('ReportSession context does not match the published template version.', 'TEMPLATE_CONTEXT_MISMATCH');
  }
  const chunks = [];
  for (const source of template.contextCorpus.sources || []) {
    if (source.analysisStatus !== 'READY_TEXT' || !/^text\//u.test(source.mimeType || '')) continue;
    if (!/^[a-f0-9]{64}$/u.test(source.sha256 || '') || !source.path
      || !Number.isSafeInteger(source.size) || source.size < 1 || source.size > MAX_DOCUMENT_BYTES) {
      throw error('Template text source metadata is invalid or exceeds the retrieval limit.', 'TEMPLATE_CONTEXT_INVALID');
    }
    let bytes;
    try { bytes = await fs.readFile(source.path); }
    catch { throw error('Template text source is unavailable.', 'TEMPLATE_CONTEXT_UNAVAILABLE'); }
    if (bytes.length !== source.size || digest(bytes) !== source.sha256) {
      throw error('Template text source hash does not match the published version.', 'TEMPLATE_CONTEXT_HASH_MISMATCH');
    }
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw error('Template text source is not valid UTF-8.', 'TEMPLATE_CONTEXT_INVALID'); }
    const text = content.replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    for (let offset = 0; offset < text.length; offset += CHUNK_LENGTH) {
      if (chunks.length >= MAX_CHUNKS) throw error('Template text corpus exceeds the retrieval limit.', 'TEMPLATE_CONTEXT_TOO_LARGE');
      const passage = text.slice(offset, offset + CHUNK_LENGTH).trim();
      if (!passage) continue;
      chunks.push({
        source_type: 'knowledge', scope_id: template.templateId,
        document_id: source.sha256, chunk_id: `${source.sha256}:${offset}`,
        document_version: `${template.templateVersion}:${source.sha256}`,
        text: passage,
        provenance: { filename: source.filename, sha256: source.sha256,
          template_id: template.templateId, template_version: template.templateVersion,
          context_corpus_id: template.contextCorpus.id, context_version: template.contextCorpus.version,
          start_offset: offset, end_offset: offset + passage.length },
      });
    }
  }
  return chunks;
}

export function retrieveCustomContext(chunks, query, topK = 3) {
  const queryTerms = terms(query);
  if (!queryTerms.size) return [];
  return chunks.map((chunk) => {
    const found = terms(chunk.text);
    const hits = [...queryTerms].filter((term) => found.has(term)).length;
    return { ...chunk, score: hits / queryTerms.size };
  }).filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.document_id.localeCompare(b.document_id) || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, Math.min(Math.max(0, topK), 3));
}
