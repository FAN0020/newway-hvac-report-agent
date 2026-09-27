# Newway Systems HVAC Report Agent MVP (V1 + V2 SBS scopes)

This repository is a local-first hackathon MVP with an explicit, token-protected LAN demo mode. The current vertical slice provides:

1. record from the browser microphone or upload a WAV file;
2. always produce/validate mono 16-bit PCM WAV;
3. save the audio locally by content hash;
4. transcribe with a managed local `whisper.cpp` provider;
5. preserve every raw transcript as an immutable artifact;
6. an explicit manual-transcript fallback labelled `provider: manual` when Whisper is unavailable;
7. retrieve correction candidates only from the server's versioned HVAC vocabulary; the browser cannot submit its own candidates or corrected text;
8. show immutable raw text beside the proposed text, require the technician to accept/reject every change, and separately confirm critical values, negation, measurements, model numbers, refrigerant, completion state, and prices;
9. persist an integrity-checked correction receipt bound to the transcript, knowledge version, candidate-set hash, final-text hash, decisions, technician, and time; even unchanged text requires an original-text confirmation receipt;
10. extract source-bound service facts only from a verified correction receipt, persist a facts receipt bound to it, and ask at most three missing-information questions;
11. plan fixed/conditional report sections, retrieve the versioned template, and generate a draft without adding service facts;
12. run the independent Validator and show claims, sources, missing fields, and validation details;
13. bind technician confirmation to the exact report hash, facts/correction receipts, report version, Validator run, technician, and time;
14. reject unconfirmed or changed reports, then idempotently save confirmed JSON and export copyable text under `data/reports/`.
15. keep `npm start` on loopback by default, while `npm run demo` fails closed unless a strong temporary token protects every API request.

## Run

Requires Node.js 20 or newer. There are no npm runtime dependencies.

```sh
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm run check
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm start
```

Open <http://127.0.0.1:4310>. Do not change the bind address by editing source code; use the audited `npm run demo` entry point below when another device needs access.

### Interface language

The toolbar language selector switches the complete application interface between English (the default) and Simplified Chinese. The selection is stored in this browser's `localStorage` under `newway_ui_locale`, persists across reloads, and updates the document language for assistive technology. Changing the interface language does not reset entered form data or the current workflow state.

Interface localization is deliberately separate from business content. Technician statements, retrieved source text, template/report content, company and product names, hashes, receipt IDs, and other technical identifiers are never translated implicitly. In this MVP, report output stays in the language supplied by its template or source; the report preview makes that boundary explicit.

Developers can change project terminology or any interface label without modifying the localization runtime. Use [the i18n developer guide](docs/I18N_DEVELOPER_GUIDE.md) and place project-specific wording in `web/locales/overrides.js`; it is deep-merged over the base English and Chinese catalogs automatically.

`npm start` is the safe local default. It binds only to `127.0.0.1`; the page obtains an in-memory token through a bootstrap endpoint that accepts only a true loopback connection. Every `/api/*` request still carries `Authorization: Bearer ...`.

For the lowest-risk rehearsal, use this local-only command and keep every browser on the demo Mac:

```sh
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm start
```

If voice capture or transcription is unavailable, switch to **手动输入原文** and use the synthetic narration in [the demo card](docs/DEMO_CARD.md). This fallback remains subject to the same correction review, Validator, technician confirmation, save, and export gates.

### Trusted-LAN demo

`npm run demo` binds to `0.0.0.0`, but refuses to start unless `HVAC_DEMO_TOKEN` is at least 16 non-whitespace characters and includes a letter plus a number or symbol. In zsh, enter a fresh temporary token without putting it in shell history:

```sh
read -s "HVAC_DEMO_TOKEN?Temporary demo token (16+ characters): "
echo
export HVAC_DEMO_TOKEN
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm run demo
```

On another device connected to the same trusted Wi-Fi, open `http://<this-computer-LAN-IP>:4310` and enter that token. It exists only in the current shell/server process and the browser tab session; the app does not print it, put it in a URL, store it in `localStorage`, or write it to a report. After the demo, press `Ctrl-C` and run `unset HVAC_DEMO_TOKEN`.

Do not expose this server to the public internet. It is plain HTTP with a temporary shared token, not production identity, TLS, rate limiting, or a hardened deployment. If a custom local hostname is needed, add its exact value through `HVAC_ALLOWED_HOSTS`; private LAN IP addresses are accepted automatically.

Phone and other-device browsers normally block microphone access on plain LAN HTTP. For tomorrow's reliable demo, record in the host browser at `http://127.0.0.1:4310` while other devices watch, or use manual text on the other device. Mobile/remote microphone capture has not been validated.

The shortest presenter checklist is [docs/DEMO_CARD.md](docs/DEMO_CARD.md). The longer setup and troubleshooting guide is [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md).

For a no-provider demo, paste a synthetic HVAC service narration into **手动输入原文**. Select **检查术语修复候选**, compare raw/proposed text, decide every candidate, confirm any critical value, and enter the reviewing technician. The app then issues the correction receipt and generates the report workflow. Answer or explicitly leave the limited follow-up questions unprovided, inspect the Validator result, confirm the current report version, then save JSON or export text.

