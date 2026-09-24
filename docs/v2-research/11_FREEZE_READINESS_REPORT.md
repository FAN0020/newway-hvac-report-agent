# 11 — SBS V2 Freeze-Readiness Report

Status: RESEARCH OUTPUT (not frozen) — Phase E of `docs/PRE_FREEZE_RESEARCH_CONTRACT.md`
Governing contract: `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` §14 (Freeze Readiness), §15
(deliverables), §17 (completion standard).

This report classifies every major V2 requirement as **GREEN** (evidence/design sufficient to
freeze for implementation), **YELLOW** (provisional implementation contract possible but SBS
confirmation required before production reliance), or **RED** (insufficient information;
freezing would launder assumptions into requirements).

Companion documents: `01_SBS_DOMAIN_DISCOVERY.md` (A), `02_SBS_EVIDENCE_AUDIT.md` (B),
`03_SBS_BUS_DOMAIN_MODEL.md` / `04_SBS_RAIL_DOMAIN_MODEL.md` (C),
`05_V2_FACT_SCHEMA_DRAFT.md` / `06_V2_REPORT_SCHEMA_DRAFT.md` (C),
`07_V2_EVAL_SPEC_DRAFT.md` (D), `08_V2_CRITICAL_ERROR_TAXONOMY.md` (D),
`09_V2_KNOWLEDGE_SCOPE_DRAFT.md` (D), `10_SBS_INFORMATION_GAPS.md`.

---

## 1. Headline verdict

**Freeze-readiness: YELLOW overall.**

- The **V2 product hypothesis and architecture** (scoped knowledge, user upload,
  correction→facts→report→validation, hard gates, isolation invariant) are ready to freeze:
  they are design decisions grounded in the frozen contract (§3, §8–§13) and V1 invariants.
- The **SBS domain specifics** (workflows, fact schemas, report schemas, critical
  fields/errors) are PROVISIONAL: the public evidence base confirms many assets, systems and
  obligations exist, but SBS-internal formats, thresholds, states and templates are
  **NOT PUBLICLY VERIFIED**. These can be frozen as *provisional* implementation contracts
  **conditional on SBS confirmation** (YELLOW), and a small number of items are RED until
  resolved or explicitly de-scoped.

No requirement is frozen as an SBS fact where evidence does not support it (contract §16,
§17). Nothing below weakens V1 integrity controls.

---

## 2. Requirement-level freeze assessment (contract §14)

