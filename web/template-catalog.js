/**
 * Predefined maintenance templates. This module is shared by the browser and
 * server so every surface uses the same immutable template contract.
 * Prototype classification is deliberate: none of the SBS forms is an
 * official SBS Transit form.
 */

const STATUS_VALUES = Object.freeze(['NOT_CHECKED', 'OK', 'NOT_OK', 'N/A']);
const HANDOVER_VALUES = Object.freeze(['NOT_CHECKED', 'READY', 'NOT_READY', 'DEFERRED']);

function field(id, label, section, displayOrder, options = {}) {
  return Object.freeze({
    id,
    label,
    section,
    displayOrder,
    type: 'string',
    required: false,
    critical: false,
    inferencePolicy: 'EVIDENCE_OR_TECHNICIAN_INPUT',
    renderer: options.allowedStatuses ? 'status-control' : 'text-control',
    ...options,
  });
}

function identity(domain, labels = {}) {
  const bus = domain === 'SBS_BUS';
  const values = bus
    ? [
      ['work.work_order_id', 'Work Order No.', true], ['work.date_time', 'Date / Time', true],
      ['asset.internal_fleet_no', 'Bus / Fleet ID', true], ['asset.registration_no', 'Registration No.', false],
      ['asset.bus_model', 'Make / Model', true], ['measurement.odometer_km', 'Odometer', true, 'number'],
      ['asset.depot', 'Depot / Location', true], ['technician.name', 'Technician', true],
    ]
    : [
      ['work.order_id', 'Work Order No.', true], ['work.date_time', 'Date / Time', true],
      ['asset.line', 'Line', true], ['asset.station_section', labels.station || 'Station / Section', true],
      ['asset.track_direction', 'Track / Direction', true], ['asset.location', labels.location || 'Chainage / Location', true],
      ['access.approval', 'PTW / Access Reference', true, 'string', true], ['technician.name', 'Technician / Team', true],
    ];
  return values.map(([id, label, required, type = 'string', critical = false], index) =>
    field(id, label, 'Job identity', index + 1, { required, type, critical, renderer: type === 'number' ? 'measurement-control' : 'text-control' }));
}

function checklist(rows, start = 20) {
  return rows.flatMap(([slug, label], index) => [
    field(`check.${slug}.status`, label, 'Inspection checklist', start + index * 3, {
      type: 'status', required: true, critical: /safety|door|exit|access|handover|protection/u.test(slug),
      allowedStatuses: STATUS_VALUES, renderer: 'status-control',
    }),
    field(`check.${slug}.observation`, `${label} — finding / measurement`, 'Inspection checklist', start + index * 3 + 1, {
      type: 'text', renderer: 'evidence-text-control',
    }),
    field(`check.${slug}.action`, `${label} — action / remarks`, 'Inspection checklist', start + index * 3 + 2, {
      type: 'text', renderer: 'evidence-text-control',
    }),
  ]);
}

function completion(domain, fields) {
  return fields.map(([id, label, required = true, critical = false, type = 'text', allowedValues], index) =>
    field(id, label, 'Completion and handover', 80 + index, {
      required, critical, type, allowedValues,
      renderer: type === 'status' ? 'status-control' : 'evidence-text-control',
      requiresTechnicianConfirmation: critical,
    }));
}

const PUBLIC_SOURCES = Object.freeze({
  bus: Object.freeze([
    Object.freeze({ title: 'SBS Transit public corporate context', url: 'https://www.sbstransit.com.sg/', provenance: 'official external context source', usage: 'Terminology context only; not job evidence.' }),
    Object.freeze({ title: 'LTA public industry resources', url: 'https://www.lta.gov.sg/content/ltagov/en/industry_innovations/industry_matters/development_construction_specifications_resources.html', provenance: 'official external context source', usage: 'Public metadata and terminology only.' }),
  ]),
  rail: Object.freeze([
    Object.freeze({ title: 'SBS Transit rail engineering and maintenance collaboration', url: 'https://www.sbstransit.com.sg/news/sbs-transit-and-st-kinetics-collaborate-to-strengthen-rail-engineering-and-maintenance-capabilities', provenance: 'official external context source', usage: 'Public rail-maintenance context only; not job evidence.' }),
    Object.freeze({ title: 'LTA transport infrastructure design criteria page', url: 'https://www.lta.gov.sg/content/ltagov/en/industry_innovations/industry_matters/development_construction_specifications_resources/Transport_Infrastructure_Design_Criteria_and_Specifications.html', provenance: 'official external context source', usage: 'Public metadata only. Restricted chapters are not ingested.' }),
    Object.freeze({ title: 'TR 85:2021 preview', url: 'https://www.singaporestandardseshop.sg/Product/GetPdf?fileName=210323092412TR+85-2021+Preview.pdf&pdtid=b4816ac4-7466-43a7-a307-3ac4880395c5', provenance: 'official external context source', usage: 'Lawfully available preview metadata only; no full standard text.' }),
  ]),
  conductor: Object.freeze([
    Object.freeze({ title: 'TR 126:2024 product overview', url: 'https://www.singaporestandardseshop.sg/Product/SSPdtDetail/5b6304aa-2cc3-4a87-a7a1-e33e71fd7695', provenance: 'official external context source', usage: 'Public scope metadata only; paywalled standard is not ingested.' }),
  ]),
});

