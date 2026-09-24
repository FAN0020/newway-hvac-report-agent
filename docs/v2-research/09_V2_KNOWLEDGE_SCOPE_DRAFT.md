# 09 — V2 Knowledge-Scope Draft (SBS Bus / SBS Rail / HVAC)

Status: DRAFT FOR PRE-FREEZE RESEARCH (not frozen)
Governing contract: `docs/PRE_FREEZE_RESEARCH_CONTRACT.md` (sections 3, 8, 9, 10, 13)
Baseline: current HVAC-only V1 implementation (`data/knowledge/*.v1.json`, versioned
correction rules, facts receipts, report modules).

---

## 1. Purpose and scope of this document

This document evaluates, rather than blindly assumes, the knowledge-hierarchy hypothesis in
contract §8:

> GLOBAL -> ORGANIZATION -> DOMAIN/SUBDOMAIN -> USER-UPLOADED KNOWLEDGE

It proposes a first-version scope model, an isolation invariant, a structured-vs-RAG split
(contract §9), and a first-version user-upload ingestion contract (contract §10). It also
frames the mandatory user-upload acceptance test (contract §13) as a scope/isolation test.

Every claim about the domain is tagged with an evidence level per contract §6:
- A = SBS-specific evidence; B = Singapore transport-sector evidence;
- C = comparable-industry evidence; D = inference/assumption.
Design decisions that are not yet backed by SBS evidence are tagged `REQUIRES SBS CONFIRMATION`
or `NOT PUBLICLY VERIFIED` where applicable. C/D evidence is never rewritten as an SBS fact.

---

## 2. Baseline: how V1 scopes knowledge today

From the existing repository (`data/knowledge/hvac-terms.v1.json`,
`data/knowledge/hvac-parts.v1.json`, `data/knowledge/report-modules.v1.json`, README):

| Baseline property | Value | Evidence |
| --- | --- | --- |
| Scope | HVAC only; one implicit domain scope | A (repository baseline) |
| Knowledge kinds | `term` (correction rules + risk tags), `part` (aliases, spec patterns), `report-module` (fixed/conditional sections, required fields) | A (repository baseline) |
| Versioning | `schema_version`, `knowledge_version` per file; receipts bind knowledge version | A (repository baseline) |
| Retrieval boundary | correction candidates come only from the server-side versioned vocabulary; browser cannot inject candidates | A (repository baseline) |
| Integrity | immutable raw transcript; correction receipt bound to candidate-set hash and final-text hash; facts receipt bound to correction receipt | A (repository baseline) |

V1 therefore already implements a de-facto "one domain, server-owned, versioned knowledge"
model. V2's knowledge scope must preserve: versioned knowledge, server-side candidate sets,
hash-bound receipts, and the invariant that knowledge assists interpretation but never
creates service facts (contract §3).

---

## 3. Candidate hierarchy (contract §8) and evaluation

### 3.1 Hierarchy under evaluation

```
GLOBAL                          (e.g., shared units, shared safety rules, Singapore-specific norms)
└── ORGANIZATION                (e.g., SBS Transit; possibly Newway for HVAC)
    ├── DOMAIN / SUBDOMAIN
    │   ├── SBS / BUS           (bus maintenance knowledge)
    │   │   └── USER UPLOADS    (documents uploaded into the Bus scope)
    │   ├── SBS / RAIL          (rail maintenance knowledge)
    │   │   └── USER UPLOADS    (documents uploaded into the Rail scope)
    │   └── HVAC                (existing V1 scope; preserved for compatibility)
    │       └── USER UPLOADS    (documents uploaded into the HVAC scope)
```

This is the candidate from contract §8, presented verbatim with HVAC preserved as a
sibling domain (contract §1: "HVAC (existing; preserve compatibility)").

### 3.2 Evaluation against evidence

