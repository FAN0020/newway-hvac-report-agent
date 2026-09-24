# 01 — SBS Domain Discovery (Bus & Rail)

Phase A of `docs/PRE_FREEZE_RESEARCH_CONTRACT.md`.
Status: RESEARCH OUTPUT (not frozen). Bus/Rail subdivision is provisional per contract §1
and may be refined only when evidence justifies it.

---

## 0. Method and evidence legend

- Research performed 2026-09 against public web sources via direct retrieval of primary pages
  and documents. The web-search endpoint was unavailable in the research environment; all
  findings below come from pages/documents actually fetched and read.
- Evidence levels per contract §6: **A** = SBS-specific evidence; **B** = Singapore
  transport-sector evidence; **C** = comparable-industry evidence; **D** = inference/assumption.
- Items that could not be publicly verified carry the marker **NOT PUBLICLY VERIFIED** and
  are collected in `02_SBS_EVIDENCE_AUDIT.md` §B and `10_SBS_INFORMATION_GAPS.md`.
- Nothing below asserts an internal SBS practice unless a primary SBS source says so. Where
  evidence only shows that a document/system *exists* (not its contents), that limitation is
  stated.

Primary sources used in this document:
- SBS Transit Milestones (https://www.sbstransit.com.sg/milestones) — A
- SBS Transit Annual Report 2024 — Operations Review PDF (https://www.sbstransit.com.sg/annual-report-2024, `Operations Review.pdf`) — A
- SBS Transit Green Efforts (https://www.sbstransit.com.sg/green-efforts) — A
- SBS Transit About Us (https://www.sbstransit.com.sg/about-us) — A
- LTA Bus Contracting Model (https://www.lta.gov.sg/content/ltagov/en/who_we_are/our_work/public_transport_system/bus/bus_contracting_model.html) — B
- LTA Bus Network (…/getting_around/public_transport/bus_network.html) — B
- LTA Rail Network (…/rail_network.html) — B
- LTA North East Line (…/rail_network/north_east_line.html) — B
- LTA Downtown Line (…/rail_network/downtown_line.html) — B
- LTA Sengkang-Punggol LRT (…/rail_network/sengkang_punggol_lrt.html) — B
- LTA New Rail Financing Framework (…/rail/new_rail_financing_framework.html) — B
- LTA OneMotoring — Vehicle Inspection (https://onemotoring.lta.gov.sg/content/onemotoring/home/owning/ongoing-car-costs/inspection.html) — B
- LTA OneMotoring — Bus registration (…/buying/vehicle-types-and-registrations/commercial-vehicle/buses.html) — B
- LTA OneMotoring — Vehicle Inspection Frequency table (inspection page) — B
- Comparable-industry brief (recovered subagent research, ISO 14224 / EN 13306 / SAE J1939 /
  EN 15380 / 49 CFR 396 / DVSA / MTR / RSSB / 14 CFR 43.9) — C, cited where used.

---

## 1. Operating context (shared by Bus and Rail)

| Finding | Evidence | Level |
| --- | --- | --- |
| SBS Transit is a Singapore public-transport operator (bus + rail), a ComfortDelGro company, listed on SGX (co. reg. 199206653M). | SBS Transit About Us; site footer "© SBS TRANSIT LTD Co. Registration No. 199206653M" | A |
| In FY2024: 196 bus routes, 81 stations, 3,329 buses, 198 trains, 9,609 employees, revenue S$1,500M. | AR2024 Operations Review p.1 (cover figures) | A |
| Bus: operates 8 of 14 LTA bus packages under the Bus Contracting Model (BCM); market share 54.3% (biggest bus operator). | AR2024 Operations Review p.2 | A |
| Rail: operates North East Line (NEL), Downtown Line (DTL), Sengkang-Punggol LRT (SPLRT); rail network 84.6 km, 81 stations (17 NEL, 35 DTL, 29 SPLRT); rail market share 31.3%. | AR2024 Operations Review p.4 | A |
| Bus/Rail are separate businesses with separate assets, depots, regulators and contracts. | AR2024 Operations Review (separate Bus Operations and Rail Operations sections); BCM (bus) vs RTSA/NRFF (rail) regimes | A/B |
| BCM: Government/LTA retains fare revenues and owns infrastructure and operating assets such as buses and depots; operators are contracted to run services. | AR2024 p.2; LTA BCM page | A/B |
| Rail: LTA owns rail operating assets; SBS Transit operates under licence; NEL+SK/PG LRT under New Rail Financing Framework since 2018, DTL under NRFF v2 since 1 Jan 2022. | SBS Transit Milestones; LTA NRFF page | A/B |
| Jurong Region Line (JRL) awarded to Singapore One Rail (SBS Transit + RATP Dev) Nov 2024; 24 km, 24 stations, opening in stages from 2027. | AR2024 Operations Review p.4 | A |

---

## 2. Phase A findings — BUS

### 2.1 Maintenance workflows and maintenance types
- SBS Transit operates **seven bus depots** where maintenance works are performed; technicians
  carry out maintenance using tablets (work instructions, drawings, electrical schematics,
  parts information) instead of paper checklists/forms. [SBS Transit Green Efforts] — A.
- Bus depots are tied to bus packages/contracts: SBS moved out of Soon Lee Bus Depot when the
  Jurong West Bus Package expired and took over the new **Sengkang West** depot (handed over by
  LTA Oct 2024, multi-storey, electric-bus ready, staff quarters). [AR2024 p.3] — A.
- Preventive maintenance enabled by condition monitoring: fleetwide **Stratio** condition
  monitoring system (AI/ML) monitors **200+ parameters including brakes, fluid levels, and
  electric systems** to enable predictive maintenance. [AR2024 p.4] — A.
- Maintenance types observed publicly: preventive/scheduled (depot servicing), predictive
  (Stratio telematics), corrective (defect rectification), mid-life refurbishment of assets.
  Exact interval schedules (km/month-based) are **NOT PUBLICLY VERIFIED**.
- Fleet mix 2024: ~61% single-deck, 39% double-deck, 10 articulated ("bendy buses"); ~9 in 10
  buses meet Euro 5 or better; 110 cleaner-energy buses (85 electric + 25 diesel-hybrid).
  [AR2024 p.3-4] — A.
- Bus technician HV capability: in 2024 more than 120 technicians were certified under the
  **WSQ National Electric Vehicle Specialist Safety (NESS)** course to handle high-voltage
  systems, batteries and charging systems on electric buses. [AR2024 p.7] — A.

### 2.2 Inspection / fault / work-order / service records
- Statutory periodic inspection (Singapore): **Omnibus (public bus): 6-monthly inspection
  regardless of age**; other buses: annually (6-monthly when >10 years old); CNG/bifuel buses:
  every 3 months. [OneMotoring Inspection page] — B.
- Statutory inspection checklist categories (Singapore): structural integrity (chassis frame),
  wheel system (tyres, suspension, shock absorber, wheel bearing, alignment), braking system
  (service + parking brake efficiency), steering system, body (seat belts, windscreen, door
  latch/hinges), visual & indication (headlamps, reflectors, mirrors, indicators, wipers,
  horn), propulsion system (exhaust emissions + noise). [OneMotoring Inspection page] — B.
- Authorised Inspection Centres: JIC, STA, VICOM. [OneMotoring] — B.
- SBS-internal work-order/inspection record formats and fault-logging conventions are
  **NOT PUBLICLY VERIFIED**.
- Comparable-industry precedent for inspection-record fields (UK DVSA Guide to Maintaining
  Roadworthiness: operator name, date+ISO week, inspector, location, registration/trailer ID,
  make/model, odometer, each item+condition, defects, remedial work+who did it, signed
  roadworthiness declaration, 15-month retention; brake performance assessment at each
  inspection). [comparable-industry brief C4/C5] — C, NOT an SBS fact.

### 2.3 Technician responsibilities
- Bus technicians maintain buses including **high-voltage systems, batteries and charging
  systems** of electric buses; SBS certifies them under WSQ NESS. [AR2024 p.7] — A.
- Work includes obtaining **work instructions, drawings, electrical schematics and parts
  information** and consulting **bus manufacturers' portals / e-manuals**. [Green Efforts] — A.
- Specific task breakdowns, shift structures and role titles are **NOT PUBLICLY VERIFIED**
  (SBS recruitment uses a Microsoft Forms job listing, not a public catalogue).

### 2.4 Major assets / subsystems / components
- Assets: single-deck, double-deck and articulated buses; electric and diesel-hybrid buses;
  depots and bus interchanges; charging infrastructure (Sengkang West depot e-bus ready).
  [AR2024] — A.
- Condition-monitored subsystems named publicly: **brakes, fluid levels, electric systems**
  (Stratio 200+ parameters). [AR2024 p.4] — A.
- Subsystems implied by statutory checklist: tyres/suspension/shock absorbers/wheel bearings,
  service & parking brakes, steering/drive shafts, body & doors, lights/indicators, exhaust
  emission and noise. [OneMotoring] — B.
- HV subsystems on electric buses: batteries, charging systems, high-voltage isolation —
  covered by NESS-certified technician training. [AR2024 p.7] — A.
- A full component taxonomy (engine, transmission, air system, door systems, HVAC, retarder,
  24V electrical, etc.) is **NOT PUBLICLY VERIFIED** for SBS; see candidate structured
  knowledge in `09_V2_KNOWLEDGE_SCOPE_DRAFT.md` §5.

### 2.5 Terminology, fault codes and identifiers
- Public identifiers: bus service numbers (e.g., 146, 296, 298X, 405, 660M, 675-677), 5-digit
  bus stop codes (e.g., 52039), interchanges/terminals names, bus package names (Bedok,
  Bishan-Toa Payoh, Clementi, Serangoon-Eunos, Sengkang-Hougang, Tampines, Seletar, Bukit
  Merah). [SBS Transit site; AR2024] — A.
- Vehicle registration plates and fleet numbering conventions for SBS buses:
  **NOT PUBLICLY VERIFIED** (public site does not publish fleet numbers).
- Fault-code systems: SBS has not publicly disclosed an internal fault-code catalogue.
  Comparable heavy-vehicle convention: **SAE J1939 SPN/FMI diagnostic fault codes** across
  ECUs (engine, transmission, brakes). [comparable-industry brief C22] — C, NOT an SBS fact.

### 2.6 Measurements and units
- Statutory inspection involves measurement-heavy checks (brake efficiency, emissions, noise,
  tyre condition) [OneMotoring] — B; units are the SG/SI conventions (km, mm, dB, %).
- Telematics monitors parameters such as brake/fluid indicators; exact measured quantities and
  units are **NOT PUBLICLY VERIFIED**.
- Comparable-unit conventions in bus maintenance: odometer (km), tyre tread depth (mm), brake
  test results (%), J1939 parameters. [comparable-industry brief] — C.

### 2.7 Diagnosis and maintenance actions
- Public evidence: SBS operates predictive maintenance (Stratio) that flags degraded
  conditions (brakes, fluids, electrical). [AR2024] — A.
- Specific diagnosis→action sequences (e.g., fault-code → test → repair) are
  **NOT PUBLICLY VERIFIED**; see generic workflow model in `03_SBS_BUS_DOMAIN_MODEL.md`.

### 2.8 Parts replacement
- SBS technicians access **parts information** and manufacturer e-manuals. [Green Efforts] — A.
- Whether parts are tracked by part number, and the parts catalog, are **NOT PUBLICLY VERIFIED**.

### 2.9 Testing and test results
- Statutory tests: braking efficiency (service + parking), exhaust emissions, noise.
  [OneMotoring] — B.
- SBS-specific post-maintenance test conventions: **NOT PUBLICLY VERIFIED**.

### 2.10 Completion / escalation / return-to-service states
- Publicly stated safety metric: bus accidents **0.142 per 100,000 bus-km** (2023: 0.147);
  Workplace Injury Rate (WIR) down 43.6% in bus in 2024. [AR2024 p.6-7] — A.
- Return-to-service criteria, defect deferral/escalation states: **NOT PUBLICLY VERIFIED**.
  Comparable-industry: work-order lifecycle stages open→assigned→in-progress→on-hold→
  completed→closed with reviewer gate and signed roadworthiness declaration [comparable brief
  C9/C4] — C.

### 2.11 Safety-critical information
- High-voltage isolation and battery/charging safety on electric buses (NESS-certified
  technicians). [AR2024 p.7] — A.
- Roadworthiness items in statutory checks (brakes, steering, tyres, doors/latches, lights,
  emissions). [OneMotoring] — B.
- Bus Captain safety systems (AGIL DriveSafe+, digital side mirrors, Golden Eye fatigue
  monitoring) are safety-equipment evidence but not maintenance-report facts. [AR2024 p.6-7] — A.

### 2.12 SOP / manual usage
- SBS technicians use **work instructions, drawings, electrical schematics, parts information**
  and **manufacturer e-manuals** via tablets — i.e., SOP/manual usage is real and digitised.
  [Green Efforts] — A.
- The specific SOP corpus and its structure are **NOT PUBLICLY VERIFIED**.

### 2.13 Maintenance reporting requirements and candidate report structure
- Regulatory record obligations: statutory inspection frequency and checklist must be complied
  with (LTA). [OneMotoring] — B.
- BCM Quality-of-Service standards: ≥96% of scheduled mileage per service per month;
  bus safety metric: <0.50 accidents per 100,000 bus-km per month; Bus Service Reliability
  Framework (BSRF) metrics (Excess Wait Time / On-Time Adherence). [LTA BCM page] — B.
- Candidate report sections (grounded in evidence + comparable practice) are drafted in
  `03_SBS_BUS_DOMAIN_MODEL.md` and `06_V2_REPORT_SCHEMA_DRAFT.md`.

### 2.14 Information available before work vs generated during work
- Before work: asset identity, route/service, depot, package, prior fault/condition data
  (Stratio), statutory inspection due-date, manufacturer manuals. [AR2024; Green Efforts] — A.
- During work: observed defects, measurements, work performed, parts used, test results,
  completion/return-to-service state. Actual field lists: **NOT PUBLICLY VERIFIED**.

---

## 3. Phase A findings — RAIL

### 3.1 Maintenance workflows and maintenance types
- Rail maintenance is depot-centric and line-specific: Bishan Depot (NEL), Sengkang Depot
  (NEL + SPLRT), Gali Batu Depot (DTL), Kim Chuan Depot (DTL), Tai Seng Facility Building.
  [LTA line pages; AR2024] — B/A.
- NEL first-generation trains (25) are undergoing **mid-life refurbishment**: 16 completed and
  back in service with new **condition monitoring systems for predictive maintenance**, new
  seats, flooring, HVAC; remaining 9 expected done by 2026. [AR2024 p.6] — A.
- Track inspection: **Rail Rover / Multi-Function Track Trolley** deployed on DTL (Mar 2025):
  ultrasonic testing for internal rail defects, laser track geometry, third-rail alignment,
  structural health monitoring, water seepage detection. [AR2024 p.6] — A.
- Train underframe inspection assisted by robotics: AVATAR AI robot dog (NEL workshop 2024)
  and an enhanced robotic inspector on wheels (camera + articulated arm). [AR2024 p.6] — A.
- OEM-style Long Term Service Support (LTSS) contracts: Siemens Mobility (DTL **Trainguard
  Sirius CBTC** signalling, multi-year LTSS), Motorola Solutions (DTL+SPLRT **TETRA radio**,
  15-year LTSS), and a **MCEM91 point machine** maintenance centre at the NEL depot
  (localising maintenance/repair/overhaul of point machines). [AR2024 p.6] — A.
- Asset management digitalisation: **IBM Maximo Application Suite** integration (with
  generative AI) for rail asset management, first of its kind in Asia-Pacific. [AR2024 p.7-8] — A.
- Maintenance types observed: preventive/scheduled (interval-based depot servicing),
  predictive/condition-based (new condition monitoring on refurbished trains, Rail Rover),
  corrective (fault rectification), overhaul (mid-life refurbishment; comparable SMRT Depot 4.0
  doubles monthly heavy-overhaul 2→4 trains [comparable brief C29]) — A/B/C.
- Exact SBS interval schedules (days/km-based servicing, overhaul cycles) are
  **NOT PUBLICLY VERIFIED**.

### 3.2 Inspection / fault / work-order / service records
- Regulatory: under NRFF, rail operators must **conduct internal audits, submit annual
  maintenance plans and fault trends analyses**; LTA sets prescriptive maintenance
  requirements and Operating Performance Standards (OPS) on service quality, safety and key
  equipment reliability; penalty framework under the Rapid Transit Systems Act (up to S$1M or
  10% of annual fare revenue). [LTA NRFF page] — B.
- Reliability reporting metric: **MKBF — Mean Kilometres Between Failure**, defined as the
  average distance a train travels before a delay of more than five minutes. [LTA Rail Service
  Reliability PDF; Mothership (comparable brief C25/C26)] — B. FY2024: DTL 8.13M train-km,
  NEL 4.10M train-km, SPLRT 549,000 train-km. [AR2024 p.5-6] — A.
- Fault/work-order formats (train-borne diagnostics, depot management system, Maximo records):
  existence evidenced (Maximo, robotic inspection) but field-level formats
  **NOT PUBLICLY VERIFIED**.

### 3.3 Technician responsibilities
- Rail technicians perform train inspections (e.g., underframe inspection assisted by robotic
  inspector), train maintenance, and participate in international skills competitions (two
  rail technicians represented SBS in Rail Vehicle Technology at WorldSkills Lyon).
  [AR2024 p.7] — A.
- Maintenance of signalling (Trainguard Sirius), radio (TETRA), point machines (MCEM91) is
  supported via LTSS partnerships with OEMs. [AR2024 p.6] — A.
- Role titles, qualifications and shift patterns: **NOT PUBLICLY VERIFIED**.

### 3.4 Major assets / subsystems / components
- Rolling stock: NEL — Alstom Metropolis **C751A** (25 first-gen, mid-life upgrading),
  **C751C**, **C851E**; DTL — Bombardier/Alstom Movia **C951**; SPLRT — Mitsubishi Heavy
  Industries **Crystal Mover**. [LTA NEL page; AR2024] — B/A.
- Line facts: NEL ~22 km, 17 stations, world's first fully automated underground driverless
  heavy rail line; DTL 42 km, 35 stations, longest underground driverless MRT line; SPLRT
  fully driverless, Sengkang LRT opened 2003 (14 stn), Punggol LRT opened 2005 (14 stn),
  two-car trains since 2016, SPLRT depot expansion by 2027. [LTA line pages] — B.
- Subsystems named publicly: traction-related condition monitoring (refurbished trains),
  third rail (Rail Rover measures **third-rail alignment**), track (internal rail defects),
  tunnels (structural health, water seepage), signalling (CBTC), radio (TETRA), point
  machines, HVAC (refurbished trains' air-conditioning). [AR2024 p.6] — A.
- Platform doors, escalators, lifts, station systems, OCS, tunnel ventilation: station asset
  categories exist (81 stations operated) but SBS-specific maintenance detail
  **NOT PUBLICLY VERIFIED**.
- Comparable-industry rail subsystem taxonomy: EN 15380 function groups (wheelsets/bogies,
  doors, brakes, traction); RSSB GMRT2466 wheelsets (tread profile, flange thickness limits).
  [comparable brief C13/C10] — C, NOT an SBS fact.

### 3.5 Terminology, fault codes and identifiers
- Line codes (NE, DT, SK, PG), station codes (e.g., NE1, DT1, SKG/PG station codes) are public
  conventions. [SBS Transit / LTA system maps] — A/B.
- Train fleet = 198 trains; individual train/car-set numbers: **NOT PUBLICLY VERIFIED**.
- Train-borne fault codes, point machine IDs, track asset IDs: **NOT PUBLICLY VERIFIED**.

### 3.6 Measurements and units
- Track-side measurements: ultrasonic rail-defect detection, laser track geometry, third-rail
  alignment, structural health, water seepage (Rail Rover). [AR2024 p.6] — A.
- Rail reliability measured in train-km (MKBF). [AR2024; LTA] — A/B.
- Wheel-profile/brake-wear thresholds: **NOT PUBLICLY VERIFIED** (comparable: wheel profile
  parameters flange height/width, qR, flange angle, rim thickness, back-to-back gauge, wheel
  diameter [comparable brief C11]; RSSB flange limits [C10]) — C.

### 3.7 Diagnosis and maintenance actions
- Public evidence: predictive maintenance via new condition monitoring systems; ultrasonic/
  laser track diagnostics; robotic underframe inspection. [AR2024 p.6] — A.
- Specific fault→diagnosis→action sequences and codes: **NOT PUBLICLY VERIFIED**.

### 3.8 Parts replacement
- Point machine MCEM91 maintenance/repair/overhaul localised at NEL depot (reduces need to
  send machines overseas); obsolete component replacement covered under Motorola LTSS.
  [AR2024 p.6] — A.
- Parts catalogs and part-number conventions: **NOT PUBLICLY VERIFIED**.

### 3.9 Testing and test results
- Post-refurbishment trains "returned to passenger service" (i.e., commissioning/return-to-
  service testing exists). [AR2024 p.6] — A.
- Specific test protocols and result formats: **NOT PUBLICLY VERIFIED**.

### 3.10 Completion / escalation / return-to-service states
- Mid-life refurbished trains "returned to passenger service"; Rail Rover findings enable
  "timely maintenance". [AR2024 p.6] — A.
- Incident management: Rail Incident Management System (RIMS) app for passenger comms during
  disruptions; VAnGuard track-intrusion detection across 29 LRT stations (OCC cuts traction
  power). [AR2024 p.8-10] — A.
- Formal escalation/return-to-service state machine: **NOT PUBLICLY VERIFIED**.

### 3.11 Safety-critical information
- Rail safety regulated under RTSA and NRFF OPS (safety, service quality, key equipment
  reliability). [LTA NRFF] — B.
- Track-side safety: track intrusion detection (VAnGuard) and traction power cut; point
  machines as safety-critical signalling (switch direction safely). [AR2024 p.6-8] — A.
- Safety outcomes: rail WIR down 34.4% in 2024; 732 red-teaming exercises on bus ops; LTA
  Code of Practice security audit with no non-compliance. [AR2024 p.7-8] — A.

### 3.12 SOP / manual usage
- Maintenance of signalling/radio/point machines follows OEM LTSS arrangements; asset
  management runs on Maximo. [AR2024 p.6-8] — A.
- Internal SOP corpus and its structure: **NOT PUBLICLY VERIFIED**.

### 3.13 Maintenance reporting requirements and candidate report structure
- Regulatory: annual maintenance plans, fault trends analyses, internal audits, OPS reporting,
  MKBF reporting to LTA. [LTA NRFF; AR2024] — B/A.
- Candidate report sections for rail drafted in `04_SBS_RAIL_DOMAIN_MODEL.md` and
  `06_V2_REPORT_SCHEMA_DRAFT.md`.

### 3.14 Information available before work vs generated during work
- Before work: line/depot, train car-set, asset hierarchy (Maximo), prior condition monitoring
  data, scheduled maintenance plan, signalling/radio/point-machine maintenance history. [AR2024] — A.
- During work: inspection results (incl. robotic underframe), measurements (track geometry,
  rail defects, third-rail alignment), parts used, test results, return-to-service state.
  Actual field lists: **NOT PUBLICLY VERIFIED**.

---

## 4. Bus/Rail subdivision status (contract §1)

The Bus/Rail split is **provisionally justified** by evidence: distinct assets, depots,
workforces, contracts (BCM vs NRFF/RTSA), regulators, and public documentation streams. No
public evidence mixes bus and rail maintenance knowledge. Finer subdivision (by package,
depot, or line) is **not yet justified by evidence** and is recommended only as metadata on
user uploads pending SBS confirmation (`09_V2_KNOWLEDGE_SCOPE_DRAFT.md` §3-4).

---

## 5. NOT PUBLICLY VERIFIED (summary)

Internal SBS maintenance artifacts not publicly disclosed (each detailed in
`10_SBS_INFORMATION_GAPS.md`): bus maintenance intervals and depot work-order formats; bus
fleet-number/registration conventions; internal fault-code catalogues (bus and rail);
parts catalogs and part-number conventions; train car-set identifiers; wheel/brake wear
thresholds; technician role/shift structures; report templates used by SBS; CMMS field-level
schemas beyond the public mention of Maximo and Stratio.

---

*End of 01_SBS_DOMAIN_DISCOVERY.md*
