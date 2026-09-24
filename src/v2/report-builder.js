/**
 * V2 SBS report builder — deterministic, fact-grounded report generation for
 * the SBS Bus and SBS Rail domains.
 *
 * Design basis (docs/v2-research, read-only):
 *   - 06_V2_REPORT_SCHEMA_DRAFT.md  §2.2 (Bus 11 sections), §2.3 (Rail 12
 *     sections), §3 (report grounding rules)
 *   - 08_V2_CRITICAL_ERROR_TAXONOMY.md (10 hard-failure classes)
 *   - 03_SBS_BUS_DOMAIN_MODEL.md §3, 04_SBS_RAIL_DOMAIN_MODEL.md §3
 *   - V1 discipline (src/tools/generate-report-draft.js): the report is
 *     generated FROM facts; knowledge/RAG may suggest wording but never
 *     injects a service fact.
 *
 * Invariants preserved from V1 (06 §3 / contract §3, §13):
 *   1. Every report claim traces to a fact in the facts receipt.
 *   2. UNCERTAIN facts are not rendered into report content (V1
 *      `validFacts` discipline); they remain visible to hard gates.
 *   3. Missing required sections render the V1 placeholder "未提供/待确认".
 *   4. This module never invents a service fact; manual recommendations are
 *      only surfaced as violations via `assertNoServiceFactInvention`.
 *
 * Rail is NOT a clone of Bus: `RAIL_REPORT_SECTIONS` carries its own
 * semantics (`track_access_record`, `reliability_compliance`,
 * `completion_state_return_to_service`, `safety_ops_notes`, `trigger_findings`).
 *
 * This module imports only `node:` built-ins or relative paths.
 */

import { SUPPORTED_V2_SCOPES, SUPPORT_STATUSES } from './fact-schemas.js';

/** V1 report placeholder for a section with no grounded content. */
const PLACEHOLDER = '未提供/待确认';

/**
 * SBS Bus report sections (06 §2.2 — 11 sections). Each entry is
 * { id, title, required }. `diagnosis` and `parts_materials` are
 * conditional (required: false): a work-order report may legitimately have
 * neither a recorded diagnosis nor replaced parts. All other sections are
 * required (core identity, works, findings, performed work, tests, completion,
 * safety/HV, compliance and provenance).
 *
 * @type {ReadonlyArray<Readonly<{ id: string, title: string, required: boolean }>>}
 */
export const BUS_REPORT_SECTIONS = Object.freeze([
  Object.freeze({ id: 'vehicle_identification', title: '车辆识别', required: true }),
  Object.freeze({ id: 'works_summary', title: '作业摘要', required: true }),
  Object.freeze({ id: 'inspection_findings', title: '检查发现', required: true }),
  Object.freeze({ id: 'diagnosis', title: '诊断', required: false }),
  Object.freeze({ id: 'work_performed', title: '完成工作', required: true }),
  Object.freeze({ id: 'parts_materials', title: '零件材料', required: false }),
  Object.freeze({ id: 'tests_results', title: '测试结果', required: true }),
  Object.freeze({ id: 'completion_state', title: '完成状态', required: true }),
  Object.freeze({ id: 'safety_hv_notes', title: '安全/HV 备注', required: true }),
  Object.freeze({ id: 'compliance_audit', title: '合规审计', required: true }),
  Object.freeze({ id: 'provenance', title: '溯源', required: true }),
]);

/**
 * SBS Rail report sections (06 §2.3 — 12 sections). Rail is deliberately NOT
 * a clone of Bus: it carries `track_access_record` (TAMS approval),
 * `reliability_compliance` (MKBF/NRFF/OPS), `trigger_findings`,
 * `completion_state_return_to_service` and `safety_ops_notes`, and omits the
 * Bus-only sections (`inspection_findings`, `safety_hv_notes`,
 * `compliance_audit`). `diagnosis` and `parts_materials` are conditional.
 *
 * @type {ReadonlyArray<Readonly<{ id: string, title: string, required: boolean }>>}
 */