| Question | Finding | Evidence level | Status |
| --- | --- | --- | --- |
| Is there evidence of an SBS organization-level knowledge corpus (e.g., manuals, SOPs)? | SBS Transit technicians use tablets for "work instructions, drawings, electrical schematics and parts information" and access "the bus manufacturers' portal … e-manuals" (SBS Transit Green Efforts page). Rail: maintenance centre at NEL depot for MCEM91 point machines, LTSS contracts with Siemens Mobility (signalling) and Motorola (TETRA radio), IBM Maximo integration — all imply substantial organizational maintenance documentation. | A | CONFIRMED BY EVIDENCE (existence of organizational knowledge); internal structure NOT PUBLICLY VERIFIED |
| Is there evidence of a formal GLOBAL layer (SG-wide)? | LTA/OneMotoring impose Singapore-wide inspection rules for omnibuses (6-monthly periodic inspection; CNG/bifuel 3-monthly; braking-efficiency, emission and noise checks) and rail asset-maintenance regulatory reporting (annual maintenance plans, fault trends analyses) under the NRFF regulatory framework. These are cross-operator (SBS and SMRT alike), i.e., Singapore-transport-scope knowledge. | B | CONFIRMED BY EVIDENCE (a Singapore-transport layer exists); whether V2 should model it as "GLOBAL" or "SINGAPORE-TRANSPORT" is a design decision |
| Is there evidence that Bus and Rail knowledge must be separated? | SBS Transit operates bus and rail as distinct businesses with distinct assets (bus fleet vs trains/depots), distinct regulatory regimes (BCM/QoS for buses; RTSA/NRFF for rail), distinct depots and workforces. No public evidence mixes bus and rail maintenance knowledge into one corpus. | A/B | PROVISIONAL — separation justified; exact boundary REQUIRES SBS CONFIRMATION |
| Is there evidence for finer subdivision (e.g., by line or by package)? | Bus depots are tied to bus packages (SBS Transit moved out of Soon Lee Depot when the Jurong West Bus Package expired; took over Sengkang West Depot; AR2024). Rail depots are line-specific (Bishan NEL, Gali Batu DTL, Sengkang). This hints that depot/package-scoped documents may be needed. | A | PROVISIONAL — recommend treating depot/package/line as *metadata on user uploads* rather than separate knowledge scopes, unless SBS confirms otherwise (contract §8: "Recommend further Bus/Rail subdivisions only when domain evidence materially justifies them") |
| Does HVAC need to stay isolated from SBS scopes? | V1 is HVAC-only; nothing in the baseline or public evidence suggests HVAC and SBS maintenance knowledge should mix. | A (baseline) | CONFIRMED BY EVIDENCE — isolation required |

### 3.3 Isolation invariant (testable)

The core isolation requirement from contract §8, restated as an executable invariant:

> For any active scope S (e.g., SBS/BUS), retrieval, correction-candidate generation, fact
> interpretation and report generation may consult only the scopes explicitly inherited by S:
> S itself, S's ancestors in the hierarchy (e.g., SBS, ORGANIZATION, GLOBAL), and documents
> explicitly bound to S. It must never retrieve knowledge from a sibling scope (e.g., HVAC,
> SBS/RAIL) or from another organization's uploads. User-uploaded knowledge remains bound to
> its authorized scope unless an explicit, audited reclassification moves it.

Testable consequences (used by the eval spec, `07_V2_EVAL_SPEC_DRAFT.md`, and the mandatory
upload acceptance test, contract §13):

1. Cross-domain retrieval isolation: queries in SBS/BUS context never surface HVAC or SBS/RAIL
   terms/manuals.
2. Cross-upload isolation: a document uploaded into SBS/BUS is retrievable only from SBS/BUS
   (and only by users authorized for SBS/BUS).
3. No implicit promotion: a manual's "replace component X" text is knowledge/context, never a
   fact that "X was replaced" (contract §3 invariant).

---

## 4. Scope model (proposed first version)

### 4.1 Scope identifiers

Proposed (PROVISIONAL — REQUIRES SBS CONFIRMATION):

```
scope_id := "global" | "org:<org>" | "domain:<org>:<domain>" | "subdomain:<org>:<domain>:<sub>"
examples:
  global
  org:sbs
  domain:sbs:bus
  domain:sbs:rail
  domain:newway:hvac            (V1 HVAC preserved)
  subdomain:sbs:bus:depot:<id>  (only if SBS confirms depot-scoped knowledge is needed)
```

Scope inheritance: `domain:sbs:bus` inherits `org:sbs` and `global`. `org:sbs` inherits
`global`. User uploads are always bound to exactly one scope_id and inherit that scope's
ancestors, but never its siblings.

### 4.2 What lives at each level (proposal with evidence)

