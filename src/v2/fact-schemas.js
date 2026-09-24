/**
 * V2 SBS fact schema — scoped, versioned fact fields for the SBS Bus and
 * SBS Rail domains.
 *
 * This module is the single source of truth for which fact fields a V2 SBS
 * scope may carry and which of them are critical (hard-gate routed). It is
 * the interface contract later V2 workers import from; do not change the
 * export names without coordinating with them.
 *
 * Design basis (docs/v2-research):
 *   - 03_SBS_BUS_DOMAIN_MODEL.md  §2  — Bus fact fields, tags, evidence
 *   - 04_SBS_RAIL_DOMAIN_MODEL.md §2  — Rail fact fields, tags, evidence
 *   - 05_V2_FACT_SCHEMA_DRAFT.md  §3/§5 — fact object, support status,
 *     manual-only fields
 *
 * Field `tag` and `evidence_level` are taken strictly from those design
 * documents (evidence levels per contract §6: A = SBS-specific, B =
 * Singapore transport-sector, C = comparable-industry, D =
 * inference/assumption). C/D evidence is never rewritten as an SBS fact:
 * REQUIRES_SBS_CONFIRMATION / PROVISIONAL fields must not be auto-filled
 * from knowledge and only enter via technician/transcript input.
 *
 * Scope isolation (05 §1.4 / §4): a fact schema instance is always evaluated
 * inside one scope; cross-scope fields are hard errors. Rail is NOT a clone
 * of Bus — each scope carries its own asset/work/completion vocabulary
 * (e.g. rail has `asset.train_set` and `access.approval`; bus has
 * `asset.registration_no` and `asset.package`).
 */

/** @type {ReadonlyArray<string>} */
export const SUPPORTED_V2_SCOPES = Object.freeze(['SBS_BUS', 'SBS_RAIL']);

/**
 * Bus fact-field catalog (03 §2, asset naming per 05 §3.3). Each entry:
 * { field, type, tag, evidence_level, critical, notes }.
 * `field` entries ending in `.*` are wildcard families (any sub-field under
 * that prefix, e.g. `safety.hv_isolation` matches `safety.*`).
 *
 * @type {ReadonlyArray<Readonly<{ field: string, type: string, tag: string, evidence_level: string, critical: boolean, notes: string }>>}
 */
