# SBS extraction evaluation

## Contract and boundary

This evaluation freezes the deterministic SBS Bus/Rail transcript extractor used by the P0 Capture flow. The extractor may map only explicitly stated technician text into schema-controlled facts. It must abstain when performed work, results, identity, approval, or completion are not stated. Scope isolation, negation, recommendations, completion confirmation, StructuredJobState mapping, and the report hard gates remain deterministic downstream authorities.

Case set: `sbs-extraction-eval.v1` in `test/fixtures/sbs-extraction-eval.v1.json`.

- Shipped English Bus and Rail demo statements.
- Existing Chinese Bus and Rail complete statements.
- Negated replacement, recommended replacement, and not-returned-to-service safety regressions.
- Expected fields, critical values, forbidden fields, intended Resolve queues, rationale, and provenance are frozen per case.

The pipeline uses scoped vocabulary v1 plus deterministic sentence rules. No model/provider, prompt, network call, token cost, or stochastic judge is involved.

## Baseline — `3ec3c8f`

| Metric | Result |
| --- | ---: |
| Expected field recall | 62.5% |
| False-missing fields | 18 |
| False-supported fields | 0 |
| Value errors | 2 |
| Bus demo Resolve items | 6 |
| Rail demo Resolve items | 7 |

The Bus demo missed direct inspection, performed-work, and test evidence. The Rail demo also missed the explicit train set, car, subsystem, TAMS approval, handback, and associated safety assertion. Existing Chinese cases missed inspection and performed-work facts, and duplicate generic work descriptions could become false conflicts.

## Candidate result

| Metric | Before | After |
| --- | ---: | ---: |
| Expected field recall | 62.5% | 100% |
| False-missing fields | 18 | 0 |
| False-supported fields | 0 | 0 |
| Value errors | 2 | 0 |
| Resolve-queue mismatches | not frozen | 0 |
| Bus demo Resolve items | 6 | 3 |
| Rail demo Resolve items | 7 | 2 |

The remaining Bus items are deliberate completion confirmation plus genuinely unstated safety/HV and compliance notes. The remaining Rail items are deliberate completion confirmation plus genuinely unstated reliability/compliance information. The extractor does not manufacture those fields to reduce the queue.

The candidate adds direct, sentence-preserving recognition for inspection findings, performed work, explicit testing, Rail TAMS approval, train/car/subsystem identity, and handback language. It also keeps generic fault description separate from inspection findings to avoid duplicate-value conflicts.

Negated and recommended replacement cases still produce no `work_performed` or `parts.replaced` fact. The out-of-service case remains `out_of_service`, not `completed`. Every extracted fact retains `DIRECT_TRANSCRIPT` support and its original transcript sentence as the value where free text is used.

## Decision and limitations

Decision: **promote** for P0 deterministic extraction. All frozen hard gates and field expectations pass with no false-supported regression.

Not verified here: production speech/ASR variability, unseen phrasing recall, stochastic model behavior (none is used), or broad real-world SBS vocabulary coverage. Those require a larger reviewed corpus and remain later evaluation work rather than grounds for weakening P0 evidence rules.

Run with:

```sh
npm run eval:sbs-extraction
node --test test/v2/extraction-eval.test.js
```