| Level | Candidate contents | Evidence that such content exists | Evidence level |
| --- | --- | --- | --- |
| GLOBAL | units & unit-normalization rules; shared safety-critical field semantics (negation, numbers, units); generic maintenance terminology that is not domain-specific | Singapore norms for units/measures used across bus and rail (km, mm, V, °C, bar/kPa); generic "maintenance action" lexicon | B for units conventions; D for exact contents — PROVISIONAL |
| ORGANIZATION (sbs) | SBS-specific identifiers and conventions: bus fleet numbering / vehicle registration plates, train car-set numbers, depot names, station codes, line codes, business-unit taxonomy (Bus/Rail), technician role titles | SBS Transit public pages and AR2024 (fleet 3,329 buses; 198 trains; depots; 81 stations) | A — the *facts*; their *use as knowledge* PROVISIONAL |
| DOMAIN (sbs:bus) | bus maintenance vocabulary, part catalogs, OEM fault-code families, inspection checklist items (statutory), e-bus HV safety terms (WSQ NESS), depot/package metadata | SBS Green Efforts page (tablets, e-manuals, manufacturer portal), AR2024 (Stratio telematics: "brakes, fluid levels, and electric systems"), OneMotoring inspection checklist | A/B |
| DOMAIN (sbs:rail) | rail asset vocabulary, rolling-stock types (C751A/C751C/C851E, C951, Crystal Mover), subsystem terms (traction, bogie, door, HVAC, signalling, third rail/OCS, point machines, CBTC), depot/line metadata | LTA NEL/DTL/SPLRT pages; AR2024 (Rail Rover, MCEM91, Trainguard Sirius, AVATAR) | A/B |
| DOMAIN (newway:hvac) | existing V1 hvac-terms/hvac-parts/report-modules | repository baseline | A (baseline) |
| USER UPLOADS | uploaded PDF/DOCX/TXT/CSV bound to one scope_id, with provenance + scenario metadata (see §6) | contract §10; no public SBS evidence needed (it is a product capability, not an SBS practice) | D (design) — REQUIRES SBS CONFIRMATION for per-depot binding |

### 4.3 What must NOT be in any knowledge scope

- Service facts (what was observed/repaired on a specific asset today). Those belong to
  transcript/facts receipts only (contract §3 invariant).
- Anything that could turn "manual recommends X" into "X happened".

---

## 5. Structured knowledge vs RAG (contract §9)

V2 must not assume all knowledge belongs in embeddings. The proposed split:

| Knowledge kind | Storage | Rationale | Evidence |
| --- | --- | --- | --- |
| Terminology, aliases, correction rules | Structured, versioned (V1 `hvac-terms.v1.json` pattern) | Needs exact matching, candidate-set hashing, auditability; V1 already does this | A (baseline); V1 pattern |
| Part/component catalogs, allowed spec patterns | Structured, versioned (V1 `hvac-parts.v1.json` pattern) | Needs validation patterns, part numbers, units checks | A (baseline); V1 pattern |
| Asset identifiers (bus fleet numbers, train numbers, depot codes, station codes, line codes) | Structured lists with provenance | Must be exact and versioned; wrong identifier is a critical error | A (facts publicly known); design D |
| Allowed units and unit-normalization rules | Structured | Number/unit integrity is a hard-failure category | B (units conventions); design D |
| Fault-code families (OEM diagnostic codes, J1939/EOBD for buses; train-borne diagnostics for rail) | Structured where code lists are finite and versioned; RAG only for descriptive prose around codes | Codes must match exactly | C (comparable-industry standards); NOT PUBLICLY VERIFIED for SBS-specific code lists |
| Hard validation rules (inspection checklist items, statutory requirements, required report fields) | Structured (V1 `report-modules.v1.json` pattern) | Deterministic validation; independent Validator | A (baseline) / B (statutory items) |
| Manuals, SOPs, maintenance guides, historical documents, user uploads | RAG (embeddings + chunk index) | Long-form prose, retrieval of passages, user uploads (contract §9: "RAG suitability for manuals, SOPs, maintenance guides, historical documents and supported user uploads") | C (industry practice) / D (design) |
| Safety-critical semantic rules (negation, completion state, return-to-service) | Structured rules + Validator checks, not RAG | Cannot be left to fuzzy retrieval; hard gates | A (V1 risk tags: NEGATION, CRITICAL_VALUE, MEASUREMENT) |

