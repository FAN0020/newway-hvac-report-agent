# 07 — V2 Evaluation Spec Draft

Status: DRAFT FOR PRE-FREEZE RESEARCH (not frozen)
Governing contract: `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` §11 (Phase D — Evaluation Design)
and §13 (mandatory user-upload acceptance test).
Design intent: an **actionable** evaluation draft that can be operationalized before the
implementation-contract freeze. Where real SBS data is unavailable, cases are synthetic and
explicitly labelled (contract §11). Evidence levels A/B/C/D apply to claims about the domain;
eval case labels are **REAL** / **SYNTHETIC** / **SYNTHETIC-BASED-ON-EVIDENCE**.

---

## 0. Evaluation principles

1. Safety-critical errors must never be hidden by average accuracy (contract §12): metrics
   are reported separately for hard-failure classes, with explicit hard gates.
2. Scoped knowledge and scoped uploads are part of every eval (contract §3, §8, §10).
3. Knowledge must never create service facts (contract §3, §13): each eval checks the
   "manual-recommendation ≠ observed action" invariant.
4. All synthetic cases carry a label and a note that they are synthetic; no synthetic case
   is presented as SBS ground truth.
5. Cases cover three contexts: HVAC (compatibility), SBS/Bus, SBS/Rail — and cross-scope
   leakage scenarios.

---

## 1. Retrieval Eval (contract §11 Retrieval Eval)

| Metric/check | Definition | Case label | Notes |
| --- | --- | --- | --- |
| Relevance@K | retrieved chunk relevant to query | SYNTHETIC | gold judgments per scope |
| Recall@K / Precision@K | against gold relevant set | SYNTHETIC | where a gold set is meaningful |
| Metadata/scope filtering | only scopes inherited by current context retrieved | SYNTHETIC | contract §8 |
| Cross-domain isolation | SBS/Bus query must not retrieve HVAC or SBS/Rail knowledge | SYNTHETIC (hard gate) | invariant test |
| User-upload retrieval | uploaded doc retrievable after READY | SYNTHETIC (ZX-47 case) | contract §10, §13 |
| Upload scope binding | upload in scope X not retrieved in scope Y | SYNTHETIC (hard gate) | contamination test |

**Corpus for retrieval tests (SYNTHETIC-BASED-ON-EVIDENCE):** representative SBS bus
vocabulary (model names, routes, depots — A/B), SBS rail vocabulary (stock classes, lines,
MKBF — A/B), HVAC V1 vocabulary (baseline), plus synthetic manuals (e.g., ZX-47 Auxiliary
Door Control Module).

## 2. Transcript Correction Eval (contract §11)

| Check | Definition | Example (SYNTHETIC) |
| --- | --- | --- |
| Technical terms | correct domain terminology | "A95" vs "A59"; "Citaro" vs "Citero"; "Movia C951" vs "C915" |
| Identifiers/model/part/fault codes | correct VRN, train set, part number, fault code | "SG3050Z"; "C751C"; "ZX-47" |
| Numbers and units | preserve/convert numbers + units | "1,500 V DC" vs "15 V"; "750 V third rail" |
| Negation | preserve negation | "did not replace" stays negative |
| Maintenance actions | correct action verbs | "replaced" vs "inspected" |
| Completion state | correct state | "completed" vs "deferred" vs "off-road" |
| Preservation of original factual meaning | correction must not change meaning | post-check against raw transcript |

**Rule:** correction candidates come only from the server-side versioned vocabulary
(scope-scoped), never from free-form browser input (V1 invariant). ZX-47 case (§6) verifies
that the term is unknown before upload and correctable after upload.

## 3. Fact Extraction Eval (contract §11)

| Check | Definition | Hard-gate? |
| --- | --- | --- |
| Field accuracy/coverage | correct fields populated | no |
| Missing facts | required facts absent | no (coverage metric) |
| Invented facts | fact not in transcript | YES |
| Incorrect normalization/status/identity | wrong unit conversion, wrong status, wrong asset | YES |
| Separation of transcript-observed vs knowledge context | RAG-suggested claim never emitted as observed fact | YES (contract §3) |

## 4. Report Eval (contract §11)

| Check | Definition | Hard-gate? |
| --- | --- | --- |
| Factual grounding | every claim traces to facts receipt | YES |
| Required-field coverage | per-scope required sections present | no |
| Unsupported claims | claim without fact support | YES |
| Structure | correct section order/templates per scope | no |
| Consistency with structured facts | report vs facts receipt diff | YES |
| Provenance/traceability | hashes, upload refs, knowledge versions present | no |

## 5. End-to-End Eval (contract §11; scenario per §3)

Scenario template: `context` + `scoped knowledge` + optional `user upload` + `noisy
transcript` → correction → facts → report → validation → technician confirmation.

| E2E scenario | Context | Upload | Transcript focus | Key assertion |
| --- | --- | --- | --- | --- |
| E2E-HVAC-1 (REAL baseline) | HVAC | none | V1-style call | preserves V1 behavior |
| E2E-BUS-1 (SYNTHETIC-BASED-ON-EVIDENCE) | SBS/Bus | optional bus manual | bus work order w/ VRN, model, brake test | correct asset/unit/test facts; no manual-invented action |
| E2E-RAIL-1 (SYNTHETIC-BASED-ON-EVIDENCE) | SBS/Rail | optional OEM manual | NEL train set + condition alert | correct stock class/train set; MKBF context only as context |
| E2E-ISO-1 (SYNTHETIC, hard gate) | SBS/Bus | none | transcript mentions HVAC part | no HVAC retrieval; hard error if leakage |
| E2E-UPLOAD-1 = ZX-47 (§6) | SBS/Bus | ZX-47 manual | "ZX forty seven has intermittent failure" | full pipeline + no invented replacement |

## 6. Mandatory user-upload acceptance test — ZX-47 (contract §13)

**Synthetic case** (explicitly labelled; no claim that ZX-47 exists at SBS).

- **Term:** `ZX-47` = Auxiliary Door Control Module (door control unit for a bus door system).
- **Before upload:** retrieval/correction for "ZX-47" returns nothing (knowledge lacks it);
  system must not hallucinate a definition.
- **Upload:** PDF/DOCX/TXT describing ZX-47 (function, recommended replacement procedure) →
  Upload → Processing → Parsed/Chunked/Indexed → **READY** (contract §10 states).
- **After upload:** scoped retrieval returns ZX-47 chunks; transcript "ZX forty seven has
  intermittent failure" corrects to "ZX-47" with the uploaded manual as provenance.
- **Invariant:** the manual recommends replacement, but the technician did not say
  replacement occurred ⇒ facts/report must NOT contain "ZX-47 replaced" (contract §3, §13).
- **Coverage asserted by this test:** ingestion, retrieval, scope isolation (ZX-47 manual is
  bound to SBS/Bus; HVAC and SBS/Rail must not see it), correction, fact grounding, report
  grounding, validation, technician confirmation.

## 7. Metrics and reporting

- Report per-class results: hard-gate pass/fail counts separately from average accuracy.
- Include confusion-style tables for: negation, numbers/units, identity, actions,
  completion, tests, safety/return-to-service, leakage, RAG-unsupported facts, upload
  contamination (see `08_V2_CRITICAL_ERROR_TAXONOMY.md` for classes).
- Every synthetic case is labeled `SYNTHETIC` in results; no synthetic case is used to claim
  SBS ground truth.

---

*End of 07_V2_EVAL_SPEC_DRAFT.md*
