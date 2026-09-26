# Authoritative Report Agent Core

> Historical Prompt 5 delivery record. The final P0 authority, endpoint, confirmation, snapshot, and export contracts are documented in `docs/FINAL_UNIFIED_REPORT_AGENT_P0.md`; where this record describes an intermediate state, the final document is authoritative.

## Scope and authority

This phase implements the deterministic server-owned reporting loop on `feat/unified-report-session`:

`FieldCandidate[] → MergeEngine → ConflictEngine → ReportField[] → ValidationEngine → Active Completeness → ResolutionPlanner → ResolutionQueue → Technician Answer → re-merge → re-validate`

The browser is not an authority for field state, support type, provenance, validation status, retrieval output, or technician-confirmation support. No technician UI was changed in this phase.

## 1. Architecture changes

- Added a server-side Agent package under `src/agent/` with independent merge, conflict, validation, completeness, and resolution-planning stages.
- Added immutable `AgentRun` records. `ReportSession` retains every run ID plus a pointer to the current run, so the exact current issues and queue survive process restart.
- Added authoritative job-context ingestion. A configured server provider creates `SYSTEM_RECORD` evidence, exact evidence spans, and `AUTHORITATIVE_SYSTEM_DATA` candidates.
- Added resolution-answer persistence with request-bound idempotency records, optimistic revision checks, immutable manual-input evidence, and a server-issued technician-confirmation event.
- Report building now consumes only facts projected from the current authoritative Agent state. Blocking fields are absent from official sections even though their candidates remain visible in exception state.

## 2. MergeEngine design

`MergeEngine` evaluates every concrete field in the exact bound template version and any permitted repeating-field candidates. It never uses last-write-wins.

- All candidates and evidence references remain attached to the resulting `ReportField`.
- Explicit technician resolution supersedes named candidates; ordering alone never supersedes evidence.
- Deterministic schema/rule violations produce `INVALID`.
- A single reliable claim produces `KNOWN_VALUE`, `EXPLICIT_NONE`, or `NOT_APPLICABLE` according to its semantic claim.
- Uncertain direct evidence remains `UNCERTAIN`; AI-only support remains `INFERRED`.
- Absence remains `UNKNOWN`.

## 3. ConflictEngine design

Reliable active candidates are grouped by canonical claim. More than one distinct reliable claim produces `CONFLICT`, retaining every candidate ID and provenance chain. Source priority may influence later policy, but cannot erase a contradictory reliable claim. A conflict is cleared only by a technician-confirmation candidate whose resolution metadata explicitly names the candidates it resolves.

## 4. ValidationEngine design

The single Agent validation pass covers:

- exact template/version binding;
- required and conditional fields;
- type, allowed-value, unit, and explicit range checks;
- critical-field human confirmation;
- evidence eligibility and the RAG/job-evidence boundary;
- identity sanity;
- negated and planned actions;
- completion and negative return-to-service safeguards.

Every `ValidationIssue` contains a stable issue ID, issue type, field, severity, blocking flag, reason, candidate IDs, evidence references, and possible resolution type. Active Completeness separately reports complete, required-missing, optional-missing, uncertain, conflicting, invalid, inferred, conditionally-required, and critical-confirmation fields.

## 5. ResolutionPlanner design

Issues are grouped by field so duplicate questions are not created and one answer can resolve multiple current issues. Queue priority is deterministic:

1. safety;
2. conflict;
3. required missing;
4. required uncertain/inferred;
5. deterministic rule violation;
6. optional clarification.

Each item includes all issue and candidate IDs, a reason, a targeted prompt, and an answer contract. Allowed values and conflicts use structured choices. Root cause supports confirmed, suspected, not established, and further-investigation-required semantics. Free text remains available only when a structured choice is insufficient.

## 6. FieldState and SupportType behavior

`FieldState` describes the semantic condition of a report field. `SupportType` describes why a candidate exists. They are independent.