export const RAIL_REPORT_SECTIONS = Object.freeze([
  Object.freeze({ id: 'asset_identification', title: '资产识别', required: true }),
  Object.freeze({ id: 'works_summary', title: '作业摘要', required: true }),
  Object.freeze({ id: 'trigger_findings', title: '触发/故障发现', required: true }),
  Object.freeze({ id: 'diagnosis', title: '诊断', required: false }),
  Object.freeze({ id: 'work_performed', title: '完成工作', required: true }),
  Object.freeze({ id: 'parts_materials', title: '零件材料', required: false }),
  Object.freeze({ id: 'tests_results', title: '测试结果', required: true }),
  Object.freeze({ id: 'track_access_record', title: '轨行区准入记录', required: true }),
  Object.freeze({ id: 'completion_state_return_to_service', title: '完成状态/回役', required: true }),
  Object.freeze({ id: 'safety_ops_notes', title: '安全/OPS 备注', required: true }),
  Object.freeze({ id: 'reliability_compliance', title: '可靠性/合规', required: true }),
  Object.freeze({ id: 'provenance', title: '溯源', required: true }),
]);

/**
 * Exact field → section mapping for Bus. Exact matches win over family
 * prefixes (e.g. `work.fault_code` → inspection_findings, not works_summary).
 *
 * @type {Readonly<Record<string, string>>}
 */
const BUS_EXACT_TO_SECTION = Object.freeze({
  'work.type': 'works_summary',
  'work.trigger': 'works_summary',
  'work.work_order_id': 'works_summary',
  'work.description': 'works_summary',
  'work.fault_code': 'inspection_findings',
  'work_performed': 'work_performed',
  'inspection_findings': 'inspection_findings',
  'diagnosis.root_cause': 'diagnosis',
  'diagnosis': 'diagnosis',
  'test.result': 'tests_results',
  'test_results': 'tests_results',
  'test_result': 'tests_results',
  'parts_used': 'parts_materials',
  'completion.state': 'completion_state',
  'completion_status': 'completion_state',
  'completion_state': 'completion_state',
  // 06 §2.2 places odometer in vehicle identification.
  'measurement.odometer_km': 'vehicle_identification',
  'measurement.odometer': 'vehicle_identification',
  'measurement.mileage': 'vehicle_identification',
});

/**
 * Field-family prefix → section mapping for Bus (matches any sub-field, e.g.
 * `safety.hv_isolation` matches `safety.`).
 *
 * @type {Readonly<Record<string, string>>}
 */
const BUS_FAMILY_TO_SECTION = Object.freeze({
  'asset.': 'vehicle_identification',
  'parts.': 'parts_materials',
  'safety.': 'safety_hv_notes',
  'test.': 'tests_results',
  'measurement.': 'tests_results',
  'completion.': 'completion_state',
  'diagnosis.': 'diagnosis',
  'provenance.': 'provenance',
  'compliance.': 'compliance_audit',
  'audit.': 'compliance_audit',
});

/**
 * Exact field → section mapping for Rail.
 *
 * @type {Readonly<Record<string, string>>}
 */
const RAIL_EXACT_TO_SECTION = Object.freeze({
  'work.type': 'works_summary',
  'work.trigger': 'works_summary',
  'work.order_id': 'works_summary',
  'work.description': 'works_summary',
  'work.fault_code': 'trigger_findings',
  'work_performed': 'work_performed',
  'inspection_findings': 'trigger_findings',
  'diagnosis.root_cause': 'diagnosis',
  'diagnosis': 'diagnosis',
  'test.result': 'tests_results',
  'test_results': 'tests_results',
  'test_result': 'tests_results',
  'parts_used': 'parts_materials',
  'completion.state': 'completion_state_return_to_service',
  'completion_status': 'completion_state_return_to_service',
  'completion_state': 'completion_state_return_to_service',
});

/**
 * Field-family prefix → section mapping for Rail. Rail-specific families:
 * `access.*` → track_access_record, `reliability.*` → reliability_compliance.
 *
 * @type {Readonly<Record<string, string>>}
 */
