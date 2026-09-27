/**
 * V2 SBS deterministic fact extractor (BUS / RAIL).
 *
 * Extracts v2 facts from technician-entered / dictated text WITHOUT any LLM:
 * the text is split into sentences and matched against the scoped knowledge
 * vocabularies (sbs-bus-terms / sbs-bus-parts or sbs-rail-terms /
 * sbs-rail-parts) plus deterministic rule patterns. Every produced fact
 * carries support_status = DIRECT_TRANSCRIPT and source = 'manual', and its
 * `critical` flag comes from the fact-schema catalog
 * (isCriticalField({ scopeId, field })).
 *
 * Contract discipline (§13): only facts explicitly stated in rawText are
 * produced. A part mentioned without a performed replacement (e.g. "检查电容"
 * or "手册建议更换电容") never yields parts.replaced; a recommendation
 * (建议/recommend/应/需...) or a negated action (未更换/没有更换...) is never
 * read as an occurred action.
 *
 * This module is deterministic and side-effect free apart from reading the
 * registry / vocab JSON files. Imports are node: built-ins or relative paths
 * only (zero npm runtime dependencies).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCriticalField, SUPPORT_STATUSES } from '../v2/fact-schemas.js';
import { loadScopeRegistry, resolveContext } from '../v2/scope.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNOWLEDGE_V2_DIR = path.join(projectRoot, 'data', 'knowledge', 'v2');

/** Domains with deterministic, evidence-grounded extraction. */
const EXTRACT_SCOPES = Object.freeze(new Set(['SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID']));
const INDUSTRIAL_SCOPES = Object.freeze(new Set(['OILFIELD', 'POWER_GRID']));

/** Vocab files per scope (canonical/aliases record shape). */
const VOCAB_FILES_BY_SCOPE = Object.freeze({
  SBS_BUS: Object.freeze(['sbs-bus-terms.v1.json', 'sbs-bus-parts.v1.json']),
  SBS_RAIL: Object.freeze(['sbs-rail-terms.v1.json', 'sbs-rail-parts.v1.json']),
  OILFIELD: Object.freeze(['oilfield-terms.v1.json']),
  POWER_GRID: Object.freeze(['power-grid-terms.v1.json']),
});

/** Upper bound on processed text (mirrors V1 extractor discipline). */
const MAX_TEXT_LENGTH = 20_000;

/* ------------------------------------------------------------------ *
 * Sentence splitting
 * ------------------------------------------------------------------ */

/**
 * Splits text into trimmed sentences. Terminators: Chinese 。！？；; ,
 * English !?; and the English period when it is not part of a decimal
 * number (e.g. "12.5" keeps its dot) and is followed by whitespace / end.
 * Newlines are always sentence boundaries. Trailing punctuation is removed.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return sentenceSpans(text).map((span) => span.text);
}

function sentenceSpans(text) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return [];
  const sentences = [];
  let buffer = '';
  let bufferStart = 0;
  const flush = () => {
    const withoutTerminator = buffer.replace(/[。！？!?；;.]+$/u, '');
    const leading = withoutTerminator.length - withoutTerminator.trimStart().length;
    const cleaned = withoutTerminator.trim();
    if (cleaned !== '') {
      const start = bufferStart + leading;
      sentences.push({ start, end: start + cleaned.length, text: cleaned });
    }
    buffer = '';
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\n' || ch === '\r') {
      flush();
      bufferStart = i + 1;
      continue;
    }
    if (buffer === '') bufferStart = i;
    buffer += ch;
    if (/[。！？!?；;]/u.test(ch)) {
      flush();
      bufferStart = i + 1;
      continue;
    }
    if (ch === '.') {
      const prev = i > 0 ? raw[i - 1] : '';
      const next = i + 1 < raw.length ? raw[i + 1] : '';
      const prevIsDigit = /\d/u.test(prev);
      const nextIsDigit = /\d/u.test(next);
      const nextIsBoundary = next === '' || /\s/u.test(next);
      if (!(prevIsDigit && nextIsDigit) && nextIsBoundary) {
        flush();
        bufferStart = i + 1;
      }
    }
  }
  flush();
  return sentences;
}

/* ------------------------------------------------------------------ *
 * Vocabulary loading & matching
 * ------------------------------------------------------------------ */

