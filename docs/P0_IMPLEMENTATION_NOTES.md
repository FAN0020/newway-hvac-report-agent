# P0 implementation notes

This note records the implemented P0 decisions from `Newway_UIUX_P0_P1_P2_Implementation_Plan_v3.docx`. It supplements rather than replaces the product requirements and V2 research documents.

## Shared model

The browser owns a schema-bound `ReportSession` for each in-progress report. Built-in schemas are stable at:

| Scope | Schema id | Version |
| --- | --- | --- |
| HVAC | `hvac_service` | `1` |
| SBS Bus | `sbs_bus_maintenance` | `0` |
| SBS Rail | `sbs_rail_maintenance` | `0` |

`web/report-runtime.js` maps grounded facts into field states (`SUPPORTED`, `NEEDS_CONFIRMATION`, `MISSING`, or `CONFLICT`) and normalizes technician work into the four P0 Resolve types: `TERMINOLOGY`, `CRITICAL_VALUE`, `MISSING_FIELD`, and `CONFLICT`. Report and knowledge transients are isolated, and async results are accepted only for the still-active report/scope generation.

## Journey and information architecture

The default journey is Reports → New report → Capture → Resolve (conditional) → Review → Complete. Capture has one primary Continue action and starts extraction/planning/generation/validation without exposing implementation-stage controls. Original transcript, immutable artifact data, and audit events remain available in the Evidence drawer. Provider health is under Settings; scoped uploads and retrieval are under Knowledge; synthetic walkthrough tools are under Help & demo.

## Finalization parity

HVAC retains the existing correction/facts receipt chain and V1 finalization endpoints. SBS Bus and Rail now receive deterministic drafts with exact `schema_id`, `schema_version`, `facts_hash`, and validation receipts from `/api/v2/reports/build`. The V2 confirm/save/export routes call the same `confirmReportDraft`, `saveConfirmedReport`, and `exportConfirmedReport` tools as HVAC. Official JSON and text exports therefore require a non-stale technician confirmation for the exact validated draft.

## P0 defect closures

- Empty upload lists render DOM nodes correctly instead of `[object HTMLParagraphElement]`.
- Statement placeholders are schema-aware, including Rail-specific copy.
- Report statement and technician input are session-scoped; knowledge query state is scope-scoped.
- Late async extraction/retrieval results are discarded after report or scope changes.
- Missing report sections are presented as explicit Resolve decisions before SBS review.

P1/P2 work such as full SBS editor depth, OCR, multi-user collaboration, and production identity remains outside this implementation.
