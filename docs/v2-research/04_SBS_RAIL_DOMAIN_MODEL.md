# 04 — SBS Rail Domain Model (Phase C)

Phase C of `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` (§7). **Rail model, kept separate from the
Bus model (`03_SBS_BUS_DOMAIN_MODEL.md`). The Rail model is NOT a clone of the Bus model:
rail has its own assets, workflows, reporting and regulatory regime (NRFF/RTSA), and its own
evidence base.**
Status: PROVISIONAL RESEARCH OUTPUT (not frozen).

Tagging: **CONFIRMED BY EVIDENCE** / **PROVISIONAL** / **REQUIRES SBS CONFIRMATION**.
Evidence levels A/B/C/D per contract §6; **NOT PUBLICLY VERIFIED** where applicable.

Key corrections captured from research (see `01_SBS_DOMAIN_DISCOVERY.md` §3 and
`02_SBS_EVIDENCE_AUDIT.md` §C): NEL is 1,500 V DC **overhead catenary** (not 750 V third
rail); DTL and SK/PG LRT are 750 V DC third rail; NEL depot is **Sengkang Depot** (Bishan
Depot is the SMRT NSL depot); DTL depots are Gali Batu + Tai Seng Facility Building (Kim
Chuan NOT publicly verified as a DTL depot); NEL signalling = Alstom Urbalis 300 CBTC,
DTL = Siemens Trainguard Sirius CBTC, SPLRT = Kyosan APM fixed-block (no Thales SelTrac
evidence on these lines).

---

## 0. Evidence base (abridged; full audit in `02_SBS_EVIDENCE_AUDIT.md` §C)

- SBS Transit AR2022–2025 Operations Review (A); SBS+IBM Maximo release (A); SBS Rail
  Engineering / Rail Operations e-brochures (A); SBS newsroom "Maintenance Works" (A)
- LTA NEL / DTL / SPLRT pages (B); LTA C851E release 27 Jul 2023 (B/A); LTA 2017 Factsheet
  "Technology for Depots and Trains" (B, archived); LTA Rail Service Reliability PDFs +
  Annex 2020–2025 (B); LTA New Rail Financing Framework (B); LTA DataMall (B)
- SSO RTSA 1995 + RTS Regulations RG1 + Creation of Rights N1 (B, TOC via archive)
- Wikipedia NEL/DTL/Sengkang LRT/Alstom Metropolis C751A/C751C/C851E/Bombardier Movia
  C951/Crystal Mover (B/C, tertiary)
- Comparable: RSSB GMRT2466; EN 15380; IEC 61375; UIC 438-3/EVN; ISO 55000; ISO 14224;
  HK MTR IMP review; Network Rail (C)

---

## 1. Maintenance workflow (Rail)

### 1.1 Confirmed workflow skeleton (CONFIRMED BY EVIDENCE — A)

