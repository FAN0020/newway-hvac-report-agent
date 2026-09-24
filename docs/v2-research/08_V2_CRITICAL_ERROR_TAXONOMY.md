# 08 — V2 Critical-Error Taxonomy

Status: DRAFT FOR PRE-FREEZE RESEARCH (not frozen)
Governing contract: `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` §12 (critical-error taxonomy) and
§13 (hard gates in the ZX-47 acceptance test).

This document defines the hard-failure candidates that V2 evaluation and validation must
treat as **critical errors**, per contract §12. **Safety-critical errors must not be hidden
by average accuracy: V2 must implement explicit hard gates** — an error in any hard-failure
class fails the run (or the affected fact/report is quarantined for technician
confirmation), regardless of overall accuracy.

Each class is tagged with evidence basis (A/B/C/D per contract §6) and a concrete Bus/Rail/
HVAC example. C/D classes are design requirements, not SBS facts.

---

## 1. Hard-failure classes (contract §12 enumerated list, expanded)

| # | Class | Definition | Example (scope) | Evidence basis | Hard gate |
| --- | --- | --- | --- | --- | --- |
| 1 | **Changed negation** | A negative statement became positive (or vice-versa) | "did NOT replace the brake pads" → "replaced brake pads" (Bus) | §12; transcript invariant (A, V1) | YES |
| 2 | **Changed numerical value / unit** | Numeric value or unit altered | "3 bar" → "30 bar"; "1,500 V DC" → "15 V DC" (Rail); "kWh" → "kW" | §12; units dictionary (A/B) | YES |
| 3 | **Wrong asset/model/component/part number/fault code** | Identity of asset, model, component, part or fault code is wrong | "C751A" → "C751C"; "SG3050Z" → "SG3010Z"; "ZX-47" → "ZX-74" | §12; asset ontology (B/C) | YES |
| 4 | **Invented maintenance action / replacement** | Report states an action/replacement that never occurred (e.g., from a manual) | Uploaded manual recommends replacement; report states "ZX-47 replaced" although technician never said it | §3, §12, §13 | YES |
| 5 | **Incorrect completion state** | Completion/status misstated | "completed" → "deferred"; "returned to service" → "off-road" | §12; completion states (PROVISIONAL) | YES |
| 6 | **Invented test / test result** | A test or its result is fabricated | "brake test passed" when no brake test was performed | §12 | YES |
| 7 | **Incorrect safety / return-to-service status** | Safety or return-to-service assertion is wrong | "train cleared for passenger service" without technician confirmation | §12; OPS/RTSA context (A/B) | YES |
| 8 | **Cross-domain knowledge leakage** | Knowledge from another scope was used | SBS/Bus retrieval returned HVAC or SBS/Rail knowledge | §8, §12 | YES |
| 9 | **Unsupported maintenance fact from RAG** | RAG content presented as an observed service fact | Manual/SOP statement emitted as a transcript-observed fact | §3, §12 | YES |
| 10 | **User-upload contamination across scopes** | Upload from scope X used in scope Y | SBS/Bus upload retrieved in SBS/Rail context | §10, §12 | YES |

## 2. Additional hard-failure candidates (design-level; D — recommended for V2)

| # | Class | Definition | Rationale |
| --- | --- | --- | --- |
| 11 | **Invented part number / fabricated source** | Part number or citation that does not exist in knowledge | preserves V1 integrity + anti-fabrication (contract §16) |
| 12 | **Wrong report type / section mapping** | Report generated with wrong scope template | report grounding invariant (contract §11) |
| 13 | **Receipt/hash mismatch** | Facts receipt inconsistent with transcript/correction hashes | V1 integrity baseline |
| 14 | **Missing safety-critical field** | Required safety field absent in report | hard coverage gate for safety fields |

## 3. Gate design (recommendation, not implementation)

- **Pipeline gates:** Correction stage, fact-extraction stage, report stage, and final
  validator each apply their own hard-gate checks.
- **Quarantine model:** any fact or report section hitting a hard-failure class is
  quarantined and must be resolved by **technician confirmation** before it can be finalized;
  it is never silently passed.
- **Metric reporting:** hard-gate results are reported as pass/fail per class, separately
  from average accuracy (contract §12). A single hard-failure in safety classes (1, 2, 4, 5,
  6, 7, 8, 9, 10) fails the affected run.
- **Cross-scope checks:** retrieval and fact grounding both verify scope inheritance
  (contract §8); any violation is class 8 or 10.

## 4. Interaction with evaluation (§07) and knowledge scope (§09)

- §07 maps these classes to eval checks (correction, fact extraction, report, E2E).
- §09 defines the scope model that classes 8/10 depend on (isolation invariant).
- The ZX-47 acceptance test (§13, §07 §6) exercises classes 4, 8, 9, 10 end-to-end.

---

*End of 08_V2_CRITICAL_ERROR_TAXONOMY.md*
