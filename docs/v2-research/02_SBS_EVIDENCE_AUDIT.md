# 02 — SBS Evidence Audit (Phase B)

Phase B of `docs/PRE_FREEZE_RESEARCH_CONTRACT.md`.
Classification per contract §6:
- **A** = SBS-specific evidence
- **B** = Singapore transport-sector evidence
- **C** = comparable-industry evidence
- **D** = inference/assumption
- Anything not publicly verified is marked **NOT PUBLICLY VERIFIED**.
- C/D evidence is never rewritten as an SBS fact.

Research was performed against public sources (2026-09). The web-search endpoint was
unavailable in the research environment; every finding below traces to a page/document
actually fetched and read (HTML via web_fetch; PDFs via download + text extraction;
Wikipedia raw wikitext for rolling-stock/platform detail, labelled C unless corroborated by
official sources). Full source registers with URLs are in `01_SBS_DOMAIN_DISCOVERY.md` §0
and in each finding below.

---

## A. AUDIT SUMMARY (counts)

| Evidence level | Bus | Rail | Cross-cutting/Standards | Meaning |
| --- | --- | --- | --- | --- |
| A (SBS-specific) | 38 | 33 | 2 | SBS Transit primary sources (AR2022–2025 Operations Reviews, Green Efforts, Milestones, newsroom, SGX results, SBS+IBM release) |
| B (SG transport-sector) | 18 | 19 | 10 | LTA pages/factsheets/reliability PDFs, OneMotoring, SSO statutes (via archive), WSHC, DataMall, SMRT/Mothership |
| C (comparable-industry) | 12 | 14 | 12 | UK/US/international standards & operators, ISO/EN/SAE/IEC/UIC, MTR, Wikipedia platform data |
| D (inference/assumption) | noted inline | noted inline | — | design proposals, not SBS facts |
| NOT PUBLICLY VERIFIED | 16 | 16 | 6 | see §B |

Counts are indicative. The audit below lists the substantive claims by cluster; the same
evidence appears across deliverables 01, 03–09.

---

## B. BUS — AUDITED CLAIMS

