# Batch 3 technician flow acceptance

Baseline: `haoqi@d81557c`. This batch works on the server-owned ReportSession and published TemplateField rules.

## Repeatable checks

```sh
npm run accept:batch3
npm run check
```

The targeted acceptance runs the HTTP 20/8/6/2 case, source-plan API rules, technician view projection, and UI route/control checks. It uses synthetic data and a stub model. The 20-field case verifies that eight manager-required technician fields start unresolved, six are extracted from one text capture, the remaining two are named in the server resolution queue, and two answers close those gaps in the same session without changing the raw transcript.

For an installed local Ollama `qwen3.5:9b` model:

```sh
npm run accept:batch3:model
```

This sends only synthetic field metadata and a boolean reviewed-work-order signal. It prints the actual model status and per-field source decision. The model can choose only eligible sources. A reviewed work-order source is eligible only when a selected authoritative candidate exists in the session. `KNOWLEDGE` is eligible only for a manager-reviewed `NORMATIVE_REFERENCE` field and available retrievable guidance in the bound scope. All other fields default to `JOB_FACT`.

## Browser path

Start `HVAC_HOST=127.0.0.1 HVAC_PORT=4177 HVAC_OLLAMA_MODEL=qwen3.5:9b node src/server.js`. Open `http://127.0.0.1:4177`, select a published report, and inspect the full field checklist before input. Submit a synthetic technician statement. After processing, the active task shows each missing required technician field and its server-owned question. Select an Answer action, provide a value, and verify that the count falls and the accepted source is visible. Reload and reopen the report to verify persistence. Check a narrow viewport and browser errors.

## Authority and knowledge boundary

The source plan is advice, not a field value or a change to `required`. The UI distinguishes model source suggestions, rule fallback, accepted evidence, and the extraction model outcome. It does not treat the model as permission to add a source outside `allowedSources`.

The current knowledge path provides template-bound retrieval guidance and questions. A `KNOWLEDGE` source-plan choice for a normative field tells the technician where to consult a reference. It does not fetch and auto-fill a cited normative value into that field. Knowledge text also cannot establish this job's actions, parts, measurements, tests, safety, or completion. A future cited normative auto-fill would need its own candidate and citation contract plus manager review; that is outside this batch.

The current authoritative retrieval path supports registered scope knowledge and session guidance uploads. A custom template's manager-uploaded context documents are preserved with the published template, but this path does not yet retrieve them into ReportSession guidance. The source planner therefore does not mark custom template knowledge as eligible merely because a file was uploaded.

## Observed local run (2026-10-01)

`npm run check` passed 733 tests. `npm run accept:batch3:model` called the installed Ollama `qwen3.5:9b` and returned `MODEL_SUGGESTED`: reviewed work order for the order ID, technician for the job action, and knowledge for the normative reference. In the browser, the synthetic 20-field template showed `0 / 8`, then a single statement yielded `6 / 8` with exactly Golf and Hotel missing; answering them changed the view to `7 / 8` and `8 / 8 Ready`. Reloading and reopening retained `8 / 8` and the original typed statement. The same browser session's extraction model ran but its two proposals were rejected; the six accepted fields came from deterministic evidence extraction. This synthetic run validates the local workflow, not real SBS field accuracy.