| FieldState | Meaning | Typical support |
| --- | --- | --- |
| `KNOWN_VALUE` | A valid, non-conflicting supported value | system, transcript, manual input, or technician confirmation |
| `EXPLICIT_NONE` | The technician/evidence explicitly says none | transcript/manual/confirmation |
| `NOT_APPLICABLE` | The field does not apply | manual/confirmation |
| `UNKNOWN` | No eligible statement exists | none |
| `UNCERTAIN` | Direct evidence exists but is uncertain | transcript/manual |
| `CONFLICT` | Reliable active sources disagree | multiple support types |
| `INVALID` | A claim violates deterministic schema or trust rules | any otherwise eligible source |
| `INFERRED` | AI-derived and not directly established | `AI_INFERENCE` only |

RAG is never a `FieldCandidate` support source. It remains `GuidanceContext`, can create a follow-up requirement, and cannot satisfy that requirement.

## 7. Endpoint changes

- `GET /api/report-sessions/:sessionId/agent-state` returns the persisted authoritative Agent state.
- `POST /api/report-sessions/:sessionId/resolution-items/:resolutionId/answer` accepts a structured answer, expected revision, and idempotency key. The server creates evidence and confirmation support.
- `POST /api/template-reports/build` now projects official facts from the current Agent state and includes Agent validation issues in gates. A blocking candidate is never rendered as a supported report value.

Existing capture, transcript-review, field-answer, confirmation, guidance, and session endpoints continue to work. Authority-field rejection now checks nested request objects as well as top-level properties.

## 8. Deterministic test matrix

The focused Agent and authoritative integration suite contains 227 passing tests after this phase. The following acceptance cases are explicitly covered by the new Agent tests or retained deterministic regression tests:

| # | Acceptance case | Coverage |
| --- | --- | --- |
| 1 | required missing → ResolutionItem | Agent core |
| 2 | optional missing does not block | Agent core |
| 3 | explicit no parts → `EXPLICIT_NONE` | Agent workflow |
| 4 | `UNKNOWN` differs from `EXPLICIT_NONE` | Agent core/contracts |
| 5 | N/A differs from `EXPLICIT_NONE` | Agent core/contracts |
| 6 | uncertain measurement → confirmation | Agent state/required-uncertain planning |
| 7 | two reliable asset IDs → `CONFLICT` | Agent workflow |
| 8 | conflict retains both provenance chains | Agent workflow |
| 9 | technician resolution resolves conflict | Agent workflow |
| 10 | invalid unit → `INVALID` | Agent core |
| 11 | explicit invalid range → `INVALID` | Agent core |
| 12 | rectification requires post-work test | Agent core |
| 13 | no rectification avoids irrelevant test | Agent core |
| 14 | safety outranks ordinary missing | Agent core |
| 15 | one answer resolves multiple issues | Agent workflow |
| 16 | resolved question does not reappear | Agent workflow |
| 17 | absent root cause remains `UNKNOWN` | Agent core |
| 18 | root cause “not established” is preserved | Agent core/workflow |
| 19 | suspected root cause is not confirmed | Agent core |
| 20 | RAG recommendation cannot satisfy work performed | Agent core/RAG regressions |
| 21 | RAG can trigger a follow-up | Agent core |
| 22 | negated action remains negated | V2 extraction regression |
| 23 | planned action remains planned and blocked | Agent core/server regression |
| 24 | blocked candidate never renders officially | Agent server integration |
| 25 | restart preserves issues and queue | Agent workflow |
| 26 | stale concurrent answer is rejected | Agent workflow |
| 27 | duplicate answer retry is idempotent | Agent workflow |
| 28 | server creates confirmation support | Agent workflow/server integration |

## 9. Regression results

Baseline before modification:

- Full repository check: 377/377 passed.
- Focused authoritative session/RAG/V2 suite: 214/214 passed.

Post-change verification:

- Focused Agent plus authoritative session/RAG/V2 suite: 227/227 passed.
- Full repository check: 390/390 passed, including syntax checks for every new Agent/domain module.

