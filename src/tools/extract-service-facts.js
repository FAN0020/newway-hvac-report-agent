import { ALLOWED_FACT_FIELDS, MANUAL_ONLY_FIELDS, sanitizeValue } from './hvac-schema.js';
import { boundedString, stableId, toolEnvelope } from './tool-envelope.js';

const NEGATED_ACTION = /(?:没有|没|并未|尚未|未曾|未|无)\s*(?:实际)?\s*(?:进行|完成|做|作)?\s*(?:任何)?\s*(?:更换|换上|使用|安装|清洗|清理|维修|加注|处理|完成)|\b(?:did\s+not|didn't|was\s+not|wasn't|were\s+not|weren't|never)\s+(?:actually\s+)?(?:replace|use|install|clean|clear|repair|recharge|service|complete|perform|test)\w*\b/iu;
const RECOMMENDED_ACTION = /(?:建议|后续|下次|应当|可考虑)[^\n。！？；;]*(?:更换|换上|使用|安装|清洗|清理|维修|加注|处理|完成)|\b(?:recommend(?:ed|ing)?|suggest(?:ed|ing)?|plan(?:ned)?\s+to|will|next\s+visit)[^.!?;\n]{0,120}\b(?:replace|use|install|clean|clear|repair|recharge|service|complete|perform|test)\w*\b/iu;

const CHINESE_QUANTITY = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 });

function sentenceSpans(rawText) {
  const spans = [];
  const pattern = /[^\n。！？；;]+[\n。！？；;]?/gu;
  for (const match of rawText.matchAll(pattern)) {
    const text = match[0].trim();
    if (!text) continue;
    const relative = match[0].indexOf(text);
    spans.push({ start: match.index + relative, end: match.index + relative + text.length, text });
  }
  return spans;
}

function cleanProviderFact(candidate, rawText, index, allowedCorrectionIds = new Set(), correctionReceiptId = null) {
  const field = boundedString(candidate?.field, 80);
  if (!ALLOWED_FACT_FIELDS.has(field) || MANUAL_ONLY_FIELDS.has(field)) return null;
  const start = Number(candidate?.source_span?.start);
  const end = Number(candidate?.source_span?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > rawText.length) return null;
  const sourceText = rawText.slice(start, end);
  if (boundedString(candidate?.source_span?.text, 2_000) !== sourceText) return null;
  if (['work_performed', 'parts_used'].includes(field) && (NEGATED_ACTION.test(sourceText) || RECOMMENDED_ACTION.test(sourceText))) return null;
  const value = sanitizeValue(candidate.value);
  if (value === '' || value === null || value === undefined) return null;
  return {
    fact_id: stableId('fact', field, value, start, end, index),
    field,
    value,
    source_refs: [
      `${correctionReceiptId ? 'confirmed_text' : 'transcript'}:${start}-${end}`,
      ...(correctionReceiptId ? [`correction_receipt:${correctionReceiptId}`] : []),
      ...(Array.isArray(candidate.correction_ids) ? candidate.correction_ids.filter((id) => allowedCorrectionIds.has(String(id))).map((id) => `correction:${id}`) : []),
    ],
    source_span: { start, end, text: sourceText },
    support_status: candidate.support_status === 'UNCERTAIN' ? 'UNCERTAIN' : 'DIRECT_TRANSCRIPT',
  };
}

function inferredPart(sentence, span, confirmedCorrections) {
  if (NEGATED_ACTION.test(sentence) || RECOMMENDED_ACTION.test(sentence) || !/(?:更换|换了|换上|使用|安装).{0,30}电容/u.test(sentence)) return null;
  const directSpec = sentence.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:微法|µF|uF)/iu)?.[1];
  const correction = confirmedCorrections.find((item) => Number(item?.source_span?.start) >= span.start && Number(item?.source_span?.end) <= span.end && /[0-9]+(?:\.[0-9]+)?\s*(?:µF|uF)/iu.test(String(item?.candidate || '')));
  const correctedSpec = String(correction?.candidate || '').match(/([0-9]+(?:\.[0-9]+)?)\s*(?:µF|uF)/iu)?.[1];
  const spec = directSpec || correctedSpec;
  const quantityMatch = sentence.match(/([0-9]+|[一二两三四五六七八九十])\s*(?:个|只|件)/u)?.[1];
  const quantity = quantityMatch ? (CHINESE_QUANTITY[quantityMatch] || Number(quantityMatch)) : null;
  return {
    action: '更换',
    name: '电容',
    ...(spec ? { specification: `${spec} µF` } : {}),
    ...(Number.isFinite(quantity) ? { quantity } : {}),
    correction_id: correction?.correction_id || null,
  };
}

