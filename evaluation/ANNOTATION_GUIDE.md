# Synthetic audio annotation guide

The 15 cases in `synthetic-cases.v1.json` are **SYNTHETIC seed data**. They contain invented asset IDs, measurements and maintenance utterances. They are not real SBS, HVAC, oilfield or grid observations. The existing `test/fixtures/sbs-extraction-eval.v1.json` remains a separate deterministic extraction regression fixture. This batch does not run transcription, retrieval, extraction or end-to-end evaluation.

## Roles and states

- `seed`: the authored standard text and proposed facts/relevance from the manifest. It is a hypothesis for evaluation design, not Gold.
- `human_review_status`: `unreviewed` → `in_review` → `reviewed` or `rejected`. Only a human reviewer can change it after listening to the generated audio without using the seed transcript as a substitute.
- `frozen_gold`: stays `false` until an independent reviewer resolves uncertain spans, checks all identifiers/numbers/negations against audio, adjudicates relevant knowledge IDs, and records approval plus annotation checksum. `reviewed` alone does not imply `frozen_gold`.

Use a copy of `ground-truth.blank.v1.json` per case. Do not overwrite the blank template. Store annotations outside the seed manifest. Include the generated WAV SHA-256 from `metadata.json`, manifest SHA-256, reviewer ID and timestamp. If a voice pronounces an ID ambiguously, note the uncertainty and keep the audio transcript separate from the intended standard text. Reject a case if it cannot support an unambiguous label. 琼文 or another designated independent reviewer must personally adjudicate before Gold freeze; automatic copying from seed cannot satisfy this step.

## Labeling rules

1. Transcribe what is heard. Record a normalized form separately; never silently repair a spoken number, model, unit or action.
2. Extract only utterance-supported facts. Keep observed action, recommendation, suspected condition, and explicit non-action distinct. Record missing fields as missing, not inferred from manuals.
3. For retrieval, judge relevance against the scope registry and versioned knowledge records. `expected_retrieval_ids` is a proposed must-find subset, while `relevant_retrieval_ids` is a proposed relevant set; neither is an observed retrieval result or a frozen relevance judgment. Check for cross-scope leakage separately.
4. A report point is a desired claim or warning only if it traces to the spoken facts. No implied pass/fail, replacement, return to service or regulatory compliance.
5. If the seed and audio differ, retain the audio observation and record the disagreement. Update the case by versioning the manifest, then regenerate audio and invalidate earlier annotations.

Freeze only after a second pass over the audio, an explicit scope/ID check, reviewer signoff, and a stable annotation hash. Report performance on frozen cases separately from seed-only dry runs.
