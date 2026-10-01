# Batch 4: local vehicle history and structured export

The history key is the reviewed stable `vehicle_id` in `ReportSession.job_context_binding` (Batch 2). Confirmation copies that server-owned binding into the immutable `ReportSnapshot`. The history service reads confirmed snapshots and creates one immutable `VehicleHistoryLink` per snapshot. The link retains the work-order reference and version, source and review hashes, report ID/version, confirmation reference/time, technician principal, and snapshot hash. A snapshot with no reviewed binding is marked `PENDING_VERIFICATION` in its structured export and is absent from vehicle history. Registration number, bus model, and free text are never used as merge keys.

- `GET /api/vehicles/{vehicle_id}/reports` returns confirmed reports for that exact stable ID, ordered by confirmation time.
- `GET /api/report-sessions/{session_id}/structured-export` returns JSON derived from the immutable confirmation snapshot. It includes the full report and field states, source snapshot ID/hash, and reviewed vehicle/work-order binding when available.

A report field that disagrees with the reviewed vehicle ID blocks the link instead of merging it into another vehicle. A missing or altered snapshot/link fails closed. These APIs remain within ServiceScribe's local store. They do not connect to SBS systems or imply a retention period, backups, or production access controls.

Integration point: Batch 2 must preserve `job_context_binding` through ReportSession transitions. `createReportSnapshot` copies it at confirmation. Existing reports created without this binding remain pending; they are not retrospectively assigned to a vehicle from text. Work-order reference/version come from the reviewed binding, while the report's own work-order field stays in the report only. No report is copied or rewritten to form history.