function makeTemplate({ templateId, name, domain, provenance, fields, contextSources, description, sourceFilename, sourceSha256, organizationLabel, reportFamily, searchAliases = [] }) {
  const version = '1.0.0';
  const operationalCategory = domain === 'HVAC' ? 'HVAC' : domain === 'SBS_BUS' ? 'Bus' : 'Rail';
  return Object.freeze({
    templateId,
    name,
    description,
    domain,
    status: 'PUBLISHED',
    templateVersion: version,
    presentation: Object.freeze({
      displayName: name,
      shortDescription: description,
      organizationLabel,
      operationalCategory,
      reportFamily,
      searchAliases: Object.freeze(searchAliases),
      technicianVisible: true,
    }),
    provenance: Object.freeze({ classification: provenance, official: false, notice: 'Prototype template — not an official SBS Transit form.' }),
    sourceArtifact: Object.freeze({
      kind: domain === 'HVAC' ? 'repository-template' : 'research-pack-prototype',
      filename: sourceFilename,
      sourcePack: domain === 'HVAC' ? 'existing Newway HVAC template' : 'SBS Transit Expanded Template Research Pack 2',
      classification: provenance,
      sha256: sourceSha256,
      preserved: true,
    }),
    schema: Object.freeze({
      id: `${templateId}-schema`, version,
      fields: Object.freeze(fields),
      missingnessPolicy: 'REQUIRED_FIELDS_REMAIN_UNRESOLVED_UNTIL_EVIDENCE_OR_TECHNICIAN_INPUT',
      positiveStatusPolicy: 'NEVER_INFER_FROM_SILENCE',
    }),
    contextCorpus: Object.freeze({
      id: `${templateId}-context`, version,
      retrievalBoundary: 'TEMPLATE_VERSION_ONLY',
      jobFactPolicy: 'CONTEXT_MUST_NOT_ASSERT_JOB_FACTS',
      sources: Object.freeze(contextSources || []),
    }),
    rendererMapping: Object.freeze({
      id: 'maintenance-workspace', version: '1.0.0', export: 'template-table-pdf',
      pdfLayout: `${templateId}.prototype.v1`,
    }),
    adapter: Object.freeze({ id: domain === 'HVAC' ? 'hvac-v1' : domain === 'SBS_BUS' ? 'sbs-bus-v1' : 'sbs-rail-v1', version: '1.0.0' }),
  });
}

const HVAC_FIELDS = [
  field('work_order', 'Work order', 'Job identity', 1, { required: true }),
  field('equipment', 'Equipment', 'Job identity', 2, { required: true }),
  field('customer_complaint', 'Customer complaint', 'Service work', 10, { required: true }),
  field('inspection_findings', 'Inspection findings', 'Service work', 11, { required: true }),
  field('work_performed', 'Work performed', 'Service work', 12, { required: true }),
  field('test_results', 'Test results', 'Completion and handover', 80, { required: true, critical: true, requiresTechnicianConfirmation: true }),
  field('completion_status', 'Completion status', 'Completion and handover', 81, { required: true, critical: true, requiresTechnicianConfirmation: true }),
];

