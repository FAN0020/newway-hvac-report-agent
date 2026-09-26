# P0 implementation notes

This note records the implemented P0 decisions from `Newway_UIUX_P0_P1_P2_Implementation_Plan_v3.docx`. It supplements rather than replaces the product requirements and V2 research documents.

## Shared model

The server owns the schema-bound `ReportSession`, revision, evidence chain, field state, validation, resolution queue, review eligibility, confirmation, and immutable snapshot for each in-progress report. The browser is a revision-aware projection/client. Built-in schemas are stable at:

| Scope | Schema id | Version |
| --- | --- | --- |
| HVAC | `hvac_service` | `1` |
| SBS Bus | `sbs_bus_maintenance` | `0` |
| SBS Rail | `sbs_rail_maintenance` | `0` |

`src/domain/*` and `src/agent/*` are the authoritative P0 contracts. `web/report-runtime.js` remains a non-authoritative compatibility/test projection only. The server models `KNOWN_VALUE`, `EXPLICIT_NONE`, `NOT_APPLICABLE`, `UNKNOWN`, `UNCERTAIN`, `CONFLICT`, `INVALID`, and `INFERRED` separately and owns every transition. Each built-in schema carries typed field definitions, required fields/groups, allowed values/units where existing business rules support them, repeating-family metadata, and a renderer binding.

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

## Finalization parity and cutover

All supported P0 templates now finalize through one ReportSession path: `POST /api/report-sessions/:id/review`, `POST /review/complete`, `POST /confirm`, and `POST /export`. Review completion creates a server-owned validation receipt bound to the exact session revision, template/version, Agent run, and structured-state hash. Confirmation loads that authoritative state and creates one immutable `ReportSnapshot`; export is downstream and idempotent.

The old HVAC and V2 build endpoints remain diagnostic compatibility adapters only. `/api/reports/{confirm,save,export}`, `/api/v2/reports/{confirm,save,export}`, and `/api/report-sessions/:id/confirmation` return `410 LEGACY_AUTHORITY_DISABLED`. The obsolete `web/app.js` authority bundle is not served by the product shell. Domain extractors and hard gates remain modules inside the unified path, not alternative final authorities.

## P0 defect closures

- Empty upload lists render DOM nodes correctly instead of `[object HTMLParagraphElement]`.
- Statement placeholders are schema-aware, including Rail-specific copy.
- Report statement, audio/blob/audio ID, language/model, attachments/evidence, manual fields, technician input, processing/error state, Complete summary, confirmation, and export state are session-scoped; knowledge query state is scope-scoped.
- Late async extraction/retrieval/report/finalization results are discarded after report or scope changes. Older requests in the same session and operation cannot overwrite newer state.
- Missing report sections are presented as explicit Resolve decisions before SBS review.
- HVAC critical corrections use the backend `critical_value_confirmed` contract.
- Knowledge displays retrieval warnings from the tool envelope's `data.warnings` field.
- Completion-state evidence is explicitly technician-confirmed before SBS builders receive it.

## Template-driven catalog extension (2026-09-26)

The technician surface now uses `Choose Template → Report Workspace → Confirm`; Resolve items are inline with the rendered schema. The manager surface uses `Templates → Template Setup → Publish`. HVAC and seven SBS prototype templates share one immutable binding and finalization contract. See `docs/TEMPLATE_CATALOG_IMPLEMENTATION.md` for registered identities, context isolation, upload truth states, tests, and limitations.

Arbitrary DOCX/PDF layout reconstruction, robust schema extraction, OCR, multi-user collaboration, organization authorization, and production identity remain outside this implementation. Uploaded artifacts are preserved and require manual schema review rather than a simulated parser.
