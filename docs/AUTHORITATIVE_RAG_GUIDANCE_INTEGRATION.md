# Authoritative RAG Guidance Integration Report

## Decision

The useful deterministic capabilities from `origin/feature/rag-guided-reporting` at `c2c2df2` are integrated by adaptation, not by merging the branch wholesale.

The authoritative boundary is now `ReportSession`:

- the server binds scope, template, context, uploads, retrieval query, permitted corpora, results, and provenance;
- deterministic extraction creates `FieldCandidate[]` with exact job-evidence references;
- retrieval creates `GuidanceContext[]`, which is structurally ineligible as evidence;
- technician field answers are persisted as manual evidence before becoming candidates;
- technician confirmation is a separate server-issued audit event;
- an authoritative report draft is derived from the persisted candidate chain and rejects a browser-supplied facts array.

The visible workspace was adapted only at its orchestration boundary. Its layout and information design were not redesigned.

## Sources audited

The integration was checked against:

- `docs/Final_merge_integration audit.rtf` (Prompt 1 audit);
- `docs/UNIFIED_REPORT_SESSION_CONTRACTS.md` (Prompt 2 contracts);
- `docs/AUTHORITATIVE_CAPTURE_BACKEND.md` (Prompt 3 evidence architecture);
- `docs/工业现场服务报告Agent_需求洞察与产品差异化分析.docx`;
- `docs/RAG_GUIDED_REPORTING_HANDOFF.md`;
- `c2c2df2` and the current `feat/unified-report-session` implementation.

The product analysis supports the chosen P0 boundary: report-aware capture, deterministic structure, explicit unknowns, evidence traceability, minimal technician interruption, and human confirmation. It does not justify diagnosis, prediction, generative report prose, OCR, embeddings, or semantic retrieval in this phase.

## Migrated capability map

| Capability | Source capability | Authoritative treatment | Main modules |
|---|---|---|---|
| Scope registry | Hierarchical context/scope registry | Kept as the server's scope authority | `src/v2/scope.js`, `data/knowledge/v2/scope-registry.v1.json` |
| Hard scope isolation | `allowed`/`forbidden` gates | Kept and applied to knowledge and uploads; session upload allow-list adds a second gate | `src/v2/retrieval.js`, `src/workflows/authoritative-capture.js` |
| Upload provenance | Scoped upload record and state machine | Adapted so upload ID/provenance include ReportSession binding and document version | `src/v2/upload.js` |
| Knowledge ingestion | text/docx/PDF text-layer parse, deterministic chunks/index | Kept; invoked through a ReportSession endpoint with server-derived scope and principal | `src/v2/upload.js`, `src/server.js` |
| Transcript review | bounded domain correction and confirmation rules | Kept; decisions remain server-bound, complete, immutable, and mapped back to raw spans | `src/v2/transcript-review.js`, `src/workflows/authoritative-capture.js` |
| Deterministic extraction | scoped rule extractor and vocabularies | Adapted to create persisted `FieldCandidate[]` rather than browser facts | `src/tools/extract-v2-facts.js`, `src/workflows/authoritative-capture.js` |
| Terminology/domain vocabularies | SBS, HVAC, oilfield, power-grid knowledge | Kept as deterministic normalization/extraction/retrieval input | `data/knowledge/**`, extraction/review modules |
| Negation | replacement/completion negation rules | Kept and extended by adversarial English coverage | `src/tools/extract-v2-facts.js` |
| Planned work | recommendation/future-action detection | Kept; never emitted as completed action | `src/tools/extract-v2-facts.js`, `src/v2/transcript-review.js` |
| Measurement/unit safeguards | scoped units and number/unit hard gates | Kept; specification-only quantities are now excluded from observed candidates | `src/tools/extract-v2-facts.js`, `src/v2/report-builder.js` |
| Completion/safety safeguards | completion enums, return-to-service and safety gates | Kept; confirmation remains a separate server event | `src/v2/report-builder.js`, domain/audit contracts |
| Scoped retrieval | deterministic lexical ranking | Adapted into automatic ReportSession processing with persisted provenance | `src/v2/retrieval.js`, `src/workflows/authoritative-capture.js` |
| Guided questions | deterministic missing-module questions | Adapted into `GuidanceContext.follow_up_questions`; answers re-enter as technician evidence | `src/v2/guided-reporting.js`, `src/v2/report-builder.js` |
| Browser orchestration | client extraction/retrieval/fact submission | Replaced for the visible workspace by ReportSession commands and projections | `web/template-app.js`, `src/server.js` |

## Retrieval architecture

