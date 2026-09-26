# Authoritative Capture Backend

## Scope

This backend owns the report lifecycle from `CONTEXT` through `CAPTURE`, `PROCESSING`, optional `CORRECTION_IF_NEEDED`, and creation/resolution of structured field candidates in `RESOLVE`. It also owns scoped guidance ingestion and retrieval.

The visible browser now uses this chain for capture, extraction, field answers, confirmation events, and server-derived report facts. Final `ReportSnapshot` creation and the remaining `REVIEW -> READY -> CONFIRMED` cutover are still separate work. Compatibility report endpoints remain available for older tests/demos but are not authoritative substitutes for this session chain.

## Architecture

The implementation has four layers:

1. `src/server.js` exposes the authoritative HTTP boundary and rejects client attempts to manufacture evidence identity, provenance, field state, support state, confirmation, or reviewer identity.
2. `src/workflows/authoritative-capture.js` orchestrates exact report binding, persistence-first capture, transcription, correction review, and candidate extraction.
3. `src/storage/report-sessions.js` persists server-owned sessions, audit events, immutable evidence records, transcripts, reviews, evidence spans, candidates, text sources, and capture-idempotency indexes.
4. `src/domain/*` validates immutable contracts, legal phase transitions, revisions, exact transcript spans, and trusted persistence reloads.

The RAG integration and migration audit are documented in `docs/AUTHORITATIVE_RAG_GUIDANCE_INTEGRATION.md`.

The authoritative chain is:

```text
ReportSession
  -> AuditEvent[]
  -> Evidence[]
      -> TranscriptArtifact[]
          -> TranscriptReview[] (only when material review is required)
          -> EvidenceSpan[]
              -> FieldCandidate[]
  -> GuidanceUpload[] (session-bound reference corpus)
  -> GuidanceContext[] (never evidence)
```

Every downstream record is bound to the same server-owned session, exact template/version, context/version, and scope. Structured candidates point to exact spans in the immutable raw transcript.

## Lifecycle and audit semantics

The backend creates sessions in `CONTEXT` at revision 0. Each accepted transition increments the revision once and creates a server-issued audit event.

| Transition | Audit event | Meaning |
| --- | --- | --- |
| session creation | `SESSION_CREATED` | Server chose the session identity and exact report bindings. |
| `CONTEXT -> CAPTURE` | `EVIDENCE_CAPTURED` | Persisted evidence is attached to this report session. |
| `CAPTURE -> PROCESSING` | `PROCESSING_STARTED` | The server began transcript/candidate processing. |
| `PROCESSING -> CORRECTION_IF_NEEDED` | `TRANSCRIPT_REVIEW_REQUESTED` | Material terminology needs a technician decision. |
| `PROCESSING -> RESOLVE` | `STRUCTURED_CANDIDATES_CREATED` | Harmless transcript processing produced structured candidates. |
| `CORRECTION_IF_NEEDED -> RESOLVE` | `TRANSCRIPT_REVIEW_DECIDED` | The server recorded complete technician decisions and produced candidates. |
| same phase | `GUIDANCE_UPLOAD_INGESTED` | A server-scoped reference document was parsed and bound to this session. |
| same phase | `GUIDANCE_RETRIEVED` | Server-selected lexical retrieval and provenance were persisted as non-evidence guidance. |
| `RESOLVE` | `FIELD_CANDIDATE_RECORDED` | A technician field answer was persisted as evidence and a candidate. |
| `RESOLVE` | `TECHNICIAN_CONFIRMATION` | The server bound a technician principal to one existing candidate. |
| processing failure | `RECOVERABLE_ERROR_RECORDED` | Raw evidence remains durable and the failed phase is retained. |
| retry | `SESSION_RECOVERED` | The session returns only to its recorded failed phase. |

Optimistic concurrency is mandatory. Mutating requests provide `expected_revision`; stale requests fail with HTTP 409 and do not mutate the session.

## Report-aware binding

Session creation resolves an exact published predefined template. The service rejects an unknown template or a version other than the currently published version. The template determines the server-owned scope and context binding:

| Template scope | Context ID |
| --- | --- |
| `HVAC` | `HVAC` |
| `SBS_BUS` | `SBS/BUS` |
| `SBS_RAIL` | `SBS/RAIL` |
| `OILFIELD` | `OILFIELD` |
| `POWER_GRID` | `POWER/GRID` |

Evidence metadata, transcript metadata, session state, and extracted candidates retain that binding. A transcript or review from another session cannot be rebound through the API.

## Text capture

