# Authoritative Report Workspace — Prompt 6 delivery report

## Outcome

The technician workspace is now a minimal client of the authoritative `ReportSession` workflow:

`Capture → server extraction/completeness → one ResolutionItem at a time → focused review → server-gated confirmation → existing-format export`

The browser no longer constructs facts, completeness, conflicts, validation, or confirmation eligibility. It renders the current session, Agent state, and queue returned by the server.

## Before / after architecture

Before, the page exposed a large editable report form, a persistent transcript, client-side report updates, duplicated workflow controls, and implementation-oriented evidence/status surfaces. After the refactor, the persistent technician page has four areas only:

1. `AppShell`
2. `CompactJobHeader`
3. `ActiveTaskPanel`
4. `ReportSummary`

`ActiveTaskPanel` is the single state-dependent action surface. `ReportSummary` is read-first and exception-first. Evidence, transcript, guidance rationale, attachments, and editing are disclosures or dialogs rather than permanent panels.

## Final component hierarchy

```text
AppShell
├── Navigation
└── ReportWorkspace
    ├── CompactJobHeader
    │   ├── template / work order / asset / technician
    │   └── actionable completeness
    ├── ActiveTaskPanel
    │   ├── CaptureComposer | ProcessingState | TranscriptCorrection
    │   ├── ResolutionItem | Review | Ready | Confirmed
    │   └── RecoverableError
    └── ReportSummary
        ├── ReportSectionAccordion[]
        │   └── read-first ReportField[]
        ├── ProvenanceDialog
        └── classified AttachmentDialog
```

## Component disposition

The full pre-change inventory and rationale are in `REPORT_WORKSPACE_COMPONENT_AUDIT.md`.

Removed or consolidated:

- Removed manual **Update report** and client-side analysis controls; submission automatically starts processing.
- Removed the permanent editable form; fields are read-first and edit only on demand during resolution.
- Removed the confirmation checkbox and duplicate confirmation controls; `Confirm report` exists only in server phase `READY`.
- Removed permanent transcript, RAG/retrieval, confidence, trace, chunk, provider, and JSON panels.
- Consolidated microphone, recording upload, and text into one capture composer.
- Consolidated evidence uploads into one classified **Attach evidence** action.
- Merged progress and completion into the compact job header.
- Moved transcript, provenance, full-report viewing, and “Why is this required?” behind progressive disclosure.
- Kept report selection, manager template setup, application shell, existing report sections, and export behavior.

## ReportSession → UI state mapping

| Server state | Technician surface | Primary action |
|---|---|---|
| loading | Loading job | none |
| `CONTEXT` | Tell us what happened | Continue after non-empty text; recording is embedded |
| capture recording | Recording… | Stop recording |
| audio upload / `PROCESSING` | Transcribing / extracting / checking | none |
| `CORRECTION_IF_NEEDED` | one material correction | Keep original or use correction |
| `RESOLVE` + queue | first server `ResolutionItem` | structured answer / Continue |
| `REVIEW` | edited, critical, and safety items only | Finish review |
| `READY` | exact approved version | Confirm report |
| `CONFIRMED` | confirmed package | Export report |
| recoverable error | saved-work message | retry the failed operation |

Header progress is derived from `agent_state.completeness` and `resolution_queue`; it reads as “N / M complete” and “N need input.” A conflict is represented truthfully as “Bus ID needs resolution,” never as either candidate value.

## ResolutionItem → control mapping

| Answer contract | Control |
|---|---|
| `SELECT_OR_PROVIDE` | source-labelled candidate buttons + Enter another |
| `SINGLE_SELECT` | button group; no positive safety default |
| `SEMANTIC_STATE` | semantic buttons such as Not established / Further investigation required |
| `NONE_OR_VALUE` | None / Yes — describe |
| `CONFIRM_OR_REPLACE` | confirm candidate / Enter correction |
| `VALUE` | compact input, with number/unit normalization where declared |

After every answer, the UI accepts the returned revision and Agent state, refreshes the authoritative chain, and renders the newly rebuilt queue. A stale revision is never applied optimistically; the UI shows a reconcile action.

## Backend support added for the workspace

