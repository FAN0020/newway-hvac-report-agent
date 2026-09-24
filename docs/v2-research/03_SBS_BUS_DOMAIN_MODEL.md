# 03 — SBS Bus Domain Model (Phase C)

Phase C of `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` (§7). **Bus model, kept separate from the
Rail model (`04_SBS_RAIL_DOMAIN_MODEL.md`); the Rail model is not a clone of this document.**
Status: PROVISIONAL RESEARCH OUTPUT (not frozen).

Every workflow step and schema field is tagged:
- **CONFIRMED BY EVIDENCE** = at least one primary SBS/LTA/public source supports it;
- **PROVISIONAL** = plausible from sector evidence, not yet verified for SBS;
- **REQUIRES SBS CONFIRMATION** = SBS-internal detail not publicly verifiable, needed before
  production reliance.

Evidence levels per contract §6 (A/B/C/D) and the **NOT PUBLICLY VERIFIED** marker are used.
C/D evidence is never rewritten as an SBS fact.

---

## 0. Evidence base (abridged; full audit in `02_SBS_EVIDENCE_AUDIT.md` §B)

- SBS Transit Annual Reports 2022–2025, Operations Review (A)
- SBS Transit Green Efforts (A); Sustainability Report 2024 (A)
- SBS Transit Milestones (A); SBS newsroom + NextBus (A)
- LTA Bus Contracting Model (B); OneMotoring Inspection / Bus registration (B)
- SSO Bus Services Industry Act 2015 (B, TOC via archive)
- WSHC Vehicular Safety (B)
- Land Transport Guru fleet tables; Wikipedia MAN/Volvo/Scania/BYD/ADL (B/C, tertiary)
- Comparable: UK DVSA GtMR; US FMCSA 49 CFR 396/625; 14 CFR 43.9; SAE J1939; ISO 14224;
  EN 13306 (C)

---

## 1. Maintenance workflow (Bus)

### 1.1 Confirmed workflow skeleton (CONFIRMED BY EVIDENCE — A)

Evidence establishes these *stages exist* at SBS, in this broad order:

| # | Stage | Evidence | Tag |
| --- | --- | --- | --- |
| W1 | Scheduled/statutory service trigger (inspection cadence + package lease/depot calendar) | OneMotoring: omnibus 6-monthly inspection (B); LTA BCM packages with depot leases (A, AR2024) | CONFIRMED BY EVIDENCE |
| W2 | Daily pre-use / pre-trip inspection | SBS Sustainability Report 2024: "pre-use checklist" digitised (A); comparable: DVSA daily walkaround (C) | CONFIRMED BY EVIDENCE (existence); checklist contents NOT PUBLICLY VERIFIED |
| W3 | Defect/fault report → work request | SBS technician tablet work instructions (A); comparable: driver defect report → CMMS work order (C) | CONFIRMED BY EVIDENCE (existence); field format NOT PUBLICLY VERIFIED |
| W4 | Diagnosis (fault code / condition data) | Stratio 200+ parameters, brakes/fluid/electrics (A); J1939 SPN/FMI family (C) | CONFIRMED BY EVIDENCE (system exists); SBS fault-code catalogue NOT PUBLICLY VERIFIED |
| W5 | Work execution per work instructions + OEM e-manuals | SBS technician e-manual access (A) | CONFIRMED BY EVIDENCE |
| W6 | Parts replacement | SBS parts-information access (A); ISO 14224 maintenance-data model (C) | CONFIRMED BY EVIDENCE (parts used); part-number scheme NOT PUBLICLY VERIFIED |
| W7 | Testing / verification after work | Statutory inspection categories incl. brake efficiency + emissions (B); comparable: post-repair brake test (C) | PROVISIONAL (SBS internal post-repair test not public) |
| W8 | Completion / close-out / return-to-service | Comparable: CMMS close-out with reviewer gate (C); 14 CFR 43.9 sign-off (C) | PROVISIONAL; REQUIRES SBS CONFIRMATION |
| W9 | Depot/package compliance audit trail | BSIA Part 6 enforcement/monitoring (B, TOC); LTA maintenance standards met (A, AR2022) | CONFIRMED BY EVIDENCE (obligation exists); record schema NOT PUBLICLY VERIFIED |

### 1.2 Provisional refinement (PROVISIONAL / REQUIRES SBS CONFIRMATION)

