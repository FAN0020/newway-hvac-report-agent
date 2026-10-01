# Local work orders (Batch 2)

The **New report** page accepts TXT, CSV, MD and text DOCX work orders up to 10 MB. Upload preserves the original bytes under `data/work-orders/sources/` and creates a pending review record. The UI shows extracted identity candidates and their source lines. A person must confirm the work-order ID and stable vehicle ID, optionally select known task fields, and give a reason for any missing or corrected identity before the record can be used. The uploaded file is never treated as proof that repair, testing, or return to service happened.

After review, choose the exact work-order version in the selector and then choose a published report template. Session creation stores the reviewed work-order reference, version, vehicle ID, source SHA-256 and review SHA-256 before prefill. Only identity and known task fields present in the template may prefill; an explicit template `allowedSources` or `allowed_sources` list must include `WORK_ORDER`. The ordinary **No work order** option still creates a report.

An exact duplicate file receives HTTP 409. A changed file for the same order and vehicle creates a new version; prior versions remain selectable. Reusing a work-order ID for another vehicle receives HTTP 409. Pending or incorrect version references cannot create sessions. Record and source hashes are checked when a version is selected. Records and sessions reload from local files after restart.

Unsupported formats, image-only PDF files, unreadable text and invalid DOCX files fail explicitly. PDF extraction and OCR are outside this batch. Local authentication protects the endpoints, but there are no manager-specific roles, retention policy, backup, or SBS BEAMS connection in this prototype.

Validation: `node --test test/work-order-flow.test.js` and `npm run check`. The tests use real CSV and DOCX files containing synthetic bus IDs, exercise HTTP upload/review/session creation, restart recovery, version conflicts, duplicate uploads, source policy, unsupported files and the no-work-order path. They establish local workflow behavior, not field extraction accuracy on real operator documents.