## Local providers

- **Speech-to-Text Model** in Settings is the authoritative local Whisper selection. It applies to the next microphone or uploaded-audio job; a running job keeps the model captured when it started. The server persists the selection in the gitignored `data/settings/speech-to-text.json`; old installs with no setting continue to use **Base**.
- Supported multilingual models are **Tiny** (~74 MiB), **Base** (~141 MiB, default), **Small** (~465 MiB), **Medium** (~1.43 GiB), **Large v3** (~2.88 GiB), and **Large v3 Turbo** (~1.51 GiB). Larger models generally trade more memory, storage, and time for better transcription quality. The exact pinned filenames, byte sizes, SHA-256 digests, download revisions, descriptions, and `whisper.cpp` compatibility live in the single registry at `src/providers/whisper-models.js`.
- Settings distinguishes installed, not installed, installing, and unavailable/error models. Selecting a missing model requires installation first. Downloads use a unique partial file, require available disk space, validate exact byte size and SHA-256 before atomic activation, suppress concurrent duplicate downloads, and never replace a valid installed model.
- Models are stored under `runtime/stt/<platform>-<arch>/models/`. Install from Settings or run `npm run stt:install -- medium` (replace `medium` with a registry ID). Existing verified models are not downloaded again.
- Whisper health is available at `GET /api/health`. It verifies the prepared binary and selected model; a clean checkout deliberately reports `STT_RUNTIME_MISSING`, a missing selected model reports `STT_MODEL_MISSING`, and a corrupt model reports an integrity error without falling back to another model.
- `npm run stt:prepare` is an explicit, networked macOS setup step. It downloads the official portable CMake 3.31.10 archive and verifies Kitware's published SHA-256, builds pinned `whisper.cpp` `b4938`, and strictly verifies the multilingual Base model before atomically installing it under `runtime/stt/<platform>-<arch>`. CMake, source, downloads, build scratch, binary, and model all remain inside this repository.
- Run `npm run stt:smoke` after preparation. It extracts the pinned official `jfk.wav` sample into project-local temporary storage, sends it through the same `WhisperProvider` used by the app, checks the transcription, and cleans the sample/output afterward.
- Run `npm run stt:benchmark` to transcribe that same checksum-pinned WAV with every installed registry model. The JSON result records model, audio duration, transcription duration, real-time factor, success/failure, and the actual transcript. Missing models are reported as failures rather than simulated. Use `npm run stt:benchmark -- --audio=/absolute/path/to/mono-16-bit.wav` for another reproducible fixture.
- To add another model compatible with the pinned runtime, add one registry definition with a stable ID, human label, `ggml` filename, pinned Hugging Face revision URL, exact bytes/SHA-256, resource positioning, and `b4938` compatibility. Provisioning, Settings, persistence, serialized inference, benchmarking, and the authoritative transcript pipeline then consume the registry without model-specific branches.
- On the prepared Apple Silicon demo machine, the real Provider smoke test returned the expected English sentence in about one second. This proves the local CLI/JSON Provider path works; it does **not** establish Chinese HVAC, accent, noise, browser microphone, or field accuracy.
- Ollama must already be running on `http://127.0.0.1:11434`. Set `HVAC_OLLAMA_MODEL` on the server to the model used for normalization/fact/draft assistance. The browser cannot select an Ollama model. No model is downloaded by this app.
- Whisper inference is single-slot per server process. Automatic transcription does not fan out retries or run multiple model processes in parallel; the existing explicit one-retry recovery remains bound to the original audio evidence and original model.

## API summary

All `/api/*` routes, including `/api/health`, require the session bearer token. Browser requests with an `Origin` must be exactly same-origin with the validated `Host`; public/malformed hosts and cross-site requests are rejected, and no permissive CORS headers are returned. Origin-less command-line requests still need the bearer token.

