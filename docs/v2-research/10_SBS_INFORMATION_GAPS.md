# 10 — SBS Information Gaps

Status: RESEARCH OUTPUT (not frozen)
Governing contract: `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` (esp. §5–§7, §16, §17).
Purpose: an explicit, consolidated register of everything that could not be publicly
verified for SBS Transit Bus/Rail. Every item is marked **NOT PUBLICLY VERIFIED** (contract
§6). Nothing here is assumed; these gaps drive the YELLOW/RED statuses in
`11_FREEZE_READINESS_REPORT.md` and the "MINIMUM INFORMATION REQUIRED FROM SBS" request at
the end of that report.

---

## 1. Bus gaps

| # | Gap | Why it matters (affected design item) | Best public signal found |
| --- | --- | --- | --- |
| B1 | Internal work-order / defect-log / service-record field formats | Bus fact schema + workflow states | Tablet work instructions exist (A); schema not public |
| B2 | Fault-code catalogue (SBS conventions + OEM diagnostic codes) | Bus fact schema (fault_code field) | Stratio 200+ parameters (A); J1939 SPN/FMI family (C, comparable) |
| B3 | Preventive-maintenance interval schedules (km/months per model/depot) | Bus workflow triggers | 6-monthly statutory inspection (B); "shift from preventive to condition-based" (A) |
| B4 | Return-to-service / defect-deferral / escalation states | Bus completion states | Comparable CMMS lifecycle (C); 14 CFR 43.9 sign-off (C) |
| B5 | Parts catalogue & part-number conventions | Bus parts facts | Parts info access via tablets (A) |
| B6 | Numeric thresholds: brake efficiency %, kPa, tyre tread mm, emissions values | Bus measurements + test results | OneMotoring checklist categories (B); thresholds not given |
| B7 | Technician role duties, shift patterns, competency ladder text | Bus roles | WSQ NESS counts (A); Diagnostic Expert scheme (A); JobStreet ads JS-rendered |
| B8 | Current per-model in-service census + full depot registry + package↔depot↔route map | Bus asset ontology | AR fleet totals (A); LTG census (B/C, tertiary) |
| B9 | Bus-side CMMS/work-order system name (Maximo is a rail partnership) | System integration | none public |
| B10 | Actual bus report templates (paper/PDF/DMS formats) | Bus report schema | none public |

## 2. Rail gaps

| # | Gap | Why it matters (affected design item) | Best public signal found |
| --- | --- | --- | --- |
| R1 | Internal maintenance schedules/intervals (day/km-based, overhaul cycles) | Rail workflow triggers | corrective+preventive per work instructions (A); interval values not public |
| R2 | Train-borne fault-code taxonomy + work-order screen formats | Rail fact schema | AVATAR defect examples (faulty lighting/open panels/surface damage — A); OEM families (C) |
| R3 | Wheel/brake wear thresholds (mm) and pass criteria | Rail measurements + test results | RSSB GMRT2466 (C, comparable); KLD wheel-profile params (C) |
| R4 | Return-to-service criteria (train → passenger service) | Rail completion states | operations manual (A, referenced); criteria not public |
| R5 | Official train/car-set register (fleet numbers, car serials, carriage types) | Rail asset identity | numbering schemes from Wikipedia (B/C); official register not public |
| R6 | Depot machine inventory (wheel lathe, underfloor lifts) and per-depot scope | Rail asset ontology | Sengkang whole-train lift (B/C); Gali Batu MEC (A) |
| R7 | RTSA provision-level duties (Part 4 safety; licensing) + any Railway Safety regulations text | Rail regulatory reporting | TOC verified (B); provision text blocked (SSO 403) |
| R8 | NRFF maintenance-plan/fault-trend submission formats + penalty values | Rail regulatory reporting | NRFF page (B); exact formats/penalties not public |
| R9 | LTA rail-reliability framework numeric thresholds beyond MKBF | KPI validation | MKBF definition + values (A/B) |
| R10 | C851E/C951 contract codes, per-class fleet counts (tertiary only) | Rail asset ontology | Wikipedia (B/C) |
| R11 | Kim Chuan as DTL depot; Tai Seng Facility Building details | Rail depot registry | DTL page lists Gali Batu/Tai Seng/East Coast (B); Kim Chuan not confirmed |
| R12 | Actual rail report templates | Rail report schema | none public |

## 3. Cross-cutting / regulatory gaps

| # | Gap | Why it matters | Best public signal found |
| --- | --- | --- | --- |
| X1 | RTA/BSIA provision-level text (inspection, accident reporting, depot-licence conditions) | Bus regulatory reporting | TOCs verified (B); section text not retrieved |
| X2 | BCM contract schedules (maintenance standard values; penalty mechanics; QoS enforcement) | Bus compliance + evals | QoS ≥96% scheduled mileage; <0.50 accidents/100k bus-km (B) |
| X3 | LTA Code of Practice for bus maintenance / bus-depot safety (may not exist publicly) | Bus compliance | none found |
| X4 | Station-code dictionary (NE1-style), bus-stop-code registry, DataMall dataset schemas | Identifiers | 5-digit bus-stop codes observed (A); schemas not public |
| X5 | LTA/SBS incident-reporting formats to LTA (bus + rail) | Regulatory reporting | SBS "Maintenance Works" advisories (A); taskforce reports (B) |
| X6 | Whether SBS would authorize user uploads of manuals/historical reports into the agent | User-upload scope (contract §10) | none public — product/partnership question |
| X7 | SBS report templates used today | Report schema | none public |

## 4. What this means

- **NOT PUBLICLY VERIFIED** items are never rewritten as SBS facts in this research package
  (contract §6, §16).
- The gaps are grouped into two classes in `11_FREEZE_READINESS_REPORT.md`:
  (a) **material for freeze** (YELLOW → SBS confirmation before production reliance);
  (b) **design-affecting unknowns** (RED → cannot freeze until resolved or explicitly
  de-scoped).
- The smallest set of real SBS artifacts that would resolve the majority of gaps is listed
  as **MINIMUM INFORMATION REQUIRED FROM SBS** in `11_FREEZE_READINESS_REPORT.md` §7.

---

*End of 10_SBS_INFORMATION_GAPS.md*