const RAIL_FAMILY_TO_SECTION = Object.freeze({
  'asset.': 'asset_identification',
  'parts.': 'parts_materials',
  'safety.': 'safety_ops_notes',
  'test.': 'tests_results',
  'measurement.': 'tests_results',
  'completion.': 'completion_state_return_to_service',
  'diagnosis.': 'diagnosis',
  'access.': 'track_access_record',
  'reliability.': 'reliability_compliance',
  'compliance.': 'reliability_compliance',
  'audit.': 'reliability_compliance',
  'provenance.': 'provenance',
});

/** Exact field labels (report rendering). */
const BUS_LABELS = Object.freeze({
  'asset.registration_no': '车牌号(VRN)',
  'asset.internal_fleet_no': '内部车队编号',
  'asset.bus_model': '车型',
  'asset.depot': '车场',
  'asset.package': '运营配套',
  'work.type': '作业类型',
  'work.trigger': '触发原因',
  'work.work_order_id': '工单编号',
  'work.fault_code': '故障代码',
  'work.description': '作业描述',
  'diagnosis.root_cause': '根本原因',
  'parts.part_number': '零件编号',
  'parts.replaced': '是否更换零件',
  'test.result': '测试结果',
  'completion.state': '完成状态',
  'work_performed': '已完成工作',
  'inspection_findings': '检查发现',
});

const RAIL_LABELS = Object.freeze({
  'asset.line': '线路',
  'asset.train_set': '列车编组',
  'asset.car': '车厢',
  'asset.stock_class': '车辆等级',
  'asset.subsystem': '子系统',
  'work.type': '作业类型',
  'work.trigger': '触发原因',
  'work.order_id': '工单编号',
  'work.fault_code': '故障代码',
  'work.description': '作业描述',
  'diagnosis.root_cause': '根本原因',
  'parts.part_number': '零件编号',
  'test.result': '测试结果',
  'access.approval': '轨行区准入审批',
  'completion.state': '完成状态',
  'work_performed': '已完成工作',
});

/** Family-prefix labels used when no exact label exists. */
const FAMILY_LABELS = Object.freeze([
  ['asset.', '资产'],
  ['work.', '作业'],
  ['diagnosis.', '诊断'],
  ['parts.', '零件'],
  ['measurement.', '测量'],
  ['test.', '测试'],
  ['completion.', '完成状态'],
  ['safety.', '安全'],
  ['provenance.', '溯源'],
  ['compliance.', '合规'],
  ['audit.', '审计'],
  ['access.', '轨行区准入'],
  ['reliability.', '可靠性'],
]);

/**
 * Completion-state allow-list shared by BUS/RAIL (03 §2 / 04 §2;
 * 05 §4 completion-state gate). Comparison tolerates `-`/`_` spelling and
 * casing; a value outside the list is a hard error unless the technician
 * confirmed it.
 */
const COMPLETION_STATES = Object.freeze(new Set([
  'completed', 'deferred', 'off-road', 'out_of_service', 'restricted_speed',
]));

/** Return-to-service / safety assertion phrases (08 class 7). */
const RETURN_TO_SERVICE_WORDS = Object.freeze([
  'back in service', 'returned to service', 'return to service',
  '已回役', '回役', 'restored', '恢复使用', '恢复运行', '恢复服务',
  'cleared for passenger service', 'safe for service', '可投入服务',
  'recommissioned', '重新服役',
]);

/** Negation words (08 class 1). */
const NEGATION_RE = /(未|没有|did\s+not|\bnot\b)/i;

/** Service-action fields that must never be populated from knowledge (08 class 9). */
const SERVICE_ACTION_FIELDS = Object.freeze(new Set([
  'work_performed', 'parts.replaced', 'test.result', 'completion.state',
  'work.description',
]));

/** Action words that indicate a knowledge hit is describing a maintenance action. */
const ACTION_WORD_RE = /replace|replaced|replacement|replacing|install|installed|installing|removed|remove|removing|更换|替换|安装|拆除/i;

