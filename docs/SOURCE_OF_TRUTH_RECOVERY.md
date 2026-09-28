# ServiceScribe source-of-truth recovery

Date: 2026-09-27
Implementation base: `57d0cb01c82ec804ed6caa8a9ba949f658a2b8ff`

This audit was completed before implementation changes. It records observed repository evidence rather than treating a design document or test name as proof of runtime behavior.

## Selected authority

| Concern | Authoritative source | Decision |
| --- | --- | --- |
| Report lifecycle, evidence, revision, validation, resolution, confirmation | `feat/unified-report-session` at `57d0cb0`, especially `src/domain/`, `src/agent/`, `src/storage/report-sessions.js`, and `src/workflows/authoritative-capture.js` | Use as the integration base. It is the only lineage with one server-owned ReportSession through immutable snapshot creation. |
| Original reporting retrieval and domain safeguards | `origin/feature/rag-guided-reporting` at `c2c2df2` | Preserve its scope registry, upload provenance, lexical retrieval, deterministic domain extraction, negation/planned-work handling, and safety gates through the ReportSession adapters already present in the selected base. Do not restore browser-owned facts or `knowledge_hits`. |
| Capture/runtime foundation | `b60cf11` and descendants, with the earlier audio orchestration intent visible at `223b7af` | Keep content-addressed audio-before-ASR, immutable transcript artifacts, source-bound idempotency, retry, and session binding from the current authoritative capture service. |
| Evaluation materials | `evaluation/synthetic-cases.v1.json`, `evaluation/component-fixtures.v1.json`, `evaluation/batch3-fixtures.v1.json`, `test/fixtures/sbs-extraction-eval.v1.json`, and the blind handoff under the project-level `docs/qiongwen-ground-truth-blind-package-2026-09-26/` | Reuse only as labelled synthetic/regression evidence. The blind annotations are unreviewed and `frozen_gold:false`; they are not Gold. Freeze a separate deterministic pipeline-comparison set with explicit provenance. |
| Product requirements | project-level `docs/工业现场服务报告Agent_需求洞察与产品差异化分析.docx` | Treat its P0 capabilities and four differentiators as the product acceptance source. |
| Report schemas | `web/template-catalog.js`, `docs/SBS_transit_template_pack/report_schemas.json`, and the expanded template source pack | Preserve explicit versioned schema/template/context bindings. Required fields remain server-owned; optional fields do not block. |
| Source report templates | project-level `docs/SBS_Transit_Expanded_Template_Research_Pack/01_predefined_templates/*.docx` plus the two committed prototype DOCX files | The seven catalog SHA-256 values exactly match the seven expanded DOCX sources. The selected branch omitted those seven binaries, so the hash declarations were truthful but the artifacts were not self-contained. PDF bindings must retain the exact source filename/hash and a deterministic layout mapping. |
| Regression infrastructure | current Node test suite and real `whisper.cpp` smoke path | Baseline: 455/455 tests passed. `npm run stt:smoke` passed with checksum-verified `whisper.cpp` b4938/Base in 599 ms on the audit machine. This is runtime integration evidence, not field-ASR accuracy. |

## Provenance and ancestry

- `origin/feature/rag-guided-reporting@c2c2df2` is an ancestor of the selected base (`0` commits only on the source side, `36` only on the selected side).
- `feat/template-catalog-runtime@5badb66` / `origin/main@5badb66` is an ancestor of the selected base (`0/9`).
- `origin/zqw-ground-truth@89ffe70` diverges one commit after common ancestor `79c2003`; its only unique evaluation capability is a validator for externally completed frozen annotations. No reviewed annotations exist in the supplied package.
- The current lineage adds ReportSession contracts (`5c2335f`), authoritative capture (`b60cf11`), scoped guidance (`c0c20ab`), deterministic agent core (`ce00361`), technician workspace (`474e997`), final confirmation/snapshot (`a5cdd5d`), recording isolation (`6a05dcf`), and real-user recovery hardening (`57d0cb0`).

## Verified gaps in the selected base

1. `ReportSessionStore.writeOfficialExport` writes `<snapshot>.txt`; `AuthoritativeCaptureService.exportConfirmedSession` renders `reportToText`; the browser downloads `.txt`. The final report is not PDF.
2. `docs/FINAL_UNIFIED_REPORT_AGENT_P0.md` labels existing-format export PASS, but the runtime export is a text projection and does not preserve the DOCX layouts.
3. The seven catalog `sourceArtifact.filename`/SHA-256 values match the project-level expanded DOCX pack, but those files are absent from the selected branch. Runtime code cannot open them.
4. The current resolution UI can expose implementation-shaped entry text such as `Enter ${item.field_id}` and swaps the report-level composer for per-item forms. This conflicts with the product requirement for one stable capture/clarification loop.
5. Existing component evaluation is intentionally isolated and provisional: 38 RUN, 16 NOT_RUN, 6 NOT_SUPPORTED, 0 ERROR. Existing Batch 3 retrieval/report checks do not evaluate the end-to-end evidence-to-report pipeline.
6. Existing SBS extraction evaluation passes its seven deterministic cases, but reports `latency.not_measured:true` and does not compare alternative correction strategies.
7. `docs/AUTHORITATIVE_RAG_GUIDANCE_INTEGRATION.md` references `docs/Final_merge_integration audit.rtf`, which is not present in any checked ref.

## Invariants retained

- Raw audio and transcripts remain immutable and content-bound.
- Job Evidence remains structurally distinct from GuidanceContext.
- Retrieval is scope-isolated and cannot establish work, measurements, tests, completion, or safety facts.
- FieldCandidate provenance points to exact evidence spans where text exists.
- Conflicting reliable values remain explicit conflicts.
- Required/conditional completeness, safety confirmation, review, and final confirmation remain server-owned.
- Stale revisions and stale validation cannot confirm a report.
- A confirmed snapshot is immutable and export failure does not invalidate it.

## Integration strategy

Use the selected base and adapt it in place; do not merge a historical feature branch wholesale. Add a frozen evidence-pipeline comparison before selecting a correction strategy, replace the visible per-field entry surface with a stable report composer while retaining structured answer controls, and add a versioned PDF renderer whose data source is the immutable confirmed snapshot.