export const BUS_FACT_FIELDS = Object.freeze([
  Object.freeze({
    field: 'asset.registration_no',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'B',
    critical: true,
    notes: 'VRN, e.g. SG3050Z; OneMotoring bus registration (B), SBS fleet registrations (B/C); wrong-identity gate (05 §4).',
  }),
  Object.freeze({
    field: 'asset.internal_fleet_no',
    type: 'string',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    evidence_level: 'D',
    critical: false,
    notes: 'Internal fleet number NOT PUBLICLY VERIFIED (03 §2).',
  }),
  Object.freeze({
    field: 'asset.bus_model',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'B',
    critical: false,
    notes: 'Chassis/body model, e.g. MAN A95, BYD K9, Scania K230UB, MB Citaro O530; fleet census (B/C).',
  }),
  Object.freeze({
    field: 'asset.depot',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Depot names, e.g. Seletar, Ulu Pandan, Hougang, Bedok North, Sengkang West (A); exhaustive registry NOT PUBLICLY VERIFIED.',
  }),
  Object.freeze({
    field: 'asset.package',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'LTA bus package (scope binding), e.g. Jurong West, Seletar, Bukit Merah (8 packages — A); package↔depot↔route map NOT PUBLICLY VERIFIED.',
  }),
  Object.freeze({
    field: 'work.type',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Maintenance type: preventive / corrective / condition-based / statutory (A).',
  }),
  Object.freeze({
    field: 'work.trigger',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Trigger: pre-use checklist / periodic / condition alert / defect report; per-type cadence NOT PUBLICLY VERIFIED.',
  }),
  Object.freeze({
    field: 'work.work_order_id',
    type: 'string',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    evidence_level: 'D',
    critical: false,
    notes: 'Work-order identifier; format NOT PUBLICLY VERIFIED (03 §2).',
  }),
  Object.freeze({
    field: 'work.fault_code',
    type: 'string',
    tag: 'PROVISIONAL',
    evidence_level: 'C',
    critical: true,
    notes: 'Fault code; J1939 SPN/FMI family (C), Stratio parameter (A); SBS catalogue REQUIRES SBS CONFIRMATION; wrong-identity gate (05 §4).',
  }),
  Object.freeze({
    field: 'work.description',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Free text of task; technician work instructions exist (A).',
  }),
  Object.freeze({
    field: 'diagnosis.root_cause',
    type: 'string',
    tag: 'PROVISIONAL',
    evidence_level: 'C',
    critical: false,
    notes: 'Root cause, e.g. brake pad wear, fluid leak; ISO 14224 maintenance-data model (C).',
  }),
  Object.freeze({
    field: 'parts.part_number',
    type: 'string',
    tag: 'PROVISIONAL',
    evidence_level: 'C',
    critical: true,
    notes: 'Replaced part + number; part-number scheme REQUIRES SBS CONFIRMATION; wrong-identity gate (05 §4).',
  }),
  Object.freeze({
    field: 'parts.replaced',
    type: 'boolean',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: true,
    notes: 'Whether a part was replaced (yes/no); parts-information access (A); invented-action gate (05 §4).',
  }),
  Object.freeze({
    field: 'measurement.*',
    type: 'number',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: true,
    notes: 'Numeric measurements: km, %, bar/kPa, mm, °C, MWh (A/B); numeric thresholds NOT PUBLICLY VERIFIED; changed-value/unit gate (05 §4).',
  }),
  Object.freeze({
    field: 'test.result',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'B',
    critical: true,
    notes: 'Post-work test outcome, e.g. brake efficiency, emissions; statutory categories (B); pass thresholds NOT PUBLICLY VERIFIED; invented-test gate (05 §4).',
  }),
  Object.freeze({
    field: 'completion.state',
    type: 'string',
    tag: 'PROVISIONAL',
    evidence_level: 'C',
    critical: true,
    notes: 'Completion / return-to-service: completed / deferred / off-road; REQUIRES SBS CONFIRMATION; completion-state + return-to-service gates (05 §4).',
  }),
  Object.freeze({
    field: 'safety.*',
    type: 'structured',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: true,
    notes: 'Safety-critical items: HV isolation, fire response, faulty safety devices; NESS HV cert (A), WSHC vehicle factors (B); procedures NOT PUBLICLY VERIFIED; safety/return-to-service gate (05 §4).',
  }),
  Object.freeze({
    field: 'provenance.*',
    type: 'structured',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Source traceability: transcript, upload, knowledge; V1 receipts baseline (A).',
  }),
]);

/**
 * Rail fact-field catalog (04 §2). Rail is NOT a clone of Bus: it has its
 * own assets (`asset.line`, `asset.train_set`, `asset.car`,
 * `asset.stock_class`, `asset.subsystem`), `work.order_id`, TAMS track-access
 * (`access.approval`) and `reliability.*` KPI context, and omits bus-only
 * fields such as `asset.registration_no` and `asset.package`.
 *
 * @type {ReadonlyArray<Readonly<{ field: string, type: string, tag: string, evidence_level: string, critical: boolean, notes: string }>>}
 */