Technician text is normalized only by trimming surrounding whitespace, limited to 20,000 characters, hashed with SHA-256, and persisted as an immutable source before extraction. It receives a server-generated `Evidence` record and an immutable `TranscriptArtifact` with provider `technician-text` and model `manual-entry`.

Candidates produced from text use `MANUAL_TECHNICIAN_INPUT`. The client cannot submit candidate support status or field state.

## Audio capture and transcription

The audio endpoint accepts `audio/wav`. The `ArtifactStore` validates the WAV container, computes a SHA-256 source hash, and persists the bytes before the Whisper provider is invoked. Malformed WAV data is rejected before session mutation or evidence attachment.

The transcript artifact preserves:

- the source evidence ID and audio source hash;
- session, template/version, context/version, and scope bindings;
- provider, model, requested/detected language, and processing version;
- immutable raw text and its content hash;
- provider segment timestamps.

Candidates produced from audio use `TRANSCRIPT_EVIDENCE`.

If transcription fails, the server moves the session to `RECOVERABLE_ERROR`, retains the raw audio and evidence, stores no fake transcript, and returns `RETRY_TRANSCRIPTION`. Retrying uses the original evidence record and audio bytes. A successful retry produces one transcript and does not duplicate evidence.

## Idempotency

The source-bound processing identity hashes all of:

- source SHA-256;
- report-session ID;
- template ID and version;
- STT model;
- language option;
- processing version (`authoritative-capture.v1`).

Repeating a completed capture with the same identity returns the persisted chain without invoking Whisper again, creating another transcript, adding another candidate, or advancing the session revision.

An optional caller idempotency key is only an alias for that server-computed identity. Reusing the key with different audio bytes or any other identity component fails with `IDEMPOTENCY_KEY_REUSE`.

## Transcript correction

Correction is conditional. A harmless transcript skips `CORRECTION_IF_NEEDED`. Material domain terminology creates a pending immutable `TranscriptReview` containing exact source spans, suggested text where applicable, a reason, and a category.

The decision endpoint requires exactly one decision for every review item. It ignores client-authored correction text and uses the server-stored suggestion for an accepted correction. The reviewer principal is assigned by the server. Rejected or no-change decisions leave extraction based on raw text.

Accepted corrections never overwrite the raw transcript. For non-HVAC templates, the server builds a corrected processing projection, then maps every extracted fact back to the corresponding raw transcript span. HVAC passes accepted correction metadata through the existing HVAC extractor while retaining the raw transcript as evidence.

## HTTP API

### Create a session

`POST /api/report-sessions`

```json
{
  "template_id": "sbs-bus-maintenance",
  "template_version": "2.0.0",
  "job_context_ref": "job:123"
}
```

Returns HTTP 201 with the server-created session and `SESSION_CREATED` event.

### Read an authoritative chain

`GET /api/report-sessions/:sessionId`

Returns the session plus ordered audit events and every attached evidence, transcript, review, evidence span, and field candidate.

### Capture technician text

`POST /api/report-sessions/:sessionId/capture/text`

```json
{
  "expected_revision": 0,
  "text": "Rear door pressure is 5.2 bar.",
  "language": "en",
  "idempotency_key": "optional-client-key"
}
```

Returns HTTP 201 for newly processed input and HTTP 200 when the same persisted result is reused.

### Capture audio

`POST /api/report-sessions/:sessionId/capture/audio`

The body is raw WAV data. Headers:

- `Content-Type: audio/wav`
- `X-Expected-Revision: <revision>`
- `X-STT-Model: <model>` (optional; defaults to `base`)
- `X-STT-Language: <language>` (optional; defaults to `auto`)
- `Idempotency-Key: <key>` (optional)

Returns HTTP 201 for a new successful capture, HTTP 200 for a persisted reuse, or HTTP 202 with a retryable error after a transcription failure.

### Retry transcription

`POST /api/report-sessions/:sessionId/transcription/retry`

```json
{
  "expected_revision": 3,
  "evidence_id": "evidence_..."
}
```

The evidence ID selects already-bound server evidence; it does not create or rebind evidence.

### Decide a transcript review

`POST /api/report-sessions/:sessionId/transcript-reviews/:reviewId/decide`

```json
{
  "expected_revision": 2,
  "decisions": [
    { "review_item_id": "review_item_...", "decision": "ACCEPT" }
  ]
}
```

Allowed decisions are `ACCEPT`, `REJECT`, and `NO_CHANGE`.

## Persistence

The default runtime root is `data/report-session-authority`:

