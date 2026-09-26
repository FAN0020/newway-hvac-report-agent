# P0 implementation notes

This note records the implemented P0 decisions from `Newway_UIUX_P0_P1_P2_Implementation_Plan_v3.docx`. It supplements rather than replaces the product requirements and V2 research documents.

## Shared model

The browser owns a schema-bound `ReportSession` for each in-progress report. Built-in schemas are stable at:

| Scope | Schema id | Version |
| --- | --- | --- |
| HVAC | `hvac_service` | `1` |
| SBS Bus | `sbs_bus_maintenance` | `0` |
| SBS Rail | `sbs_rail_maintenance` | `0` |

`web/report-runtime.js` is the shared browser/server P0 compatibility contract. It maps grounded facts into schema field states (`SUPPORTED`, `NEEDS_CONFIRMATION`, `MISSING`, `CONFLICT`, with out-of-schema facts recorded as `UNSUPPORTED`) and normalizes technician work into the four P0 Resolve types: `TERMINOLOGY`, `CRITICAL_VALUE`, `MISSING_FIELD`, and `CONFLICT`. Each built-in schema carries typed field definitions, required fields/groups, allowed values/units where existing business rules support them, repeating-family metadata, and a builder binding.

The implemented authority flow is:

```text
immutable evidence / technician statement
  → existing domain extractor and receipts
  → schema field mapper
  → StructuredJobState + fieldStates
  → deterministic completeness
  → generic ResolveQueue
  → technician follow-up evidence
  → updated StructuredJobState
  → existing domain builder
  → independent validator / hard gates
  → review → exact-version confirmation → official artifact
```

Facts remain evidence-oriented claims. `StructuredJobState` is the authoritative report-field state: builders receive only facts projected from `SUPPORTED` state. Missing, conflicting, unconfirmed, and unsupported values are never rendered as confirmed claims. Technician answers create `CONFIRMED_BY_TECHNICIAN` follow-up facts with the Resolve item and technician in provenance, then rerun mapping, completeness, and queue generation. A deterministic `provenance.source` projection makes verified support visible in SBS output without adding a service action.

Completeness is separate from integrity validation. It reports resolved/missing fields and groups, conflicts, confirmation requirements, invalid enum/unit values, and unsupported fields. Existing HVAC validation and SBS hard gates remain independent authorities. Schema conflicts, confirmation-required state, and schema constraint failures also block V2 confirmation.

## Journey and information architecture

The default journey is Reports → New report → Capture → Resolve (conditional) → Review → Complete. Capture has one primary Continue action and starts extraction/planning/generation/validation without exposing implementation-stage controls. Original transcript, immutable artifact data, and audit events remain available in the Evidence drawer. Provider health is under Settings; scoped uploads and retrieval are under Knowledge; synthetic walkthrough tools are under Help & demo.

## Finalization parity

HVAC retains the existing correction/facts receipt chain and V1 finalization endpoints. Its builder now projects verified receipt facts through `hvac_service` StructuredJobState before generation while keeping `hvac-report-draft.v1` as the legacy document-format marker. HVAC drafts additionally carry `schema_id`, `report_schema_version`, `report_session_id`, `facts_hash`, and `structured_state_hash`.

SBS Bus and Rail receive deterministic drafts with exact `schema_id`, `schema_version`, `report_session_id`, `facts_hash`, `structured_state_hash`, and validation receipts from `/api/v2/reports/build`. Their existing 11- and 12-section builders remain unchanged behind a state-derived fact adapter. The V2 confirm/save/export routes call the same `confirmReportDraft`, `saveConfirmedReport`, and `exportConfirmedReport` tools as HVAC.

Confirmation receipts preserve report, validator, facts/receipt, schema, session, and StructuredJobState identities. Material draft/state/schema changes therefore change the report hash and invalidate stale confirmation. Official report filenames include report identity plus a deterministic suffix from the confirmation identity: repeated writes for one confirmation are idempotent, while distinct confirmations of the same draft no longer collide.

This is an additive P0 adapter. The current domain extractors, HVAC receipt chain, V2 fact schema/hard gates, and three proven builders remain in place. A future P1 schema package can implement the same schema/renderer boundary; it should replace built-in definitions deliberately, not add a parallel Capture/Resolve/Review runtime.

## P0 defect closures

- Empty upload lists render DOM nodes correctly instead of `[object HTMLParagraphElement]`.
- Statement placeholders are schema-aware, including Rail-specific copy.
- Report statement, audio/blob/audio ID, language/model, attachments/evidence, manual fields, technician input, processing/error state, Complete summary, confirmation, and export state are session-scoped; knowledge query state is scope-scoped.
- Late async extraction/retrieval/report/finalization results are discarded after report or scope changes. Older requests in the same session and operation cannot overwrite newer state.
- Missing report sections are presented as explicit Resolve decisions before SBS review.
- HVAC critical corrections use the backend `critical_value_confirmed` contract.
- Knowledge displays retrieval warnings from the tool envelope's `data.warnings` field.
- Completion-state evidence is explicitly technician-confirmed before SBS builders receive it.

P1/P2 work such as arbitrary template parsing, a Template Setup Agent/editor/publisher, layout reconstruction, full SBS editor depth, OCR, multi-user collaboration, and production identity remains outside this implementation.
