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

function groupCandidatesByContext(candidates, rawText) {
  const sentences = [];
  const pattern = /[^\n。！？；;]+[\n。！？；;]?/gu;
  for (const match of rawText.matchAll(pattern)) {
    const text = match[0].trim();
    if (!text) continue;
    sentences.push({ start: match.index, end: match.index + match[0].length, text });
  }
  return sentences.map(sentence => ({
    sentence: sentence.text,
    start: sentence.start,
    end: sentence.end,
    candidates: candidates.filter(c => c.source_span.start >= sentence.start && c.source_span.end <= sentence.end)
  })).filter(group => group.candidates.length > 0);
}

export async function buildTranscriptCorrectionCandidatesWithContext({ rawText, knowledgeRoot = defaultKnowledgeRoot, provider = null, model = null } = {}) {
  // First: Build baseline candidates (unchanged)
  const baseline = await buildTranscriptCorrectionCandidates({ rawText, knowledgeRoot });
  if (!provider?.generateJson || baseline.candidates.length === 0) {
    return baseline; // No provider or no candidates, return baseline
  }
  try {
    const contextGroups = groupCandidatesByContext([...baseline.candidates], rawText);
    if (contextGroups.length === 0) return baseline;
    const response = await provider.generateJson({
      model,
      system: `You filter HVAC term correction candidates using sentence context. When multiple candidates target the same span or nearby spans, select the most appropriate. Return only candidate_id values from the supplied list. Do not invent candidates, add service facts, or change source spans. Return JSON only.`,
      prompt: JSON.stringify({
        raw_text: rawText,
        candidate_groups: contextGroups.map(group => ({
          sentence: group.sentence,
          sentence_span: { start: group.start, end: group.end },
          candidates: group.candidates.map(c => ({
            candidate_id: c.candidate_id,
            source_span: c.source_span,
            source_text: c.source_span.text,
            candidate: c.candidate,
            reason: c.reason,
            risk: c.risk
          }))
        })),
        disambiguation_hints: {
          numbers_with_units: '数字通常需要单位：35微法→35 µF，220伏→220V',
          brand_vs_generic: '品牌名通常出现在"换""用"等动词后',
          tool_vs_part: '工具在"用X检查"，零件在"更换X"'
        },
        required_output: { retained_candidate_ids: ['candidate_id'] }
      })
    });
    const retainedIds = Array.isArray(response?.data?.retained_candidate_ids) ? response.data.retained_candidate_ids : [];
    const allowedIds = new Set(baseline.candidates.map(c => c.candidate_id));
    const validIds = retainedIds.filter(id => allowedIds.has(String(id)));
    if (validIds.length === 0 || validIds.length === baseline.candidates.length) {
      return baseline; // No filtering or invalid output, return baseline
    }
    const filtered = baseline.candidates.filter(c => validIds.includes(c.candidate_id));
    return Object.freeze({
      knowledge_version: baseline.knowledge_version,
      candidates: Object.freeze(filtered.map(c => Object.freeze(c))),
      context_filtering_applied: true
    });
  } catch (error) {
    return baseline; // Provider error, return baseline
  }
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
