import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedString, toolEnvelope, toolFailure } from './tool-envelope.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultIndexPath = path.join(projectRoot, 'data', 'knowledge', 'field-service-rag.v1.json');

let cachedIndex;

function tokenize(value) {
  const text = boundedString(value, 40_000).toLocaleLowerCase();
  const latin = text.match(/[a-z0-9][a-z0-9._/-]*/giu) || [];
  const chineseRuns = text.match(/[\p{Script=Han}]+/gu) || [];
  const chinese = [];
  for (const run of chineseRuns) {
    for (let index = 0; index < run.length; index += 1) {
      chinese.push(run[index]);
      if (index + 1 < run.length) chinese.push(run.slice(index, index + 2));
    }
  }
  return [...latin, ...chinese];
}

function termFrequency(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

async function loadIndex(indexPath = defaultIndexPath) {
  if (!cachedIndex || cachedIndex.path !== indexPath) {
    const document = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    cachedIndex = { path: indexPath, document };
  }
  return cachedIndex.document;
}

function queryFromFacts(facts = []) {
  return facts
    .filter((fact) => fact?.support_status !== 'UNCERTAIN')
    .slice(0, 100)
    .map((fact) => `${fact.field || ''} ${typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)}`)
    .join(' ');
}

function scoreChunks(chunks, queryTokens) {
  const queryCounts = termFrequency(queryTokens);
  const tokenSets = chunks.map((chunk) => new Set(tokenize(`${chunk.title || ''} ${chunk.section || ''} ${(chunk.tags || []).join(' ')} ${chunk.text || ''}`)));
  const documentFrequency = new Map();
  for (const token of queryCounts.keys()) {
    documentFrequency.set(token, tokenSets.reduce((count, set) => count + (set.has(token) ? 1 : 0), 0));
  }
  return chunks.map((chunk, index) => {
    const chunkTokens = tokenize(`${chunk.title || ''} ${chunk.section || ''} ${(chunk.tags || []).join(' ')} ${chunk.text || ''}`);
    const counts = termFrequency(chunkTokens);
    let score = 0;
    const matches = [];
    for (const [token, queryCount] of queryCounts) {
      const frequency = counts.get(token) || 0;
      if (!frequency) continue;
      const inverseDocumentFrequency = Math.log(1 + (chunks.length + 1) / (1 + (documentFrequency.get(token) || 0)));
      score += (1 + Math.log(frequency)) * inverseDocumentFrequency * Math.min(queryCount, 3);
      matches.push(token);
    }
    const normalization = Math.sqrt(Math.max(1, chunkTokens.length));
    return { chunk, score: Number((score / normalization).toFixed(6)), matches: [...new Set(matches)].slice(0, 20) };
  });
}

export async function retrieveFieldServiceKnowledge({
  query = '',
  facts = [],
  domains = [],
  documentIds = [],
  topK = 5,
  traceId,
  indexPath = defaultIndexPath,
} = {}) {
  try {
    const index = await loadIndex(indexPath);
    const normalizedDomains = new Set((Array.isArray(domains) ? domains : [domains]).map(String).filter(Boolean));
    const normalizedDocumentIds = new Set((Array.isArray(documentIds) ? documentIds : [documentIds]).map(String).filter(Boolean));
    const candidates = (index.chunks || []).filter((chunk) => {
      if (normalizedDomains.size && !normalizedDomains.has(String(chunk.domain))) return false;
      if (normalizedDocumentIds.size && !normalizedDocumentIds.has(String(chunk.document_id))) return false;
      return true;
    });
    const effectiveQuery = boundedString(query || queryFromFacts(facts), 20_000);
    const queryTokens = tokenize(effectiveQuery);
    const limit = Math.max(1, Math.min(8, Number(topK) || 5));
    const scored = scoreChunks(candidates, queryTokens)
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || String(a.chunk.chunk_id).localeCompare(String(b.chunk.chunk_id)))
      .slice(0, limit);
    const results = scored.map(({ chunk, score, matches }, rank) => ({
      rank: rank + 1,
      score,
      matched_terms: matches,
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      domain: chunk.domain,
      title: chunk.title,
      section: chunk.section,
      text: chunk.text,
      source: chunk.source,
      source_hash: chunk.source_hash,
      report_sections: chunk.report_sections || [],
    }));
    return toolEnvelope('retrieve_field_service_knowledge', traceId, 'PASS', {
      query: effectiveQuery,
      knowledge_version: index.knowledge_version,
      index_schema_version: index.schema_version,
      result_count: results.length,
      results,
    });
  } catch (error) {
    return toolFailure('retrieve_field_service_knowledge', traceId, error, 'RAG_RETRIEVAL_FAILED');
  }
}

export const ragPaths = Object.freeze({ defaultIndexPath });