- **Trigger classes** (PROVISIONAL, based on B + A): statutory periodic inspection (6-monthly
  omnibus, annual/6-monthly other buses, 3-monthly CNG — B); kilometre/day-based preventive
  service (interval values NOT PUBLICLY VERIFIED); condition-based alerts (Stratio — A);
  defect/breakdown reports; depot/package lease events (A).
- **States** (PROVISIONAL, mapped from comparable CMMS lifecycle C): open → assigned → in
  progress → on hold → completed → closed, with a reviewer/QA gate and hold reasons.
  REQUIRES SBS CONFIRMATION: actual SBS states, hold reasons, deferral/escalation rules.
- **Role separation** (CONFIRMED BY EVIDENCE that roles exist — A; duty text REQUIRES SBS
  CONFIRMATION): bus technician (work per work instructions), Diagnostic Expert (condition
  data), WSQ NESS-certified technician for HV/electric (A), supervisor/QA (PROVISIONAL).

---

## 2. Maintenance fact schema (Bus)

Tagged candidate fields. "Tag" column states the strongest evidence-supported status.

| Field | Description | Example / Unit | Tag |
| --- | --- | --- | --- |
| `asset.vehicle_id` | Vehicle identity | registration number, e.g. SG3050Z; internal fleet no. | CONFIRMED BY EVIDENCE (VRN — B); internal number REQUIRES SBS CONFIRMATION |
| `asset.bus_model` | Chassis/body model | MAN A95 (Euro VI); BYD K9; Scania K230UB; MB Citaro O530 | CONFIRMED BY EVIDENCE (fleet census B/C) |
| `asset.depot` | Depot performing/hosting work | Seletar, Ulu Pandan, Hougang, Bedok North, Sengkang West, etc. | CONFIRMED BY EVIDENCE (names — A); depot list NOT PUBLICLY VERIFIED as exhaustive |
| `asset.package` | LTA bus package (scope binding) | Jurong West, Seletar, Bukit Merah, etc. | CONFIRMED BY EVIDENCE (8 packages — A); package↔depot↔route map NOT PUBLICLY VERIFIED |
| `work.type` | Maintenance type | preventive / corrective / condition-based / statutory | CONFIRMED BY EVIDENCE (shift from preventive to condition-based — A) |
| `work.trigger` | What initiated work | pre-use checklist / periodic / condition alert / defect report | CONFIRMED BY EVIDENCE (existence of each); per-type cadence NOT PUBLICLY VERIFIED |
| `work.work_order_id` | Work-order identifier | — | REQUIRES SBS CONFIRMATION (format NOT PUBLICLY VERIFIED) |
| `work.fault_code` | Fault code | J1939 SPN/FMI family (C); Stratio parameter (A) | PROVISIONAL (family exists); SBS code catalogue REQUIRES SBS CONFIRMATION |
| `work.description` | Free text of task | — | CONFIRMED BY EVIDENCE (work instructions exist — A) |
| `diagnosis.root_cause` | Root cause | e.g. brake pad wear, fluid leak | PROVISIONAL (ISO 14224 model C) |
| `parts.part_number` | Replaced part + number | — | PROVISIONAL; part-number scheme REQUIRES SBS CONFIRMATION |
| `parts.replaced` | Whether a part was replaced | yes/no | CONFIRMED BY EVIDENCE (parts info access — A) |
| `measurement.*` | Numeric measurements | km, %, bar/kPa, mm, °C, MWh | CONFIRMED BY EVIDENCE (units used in SBS/LTA material — A/B); numeric thresholds NOT PUBLICLY VERIFIED |
| `test.result` | Post-work test outcome | brake efficiency, emissions | CONFIRMED BY EVIDENCE (statutory categories — B); pass thresholds NOT PUBLICLY VERIFIED |
| `completion.state` | Completion / return-to-service | completed / deferred / off-road | PROVISIONAL; REQUIRES SBS CONFIRMATION |
| `safety.*` | Safety-critical items | HV isolation, fire response, faulty safety devices | CONFIRMED BY EVIDENCE (NESS HV cert — A; WSHC vehicle factors — B); procedures NOT PUBLICLY VERIFIED |
| `provenance.*` | Source traceability | transcript, upload, knowledge | CONFIRMED BY EVIDENCE (V1 receipts — A baseline) |

### 2.2 Critical/safety fields (Bus)

- **HV/electric-bus safety** — REQUIRES SBS CONFIRMATION: HV isolation procedure state,
  battery/charging handling, NESS-certified performer (certificate level). NESS training
  exists (A); procedure text NOT PUBLICLY VERIFIED.