- Added server-owned review entry/completion, report confirmation binding, and classified attachment APIs.
- Added immutable audit events for attachments, review start/completion, and report confirmation.
- Added content-addressed attachment storage; attachments become `DOCUMENT` evidence but never create a `FieldCandidate` by themselves.
- Added a demo work-order context provider so known identity fields arrive before capture without browser-supplied facts.
- Added deterministic Bus/Fleet ID extraction for explicitly introduced identifiers so spoken/text identity conflicts reach the authoritative ConflictEngine.
- Fixed mixed statements so explicit “No parts were used” remains `EXPLICIT_NONE` even if a component name is mentioned elsewhere; an actual stated replacement is not silently discarded.

## Responsive behavior

- Desktop uses a compact two-column read-first field grid and keeps the active task above the report.
- At approximately `390 × 844`, the shell collapses, report fields become one column, structured choices become full-width, and primary/secondary controls stack.
- Resolution choices use at least 50 px height; report Source/Edit and disclosure targets use at least 44 px on mobile.
- Long template names, identifiers, field values, and terminology wrap without horizontal overflow.
- Capture, Resolve, Review, and recoverable-error states remain usable in the initial mobile viewport.

## Accessibility verification

- Interactive controls have accessible names; the active task is an `aria-live="polite"` labelled region.
- Focus-visible styling uses a 3 px high-contrast outline.
- All structured question choices are native buttons and keyboard reachable.
- Native dialogs focus their close control, trap focus, close on Escape, and restore focus to the invoking Source action.
- The mobile navigation is inert and removed from the accessibility tree while closed.
- Disabled capture communicates its requirement through the empty statement field; confirmation is omitted until server phase `READY` rather than shown as a misleading locally-disabled gate.
- Microphone denial explicitly offers **Use text instead**; capture always retains typed text and supports recording upload.
- Errors include an “Action needed” label and text, not color alone.

Rendered checks found and fixed: over-expanded capture sections, every section opening during review, normal fields being forced through review, missing measurement units, misleading source checkmarks on conflicts, inaccessible 32 px mobile Source/Edit targets, raw “Failed to fetch” copy, a no-op retry path, and a nested `<main>` landmark.

## UI and integration test matrix

Automated workspace state coverage contains all requested named states:

- Capture/processing (11): loading, empty, typing, mic ready, recording, stopped, uploading, transcribing, extracting, completeness check, successful extraction.
- Correction (3): material correction, accepted, rejected.
- Resolution semantics (11): required missing, uncertain, conflict, invalid, conditional, safety, explicit none, N/A, partial, multi-item, final item.
- Completion (3): review, ready, confirmed.
- Recovery/export (5): STT failure, upload failure, network failure, stale revision, export after confirmation.

For every state, `report-workspace-view.test.js` asserts the single primary action, server-phase confirmation gate, absence of debug metadata, and authoritative view mapping. DOM contracts assert progressive disclosure, read-first fields, no browser facts/completeness, structured controls, responsive rules, accessible focus/targets, non-voice recovery, and no permanent RAG/debug surface.

Actual results:

| Verification | Result |
|---|---|
| Full deterministic repository suite | **428 passed, 0 failed** |
| Focused workspace/server lifecycle suite | **67 passed, 0 failed** |
| Workspace view/UI contract subset after visual fixes | **49 passed, 0 failed** |
| Normal browser console | **0 errors, 0 warnings** |
| Network recovery | expected browser network failure only; retry continued the same session and statement |
| Confirm/export browser smoke | confirmed successfully; downloaded `bus-defect-rectification-corrective-maintenance.txt` |

## Real unified-backend journeys

| Journey | Result and evidence |
|---|---|
| A — Mostly complete dictation/text | PASS — work-order identity prefilled, processing automatic, transcript collapsed, five true unresolved items queued, one-at-a-time answers reached Review → Ready → Confirmed → export. |
| B — Explicit none | PASS — mixed statement with “door controller” plus “No parts were used” rendered Parts / materials = None and did not ask for a part. Regression test added. |
| C — Conflict | PASS — `8300-354` work order vs `8300-345` statement produced `CONFLICT`; both values and sources were shown; source dialog retained both provenance chains; selection removed the conflict. |
| D — Uncertain measurement | PASS — Agent integration tests keep `UNCERTAIN` distinct and emit one `CONFIRM_OR_REPLACE`; the UI state contract renders one focused structured confirmation and source remains attached. |
| E — Root cause unknown | PASS — “Root cause not established” is preserved and allowed to complete without an invented diagnosis. |
| F — Safety | PASS — return-to-service was the first question, no option was preselected, and confirmation remained unavailable until the server accepted it. |
| G — RAG-triggered requirement | PASS — Agent integration proves GuidanceContext can create a follow-up but cannot satisfy work performed; UI exposes only optional “Why is this required?” and no RAG panel. |
| H — STT failure | PASS — HTTP integration preserves audio evidence and retries transcription on the same ReportSession; UI state renders Retry transcription and never fabricates a transcript. |