| Requirement | Evidence | Status | Remaining uncertainty | Recommended action |
| --- | --- | --- | --- | --- |
| V2 product hypothesis (context select → scoped knowledge → upload → correction → facts → report → validation → confirmation) | Contract §3 (frozen); V1 baseline | **GREEN** | None for hypothesis; scope-policy details below | Freeze hypothesis as written |
| Bus workflow model | A/B evidence: stages exist (pre-use checklist, statutory inspection 6-mo omnibus, work instructions, Stratio condition-based, parts, e-manuals) — 03 §1 | **YELLOW** | Internal interval values, work-order states, return-to-service/deferral rules NOT PUBLICLY VERIFIED (gaps B1–B4) | Freeze provisional workflow; confirm states/intervals with SBS; keep intervals out of hard requirements |
| Rail workflow model | A/B evidence: corrective+preventive per work instructions, condition monitoring, Rail Rover/ATI/AVI, TAMS access, NRFF reporting — 04 §1 | **YELLOW** | Interval schedules, fault-code taxonomy, return-to-service criteria NOT PUBLICLY VERIFIED (gaps R1–R4) | Freeze provisional workflow; confirm with SBS; keep numeric schedules out of hard requirements |
| Bus fact schema | 03 §2; assets (VRN/model/depot/package — A/B), units (A/B), statutory checks (B) confirmed; fault codes, part numbers, thresholds PROVISIONAL | **YELLOW** | B1–B6 | Freeze schema skeleton + confirmed fields; mark fault/part/threshold fields REQUIRES SBS CONFIRMATION |
| Rail fact schema | 04 §2; line/stock class/train set/subsystem/condition systems confirmed (A/B/C); work-order format, thresholds, register PROVISIONAL | **YELLOW** | R2–R5 | Freeze skeleton + confirmed fields; mark remaining REQUIRES SBS CONFIRMATION |
| Bus report schema | 06 §2.2; statutory/contractual section basis (B + A); SBS templates not public | **YELLOW** | B10; report-type registry | Freeze candidate schema as provisional; confirm templates with SBS |
| Rail report schema | 06 §2.3; asset/works/track-access/reliability/compliance sections (A/B); SBS templates not public | **YELLOW** | R12; report-type registry | Freeze candidate schema as provisional; confirm templates with SBS |
| Critical fields / hard-gate taxonomy | 08; contract §12 classes; V1 validator baseline (A) | **GREEN** (taxonomy/mechanism); **YELLOW** (per-scope field lists) | Per-scope critical-field enumeration needs SBS confirmation (e.g., which fields are safety-critical in their work orders) | Freeze taxonomy + gate design; confirm per-scope critical fields with SBS |
| Knowledge hierarchy (GLOBAL → ORGANIZATION → DOMAIN → USER-UPLOADED) | 09 §3; contract §8 | **GREEN** (evaluation complete; design justified) | None for V1 of the hierarchy; future subdivisions deferred | Freeze 09 hierarchy for implementation-contract scope |
| Cross-domain isolation invariant | 09 §3–§4; contract §8; V1 single-domain baseline | **GREEN** (mechanism); tested by 07 §1/§5 | None structural; needs SBS confirmation only for scope bindings (which knowledge belongs to Bus vs Rail vs shared) | Freeze invariant + tests |
| User-upload behavior (PDF/DOCX/TXT/CSV; Upload→Processing→Parsed/Chunked/Indexed→READY; provenance+scenario metadata) | 09 §5; contract §10 | **GREEN** for the ingestion contract; **YELLOW** for scope/metadata policy | Whether SBS would authorize such uploads (gap X6); exact metadata schema | Freeze ingestion contract + ZX-47 test; confirm authorization + metadata with SBS |
| Retrieval eval | 07 §1; contract §11 | **GREEN** (design ready) | Gold corpora are synthetic (labelled); no SBS data | Operationalize with synthetic corpus now; add SBS corpus when available |
| Transcript-correction eval | 07 §2; contract §11 | **GREEN** (design ready) | Real noisy transcripts unavailable | Use synthetic labelled transcripts; add SBS samples when available |
| Fact-extraction eval | 07 §3; contract §11 | **GREEN** (design ready) | Threshold/identity ground truth (gaps B6/R3) | Implement hard gates now; confirm thresholds with SBS |
| Report eval | 07 §4; contract §11 | **GREEN** (design ready) | Report-type/template ground truth (B10/R12) | Implement grounding/coverage/unsupported-claim checks now |
| End-to-end eval | 07 §5–§6; contract §11, §13 | **GREEN** (design ready incl. ZX-47) | Synthetic scenarios only | Implement E2E harness + ZX-47 acceptance test at implementation start |
| V1 integrity preservation | Contract §2/§16; V1 baseline | **GREEN** | — | Carry all V1 controls (immutable transcript, hashes, receipts, validator, technician confirmation, manual-only fields) into V2 unchanged |

---

## 3. Per-status summary

**GREEN (freeze now):** V2 hypothesis; hard-gate taxonomy + mechanism; knowledge hierarchy;
cross-domain isolation invariant (mechanism); user-upload ingestion contract; all five eval
designs (retrieval/correction/fact/report/E2E incl. ZX-47); V1 integrity preservation.

**YELLOW (provisional contract, SBS confirmation before production reliance):**
Bus workflow; Rail workflow; Bus fact schema; Rail fact schema; Bus report schema; Rail
report schema; per-scope critical-field lists; user-upload scope/metadata policy.

**RED (insufficient; do not freeze without resolution or explicit de-scoping):**
- **R3 / B6 numeric thresholds** (wheel/brake/tyre/brake-efficiency/pressure values): freezing
  specific numbers without SBS/LTA confirmation would launder comparable-industry values
  (C-level) into requirements. Recommended: do not put numeric thresholds in the
  implementation contract; require them via the MINIMUM INFORMATION REQUIRED FROM SBS request
  below, or mark thresholds as technician-entered values (not validated against a fixed list).
- **B5/R2 fault-code + part-number catalogues**: freezing a specific SBS/OEM code list is
  impossible without SBS confirmation. Recommended: schema supports a code field with
  `REQUIRES SBS CONFIRMATION` and an empty/versioned catalogue; catalogue content is a
  confirm-and-fill item, not a freeze item.