/** Normalized inline unit extraction (08 class 2). */
const INLINE_UNIT_RE = /(-?\d[\d,.\uFF0C]*)\s*([A-Za-z°℃%/][A-Za-z°℃%/\-]*)/;

/** Garbled-text heuristics for the wrong-identity gate (08 class 3). */
const GARBLED_RE = /[\uFFFD\uFFFE\uFFFF]|\?\?\?|\u0000/;

/**
 * Inline unit dictionaries per scope (task-specified, 08 §1 class 2):
 * Bus {km, %, bar, kPa, mm, °C, kWh, MWh, g/kWh, V, dB};
 * Rail {km, train-km, car-km, mm, V, %, °C, min}. Stored normalized.
 */
const BUS_UNITS = Object.freeze(new Set(['km', '%', 'bar', 'kpa', 'mm', '°c', 'kwh', 'mwh', 'g/kwh', 'v', 'db']));
const RAIL_UNITS = Object.freeze(new Set(['km', 'train-km', 'car-km', 'mm', 'v', '%', '°c', 'min']));

const SECTIONS_BY_SCOPE = Object.freeze({
  SBS_BUS: BUS_REPORT_SECTIONS,
  SBS_RAIL: RAIL_REPORT_SECTIONS,
});
const EXACT_BY_SCOPE = Object.freeze({ SBS_BUS: BUS_EXACT_TO_SECTION, SBS_RAIL: RAIL_EXACT_TO_SECTION });
const FAMILY_BY_SCOPE = Object.freeze({ SBS_BUS: BUS_FAMILY_TO_SECTION, SBS_RAIL: RAIL_FAMILY_TO_SECTION });
const LABELS_BY_SCOPE = Object.freeze({ SBS_BUS: BUS_LABELS, SBS_RAIL: RAIL_LABELS });
const UNITS_BY_SCOPE = Object.freeze({ SBS_BUS: BUS_UNITS, SBS_RAIL: RAIL_UNITS });
const FORBIDDEN_SOURCES_BY_SCOPE = Object.freeze({
  SBS_BUS: Object.freeze(['SBS_RAIL', 'HVAC']),
  SBS_RAIL: Object.freeze(['SBS_BUS', 'HVAC']),
});

/** Normalizes a unit token for dictionary lookup ('°C'/'℃' → '°c', lowercased). */
function normalizeUnit(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/℃/g, '°c').replace(/\s+/g, '');
}

/** Flattens a fact value (string | number | boolean | object | array) to searchable text. */
function factText(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(factText).filter(Boolean).join('，');
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, item]) => item !== '' && item !== null && item !== undefined)
      .map(([key, item]) => `${key}: ${factText(item)}`)
      .join('，');
  }
  return String(value ?? '');
}

/** Renders a fact value for report content (bilingual labels, object flattening). */
function renderValue(fact) {
  const value = fact?.value;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  return factText(value);
}

/** Human label for a fact field, falling back to family-prefix labels. */
function labelFor(field, scopeId) {
  const exact = LABELS_BY_SCOPE[scopeId]?.[field];
  if (exact) return exact;
  for (const [prefix, label] of FAMILY_LABELS) {
    if (field.startsWith(prefix)) {
      const sub = field.slice(prefix.length);
      return sub ? `${label} · ${sub}` : label;
    }
  }
  return field;
}

/** A fact is renderable when it is well-formed, non-empty and not UNCERTAIN (V1 discipline). */
function isUsableFact(fact) {
  return Boolean(fact)
    && typeof fact.field === 'string'
    && fact.field.trim() !== ''
    && fact.value !== undefined
    && fact.value !== null
    && String(fact.value).trim() !== ''
    && fact.support_status !== SUPPORT_STATUSES.UNCERTAIN;
}

