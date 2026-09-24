# Newway Systems HVAC Report Agent MVP

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

## Local RAG knowledge layer

The report workflow now retrieves relevant excerpts from the versioned field-service corpus before report planning. Retrieval is local and deterministic: English terms plus Chinese character and bigram tokens are scored across bounded document chunks. Every result carries a stable `chunk_id`, document ID, source name, source hash, and score.

RAG evidence is deliberately **reference-only**. It may help select fields and tell the technician what to verify, but it is never promoted into a completed service fact. Report claims still require transcript spans or manual technician input, and the UI displays the retrieved citations separately from the report facts.

The included index contains five initial sources across HVAC, power/energy, and petrochemical maintenance. To rebuild an index from UTF-8 `.txt` sources:

```bash
npm run rag:build -- path/to/manifest.json data/knowledge/field-service-rag.v1.json
```

The manifest format is:

```json
{
  "knowledge_version": "2026-09-24",
  "max_chunk_chars": 900,
  "sources": [{
    "document_id": "stable-document-id",
    "domain": "power_energy",
    "title": "Document title",
    "path": "relative/source.txt",
    "source": "Original filename.docx",
    "tags": ["inspection"],
    "report_sections": ["inspection_findings", "test_results"]
  }]
}
```

`POST /api/rag/retrieve` accepts a free-text query or a server-side `facts_receipt_id`, optional `domains`/`document_ids`, and `top_k` from 1 to 8. `/api/reports/plan` also performs retrieval automatically from the verified facts receipt and carries citations into the draft's `knowledge_context`.

## Run

Requires Node.js 20 or newer. There are no npm runtime dependencies.

```sh
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm run check
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm start
```

Open <http://127.0.0.1:4310>. Do not change the bind address by editing source code; use the audited `npm run demo` entry point below when another device needs access.

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

- Whisper health is available at `GET /api/health`. It verifies the prepared binary and model against the project-local manifest SHA-256 values; a clean checkout deliberately reports `STT_RUNTIME_MISSING`.
- `npm run stt:prepare` is an explicit, networked macOS setup step. It downloads the official portable CMake 3.31.10 archive and verifies Kitware's published SHA-256, builds pinned `whisper.cpp` `b4938`, and strictly verifies the multilingual Base model before atomically installing it under `runtime/stt/<platform>-<arch>`. CMake, source, downloads, build scratch, binary, and model all remain inside this repository.
- Run `npm run stt:smoke` after preparation. It extracts the pinned official `jfk.wav` sample into project-local temporary storage, sends it through the same `WhisperProvider` used by the app, checks the transcription, and cleans the sample/output afterward.
- On the prepared Apple Silicon demo machine, the real Provider smoke test returned the expected English sentence in about one second. This proves the local CLI/JSON Provider path works; it does **not** establish Chinese HVAC, accent, noise, browser microphone, or field accuracy.
- Ollama must already be running on `http://127.0.0.1:11434`. Set `HVAC_OLLAMA_MODEL` on the server to the model used for normalization/fact/draft assistance. The browser cannot select an Ollama model. No model is downloaded by this app.
- The browser's Base/Tiny/Small selector is only the Whisper STT model selector. It is never forwarded as the Ollama model.

## API summary

All `/api/*` routes, including `/api/health`, require the session bearer token. Browser requests with an `Origin` must be exactly same-origin with the validated `Host`; public/malformed hosts and cross-site requests are rejected, and no permissive CORS headers are returned. Origin-less command-line requests still need the bearer token.

- `POST /api/audio` with `Content-Type: audio/wav`: validates and stores audio.
- `POST /api/transcriptions`: creates or retrieves an immutable raw transcript using an idempotency key. A caller may explicitly make one retry as attempt 2.
- `POST /api/normalizations`: accepts only a transcript artifact ID. The server loads versioned HVAC correction rules, builds a bounded candidate set, optionally asks its configured Ollama model to recommend candidate IDs, and deterministically falls back when model output is invalid or unavailable. It never overwrites raw text.
- `POST /api/corrections/confirm`: accepts the transcript ID, server candidate-bundle hash, per-candidate `ACCEPT`/`REJECT` decisions, critical-review flags, and technician identity. It recomputes the candidate set and writes an immutable `hvac-correction-receipt.v1`. Client-supplied corrected text/candidate objects are rejected.
- `POST /api/transcripts/manual`: saves an immutable manual `TranscriptArtifact`; it never claims to be ASR output.
- `POST /api/facts/extract`: accepts only `correction_receipt_id` plus explicit technician-entered follow-up fields and an optional LLM-use flag. It reloads and verifies the transcript, knowledge version, candidate-set hash, decisions, and final-text hash before returning a server-side `facts_receipt_id` bound to that correction receipt.
- `POST /api/reports/validate-input`, `/api/reports/plan`, and `/api/reports/generate`: load facts by `facts_receipt_id`; client-declared fact arrays are not trusted.
- `POST /api/reports/validate-draft`: reloads the same server-side facts receipt, validates the exact draft, and records a validation receipt bound to both hashes.
- `POST /api/reports/confirm`: issues a token bound to the current report hash/version, Validator run, technician, and timestamp.
- `POST /api/reports/save`: writes the confirmed report as JSON; rejects missing or stale tokens.
- `POST /api/reports/export`: writes and returns copyable text; rejects missing or stale tokens.

## Data and Git boundary

Runtime audio, transcripts, correction receipts, facts receipts, validation receipts, confirmation records, official reports, project-local CMake/source archives, Whisper binaries/models, caches, briefing-render scratch files, and temporary test output are excluded from Git. The repository includes only `.gitkeep` placeholders for runtime data directories. The normal automated suite uses synthetic text and direct function calls; `npm run stt:smoke` is a separate opt-in real Whisper check. Neither path invokes real Ollama or listens on a port.
