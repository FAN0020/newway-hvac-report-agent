# PRE-FREEZE RESEARCH CONTRACT — SBS V2
Status: FROZEN
Owner: Product
Purpose: Govern all research and design work required before the implementation contract is frozen.

## 1. Objective
Prepare an evidence-grounded V2 specification for the existing maintenance report agent, extending the current HVAC system to SBS Transit use cases while preserving existing safety/integrity invariants.

Target scenario taxonomy for research:
- HVAC (existing; preserve compatibility)
- SBS Transit
  - Bus
  - Rail

Bus/Rail subdivision is provisional as a domain taxonomy and may be refined only when evidence justifies it.

## 2. Existing system baseline
Treat the repository's current implementation and README as the baseline. The existing pipeline includes:
Audio/microphone -> Whisper STT -> immutable raw transcript -> domain-assisted correction -> human confirmation/correction receipt -> structured fact extraction/facts receipt -> report planning/generation -> independent validation -> technician confirmation -> save/export.

Existing integrity controls (immutable raw transcript, receipts, hashes/version binding, validator, critical-value review, human confirmation and provenance checks) are inherited constraints. Research may recommend additions, but must not silently remove or weaken them.

## 3. Core V2 product hypothesis
V2 should support:
1. user selects maintenance context;
2. system activates only knowledge permitted for that context;
3. user may upload additional documents into that context;
4. uploaded documents are processed into retrievable knowledge;
5. speech is transcribed;
6. scoped knowledge may assist transcript correction;
7. corrected transcript is converted to structured maintenance facts;
8. scoped knowledge may assist interpretation;
9. a context-appropriate report is generated;
10. output is independently validated;
11. technician confirms the final output.

Critical semantic invariant:
KNOWLEDGE/RAG IS CONTEXT OR EVIDENCE FOR INTERPRETATION; IT IS NOT EVIDENCE THAT A SERVICE ACTION OCCURRED.
A manual recommendation must never be transformed into an observed repair/action/result unless supported by the service transcript or explicit technician input.

## 4. Frozen pre-freeze work phases
Complete all phases in order:
A. SBS Domain Discovery
B. Evidence Audit
C. Provisional Domain Models and Schemas
D. Evaluation Design
E. Freeze-Readiness Review

This contract authorizes research/design only. Do not implement or modify production code.

## 5. Phase A — SBS Domain Discovery
Research Bus and Rail separately. Prioritize sources:
1. SBS Transit primary/public documents
2. Singapore government/LTA sources
3. Singapore public-transport technical sources
4. public tender/procurement documents
5. relevant manufacturer technical documentation
6. academic/industry sources
7. comparable maintenance systems only where direct evidence is unavailable

Investigate, where evidence permits:
- maintenance workflows and maintenance types
- inspection/fault/work-order/service records
- technician responsibilities
- major assets/subsystems/components
- terminology, fault codes and identifiers
- measurements and units
- diagnosis and maintenance actions
- parts replacement
- testing and test results
- completion/escalation/return-to-service states
- safety-critical information
- SOP/manual usage
- maintenance reporting requirements and candidate report structure
- information available before work vs generated during work

Do not invent internal SBS practices.

## 6. Phase B — Evidence Audit
Classify every substantive domain claim:
A = SBS-specific evidence
B = Singapore transport-sector evidence
C = comparable-industry evidence
D = inference/assumption

For important claims record:
- claim
- Bus/Rail
- evidence level
- source title
- source URL
- source passage/page/location where available
- confidence
- limitations

If not publicly verified, state: NOT PUBLICLY VERIFIED.
C/D evidence must never be rewritten as an SBS fact. Primary evidence overrides generic practice.

## 7. Phase C — Provisional Domain Model
Produce separate Bus and Rail:
- maintenance workflow
- maintenance fact schema
- candidate report schema
- critical/safety fields
- terminology/structured-knowledge candidates

Every workflow step and schema field must be tagged:
- CONFIRMED BY EVIDENCE
- PROVISIONAL
- REQUIRES SBS CONFIRMATION

Do not clone the Bus schema into Rail without evidence.

## 8. Knowledge-scope hypothesis to evaluate
Evaluate, rather than blindly assume, this hierarchy:
GLOBAL -> ORGANIZATION -> DOMAIN/SUBDOMAIN -> USER-UPLOADED KNOWLEDGE.

Candidate example:
GLOBAL
- SBS
  - BUS
    - user uploads
  - RAIL
    - user uploads
- HVAC

Core isolation requirement to test:
Selecting SBS/Bus may retrieve only scopes explicitly inherited by SBS/Bus; it must not retrieve HVAC or SBS/Rail knowledge. User-uploaded knowledge must remain bound to its authorized scope unless explicitly reclassified.

Recommend further Bus/Rail subdivisions only when domain evidence materially justifies them.