| # | Stage | Evidence | Tag |
| --- | --- | --- | --- |
| R1 | Scheduled maintenance (day/km-based, per work instructions and procedures) | SBS Rail Engineering e-brochure: corrective + preventive "in accordance to work instructions and procedures" (A) | CONFIRMED BY EVIDENCE (existence); interval values NOT PUBLICLY VERIFIED |
| R2 | Condition-monitoring alerts (predictive) | NEL C751A refurb adds condition monitoring (A, LTA page + AR2024); C851E all six with condition monitoring (A, LTA release); DTL MEC monitors point machines & sump pumps (A, AR2025) | CONFIRMED BY EVIDENCE |
| R3 | Track inspection (automatic + manual) | Rail Rover / 2nd-gen Multi-Function Track Trolley: ultrasonic rail-defect detection, laser track geometry, third-rail alignment, tunnel structural health + seepage (A, AR2024); ATI on 4 DTL + 2 NEL trains (B/A); AVI wayside sensors (B, LTA 2017 factsheet) | CONFIRMED BY EVIDENCE |
| R4 | Defect/fault reporting + work request | MMMD Maintenance Management Mobile Device (B, LTA 2017 factsheet); gamified train-defect app (A, AR2025); AVATAR robot dog detects faulty lighting/open panels/surface damage (A) | CONFIRMED BY EVIDENCE (systems exist); record schema NOT PUBLICLY VERIFIED |
| R5 | Track access control | Track Access Management System (TAMS): automated request→approval (DTL live 2023, extending NEL/SPLRT/JRL) (A, AR2023/2024) | CONFIRMED BY EVIDENCE |
| R6 | Work execution (workshop or trackside) | Sengkang Depot workshop can raise an entire train (B/C); DTL MEC at Gali Batu (A); Siemens MCEM91 point-machine maintenance centre at NEL depot (A) | CONFIRMED BY EVIDENCE |
| R7 | Testing / verification | post-work checks (PROVISIONAL); statutory/regulatory verification of safety-critical assets (RTSA Part 4 — B, TOC) | PROVISIONAL |
| R8 | Completion / return-to-service | PROVISIONAL; REQUIRES SBS CONFIRMATION (return-to-service criteria NOT PUBLICLY VERIFIED) | PROVISIONAL |
| R9 | Regulatory reporting / audit trail | NRFF: internal audits, annual maintenance plans, fault-trend analyses (B, LTA NRFF); MKBF reporting (A/B); OPS compliance (B) | CONFIRMED BY EVIDENCE (obligation); submission formats NOT PUBLICLY VERIFIED |

### 1.2 Provisional refinement

- **Trigger classes** (PROVISIONAL): day/km-based scheduled service (values NOT PUBLICLY
  VERIFIED); condition-based alerts from on-board condition monitoring / MEC / ATI/AVI (A);
  fault/incident reports (A, e.g., Aug 2025 power fault); mid-life refurbishment projects
  (A, C751A all 25 by 2026); regulatory-mandated submissions (B).
- **Work locations** (CONFIRMED BY EVIDENCE — A/B): depots (Sengkang, Gali Batu, Tai Seng),
  trackside (via TAMS), OCC-coordinated night works (A, maintenance advisories).
- **State model** (PROVISIONAL, comparable CMMS lifecycle C): open → assigned → in progress →
  on hold → completed → closed with reviewer gate; REQUIRES SBS CONFIRMATION for rail
  specifics (e.g., TAMS approval state before trackside entry — A shows approval exists).
- **Role separation** (CONFIRMED BY EVIDENCE that roles exist — A; duty text REQUIRES SBS
  CONFIRMATION): Rail Technician (corrective+preventive per work instructions), Rail Engineer
  (fault analysis, technical investigations, compliance with operating standards/safety
  rules), Diagnostic Expert, Traffic Controller/OCC, Emergency Train Operator (per operations
  manual — A, e-brochures).

---

## 2. Maintenance fact schema (Rail)