function heuristicFacts(rawText, confirmedCorrections = []) {
  const candidates = [];
  for (const span of sentenceSpans(rawText)) {
    const text = span.text;
    const add = (field, value, uncertain = false) => candidates.push({ field, value, source_span: span, support_status: uncertain ? 'UNCERTAIN' : 'DIRECT_TRANSCRIPT' });
    const complaint = text.match(/(?:客户(?:反映|说|报告)|报修)[：:,，\s]*(.+)/u)?.[1];
    if (complaint) add('customer_complaint', complaint.replace(/[\n。！？；;]+$/u, ''));
    const finding = text.match(/(?:检查(?:发现|结果)?|现场发现|发现)[：:,，\s]*(.+)/u)?.[1];
    if (finding) add('inspection_findings', finding.replace(/[\n。！？；;]+$/u, ''));
    if (/\b(?:I|we)\s+(?:found|observed)\b|\binspection\s+(?:found|showed|revealed)\b/iu.test(text)) {
      add('inspection_findings', text.replace(/[\n。！？；;]+$/u, ''));
    }
    if (!NEGATED_ACTION.test(text) && !RECOMMENDED_ACTION.test(text) && /(?:已(?:更换|清洗|清理|维修|疏通|紧固|完成)|完成了|进行了|更换|换了|换上|清洗|清理|维修|疏通|紧固)/u.test(text)) {
      add('work_performed', text.replace(/[\n。！？；;]+$/u, ''));
    }
    if (!NEGATED_ACTION.test(text) && !RECOMMENDED_ACTION.test(text) && /\b(?:I|we)\s+(?:actually\s+)?(?:replaced|installed|cleaned|cleared|repaired|recharged|serviced|tightened|reset|unblocked|completed|performed)\b/iu.test(text)) {
      add('work_performed', text.replace(/[\n。！？；;]+$/u, ''));
    }
    const part = inferredPart(text, span, confirmedCorrections);
    if (part) {
      const correctionId = part.correction_id;
      delete part.correction_id;
      candidates.push({ field: 'parts_used', value: part, source_span: span, support_status: 'DIRECT_TRANSCRIPT', correction_ids: correctionId ? [correctionId] : [] });
    }
    if (/(?:测试|试机|测量|运行)[^\n。！？；;]*(?:正常|异常|通过|失败|可以|不能|温度|压力|电流)/u.test(text)) {
      add('test_results', text.replace(/[\n。！？；;]+$/u, ''));
    }
    if (/\b(?:test(?:ed|ing)?|ran\s+(?:an?\s+)?[\w-]+\s+test|performed\s+(?:an?\s+)?[\w-]+\s+test)\b[^.!?;\n]{0,160}\b(?:normal|passed|failed|acceptable|within\s+(?:range|limits)|abnormal)\b/iu.test(text)) {
      add('test_results', text.replace(/[\n。！？；;]+$/u, ''));
    }
    if (/(?:问题|故障)(?:已解决|未解决|部分解决)|(?:已完成|未完成|需继续处理)/u.test(text)) {
      add('completion_status', text.replace(/[\n。！？；;]+$/u, ''));
    }
    if (/\b(?:job|work|service)\s+(?:is|was)\s+(?:now\s+)?(?:complete|completed)\b/iu.test(text)) {
      add('completion_status', text.replace(/[\n。！？；;]+$/u, ''));
    }
    const unresolved = text.match(/(?:未解决|尚未解决|遗留问题)[：:,，\s]*(.+)/u)?.[1];
    if (unresolved) add('unresolved_issues', unresolved.replace(/[\n。！？；;]+$/u, ''));
    const followUp = text.match(/(?:建议|后续)[：:,，\s]*(.+)/u)?.[1];
    if (followUp) add('follow_up_recommendations', followUp.replace(/[\n。！？；;]+$/u, ''));
  }
  return candidates;
}