const BUS_PM_FIELDS = [
  ...identity('SBS_BUS'),
  ...checklist([['engine_fluids', 'Engine and fluids'], ['brakes', 'Brakes'], ['tyres', 'Tyres and wheels'], ['electrical', 'Electrical system'], ['passenger_safety', 'Passenger safety equipment'], ['post_service', 'Post-service checks']]),
  ...completion('SBS_BUS', [
    ['inspection_findings', 'Defects / findings'], ['work_performed', 'Corrective work'], ['parts.part_number', 'Parts used', false],
    ['test.result', 'Test result', true, true], ['completion.outstanding_issues', 'Outstanding issues'],
    ['completion.state', 'Final condition', true, true, 'status', HANDOVER_VALUES],
  ]),
];

const BUS_DEFECT_FIELDS = [
  ...identity('SBS_BUS'),
  field('work.trigger', 'Complaint / trigger', 'Diagnosis', 20, { required: true }),
  field('inspection_findings', 'Inspection findings', 'Diagnosis', 21, { required: true }),
  field('diagnosis.root_cause', 'Root cause', 'Diagnosis', 22, { required: true }),
  field('work_performed', 'Work performed', 'Rectification', 30, { required: true }),
  field('parts.part_number', 'Parts / materials', 'Rectification', 31),
  field('measurement.*', 'Measurements', 'Rectification', 32, { type: 'measurement', repeating: true, renderer: 'measurement-control' }),
  ...completion('SBS_BUS', [
    ['test.result', 'Post-work test', true, true], ['completion.outstanding_issues', 'Outstanding issues'],
    ['completion.state', 'Return to service / handover', true, true, 'status', HANDOVER_VALUES],
  ]),
];

const BUS_DOOR_FIELDS = [
  ...identity('SBS_BUS'),
  field('work.description', 'Reported issue / work scope', 'Inspection checklist', 19),
  ...checklist([['front_door', 'Front passenger door'], ['rear_door', 'Rear passenger door'], ['door_sensors_interlocks', 'Door sensors and interlocks'], ['emergency_exits', 'Emergency exits'], ['accessibility_equipment', 'Accessibility equipment'], ['warning_alarms', 'Warning and alarm devices']]),
  ...completion('SBS_BUS', [
    ['inspection_findings', 'Defects found'], ['work_performed', 'Corrective work'],
    ['test.result', 'Functional test', true, true], ['completion.state', 'Final safety status', true, true, 'status', HANDOVER_VALUES],
  ]),
];

const RAIL_TRACK_FIELDS = [
  ...identity('SBS_RAIL'),
  ...checklist([['rail_visual', 'Rail visual condition'], ['track_geometry', 'Track geometry'], ['fastenings', 'Fastenings'], ['sleepers', 'Sleepers'], ['joints_welds', 'Joints and welds'], ['environment', 'Track environment']]),
  ...completion('SBS_RAIL', [
    ['inspection_findings', 'Defects and exact locations'], ['work_performed', 'Corrective work'],
    ['completion.outstanding_issues', 'Outstanding issues'], ['completion.follow_up', 'Follow-up required'],
    ['completion.state', 'Final track condition', true, true, 'status', HANDOVER_VALUES],
    ['handover.verification', 'Handover / verification', true, true],
  ]),
];

const PLAIN_RAIL_FIELDS = [
  ...identity('SBS_RAIL'),
  ...checklist([['qualified_team', 'Qualified team confirmed'], ['tools_calibration', 'Tools and calibration'], ['ppe_toolbox', 'PPE and toolbox briefing'], ['possession_access', 'Possession / access control'], ['general_condition', 'General rail condition'], ['cracks', 'Cracks'], ['wear', 'Wear'], ['joints', 'Joints'], ['creep', 'Rail creep']]),
  ...completion('SBS_RAIL', [
    ['completion.outstanding_issues', 'Outstanding defects'], ['completion.follow_up', 'Follow-up'],
    ['handover.area_cleared', 'Area cleared and tools accounted', true, true], ['handover.verification', 'Permit / handover closure', true, true],
  ]),
];

const CONDUCTOR_FIELDS = [
  ...identity('SBS_RAIL'),
  ...checklist([['qualified_team', 'Qualified team confirmed'], ['ppe_toolbox', 'PPE and briefing'], ['conductor_rail', 'Conductor / third rail'], ['supports_insulators', 'Supports and insulators'], ['fastenings', 'Fastenings'], ['alignment_clearance', 'Alignment and clearance'], ['expansion_joints', 'Expansion and joints'], ['arcing_overheating', 'Arcing / overheating / damage']]),
  ...completion('SBS_RAIL', [
    ['inspection_findings', 'Defects / outstanding items'], ['work_performed', 'Corrective work'],
    ['handover.area_cleared', 'Area cleared', true, true], ['handover.verification', 'Handover / permit closure', true, true],
  ]),
];

