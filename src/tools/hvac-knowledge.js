import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashValue } from './report-integrity.js';
import { boundedString, toolEnvelope, toolFailure } from './tool-envelope.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultKnowledgeRoot = path.join(projectRoot, 'data', 'knowledge');
const defaultTemplateRoot = path.join(projectRoot, 'data', 'templates');
const QUERY_FILES = Object.freeze({
  TERM_NORMALIZATION: 'hvac-terms.v1.json',
  PART_CATALOG: 'hvac-parts.v1.json',
  REPORT_MODULES: 'report-modules.v1.json',
});

const cache = new Map();

async function readVersionedJson(filename, root) {
  const absolute = path.join(root, filename);
  if (!cache.has(absolute)) cache.set(absolute, fs.readFile(absolute, 'utf8').then(JSON.parse));
  return cache.get(absolute);
}

function tokens(value) {
  return boundedString(value, 2_000).toLocaleLowerCase().split(/[\s,，。；;:：/]+/u).filter(Boolean);
}

export async function retrieveHvacKnowledge({ queryType, query = '', filters = {}, traceId, knowledgeRoot = defaultKnowledgeRoot } = {}) {
  try {
    const filename = QUERY_FILES[String(queryType || '')];
    if (!filename) return toolEnvelope('retrieve_hvac_knowledge', traceId, 'FAIL', {}, { error_code: 'INVALID_QUERY_TYPE' });
    const document = await readVersionedJson(filename, knowledgeRoot);
    const queryTokens = tokens(query);
    const records = (document.records || [...(document.fixed_sections || []), ...(document.conditional_sections || [])])
      .filter((record) => {
        if (filters.kind && record.kind !== filters.kind) return false;
        if (queryTokens.length === 0) return true;
        const haystack = JSON.stringify(record).toLocaleLowerCase();
        return queryTokens.some((token) => haystack.includes(token));
      })
      .slice(0, 20);
    return toolEnvelope('retrieve_hvac_knowledge', traceId, 'PASS', {
      query_type: queryType,
      knowledge_version: document.knowledge_version,
      schema_version: document.schema_version,
      records,
    });
  } catch (error) {
    return toolFailure('retrieve_hvac_knowledge', traceId, error, 'KNOWLEDGE_READ_FAILED');
  }
}

export async function retrieveReportModules({ traceId, knowledgeRoot = defaultKnowledgeRoot } = {}) {
  return retrieveHvacKnowledge({ queryType: 'REPORT_MODULES', traceId, knowledgeRoot });
}

function exactOccurrences(text, phrase) {
  const occurrences = [];
  let offset = 0;
  while (phrase && offset <= text.length - phrase.length) {
    const start = text.indexOf(phrase, offset);
    if (start < 0) break;
    occurrences.push({ start, end: start + phrase.length, text: text.slice(start, start + phrase.length) });
    offset = start + Math.max(1, phrase.length);
  }
  return occurrences;
}

export async function buildTranscriptCorrectionCandidates({ rawText, knowledgeRoot = defaultKnowledgeRoot } = {}) {
  const text = boundedString(rawText, 20_000);
  const documents = await Promise.all([
    readVersionedJson('hvac-terms.v1.json', knowledgeRoot),
    readVersionedJson('hvac-parts.v1.json', knowledgeRoot),
  ]);
  const versions = [...new Set(documents.map((document) => String(document.knowledge_version || 'unknown')))].sort();
  const knowledgeVersion = `hvac-corrections@${versions.join('+')}`;
  const candidates = [];
  for (const document of documents) {
    for (const record of document.records || []) {
      for (const rule of record.correction_rules || []) {
        if (!rule?.id || !rule?.source || !rule?.target) continue;
        for (const span of exactOccurrences(text, String(rule.source))) {
          const basis = {
            knowledge_id: String(record.id),
            rule_id: String(rule.id),
            match_basis: String(rule.match_basis || 'CONTROLLED_EXACT_PHRASE'),
            matched_text: span.text,
          };
          candidates.push({
            candidate_id: `candidate_${hashValue({ knowledgeVersion, basis, span, target: rule.target }).slice(7, 31)}`,
            knowledge_version: knowledgeVersion,
            source_span: span,
            candidate: String(rule.target),
            knowledge_ids: [String(record.id)],
            risk: String(record.risk || 'LOW'),
            reason: String(rule.reason || record.description || 'Versioned HVAC knowledge candidate.'),
            match_basis: basis,
          });
        }
      }
    }
  }
  candidates.sort((a, b) => a.source_span.start - b.source_span.start || a.source_span.end - b.source_span.end || a.candidate_id.localeCompare(b.candidate_id));
  return Object.freeze({
    knowledge_version: knowledgeVersion,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
  });
}

export async function loadReportModulesConfig({ knowledgeRoot = defaultKnowledgeRoot } = {}) {
  return readVersionedJson('report-modules.v1.json', knowledgeRoot);
}

export async function loadReportTemplateConfig({ templateRoot = defaultTemplateRoot } = {}) {
  return readVersionedJson('hvac-service-report.v1.json', templateRoot);
}

export async function retrieveReportTemplate({ templateId = 'hvac_service_report', version = '1.0.0', traceId, templateRoot = defaultTemplateRoot } = {}) {
  try {
    if (templateId !== 'hvac_service_report' || version !== '1.0.0') {
      return toolEnvelope('retrieve_report_template', traceId, 'FAIL', {}, { error_code: 'TEMPLATE_NOT_FOUND' });
    }
    const template = await readVersionedJson('hvac-service-report.v1.json', templateRoot);
    return toolEnvelope('retrieve_report_template', traceId, 'PASS', { template });
  } catch (error) {
    return toolFailure('retrieve_report_template', traceId, error, 'TEMPLATE_READ_FAILED');
  }
}

export const paths = Object.freeze({ defaultKnowledgeRoot, defaultTemplateRoot });
