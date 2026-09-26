# Template catalog runtime implementation

Date: 2026-09-26
Branch: `feat/template-catalog-runtime`

This note records the template-driven implementation added from the Template-Driven Maintenance Reporting SoT and the SBS Transit Expanded Template Research Pack 2. It supplements the requirements; it does not redefine them.

## Provenance boundary

None of the Bus or Rail forms in this implementation is represented as an official SBS Transit form. The catalog preserves the source filename, SHA-256, pack name, and one of these classifications:

- `user-supplied prototype`
- `research-derived prototype`
- `official external context source` (context links and public metadata only)

The original research-pack artifacts remain user-owned source material. The runtime catalog contains derived field definitions and source metadata, not copied full standards.

## Published predefined versions

All entries use the same `Template → TemplateVersion → ReportSchema → ContextCorpus → RendererMapping → Adapter` contract.

| Template | Template version | Domain | Prototype source |
| --- | --- | --- | --- |
| HVAC Service Report | 1.0.0 | HVAC | `hvac-service-report.v1.json` |
| Bus Preventive Maintenance / Inspection | 1.0.0 | SBS_BUS | `Bus_General_PM_Prototype.docx` |
| Bus Defect Rectification / Corrective Maintenance | 1.0.0 | SBS_BUS | `Bus_Defect_Rectification_Prototype.docx` |
| Bus Passenger Door / Safety Equipment Inspection | 1.0.0 | SBS_BUS | `Bus_Door_Safety_Inspection_Prototype.docx` |
| Rail Track Inspection / Maintenance | 1.0.0 | SBS_RAIL | `Rail_Track_Inspection_Prototype.docx` |
| Plain Rail Preventive Inspection | 1.0.0 | SBS_RAIL | `Rail_Plain_Rail_PM_Prototype.docx` |
| Conductor / Third-Rail Preventive Inspection | 1.0.0 | SBS_RAIL | `Rail_Conductor_Rail_Inspection_Prototype.docx` |
| Rail Maintenance Completion / Handover | 1.0.0 | SBS_RAIL | `Rail_Maintenance_Handover_Prototype.docx` |

Each schema declares field id, label, section, display order, type, required policy, critical policy, allowed status/value policy where applicable, inference policy, and renderer control. Checklist status fields begin at `NOT_CHECKED`; silence never maps to `OK`, `Normal`, `Passed`, `READY`, performed work, or a completion state.

## Runtime binding and evidence flow

A new report session binds these exact identities before any input is accepted:

```text
templateId + templateVersion
  + schemaId + schemaVersion
  + contextCorpusId + contextVersion
  + rendererId + rendererVersion
```

Voice, typed statements, text uploads, and manual field entry converge on the existing `ReportSession`, `StructuredJobState`, completeness, and `ResolveQueue` runtime. Existing SBS Bus and Rail deterministic extractors are adapters into the selected schema. Facts outside that schema are retained as unsupported rather than rendered. Knowledge/context-only support becomes `NEEDS_CONFIRMATION`, and critical values require technician confirmation.

`POST /api/template-reports/build` is retained only as a non-authoritative compatibility/diagnostic projection. Supported P0 technician reports validate, review, confirm, snapshot, and export through `/api/report-sessions/:id/*`. Legacy V2 confirmation is disabled; a client draft or material client-side change cannot authorize finalization.

## Context corpora

Every predefined template version owns a distinct context corpus id. Retrieval first resolves the immutable template binding and cannot widen scope based on query text. Bus Door, Rail Track, Plain Rail, and Conductor Rail therefore cannot retrieve from each other's corpus unless a future approved organization policy explicitly creates a shared source.

Only public links and summaries are registered. Current metadata sources include public SBS Transit rail-maintenance pages, the LTA infrastructure criteria page, the lawfully available TR 85 preview, and the public TR 126 product overview. Restricted LTA chapters and paywalled full standards are not ingested. Context results explicitly carry `mayAssertJobFacts: false`.

## Manager Template Setup

Manager Template Setup implements truthful states for:

1. source upload and content-addressed preservation;
2. analysis (`MANUAL_REVIEW_REQUIRED` when no robust parser is enabled);
3. manual field/schema review;
4. template-version-scoped context upload;
5. server-side contract test;
6. immutable version publication.