## Product-UI-QA findings and fixes

- Replaced implementation-centred stages and panels with task-centred copy and transient processing.
- Reduced initial page height by keeping report sections collapsed during capture.
- Opened only the section containing the current resolution; other unresolved sections remain visually marked.
- In Review, showed only technician-resolved and critical/safety values by default; **View full report** reveals everything.
- Preserved exact source labels and verbatim evidence spans on demand.
- Prevented conflicting values from appearing as accepted report values.
- Preserved typed work through offline failure and made retry resume the failed capture.
- Confirmed native modal focus behavior and practical mobile hit areas.
- Searched the visible workspace for duplicate primary controls, microphones, uploads, confirmation controls, decorative cards, permanent transcripts/RAG, confidence percentages, raw JSON, trace/chunk IDs, provider/model names, and internal phase terminology; none remain.

## Requirement-to-UI evidence matrix

| Requirement | Classification | Observable evidence |
|---|---|---|
| Report-aware Capture | PASS | Exact published template and work-order context bind the session; known identity is prefilled; one text/mic composer submits through ReportSession capture APIs. |
| Active Completeness | PASS | Header shows actionable completion; server queue drives one question at a time; technician never searches the form for the next missing field. |
| Evidence-grounded / Traceable | PASS | Read-first fields expose source on demand; conflict provenance shows both sources; attachments and answers become server-owned evidence/events. |
| Existing-workflow Compatibility | PASS | Existing template sections remain; the confirmed server-approved draft exports through the existing report builder/exporter. |
| Voice/Text → structured fields | PASS | Text browser journey and audio HTTP integration both enter the unified capture service and produce server candidates. |
| Missing-field detection | PASS | Server completeness/validation queue is rendered directly; optional missing fields do not block. |
| Agent follow-up questions | PASS | ResolutionPlanner order and answer contracts map to one focused task with structured controls. |
| Human confirmation | PASS | Correction decisions, resolution answers, review completion, and final confirmation are explicit server mutations with revision checks. |
| Field provenance/evidence | PASS | Source dialog shows work-order records or exact transcript spans; resolution evidence survives conflict resolution. |
| Existing template/report compatibility | PASS | SBS corrective-maintenance schema rendered and exported in the existing builder path after server confirmation. |

No P0 requirement is classified FAIL without explanation.

## Verification artifacts

Screenshots are in `output/playwright/prompt6/`:

- `desktop-capture-final.png`
- `desktop-resolve-final.png`
- `desktop-conflict-final.png`
- `desktop-review-final.png`
- `desktop-ready.png`
- `desktop-recoverable-error-final.png`
- `mobile-capture.png`
- `mobile-resolve.png`
- `mobile-review-final.png`
- `mobile-recoverable-error-final.png`

## Remaining issues

### P0

None known after the full suite and rendered-state verification.

### P1

- The new authoritative workspace copy is English-only. Existing locale infrastructure and legacy bilingual surfaces remain intact, but these new strings should be moved into the locale catalog in a later localization phase.
- Reopening an in-progress server-persisted ReportSession after a full browser reload needs a session-list/resume API and product decision; server restart persistence itself is already covered.
- Physical-device microphone permission and long-recording ergonomics should receive device-lab coverage in addition to automated capture/provider tests.

### P2

- Add automated screenshot-diff baselines if the repository adopts a visual-regression service.

## Exact files changed

- `src/domain/audit-contracts.js`
- `src/domain/report-session.js`
- `src/server.js`
- `src/storage/report-sessions.js`
- `src/storage/reports.js`
- `src/tools/extract-v2-facts.js`
- `src/workflows/authoritative-capture.js`
- `test/authoritative-agent-workflow.test.js`
- `test/authoritative-capture-server.test.js`
- `test/report-workspace-lifecycle.test.js`
- `test/report-workspace-view.test.js`
- `test/template-ui-contract.test.js`
- `test/template-workspace-refinement.test.js`
- `test/v2/extract-v2-facts.test.js`
- `web/index.html`
- `web/report-workspace-view.js`
- `web/styles.css`
- `web/template-app.js`
- `docs/REPORT_WORKSPACE_COMPONENT_AUDIT.md`
- `docs/AUTHORITATIVE_REPORT_WORKSPACE.md`