export const RAIL_FACT_FIELDS = Object.freeze([
  Object.freeze({
    field: 'asset.line',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Line: NEL / DTL / SPLRT / (JRL future) (A).',
  }),
  Object.freeze({
    field: 'asset.train_set',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'B',
    critical: true,
    notes: 'Train-set identifier, e.g. C751A 7001/7002–7049/7050, C951 9001–9092 (B/C); official register REQUIRES SBS CONFIRMATION; wrong-identity gate (05 §4).',
  }),
  Object.freeze({
    field: 'asset.car',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'B',
    critical: false,
    notes: 'Individual car: 5-digit serial (7xxxx) + carriage type DT/Mi/Mp (B/C); official register NOT PUBLICLY VERIFIED.',
  }),
  Object.freeze({
    field: 'asset.stock_class',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Rolling-stock class: Alstom C751A/C751C/C851E, Movia C951/C951A, Crystal Mover C810/C810A/C810D (A/B).',
  }),
  Object.freeze({
    field: 'asset.subsystem',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Subsystem/component: traction, bogie, brake, door, pantograph/collector shoe, point machine, track, third rail/OCS (A/B/C).',
  }),
  Object.freeze({
    field: 'work.type',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Maintenance type: corrective / preventive / condition-based / mid-life refurbishment (A).',
  }),
  Object.freeze({
    field: 'work.trigger',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Trigger: condition alert / scheduled / fault report / track-inspection finding; cadence NOT PUBLICLY VERIFIED.',
  }),
  Object.freeze({
    field: 'work.order_id',
    type: 'string',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    evidence_level: 'D',
    critical: false,
    notes: 'Work-order identifier; format REQUIRES SBS CONFIRMATION (04 §2).',
  }),
  Object.freeze({
    field: 'work.fault_code',
    type: 'string',
    tag: 'PROVISIONAL',
    evidence_level: 'C',
    critical: true,
    notes: 'Fault code / defect type, e.g. faulty lighting, open panels, surface damage (A examples); OEM families (C); SBS catalogue REQUIRES SBS CONFIRMATION; wrong-identity gate (05 §4).',
  }),
  Object.freeze({
    field: 'diagnosis.root_cause',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Root cause, e.g. faulty voltage transformer + switchboard components (Aug 2025 — A).',
  }),
  Object.freeze({
    field: 'parts.part_number',
    type: 'string',
    tag: 'PROVISIONAL',
    evidence_level: 'C',
    critical: true,
    notes: 'Replaced part; REQUIRES SBS CONFIRMATION; wrong-identity gate (05 §4).',
  }),
  Object.freeze({
    field: 'measurement.*',
    type: 'number',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: true,
    notes: 'Track/asset measurements: rail-defect depth, track geometry, third-rail alignment, wheel/brake wear mm (A); thresholds NOT PUBLICLY VERIFIED; changed-value/unit gate (05 §4).',
  }),
  Object.freeze({
    field: 'test.result',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: true,
    notes: 'Test outcome: ultrasonic/laser inspection results, post-repair verification (A); pass criteria NOT PUBLICLY VERIFIED; invented-test gate (05 §4).',
  }),
  Object.freeze({
    field: 'access.approval',
    type: 'string',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: true,
    notes: 'TAMS track-access approval: request → approved (A); trackside work must record authorised access (04 §2.1).',
  }),
  Object.freeze({
    field: 'completion.state',
    type: 'string',
    tag: 'PROVISIONAL',
    evidence_level: 'C',
    critical: true,
    notes: 'Completion / return-to-service: completed / deferred / restricted-speed / train out of service; REQUIRES SBS CONFIRMATION; return-to-service gate (05 §4).',
  }),
  Object.freeze({
    field: 'safety.*',
    type: 'structured',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: true,
    notes: 'Safety-critical: RTSA Part 4 safety duties, OPS safety dimension, VAnGuard intrusion detection, evacuation exercises (A/B); procedure text NOT PUBLICLY VERIFIED; safety/return-to-service gate (05 §4).',
  }),
  Object.freeze({
    field: 'reliability.*',
    type: 'structured',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Reliability KPI context: MKBF train-km/car-km per line, >30-min delay counts (A/B).',
  }),
  Object.freeze({
    field: 'provenance.*',
    type: 'structured',
    tag: 'CONFIRMED_BY_EVIDENCE',
    evidence_level: 'A',
    critical: false,
    notes: 'Source traceability: transcript, upload, knowledge; V1 receipts baseline (A).',
  }),
]);