- **Brake/emission pass state** — PROVISIONAL: must not assert "roadworthy"/"passed" unless
  a test result supports it (statutory brake efficiency/emission checks — B).
- **Return-to-service** — PROVISIONAL/REQUIRES SBS CONFIRMATION: an "off-road → back in
  service" transition must be a technician-confirmed fact, never inferred from a manual.
- **Faulty safety devices / not-maintained-regularly** — B (WSHC vehicle risk factors):
  report must flag rather than mask these.

---

## 3. Candidate report schema (Bus)

### 3.1 Structure (PROVISIONAL; informed by statutory/contractual obligations — B + A)

| Report section (candidate) | Drives from | Evidence basis |
| --- | --- | --- |
| 1. Vehicle/asset identification (VRN, model, odometer, depot, package) | fact schema | OneMotoring registration (B); AR package/depot (A) |
| 2. Service/works summary (type, date, work-order, trigger) | fact schema | workflow (A/B) |
| 3. Inspection/fault findings (per-item condition, defects) | fact schema | OneMotoring checklist categories (B); DVSA per-item records (C) |
| 4. Work performed / diagnosis / root cause | fact schema | technician work instructions (A); ISO 14224 (C) |
| 5. Parts replaced (part number, qty) | fact schema | parts info (A); part-number scheme REQUIRES SBS CONFIRMATION |
| 6. Tests performed + results (brake, emissions, electrical) | fact schema | OneMotoring categories (B) |
| 7. Completion state / roadworthiness / return-to-service declaration | fact schema | statutory (B); 14 CFR 43.9 sign-off model (C) |
| 8. Safety/HV notes | fact schema | NESS (A); WSHC (B) |
| 9. Compliance/audit block (licence refs, inspection due date, package compliance) | fact + knowledge | BSIA (B, TOC); LTA maintenance standards (A) |
| 10. Provenance/traceability | receipts | V1 baseline (A) |

### 3.2 Report-type candidates (PROVISIONAL — REQUIRES SBS CONFIRMATION)

Daily/pre-use record; periodic inspection record; corrective work-order report; condition-based
service report; breakdown/incident report; statutory inspection certification support record.
SBS's actual report templates (paper/PDF/DMS) are NOT PUBLICLY VERIFIED.

---

## 4. Terminology / structured-knowledge candidates (Bus)

Evidence level in parentheses. Store as structured knowledge (contract §9) where stable:

| Candidate term list | Examples | Evidence |
| --- | --- | --- |
| Bus model ontology | MAN A95/A22/A24, Volvo B9TL, Scania K230UB, MB Citaro O530, BYD K9/K9RC/B12A03/BC12A04, Linkker LM312, Zhongtong N12, ADL Enviro500 MMC | B/C |
| Chassis/engine/gearbox attributes | D 2066 LUH-32/51, D9B-310, DC9, ZF EcoLife/Ecomat, Voith DIWA, Euro class | C |
| Registration ranges per model | BYD K9 SG3050Z–SG3069X; A95 SG5921Y–SG5998B; B9TL Wright ranges; etc. | B/C (tertiary) |
| Service/route identifiers | 5, 76, 135, 162M, 265, 807A, 851e, CDS 675 | A (NextBus) |
| Bus stop codes | 5-digit codes (e.g., 52039) | A |
| Inspection categories | structural, wheel, brake, steering, body, visual/indication, propulsion | B |
| Maintenance-type vocabulary | preventive / corrective / condition-based / statutory | A (SBS wording) |
| Units dictionary | km, %, bar, mm, °C, MWh, g/kWh | A/B |
| Fault-code family (if used) | SAE J1939 SPN/FMI (comparable) | C — NOT an SBS fact |
| Depot registry | Seletar, Ulu Pandan, Hougang, Bedok North, Sengkang West, + closed Soon Lee/Ang Mo Kio | A |

---

## 5. What remains NOT PUBLICLY VERIFIED for Bus

- Work-order / defect-log / service-record field formats and states
- Preventive-maintenance interval values (km/months) per model/depot
- SBS internal fault-code catalogue and parts catalog
- Technician role/shift/competency duty text
- Return-to-service criteria and deferral rules
- Numeric inspection thresholds (brake %, kPa, tyre mm)
- Current per-model in-service census and full depot registry
- Actual SBS report templates

These are compiled in `10_SBS_INFORMATION_GAPS.md` §Bus and drive the YELLOW/RED statuses in
`11_FREEZE_READINESS_REPORT.md`.

---

*End of 03_SBS_BUS_DOMAIN_MODEL.md*
