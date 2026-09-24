# 06 — V2 Report Schema Draft

Status: DRAFT FOR PRE-FREEZE RESEARCH (not frozen)
Governing contract: `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` (§3 hypothesis, §7 Phase C,
§12 critical errors, §13 acceptance test)
Baseline: V1 `report-modules.v1.json` + `FIELD_TO_SECTION` (HVAC) in `src/tools/hvac-schema.js`.

This draft extends V1 report generation to SBS Bus and SBS Rail while preserving V1
invariants (report grounded in structured facts, independent validation, technician
confirmation, provenance). Every section is tagged **CONFIRMED BY EVIDENCE** / **PROVISIONAL**
/ **REQUIRES SBS CONFIRMATION**.

---

## 1. V1 report model (baseline)

- V1 generates a context-appropriate report from structured facts via **report modules**
  (`data/knowledge/report-modules.v1.json`): fixed sections + conditional sections +
  required fields, with `FIELD_TO_SECTION` mapping facts to report sections.
- Report content is grounded in the facts receipt (hash-bound); independent Validator
  checks consistency; technician confirms final output (README baseline).

## 2. V2 report structure per scope

### 2.1 HVAC (unchanged; compatibility preserved)

Keep V1 modules and `FIELD_TO_SECTION` as-is. V2 may only add scoped extensions that do not
alter HVAC behavior. — CONFIRMED BY EVIDENCE (V1 baseline).

### 2.2 SBS Bus — candidate report schema

Sections are PROVISIONAL (informed by statutory/contractual obligations — B + A) unless
tagged otherwise:

| Section | Contents (fact fields) | Tag |
| --- | --- | --- |
| 1. Vehicle identification | VRN, model, odometer, depot, package, route/service | CONFIRMED BY EVIDENCE (identity sources B/A) |
| 2. Works summary | work type, date, work order id, trigger | PROVISIONAL (work-order id format REQUIRES SBS CONFIRMATION) |
| 3. Inspection/fault findings | per-item findings, defects, fault code | CONFIRMED BY EVIDENCE (statutory categories B); fault-code catalogue REQUIRES SBS CONFIRMATION |
| 4. Diagnosis / root cause | diagnosis, root cause | PROVISIONAL |
| 5. Work performed | actions, work instructions referenced | CONFIRMED BY EVIDENCE (A); actions only from transcript |
| 6. Parts and materials | part numbers, quantities | PROVISIONAL; scheme REQUIRES SBS CONFIRMATION |
| 7. Tests and results | brake, emissions, electrical; results | CONFIRMED BY EVIDENCE (statutory checks B); pass thresholds NOT PUBLICLY VERIFIED |
| 8. Completion state | completed/deferred/off-road; return-to-service | PROVISIONAL; REQUIRES SBS CONFIRMATION |
| 9. Safety/HV notes | HV isolation, NESS cert, safety-device findings | CONFIRMED BY EVIDENCE (program exists A; WSHC B); procedure text NOT PUBLICLY VERIFIED |
| 10. Compliance/audit block | inspection due date, licence/package refs, LTA standards | CONFIRMED BY EVIDENCE (obligations B/A); formats NOT PUBLICLY VERIFIED |
| 11. Provenance/traceability | receipts, uploads, knowledge versions | CONFIRMED BY EVIDENCE (V1) |

### 2.3 SBS Rail — candidate report schema

| Section | Contents | Tag |
| --- | --- | --- |
| 1. Asset identification | line, stock class, train set, car, subsystem | CONFIRMED BY EVIDENCE (A/B/C); register REQUIRES SBS CONFIRMATION |
| 2. Works summary | work type, date, work order, location (depot/trackside) | PROVISIONAL |
| 3. Trigger/fault findings | condition alert, fault report, inspection finding | CONFIRMED BY EVIDENCE (A: condition monitoring, AVATAR examples) |
| 4. Diagnosis / root cause | diagnosis, root cause (e.g., Aug 2025 power-fault RCA) | CONFIRMED BY EVIDENCE (example A) |
| 5. Work performed | actions | CONFIRMED BY EVIDENCE (A) |
| 6. Parts and materials | part numbers | PROVISIONAL |
| 7. Tests and results | ultrasonic, laser geometry, electrical tests | CONFIRMED BY EVIDENCE (capabilities A); pass criteria NOT PUBLICLY VERIFIED |
| 8. Track access record | TAMS request→approval, lead time | CONFIRMED BY EVIDENCE (A) |
| 9. Completion state / return-to-service | completed / restricted-speed / out-of-service | PROVISIONAL; REQUIRES SBS CONFIRMATION |
| 10. Safety/OPS notes | RTSA Part 4 context, VAnGuard events, OPS | CONFIRMED BY EVIDENCE (obligations A/B) |
| 11. Reliability/compliance block | MKBF context, NRFF submissions, OPS | CONFIRMED BY EVIDENCE (A/B) |
| 12. Provenance/traceability | receipts | CONFIRMED BY EVIDENCE (V1) |

### 2.4 Report-type registry (PROVISIONAL — REQUIRES SBS CONFIRMATION)

- **HVAC:** V1 report types unchanged.
- **Bus:** daily/pre-use record; periodic inspection record; corrective work-order report;
  condition-based service report; breakdown/incident report; statutory-inspection support
  record.
- **Rail:** scheduled-service record; condition-based service record; track-inspection
  report; corrective work-order report; incident/power-fault report; mid-life-refurbishment
  progress record; regulatory-submission support record (NRFF annual maintenance plans /
  fault-trend analyses — B).
- SBS's actual templates (paper/PDF/DMS) are **NOT PUBLICLY VERIFIED**; the registry above is
  a candidate list to confirm.

## 3. Report grounding rules (V1 invariants preserved; contract §3, §13)

1. Every report claim must trace to a fact in the facts receipt (`support_status` +
   `source`).
2. Knowledge/RAG may suggest wording but must never inject a service fact. E.g., an uploaded
   manual recommending replacement must not produce "ZX-47 replaced" unless the transcript or
   technician input says replacement occurred (contract §13).
3. Safety/return-to-service statements require `CONFIRMED_BY_TECHNICIAN` support status; they
   are hard-gated (contract §12).
4. Cross-scope references (e.g., a Bus report citing SBS/Rail knowledge) are hard errors.
5. Independent Validator re-checks: required-field coverage, unsupported claims, structure,
   consistency with structured facts, provenance (contract §11 Report Eval).

## 4. Report evaluation hooks (see `07_V2_EVAL_SPEC_DRAFT.md` §4)

- factual grounding, required-field coverage, unsupported claims, structure, consistency
  with structured facts, provenance/traceability.
- Hard-gate checks: no invented action/replacement/test; no incorrect completion/safety/
  return-to-service state; no cross-domain leakage; no upload contamination.

---

*End of 06_V2_REPORT_SCHEMA_DRAFT.md*