| Field | Description | Example / Unit | Tag |
| --- | --- | --- | --- |
| `asset.line` | Line | NEL / DTL / SPLRT / (JRL future) | CONFIRMED BY EVIDENCE (A) |
| `asset.train_set` | Train set identifier | fleet numbers C751A 7001/7002–7049/7050; C751C 7051/7052–7085/7086; C951 9001–9092 | CONFIRMED BY EVIDENCE (numbering — B/C); official register REQUIRES SBS CONFIRMATION |
| `asset.car` | Individual car + type | 5-digit serial (7xxxx), carriage type DT/Mi/Mp | CONFIRMED BY EVIDENCE (scheme — B/C); official register NOT PUBLICLY VERIFIED |
| `asset.stock_class` | Rolling-stock class | Alstom Metropolis C751A/C751C/C851E; Bombardier/Alstom Movia C951/C951A; MHI Crystal Mover C810/C810A/C810D | CONFIRMED BY EVIDENCE (A/B) |
| `asset.subsystem` | Subsystem/component | traction (ONIX/OPTONIX/MITRAC), bogie (B25/FLEXX Metro 3100), brake, door, pantograph/collector shoe, point machine, track, third rail/OCS | CONFIRMED BY EVIDENCE (A/B/C) |
| `work.type` | Maintenance type | corrective / preventive / condition-based / mid-life refurbishment | CONFIRMED BY EVIDENCE (A) |
| `work.trigger` | Trigger | condition alert / scheduled / fault report / track-inspection finding | CONFIRMED BY EVIDENCE (existence); cadence NOT PUBLICLY VERIFIED |
| `work.order_id` | Work-order identifier | — | REQUIRES SBS CONFIRMATION |
| `work.fault_code` | Fault code / defect type | e.g., "faulty lighting, open panels, surface damage" (AVATAR examples — A); OEM families (ONIX/OPTONIX/MITRAC, C) | PROVISIONAL (families exist); SBS catalogue REQUIRES SBS CONFIRMATION |
| `diagnosis.root_cause` | Root cause | e.g., faulty voltage transformer + switchboard components (Aug 2025 — A) | CONFIRMED BY EVIDENCE (example exists — A) |
| `parts.part_number` | Replaced part | — | PROVISIONAL; REQUIRES SBS CONFIRMATION |
| `measurement.*` | Track/asset measurements | rail-defect depth, track geometry, third-rail alignment, wheel/brake wear (mm) | CONFIRMED BY EVIDENCE (capabilities — A); thresholds NOT PUBLICLY VERIFIED |
| `test.result` | Test outcome | ultrasonic/laser inspection results; post-repair verification | CONFIRMED BY EVIDENCE (capabilities — A); pass criteria NOT PUBLICLY VERIFIED |
| `access.approval` | TAMS track-access approval | request → approved (with lead time) | CONFIRMED BY EVIDENCE (A) |
| `completion.state` | Completion / return-to-service | completed / deferred / restricted-speed / train out of service | PROVISIONAL; REQUIRES SBS CONFIRMATION |
| `safety.*` | Safety-critical | RTSA Part 4 safety duties; OPS safety dimension; VAnGuard intrusion detection (29 LRT stations); evacuation exercises | CONFIRMED BY EVIDENCE (obligation/existence — A/B); procedure text NOT PUBLICLY VERIFIED |
| `reliability.*` | Reliability KPI context | MKBF train-km/car-km per line; >30-min delay counts | CONFIRMED BY EVIDENCE (A/B) |
| `provenance.*` | Source traceability | transcript, upload, knowledge | CONFIRMED BY EVIDENCE (V1 baseline) |

### 2.1 Critical/safety fields (Rail)

- **Return-to-service / restricted operation** — PROVISIONAL/REQUIRES SBS CONFIRMATION:
  a train returning to passenger service is a technician/operations-confirmed fact (per
  operations manual — A); never inferred from a manual.
- **Trackside work authorisation** — CONFIRMED BY EVIDENCE (TAMS approval — A): report must
  record authorised access before trackside work.
- **Signalling/safety-system status** — PROVISIONAL: CBTC/ATP/ATO/fixed-block subsystem
  faults (URBALIS/Trainguard Sirius/Kyosan — B/C) must be flagged, never silently normalised.
- **Power-system faults** — CONFIRMED BY EVIDENCE of severity (Aug 2025 substation fault —
  A): traction-power status is safety-critical.
- **Track-intrusion / VAnGuard** — A: intrusion events cut traction power; must be reported
  as events, not masked.

---

## 3. Candidate report schema (Rail)

### 3.1 Structure (PROVISIONAL; informed by A/B evidence)

