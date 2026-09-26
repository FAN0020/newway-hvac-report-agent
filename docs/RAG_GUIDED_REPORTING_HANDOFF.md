# RAG-guided reporting handoff

## What this branch adds

- Scope-gated retrieval remains isolated across HVAC, SBS Bus and SBS Rail.
- Retrieval now ranks by query-term coverage, document density and exact-phrase bonus.
- Fact extraction automatically runs a scoped Top-3 retrieval for the same statement.
- Extracted facts are editable and can be explicitly confirmed by the technician.
- Missing required report modules become domain-specific follow-up questions.
- Follow-up answers enter the report only as `CONFIRMED_BY_TECHNICIAN` facts.
- RAG results never create service actions, test outcomes, completion states or safety facts.
- Real Whisper transcripts are copied directly into the active SBS Bus/Rail facts input.
- Rail ASR corrections are shown as reviewable suggestions and require an explicit technician selection before they change the working transcript.
- Future/planned action wording such as `I will replace` raises a critical clarification and is never converted to completed work automatically.

## Real voice regression: RAIL-VOICE-001

The first iPhone recording produced two domain-critical ASR errors: `C751A` became `Z751A`, and `door control module faulty` became `door control model 40`. The first-round repair now proposes both corrections for technician confirmation.

After both suggestions are explicitly accepted, the same transcript extracts six facts instead of two, including:

- `asset.stock_class = Alstom Metropolis C751A`;
- `work.description = ...door control module faulty`;
- `parts.part_number = door control module`;
- `parts.replaced = true`.

The corrected Top-3 retrieval ranks Rail door knowledge first and Rail asset numbering second. Use the same audio again for the second-round test; the expected visible behavior is: transcript auto-routed to V2 → two unchecked suggestions → explicit technician acceptance → six extracted facts.

## Run

```powershell
npm install
npm start
```

Open `http://127.0.0.1:4310`, select **SBS / Bus** or **SBS / Rail**, and use the Facts & report panel.

## Rail demo input

> Corrective maintenance on train set C751A. Reported a door fault on car three. Inspection found the train door worn. Replaced the train door. Test passed. Returned to service.

Expected flow:

1. Eight deterministic facts are extracted.
2. Up to three scoped knowledge results are retrieved automatically.
3. The first report draft shows missing Rail modules.
4. The UI asks for trigger/finding, work performed, track access, safety/OPS and reliability/compliance details.
5. Applying answers rebuilds the report with technician-confirmed facts.

## Bus demo input

> Preventive maintenance on bus MAN A95, registration SBS6025Z. The front door would not close. Inspection found the door control module faulty. Replaced the door control module. Door opening and closing test passed. Completion state completed.

## Tester checklist

- Confirm retrieval returns only the selected scope.
- Confirm Top K defaults to 3 after automatic retrieval.
- Edit one extracted value and verify its status changes to `MANUAL_ENTRY`.
- Press **Confirm** and verify it changes to `CONFIRMED_BY_TECHNICIAN`.
- Build an incomplete report and verify concrete follow-up questions appear.
- Apply answers and verify the corresponding report modules are populated.
- Verify no retrieved knowledge sentence becomes a performed action or test result.
- Verify missing information remains `Not provided / pending confirmation`.

## Evaluation-ready outputs

Each retrieval result exposes:

- scope and source type;
- document and chunk identifier;
- score;
- matched query terms;
- provenance metadata.

These fields support Hit@3, Recall@3 and source-isolation evaluation without changing the report-generation contract.