- **B4/R4 return-to-service and completion-state vocabularies**: without SBS states, hard
  gates on these classes cannot enumerate the allowed states. Recommended: define states as
  an open, technician-confirmed enum in the provisional contract; fill allowed values from
  SBS.

---

## 4. What can and cannot enter the frozen implementation contract (contract §17)

**Can enter the implementation contract now (as frozen):** architecture, pipeline stages,
scope model + isolation invariant, ingestion contract, ZX-47 acceptance test, hard-gate
taxonomy + mechanism, eval harness + metrics, V1-integrity constraints, and all
evidence-confirmed schema fields/sections (as enumerated in 03/04/05/06 with their tags).

**Cannot enter the implementation contract until SBS confirms (provisional now):**
SBS-internal workflow states and intervals, fault-code/part-number catalogues, numeric
thresholds, completion/return-to-service vocabularies, per-scope critical-field lists,
report templates, upload-authorization policy. These are represented as **parameters to be
filled by SBS-confirmed data**, never as hardcoded SBS facts derived from comparable-industry
sources.

---

## 5. Key unresolved SBS information gaps (most important)

1. **Work-order / fault-code / part-number conventions** (Bus B1/B2/B5; Rail R2) — block a
   precise fact schema and reliability analytics.
2. **Maintenance intervals and completion/return-to-service vocabularies** (B3/B4, R1/R4) —
   block workflow and completion-state hard gates.
3. **Numeric inspection/maintenance thresholds** (B6, R3) — block measurement/test
   validation and are RED.
4. **Actual report templates** (B10, R12) — block report schema finalization.
5. **Regulatory submission formats** (NRFF plans/fault-trend analyses; RTA/BSIA section text;
   BCM schedules) — block compliance-block completeness (X1–X3, R7–R9).
6. **Upload authorization** (X6) — product/partnership question for user-upload scope.

## 6. Requirement | Evidence | Status | Remaining uncertainty | Recommended action (consolidated)

See §2 table above; rows are the authoritative per-requirement record for this phase.

---

## 7. MINIMUM INFORMATION REQUIRED FROM SBS

The smallest set of real SBS artifacts/answers that would materially resolve the remaining
uncertainty and move the YELLOW/RED items to GREEN. Item 1 alone would unlock most of the
fact-schema and workflow model.

1. **Sample work orders and defect logs** (bus + rail, de-identified): field names, states,
   fault codes, part numbers, completion/return-to-service statuses. → resolves B1–B5, R2–R4.
2. **Maintenance schedule excerpts** (bus: km/month preventive + statutory; rail: day/km/
   overhaul cycles). → resolves B3, R1.
3. **Inspection/test pass criteria** (brake efficiency %, kPa, tyre tread mm, wheel-wear mm,
   emissions). → resolves B6, R3 (RED).
4. **One current report template per type** (bus service/inspection/corrective; rail
   service/track/corrective) — de-identified. → resolves B10, R12.
5. **Fault-code/part-number catalogue** (or confirmation that codes are free-text +
   technician-entered). → resolves B2/B5, R2.
6. **Technician role/competency descriptions** (bus + rail; incl. NESS/HV scope for bus).
   → resolves B7.
7. **Scope-binding confirmation**: which knowledge is Bus vs Rail vs shared (e.g., is
   "fare revenue / package" shared?), and whether SBS authorizes user uploads of manuals/
   historical reports into the agent. → resolves X6 + isolation bindings.
8. **Regulatory submission references** (NRFF maintenance-plan/fault-trend format; BCM
   maintenance-standard schedules; RTA/BSIA inspection-relevant sections), or confirmation
   that the agent need not auto-fill them. → resolves X1–X3, R7–R9.

If SBS supplies items 1, 3, and 4, the implementation contract can be frozen with the fact
schema, workflow states, thresholds, and report schema in GREEN; items 2, 5–8 can remain
provisional parameters filled post-confirmation.

---

## 8. Completion statement

Per contract §17: all 11 deliverables exist (01–11 under `docs/v2-research/`); factual
claims are source-audited (`02_SBS_EVIDENCE_AUDIT.md`); uncertainty is explicit
(`10_SBS_INFORMATION_GAPS.md`); the evaluation draft is actionable (`07_V2_EVAL_SPEC_DRAFT.md`
incl. the mandatory ZX-47 test); and this report states clearly what can and cannot enter the
later frozen implementation contract. **The pre-freeze research package is complete and
submitted for freeze review.**

---

*End of 11_FREEZE_READINESS_REPORT.md*