| Report section (candidate) | Drives from | Evidence basis |
| --- | --- | --- |
| 1. Asset identification (line, train set, car, class, subsystem) | fact schema | A/B/C |
| 2. Works summary (type, date, work order, location: depot/trackside) | fact schema | A (work instructions; TAMS) |
| 3. Trigger/fault findings (condition alert, fault report, inspection finding) | fact schema | A (condition monitoring; AVATAR examples) |
| 4. Diagnosis / root cause | fact schema | A (Aug 2025 example) |
| 5. Work performed + parts | fact schema | A/B |
| 6. Tests performed + results (ultrasonic, laser geometry, electrical) | fact schema | A (Rail Rover; ATI/AVI) |
| 7. Track access record (TAMS approval, lead time) | fact schema | A |
| 8. Completion state / return-to-service | fact schema | PROVISIONAL |
| 9. Safety/OPS notes (incl. RTSA Part 4 context, VAnGuard, exercises) | fact + knowledge | A/B |
| 10. Reliability/compliance block (MKBF context, NRFF submissions, OPS) | fact + knowledge | A/B |
| 11. Provenance/traceability | receipts | V1 baseline |

### 3.2 Report-type candidates (PROVISIONAL — REQUIRES SBS CONFIRMATION)

Scheduled-service record; condition-based service record (condition monitoring / MEC);
track-inspection report (Rail Rover / ATI); corrective work-order report; incident/power-fault
report; mid-life-refurbishment progress record; regulatory submission support record
(NRFF annual maintenance plans / fault-trend analyses — B). Actual SBS templates NOT
PUBLICLY VERIFIED.

---

## 4. Terminology / structured-knowledge candidates (Rail)

| Candidate term list | Examples | Evidence |
| --- | --- | --- |
| Rolling-stock class ontology | C751A/C751C/C851E (Alstom), C951/C951A (Bombardier/Alstom), C810/C810A/C810D (MHI) | A/B/C |
| Subsystem/function taxonomy | traction, bogie, brake, door, pantograph/collector shoe, point machine, track, third rail/OCS, signalling | B/C (EN 15380 function groups as comparable; ISO 14224 taxonomy model) |
| Signalling glossary | CBTC, moving-block, fixed-block, ATP/ATO/ATS, CBI, GoA 4 (UTO), Urbalis 300, Trainguard Sirius, APM | B/C |
| Electrification per line | NEL 1,500 V DC OCS; DTL 750 V DC third rail; SPLRT 750 V DC third rail | A/B/C |
| Depot registry | Sengkang (NEL OCC, whole-train lift), Gali Batu (DTL MEC), Tai Seng (DTL facility) | A/B |
| Inspection technology glossary | Rail Rover, Multi-Function Track Trolley, ATI, AVI, IMDC, MMMD, condition monitoring | A/B |
| Reliability KPI dictionary | MKBF (train-km/car-km, delays >5 min), >30-min delay counts, per-line values 2022–2025 | A/B |
| Maintenance-type vocabulary | corrective / preventive / condition-based / mid-life refurbishment | A |
| Standards registry (comparable) | ISO 55001 (SBS-certified — A), ISO 14224, EN 15380, IEC 61375, UIC 438-3/EVN, RSSB GMRT2466 | C (+A for ISO 55001) |
| Station names/counts | 17 NEL / 35 DTL / 29 SPLRT stations | A |

---

## 5. What remains NOT PUBLICLY VERIFIED for Rail

- Internal maintenance schedules/intervals (day/km-based, overhaul cycles)
- Train-borne fault-code catalogue and work-order screen formats
- Wheel/brake wear thresholds (mm) and return-to-service criteria
- Depot machine inventory (wheel lathe, underfloor lift makes)
- Official train/car-set register; Kim Chuan as DTL depot; Tai Seng facility details
- RTSA provision-level duties and Railway Safety regulation text (SSO blocks direct fetch;
  TOC verified)
- NRFF maintenance-plan/fault-trend submission formats and penalty values
- LTA rail-reliability numeric thresholds beyond MKBF
- C851E/C951 contract codes and per-class fleet counts (tertiary only)

These are compiled in `10_SBS_INFORMATION_GAPS.md` §Rail and drive statuses in
`11_FREEZE_READINESS_REPORT.md`.

---

*End of 04_SBS_RAIL_DOMAIN_MODEL.md*