const RAIL_HANDOVER_FIELDS = [
  ...identity('SBS_RAIL'),
  field('work.trigger', 'Trigger / fault', 'Maintenance record', 20, { required: true }),
  field('inspection_findings', 'Findings', 'Maintenance record', 21, { required: true }),
  field('work_performed', 'Work performed', 'Maintenance record', 22, { required: true }),
  field('parts.part_number', 'Parts / materials', 'Maintenance record', 23),
  field('test.result', 'Measurements / test results', 'Maintenance record', 24, { required: true, critical: true, requiresTechnicianConfirmation: true }),
  ...completion('SBS_RAIL', [
    ['completion.outstanding_issues', 'Outstanding items'], ['handover.area_cleared', 'Area cleared / housekeeping', true, true],
    ['handover.tools_accounted', 'Tools and protection devices accounted', true, true],
    ['handover.occ', 'OCC handover', true, true],
    ['completion.state', 'Return-to-service decision', true, true, 'status', HANDOVER_VALUES],
  ]),
];

const TEMPLATES = Object.freeze([
  makeTemplate({ templateId: 'hvac-service-report', name: 'HVAC Service Report', domain: 'HVAC', provenance: 'user-supplied prototype', description: 'Service findings, work, tests, and completion for HVAC equipment.', organizationLabel: 'Newway', reportFamily: 'HVAC service', searchAliases: ['air conditioning', 'cooling', 'ventilation'], fields: HVAC_FIELDS, contextSources: [], sourceFilename: 'hvac-service-report.v1.json', sourceSha256: 'c16394579e5bfbabab8f52e071b8ca20669a73179c1e595a5fd413556133d561' }),
  makeTemplate({ templateId: 'bus-preventive-maintenance-inspection', name: 'Bus Preventive Maintenance / Inspection', domain: 'SBS_BUS', provenance: 'research-derived prototype', description: 'Preventive bus inspection with evidence-backed checklist states.', organizationLabel: 'SBS Transit', reportFamily: 'Preventive maintenance', searchAliases: ['bus PM', 'scheduled inspection'], fields: BUS_PM_FIELDS, contextSources: PUBLIC_SOURCES.bus, sourceFilename: 'Bus_General_PM_Prototype.docx', sourceSha256: '86c0935105295f40e35827c4b8ded8411119c447f04e8b8189d79ec9f954c3d7' }),
  makeTemplate({ templateId: 'bus-defect-rectification-corrective-maintenance', name: 'Bus Defect Rectification / Corrective Maintenance', domain: 'SBS_BUS', provenance: 'research-derived prototype', description: 'Diagnosis, rectification, and safe handover of a reported bus defect.', organizationLabel: 'SBS Transit', reportFamily: 'Corrective maintenance', searchAliases: ['bus repair', 'fault rectification'], fields: BUS_DEFECT_FIELDS, contextSources: PUBLIC_SOURCES.bus, sourceFilename: 'Bus_Defect_Rectification_Prototype.docx', sourceSha256: 'faf6a2aff28c1b71f91955064bc4eda2ceadfdecb2737458af131d9b0567e50d' }),
  makeTemplate({ templateId: 'bus-passenger-door-safety-equipment-inspection', name: 'Bus Passenger Door / Safety Equipment Inspection', domain: 'SBS_BUS', provenance: 'research-derived prototype', description: 'Passenger-door and safety-equipment inspection.', organizationLabel: 'SBS Transit', reportFamily: 'Door and safety inspection', searchAliases: ['bus door', 'emergency equipment', 'passenger safety'], fields: BUS_DOOR_FIELDS, contextSources: PUBLIC_SOURCES.bus, sourceFilename: 'Bus_Door_Safety_Inspection_Prototype.docx', sourceSha256: '77e41dd5f2ceed3d68f7d43a77652272519a5c907a5cf0f6e20afa9573a2d03b' }),
  makeTemplate({ templateId: 'rail-track-inspection-maintenance', name: 'Rail Track Inspection / Maintenance', domain: 'SBS_RAIL', provenance: 'research-derived prototype', description: 'Track inspection, exact-location findings, and handover.', organizationLabel: 'SBS Transit', reportFamily: 'Track inspection', searchAliases: ['railway track', 'track maintenance'], fields: RAIL_TRACK_FIELDS, contextSources: PUBLIC_SOURCES.rail, sourceFilename: 'Rail_Track_Inspection_Prototype.docx', sourceSha256: '10439bb96bb1446c2ad66b982f8b5ba32659bce096b2327dbb26adbd60e320e0' }),
  makeTemplate({ templateId: 'plain-rail-preventive-inspection', name: 'Plain Rail Preventive Inspection', domain: 'SBS_RAIL', provenance: 'research-derived prototype', description: 'Preventive inspection for plain rail and access controls.', organizationLabel: 'SBS Transit', reportFamily: 'Plain rail inspection', searchAliases: ['running rail', 'rail PM'], fields: PLAIN_RAIL_FIELDS, contextSources: PUBLIC_SOURCES.rail, sourceFilename: 'Rail_Plain_Rail_PM_Prototype.docx', sourceSha256: '37fda7ed71e6afc989d50dc65ba2c0fa465b292bfba98e4a2e126dbb4da16303' }),
  makeTemplate({ templateId: 'conductor-third-rail-preventive-inspection', name: 'Conductor / Third-Rail Preventive Inspection', domain: 'SBS_RAIL', provenance: 'research-derived prototype', description: 'Conductor-rail condition and safety inspection.', organizationLabel: 'SBS Transit', reportFamily: 'Conductor rail inspection', searchAliases: ['third rail', 'power rail'], fields: CONDUCTOR_FIELDS, contextSources: [...PUBLIC_SOURCES.rail, ...PUBLIC_SOURCES.conductor], sourceFilename: 'Rail_Conductor_Rail_Inspection_Prototype.docx', sourceSha256: '81635770b0a38526b797829f2736a8321a1d50d97a6d4b478bd8632647235f0e' }),
  makeTemplate({ templateId: 'rail-maintenance-completion-handover', name: 'Rail Maintenance Completion / Handover', domain: 'SBS_RAIL', provenance: 'research-derived prototype', description: 'Maintenance completion, accountability, and return-to-service handover.', organizationLabel: 'SBS Transit', reportFamily: 'Maintenance handover', searchAliases: ['return to service', 'OCC handover', 'work completion'], fields: RAIL_HANDOVER_FIELDS, contextSources: PUBLIC_SOURCES.rail, sourceFilename: 'Rail_Maintenance_Handover_Prototype.docx', sourceSha256: '1c6c3e4e91ef37fdb9e391d7329a3b29ee3829bf46f5fd225c611e382436307c' }),
]);

