# Batch 1 source provenance

Date: 2026-09-18

## Decision

The sibling `local_dictator-main` project was used only as a read-only technical reference in this batch. Its project-level license and Git origin could not be confirmed by Batch 0, so no file was copied verbatim and the source project was not modified. This repository contains a smaller, independently written implementation for the HVAC workflow.

## Necessary reference files read

- `web/microphone.js`: reference behavior for permission timeout and stopping a stream that arrives after timeout.
- `web/pcm-worklet.js`: reference behavior for buffered Float32 capture and explicit final flush acknowledgement.
- `web/pcm-worklet-client.js`: reference behavior for waiting for the final audio samples.
- `src/providers/stt.js`: reference interface and failure cases for a spawned `whisper.cpp` CLI.
- `src/providers/whisper-models.js`: reference Base model filename and published SHA-256.
- `src/providers/llm.js`: reference shape for loopback Ollama chat calls, timeout, `think:false`, and JSON handling.
- `scripts/prepare-stt-runtime.js`: reference pinned `whisper.cpp` version and build prerequisites.
- `package.json` and `runtime/stt/README.md`: reference runtime expectations only.

## Independently implemented here

- `web/audio-recorder.js` and `web/pcm-capture-worklet.js` use HVAC-neutral names, downmix to mono, resample to 16 kHz, encode 16-bit PCM WAV, and include their own lifecycle implementation.
- `src/providers/whisper.js` is a smaller provider with project-contained temporary output, explicit health errors, bounded process output, timeout/cancellation, and test injection.
- `src/providers/ollama.js` rejects non-loopback URLs and exposes a small JSON-only API.
- `src/tools/normalize-hvac-transcript.js` implements the HVAC contract: the LLM can only select approved candidate IDs; critical corrections require technician confirmation; raw text is never replaced.
- Storage, HTTP endpoints, UI, WAV validation, tests, and documentation were written for this MVP.

## Third-party runtime

The optional preparation script downloads/builds `whisper.cpp` `b4938` and preserves its upstream license in the runtime directory. The script and model download were not executed in Batch 1. The Base model hash is pinned to `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`.

Ollama itself and any selected Ollama model remain separately installed software. The model license must be checked before distribution.
