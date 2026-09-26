# Report Workspace Component Audit

## Decision trace

User: a field technician completing one bound maintenance report.

Immediate goal: capture what happened once, answer only unresolved exceptions, review material facts, and confirm the existing company report.

Required decisions: provide an initial statement; resolve the current correction or ResolutionItem; inspect evidence only when needed; confirm when the server marks the report ready.

Required information: report/job identity, actionable completeness, the current question or recovery action, compact report sections, material source provenance, and confirmation availability.

Required actions: type or record a statement, upload a recording, attach evidence, accept/reject a material transcript correction, answer one ResolutionItem, edit a specific field on demand, inspect provenance, retry preserved audio, and confirm/export.

Required visible system state: capture/recording/processing/recovery status, current server-owned ReportSession phase, current ResolutionItem, section-level exceptions, and server-owned readiness.

The minimum sufficient persistent component set is therefore: App shell/navigation, compact JobHeader, one ActiveTaskPanel, and Report Summary.

## Existing component inventory and disposition

| Current component | Classification | Decision |
| --- | --- | --- |
| Template sidebar and technician navigation | KEEP | Required global navigation. Manager navigation remains unchanged because it is outside this workspace refactor. |
| Top bar page title | REVISE | Keep shell identity, but remove duplicated report title/status from the workspace context. |
| Runtime connection indicator | HIDE BY DEFAULT | Show only when connecting, unavailable, or recovering; “Local” is implementation-driven and not a technician task. |
| Choose-report back action | MOVE | Keep as a compact JobHeader action, not a competing page heading. |
| Organization eyebrow | REMOVE | The organization is template provenance, not product branding or a repeated workspace heading. |
| Large report title and description | REVISE | Become compact JobHeader title plus one metadata line. Remove generic description after selection. |
| Required-count status and decorative progress meter | REVISE | Replace “0 / 14 required” and meter with server-owned “complete / total” and “need input”; categories open on demand. |
| Report composer panel | REVISE | Becomes the Capture state of ActiveTaskPanel. |
| Statement textarea | KEEP | Primary input; submit automatically after a deliberate pause or explicit keyboard action, with microphone embedded. |
| Separate microphone pill | MERGE | Embed in the statement composer as the single peer capture mode, retaining one clear capture interaction. |
| Update report button | REMOVE | Processing starts automatically; no manual pipeline trigger. |
| Upload recording | KEEP | Secondary capture action. |
| Add supporting document | REVISE | Rename to “Attach evidence”; one control with attachment-purpose selection. |
| Retry button | MOVE | Appears only as the primary recovery action in ActiveTaskPanel. |
| Recording timer | KEEP | Contextual live state only while recording. |
| Input/status text | REVISE | One concise live status; no provider/model/pipeline implementation language. |
| Transcript correction container | REVISE | ActiveTaskPanel shows exactly one material correction with accept/reject controls. |
| Full statement textarea after capture | HIDE BY DEFAULT | Collapse to “Initial statement captured” with on-demand transcript. Auto-expand only for correction. |
| Full editable field form | REMOVE | Replaced by read-first ReportSectionAccordion; no permanent inputs. |
| Checklist table with permanent controls | REVISE | Compact read-only field rows inside section accordions; editing is on demand. |
| Per-field status on every field | REVISE | Show actionable labels only when meaningful; normal values use a lightweight source indicator. |
| Per-field confirm buttons | MOVE | Critical/uncertain/conflict work moves to the single ResolutionItem ActiveTaskPanel. |
| Confirmation checkbox | REMOVE | It duplicates review state and local browser logic. Server readiness controls confirmation. |
| Confirm Report button | REVISE | The only final primary CTA; enabled only when the authoritative session is READY. |
| Confirmation status paragraph | MERGE | Fold into ActiveTaskPanel/live status so confirmation status is not duplicated. |
| Template details and evidence block | REMOVE | Template IDs, schema versions, context versions, and source inventories are implementation/admin data. |
| Context-source list | HIDE BY DEFAULT | Only question-specific “Why is this required?” guidance is available on demand. |
| Full evidence/debug drawer from the legacy app | REMOVE | Raw JSON, receipts, trace IDs, model/provider details, and debug timelines do not belong in the technician workspace. Replace with field-level provenance disclosure. |
| Reports list, template chooser, manager template pages | KEEP | Outside this focused workspace refactor. |

## Zero-component result

Starting from an empty workspace, four persistent areas earn their place:

1. App shell/navigation: location and escape path.
2. JobHeader: compact report/job identity and actionable completion summary.
3. ActiveTaskPanel: the only immediate task, capture, correction, resolution, recovery, review, ready, or confirmed action.
4. Report Summary: read-first sections and on-demand provenance/editing.

Attachment purpose, transcript, guidance explanation, provenance, editing, and unresolved-category details are contextual disclosures rather than permanent panels.