```text
sessions/                         trusted-hash-wrapped ReportSession records
audit-events/                     immutable AuditEvent records
records/evidence/                 immutable Evidence records
records/transcripts/              immutable TranscriptArtifact records
records/transcript-reviews/       immutable pending/reviewed decision history
records/evidence-spans/           immutable exact source spans
records/field-candidates/         immutable structured candidates
text-sources/                     immutable technician-text source bodies
capture-index/by-identity/        source-bound processing state
capture-index/by-custom-key/      caller-key to source-identity bindings
capture-index/by-evidence/        evidence to capture identity bindings
```

Audio remains in the existing content-addressed artifact store. Session writes use temporary-file replacement. Immutable records use exclusive creation and collision checks. Reload validates the session against an out-of-band trusted hash.

The current file-backed implementation serializes writes within one Node.js process. It does not implement a distributed lock or cross-process database transaction; a multi-process deployment must replace this store with transactional persistence while retaining the same contracts.

## Trust boundary

The HTTP layer rejects client fields that claim server authority, including session/revision identity, evidence/transcript identity, provenance, evidence references, field state, support state, confirmation, confirmation receipts, reviewer principal, and corrected text. The session ID is taken from the route, and review IDs are verified against the session's persisted attachments.

The server, not the browser, creates:

- ReportSession IDs and revisions;
- Evidence, transcript, review, span, candidate, and audit IDs;
- report/context bindings;
- support types and candidate assessments;
- recovery state and next actions;
- technician-review principal and accepted corrected text.

## Test matrix

| # | Required behavior | Coverage |
| --- | --- | --- |
| 1 | Text evidence persistence | workflow + HTTP |
| 2 | Audio persistence before STT | workflow + HTTP |
| 3 | Whisper invocation and transcript persistence | workflow + HTTP with injected provider |
| 4 | Exact session/template/context binding | workflow + HTTP |
| 5 | Provider timestamps retained | workflow + HTTP |
| 6 | Same-source capture is idempotent | workflow + HTTP |
| 7 | STT failure preserves audio/evidence | workflow + HTTP |
| 8 | Retry succeeds without duplicate evidence | workflow + HTTP |
| 9 | Same caller key cannot bind different audio | workflow + HTTP |
| 10 | Cross-session transcript/review rebinding rejected | service + HTTP |
| 11 | Template-version mismatch rejected | HTTP |
| 12 | Stale revision rejected | store + HTTP |
| 13 | Duplicate request creates no duplicate artifacts | workflow + HTTP |
| 14 | Fabricated evidence identity rejected | HTTP |
| 15 | Fabricated provenance rejected | HTTP |
| 16 | Client-authored technician confirmation rejected | HTTP |
| 17 | Malformed audio causes no session corruption | workflow + HTTP |
| 18 | Session chain survives process/store restart | store + HTTP |
| 19 | Harmless transcript skips correction | workflow |
| 20 | Critical terminology requires correction | workflow |
| 21 | Rejected correction preserves raw transcript | workflow |
| 22 | Accepted correction preserves raw evidence and decision history | workflow |

The tests use a deterministic injected transcription provider to verify provider invocation, timestamp handling, failure, retry, and idempotency. A separate `npm run stt:smoke` check verifies the prepared, checksum-pinned local `whisper.cpp` binary and multilingual Base model against the repository's official sample. That smoke check verifies runtime integration, not domain transcription quality.

## Verification evidence

- `npm run check`: syntax checks passed and all 377 repository tests passed; the scoped-RAG subsets are recorded in `docs/AUTHORITATIVE_RAG_GUIDANCE_INTEGRATION.md`.
- `npm run stt:smoke`: the checksum-verified `whisper.cpp` b4938 runtime and Base model reported ready and transcribed the official English sample successfully.
- `git diff --check`: no whitespace errors.

## Current cutover status

The visible browser now routes text/audio capture, transcript review, technician field answers, candidate confirmation, guidance upload/viewing, and server-derived report drafting through the authoritative ReportSession endpoints. The scoped deterministic RAG integration and its trust boundary are documented in `docs/AUTHORITATIVE_RAG_GUIDANCE_INTEGRATION.md`.

Remaining cutover work is narrower:

1. Implement final `ReportSnapshot` creation and the `RESOLVE -> REVIEW -> READY -> CONFIRMED` lifecycle against an exact session revision.
2. Decide how custom manager-published templates provide server-side extraction adapters; predefined catalog templates are currently authoritative.
3. Extend the lifecycle explicitly before allowing multiple independent primary captures in one session.
4. Replace the demo technician principal with authenticated server identity.
5. Move file persistence to transactional storage before multi-process deployment.
6. Measure domain transcription quality separately from backend correctness.

OCR, embeddings/vector search, semantic retrieval, generative report prose, automatic diagnosis, predictive maintenance, and a RAG-card UI remain intentionally out of scope.