/** Maps a fact field to its report section (exact match wins, then family prefix). */
function sectionOf(scopeId, field) {
  const exact = EXACT_BY_SCOPE[scopeId]?.[field];
  if (exact) return exact;
  const families = FAMILY_BY_SCOPE[scopeId] || {};
  for (const prefix of Object.keys(families)) {
    if (field.startsWith(prefix)) return families[prefix];
  }
  return null;
}

/** Builds the sections array for one scope from facts; never invents content. */
function buildReportSections({ scopeId, facts = [], factsReceiptId }) {
  const sections = SECTIONS_BY_SCOPE[scopeId].map((section) => ({
    id: section.id,
    title: section.title,
    required: section.required,
    content: [],
  }));
  const byId = new Map(sections.map((section) => [section.id, section]));
  for (const fact of facts) {
    if (!isUsableFact(fact)) continue;
    const sectionId = sectionOf(scopeId, fact.field);
    if (!sectionId || !byId.has(sectionId)) continue;
    const label = labelFor(fact.field, scopeId);
    const unit = fact.unit ? ` ${fact.unit}` : '';
    byId.get(sectionId).content.push(`${label}：${renderValue(fact)}${unit}。`);
  }
  if (factsReceiptId) {
    const provenance = byId.get('provenance');
    if (provenance) provenance.content.unshift(`事实收据: ${factsReceiptId}`);
  }
  return sections.map((section) => Object.freeze({
    id: section.id,
    title: section.title,
    required: section.required,
    content: Object.freeze(section.content.length ? section.content : [PLACEHOLDER]),
  }));
}

/**
 * Builds an SBS Bus report draft from the supplied facts receipt facts.
 *
 * @param {{ facts?: Array<{ field: string, value: unknown, unit?: string, support_status: string, source?: string, critical?: boolean }>, factsReceiptId?: string }} params
 * @returns {{ sections: ReadonlyArray<Readonly<{ id: string, title: string, required: boolean, content: ReadonlyArray<string> }>>, reportVersion: 'v2-bus-1' }}
 */
export function buildBusReportSections({ facts = [], factsReceiptId } = {}) {
  return Object.freeze({
    sections: Object.freeze(buildReportSections({ scopeId: 'SBS_BUS', facts, factsReceiptId })),
    reportVersion: 'v2-bus-1',
  });
}

/**
 * Builds an SBS Rail report draft from the supplied facts receipt facts.
 *
 * @param {{ facts?: Array<{ field: string, value: unknown, unit?: string, support_status: string, source?: string, critical?: boolean }>, factsReceiptId?: string }} params
 * @returns {{ sections: ReadonlyArray<Readonly<{ id: string, title: string, required: boolean, content: ReadonlyArray<string> }>>, reportVersion: 'v2-rail-1' }}
 */
export function buildRailReportSections({ facts = [], factsReceiptId } = {}) {
  return Object.freeze({
    sections: Object.freeze(buildReportSections({ scopeId: 'SBS_RAIL', facts, factsReceiptId })),
    reportVersion: 'v2-rail-1',
  });
}

/** Normalizes an English/Chinese action word to a stem for cross-matching. */
function actionStem(word) {
  return String(word).toLowerCase().replace(/(ed|ing|es|s)$/, '');
}

/** Returns the set of normalized action stems present in a piece of text. */
function actionStemsIn(text) {
  const stems = new Set();
  const words = String(text ?? '').match(/replace|replaced|replacement|replacing|install|installed|installing|removed|remove|removing|更换|替换|安装|拆除/gi) || [];
  for (const word of words) stems.add(actionStem(word));
  return stems;
}

function isTruthy(value) {
  if (value === true) return true;
  const low = String(value ?? '').trim().toLowerCase();
  return low === 'true' || low === 'yes' || low === '是';
}

/** Whether the fact base supports a service action (parts replaced or grounded work_performed). */
function actionStemsSupportedByFacts(facts) {
  const stems = new Set();
  if (facts.some((fact) => fact?.field === 'parts.replaced' && isTruthy(fact.value))) {
    stems.add('*replaced*');
  }
  for (const fact of facts) {
    if (!fact) continue;
    if (fact.field !== 'work_performed' && fact.field !== 'work.description' && fact.field !== 'performed_actions') continue;
    const status = fact.support_status;
    if (status !== SUPPORT_STATUSES.DIRECT_TRANSCRIPT && status !== SUPPORT_STATUSES.MANUAL_ENTRY) continue;
    for (const stem of actionStemsIn(fact.value)) stems.add(stem);
  }
  return stems;
}