## 10. Product-requirement compliance

Assessment against `工业现场服务报告Agent_需求洞察与产品差异化分析`:

| Requirement | Status | Evidence or remaining owner |
| --- | --- | --- |
| P0 — existing template ingestion | PARTIAL | Exact published template/version binding and existing source-artifact metadata are implemented. Arbitrary uploaded company templates are not yet compiled into the authoritative ReportSession policy; Prompt 6 owns that integration. |
| P0 — voice/text → structured fields | IMPLEMENTED | Audio/text becomes immutable evidence, exact spans, and server-owned `FieldCandidate[]`. |
| P0 — missing-field detection | IMPLEMENTED | Active Completeness distinguishes required, optional, conditional, uncertain, conflict, invalid, inferred, and safety-confirmation gaps. |
| P0 — Agent follow-up questions | IMPLEMENTED | Deterministic, prioritized, deduplicated `ResolutionQueue[]` is produced server-side. |
| P0 — human confirmation | IMPLEMENTED | Answers become manual evidence plus server-issued `TECHNICIAN_CONFIRMATION`; stale and duplicate writes are controlled. |
| P0 — field provenance/evidence | IMPLEMENTED | Accepted, conflicting, invalid, and superseded candidates retain evidence IDs and exact spans where available. |
| P0 — generate existing company format | PARTIAL | The authoritative builder preserves the selected renderer/template binding and blocks unsafe values. Pixel/layout fidelity and custom-template export are Prompt 6 responsibilities. |
| Differentiator 1 — Report-aware Capture | IMPLEMENTED | Capture is bound to an exact template/context before extraction, and extraction emits only permitted fields. Technician UI refinement remains intentionally deferred. |
| Differentiator 2 — Active Completeness | IMPLEMENTED | Server-owned completeness and targeted resolution planning eliminate manual form searching at the contract level. |
| Differentiator 3 — Evidence-grounded / Traceable | IMPLEMENTED | Every official fact is projected from eligible candidates with provenance; GuidanceContext and blocked facts cannot enter official sections. |
| Differentiator 4 — Existing-workflow Compatibility | PARTIAL | Existing predefined templates and renderer mappings remain compatible. Arbitrary company-template compilation and final-format fidelity are owned by Prompt 6. |

Backend acceptance is therefore satisfied for this phase, but the complete product requirement is not claimed as fulfilled.

## 11. Remaining gaps for Prompt 6

- Integrate published custom template drafts into the same policy compiler used by authoritative ReportSession creation.
- Implement the minimal technician resolution UI over the new queue without exposing retrieval scores, chunk IDs, or debug metadata by default.
- Complete exact existing-company-format rendering/export validation.
- Add product-level browser and artifact journeys for queue progression, restart, and final export.
- Decide operational identity/authentication for the technician principal; this phase retains the existing demo principal boundary.
- Add a durable multi-process lock/transaction strategy if the file-backed prototype is deployed with more than one server process.

## 12. Exact files changed

- `src/agent/conflict-engine.js`
- `src/agent/index.js`
- `src/agent/merge-engine.js`
- `src/agent/report-agent.js`
- `src/agent/resolution-planner.js`
- `src/agent/template-policy.js`
- `src/agent/validation-engine.js`
- `src/agent/validation-rules.js`
- `package.json`
- `src/domain/agent-contracts.js`
- `src/domain/audit-contracts.js`
- `src/domain/evidence-contracts.js`
- `src/domain/field-contracts.js`
- `src/domain/index.js`
- `src/domain/report-session.js`
- `src/domain/serialization.js`
- `src/server.js`
- `src/storage/report-sessions.js`
- `src/workflows/authoritative-capture.js`
- `test/authoritative-agent-core.test.js`
- `test/authoritative-agent-workflow.test.js`
- `test/authoritative-capture-server.test.js`
- `docs/AUTHORITATIVE_REPORT_AGENT_CORE.md`

No `web/` technician UI file was modified.