Text context is marked `READY_TEXT`. Unsupported binary context is preserved as `PRESERVED_UNDETECTED` and blocks publication pending review. The source artifact is never discarded. Custom templates published through this flow are returned by the same catalog endpoint and registered into the same browser runtime; they are not UI exceptions.

## Verification coverage

Automated contracts cover:

- identity and immutable versions for all eight predefined templates;
- explicit field metadata, required missingness, unsupported fields, and no positive defaults;
- deterministic Bus/Rail extraction adapters for all seven SBS templates;
- negated and recommended work not becoming performed work;
- inline Resolve updates, critical confirmation, and conflicts;
- per-template context isolation and binding mismatch rejection;
- exact-version final validation and confirmation for every predefined template;
- custom upload preservation, manual-review state, schema/context/test/publish happy path, and publish-gate failure path;
- visible technician and manager information architecture.

Actual browser QA covers the chooser, Bus Door workspace, Rail Track workspace, missing state, critical/conflict state, READY, CONFIRMED, manager list, Template Setup, and mobile chooser/workspace. Evidence is stored locally under `output/visual-qa/`.

## Report Workspace refinement (2026-09-26)

The technician surface now presents the selected schema as the report itself rather than as a separate capture panel followed by a checklist. Template sections and display order drive compact desktop rows and single-column mobile fields. Checklist triplets (`status`, `observation`, and `action`) render as one report row, while required, supported, confirmation-required, and conflicting states appear beside the affected field.

Voice and typed input share one compact composer. The microphone control is attached to the statement area; stopping a recording persists WAV evidence, transcribes it, runs extraction and schema mapping, and refreshes the report without a separate Transcribe action. Typed edits are also preserved as immutable manual transcript artifacts with edited-artifact provenance. HVAC input reuses the existing normalization/correction-receipt/extraction pipeline: suggested transcript wording is reviewed inline before mapping, and critical mapped values still require an explicit technician confirmation beside the field. After exact-version confirmation, the report fields and every input path are locked.

The primary identity is the domain-neutral **Field Report** brand. Newway and SBS Transit remain only as contextual organization labels for their respective templates. Technician navigation is limited to Reports and New report; manager navigation is limited to Templates, with Template Setup entered from New template.

The browser visual matrix includes desktop and 390 px mobile layouts, empty/partial/ready/confirmed report states, recording and processing feedback, real extraction-produced critical and conflict states, manager Templates and Template Setup, keyboard focus, and a clean browser console. Recording/processing screenshots use a browser media-device stub for repeatable visual-state inspection; recorder encoding and error paths remain covered by automated tests, while a physical microphone was not exercised in this run.

## Template Selection refinement (2026-09-26)

The technician chooser projects a deliberately small, human-facing view from the canonical template contract: display name, short description, organization, operational category, report family, and search aliases. Versions, provenance, schema ids, context ids, and renderer ids remain available in the manager and audit surfaces but are not repeated on technician cards. Only published templates whose presentation policy allows technician use are listed.

The default chooser is `New report → Choose a report → Search reports`, followed by optional All, Bus, Rail, and HVAC filters. Search covers the display name, organization, domain, family, description, and aliases. The catalog uses compact two-column rows on desktop and one-column rows on mobile. Loading, unavailable, empty-catalog, no-results, and clear-search states are explicit. Reports navigation remains hidden until this browser actually has a report session.

Recent reports are not seeded or inferred. The chooser records only templates actually opened in the current browser tab, keeps at most three unique ids in `sessionStorage`, and hides the section when no valid recent id exists. The report session continues to bind the exact template, schema, renderer, and context versions from the full canonical record; the technician projection never becomes runtime authority.

Selection behavior is covered at the eight-template baseline and with a 100-template synthetic catalog. Browser evidence for chooser, search/no-results, recent use, representative Bus/Rail workspaces, READY/CONFIRMED, manager setup, and 390 px mobile is stored under `output/playwright/` and remains excluded from source control.

## Known limitations and deferred work

- Arbitrary DOCX/PDF layout reconstruction and schema extraction are deliberately not claimed. Source files are preserved and schema definition is manual.
- Binary context parsing/OCR is not implemented; unsupported content remains visibly undetected.
- Existing deterministic extractors map canonical facts but do not infer template checklist row statuses from prose. A technician must explicitly set checklist statuses.
- Local Whisper remains an optional runtime dependency; audio is preserved and a truthful error is shown if transcription is unavailable.
- Organization authorization, shared-corpus approval, multi-user editing, and production identity remain future work.