/**
 * Hard gate (08 class 4; contract §3, §13): a knowledge hit must not become an
 * occurred service action unless the facts receipt supports it.
 *
 * Support exists when the facts contain a truthy `parts.replaced` fact OR a
 * `work_performed`-family fact containing the recommended action word with a
 * transcript/technician-grounded support status (DIRECT_TRANSCRIPT or
 * MANUAL_ENTRY). Anything else yields an INVENTED_ACTION_REPLACEMENT
 * violation per knowledge hit that recommends an action.
 *
 * @param {{ facts?: Array<object>, knowledgeHits?: Array<string> }} params
 * @returns {ReadonlyArray<Readonly<{ class: 'INVENTED_ACTION_REPLACEMENT', detail: string }>>}
 */
export function assertNoServiceFactInvention({ facts = [], knowledgeHits = [] } = {}) {
  const supported = actionStemsSupportedByFacts(facts);
  const violations = [];
  for (const hit of knowledgeHits) {
    if (typeof hit !== 'string' || hit.trim() === '') continue;
    const hitStems = actionStemsIn(hit);
    if (hitStems.size === 0) continue;
    const word = hit.match(ACTION_WORD_RE)?.[0] || [...hitStems][0];
    const grounded = [...hitStems].some((stem) => supported.has(stem) || supported.has('*replaced*'));
    if (grounded) continue;
    violations.push(Object.freeze({
      class: 'INVENTED_ACTION_REPLACEMENT',
      detail: `Knowledge hit "${hit}" recommends a service action ("${word}") with no supporting fact (no parts.replaced, no transcript/technician work_performed containing that action). Manual/SOP recommendation must not be rendered as an occurred action (08 class 4; contract §3/§13).`,
    }));
  }
  return Object.freeze(violations);
}

/** Whether a field is an asset/part/fault identity field (08 class 3 wrong-identity gate). */
function isIdentityField(field) {
  return field === 'asset.car'
    || field === 'asset.car_serial'
    || field.includes('registration_no')
    || field.includes('train_set')
    || field.includes('stock_class')
    || field.includes('part_number')
    || field.includes('fault_code');
}

/** Whether a fact claims an action happened (for the merged invented-action check). */
function claimsAction(field, value) {
  if (field === 'parts.replaced') return isTruthy(value);
  if (field === 'work_performed' || field === 'work.description' || field === 'performed_actions') {
    return actionStemsIn(value).size > 0;
  }
  return false;
}

/** CHANGED_NUMBER_UNIT check for one fact: unknown unit or number/unit mismatch (08 class 2). */
function checkNumberUnit({ scopeId, fact }) {
  const units = UNITS_BY_SCOPE[scopeId];
  const text = String(fact.value ?? '');
  const hasDigit = /\d/.test(text);
  const rawUnit = fact.unit;
  if (rawUnit !== undefined && rawUnit !== null && String(rawUnit).trim() !== '') {
    const norm = normalizeUnit(rawUnit);
    if (!units.has(norm)) {
      return `Unit "${rawUnit}" on ${fact.field} is not in the ${scopeId} unit dictionary.`;
    }
    if (!hasDigit) {
      return `Unit "${rawUnit}" present on ${fact.field} but value "${text}" contains no number (number/unit mismatch).`;
    }
    return null;
  }
  const inline = INLINE_UNIT_RE.exec(text);
  if (inline) {
    const token = inline[2];
    if (/[A-Za-z]/.test(token) || /[°℃%]/.test(token)) {
      const norm = normalizeUnit(token);
      if (!units.has(norm)) {
        return `Inline unit "${token}" in value "${text}" on ${fact.field} is not in the ${scopeId} unit dictionary.`;
      }
    }
  }
  return null;
}

