# Unified ReportSession contracts

This phase establishes a target domain boundary without changing the technician UI or existing HTTP endpoints. The contracts under `src/domain/` are intentionally not wired into production flows yet.

## Authority model

- `ReportSession` is a server-owned aggregate. Browser data is input to commands, never a persisted session replacement.
- Every mutation uses `session_id + expected_revision`; accepted transitions increment the revision exactly once and append a server-issued `AuditEvent` reference.
- `FieldState` describes the semantic state of a report field. `SupportType` describes why a candidate may be believed. They are separate dimensions.
- `TECHNICIAN_CONFIRMATION` can only be created from a matching server-issued confirmation event bound to the session, field, source candidate, and future technician-principal reference.
- `GuidanceContext` is a separate contract. It has no `evidence_id`, is permanently marked `eligible_as_job_evidence: false`, and `RAG_GUIDANCE` is rejected by `FieldCandidate` construction.
- Persisted sessions and snapshots require an out-of-band trusted persistence hash when deserialized. A JSON shape alone is not an authority grant.

## Contract inventory

| Contract | Purpose |
|---|---|
| `ReportSession` | Server-authoritative aggregate identity, bindings, revision, phase, timestamps, recovery state, and append-only audit references. |
| `Evidence` | Immutable content-addressed audio, transcript, document, manual-input, or system-record artifact metadata. |
| `EvidenceSpan` | Exact UTF-16 source offsets and quote hash, validated against the supplied immutable source text. |
| `TranscriptArtifact` | Immutable transcript text and segments bound to a session and source evidence artifact. |
| `TranscriptReview` | Review decisions for one transcript with a future technician-principal reference. |
| `FieldCandidate` | A session-bound claim, evidence references, assessment, and support type. |
| `ReportField` | All candidates for one session/field plus a deterministically derived `FieldState`. |
| `GuidanceContext` | Retrieved context that can guide questions or validation but cannot directly become a job fact. |
| `ValidationIssue` | Structured validation failure with exact field, candidate, and evidence references. |
| `ResolutionItem` | Explicit work required to resolve a validation issue. |
| `AuditEvent` | Server-issued append-only transition or confirmation event. |
| `ReportSnapshot` | Deeply immutable, content-addressed view of one exact session revision. |

## Field semantics

`ReportField` derives one of:

- `UNKNOWN`: no candidate exists.
- `EXPLICIT_NONE`: evidence explicitly states that no item/value exists.
- `NOT_APPLICABLE`: the field does not apply to the job.
- `CONFLICT`: at least two distinct claims compete; every candidate and provenance reference is retained.
- `INVALID`: the selected claim failed deterministic validation.
- `UNCERTAIN`: the claim exists but its assessment remains uncertain.
- `INFERRED`: the only support is AI inference.
- `KNOWN_VALUE`: one non-conflicting value is supported by job evidence or a server-issued technician confirmation.

`EXPLICIT_NONE`, `NOT_APPLICABLE`, and `UNKNOWN` therefore never collapse into the same null-like value.

## Session transitions

```text
CONTEXT -> CAPTURE -> PROCESSING -> CORRECTION_IF_NEEDED -> RESOLVE
                              \---------------------------> RESOLVE
RESOLVE -> REVIEW -> READY -> CONFIRMED

CAPTURE | PROCESSING | CORRECTION_IF_NEEDED | RESOLVE | REVIEW | READY
  -> RECOVERABLE_ERROR -> exact recorded recovery phase
```

`CONFIRMED` is terminal in this contract version. Invalid skips, stale revisions, and recovery to any phase other than the recorded failure phase fail with explicit error codes.

## Mapping from current runtime

