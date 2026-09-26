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

# Batch 3: isolated RAG, report, and semantic evaluation

Batch 3 reads the same `synthetic-cases.v1.json` as Batch 2 and the committed `batch3-fixtures.v1.json`. The labels remain **PROVISIONAL_SYNTHETIC_SEED**. The 15 RAG queries are fixed in that fixture; the relevant IDs come from the manifest. Queries run through the product `createRetriever` with the scope registry, local versioned corpus, `topK=3`, and uploads disabled. Each run records the registry and every corpus-file SHA-256, query, ranked result text and stable `chunk_id`/provenance. The current corpus is a versioned local snapshot at evaluation time, not a frozen human Gold corpus. `CROSS_DOMAIN_BLOCKED` warnings are expected when the registry skips forbidden files; a returned forbidden scope or non-knowledge hit is a hard-gate failure.

RAG metric definitions: Hit@3 is 1 if any of the manifest's `relevant_retrieval_ids` occurs in the first three hits; Recall@3 is relevant IDs found divided by the number of relevant IDs; Precision@3 is relevant IDs found divided by **3** even when fewer hits are returned; MRR@3 is reciprocal rank of the first relevant hit, or 0. These are macro-averaged per scope over `RUN` cases. IDs are exact provenance keys, not semantic guesses. The relevance labels are synthetic seeds and may omit other useful records. The separate `hard_gate_failures` list checks scope leakage and cross-domain hits; `UNSUPPORTED_SERVICE_FACT_PROMOTION` is a report-output gate, because retrieval itself does not claim an action occurred.

The report runner generates five independent fixed-fact drafts, one normal case per scope. The other ten cases say `NOT_RUN: NO_FIXED_REPORT_SEED_FACTS`. Each draft uses committed seed facts and committed, fixed knowledge IDs, resolved to a source checksum; it never consumes ASR, correction, fact extraction, or live RAG output. HVAC uses `planReportSections`, `retrieveReportTemplate`, and `generateReportDraft` with no provider. The four V2 scopes use their existing scope-specific report builders, `planV2Report`, and `checkHardGates`. The fixed knowledge context is recorded for traceability but is **not** passed as a service-fact source. Unknown scopes produce `NOT_SUPPORTED`; fixture or builder errors produce `ERROR`.

Report metrics distinguish structural required-section completeness from **populated** required sections. Fact-value coverage is the share of supported seed fact values present in rendered claim/content text; this exact string metric may miss a correct paraphrase. Unsupported claim count is the number of rendered lines or claims without a trace to a supplied fact. Traceability is the share of rendered non-placeholder lines/claims with that trace. `missing_required_sections` and populated-section score preserve absent facts and approvals. These checks do not establish full narrative correctness. Existing hard gates assess V2 fact safety, and a separate report gate flags action wording without a grounded service-action fact. HVAC's V1 claim fact IDs are checked against the fixed facts. A 100% fact-value score on deterministic builder output is a contract check, not field accuracy.

```sh
npm run eval:batch3
npm run eval:batch3 -- --component rag --case SBS-BUS-MISSING-003
.venv/bin/python -m pip install -r evaluation/requirements-deepeval.txt
npm run eval:deepeval:adapter
npm run eval:deepeval:smoke
npm run eval:summary
```

`eval:summary` requires both Batch 2 and Batch 3 results from the same manifest. To regenerate all deterministic component results, run `npm run eval:components`, then `npm run eval:batch3`, then `npm run eval:summary`. This is a command sequence for separate components, **not** an end-to-end pipeline. The outputs are `.tmp/evaluation-runs/{component-results,batch3-results,deepeval-results,summary}.{json,md}`; `.tmp/`, `.venv/`, and caches are ignored by Git.

`deepeval_adapter.py` converts `Case + synthetic seed expectation + Prediction` to `LLMTestCase` for correction, RAG and report. DeepEval 4.2.3 is pinned; it calls only `http://127.0.0.1:11434` through a custom `DeepEvalBaseLLM` using `qwen3.5:9b`, with telemetry opt-out. `--adapter-only` checks conversion and marks every semantic metric `NOT_RUN`; `--smoke` judges one report faithfulness case and marks all other semantic metrics `NOT_RUN: SMOKE_SELECTION`. A full run without either flag may take substantial local model time. The semantic metrics are correction semantic preservation; contextual relevancy, precision and recall; report faithfulness to **seed facts** and a report semantic rubric. Faithfulness uses facts as retrieval context because knowledge records cannot establish occurred service facts. DeepEval does not replace WER, exact term/ID/number/unit checks, fact-field F1, exact Hit@3, missing-set scores, scope isolation, or safety gates. A local judge score is provisional model judgment, not a human frozen Gold result.