```text
ReportSession(template + context + scope)
  ├─ optional guidance upload
  │    server derives scope/principal/session binding
  │    -> parse -> chunk -> lexical index -> immutable upload provenance
  └─ persisted transcript / reviewed transcript projection
       -> server chooses query
       -> allowed knowledge scopes from registry
       -> only this session's guidance_upload_ids
       -> deterministic lexical top K (fixed at 3 internally)
       -> immutable GuidanceContext
            ├─ permitted_corpora
            ├─ document/chunk/version provenance
            ├─ applicable_modules
            └─ follow_up_questions
```

Retrieval has two independent isolation layers:

1. registry isolation blocks another domain even if a caller knows its document or upload identifier;
2. `permittedUploadIds` blocks another ReportSession's upload even when both sessions share the same domain.

The browser can request the on-demand guidance projection. That projection intentionally omits retrieval score, chunk ID, and debug provenance. Full provenance remains in the immutable server chain.

The compatibility endpoint `POST /api/v2/retrieve` remains available for the inactive legacy/demo surface and manual diagnostics. Its output is not accepted as authoritative ReportSession input.

## Extraction architecture

```text
immutable Evidence
  -> immutable TranscriptArtifact
  -> optional TranscriptReview decision set
  -> deterministic extractor + template field adapter
  -> exact raw EvidenceSpan
  -> server-created FieldCandidate
  -> technician resolution/confirmation event when required
  -> server-derived report facts
```

Every server-created candidate includes:

- `field_id`;
- `claim` with candidate value and a separately exposed optional `unit`;
- immutable `evidence_refs`, including exact `span_id` when text offsets exist;
- `extraction.method` and `extraction.version`;
- `risk_class` (`STANDARD` or `CRITICAL`);
- `confidence_class`;
- `source_context` with domain, context ID/version, and scope;
- support type independent from field state and confidence.

Extraction never creates `TECHNICIAN_CONFIRMATION`. A technician can confirm an existing candidate only through a server command that produces a `TECHNICIAN_CONFIRMATION` audit event and a new confirmation candidate bound to the original candidate and evidence.

Manual form answers follow the same rule: the answer is first persisted as `MANUAL_INPUT` evidence with an exact span, then converted to a `MANUAL_TECHNICIAN_INPUT` candidate. Clearing a field produces `EXPLICIT_NONE`; it does not silently resurrect an older value.

## Guidance is not evidence

`GuidanceContext` requires:

- server session/context/scope binding;
- server-selected query;
- `LEXICAL_DETERMINISTIC` method and version;
- permitted corpora;
- retrieved document, chunk, version, score, text, and provenance;
- applicable modules and deterministic follow-up questions;
- `support_type: RAG_GUIDANCE`;
- `eligible_as_job_evidence: false`.

It deliberately has no `evidence_id`. `createFieldCandidate` rejects `RAG_GUIDANCE`; `createReportField` independently rejects guidance-prefixed evidence/source references even if a caller forges a candidate-shaped object. ReportSession capture endpoints reject client `knowledge_hits`, guidance IDs, facts, support state, and provenance. Authoritative report drafting also rejects a client `facts` member.

Therefore guidance cannot establish work performed, replacement, testing, pass/fail, acknowledgement, completion, return-to-service, safety state, or observed measurements.

## Keep / Adapt / Replace / Deferred

### Keep

- `src/v2/scope.js` registry resolution and hard isolation;
- `src/v2/upload.js` extraction, deterministic chunking, indexing, and failure boundaries;
- `src/v2/retrieval.js` lexical scoring and stable provenance;
- `src/v2/transcript-review.js` bounded review rules;
- deterministic vocabularies and fact schemas;
- negation, planned-work, completion, safety, unit, identity, and RAG hard gates;
- `src/v2/guided-reporting.js` deterministic question catalog.

### Adapt

- upload identity/provenance now binds the ReportSession;
- retrieval accepts a server-owned upload allow-list;
- retrieval is invoked from ReportSession processing, not submitted as browser hits;
- extracted facts are converted to immutable candidates and raw transcript spans;
- guidance output is a persisted domain contract rather than an array of cards;
- report planning supplies applicable modules and follow-up questions inside guidance;
- the visible browser is a projection/command client for authoritative capture, answers, confirmation, and draft creation.

### Replace

- browser-created `CONFIRMED_BY_TECHNICIAN` facts;
- browser submission of authoritative `facts` or `knowledge_hits`;
- client scope/uploader/report binding for ReportSession uploads;
- same-domain global upload visibility in authoritative retrieval;
- specification quantities being treated as observed job measurements;
- direct client promotion of guidance into report fields.

### Deferred