/** @type {Readonly<Record<string, ReadonlyArray<object>>>} */
const FACT_FIELDS_BY_SCOPE = Object.freeze({
  SBS_BUS: BUS_FACT_FIELDS,
  SBS_RAIL: RAIL_FACT_FIELDS,
});

/**
 * Reports whether a fact field is critical (hard-gate routed) in a given
 * scope. Wildcard catalog entries ending in `.*` match any sub-field under
 * that prefix (e.g. `safety.hv_isolation` matches `safety.*`). Unknown
 * fields inside a known scope return false; unknown scopes throw.
 *
 * @param {{ scopeId: string, field: string }} params
 * @returns {boolean}
 */
export function isCriticalField({ scopeId, field }) {
  const catalog = FACT_FIELDS_BY_SCOPE[scopeId];
  if (!catalog) {
    throw new Error(
      `Unknown V2 scope "${scopeId}". Expected one of: ${SUPPORTED_V2_SCOPES.join(', ')}.`,
    );
  }
  const key = String(field ?? '');
  const entry = catalog.find(
    (candidate) => candidate.field === key
      || (candidate.field.endsWith('.*') && key.startsWith(candidate.field.slice(0, -1))),
  );
  return entry?.critical === true;
}

/**
 * Support statuses carried by every V2 fact (V1 statuses preserved, 05 §3.2):
 * DIRECT_TRANSCRIPT / MANUAL_ENTRY / CONFIRMED_BY_TECHNICIAN / UNCERTAIN.
 *
 * @type {Readonly<Record<'DIRECT_TRANSCRIPT'|'MANUAL_ENTRY'|'CONFIRMED_BY_TECHNICIAN'|'UNCERTAIN', string>>}
 */
export const SUPPORT_STATUSES = Object.freeze({
  DIRECT_TRANSCRIPT: 'DIRECT_TRANSCRIPT',
  MANUAL_ENTRY: 'MANUAL_ENTRY',
  CONFIRMED_BY_TECHNICIAN: 'CONFIRMED_BY_TECHNICIAN',
  UNCERTAIN: 'UNCERTAIN',
});

/**
 * Manual-only fields (V2): V1 `cost_quote`/`warranty` retained plus SBS
 * candidates `estimated_completion_time`, `part_price`, `contract_reference`,
 * `penalty_or_claim` (05 §5). These must never be auto-filled from knowledge;
 * they enter only via technician input.
 *
 * @type {ReadonlyArray<Readonly<{ field: string, tag: string, notes: string }>>}
 */
export const MANUAL_ONLY_FIELDS_V2 = Object.freeze([
  Object.freeze({
    field: 'cost_quote',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    notes: 'V1 manual-only field, retained (05 §2/§5); enters only via technician input.',
  }),
  Object.freeze({
    field: 'warranty',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    notes: 'V1 manual-only field, retained (05 §2/§5); enters only via technician input.',
  }),
  Object.freeze({
    field: 'estimated_completion_time',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    notes: 'Candidate (05 §5): bus/rail estimated completion time; never auto-filled from knowledge.',
  }),
  Object.freeze({
    field: 'part_price',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    notes: 'Candidate (05 §5): part price; never auto-filled from knowledge.',
  }),
  Object.freeze({
    field: 'contract_reference',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    notes: 'Candidate (05 §5): package/licence contract reference; never auto-filled from knowledge.',
  }),
  Object.freeze({
    field: 'penalty_or_claim',
    tag: 'REQUIRES_SBS_CONFIRMATION',
    notes: 'Candidate (05 §5): penalty/claim references; never auto-filled from knowledge.',
  }),
]);
