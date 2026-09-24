# 05 — V2 Fact Schema Draft

Status: DRAFT FOR PRE-FREEZE RESEARCH (not frozen)
Governing contract: `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` (§3 hypothesis, §7 Phase C, §9,
§10, §12)
Baseline: V1 `ALLOWED_FACT_FIELDS` / `SUPPORT_STATUSES` / `MANUAL_ONLY_FIELDS` /
`FIELD_TO_SECTION` in `src/tools/hvac-schema.js` (HVAC scope, single domain).

This document proposes a **scoped, versioned fact schema** for V2 that extends the V1
invariants (immutable raw transcript, hash-bound receipts, independent validator,
technician confirmation, knowledge-never-creates-service-facts) to SBS Bus and SBS Rail.
It is a design draft: every field is tagged **CONFIRMED BY EVIDENCE** / **PROVISIONAL** /
**REQUIRES SBS CONFIRMATION**, and evidence levels follow contract §6. C/D evidence is never
rewritten as an SBS fact.

---

## 1. Design principles (carried from V1, preserved — contract §2/§16)

1. **Transcript is the only service-action evidence.** Knowledge/RAG is context for
   interpretation; it never creates a fact that a service action occurred (contract §3).
2. **Every fact carries a support status** (V1: DIRECT_TRANSCRIPT / MANUAL_ENTRY /
   CONFIRMED_BY_TECHNICIAN / UNCERTAIN) and is bound into a facts receipt with hashes and
   knowledge-version references.
3. **Manual-only fields** (V1: cost_quote, warranty) stay manual-only; new manual-only
   candidates are listed in §5.
4. **Scope isolation** (contract §8): a fact schema instance is always evaluated inside one
   context (HVAC | SBS/Bus | SBS/Rail); cross-scope facts are hard errors (contract §12).
5. **SBS facts must not be invented from manuals**: fault codes, part numbers, thresholds
   are only recorded when stated by the technician/transcript or an SBS-confirmed source.

---

## 2. V1 → V2 field mapping (HVAC compatibility preserved)

| V1 field (HVAC) | V2 handling | Notes |
| --- | --- | --- |
| work_order | retained, per-context identifier (HVAC work order / bus WO / rail WO) | identifier format varies by context; SBS formats NOT PUBLICLY VERIFIED |
| equipment | → `asset` object (see §3) | V2 upgrades scalar to structured asset |
| customer_complaint | retained | — |
| inspection_findings | retained | per-context findings vocabulary |
| work_performed | retained | must never be filled from knowledge alone |
| parts_used | retained; part-number field added | part-number scheme REQUIRES SBS CONFIRMATION |
| test_results | retained | pass thresholds per context NOT PUBLICLY VERIFIED |
| completion_status | retained | states per context; SBS states REQUIRES SBS CONFIRMATION |
| unresolved_issues / follow_up_recommendations | retained | — |
| refrigerant_record | HVAC-only | kept in HVAC scope; not copied to SBS |
| measurements | retained; units dictionary per context | units: km, %, bar, mm, °C, V, kWh/MWh, g/kWh (evidence A/B) |
| attachments | retained | text-bearing uploads only (contract §10) |
| cost_quote / warranty | retained, manual-only | — |
| customer_feedback | retained | — |

---

## 3. Proposed V2 fact schema (scoped)

### 3.1 Common envelope (all scopes)

| Field | Type | Support-status rule | Tag |
| --- | --- | --- | --- |
| `schema_version` | string | system | CONFIRMED BY EVIDENCE (V1 versioning) |
| `context` | enum: HVAC \| SBS_BUS \| SBS_RAIL | system; determines scope | CONFIRMED BY EVIDENCE (contract §1) |
| `knowledge_version` | {scope: version} | system; bound into receipt | CONFIRMED BY EVIDENCE (V1) |
| `upload_versions` | map upload_id → parsed version | system; provenance for user uploads | CONFIRMED BY EVIDENCE (contract §10) |
| `transcript_hash` / `correction_receipt_hash` / `facts_hash` | hashes | system | CONFIRMED BY EVIDENCE (V1) |
| `facts[]` | array of fact objects (§3.2) | — | CONFIRMED BY EVIDENCE (V1 facts receipt) |

### 3.2 Fact object

| Field | Type | Tag | Notes |
| --- | --- | --- | --- |
| `field` | string (schema-controlled) | CONFIRMED BY EVIDENCE | field names per scope schema |
| `value` | string \| number \| structured | CONFIRMED BY EVIDENCE | validated by per-field rule |
| `unit` | string | CONFIRMED BY EVIDENCE | from scope units dictionary (A/B) |
| `support_status` | DIRECT_TRANSCRIPT \| MANUAL_ENTRY \| CONFIRMED_BY_TECHNICIAN \| UNCERTAIN | CONFIRMED BY EVIDENCE | V1 statuses preserved |
| `source` | transcript segment \| upload ref \| knowledge ref \| technician input | CONFIRMED BY EVIDENCE | provenance |
| `critical` | bool + critical-error class (§08) | CONFIRMED BY EVIDENCE | hard-gate routing |
| `confidence` | low/med/high | PROVISIONAL | optional; never replaces hard gates |