- embeddings or a vector database;
- semantic retrieval/reranking;
- OCR for image-only PDFs;
- generative report prose;
- automatic diagnosis;
- predictive maintenance;
- distributed/multi-process transaction coordination;
- production identity provider integration and signed technician principals;
- automatic migration/backfill of historic saved reports.

## Adversarial coverage

| # | Required case | Evidence |
|---|---|---|
| 1 | BUS cannot retrieve RAIL-only upload | `test/v2/retrieval.test.js` |
| 2 | RAIL cannot retrieve POWER-only knowledge | `test/v2/retrieval-regression.test.js` |
| 3 | forged scope rejected | `test/authoritative-capture-server.test.js` |
| 4 | cross-domain upload contamination blocked | teammate retrieval/report hard-gate tests |
| 5 | client `knowledge_hit` cannot become authoritative | authoritative capture HTTP rejection test |
| 6 | client cannot relabel guidance as technician evidence | domain forged-candidate test |
| 7 | forged `support_status` rejected | authoritative capture HTTP rejection test |
| 8 | GuidanceContext cannot serialize into ReportField evidence | domain forged-candidate test |
| 9 | “did not replace” is not performed replacement | deterministic extraction adversarial test |
| 10 | “recommend replacing” is not performed replacement | deterministic extraction adversarial test |
| 11 | “will replace” is not performed replacement | deterministic extraction adversarial test |
| 12 | “not returned to service” is not positive return-to-service | extraction and hard-gate tests |
| 13 | changed negation caught | teammate hard-gate tests |
| 14 | number mutation caught | server-owned candidate/draft boundary plus teammate number hard gates |
| 15 | unit mutation caught | server-owned candidate/draft boundary plus teammate unit hard gates |
| 16 | wrong asset identity caught | teammate identity hard-gate tests |
| 17 | specification is not observed measurement | deterministic extraction specification test |
| 18 | RAG recommendation is not completed action | teammate report-builder and server tests |
| 19 | candidate points to exact evidence | authoritative guidance workflow test |
| 20 | retrieval retains document/chunk/version provenance | guidance contract/workflow and teammate retrieval tests |
| 21 | technician answer remains distinct from RAG | authoritative field-answer/confirmation workflow test |

## Test results

Verified on 2026-09-27:

- `npm run check`: PASS — syntax checks and 377/377 repository tests passed.
- `node --test --test-concurrency=1 test/v2/*.test.js test/v2-server.test.js`: PASS — 171/171 teammate V2 regression tests passed.
- `node --test --test-concurrency=1 test/authoritative-capture-server.test.js test/authoritative-guidance-workflow.test.js`: PASS — 14/14 authoritative HTTP/workflow integration tests passed.
- `git diff --check`: PASS — no whitespace errors.

The authoritative integration tests exercise actual HTTP service boundaries, persisted restart behavior, server-owned upload scope, per-session upload isolation, automatic retrieval, exact candidate evidence spans, manual technician evidence, server-issued confirmations, rejection of forged authority fields, and server-derived report facts.

## Intentionally not migrated

The following code was not copied into the authoritative path:

- `web/app.js` retrieval-card and `knowledge_hits` orchestration. It is not loaded by the current product shell.
- The client-controlled extraction/build behavior behind `/api/v2/facts/extract` and `/api/v2/reports/build`. These remain compatibility/demo endpoints and do not mutate or finalize ReportSession state.
- The old browser-created fact/support receipts and local `factsFromStructuredState` authority path.
- `src/v2/report-builder.js` prose/section builders as a new automatic report-writing engine. Only deterministic planning and existing validation safeguards are reused.
- Generative draft modules as a source of job facts.
- Any embedding, vector store, OCR, semantic reranker, diagnosis, or prediction implementation.

## Unresolved gaps

1. File persistence is process-local for locking. Multi-process deployment requires transactional storage.
2. The demo principal is server-assigned but is not yet backed by production authentication/authorization.
3. Custom manager-created templates are not yet resolvable by `AuthoritativeCaptureService`; authoritative creation currently accepts the published predefined catalog.
4. ReportSession currently models one primary capture chain. Adding multiple independent transcript captures to one in-progress session needs an explicit lifecycle extension rather than an illegal phase rewind.
5. Final `ReportSnapshot` creation and `RESOLVE -> REVIEW -> READY -> CONFIRMED` cutover remain separate work. Existing confirmation/export tooling consumes the server-derived draft, but it has not yet been replaced by a ReportSnapshot-native finalization service.
6. Historic reports and old client facts are not backfilled into the new evidence/candidate contracts.

These gaps do not weaken the RAG boundary: no guidance-only claim can enter the authoritative candidate or report-fact chain.