Design rule: any knowledge that must be *exact* (identifiers, codes, units, numbers, required
fields, correction candidates) is structured; any knowledge that is *explanatory prose*
(manuals, SOPs, how-to guides) is RAG. This mirrors V1's existing split
(term/part JSON vs nothing-RAG-yet) and keeps the critical-error gates deterministic.

---

## 6. User-upload hypothesis and first-version ingestion contract (contract §10)

### 6.1 Supported types (first version)

PDF, DOCX, TXT, CSV — exactly the candidates named in contract §10.

### 6.2 Intended UX

```
Upload -> Processing -> Parsed/Chunked/Indexed -> READY
```

- Upload is bound to the active scope (e.g., SBS/BUS) at upload time; the scope is recorded,
  not inferred later.
- Processing is asynchronous; status must be observable (`PROCESSING`, `FAILED`, `READY`).
- On failure (e.g., unparseable binary, password-protected PDF), the document is marked
  `FAILED` with a reason; it must never be partially indexed.
- READY means: parsed, chunked, indexed, and retrievable only within its bound scope.

### 6.3 Provenance and scenario metadata (contract §10)

Every uploaded document record carries:

```
document_id            (server-generated, immutable)
scope_id               (authorized scope at upload time; reclassification is an explicit audit event)
file_name, content_type, size_bytes, sha256
source                ("user_upload:<user_id>")
scenario              (e.g., "bus_depot_manual", "rail_line_sop", "hvac_service_guide"; free-text + normalized tags)
uploaded_at, uploaded_by
processing            (status, started_at, finished_at, chunk_count, error if any)
retrieval_meta        (chunking parameters, index version)
```

### 6.4 Boundaries (contract §10)

V2 research does NOT require solving: scanned-document OCR, engineering drawings, circuit
diagrams, image/video understanding, or multimodal RAG — unless evidence establishes them as
indispensable. They are recorded as future scope/unknowns (see `10_SBS_INFORMATION_GAPS.md`).

| Boundary | First version | Future scope |
| --- | --- | --- |
| Scanned/image-only PDF | Not supported (mark FAILED or "requires OCR") | OCR, if SBS confirms paper-only SOPs are prevalent |
| Drawings/diagrams | Not interpreted | CAD/image understanding if required |
| Multimodal | Not in scope | Only if evidence establishes it as indispensable |

---

## 7. Mapping to the mandatory user-upload acceptance test (contract §13)

The scope model must satisfy the ZX-47 test. Draft trace (full case spec in
`07_V2_EVAL_SPEC_DRAFT.md` §8):

1. Before upload: SBS/BUS scope does not know "ZX-47" (verified by a retrieval probe).
2. Upload `auxiliary-door-control-module.pdf` into SBS/BUS: parse -> chunk -> index -> READY.
3. Noisy transcript "ZX forty seven has intermittent failure": scoped retrieval within SBS/BUS
   surfaces the ZX-47 entry and assists correction to "ZX-47".
4. The document says "replace ZX-47 when failing"; the transcript does not say replacement
   happened: facts/report MUST NOT state "ZX-47 replaced" (contract §13 and §3 invariant).
5. The same document must NOT be retrievable from SBS/RAIL or HVAC contexts (isolation).

This test exercises: ingestion, retrieval, scope isolation, correction, fact grounding, and
report grounding — the six capabilities named in contract §13.

---

## 8. Open questions (see also `10_SBS_INFORMATION_GAPS.md`)

- Whether SBS wants depot/package/line-scoped uploads (Bus depots are contract-package-bound;
  rail depots are line-bound) — PROVISIONAL, REQUIRES SBS CONFIRMATION.
- Whether "GLOBAL" should be modelled as Singapore-transport-scope (LTA-level knowledge) vs a
  truly generic layer — REQUIRES SBS CONFIRMATION.
- Whether uploaded historical maintenance reports (if SBS ever provides them) belong in RAG or
  in structured fact corpora — REQUIRES SBS CONFIRMATION; NOT PUBLICLY VERIFIED that SBS would
  authorize such uploads at all.
- OCR/drawings — future scope unless evidence changes (contract §10).

---

*End of 09_V2_KNOWLEDGE_SCOPE_DRAFT.md*