function assertSupportedScope(scopeId) {
  if (!SUPPORTED_V2_SCOPES.includes(scopeId)) {
    throw new Error(`Unknown V2 scope "${scopeId}". Expected one of: ${SUPPORTED_V2_SCOPES.join(', ')}.`);
  }
}

/**
 * Deterministic hard-gate checks (08 taxonomy; 06 §3/§4) — no LLM involved.
 * Covers (among others): INCORRECT_SAFETY_RETURN_TO_SERVICE,
 * INCORRECT_COMPLETION_STATE, INVENTED_TEST_RESULT, CHANGED_NUMBER_UNIT,
 * WRONG_IDENTITY, RAG_UNSUPPORTED_FACT, CROSS_DOMAIN_LEAKAGE /
 * UPLOAD_CONTAMINATION, CHANGED_NEGATION, plus a merged
 * INVENTED_ACTION_REPLACEMENT check for UNCERTAIN action claims.
 * (Knowledge-hit-driven INVENTED_ACTION_REPLACEMENT is covered separately by
 * `assertNoServiceFactInvention`.)
 *
 * @param {{ scopeId: string, facts?: Array<{ field: string, value: unknown, unit?: string, support_status: string, source?: string }> }} params
 * @returns {{ violations: ReadonlyArray<Readonly<{ class: string, field: string, detail: string }>> }}
 */