| Current source | New contract mapping | Migration rule |
|---|---|---|
| Browser `session.id` | `ReportSession.session_id` | The server creates and persists it; the browser only retains a reference. |
| `templateBinding` | `template_binding` | Preserve exact template ID/version. Schema/renderer metadata may remain template-owned in this phase. |
| `scope`, context corpus | `context_binding` | Bind context ID/version and scope on session creation. |
| Browser `revision` | `ReportSession.revision` | Replace local increments with compare-and-append server commands. |
| `fieldStates[field].status = MISSING` | `ReportField.state = UNKNOWN` | No candidate. |
| `SUPPORTED` | `KNOWN_VALUE`, `EXPLICIT_NONE`, or `NOT_APPLICABLE` | Derive from candidate claims rather than one generic status. |
| `NEEDS_CONFIRMATION` | `UNCERTAIN` plus a `ResolutionItem` | Do not encode missing authority as a support label. |
| `CONFLICT` | `CONFLICT` | Retain all competing candidates; never select the last write. |
| V2 `DIRECT_TRANSCRIPT` | `TRANSCRIPT_EVIDENCE` | Require transcript artifact plus exact `EvidenceSpan`. |
| V2 system-derived source | `AUTHORITATIVE_SYSTEM_DATA` | Require an immutable system evidence artifact. |
| Uploaded supporting document | `DOCUMENT_EVIDENCE` | Require document evidence and span where text offsets exist. |
| `MANUAL_ENTRY` | `MANUAL_TECHNICIAN_INPUT` | Persist manual input evidence first. |
| Client `CONFIRMED_BY_TECHNICIAN` | No authoritative direct mapping | Keep as untrusted manual input until a server confirmation event is issued. |
| `UNCERTAIN` V2 fact | Candidate `assessment = UNCERTAIN` | Support type still records the evidence source independently. |
| `knowledge:*`, `context:*`, `rag:*`, `knowledge_hits` | `GuidanceContext` | Never insert into `Evidence` or `FieldCandidate`. |
| Browser resolve answer | Resolution command | Server validates expected revision and appends the resulting candidate/event. |
| Browser confirmation object | `AuditEvent` + immutable `ReportSnapshot` | Server binds principal, session revision, template, state and content hash. |

## Existing-module migration map

| Classification | Modules | Intended treatment |
|---|---|---|
| `KEEP` | `src/storage/artifacts.js`, `src/tools/correction-integrity.js`, `src/v2/scope.js`, `src/v2/retrieval.js`, `src/v2/upload.js`, deterministic extractors | Preserve evidence-first storage, correction checks, scope isolation, and deterministic extraction. Adapt outputs at their boundaries only. |
| `ADAPT` | `src/server.js`, `src/storage/reports.js`, `web/report-runtime.js`, template catalog/runtime, V1/V2 report builders | Add a server session repository and command handlers; turn the browser runtime into a read-only projection; make builders consume a snapshot. |
| `REPLACE` | Browser `applyResolveAnswer`, browser `factsFromStructuredState` as builder authority, direct facts/draft submission to build/confirm, hash-only `v2facts_*` receipts | Replace with session commands, persisted fact receipts, and server-loaded snapshots. |
| `DEPRECATE` | Client support/provenance labels, raw client `knowledge_hits`, last-write-wins template field map, confirmation from free-form draft payload | Keep only during compatibility rollout, then remove after parity and replay tests pass. |

## Intentionally unresolved for the next phase

1. Session repository technology, transaction boundaries, retention, and restart recovery.
2. Production authentication and authorization for `technician_principal_ref`.
3. HTTP command/resource shapes and compatibility rollout for existing endpoints.
4. Migration of audio orchestration and immutable capture binding.
5. Technician UI projection and conflict/resolve command integration.
6. Durable storage and signing policy for audit and confirmation receipts.
7. Persisted retrieval snapshots and binding of `GuidanceContext` to validator runs.
8. Conversion/backfill of existing V1/V2 saved reports and facts receipts.
9. Cross-process concurrency, transaction retries, and event-store idempotency keys.
10. Embeddings, OCR, or any change to current retrieval models.

These omissions are deliberate: this branch supplies contracts, deterministic state/revision logic, documentation, and tests only.
