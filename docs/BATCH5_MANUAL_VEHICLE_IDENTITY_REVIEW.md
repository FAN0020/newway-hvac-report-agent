# Batch 5: vehicle identity review for reports without work orders

After a report started with `new-report:*` reaches `CONFIRMED`, open **Reports → Review vehicle identity and history**. Select the report, inspect its confirmed fields, check its stable vehicle ID against an independent source, describe that source, and attest to the check. The page then links the report to vehicle history and can query all confirmed reports for that exact ID.

API equivalent (authenticated):

```http
POST /api/report-sessions/{session_id}/vehicle-identity-review
Content-Type: application/json

{"vehicle_id":"BUS-101","review_note":"Fleet register record BUS-101 checked","attested":true}
```

Read `GET /api/vehicles/{vehicle_id}/reports` or `GET /api/report-sessions/{session_id}/structured-export`. The first returns only links whose snapshot and identity review still validate; the second reports `VERIFIED` only after a link exists.

The review is a separate immutable `VehicleIdentityReview` record keyed by snapshot ID. The immutable `VehicleHistoryLink` references its hash. Neither operation edits the confirmed `ReportSnapshot`. A retry with the same vehicle ID returns the existing link; a different ID, a mismatch with a known report vehicle ID, a malformed ID, or a changed persisted review fails closed. Reports bound to a reviewed work order continue to use their existing history path.

The review note records what the operator says they checked; this local demo cannot verify an external fleet register or establish a real person's identity. Operator roles, retention, backup and external fleet systems remain deployment decisions.