export function checkHardGates({ scopeId, facts = [] } = {}) {
  assertSupportedScope(scopeId);
  const violations = [];
  const forbidden = FORBIDDEN_SOURCES_BY_SCOPE[scopeId];
  const push = (cls, field, detail) => violations.push(Object.freeze({ class: cls, field, detail }));

  for (const fact of facts) {
    if (!fact || typeof fact.field !== 'string' || fact.field.trim() === '') continue;
    const field = fact.field;
    const value = fact.value;
    const text = String(value ?? '');
    const status = fact.support_status;
    const source = String(fact.source ?? '');
    const isCompletionField = field === 'completion.state' || field === 'completion_state' || field === 'completion_status';
    const isSafetyField = field.startsWith('safety.') || isCompletionField;

    // 08 class 7 — incorrect safety / return-to-service assertion without
    // technician confirmation.
    if (isSafetyField && status !== SUPPORT_STATUSES.CONFIRMED_BY_TECHNICIAN) {
      const low = text.toLowerCase();
      if (RETURN_TO_SERVICE_WORDS.some((word) => low.includes(word.toLowerCase()))) {
        push('INCORRECT_SAFETY_RETURN_TO_SERVICE', field,
          `Return-to-service/safety assertion "${text}" on ${field} lacks CONFIRMED_BY_TECHNICIAN support.`);
      }
    }

    // 08 class 5 — completion state outside the shared allow-list, unconfirmed.
    if (field === 'completion.state' && status !== SUPPORT_STATUSES.CONFIRMED_BY_TECHNICIAN) {
      const candidate = text.trim().toLowerCase().replace(/-/g, '_');
      const allowed = COMPLETION_STATES.has(candidate)
        || COMPLETION_STATES.has(candidate.replace(/_/g, '-'));
      if (!allowed) {
        push('INCORRECT_COMPLETION_STATE', field,
          `Completion state "${text}" is not in the allowed enum [completed, deferred, off-road, out_of_service, restricted_speed] and lacks technician confirmation.`);
      }
    }

    // 08 class 6 — invented test / test result (UNCERTAIN or knowledge-sourced).
    if ((field === 'test.result' || field === 'test_results' || field === 'test_result' || field.startsWith('test.'))
      && (status === SUPPORT_STATUSES.UNCERTAIN || /knowledge/i.test(source))) {
      const why = status === SUPPORT_STATUSES.UNCERTAIN ? 'UNCERTAIN' : 'knowledge-sourced';
      push('INVENTED_TEST_RESULT', field,
        `Test result "${text}" is ${why}; it must not be rendered as a performed test.`);
    }

    // 08 class 2 — changed numerical value / unit. Identity fields
    // (asset/part/fault identifiers, isIdentityField) are NOT measurements:
    // the 08 class 2 unit check targets measured values, so identifiers like
    // plate "SBS6025Z" or train set "C751A" must not be read as "number +
    // inline unit" and must never raise CHANGED_NUMBER_UNIT.
    if (!isIdentityField(field)) {
      const unitIssue = checkNumberUnit({ scopeId, fact });
      if (unitIssue) push('CHANGED_NUMBER_UNIT', field, unitIssue);
    }

    // 08 class 3 — wrong asset/part/fault identity (empty or garbled).
    if (isIdentityField(field) && (text.trim() === '' || GARBLED_RE.test(text))) {
      const reason = text.trim() === '' ? 'empty' : 'garbled';
      push('WRONG_IDENTITY', field, `Identity field ${field} is ${reason}: "${text}".`);
    }

    // 08 class 9 — unsupported maintenance fact from RAG (knowledge never
    // creates a service action).
    if (/knowledge/i.test(source) && SERVICE_ACTION_FIELDS.has(field)) {
      push('RAG_UNSUPPORTED_FACT', field,
        `Fact ${field} is sourced from knowledge but describes a service action; RAG must not create service facts.`);
    }

    // 08 class 8 / class 10 — cross-domain leakage / user-upload contamination.
    {
      const leaked = forbidden.find((token) => source.toUpperCase().includes(token));
      if (leaked) {
        const cls = /upload/i.test(source) ? 'UPLOAD_CONTAMINATION' : 'CROSS_DOMAIN_LEAKAGE';
        push(cls, field,
          `Source "${source}" references ${leaked} inside a ${scopeId} report (cross-scope isolation violated).`);
      }
    }

    // 08 class 1 — changed negation: a negated statement whose support is
    // UNCERTAIN must not be flipped into an affirmative claim.
    if (NEGATION_RE.test(text) && status === SUPPORT_STATUSES.UNCERTAIN) {
      push('CHANGED_NEGATION', field,
        `Negated statement "${text}" on ${field} is UNCERTAIN; negation must not be flipped.`);
    }

    // 08 class 4 (merged) — an action claimed with UNCERTAIN support.
    if (claimsAction(field, value) && status === SUPPORT_STATUSES.UNCERTAIN) {
      push('INVENTED_ACTION_REPLACEMENT', field,
        `Fact ${field} claims an action ("${text}") with UNCERTAIN support; no grounded transcript/technician evidence.`);
    }
  }

  return Object.freeze({ violations: Object.freeze(violations) });
}

/**
 * Deterministic report plan: full scope section list plus the required
 * sections that have no grounded fact coverage (06 §2.2/§2.3, §3; V1 plan
 * discipline). Provenance counts as covered when a facts receipt id is given.
 *
 * @param {{ scopeId: string, facts?: Array<object>, factsReceiptId?: string }} params
 * @returns {{ scopeId: string, sections: ReadonlyArray<Readonly<{ id: string, title: string, required: boolean }>>, missing_required_fields: ReadonlyArray<string> }}
 */
export function planV2Report({ scopeId, facts = [], factsReceiptId } = {}) {
  assertSupportedScope(scopeId);
  const meta = SECTIONS_BY_SCOPE[scopeId];
  const covered = new Set();
  for (const fact of facts) {
    if (!isUsableFact(fact)) continue;
    const sectionId = sectionOf(scopeId, fact.field);
    if (sectionId) covered.add(sectionId);
  }
  if (factsReceiptId) covered.add('provenance');
  const missing = meta.filter((section) => section.required && !covered.has(section.id)).map((section) => section.id);
  return Object.freeze({
    scopeId,
    sections: Object.freeze(meta.map((section) => Object.freeze({
      id: section.id,
      title: section.title,
      required: section.required,
    }))),
    missing_required_fields: Object.freeze(missing),
  });
}