/** @type {Map<string, Promise<{ terms: object[], parts: object[] }>>} */
const vocabCache = new Map();

/**
 * Loads and parses the scoped vocabulary JSON files (terms + parts).
 * Results are cached per scope id.
 *
 * @param {'SBS_BUS'|'SBS_RAIL'} scopeId
 * @returns {Promise<{ terms: object[], parts: object[] }>}
 */
async function loadScopeVocab(scopeId) {
  const cached = vocabCache.get(scopeId);
  if (cached) return cached;
  const promise = (async () => {
    const terms = [];
    const parts = [];
    for (const file of VOCAB_FILES_BY_SCOPE[scopeId]) {
      const raw = await fs.readFile(path.join(KNOWLEDGE_V2_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      const records = Array.isArray(data?.records) ? data.records : [];
      if (file.includes('-parts.')) parts.push(...records);
      else terms.push(...records);
    }
    return { terms, parts };
  })();
  vocabCache.set(scopeId, promise);
  try {
    return await promise;
  } catch (error) {
    vocabCache.delete(scopeId);
    throw error;
  }
}

/**
 * Builds a match index from records: { canonical, patterns[] } entries with
 * patterns (canonical + aliases) sorted longest-first so the most specific
 * alias wins.
 *
 * @param {object[]} records
 * @returns {Array<{ canonical: string, patterns: string[] }>}
 */
function buildIndex(records) {
  const entries = [];
  for (const record of records) {
    const canonical = String(record?.canonical ?? '');
    if (!canonical) continue;
    const aliases = Array.isArray(record?.aliases) ? record.aliases : [];
    const patterns = [...new Set([canonical, ...aliases].filter((item) => typeof item === 'string' && item !== ''))]
      .sort((a, b) => b.length - a.length);
    entries.push({ canonical, patterns });
  }
  return entries;
}

/**
 * Whether `token` appears in `text`. Pure-ASCII/alphanumeric tokens
 * (including phrases with spaces, e.g. "MAN A95") are matched with
 * alphanumeric word boundaries so "A95" does not match inside "A95RC";
 * CJK/mixed tokens fall back to substring containment.
 *
 * @param {string} text
 * @param {string} token
 * @returns {boolean}
 */
function containsToken(text, token) {
  if (/^[A-Za-z0-9][A-Za-z0-9 .,\-/:]*$/u.test(token)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'iu').test(text);
  }
  return text.includes(token);
}

/**
 * Finds the vocab entries whose canonical/alias appears in the sentence.
 * At most one match per record (the longest matching alias).
 *
 * @param {string} sentence
 * @param {Array<{ canonical: string, patterns: string[] }>} entries
 * @returns {Array<{ canonical: string, pattern: string, display: string }>}
 */
function findMatches(sentence, entries) {
  const found = [];
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      if (containsToken(sentence, pattern)) {
        // Prefer an English display value when the vocab canonical is CJK but
        // the sentence matched an English alias (English-language SBS demo);
        // Chinese dictation keeps the canonical value unchanged.
        const display = /[\u4e00-\u9fff]/.test(entry.canonical) && !/[\u4e00-\u9fff]/.test(pattern)
          ? pattern
          : entry.canonical;
        found.push({ canonical: entry.canonical, pattern, display });
        break;
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Rule patterns (deterministic)
 * ------------------------------------------------------------------ */

/** Maintenance-type keyword rules, ordered so more specific phrases win. */
const WORK_TYPE_RULES = Object.freeze([
  { value: 'statutory', re: /法定|statutory|roadworthiness|定期检验|periodic\s*inspection|政府检验/iu },
  { value: 'condition_based', re: /状态性|视情|预测性|condition[- ]?based|predictive|状态监测|状态维护/iu },
  { value: 'preventive', re: /预防|保养|定期|scheduled|preventive/iu },
  { value: 'corrective', re: /纠正|维修|修复|corrective|repair|defect\s*rectification/iu },
]);

/** Sentences stating a fault / defect (drives work.description). */
const FAULT_RE = /故障|异常|不工作|失灵|损坏|不良|磨损|磨耗|报错|间歇|不制冷|无法|malfunction|fault|intermittent|not\s+work(?:ing)?|(?:would|did|does)\s+not\s+(?:close|open|operate)|damage|worn|defect/iu;

/** Direct inspection/findings language; the sentence remains the evidence value. */
const INSPECTION_RE = /检查发现|检查结果|经检查|检验发现|检查了|inspection\s+(?:found|showed|identified)|inspected|examined|found\s+(?:that\s+)?/iu;

/** Sentences carrying an explicit fault-code signal (drives work.fault_code). */
const FAULT_CODE_RE = /故障码|fault\s*code|SPN|FMI|J1939|诊断码|代码|\bcode\b/iu;

/** Root-cause markers (drives diagnosis.root_cause). */
const ROOT_CAUSE_RE = /原因是|由于|因为|检查发现|检查结果|根因|due\s+to|caused\s+by|root\s+cause/iu;

/** Part replacement explicitly negated — never an occurred action. */
const NOT_REPLACED_RE = /未\s*(?:更换|替换|换)|没有(?:更换|替换|换)|没换|并未更换|无需更换|不需更换|不(?:更换|替换|换)|not\s*(?:replaced|changed|installed)|no\s*replacement/iu;

/**
 * Recommendation / requirement / future markers — "建议更换" or "需更换"
 * states an obligation or plan, not a performed action (§13).
 */
const RECOMMENDATION_RE = /建议|推荐|recommend|should|ought|必须|需要|需|应当|应该|应\s*(?:更换|替换|换)|要求|计划|planned?|拟\s*(?:更换|替换|换)|将\s*(?:会|要)?\s*(?:更换|替换|换)|will\s+(?:be\s+)?replac|to\s+be\s+replaced/iu;

/** Performed-replacement verbs ("换" alone is too ambiguous to trust). */
const REPLACED_RE = /更换|替换|换了|换上|换下|换掉|换装|replaced|installed|replacement\s+(?:done|performed|made)/iu;

/**
 * Number + measurement unit (scope unit dictionaries from report-builder:
 * BUS {km, %, bar, kPa, mm, °C, kWh, MWh, g/kWh, V, dB}; RAIL
 * {km, train-km, car-km, mm, V, %, °C, min}). Capacitance specs (µF/uF/微法)
 * are part specifications, not measurements, and are intentionally excluded.
 */
const MEASUREMENT_RE = /((?:\d{1,3}(?:,\d{3})+(?:\.\d+)?)|(?:\d+(?:[.,]\d+)?))\s*(kilometers?|kilometres?|千米|公里|毫米|厘米|米|kv|mm|km|cm|m|%|bar|kpa|psi|°c|℃|v|kwh|mwh|min|db|g\/kwh|ω[·.]?m|ohm[·-]?m)/giu;

/** Explicit standard references used by the supplied inspection templates. */
const STANDARD_REFERENCE_RE = /\b(?:GB(?:\/T)?|NB\/T|Q\/GDW)\s*\d+(?:\.\d+)?(?:-\d{4})?(?:\s*第\s*[\d.]+\s*条)?/giu;
const INSPECTION_ITEM_RE = /检查|检测|试验|测试|巡检|inspection|test|击穿电压|介质损耗|体积电阻率|管道敷设|线路选择|输油工艺/iu;
const INDUSTRIAL_RESULT_RE = /符合|不符合|合格|不合格|正常|异常|通过|不通过|pass(?:ed)?|fail(?:ed)?|compliant|non[- ]?compliant/iu;
const OBSERVATION_RE = /实际情况|现场|发现|观察|测得|显示|observed|found|measured|inspection/iu;
const SPECIFICATION_ONLY_RE = /手册|规范|规格|标准|要求|阈值|上限|下限|manual|spec(?:ification)?|standard|required?|threshold|limit/iu;
const PERFORMED_WORK_RE = /已(?:更换|修复|紧固|清理|整改|处理|隔离)|(?:已完成|完成)(?:了)?[^。；;，,]{0,12}(?:更换|修复|紧固|清理|整改|处理|隔离)|replaced|repaired|secured|cleaned|rectified|isolated|reseated|reconnected/iu;

/** Test-indicator + result words (drives test.result). */
const TEST_INDICATOR_RE = /试机|测试|试验|试车|试运行|复测|test|retest|验证|check|检测/iu;
const TEST_RESULT_RE = /正常|异常|通过|不通过|失败|良好|合格|不合格|ok|normal|pass|fail|运转|ready|successful(?:ly)?/iu;
const TEST_ACTION_RE = /试机|测试|试验|试车|试运行|验证|tested|verified|validated|function(?:al)?\s+test|completed?\s+(?:\w+\s+){0,3}cycles?\s+successful(?:ly)?/iu;
const COMPLETED_CYCLE_RE = /\bcompleted?\b[^.!?。！？]{0,60}\bcycles?\b/iu;

/** TAMS/track-access approval must be stated, never inferred from rail work. */
const ACCESS_APPROVED_RE = /(?:\bTAMS\b[^.]*\baccess\b[^.]*\bapproved\b)|(?:track\s+access[^.]*\bapproved\b)|(?:轨道|线路|轨旁)?准入[^.。]*(?:已批准|获批|批准)/iu;

/** Explicit "not completed" statements have no defined completion value. */
const COMPLETION_NOT_DONE_RE = /未完成|尚未完成|没有完成|未解决|尚未解决|没有解决|unresolved|not\s+complet/iu;

const COMPLETION_OUT_OF_SERVICE_RE = /未回役|未恢复|未返回|out\s+of\s+service|not\s+return(?:ed)?\s+to\s+service|退出服务/iu;

const COMPLETION_DONE_RE = /已完成|已解决|完成|解决|回役|恢复服务|恢复运营|恢复运行|恢复使用|重新上路|back\s+in\s+service|return(?:ed)?(?:\s+\S+){0,4}\s+to\s+(?:the\s+)?service|restored|recommissioned|cleared\s+for\s+passenger|complet(?:e|ed|ion)|resolved|fixed/iu;

const COMPLETION_DEFERRED_RE = /延期|延后|延迟|改期|postpon|deferr/iu;

const COMPLETION_OFFROAD_RE = /off-?road|下线|停运/iu;

const COMPLETION_RESTRICTED_RE = /限速|restricted\s*speed|speed\s+restriction/iu;

/** Safety-critical assertion markers (drives safety.*). */
const SAFETY_RE = /高压|高电压|回役|恢复服务|恢复运营|恢复运行|重新上路|安全措施|安全确认|安全隔离|HSE|restored|back\s+in\s+service|return(?:ed)?(?:\s+\S+){0,4}\s+to\s+(?:the\s+)?service|no\s+(?:additional\s+)?safety\s+(?:issue|concern|hazard)s?|隔离|isolation|断电|high\s*voltage|\bHV\b|电气安全/iu;

/** Singapore bus vehicle registration as dictated by the technician. */
const BUS_REGISTRATION_RE = /\b(?:SBS|SG)\d{1,4}[A-Z]\b/giu;
/** Internal fleet identifier, only when explicitly introduced as a bus/fleet ID. */
const BUS_FLEET_ID_RE = /\b(?:bus|fleet)\s*(?:id|number|no\.?)[\s:=]*(\d{4}-\d{3})\b/giu;

/**
 * Infers a measurement sub-field from sentence context; falls back to the
 * unified measurement.value field.
 *
 * @param {string} sentence
 * @returns {string}
 */
function measurementField(sentence, unit = '') {
  const normalizedUnit = String(unit).toLowerCase().replace(/℃/g, '°c');
  if (/odometer|mileage|里程(?:表|计)?/iu.test(sentence) && normalizedUnit === 'km') return 'measurement.odometer_km';
  if (/ω[·.]?m|ohm[·-]?m/iu.test(normalizedUnit) || /体积电阻率|resistivity/iu.test(sentence)) return 'measurement.resistivity';
  if (/击穿电压|耐压值|breakdown\s+voltage|dielectric\s+strength/iu.test(sentence) && normalizedUnit === 'kv') return 'measurement.breakdown_voltage';
  if (/湿度|humidity/iu.test(sentence) && normalizedUnit === '%') return 'measurement.humidity';
  if (/介质损耗|tgδ|dielectric\s+loss/iu.test(sentence) && normalizedUnit === '%') return 'measurement.dielectric_loss';
  if (/间隙|gap|间距/iu.test(sentence)) return 'measurement.gap';
  if (/管顶覆土|覆土.{0,3}厚度/iu.test(sentence)) return 'measurement.depth';
  if (/磨损|磨耗|wear|thickness|厚度|深度|depth|胎纹/iu.test(sentence)) return 'measurement.wear';
  if (normalizedUnit === '°c' || /温度|temp/iu.test(sentence)) return 'measurement.temperature';
  if (/压力|pressure|bar|kpa|psi/iu.test(sentence)) return 'measurement.pressure';
  if (normalizedUnit === 'kv' || normalizedUnit === 'v') return 'measurement.voltage';
  return 'measurement.value';
}

function normalizeMeasurementUnit(unit) {
  const value = String(unit ?? '');
  return ({ 米: 'm', 千米: 'km', 公里: 'km', 毫米: 'mm', 厘米: 'cm', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km' })[value.toLowerCase()] || value;
}

function normalizeMeasurementValue(value) {
  const text = String(value ?? '');
  return /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(text) ? text.replaceAll(',', '') : text;
}

/* ------------------------------------------------------------------ *
 * Per-sentence extraction
 * ------------------------------------------------------------------ */

/**
 * Extracts the candidate facts ({ field, value, unit? }) explicitly stated
 * in one sentence, using the scoped vocabularies and rule patterns.
 *
 * @param {string} sentence
 * @param {'SBS_BUS'|'SBS_RAIL'|'OILFIELD'|'POWER_GRID'} scopeId
 * @param {{ terms: object[], parts: object[] }} vocab
 * @returns {Array<{ field: string, value: unknown, unit?: string }>}
 */
function factsFromSentence(sentence, scopeId, vocab) {
  const out = [];
  const push = (field, value) => out.push({ field, value });

  // --- asset.* (bus model / rail line / rail stock class) ----------
  if (scopeId === 'SBS_BUS') {
    const models = buildIndex(vocab.terms.filter((record) => /^term_model_/u.test(String(record?.id ?? ''))));
    for (const hit of findMatches(sentence, models)) push('asset.bus_model', hit.canonical);
    for (const match of sentence.matchAll(BUS_REGISTRATION_RE)) push('asset.registration_no', match[0].toUpperCase());
    for (const match of sentence.matchAll(BUS_FLEET_ID_RE)) push('asset.internal_fleet_no', match[1]);
  } else if (scopeId === 'SBS_RAIL') {
    const lines = buildIndex(vocab.terms.filter((record) => /^term_line_/u.test(String(record?.id ?? ''))));
    const stocks = buildIndex(vocab.terms.filter((record) => /^term_stock_/u.test(String(record?.id ?? ''))));
    for (const hit of findMatches(sentence, lines)) push('asset.line', hit.canonical);
    for (const hit of findMatches(sentence, stocks)) push('asset.stock_class', hit.canonical);
    const trainSet = /(?:train\s+set\s+)?([A-Z]\d{3}[A-Z]?\s+\d{4}\/\d{4})\b|\b([A-Z]\d{3}[A-Z]?)\s+train\s+set\s+(\d{4}\/\d{4})\b/iu.exec(sentence);
    if (trainSet) push('asset.train_set', (trainSet[1] || `${trainSet[2]} ${trainSet[3]}`).toUpperCase());
    const car = /\bcar\s+([A-Za-z0-9-]+)\b/iu.exec(sentence);
    if (car) push('asset.car', `Car ${car[1]}`);
    if (/车门|(?:train\s+)?door(?:\s+system|\s+roller)?/iu.test(sentence)) push('asset.subsystem', 'door');
  } else if (INDUSTRIAL_SCOPES.has(scopeId)) {
    const assets = buildIndex(vocab.terms.filter((record) => /^term_asset_/u.test(String(record?.id ?? ''))));
    for (const hit of findMatches(sentence, assets)) push('asset.equipment', hit.canonical);
    const voltage = /电压等级|额定电压|voltage\s+level|rated\s+voltage/iu.test(sentence)
      ? sentence.match(/\b\d+(?:\.\d+)?\s*kV\b/iu)
      : null;
    if (scopeId === 'POWER_GRID' && voltage) push('asset.voltage_level', voltage[0].replace(/\s+/g, ''));
  }

  if (INDUSTRIAL_SCOPES.has(scopeId)) {
    for (const match of sentence.matchAll(STANDARD_REFERENCE_RE)) push('standard.reference', match[0].replace(/\s+/g, ' ').trim());
    if (INSPECTION_ITEM_RE.test(sentence)) {
      push('work.type', 'inspection');
      push('inspection.item', sentence);
    }
    if (OBSERVATION_RE.test(sentence)) push('inspection.observation', sentence);
    if (INDUSTRIAL_RESULT_RE.test(sentence)) push('inspection.result', sentence);
    if (FAULT_RE.test(sentence) || /缺陷|隐患|泄漏|腐蚀|破损|超标|defect|leak|corrosion|damage/iu.test(sentence)) {
      push('defect.description', sentence);
    }
    if (PERFORMED_WORK_RE.test(sentence) && !RECOMMENDATION_RE.test(sentence) && !NOT_REPLACED_RE.test(sentence)) {
      push('work_performed', sentence);
    }
  }

  // --- work.type ------------------------------------------------------
  for (const rule of WORK_TYPE_RULES) {
    if (rule.re.test(sentence)) {
      push('work.type', rule.value);
      break;
    }
  }

  // --- work.description / work.fault_code (fault sentences) ----------
  const inspection = INSPECTION_RE.test(sentence);
  if (inspection) push('inspection_findings', sentence);
  if (FAULT_RE.test(sentence)) {
    if (!inspection) push('work.description', sentence);
    if (!inspection) push('inspection_findings', sentence);
    if (FAULT_CODE_RE.test(sentence)) push('work.fault_code', sentence);
  }

  // --- diagnosis.root_cause ------------------------------------------
  if (ROOT_CAUSE_RE.test(sentence)) {
    push('diagnosis.root_cause', sentence);
  }

  // --- parts.* --------------------------------------------------------
  const partsIndex = buildIndex(vocab.parts);
  const partHits = findMatches(sentence, partsIndex);
  for (const hit of partHits) push('parts.part_number', hit.display);
  const replaced = !NOT_REPLACED_RE.test(sentence)
    && !RECOMMENDATION_RE.test(sentence)
    && REPLACED_RE.test(sentence);
  if (replaced && partHits.length > 0) {
    push('parts.replaced', 'true');
    push('work_performed', sentence);
  }
  const performedWork = !NOT_REPLACED_RE.test(sentence)
    && !RECOMMENDATION_RE.test(sentence)
    && PERFORMED_WORK_RE.test(sentence);
  if (performedWork) push('work_performed', sentence);

  // --- measurement.* --------------------------------------------------
  for (const measure of sentence.matchAll(MEASUREMENT_RE)) {
    const before = sentence.slice(0, measure.index);
    const after = sentence.slice(measure.index + measure[0].length);
    const specificationBefore = SPECIFICATION_ONLY_RE.test(before) && !OBSERVATION_RE.test(before);
    const specificationMarker = after.search(SPECIFICATION_ONLY_RE);
    const intervening = specificationMarker < 0 ? '' : after.slice(0, specificationMarker);
    MEASUREMENT_RE.lastIndex = 0;
    const interveningHasMeasurement = MEASUREMENT_RE.test(intervening);
    MEASUREMENT_RE.lastIndex = 0;
    const specificationAfter = specificationMarker >= 0 && !interveningHasMeasurement;
    if (specificationBefore || specificationAfter) continue;
    const unit = normalizeMeasurementUnit(measure[2]);
    out.push({ field: measurementField(sentence, unit), value: normalizeMeasurementValue(measure[1]), unit });
  }

  // --- test.result ----------------------------------------------------
  if (((TEST_INDICATOR_RE.test(sentence) || COMPLETED_CYCLE_RE.test(sentence)) && TEST_RESULT_RE.test(sentence)) || TEST_ACTION_RE.test(sentence)) {
    push('test.result', sentence);
  }

  // --- rail access approval -------------------------------------------
  if (scopeId === 'SBS_RAIL' && ACCESS_APPROVED_RE.test(sentence)) push('access.approval', sentence);

  // --- completion.state ------------------------------------------------
  if (!COMPLETION_NOT_DONE_RE.test(sentence)) {
    let state = null;
    if (COMPLETION_OUT_OF_SERVICE_RE.test(sentence)) state = 'out_of_service';
    else if (COMPLETION_DONE_RE.test(sentence)) state = 'completed';
    else if (COMPLETION_DEFERRED_RE.test(sentence)) state = 'deferred';
    else if (COMPLETION_OFFROAD_RE.test(sentence)) state = 'off-road';
    else if (COMPLETION_RESTRICTED_RE.test(sentence)) state = 'restricted_speed';
    if (state) push('completion.state', state);
  }

  // --- safety.* ---------------------------------------------------------
  if (SAFETY_RE.test(sentence)) {
    push('safety.assertion', sentence);
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Deterministically extracts v2 SBS facts from technician text.
 *
 * @param {{ contextId: string, rawText: string, registry?: object }} params
 * @returns {Promise<{ facts: Array<{ field: string, value: unknown, unit?: string, support_status: string, source: string, critical: boolean }>, warnings: string[] }>}
 */
export async function extractV2Facts({ contextId, rawText, registry } = {}) {
  const reg = registry || await loadScopeRegistry();
  const { scopeId } = resolveContext(contextId, reg);
  if (!EXTRACT_SCOPES.has(scopeId)) {
    throw new Error(
      `V2 fact extraction supports SBS/BUS, SBS/RAIL, OILFIELD, and POWER/GRID. ` +
      `Context "${String(contextId ?? '')}" resolved to scope "${scopeId}", which does not support deterministic V2 fact extraction (HVAC uses the V1 flow).`,
    );
  }
  const text = String(rawText ?? '').slice(0, MAX_TEXT_LENGTH);
  const vocab = await loadScopeVocab(scopeId);

  const facts = [];
  const warnings = [];
  const seen = new Set();
  for (const sentenceSpan of sentenceSpans(text)) {
    const sentence = sentenceSpan.text;
    const candidates = factsFromSentence(sentence, scopeId, vocab);
    if (candidates.length === 0) {
      warnings.push(`Unrecognized: ${sentence}`);
      continue;
    }
    // Spoken self-corrections such as “错了，GB...” supersede a preceding
    // standard reference. Keep the explicitly corrected reference only.
    if (INDUSTRIAL_SCOPES.has(scopeId)
      && /(?:错了|更正|改为|correction|corrected)/iu.test(sentence)
      && candidates.some((candidate) => candidate.field === 'standard.reference')) {
      for (let index = facts.length - 1; index >= 0; index -= 1) {
        if (facts[index].field === 'standard.reference') facts.splice(index, 1);
      }
    }
    for (const candidate of candidates) {
      // A report has one current completion/service state. Technicians often
      // say that a repair step was completed and then clarify that the asset
      // is still out of service. Preserve that chronology by allowing the
      // latest explicit completion.state statement to supersede earlier ones.
      if (candidate.field === 'completion.state') {
        for (let index = facts.length - 1; index >= 0; index -= 1) {
          if (facts[index].field !== 'completion.state') continue;
          seen.delete(`${facts[index].field}|${String(facts[index].value)}|${facts[index].unit ?? ''}`);
          facts.splice(index, 1);
        }
      }
      const fact = {
        field: candidate.field,
        value: candidate.value,
        ...(candidate.unit !== undefined ? { unit: candidate.unit } : {}),
        support_status: SUPPORT_STATUSES.DIRECT_TRANSCRIPT,
        source: 'manual',
        source_span: { ...sentenceSpan },
        critical: isCriticalField({ scopeId, field: candidate.field }),
      };
      const key = `${fact.field}|${String(fact.value)}|${fact.unit ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
  }
  return { facts, warnings };
}