## 9. Structured knowledge vs RAG
Do not assume all knowledge belongs in embeddings.
Assess likely structured storage for items such as terminology, part numbers, asset IDs, fault codes, allowed units, schemas and hard validation rules.
Assess RAG suitability for manuals, SOPs, maintenance guides, historical documents and supported user uploads.

## 10. User-upload hypothesis and boundaries
Research/design a first-version ingestion contract for text-bearing documents. Candidate supported types: PDF, DOCX, TXT, CSV.
The intended user experience is Upload -> Processing -> Parsed/Chunked/Indexed -> READY.
Uploaded knowledge must carry provenance and scenario metadata.

Do not require V2 research to solve scanned-document OCR, engineering drawings, circuit diagrams, image/video understanding or multimodal RAG unless evidence establishes them as indispensable. Mark such needs as future scope/unknowns.

## 11. Phase D — Evaluation Design
Create a V2 evaluation draft BEFORE implementation-contract freeze.

At minimum include:
### Retrieval Eval
- relevance
- Recall@K/Precision@K where meaningful
- metadata/scope filtering
- cross-domain isolation
- user-upload retrieval

### Transcript Correction Eval
- technical terms
- identifiers/model/part/fault codes
- numbers and units
- negation
- maintenance actions
- completion state
- preservation of original factual meaning

### Fact Extraction Eval
- field accuracy/coverage
- missing facts
- invented facts
- incorrect normalization/status/identity
- strict separation of transcript-observed facts from knowledge-base context

### Report Eval
- factual grounding
- required-field coverage
- unsupported claims
- structure
- consistency with structured facts
- provenance/traceability where appropriate

### End-to-End Eval
Scenario + scoped knowledge + optional user upload + transcript -> correction -> facts -> report -> validation.

Design golden/synthetic cases where real data is unavailable, and label them as synthetic.

## 12. Critical-error taxonomy
Define hard-failure candidates including:
- changed negation
- changed numerical value/unit
- wrong asset/model/component/part number/fault code
- invented maintenance action/replacement
- incorrect completion state
- invented test/test result
- incorrect safety or return-to-service status
- cross-domain knowledge leakage
- unsupported maintenance fact introduced from RAG
- user-upload contamination across scopes

Safety-critical errors must not be hidden by average accuracy. Recommend explicit hard gates.

## 13. Mandatory user-upload acceptance test
Design a synthetic test containing a previously unknown term, e.g.:
ZX-47 = Auxiliary Door Control Module.

Before upload: system lacks that knowledge.
After upload: document is parsed/chunked/indexed and READY.
Noisy transcript: "ZX forty seven has intermittent failure."
Expected: correct scoped retrieval assists interpretation/correction.

If the uploaded manual recommends replacement but the technician did not say replacement occurred, facts/report MUST NOT state "ZX-47 replaced."

The test must cover ingestion, retrieval, scope isolation, correction, fact grounding and report grounding.

## 14. Phase E — Freeze Readiness
For every major requirement classify:
GREEN = evidence/design sufficient to freeze for implementation.
YELLOW = provisional implementation contract possible but SBS confirmation required before production reliance.
RED = insufficient information; freezing would launder assumptions into requirements.

Assess at least:
- Bus/Rail workflows
- Bus/Rail fact schemas
- Bus/Rail report schemas
- critical fields/errors
- knowledge hierarchy
- cross-domain isolation
- user-upload behavior
- retrieval/correction/fact/report/E2E evals

## 15. Required deliverables
Write these files under docs/v2-research/:
01_SBS_DOMAIN_DISCOVERY.md
02_SBS_EVIDENCE_AUDIT.md
03_SBS_BUS_DOMAIN_MODEL.md
04_SBS_RAIL_DOMAIN_MODEL.md
05_V2_FACT_SCHEMA_DRAFT.md
06_V2_REPORT_SCHEMA_DRAFT.md
07_V2_EVAL_SPEC_DRAFT.md
08_V2_CRITICAL_ERROR_TAXONOMY.md
09_V2_KNOWLEDGE_SCOPE_DRAFT.md
10_SBS_INFORMATION_GAPS.md
11_FREEZE_READINESS_REPORT.md

The final report must contain a table:
Requirement | Evidence | Status | Remaining uncertainty | Recommended action

End with: MINIMUM INFORMATION REQUIRED FROM SBS.
Request the smallest set of real SBS artifacts/answers that would materially resolve remaining uncertainty.

## 16. Prohibitions
During this contract:
- do not write implementation code
- do not modify production behavior
- do not fabricate sources/data
- do not present generic practice as SBS fact
- do not let manuals/RAG create service facts
- do not prematurely declare RED/YELLOW assumptions frozen
- do not optimize for architectural complexity
- do not silently weaken V1 integrity controls

## 17. Completion standard
The work is complete only when all 11 deliverables exist, factual claims are source-audited, uncertainty remains explicit, the evaluation draft is actionable, and the Freeze Readiness Report makes clear what can and cannot enter the later frozen implementation contract.

Evidence quality and falsifiability are more important than document length.