- `GET /api/settings/speech-to-text`: returns the persisted active model and sanitized lifecycle state for every registry model.
- `POST /api/settings/speech-to-text` with `{"model":"small"}`: selects an already installed and verified model.
- `POST /api/speech-to-text/models/<id>/install`: installs and verifies one missing/corrupt registry model.
- `POST /api/audio` with `Content-Type: audio/wav`: validates and stores audio.
- `POST /api/transcriptions`: creates or retrieves an immutable raw transcript using an idempotency key. A caller may explicitly make one retry as attempt 2.
- `POST /api/normalizations`: accepts only a transcript artifact ID. The server loads versioned HVAC correction rules, builds a bounded candidate set, optionally asks its configured Ollama model to recommend candidate IDs, and deterministically falls back when model output is invalid or unavailable. It never overwrites raw text.
- `POST /api/corrections/confirm`: accepts the transcript ID, server candidate-bundle hash, per-candidate `ACCEPT`/`REJECT` decisions, critical-review flags, and technician identity. It recomputes the candidate set and writes an immutable `hvac-correction-receipt.v1`. Client-supplied corrected text/candidate objects are rejected.
- `POST /api/transcripts/manual`: saves an immutable manual `TranscriptArtifact`; it never claims to be ASR output.
- `POST /api/facts/extract`: accepts only `correction_receipt_id` plus explicit technician-entered follow-up fields and an optional LLM-use flag. It reloads and verifies the transcript, knowledge version, candidate-set hash, decisions, and final-text hash before returning a server-side `facts_receipt_id` bound to that correction receipt.
- `POST /api/reports/validate-input`, `/api/reports/plan`, and `/api/reports/generate`: load facts by `facts_receipt_id`; client-declared fact arrays are not trusted. Generation projects receipt facts through the built-in `hvac_service` StructuredJobState adapter first.
- `POST /api/reports/validate-draft`: reloads the same server-side facts receipt, validates the exact draft plus schema/session/state bindings, and records a validation receipt bound to both evidence and report hashes.
- `POST /api/reports/confirm`: issues a token bound to the current report hash/version, Validator run, facts/correction receipts, schema/session/state identity, technician, and timestamp.
- `POST /api/reports/save`: writes the confirmed report as JSON; rejects missing or stale tokens.
- `POST /api/reports/export`: writes and returns copyable text; rejects missing or stale tokens.

## V2: knowledge scopes, user uploads, and SBS Bus/Rail reports

V2 adds three isolated knowledge scopes on top of the unchanged V1 HVAC flow. The browser picks a scope (`HVAC` keeps the original panel; `SBS·Bus` / `SBS·Rail` show the V2 panel). V2 ships without a new eval suite and without new npm dependencies.

Scope isolation is a hard gate: `SBS/BUS` and `SBS/RAIL` queries can never return `HVAC` content (or each other's), and user uploads are bound to their upload scope (`USER_UPLOADED:<scope>`). A blocked cross-domain source yields zero results plus a `CROSS_DOMAIN_BLOCKED` warning.

- `data/knowledge/v2/` — versioned structured knowledge (scope registry + SBS Bus/Rail terms, parts, assets, units, report modules). Every record carries `evidence_level` (A/B/C/D), `confidence`, and `not_publicly_verified` markers for anything that must not be asserted as an SBS fact.
- `src/v2/` — scope registry & isolation, upload ingestion (UPLOADED→…→READY/FAILED, provenance + scenario metadata), scope-gated retrieval, SBS fact schemas, and the Bus (11 sections) / Rail (12 sections) report builder with deterministic hard gates.
- `POST /api/v2/scopes` — lists the three leaf scopes and context ids.
- `POST /api/v2/uploads` — raw-byte document upload (txt/csv/md native; docx via system `unzip`; pdf via system `pdftotext`, otherwise `FAILED` with `PDF_TEXT_LAYER_REQUIRED`). Bound to the upload scope; `HVAC` uploads are rejected.
- `GET /api/v2/uploads?scope_id=` — lists uploads for a scope.
- `POST /api/v2/retrieve` — scope-gated retrieval over knowledge + uploads.
- `POST /api/v2/facts/extract` — deterministic SBS fact extraction from technician text (`provider: manual`, critical fields flagged).
- `POST /api/v2/reports/build` — maps facts into the selected Bus/Rail StructuredJobState, projects only supported state into the existing builder, then runs schema validation, `assertNoServiceFactInvention`, and `checkHardGates`. A gate violation returns `NEEDS_CONFIRMATION` and the browser blocks confirmation (e.g. a manual's "replace ZX-47" recommendation is never rendered as an occurred action).
- `data/v2-uploads/` — upload store (runtime data, gitignored).

The V2 panel includes two presenter tools for SBS audiences in both supported interface languages:

- **▶ Play demo** — one-click simulated recording: the browser speaks the technician's statement (TTS) with word-by-word captions, shows the terminology fixes for mis-heard words (`A ninety five`→`A95`, `door control modular`→`door control module`), then runs the real fact extraction and report build end to end. Bus and Rail each have their own scripted scenario.
- **Guided walkthrough** — a step-by-step, user-driven tour of the product flow: choose scope → upload a sample service document → scope-gated search → enter the on-site statement → extract facts → build the report. Each step highlights the control to operate and auto-advances once the step's effect is detected; switching scope restarts it, and it is exclusive with the demo player.

Design and acceptance origins: `docs/v2-research/` (03/04 domain models, 05 facts, 06 report schema, 08 critical-error taxonomy, 09 scope/upload contract).

## Data and Git boundary

Runtime audio, transcripts, correction receipts, facts receipts, validation receipts, confirmation records, official reports, persisted local settings, project-local CMake/source archives, Whisper binaries/models, caches, briefing-render scratch files, and temporary test output are excluded from Git. The repository includes only `.gitkeep` placeholders for runtime data directories. The normal automated suite uses synthetic text and direct function calls; `npm run stt:smoke` and `npm run stt:benchmark` are separate opt-in real Whisper checks. Neither normal automated path invokes real Ollama or listens on a port.
