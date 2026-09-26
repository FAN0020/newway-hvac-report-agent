# Batch 1 synthetic audio cases

This folder contains 15 versioned **SYNTHETIC** seed cases, three in each of HVAC, SBS Bus, SBS Rail, Oilfield and Power Grid. Each scope has a normal case, a confusable-term case, and a negation/missing-information case. The data is invented and does not establish operational facts or model accuracy. Knowledge IDs refer to the existing scope registry and versioned local knowledge records. The cases were designed against `docs/v2-research/07_V2_EVAL_SPEC_DRAFT.md`; the spec remains draft.

## Local commands

```sh
npm run eval:audio:validate
npm run eval:audio:dry-run
npm run eval:audio:generate -- --case HVAC-NORMAL-001 --case SBS-BUS-MISSING-003
npm run eval:audio:generate -- --output /absolute/path/to/ignored-audio
```

The generator uses only local macOS `say`, `ffmpeg` and `ffprobe`. It checks the manifest before any synthesis, verifies installed voices/tools, and writes 16 kHz mono PCM signed 16-bit WAV files for Whisper. `clean`, `mild_bandlimit`, and `telephone` are deterministic filter profiles; they do not simulate field recording conditions. The default output is `.tmp/synthetic-audio/`, which Git ignores. `metadata.json` records the manifest checksum, per-WAV checksum, voice, rate, profile and duration. Synthesis may differ across macOS voice versions, so compare file checksums rather than assuming bitwise identity across machines. Rerunning overwrites selected WAV files and the metadata for that run; use a fresh output directory for a complete batch. Do not commit generated audio.

`--validate` and `--dry-run` require no audio tools and make no files. This batch has no external TTS/LLM calls and no end-to-end test. See `ANNOTATION_GUIDE.md` and `ground-truth.blank.v1.json` before treating any seed as a human reviewed Gold label.