### 3.3 Asset object (per scope)

**HVAC** (unchanged semantics): `equipment` string + existing fields. — CONFIRMED BY EVIDENCE.

**SBS_BUS**:

| Field | Tag | Evidence |
| --- | --- | --- |
| `registration_no` (VRN) | CONFIRMED BY EVIDENCE | OneMotoring bus registration (B); SBS fleet registrations (B/C) |
| `internal_fleet_no` | REQUIRES SBS CONFIRMATION | NOT PUBLICLY VERIFIED |
| `model` (chassis/body) | CONFIRMED BY EVIDENCE | fleet census (B/C) |
| `depot` | CONFIRMED BY EVIDENCE (names) | ARs (A); exhaustive registry REQUIRES SBS CONFIRMATION |
| `package` (LTA bus package) | CONFIRMED BY EVIDENCE | AR2024 (A) |
| `route/service` | CONFIRMED BY EVIDENCE | SBS site (A) |

**SBS_RAIL**:

| Field | Tag | Evidence |
| --- | --- | --- |
| `line` (NEL/DTL/SPLRT) | CONFIRMED BY EVIDENCE | SBS/LTA (A/B) |
| `stock_class` | CONFIRMED BY EVIDENCE | LTA NEL page, class pages (A/B/C) |
| `train_set` (fleet number) | CONFIRMED BY EVIDENCE (scheme) | B/C; official register REQUIRES SBS CONFIRMATION |
| `car` + carriage type (DT/Mi/Mp) | CONFIRMED BY EVIDENCE (scheme) | B/C |
| `subsystem` | CONFIRMED BY EVIDENCE | A/B/C |
| `depot/facility` | CONFIRMED BY EVIDENCE (names) | A/B; machine inventory NOT PUBLICLY VERIFIED |

---

## 4. Critical fields and hard-gate routing (see `08_V2_CRITICAL_ERROR_TAXONOMY.md` for the
full taxonomy; summary here)

Facts whose **error class** is in the hard-failure set (contract §12) must route through a
hard gate (cannot be hidden by average accuracy — contract §12, §13):

| Critical fact group | Example | V2 rule |
| --- | --- | --- |
| Negation | "did NOT replace" → "replaced" | changed-negation gate |
| Numbers/units | 3 bar → 30 bar; kW→kWh | changed-value/unit gate |
| Identity | wrong VRN, train set, part number, fault code | wrong-identity gate |
| Actions/replacements | invented replacement from manual | invented-action gate (contract §3, §13) |
| Completion | "completed" vs "deferred" vs "off-road" | completion-state gate |
| Tests | invented test/result | invented-test gate |
| Safety/return-to-service | "back in service" without confirmation | safety/return-to-service gate |
| Scope leakage | SBS/Bus retrieves HVAC or SBS/Rail | cross-domain gate |
| RAG-unsupported fact | manual-only claim recorded as observed | RAG-unsupported gate |
| Upload contamination | upload from scope A used in scope B | upload-contamination gate |

---

## 5. Manual-only field candidates (PROVISIONAL — REQUIRES SBS CONFIRMATION)

- `cost_quote`, `warranty` (V1, retained).
- Candidates from SBS domains: `estimated_completion_time` (bus/rail), `part_price`,
  `contract_reference` (package/licence), `penalty_or_claim` references. These must never be
  auto-filled from knowledge; they enter only via technician input (V1 pattern).

---

## 6. Structured knowledge vs RAG inputs to the schema (contract §9; detail in 09 §4)

- **Structured (versioned knowledge files per scope):** terminology, model/class ontology,
  registration ranges, part-number families, fault-code families (SBS-confirmed ones only),
  units dictionary, allowed values/enums, hard validation rules, depot/package/facility
  registries, KPI dictionary (MKBF, BSRF).
- **RAG (embeddings):** OEM e-manuals, SOPs, maintenance guides, historical reports,
  supported user uploads (PDF/DOCX/TXT/CSV), with provenance + scenario metadata (contract §10).
- **Boundary:** RAG content may assist interpretation but never creates service facts
  (contract §3, §13); this is enforced at the fact-schema layer by `support_status` and
  `source` constraints, not by retrieval tuning alone.

---

## 7. Open items (NOT PUBLICLY VERIFIED — see `10_SBS_INFORMATION_GAPS.md`)

- SBS bus work-order/fault-code/part-number conventions
- SBS rail work-order/fault-code formats and train-set register
- SBS completion-state vocabulary and return-to-service criteria
- SBS units/thresholds dictionaries (brake %, kPa, tyre mm, wheel-wear mm)
- SBS report templates (affect which fields a report must cover)

---

*End of 05_V2_FACT_SCHEMA_DRAFT.md*