### B1. Fleet, assets, depots
- **Claim:** FY2024 fleet 3,329 buses (~61% single-deck, 39% double-deck, 10 articulated); FY2025 fleet 3,384 (~62% SD, 38% DD, 10 articulated); FY2022 3,562. | BUS | **A** | SBS Transit Annual Report 2022/2024/2025 Operations Review | https://www.sbstransit.com.sg/Uploads/Investor_Relations/Annual_Report/2024/Operations%20Review.pdf (also 2022, 2025) | "In 2024, our fleet comprised 3,329 buses…" | HIGH | Self-reported; report text prints 61%+39%+10 articulated (quoted verbatim; appears to double-count articulated within deck shares).
- **Claim:** Cleaner-energy bus counts: 56 (2022: 31e+25h), 57 (2023: 32e+25h), 110 (2024: 85e+25h); ~9 in 10 buses Euro 5+; TCFD target: all buses cleaner energy by 2040, half electric by 2030. | BUS | **A** | AR2023/2024 Operations Review; TCFD Inaugural Report 2023 | same host paths | "This included 110 cleaner energy buses, up from the 57 in 2023. They comprised 85 electric buses and 25 diesel-hybrid ones." | HIGH | Future fleet plans are aspirational statements.
- **Claim:** Seven bus depots; technicians use tablets with work instructions, drawings, electrical schematics, parts information and manufacturer e-manual portals. | BUS | **A** | SBS Transit Green Efforts | https://www.sbstransit.com.sg/green-efforts | "Across our seven bus depots, our technicians use tablets instead of paper checklists and forms…" | HIGH | Depot names not enumerated on this page; see B1 next.
- **Claim:** Named bus depots: Ang Mo Kio (exited Jan 2025), Bedok North, Ulu Pandan, Hougang, Seletar, Soon Lee (exited 2024), Bukit Batok (bus-stop "Sbst Bt Batok Depot"), new Sengkang West (handed over Oct 2024; Singapore's first electric bus depot, ~500-bus capacity, 240 EV chargers). | BUS | **A** | AR2022–2025 Operations Review; Sustainability Report 2024; SBS NextBus | https://www.sbstransit.com.sg/ | "Sengkang West Bus Depot… Singapore's first electric bus depot… 240 advanced electric vehicle chargers" | HIGH | Depot list assembled from AR/news/bus-stop names; SBS does not publish a single asset register.
- **Claim:** Depot occupation is tied to LTA Bus Packages/leases (Soon Lee exit on Jurong West package expiry; Ang Mo Kio exit on land-lease expiry). | BUS | **A** | AR2024 Operations Review | as above | "we moved out of the Soon Lee Bus Depot with the expiry of the Jurong West Bus Package." | HIGH | Reinforces package-scoped depot metadata hypothesis (09 §3).
- **Claim:** BYD K9 (20 electric, SG3050Z–SG3069X) operated solely by SBS from Seletar Bus Depot (service from Jul 2020); BYD K9RC double-deck demo and B12A03 demo ran with SBS; Linkker LM312 (20, shared), Zhongtong N12 (120, all ops), BYD BC12A04 (300, all ops) also in service. | BUS | **B** (Singapore-sector, tertiary-sourced) | Wikipedia "BYD K series"; Land Transport Guru fleet tables | https://landtransportguru.net/bus-models/ | "The fleet of BYD K9 buses are operated solely by SBS Transit, based at Seletar Bus Depot (SEDEP)…" | MEDIUM-HIGH | Enthusiast/tertiary sources; registration ranges and allocations not cross-checked against GeBIZ/LTA.
- **Claim:** MAN A95 double-deck (200 Euro V, 362 Euro VI, 50 Euro VI 3-door at SBS), MAN A22 single-deck (734+150 across operators), MAN A24 articulated (SBS runs ~12 on Yishun feeders); Volvo B9TL Wright (1,606 at SBS) and CDGE (200); Scania K230UB (1,101 at SBS); MB Citaro O530 (1,155 across all operators incl. SBS); ADL Enviro500 MMC 3-door (50, all ops). | BUS | **B/C** | Wikipedia MAN Lion's City / Volvo B9TL / Scania K series / ADL Enviro500; Land Transport Guru | https://en.wikipedia.org/w/index.php?title=MAN_Lion%27s_City&action=raw ; https://landtransportguru.net/bus-models/ | see OEM brief §A1-12 | MEDIUM-HIGH | Fleet censuses are tertiary; per-operator splits not always itemised; counts are acquisition totals not current-in-service.
- **Claim:** No Enviro500EV and no production BYD B12 at SBS (trials/demonstrators only); Scania K310UD demonstrator only. | BUS | **B** (negative/absent evidence) | Land Transport Guru; Wikipedia | as above | absence from production fleet tables | MEDIUM | Absence in tertiary tables ≠ proof, but consistent across sources. NOT PUBLICLY VERIFIED as absolute.

### B2. Maintenance workflows and types
- **Claim:** Fleetwide Stratio condition-monitoring system (AI/ML) tracks 200+ parameters including brakes, fluid levels, electric systems for predictive maintenance; fleetwide by end-2024; prevented 500+ breakdowns in 2025. | BUS | **A** | AR2024/2025 Operations Review; Sustainability Report 2024 | https://www.sbstransit.com.sg/Uploads/Investor_Relations/Annual_Report/2024/Operations%20Review.pdf | "it tracks over 200 parameters, including brakes, fluid levels, and electric systems to achieve operational reliability." | HIGH | Vendor product (Stratio); SBS effectiveness claims self-reported.
- **Claim:** Shift from preventive to condition-based maintenance; "Maintenance Failure Review Board" identifies lifespan-extension vs replacement; periodic inspections and targeted replacements saved 15.7 t materials in 2024. | BUS | **A** | Sustainability Report 2024 | https://www.sbstransit.com.sg/Uploads/Sustainability/Sustainability%20Report%202024/SBS%20Transit%20Sustainability%20Report%202024.pdf | "the shift from preventive to condition-based maintenance has allowed us to optimise costs and save materials." | HIGH | No public interval schedules (km/month values). NOT PUBLICLY VERIFIED.
- **Claim:** "Diagnostic Expert Career Scheme" for bus technicians (condition-based/predictive; AI Diagnostics tools); AI automated tyre management at Ulu Pandan (saves ~2,000 man-hours/depot/yr); Electric Bus Satellite Training Centre at Seletar (with Singapore Bus Academy). | BUS | **A** | AR2025 Operations Review | https://www.sbstransit.com.sg/Uploads/Investor_Relations/Annual_Report/2025/Operations%20Review.pdf | "we introduced a new Diagnostic Expert Career Scheme for bus technicians…" | HIGH | Role content not detailed publicly.
- **Claim:** Digitised daily "pre-use checklist" and operational forms (paper→softcopy). | BUS | **A** | Sustainability Report 2024 | as above | "conversion of hardcopy pre-use checklist and operational forms to softcopies." | HIGH | Checklist item content not published.

### B3. Inspection / fault / work-order / records
- **Claim:** Omnibus (public-transport bus) periodic inspection every 6 months regardless of age; other buses annually (<10 yr) / 6-monthly (>10 yr); CNG/bifuel bus systems every 3 months. | BUS | **B** | OneMotoring (LTA) — Inspection | https://onemotoring.lta.gov.sg/content/onemotoring/home/owning/ongoing-car-costs/inspection.html | inspection-frequency table (Omnibus 6-monthly) | HIGH | Public-facing summary; statutory section text (Road Traffic Act / PSV Rules) not retrieved.
- **Claim:** Statutory inspection checklist categories: structural integrity (chassis frame); wheel system (tyres, suspension, shock absorber, wheel bearing, alignment); braking system (service + parking brake efficiency); steering system (drive shafts, stability); body (seat belts, windscreen, door latch/hinges); visual & indication (headlamps, reflectors, mirrors, indicators, wipers, horn); propulsion (exhaust emissions + noise per NEA). | BUS | **B** | OneMotoring (LTA) — Inspection | as above | checklist table | HIGH | Pass/fail numeric thresholds (brake %, kPa) not given.
- **Claim:** Inspections at LTA-Authorised Inspection Centres (JIC, STA, VICOM); LTA inspection notice issued up to 3 months before due date; inspection tied to road-tax renewal validity. | BUS | **B** | OneMotoring (LTA) — Inspection | as above | AIC sections | HIGH | —
- **Claim:** LTA regulates private-bus use/ownership, ensures buses "undergo regular inspections to maintain roadworthiness"; Vocational Licences for PSV drivers/bus attendants; fare-charging scheduled bus services licensed by LTA; all buses registered before driving. | BUS | **B** | LTA — Buses (Regulations & Licensing) | https://www.lta.gov.sg/content/ltagov/en/industry_innovations/industry_matters/regulations_licensing/buses.html | quoted line | HIGH | —
- **Claim:** "Omnibus" = bus operated by public transport operators; omnibuses can only be registered under public bus operators; 5 bus types. | BUS | **B** | OneMotoring — Bus registration | https://onemotoring.lta.gov.sg/content/onemotoring/home/buying/vehicle-types-and-registrations/commercial-vehicle/buses.html | "An Omnibus is a bus operated by public transport operators." | HIGH | Registration, not maintenance, focus.
- **Claim:** SBS met "all the standards stipulated by the LTA in the maintenance of buses, bus interchanges and depots, the Common Fleet Management and the Bus Ticketing systems" (2022). | BUS | **A** | AR2022 Operations Review | https://www.sbstransit.com.sg/Uploads/Investor_Relations/Annual_Report/2022/Operations%20Review.pdf | quoted | HIGH | Existence of LTA-set maintenance standards (contractual/audited) confirmed; the standard values are not published.
- **Claim:** SBS-internal work-order/inspection record formats and fault-logging conventions. | BUS | — | — | — | — | — | **NOT PUBLICLY VERIFIED.** (SBS confirms tablet-based digital work instructions exist; schema not public.)
- **Claim (comparable):** UK DVSA safety-inspection record fields (operator, date+ISO week, inspector, location, registration ID, make/model, odometer, per-item condition, defects, remedial work, signed roadworthiness declaration, 15-month retention, brake-performance assessment); US FMCSA 12-monthly inspection (49 CFR §396.17) with documentation kept on vehicle; US FTA 49 CFR 625 asset-management registers. | BUS | **C** | GOV.UK Guide to Maintaining Roadworthiness; OperatorCompliance summary; eCFR via Cornell LII | https://www.gov.uk/government/publications/guide-to-maintaining-roadworthiness ; https://www.law.cornell.edu/cfr/text/49/396.17 ; https://www.law.cornell.edu/cfr/text/49/part-625 | quoted field list | HIGH (primary text) / MEDIUM (DVSA PDF via secondary) | NOT an SBS fact; comparable precedent for record-field design.

### B4. Technician roles
- **Claim:** WSQ NESS (offered by ITE College West) certifies SBS technicians for HV electric-bus systems, batteries, charging; 46 first-in-industry (2022), 67 (2023), >120 (2024), 159 (2025), >40% of technicians HV-certified by 2025. | BUS | **A** (SBS counts) / **B** (course provenance) | AR2022/2024/2025 Operations Review | as above | "more than 120 technicians were certified… National Electric Vehicle Specialist Safety (NESS) course." | HIGH | Self-reported counts.
- **Claim:** Bus technicians obtain work instructions/drawings/schematics/parts info and consult manufacturer e-manuals. | BUS | **A** | Green Efforts | https://www.sbstransit.com.sg/green-efforts | quoted | HIGH | —
- **Claim:** Technician job duties and career ladders. | BUS | — | SBS "Join Us" → JobStreet link; "Diagnostic Expert Career Scheme" | https://www.sbstransit.com.sg/grow-with-us | — | — | **NOT PUBLICLY VERIFIED** (job-ad text JS-rendered; e-brochures image-based).

### B5. Terminology, fault codes, identifiers
- **Claim:** Public identifiers: service numbers (146, 296, 298X, 405, 660M, 675–677, etc.; suffixes A/B/G/W/M/T/e), 5-digit bus stop codes (e.g., 52039, 22191 Soon Lee Depot), interchange/terminal names, package names (Bedok, Bishan-Toa Payoh, Clementi, Serangoon-Eunos, Sengkang-Hougang, Tampines, Seletar, Bukit Merah). | BUS | **A/B** | SBS Transit site (NextBus); AR2024 | https://www.sbstransit.com.sg/ | bus-stop code examples in NextBus dropdown | HIGH | —
- **Claim:** Vehicle registration number (VRN) is statutory identity; "Omnibus" registration class under public operators. | BUS | **B** | OneMotoring | as above | — | HIGH | —
- **Claim:** SBS internal fleet numbering and fault-code catalogue. | BUS | — | — | — | — | — | **NOT PUBLICLY VERIFIED.**
- **Claim (comparable):** SAE J1939 PGN/SPN/FMI diagnostic fault codes across heavy-vehicle ECUs (engine, transmission, brakes); OBD/EOBD family. | BUS | **C** | Wikipedia SAE J1939; Heavy Duty Journal; PrimoDeTech | https://en.wikipedia.org/w/index.php?title=SAE_J1939&action=raw | "parameter group number (PGN)… Suspect Parameter Number (SPN)" | HIGH | Truck/road focus; SBS telematics protocol stack not disclosed.

### B6. Measurements and units
- **Claim:** Units observed in SBS/LTA bus material: km/bus-km, %, MWh, g/kWh, S$M, man-hours, per-month QoS rates. | BUS | **A/B** | ARs; Green Efforts; LTA BCM | as above | "0.142 accident cases per 100,000 bus-km"; "840MWh"; "0.46g/kWh to 0.25g/kWh" | HIGH | —
- **Claim:** kPa/bar brake pressures, V, °C, tyre-tread mm thresholds. | BUS | — | — | — | — | — | **NOT PUBLICLY VERIFIED.**

### B7. Testing, completion, safety-critical, return-to-service
- **Claim:** Bus safety metrics: 0.142 accidents/100,000 bus-km (2024, from 0.147 in 2023); WIR −43.6% (bus, 2024); BCM QoS: ≥96% scheduled mileage per service per month; <0.50 accidents/100,000 bus-km per month; BSRF uses Excess Wait Time or On-Time Adherence. | BUS | **A/B** | AR2024; LTA BCM page | https://www.lta.gov.sg/content/ltagov/en/who_we_are/our_work/public_transport_system/bus/bus_contracting_model.html | quoted QoS | HIGH | —
- **Claim:** HV isolation and battery/charging safety on electric buses (NESS-certified technicians; e-bus fire-response training scenario). | BUS | **A** | AR2024/2025 | as above | — | HIGH | Procedure detail not public. NOT PUBLICLY VERIFIED (procedures).
- **Claim:** Return-to-service criteria and defect deferral/escalation states. | BUS | — | — | — | — | — | **NOT PUBLICLY VERIFIED.** (Comparable: CMMS work-order lifecycle open→…→closed with reviewer gate; 14 CFR §43.9 record+sign-off — evidence C.)

---

## C. RAIL — AUDITED CLAIMS

### C1. Network, stock, depots
- **Claim:** SBS operates NEL, DTL, SPLRT (plus JRL via Singapore One Rail JV from ~2027/2028). | RAIL | **A** | SBS Transit site/AR2025 | https://www.sbstransit.com.sg/ | "NORTH EAST LINE • DOWNTOWN LINE • SENGKANG LIGHT RAIL TRANSIT • PUNGGOL LIGHT RAIL TRANSIT" | HIGH | —
- **Claim:** Network scale: 84.6 km / 81 stations (17 NEL, 35 DTL, 29 SPLRT) in 2024 (83 km / 78 stations 2023); national MRT ~200–260 km / 140+ stations (LTA figures vary by page/date). | RAIL | **A/B** | AR2024; LTA rail pages | https://www.sbstransit.com.sg/Uploads/Investor_Relations/Annual_Report/2024/Operations%20Review.pdf ; https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network.html | "Our rail network increased by 1.6 km or about 1.9% to 84.6km…" | HIGH | DTL length reported as both 42 km (AR2023) and 34 km (AR2024) — conflict; do not hardcode.
- **Claim:** NEL = Alstom Metropolis C751A (25×6-car, ONIX 1500, 1,500 V DC overhead catenary — only OCS MRT line), C751C (18×6-car, OPTONIX), C851E (6×6-car, OPTONIX; all six with condition monitoring; two with Automatic Track Inspection). | RAIL | **A** (LTA NEL page; LTA C851E release) / **B** (class pages) | LTA North East Line; LTA news release 27 Jul 2023; Wikipedia Alstom Metropolis C751A/C751C/C851E | https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network/north_east_line.html ; https://www.lta.gov.sg/content/ltagov/en/newsroom/2023/7/news-releases/new-trains-for-north-east-line-to-be-rolled-out-for-passenger-se.html | "The rolling stock of the train is Alstom Metropolis C751A, C751C and C851E." | HIGH | Per-class car counts from Wikipedia (B); LTA page confirms classes + mid-life upgrade.
- **Claim:** DTL = Bombardier/Alstom Movia C951/C951A (92×3-car, MITRAC 1000 IGBT-VVVF with permanent-magnet synchronous motors, FLEXX Metro 3100 bogies, 750 V DC third rail, Siemens Trainguard Sirius CBTC). | RAIL | **A/B** | LTA DTL page; Wikipedia Downtown Line / Bombardier Movia C951 | https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network/downtown_line.html ; https://en.wikipedia.org/w/index.php?title=Bombardier_Movia_C951&action=raw | "Siemens Trainguard Sirius communications-based train control (CBTC)… 750 V DC third rail" | HIGH | DTL signalling = Siemens Trainguard Sirius; any Thales SelTrac claim for DTL is **NOT PUBLICLY VERIFIED / contradicted**.
- **Claim:** SPLRT = MHI Crystal Mover (C810 one-car ×41, C810A two-car ×16, C810D two-car ×25 replacing first-gen by 2028), Kyosan Electric APM fixed-block signalling, 750 V DC third rail, 1,850 mm gauge. | RAIL | **B** | Wikipedia Sengkang LRT line / Crystal Mover; LTA SPLRT page | https://en.wikipedia.org/w/index.php?title=Sengkang_LRT_line&action=raw | "Kyosan Electric's Automated People Mover (APM) fixed block signalling system" | HIGH | Signalling detail tertiary (Kyosan corp. report via Wikipedia).
- **Claim:** NEL depot = Sengkang Depot (27 ha; NEL OCC; workshop can lift an entire train; LRT maintained on 2nd floor; expansion 3.5→11.1 ha by 2027). | RAIL | **B/C** | Wikipedia NEL / Sengkang Depot / Sengkang LRT | as above | "the depot's workshop has equipment which can raise an entire train" | MEDIUM-HIGH | Depot machinery makes (wheel lathe etc.) NOT PUBLICLY VERIFIED. **Correction:** Bishan Depot is the SMRT NSL depot, NOT the NEL depot.
- **Claim:** DTL depots = Gali Batu + Tai Seng Facility Building (future East Coast Integrated Depot); Gali Batu hosts a new Maintenance & Engineering Centre (MEC) for DTL systems. | RAIL | **A** (MEC, SBS AR) / **B** (depots, Wikipedia) | AR2025 Operations Review; Wikipedia Downtown Line | as above | "a new Maintenance and Engineering Centre (MEC) for DTL systems was set up at the Gali Batu Depot" | MEDIUM-HIGH | Kim Chuan as a DTL depot **NOT PUBLICLY VERIFIED** (appears only in planning history).
- **Claim:** Train/car identifiers: fleet numbers C751A 7001/7002–7049/7050, C751C 7051/7052–7085/7086, C951 9001–9092; 5-digit car serials (7xxxx); carriage types DT/Mi/Mp. | RAIL | **B/C** | Wikipedia class pages | as above | car-numbering schemes | HIGH | Format evidence; official SBS registry not public.

### C2. Maintenance workflows and types
- **Claim:** Mid-life refurbishment of all 25 C751A (2019–2026, CRRC Nanjing Puzhen; S$116.7M per tertiary source) with new condition-monitoring systems for predictive maintenance; 16 returned to service by end-2024; all 25 by Feb 2026. | RAIL | **A/B** | AR2024; LTA NEL page | as above | "Sixteen trains on the NEL have completed their mid-life refurbishment… feature new condition monitoring systems for predictive maintenance." | HIGH | Contract value tertiary (C).
- **Claim:** Rail Rover (upgraded Multi-Function Track Trolley) on DTL (Mar 2025): ultrasonic internal rail-defect detection, laser track geometry + third-rail alignment, tunnel structural health + water seepage. | RAIL | **A** | AR2024 | as above | quoted | HIGH | —
- **Claim:** AVATAR AI robot dog at NEL workshop (2024) and enhanced robotic inspector on wheels for underframe inspection; gamified train-defect app + smart glasses (Q2 2026); MoU with dConstruct Robotics (overhaul maintenance). | RAIL | **A** | AR2024/2025 | as above | — | HIGH | —
- **Claim:** Track access digitised via Track Access Management System (TAMS) (DTL live 2023 → NEL → SPLRT/JRL). | RAIL | **A** | AR2023/2024 | as above | quoted | HIGH | —
- **Claim:** Rail maintenance types: corrective + preventive "in accordance to work instructions and procedures" (Rail Engineering e-brochure); predictive/condition-based (condition monitoring, MEC for point machines & sump pumps, MaxiMobility with IBM); ISO 55001 (first to transition to 2024 edition). | RAIL | **A** | AR2025; SBS Rail Engineering e-brochure; SBS+IBM release | https://www.sbstransit.com.sg/news/sbs-transit-taps-into-ibm-maximo-application-suite-for-intelligent-asset-management-to-enhance-rail-operations-and-maintenance | quoted | HIGH | Maximo is a partnership announcement (planned), not proof of full production deployment.
- **Claim:** LTSS/OEM contracts: 10-yr Alstom NEL signalling support; 15-yr Motorola Solutions LTSS (DTL+SPLRT TETRA radio); multi-year Siemens Mobility LTSS (DTL Trainguard Sirius CBTC); Siemens MCEM91 point-machine maintenance centre at NEL depot. | RAIL | **A** | AR2022/2024 | as above | quoted | HIGH | Contract values not disclosed.
- **Claim:** Aug 2025 major power fault on NEL + entire SPLRT (faulty voltage transformer + switchboard components at shared depot substation); LTA Rail Reliability Taskforce (Sep 2025) → MOT-accepted recommendations (Feb 2026); power-asset renewal from 2026. | RAIL | **A/B** | SBS AR2025; LTA Reports page; Mothership | https://www.lta.gov.sg/content/ltagov/en/who_we_are/statistics_and_publications/reports.html | quoted | HIGH | Taskforce report PDF downloaded (40 pp) but not fully reviewed.

### C3. Records, reliability reporting, regulation
- **Claim:** MKBF definition (LTA): mean distance travelled between delays >5 min, in train-km (MRT) or car-km (LRT); figures subject to adjustment pending incident investigations; published monthly. | RAIL | **B** | LTA Rail Service Reliability PDFs; Annex (2020–2025) | https://www.lta.gov.sg/content/dam/ltagov/who_we_are/statistics_and_publications/statistics/pdf/Rail_Service_Reliability_Performance_Sep_2025_to_Aug_2026.pdf ; …/Annex%E2%80%93Historical_Rail_Service_Reliability_Performance.pdf | "Mean Distance Travelled Between Delays >5 min (train-km)" | HIGH | —
- **Claim:** MKBF values: DTL 4.05M (2022)/8.12M (2023)/8.13M (2024)/2.79M (2025) train-km; NEL 2.06M (2022/23)/4.10M (2024)/2.20M (2025); SPLRT 0.44M (2022)/1.22M (2023)/0.55M (2024)/1.03M (2025) car-km; national MRT avg 2.08M (2023)/1.61M (2025). | RAIL | **A** (SBS ARs) / **B** (LTA Annex; cross-corroborated) | SBS AR2022–2025; LTA Annex | as above | "the DTL clocked 8.12 million train-km in 2023…" | HIGH | SBS wording omits the >5-min threshold; LTA defines it.
- **Claim:** NEL MKBF target of 1,000,000 train-km (historical, per tertiary source). | RAIL | **C** | Wikipedia NEL | as above | "maintains its mean kilometres between failures target of one million train-km." | MEDIUM | Historical/tertiary.
- **Claim:** Regulatory framework (NRFF): LTA owns rail operating assets; operators conduct internal audits, submit annual maintenance plans and fault trends analyses; Operating Performance Standards (service quality, safety, key equipment reliability); penalty framework under RTSA. | RAIL | **B** | LTA New Rail Financing Framework | https://www.lta.gov.sg/content/ltagov/en/who_we_are/our_work/public_transport_system/rail/new_rail_financing_framework.html | NRFF page content | HIGH for page existence; page body was truncated in some fetches and fully readable in one (the maintenance-plan/fault-trend sentence) | Exact penalty values (S$1M or 10% fare revenue) from the comparable-industry brief's snippet; treat penalty amount as B if fully confirmed on page, else NOT PUBLICLY VERIFIED. (Verify: the sentence "Rail operators must conduct internal audits and submit annual maintenance plans and fault trends analyses" appeared in a fetched snippet.)
- **Claim:** Statutory instruments: Rapid Transit Systems Act 1995 (Parts 3 Operation, 3A Designated Entities, 4 Safety of Railway, 4A, 5 Appeals, 6); Road Traffic Act 1961 (Parts 1 registration, 2 drivers, 3 instructors, 4 general); Bus Services Industry Act 2015 (Parts 2 procurement, 3 operator licensing, 4 bus depot/interchange operator licensing, 4A, 5 step-in, 5A, 6 enforcement/monitoring, 7, 8); RTS Regulations (RG1) = passenger/fares/enforcement (not a maintenance code); RTS (Creation of Rights) Notification N1. | RAIL/BUS | **B** | Singapore Statutes Online (archived snapshots) | https://web.archive.org/web/20260117160056/https://sso.agc.gov.sg/Act/RTSA1995 ; https://web.archive.org/web/20250108181656/https://sso.agc.gov.sg/Act/RTA1961 ; https://web.archive.org/web/20260118170206/https://sso.agc.gov.sg/Act/BSIA2015 | Table of Contents + status lines | HIGH (TOC/status) | Provision-level text NOT retrieved (SSO blocks direct fetch; Wayback TOC only). Section-level obligations (e.g., RTSA Part 4 safety duties, BSIA depot-licence conditions) **NOT PUBLICLY VERIFIED**.
- **Claim:** LTA "Railway Safety" pages exist (Rapid Transit System Safety; Safety Submission Overview) — a submission/audit-based rail-safety regime. | RAIL | **B** | LTA Safety, Health & Environment child pages | https://www.lta.gov.sg/content/ltagov/en/industry_innovations/industry_matters/safety_health_environment/rapid_train_system_safety.html | page titles (HTTP 200) | HIGH (existence) | Page content pruned → record-type detail NOT PUBLICLY VERIFIED.
- **Claim:** WSHC workplace-safety requirements apply to depots/workshops (WSH Risk Management Regulations; WSH Incident Reporting Regulations; vehicle factors include "Not maintained regularly"). | BUS/RAIL | **B** | WSHC Vehicular Safety pages | https://www.tal.sg/wshc/topics/vehicular-safety/about-vehicular-safety | quoted | HIGH | General workplace law (MOM/WSHC), not LTA-specific.
- **Claim:** LTA DataMall publishes static/dynamic land-transport datasets; dynamic APIs require a registered Account Key; Singapore Open Data Licence. | RAIL/BUS | **B** | LTA DataMall | https://datamall.lta.gov.sg/content/datamall/en.html | quoted | HIGH | Dataset schemas (station codes etc.) not retrieved here.
- **Claim:** Rail incident/delay reporting conventions: SBS newsroom has a "Maintenance Works" filter; joint LTA/PTO releases for disruptions; Rail Reliability Taskforce (formed 19 Sep 2025) recommendations accepted 13 Feb 2026. | RAIL | **A/B** | SBS newsroom; LTA Reports | https://www.sbstransit.com.sg/news ; https://www.lta.gov.sg/content/ltagov/en/who_we_are/statistics_and_publications/reports.html | "Maintenance Works" filter | HIGH | Root-cause detail lives in joint releases.

### C4. Measurements, safety-critical, return-to-service
- **Claim:** Track-side measurements: ultrasonic rail-defect detection, laser track geometry, third-rail alignment, structural health, water seepage (Rail Rover); ATI detects rail cracks/corrugation/missing fasteners; AVI wayside sensors (collector-shoe wear, gearbox/axle temperature). | RAIL | **A/B** | AR2024; LTA 2017 factsheet; LTA C851E release | as above | quoted | HIGH | —
- **Claim:** Electrification per line: NEL 1,500 V DC overhead catenary (only OCS line); DTL and SK/PG LRT 750 V DC third rail. | RAIL | **A/B/C** | LTA pages; Wikipedia; SBS Rail Rover ("third-rail alignment") | as above | — | HIGH | **Correction vs initial research premise:** NEL is not 750 V third rail.
- **Claim:** Standard gauge 1,435 mm (MRT); SPLRT gauge 1,850 mm. | RAIL | **C** | Wikipedia | as above | — | MEDIUM | —
- **Claim:** Safety-critical: RTSA Part 4 "Safety of Railway"; NRFF OPS safety dimension; VAnGuard track-intrusion detection (29 LRT stations, OCC cuts traction power); named exercises (High Flame, Phoenix, High Waters, Escape Shaft, Station Guard); rail WIR −34.4% (2024); 5 workplace injuries (2025). | RAIL | **A/B** | AR2024/2025; LTA; SSO | as above | quoted | HIGH | —
- **Claim:** Return-to-service criteria and LTA submission formats (work-order/fault data models, wheel-wear thresholds, interval schedules). | RAIL | — | — | — | — | — | **NOT PUBLICLY VERIFIED.**
- **Claim (comparable):** UK RSSB GMRT2466 wheelsets (tread profile, flange-thickness limits); wheel-profile parameters (flange height/width, qR, angle, rim thickness, back-to-back gauge, diameter); door-cycle-count maintenance; EN 15380 function groups; IEC 61375 TCN; UIC 438-3/EVN. | RAIL | **C** | RSSB catalogue; KLD Labs; Wikipedia IEC 61375/UIC; BSI/ANSI EN 15380 | as above | quoted | MEDIUM-HIGH | Standards/precedent only; NOT SBS thresholds. EN 15380 detail NOT PUBLICLY VERIFIED in OEM brief.

---

## D. CROSS-CUTTING / STANDARDS / KNOWLEDGE-SCOPE CLAIMS

- **Claim:** Knowledge-hierarchy hypothesis (GLOBAL → ORGANIZATION → DOMAIN/SUBDOMAIN → USER-UPLOADED) is a product hypothesis to evaluate, not an SBS fact. | — | **D** | contract §8 | docs/PRE_FREEZE_RESEARCH_CONTRACT.md | — | — | Design hypothesis; isolation requirement testable (see 07, 08, 09).
- **Claim:** SBS uses structured/versioned knowledge and digitised work instructions already (tablets, e-manuals, Maximo, Stratio) — supports structured-knowledge + RAG split. | BUS/RAIL | **A** | Green Efforts; AR2024; SBS+IBM release | as above | — | HIGH | —
- **Claim (comparable):** ISO 14224 (nine-level equipment taxonomy; equipment/failure/maintenance data categories; failure-mode/cause/mechanism/consequence); EN 13306 (preventive/corrective/condition-based vocabulary); ISO 55000 series (life-cycle asset management; SBS rail already ISO 55001-certified — A); 49 CFR 625 (US transit asset registers); 14 CFR §43.9 (record+sign-off for return-to-service). | BOTH | **C** (standards) / **A** (ISO 55001 certification) | Wikipedia ISO 14224; en-standard.eu EN 13306; ISO/TC251; Cornell eCFR; AR2024 | as above | quoted | HIGH | Standards are comparable-industry models; SBS's ISO 55001 certification is SBS-reported (A).

---

## E. NOT PUBLICLY VERIFIED REGISTER (consolidated)

| # | Item | Why it matters | Affects |
| --- | --- | --- | --- |
| 1 | SBS bus internal fault-code catalogue & OEM diagnostic codes (J1939/Stratio parameter catalogue) | fault-code fact schema | Bus schema |
| 2 | SBS bus work-order / defect-log / service-record field formats | fact + report schema | Bus schema |
| 3 | SBS bus preventive-maintenance interval schedules (km/month values) | workflow model | Bus workflow |
| 4 | SBS bus fleet-number convention (internal number alongside VRN) | identifiers | Bus schema |
| 5 | SBS bus parts catalog & part-number conventions | parts replacement facts | Bus schema |
| 6 | SBS bus return-to-service / defect-deferral / escalation states | completion states | Bus workflow |
| 7 | SBS bus tyre-tread/brake/emission numeric thresholds | measurements | Bus schema |
| 8 | SBS bus technician role/shift/career details | roles | Bus workflow |
| 9 | SBS bus current make/model census + per-model allocations | asset taxonomy | Knowledge |
| 10 | Depot-by-depot maintenance scope (routine vs overhaul vs HV) | workflow/deport metadata | Knowledge |
| 11 | Rail internal maintenance schedules (daily/day-km/overhaul cycles) | rail workflow | Rail workflow |
| 12 | Rail train-borne fault-code taxonomy & work-order screen formats | rail fact schema | Rail schema |
| 13 | Rail wheel-wear / brake-wear thresholds (mm) | measurements | Rail schema |
| 14 | Rail depot machine inventory (wheel lathe, underfloor lifts) | asset taxonomy | Knowledge |
| 15 | Rail car-set/train identifiers in official register | identifiers | Rail schema |
| 16 | RTSA provision-level duties (Part 4 safety; licensing) + Railway Safety regulations text | regulatory reporting | Rail compliance |
| 17 | RTA/PSV provision-level inspection + accident-reporting text | statutory records | Bus compliance |
| 18 | BCM contract schedules (maintenance standards values; penalty mechanics) | regulatory reporting | Bus compliance |
| 19 | NRFF penalty values + maintenance-plan/fault-trend submission formats | regulatory reporting | Rail compliance |
| 20 | LTA bus/rail reliability framework numeric thresholds beyond MKBF/BSRF | KPI validation | Evals |
| 21 | LTA Code of Practice for bus maintenance / depot safety (may not exist publicly) | regulatory reporting | Bus compliance |
| 22 | LTA/SBS station-code dictionary (NE1-style) and dataset schemas | identifiers | Knowledge |
| 23 | Bus-side CMMS/work-order system name (Maximo is rail-only partnership) | system integration | Bus workflow |
| 24 | SBS report templates actually used (paper/PDF/DMS formats) | report schema | Report schema |
| 25 | Whether SBS would authorize user uploads of manuals/historical reports | user-upload scope | 09/10/11 |

---

*End of 02_SBS_EVIDENCE_AUDIT.md*