const BY_ID = new Map(TEMPLATES.map((item) => [item.templateId, item]));

export const PREDEFINED_TEMPLATE_IDS = Object.freeze(TEMPLATES.map((item) => item.templateId));

export function listPredefinedTemplates() {
  return structuredClone(TEMPLATES);
}

export function templateFor(templateId) {
  const item = BY_ID.get(templateId);
  if (!item) throw new Error(`Unknown template: ${templateId}`);
  return structuredClone(item);
}

export function registerTemplate(template) {
  if (!template?.templateId || !template?.schema?.id || !template?.contextCorpus?.id) throw new TypeError('A complete template contract is required.');
  BY_ID.set(template.templateId, structuredClone(template));
  return templateFor(template.templateId);
}

function matchesField(pattern, candidate) {
  return pattern.endsWith('.*') ? candidate.startsWith(pattern.slice(0, -1)) : pattern === candidate;
}

export function mapFactsForTemplate(templateId, facts = []) {
  const item = templateFor(templateId);
  const allowed = item.schema.fields.map((entry) => entry.id);
  const accepted = [];
  const unsupportedFacts = [];
  for (const fact of facts) {
    if (allowed.some((pattern) => matchesField(pattern, fact.field))) accepted.push(structuredClone(fact));
    else unsupportedFacts.push(structuredClone(fact));
  }
  return { facts: accepted, unsupportedFacts };
}

export function templateIdForLegacyReportType(reportType) {
  const legacy = {
    HVAC: 'hvac-service-report',
    hvac_service: 'hvac-service-report',
    sbs_bus_maintenance: 'bus-defect-rectification-corrective-maintenance',
    SBS_BUS: 'bus-defect-rectification-corrective-maintenance',
    sbs_rail_maintenance: 'rail-maintenance-completion-handover',
    SBS_RAIL: 'rail-maintenance-completion-handover',
  };
  return legacy[reportType] || null;
}
