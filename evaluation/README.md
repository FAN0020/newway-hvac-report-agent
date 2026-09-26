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

# Batch 2 component evaluation (provisional)

`component-fixtures.v1.json` is a committed, machine-readable **SYNTHETIC seed** contract. It is not human reviewed or frozen Gold. `component-metrics.js`, `component-adapters.js`, and `scripts/evaluate-components.js` keep each component independent: ASR reads generated WAV, correction reads fixed noisy text, facts read the manifest reference text, and missing-field checks read fixed fact objects. A failed or inaccurate component never feeds another component.

```sh
npm run eval:components:dry-run
npm run eval:audio:generate
npm run eval:components
npm run eval:components -- --component facts --case SBS-BUS-MISSING-003
```

The full run writes `.tmp/evaluation-runs/component-results.json` and `.tmp/evaluation-runs/component-results.md`; `.tmp/` is Git ignored. The JSON contract is specified in `component-contract.v1.json` and emitted as `component-evaluation.v1` with one `component-result.v1` per case/component. Every result carries `RUN`, `NOT_RUN`, `NOT_SUPPORTED`, or `ERROR`, plus scope, scenario, input, expectation, prediction, deterministic metrics, and a separate `hard_gate_failures` list. The run records manifest and fixture SHA-256 checksums and refuses ASR scoring against stale or modified audio. The output status stays `PROVISIONAL_SYNTHETIC_SEED` until a distinct human reviewed, frozen Gold set exists.

**Metric units and limits:** WER uses lowercase NFKC word tokens; CER removes spaces and compares Unicode characters. Term and number/unit scores are exact normalized phrase hits; equipment IDs also ignore punctuation and spacing against the seed lists, so spoken forms, aliases, and unit conversions can register as misses. Correction checks exact expected text and critical phrase preservation for term, number/unit, ID, negation, and action; the fixture runner simulates acceptance of the module's suggestions for comparison. It does not auto-accept corrections in the product. Fact micro/macro P/R/F1 currently score **unique field presence per case**, not fact values or sentence-level semantic equivalence. This intentionally limited proxy is insufficient to claim full fact accuracy. Missing-field P/R/F1 compares exact required field/section IDs. The Markdown reports each scope separately and lists every seed critical-check miss or unsupported action; no aggregate score suppresses it. `hard_gate_failures` are evaluation assertions, not the product report hard-gate output.

The current fixed correction fixture covers one confusable-term example each for HVAC, SBS Bus, and SBS Rail. Oilfield and Power Grid have no product correction module and are `NOT_SUPPORTED`; cases without fixed noisy text are `NOT_RUN`. Missing-field fixtures cover one case per scope; other cases are `NOT_RUN`. No local or external LLM is used. HVAC fact extraction uses its deterministic fallback, whose English coverage is limited. The V2 fact adapter invokes `extractV2Facts`; the missing-field adapter invokes V1 `validateReportInput` or V2 `planV2Report`. No RAG, report generation, DeepEval, UI, or end-to-end workflow is evaluated here.