function manualFacts(manualFields) {
  return Object.entries(manualFields || {}).slice(0, 30).filter(([field, value]) => ALLOWED_FACT_FIELDS.has(field) && value !== '' && value !== null && value !== undefined)
    .map(([field, value], index) => ({
      fact_id: stableId('fact', 'manual', field, value, index),
      field,
      value: sanitizeValue(value),
      source_refs: [`manual:${field}`],
      support_status: 'MANUAL_ENTRY',
    }));
}

function deduplicateFacts(facts) {
  const seen = new Set();
  return facts.filter((fact) => {
    const key = `${fact.field}|${JSON.stringify(fact.value)}|${fact.source_refs.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 100);
}

export async function extractServiceFacts({ transcript, correctionReceipt = null, confirmedCorrections = [], manualFields = {}, provider, model, traceId } = {}) {
  if (!transcript || typeof transcript.raw_text !== 'string') {
    return toolEnvelope('extract_service_facts', traceId, 'FAIL', {}, { error_code: 'INVALID_TRANSCRIPT_ARTIFACT' });
  }
  if (correctionReceipt && (correctionReceipt.transcript_artifact_id !== transcript.artifact_id || correctionReceipt.final_text !== transcript.raw_text)) {
    return toolEnvelope('extract_service_facts', traceId, 'FAIL', {}, { error_code: 'CORRECTION_TRANSCRIPT_MISMATCH' });
  }
  const rawText = transcript.raw_text.slice(0, 20_000);
  const correctionReceiptId = correctionReceipt?.correction_receipt_id || null;
  let providerCandidates = [];
  const warnings = [];
  let providerMetadata = null;
  if (provider?.generateJson) {
    try {
      const response = await provider.generateJson({
        model,
        system: 'Extract only explicitly stated HVAC service facts. Copy an exact source_span from raw_text for every fact. Do not infer customary steps, causes, safety, price, test duration, or completion. Return JSON only.',
        prompt: JSON.stringify({
          raw_text: rawText,
          confirmed_corrections: confirmedCorrections.filter((item) => item?.status === 'CONFIRMED_BY_TECHNICIAN').slice(0, 30),
          allowed_fields: [...ALLOWED_FACT_FIELDS].filter((field) => !MANUAL_ONLY_FIELDS.has(field)),
          required_output: { facts: [{ field: 'allowed field', value: 'bounded value', source_span: { start: 0, end: 1, text: 'exact raw substring' }, support_status: 'DIRECT_TRANSCRIPT or UNCERTAIN' }] },
        }),
      });
      providerCandidates = Array.isArray(response?.data?.facts) ? response.data.facts : [];
      if (!Array.isArray(response?.data?.facts)) warnings.push('Provider output had no facts array; deterministic extraction was used.');
      providerMetadata = { provider: response?.provider || 'unknown', model: response?.model || model || 'unknown' };
    } catch (error) {
      warnings.push(`Provider extraction failed; deterministic extraction was used (${error.code || 'PROVIDER_ERROR'}).`);
    }
  }
  const approvedCorrections = confirmedCorrections.filter((item) => item?.status === 'CONFIRMED_BY_TECHNICIAN');
  const allowedCorrectionIds = new Set(approvedCorrections.map((item) => String(item.correction_id)));
  const cleanedProviderFacts = providerCandidates.slice(0, 100).map((item, index) => cleanProviderFact(item, rawText, index, allowedCorrectionIds, correctionReceiptId)).filter(Boolean);
  if (cleanedProviderFacts.length < providerCandidates.length) warnings.push('Unsupported, malformed, manual-only, or negated action facts from the provider were discarded.');
  const heuristic = heuristicFacts(rawText, approvedCorrections).map((item, index) => cleanProviderFact(item, rawText, index + 1_000, allowedCorrectionIds, correctionReceiptId)).filter(Boolean);
  const facts = deduplicateFacts([...cleanedProviderFacts, ...heuristic, ...manualFacts(manualFields)]);
  return toolEnvelope('extract_service_facts', traceId, 'PASS', {
    transcript_artifact_id: transcript.artifact_id || null,
    correction_receipt_id: correctionReceiptId,
    facts,
    provider: providerMetadata,
    deterministic_fallback_used: cleanedProviderFacts.length === 0,
  }, { warnings });
}
