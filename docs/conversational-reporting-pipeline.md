# Conversational technician reporting

## Reproduced failure

Report 7's original transcript explicitly said “bus 204,” “at Changi Airport,” “I am Alex,” a driver complaint about vibration, a retest, that vibration was gone, and that the bus was returned to service. The persisted extraction artifact contained only four fields: work order, inspection finding, work performed, and no outstanding issues. Its `model` was `null` and `model_contributed` was `false`. The old deterministic parser required narrow wording for several identities and places, merged repair and retest into one action, and had no test-observation role. Field validation could only see the few candidates that extraction produced. Retrieval ran later and was not the cause of the omissions.

## Capture path

The server keeps raw transcripts immutable. Normalized text is segmented into source-offset assertions. Deterministic rules propose high-certainty facts; span coverage records unresolved or partial assertions. A configured semantic provider receives only unresolved windows, neighboring assertions, and established facts. It returns canonical proposals without template field IDs. The server verifies exact quotes, values, actor, polarity, temporal meaning, and semantic type before routing. Verified facts and rejected proposals are persisted in a versioned semantic trace, while the template maps accepted facts into report candidates. Critical confirmation remains a separate report policy.

The real transcript now yields separate asset, location, technician, complaint, finding, repair, retest, observation, explicit-none, and return-to-service facts. The loose bracket remains a finding, not an asserted root cause. “This morning” is retained as a daypart reference; a Date / Time field needing minute precision remains unresolved until the technician supplies an exact time.

The provider interface accepts either `generateJson` or `extractSemanticProposals`, so local Ollama, a cloud adapter, and a mock provider share the same verifier. Without an available model, deterministic facts remain usable and the trace records the unprocessed windows. An unavailable provider cannot silently turn guesses into fields.

## Developer inspection and replay

`GET /api/report-sessions/{session_id}/semantic-trace` returns the latest persisted trace for a session, the associated raw and normalized transcript with corrections, and the current report state and clarification queue. The trace includes pipeline versions, exact assertion spans and coverage, deterministic and semantic proposals, verification rejections, canonical facts, complaint-to-observation relationships, field assignments, conflicts, and missing-information reasons. The response labels the current report state with its session revision because later manual edits may follow the traced capture. The capture response also includes the trace. `AuthoritativeCaptureService.replaySemanticTrace` reprocesses a stored immutable transcript without changing report state and compares facts, rejections, field assignments, and missing information with the stored derivation. `POST /api/report-sessions/{session_id}/transcripts/{transcript_id}/semantic-replay` with `expected_revision` applies a new derivation to a report in Resolve, superseding the prior transcript-derived candidates while retaining audit history and technician-entered candidates. Repeating the same pipeline version is idempotent.

The old Report 7 session is not rewritten by the code update. It contains later technician-entered fleet values, so replacing its current state automatically would hide a real conflict. New captures use the new pipeline; stored transcripts can be replayed and applied explicitly. A replay that adds bus 204 will preserve the technician-entered values as a conflict requiring resolution.

## Verification

Run `npm run eval:conversational-reporting` for the frozen real transcript and paraphrase corpus. It checks normalization, assertion boundaries, fact precision and recall, source spans, actor and temporality, routing, unsupported fills, and clarification count against the saved baseline. Run `npm run check` for the full repository gate. The test suite includes provider failure, unsupported model claims, replay, retry idempotency, conflicts, schema-specific test semantics, and the HTTP trace route.
