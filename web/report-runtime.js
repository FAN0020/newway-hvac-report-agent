function field(type = "string", options = {}) {
  return Object.freeze({ type, required: false, repeating: false, ...options });
}

const HVAC_FIELDS = Object.freeze({
  work_order: field("structured"),
  equipment: field("structured"),
  customer_complaint: field("string", { required: true }),
  inspection_findings: field("string", { required: true }),
  work_performed: field("string", { required: true }),
  parts_used: field("structured", { repeating: true }),
  test_results: field("string", { required: true }),
  completion_status: field("string", { required: true }),
  unresolved_issues: field("string"),
  follow_up_recommendations: field("string"),
  refrigerant_record: field("structured", { repeating: true }),
  measurements: field("structured", { repeating: true }),
  attachments: field("structured", { repeating: true }),
  cost_quote: field("structured"),
  warranty: field("structured"),
  customer_feedback: field("string"),
});

const BUS_FIELDS = Object.freeze({
  "asset.registration_no": field(), "asset.internal_fleet_no": field(), "asset.bus_model": field(),
  "asset.depot": field(), "asset.package": field(), "work.type": field(),
  "work.trigger": field(), "work.work_order_id": field(), "work.fault_code": field(), "work.description": field("string", { repeating: true }),
  inspection_findings: field("string", { repeating: true }), work_performed: field("string", { repeating: true }), "diagnosis.root_cause": field(),
  "parts.part_number": field(), "parts.replaced": field("boolean"),
  "measurement.odometer_km": field("number", { allowedUnits: ["km"] }),
  "measurement.*": field("number", { repeating: true, allowedUnits: ["km", "%", "bar", "kPa", "mm", "°C", "kWh", "MWh", "g/kWh", "V", "dB"] }),
  "test.result": field(),
  "completion.state": field("string", { allowedValues: ["completed", "deferred", "off-road", "out_of_service", "restricted_speed"], requiresTechnicianConfirmation: true }),
  "safety.*": field("structured", { repeating: true }), "compliance.*": field("structured", { repeating: true }),
  "audit.*": field("structured", { repeating: true }), "provenance.*": field("structured", { repeating: true }),
});

const RAIL_FIELDS = Object.freeze({
  "asset.line": field(), "asset.train_set": field(), "asset.car": field(), "asset.stock_class": field(), "asset.subsystem": field(),
  "work.type": field(), "work.trigger": field(), "work.order_id": field(), "work.fault_code": field(), "work.description": field("string", { repeating: true }),
  inspection_findings: field("string", { repeating: true }), work_performed: field("string", { repeating: true }), "diagnosis.root_cause": field(),
  "parts.part_number": field(), "parts.replaced": field("boolean"),
  "measurement.*": field("number", { repeating: true, allowedUnits: ["km", "train-km", "car-km", "mm", "V", "%", "°C", "min"] }),
  "test.result": field(), "access.approval": field(),
  "completion.state": field("string", { allowedValues: ["completed", "deferred", "off-road", "out_of_service", "restricted_speed"], requiresTechnicianConfirmation: true }),
  "safety.*": field("structured", { repeating: true }), "reliability.*": field("structured", { repeating: true }),
  "compliance.*": field("structured", { repeating: true }), "audit.*": field("structured", { repeating: true }),
  "provenance.*": field("structured", { repeating: true }),
});

const INDUSTRIAL_FIELDS = Object.freeze({
  "asset.equipment": field(), "asset.location": field(), "asset.voltage_level": field(),
  "work.type": field(), "work.description": field(), "standard.reference": field(),
  "inspection.item": field(), "inspection.observation": field(), "inspection.result": field(),
  "defect.description": field(), work_performed: field(),
  "measurement.*": field("number", { repeating: true, allowedUnits: ["kV", "V", "A", "mA", "m", "mm", "cm", "km", "%", "°C", "bar", "kPa", "MPa", "Ω·m", "ohm·m", "min"] }),
  "test.result": field(),
  "completion.state": field("string", { allowedValues: ["completed", "deferred", "out_of_service", "restricted_service"], requiresTechnicianConfirmation: true }),
  "safety.*": field("structured", { repeating: true }),
  "provenance.*": field("structured", { repeating: true }),
});

const BUS_GROUPS = Object.freeze([
  { id: "vehicle_identification", fields: ["asset.registration_no", "asset.internal_fleet_no", "asset.bus_model", "asset.depot", "asset.package", "measurement.odometer_km"], targetField: "asset.registration_no" },
  { id: "works_summary", fields: ["work.type", "work.trigger", "work.work_order_id", "work.description"], targetField: "work.description" },
  { id: "inspection_findings", fields: ["work.fault_code", "inspection_findings"], targetField: "inspection_findings" },
  { id: "work_performed", fields: ["work_performed"], targetField: "work_performed" },
  { id: "tests_results", fields: ["test.result", "measurement.*"], targetField: "test.result" },
  { id: "completion_state", fields: ["completion.state"], targetField: "completion.state" },
  { id: "safety_hv_notes", fields: ["safety.*"], targetField: "safety.technician_note" },
  { id: "compliance_audit", fields: ["compliance.*", "audit.*"], targetField: "audit.technician_note" },
  { id: "provenance", fields: ["provenance.*"], targetField: "provenance.technician_note", satisfiedByEvidence: true },
].map(Object.freeze));

const RAIL_GROUPS = Object.freeze([
  { id: "asset_identification", fields: ["asset.line", "asset.train_set", "asset.car", "asset.stock_class", "asset.subsystem"], targetField: "asset.train_set" },
  { id: "works_summary", fields: ["work.type", "work.trigger", "work.order_id", "work.description"], targetField: "work.description" },
  { id: "trigger_findings", fields: ["work.fault_code", "inspection_findings"], targetField: "inspection_findings" },
  { id: "work_performed", fields: ["work_performed"], targetField: "work_performed" },
  { id: "tests_results", fields: ["test.result", "measurement.*"], targetField: "test.result" },
  { id: "track_access_record", fields: ["access.approval"], targetField: "access.approval" },
  { id: "completion_state_return_to_service", fields: ["completion.state"], targetField: "completion.state" },
  { id: "safety_ops_notes", fields: ["safety.*"], targetField: "safety.technician_note" },
  { id: "reliability_compliance", fields: ["reliability.*", "compliance.*", "audit.*"], targetField: "reliability.technician_note" },
  { id: "provenance", fields: ["provenance.*"], targetField: "provenance.technician_note", satisfiedByEvidence: true },
].map(Object.freeze));

const INDUSTRIAL_GROUPS = Object.freeze([
  { id: "asset_identification", fields: ["asset.equipment", "asset.location", "asset.voltage_level"], targetField: "asset.equipment" },
  { id: "inspection_basis", fields: ["standard.reference"], targetField: "standard.reference" },
  { id: "inspection_scope", fields: ["inspection.item", "work.type", "work.description"], targetField: "inspection.item" },
  { id: "observations_measurements", fields: ["inspection.observation", "measurement.*"], targetField: "inspection.observation" },
  { id: "findings_result", fields: ["inspection.result", "defect.description"], targetField: "inspection.result" },
  { id: "completion_safety", fields: ["completion.state", "safety.*"], targetField: "completion.state" },
  { id: "provenance", fields: ["provenance.*"], targetField: "provenance.technician_note", satisfiedByEvidence: true },
].map(Object.freeze));

function schema(spec) {
  return Object.freeze({
    ...spec,
    fields: Object.freeze(Object.keys(spec.fieldDefinitions)),
    requiredFields: Object.freeze(Object.entries(spec.fieldDefinitions).filter(([, definition]) => definition.required).map(([fieldId]) => fieldId)),
  });
}

export const REPORT_SCHEMAS = Object.freeze({
  HVAC: schema({ scope: "HVAC", id: "hvac_service", version: "1", reportType: "HVAC", name: "HVAC Service", statementPlaceholder: "Describe the customer complaint, inspection, work performed, and final test results.", fieldDefinitions: HVAC_FIELDS, requiredGroups: Object.freeze([]), builderBinding: "hvac_v1" }),
  SBS_BUS: schema({ scope: "SBS_BUS", id: "sbs_bus_maintenance", version: "0", reportType: "SBS_BUS", name: "SBS Bus Maintenance", statementPlaceholder: "Describe the bus, reported issue, checks completed, work performed, and return-to-service result.", fieldDefinitions: BUS_FIELDS, requiredGroups: BUS_GROUPS, builderBinding: "sbs_bus_v0" }),
  SBS_RAIL: schema({ scope: "SBS_RAIL", id: "sbs_rail_maintenance", version: "0", reportType: "SBS_RAIL", name: "SBS Rail Maintenance", statementPlaceholder: "Describe the train or rail asset, reported issue, checks completed, work performed, and return-to-service result.", fieldDefinitions: RAIL_FIELDS, requiredGroups: RAIL_GROUPS, builderBinding: "sbs_rail_v0" }),
  OILFIELD: schema({ scope: "OILFIELD", id: "oilfield_inspection", version: "1", reportType: "OILFIELD", name: "Oilfield Inspection", statementPlaceholder: "Describe the equipment and location, inspection basis, observed condition, measurements, work performed, test result, safety controls, and completion state.", fieldDefinitions: INDUSTRIAL_FIELDS, requiredGroups: INDUSTRIAL_GROUPS, builderBinding: "industrial_oilfield_v1" }),
  POWER_GRID: schema({ scope: "POWER_GRID", id: "power_grid_inspection", version: "1", reportType: "POWER_GRID", name: "Power Grid Inspection", statementPlaceholder: "Describe the grid asset and location, voltage level, inspection basis, observations, measurements, work performed, verification, safety controls, and completion state.", fieldDefinitions: INDUSTRIAL_FIELDS, requiredGroups: INDUSTRIAL_GROUPS, builderBinding: "industrial_power_grid_v1" }),
});

const SCHEMAS_BY_ID = new Map(Object.values(REPORT_SCHEMAS).map((item) => [item.id, item]));
const SCHEMAS_BY_TYPE = new Map(Object.values(REPORT_SCHEMAS).map((item) => [item.reportType, item]));
function copy(value) { return structuredClone(value); }
function sessionId() { return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `session_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function isWildcard(fieldId) { return fieldId.endsWith(".*"); }
function fieldMatches(pattern, fieldId) { return isWildcard(pattern) ? fieldId.startsWith(pattern.slice(0, -1)) : fieldId === pattern; }
function hasValue(value) { return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === ""); }
function emptyFieldState(fieldId, definition = {}) { return { fieldId, definition: copy(definition), value: null, unit: null, status: "MISSING", support: [], candidates: [] }; }

const CAPTURE_STATE_VALUES = Object.freeze({
  inputMode: new Set(["none", "recording", "uploaded_audio", "manual"]),
  audioState: new Set(["idle", "recording", "ready", "uploading", "failed"]),
  transcriptionState: new Set(["idle", "processing", "complete", "failed"]),
  documentState: new Set(["idle", "uploading", "processing", "ready", "failed"]),
  processingState: new Set(["idle", "extracting", "validating", "complete", "failed"]),
  statementState: new Set(["empty", "available"]),
});

function initialCaptureState() {
  return {
    inputMode: "none",
    audioState: "idle",
    transcriptionState: "idle",
    documentState: "idle",
    processingState: "idle",
    statementState: "empty",
    audioError: null,
    transcriptionError: null,
    documentError: null,
    processingError: null,
    integrityError: null,
    audioBlob: null,
    audioId: null,
    previewUrl: null,
    attachment: null,
    language: "auto",
    model: "base",
  };
}

function definitionEntry(schemaToSearch, fieldId) {
  if (schemaToSearch.fieldDefinitions[fieldId]) return [fieldId, schemaToSearch.fieldDefinitions[fieldId]];
  return Object.entries(schemaToSearch.fieldDefinitions).find(([candidate]) => isWildcard(candidate) && fieldId.startsWith(candidate.slice(0, -1))) || null;
}

export function schemaFor(reportTypeOrSchemaId) {
  const found = SCHEMAS_BY_ID.get(reportTypeOrSchemaId) || SCHEMAS_BY_TYPE.get(reportTypeOrSchemaId);
  if (!found) throw new Error(`Unknown report type: ${reportTypeOrSchemaId}`);
  return found;
}

export function createReportSession({ id, reportType, jobContext = {} } = {}) {
  const reportSchema = schemaFor(reportType || REPORT_SCHEMAS.HVAC.id);
  const createdAt = new Date().toISOString();
  const fieldStates = Object.fromEntries(Object.entries(reportSchema.fieldDefinitions).filter(([fieldId]) => !isWildcard(fieldId)).map(([fieldId, definition]) => [fieldId, emptyFieldState(fieldId, definition)]));
  return {
    id: id || sessionId(), scope: reportSchema.scope, reportType: reportSchema.reportType,
    schemaId: reportSchema.id, schemaVersion: reportSchema.version, status: "DRAFT", view: "capture", revision: 0,
    createdAt, updatedAt: createdAt, jobContext: copy(jobContext),
    capture: initialCaptureState(),
    manualFields: {}, processing: { status: "idle", error: null }, complete: { summary: "", meta: "", copyableText: "" },
    evidence: [], sources: [], transcript: { original: "", normalized: "", hash: null }, transcriptArtifact: null, originalTranscriptArtifact: null, transcriptHistory: [], corrections: [], correctionCandidates: [], correctionDecisions: [],
    facts: [], unsupportedFacts: [], structuredState: {}, fieldStates, completeness: null, unresolvedItems: [], resolveQueue: [], resolveAnswers: {}, resolveFlow: { total: 0, completed: 0 },
    reportDraft: null, reportDocument: null, validation: null, confirmation: null, exportState: { saved: false, files: [], error: null },
  };
}

export function updateCaptureState(session, patch = {}) {
  if (!session?.capture) throw new TypeError("A ReportSession with Capture state is required.");
  for (const [key, value] of Object.entries(patch)) {
    if (CAPTURE_STATE_VALUES[key] && !CAPTURE_STATE_VALUES[key].has(value)) {
      throw new TypeError(`Invalid Capture ${key}: ${value}`);
    }
  }
  Object.assign(session.capture, copy(patch));
  session.updatedAt = new Date().toISOString();
  return session;
}

export function captureReadiness(session, { statement } = {}) {
  const capture = session?.capture || initialCaptureState();
  const usableStatement = String(
    statement
      ?? session?.transcriptArtifact?.raw_text
      ?? session?.transcript?.original
      ?? "",
  ).trim();
  const fatalIntegrityError = capture.integrityError || null;
  const pendingRequiredOperation = ["extracting", "validating"].includes(capture.processingState)
    || (capture.inputMode !== "manual" && capture.transcriptionState === "processing");
  const hasUsableStatement = usableStatement.length > 0;
  let reason = "ready";
  if (fatalIntegrityError) reason = "integrity_error";
  else if (pendingRequiredOperation) reason = "required_processing";
  else if (!hasUsableStatement) reason = "statement_required";
  return {
    canContinue: reason === "ready",
    hasUsableStatement,
    pendingRequiredOperation,
    fatalIntegrityError,
    reason,
  };
}

function factValue(fact) { return Object.hasOwn(fact, "value") ? fact.value : fact.normalized_value ?? fact.text ?? null; }
function factSupport(fact) {
  if (Array.isArray(fact.source_refs)) return fact.source_refs;
  if (Array.isArray(fact.support)) return fact.support;
  if (fact.source) return [fact.source];
  if (fact.evidence) return Array.isArray(fact.evidence) ? fact.evidence : [fact.evidence];
  return [];
}
function supportStatus(fact, support) {
  const status = String(fact.support_status || fact.status || "").toUpperCase();
  if (["CONFLICT", "CONTRADICTED"].includes(status)) return "CONFLICT";
  if (["UNCERTAIN", "NEEDS_CONFIRMATION", "AMBIGUOUS"].includes(status)) return "NEEDS_CONFIRMATION";
  if (["SUPPORTED", "DIRECT_TRANSCRIPT", "CONFIRMED_BY_TECHNICIAN", "CONFIRMED_BY_EVIDENCE"].includes(status)) return "SUPPORTED";
  return support.length ? "SUPPORTED" : "NEEDS_CONFIRMATION";
}
function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

const VOLATILE_MATERIAL_KEYS = new Set([
  "createdAt", "updatedAt", "created_at", "updated_at", "recorded_at", "generated_at",
  "trace_id", "validator_run_id", "confirmation_token", "confirmed_at",
]);

function canonicalMaterialValue(value) {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalMaterialValue);
  if (typeof value === "object") {
    if (typeof value.name === "string" && typeof value.size === "number" && typeof value.type === "string") {
      return { name: value.name, size: value.size, type: value.type, lastModified: value.lastModified ?? null };
    }
    return Object.fromEntries(Object.keys(value)
      .filter((key) => !VOLATILE_MATERIAL_KEYS.has(key))
      .sort()
      .map((key) => [key, canonicalMaterialValue(value[key])]));
  }
  return String(value);
}

export function reportMaterialSignature(session) {
  return JSON.stringify(canonicalMaterialValue({
    transcript: session.transcript,
    transcriptArtifact: session.transcriptArtifact,
    corrections: session.corrections,
    correctionDecisions: session.correctionDecisions,
    correctionReceipt: session.correctionReceipt,
    manualFields: session.manualFields,
    evidence: session.evidence,
    sources: session.sources,
    attachment: session.capture?.attachment,
    facts: session.facts,
    structuredState: session.structuredState,
    fieldStates: session.fieldStates,
    unresolvedItems: session.unresolvedItems,
    reportDraft: session.reportDraft,
    validation: session.validation,
  }));
}

export function transcriptSourceLabel(artifact) {
  const mode = String(artifact?.input_mode || "").toUpperCase();
  if (mode === "EDITED_TRANSCRIPT") return "Edited transcript";
  if (mode === "MANUAL_TRANSCRIPT" || mode === "MANUAL_INPUT") return "Manual input";
  if (mode === "VOICE_TRANSCRIPT" || artifact?.audio_id) return "Voice transcript";
  return "Captured statement";
}

export function applyTranscriptArtifact(session, artifact) {
  if (!artifact || !String(artifact.raw_text || "").trim()) throw new TypeError("A transcript artifact with statement text is required.");
  const previous = session.transcriptArtifact;
  session.transcriptHistory ||= [];
  if (previous?.artifact_id && previous.artifact_id !== artifact.artifact_id
    && !session.transcriptHistory.some((item) => item.artifact_id === previous.artifact_id)) {
    session.transcriptHistory.push(copy(previous));
  }
  session.originalTranscriptArtifact ||= copy(artifact);
  session.transcriptArtifact = copy(artifact);
  session.transcript = {
    original: artifact.raw_text,
    normalized: artifact.raw_text,
    hash: artifact.source_hash || artifact.artifact_id,
  };
  return session;
}

export function bindSessionConfirmation(session, confirmation) {
  session.confirmation = copy(confirmation);
  session.status = "CONFIRMED";
  session.confirmedMaterialSignature = reportMaterialSignature(session);
  return session;
}

export function hasMaterialReportChange(session) {
  return Boolean(session.confirmation && session.confirmedMaterialSignature
    && session.confirmedMaterialSignature !== reportMaterialSignature(session));
}

export function invalidateSessionConfirmation(session) {
  session.confirmation = null;
  session.confirmedMaterialSignature = null;
  session.status = session.reportDraft ? "REVIEW" : (session.transcript?.original ? "RESOLVE" : "CAPTURE");
  session.complete = { summary: "", meta: "", copyableText: "" };
  session.exportState = { saved: false, files: [], error: null };
  session.updatedAt = new Date().toISOString();
  return session;
}

export function confirmationViewState(session, { reviewable = false } = {}) {
  if (session.confirmation) {
    const at = session.confirmation.confirmed_at ? ` at ${session.confirmation.confirmed_at}` : "";
    return {
      confirmed: true,
      checkboxChecked: true,
      confirmationDisabled: true,
      canFinalize: true,
      message: `Confirmed${at}. This exact report version remains official.`,
    };
  }
  return {
    confirmed: false,
    checkboxChecked: false,
    confirmationDisabled: true,
    canFinalize: false,
    message: reviewable ? "Review and confirm this exact version." : "Confirmation is blocked by validation.",
  };
}

export function reviewStatus(session, { reviewable = false, issueCount = 0 } = {}) {
  if (session?.confirmation) return "CONFIRMED";
  if (Number(issueCount) > 0) return "NEEDS_INFORMATION";
  return reviewable ? "READY_TO_CONFIRM" : "VALIDATION_FAILED";
}

function collectSearchValues(value, result) {
  if (value === null || value === undefined) return;
  if (["string", "number", "boolean"].includes(typeof value)) { result.push(String(value)); return; }
  if (Array.isArray(value)) { for (const item of value) collectSearchValues(item, result); return; }
  if (typeof value === "object") for (const item of Object.values(value)) collectSearchValues(item, result);
}

export function reportSearchText(session) {
  const values = [];
  collectSearchValues({
    id: session.id,
    schemaId: session.schemaId,
    reportType: session.reportType,
    jobContext: session.jobContext,
    structuredState: session.structuredState,
    facts: session.facts,
    reportDraft: session.reportDraft,
  }, values);
  return values.join(" ").toLowerCase();
}

export function knowledgeQueryState(rawQuery) {
  const query = String(rawQuery || "").trim();
  return { valid: query.length > 0, query };
}

export function audioPreferenceState({ language, model } = {}) {
  const languages = new Set(["auto", "zh", "en", "ms", "ta"]);
  const models = new Set(["base", "tiny", "small"]);
  return {
    language: languages.has(language) ? language : "auto",
    model: models.has(model) ? model : "base",
  };
}

export function globalViewStatus(view, scope = "SBS_BUS") {
  const statuses = {
    reports: "Local report workspace",
    "new-report": "Choose a report type",
    settings: "Local runtime settings",
    help: "Demo help and walkthroughs",
  };
  if (view === "knowledge") return `Knowledge · ${schemaFor(scope).name} · scope isolated`;
  return statuses[view] || "Local workspace ready";
}

export function mapFactsToStructuredState(session, facts = []) {
  const next = copy(session);
  const reportSchema = schemaFor(next.schemaId);
  next.facts = copy(facts); next.unsupportedFacts = []; next.structuredState = {};
  next.fieldStates = Object.fromEntries(Object.entries(reportSchema.fieldDefinitions).filter(([fieldId]) => !isWildcard(fieldId)).map(([fieldId, definition]) => [fieldId, emptyFieldState(fieldId, definition)]));
  for (const fact of facts) {
    const fieldId = fact.field || fact.field_id || fact.key;
    const entry = fieldId ? definitionEntry(reportSchema, fieldId) : null;
    if (!entry) { next.unsupportedFacts.push({ ...copy(fact), field: fieldId || null, status: "UNSUPPORTED" }); continue; }
    const [, definition] = entry;
    const fieldState = next.fieldStates[fieldId] || (next.fieldStates[fieldId] = emptyFieldState(fieldId, definition));
    const value = factValue(fact); const support = factSupport(fact);
    let candidateStatus = supportStatus(fact, support);
    if (definition.requiresTechnicianConfirmation && candidateStatus === "SUPPORTED" && String(fact.support_status || "").toUpperCase() !== "CONFIRMED_BY_TECHNICIAN") candidateStatus = "NEEDS_CONFIRMATION";
    const candidate = { factId: fact.id || fact.fact_id || null, value, unit: fact.unit ?? null, support, status: candidateStatus, raw: copy(fact) };
    fieldState.candidates.push(candidate); fieldState.support.push(...support);
    if (!hasValue(value)) continue;
    if (definition.repeating) {
      const values = fieldState.candidates.filter((item) => hasValue(item.value)).map((item) => item.value);
      fieldState.value = values.length === 1 ? values[0] : values; fieldState.unit = fact.unit ?? fieldState.unit;
      fieldState.status = fieldState.candidates.some((item) => item.status === "NEEDS_CONFIRMATION") ? "NEEDS_CONFIRMATION" : "SUPPORTED";
    } else if (hasValue(fieldState.value) && !sameValue(fieldState.value, value)) {
      fieldState.status = "CONFLICT";
    } else {
      fieldState.value = value; fieldState.unit = fact.unit ?? null;
      if (candidate.status === "CONFLICT" || fieldState.status === "CONFLICT") fieldState.status = "CONFLICT";
      else if (candidate.status === "NEEDS_CONFIRMATION") fieldState.status = "NEEDS_CONFIRMATION";
      else fieldState.status = "SUPPORTED";
    }
    next.structuredState[fieldId] = fieldState.value;
  }
  next.revision += 1; next.updatedAt = new Date().toISOString(); next.completeness = evaluateCompleteness(next);
  return next;
}

function normalizeUnit(value) { return String(value ?? "").trim().toLowerCase().replaceAll("℃", "°c").replaceAll(" ", ""); }
function matchingStates(session, patterns) { return Object.entries(session.fieldStates || {}).filter(([fieldId]) => patterns.some((pattern) => fieldMatches(pattern, fieldId))); }

export function evaluateCompleteness(session) {
  const reportSchema = schemaFor(session.schemaId);
  const missingFields = []; const invalidValues = []; const conflicts = []; const needsConfirmation = []; const resolvedFields = [];
  for (const [fieldId, state] of Object.entries(session.fieldStates || {})) {
    if (state.status === "CONFLICT") conflicts.push(fieldId);
    if (state.status === "NEEDS_CONFIRMATION") needsConfirmation.push(fieldId);
    if (state.status === "SUPPORTED" && hasValue(state.value)) resolvedFields.push(fieldId);
    const definition = definitionEntry(reportSchema, fieldId)?.[1] || state.definition || {};
    if (definition.required && (!hasValue(state.value) || state.status === "MISSING")) missingFields.push(fieldId);
    const values = Array.isArray(state.value) && definition.repeating ? state.value : [state.value];
    if (hasValue(state.value) && definition.allowedValues && values.some((value) => !definition.allowedValues.includes(String(value)))) invalidValues.push({ fieldId, reason: "allowed_value", value: copy(state.value) });
    const units = state.candidates?.map((candidate) => candidate.unit).filter(hasValue) || [];
    if (definition.allowedUnits && units.some((unit) => !definition.allowedUnits.map(normalizeUnit).includes(normalizeUnit(unit)))) invalidValues.push({ fieldId, reason: "unit", value: units.join(", ") });
  }
  for (const group of reportSchema.requiredGroups || []) {
    const states = matchingStates(session, group.fields);
    const satisfied = (group.satisfiedByEvidence && (session.facts || []).some((fact) => factSupport(fact).length > 0)) || states.some(([, state]) => state.status === "SUPPORTED" && hasValue(state.value));
    if (!satisfied && !missingFields.includes(group.id)) missingFields.push(group.id);
  }
  return {
    requiredFields: [...reportSchema.requiredFields, ...(reportSchema.requiredGroups || []).map((group) => group.id)], resolvedFields, missingFields, invalidValues, conflicts, needsConfirmation,
    unsupportedFields: (session.unsupportedFacts || []).map((fact) => fact.field),
    complete: missingFields.length === 0 && invalidValues.length === 0 && conflicts.length === 0 && needsConfirmation.length === 0,
  };
}

function resolveItem(type, fieldId, severity, question, evidence = [], meta = {}) {
  return { id: `${type.toLowerCase()}_${fieldId}_${meta.index ?? 0}`, type, fieldId, severity, question, evidence: copy(evidence), answer: null, ...meta };
}

export function createResolveQueue(session) {
  const reportSchema = session.schemaId ? schemaFor(session.schemaId) : null; const items = [];
  for (const [index, candidate] of (session.correctionCandidates || []).entries()) {
    const fieldId = candidate.field || candidate.fieldId || "transcript"; const evidence = candidate.evidence || candidate.source_refs || [];
    const status = String(candidate.status || candidate.confidence || "").toUpperCase();
    const critical = ["UNCERTAIN", "NEEDS_CONFIRMATION", "NEEDS_TECHNICIAN_CONFIRMATION", "CRITICAL"].includes(status) || candidate.critical === true;
    if (critical) items.push(resolveItem("CRITICAL_VALUE", fieldId, "high", candidate.criticalQuestion || `Confirm the critical value for ${fieldId}.`, evidence, { index, candidate: copy(candidate) }));
    else items.push(resolveItem("TERMINOLOGY", fieldId, "medium", candidate.question || `Confirm the proposed terminology for ${fieldId}.`, evidence, { index, candidate: copy(candidate) }));
  }
  const completeness = reportSchema ? evaluateCompleteness(session) : { missingFields: session.missingFields || [] };
  for (const missingId of completeness.missingFields || []) {
    const group = reportSchema?.requiredGroups?.find((candidate) => candidate.id === missingId); const targetField = group?.targetField || missingId;
    const state = session.fieldStates?.[targetField];
    if (!state || state.status === "MISSING" || !hasValue(state.value)) items.push(resolveItem("MISSING_FIELD", missingId, "high", `Provide the required ${missingId.replaceAll(/[._]/g, " ")}.`, [], { targetField }));
  }
  for (const [fieldId, state] of Object.entries(session.fieldStates || {})) {
    if (state.status === "CONFLICT") items.push(resolveItem("CONFLICT", fieldId, "high", `Choose the supported value for ${fieldId.replaceAll(/[._]/g, " ")}.`, state.support, { candidates: copy(state.candidates), targetField: fieldId }));
    else if (state.status === "NEEDS_CONFIRMATION" && !items.some((item) => item.type === "CRITICAL_VALUE" && item.fieldId === fieldId)) items.push(resolveItem("CRITICAL_VALUE", fieldId, "high", `Confirm ${fieldId.replaceAll(/[._]/g, " ")} before review.`, state.support, { targetField: fieldId }));
  }
  for (const [index, conflict] of (session.conflicts || []).entries()) {
    const fieldId = conflict.field || conflict.fieldId || "conflict";
    items.push(resolveItem("CONFLICT", fieldId, "high", conflict.question || `Choose the supported value for ${fieldId.replaceAll(/[._]/g, " ")}.`, conflict.evidence || [], { index, candidates: copy(conflict.values || conflict.candidates || []), targetField: fieldId }));
  }
  const unique = [...new Map(items.map((item) => [`${item.type}:${item.fieldId}`, item])).values()];
  const rank = { CRITICAL_VALUE: 0, CONFLICT: 1, MISSING_FIELD: 2, TERMINOLOGY: 3 };
  return unique
    .map((item) => ({ ...item, answer: copy(session.resolveAnswers?.[item.id] || item.answer) }))
    .sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || a.fieldId.localeCompare(b.fieldId));
}

function safeFactId(value) { return String(value).replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 90); }
export function applyResolveAnswer(session, resolveItemToApply, answer, technician = {}) {
  const targetField = resolveItemToApply.targetField || resolveItemToApply.fieldId;
  if (!targetField || !hasValue(answer)) throw new TypeError("A Resolve answer and target field are required.");
  const reportSchema = schemaFor(session.schemaId);
  if (!definitionEntry(reportSchema, targetField)) throw new Error(`Resolve target is outside ${reportSchema.id}: ${targetField}`);
  const resolveRevision = Number(session.revision || 0) + 1; const factId = `followup_${safeFactId(session.id)}_${safeFactId(targetField)}_${resolveRevision}`;
  const followUpFact = {
    fact_id: factId, field: targetField, value: answer, support_status: "CONFIRMED_BY_TECHNICIAN", source: "technician_follow_up", source_refs: [`resolve:${resolveItemToApply.id}`],
    provenance: {
      source: "technician_follow_up",
      resolve_item_id: resolveItemToApply.id,
      technician_id: String(technician.technicianId || "").trim(),
      technician_name: String(technician.technicianName || "").trim(),
      evidence: copy(resolveItemToApply.evidence || []),
      candidate_fact_ids: (resolveItemToApply.candidates || []).map((candidate) => candidate.factId || candidate.fact_id || candidate.id).filter(Boolean),
      recorded_at: new Date().toISOString(),
    },
  };
  const replacePrior = ["CONFLICT", "CRITICAL_VALUE", "MISSING_FIELD"].includes(resolveItemToApply.type);
  const facts = (session.facts || []).filter((fact) => !replacePrior || (fact.field || fact.field_id || fact.key) !== targetField);
  const next = mapFactsToStructuredState(session, [...facts, followUpFact]);
  next.unresolvedItems = (session.unresolvedItems || []).map((item) => item.id === resolveItemToApply.id
    ? { ...item, answer: { decision: "CONFIRM", value: copy(answer) }, resolvedFactId: factId }
    : copy(item));
  next.resolveQueue = createResolveQueue(next); return next;
}

export function beginResolveFlow(session, items = createResolveQueue(session)) {
  session.unresolvedItems = copy(items);
  session.resolveQueue = copy(items);
  session.resolveFlow = { total: items.length, completed: items.filter((item) => item.answer).length };
  return session;
}

export function resolveProgress(session) {
  const items = session.unresolvedItems || session.resolveQueue || [];
  const remainingItems = items.filter((item) => !item.answer);
  const completed = Number(session.resolveFlow?.completed ?? items.length - remainingItems.length);
  const total = Math.max(Number(session.resolveFlow?.total || 0), completed + remainingItems.length);
  return { total, completed, remaining: remainingItems.length, current: remainingItems[0] || null };
}

export function resolveAttentionCount(session) {
  return (session.unresolvedItems || session.resolveQueue || []).filter((item) => !item.answer || item.answer.decision === "NOT_PROVIDED").length;
}

export function applyResolveDecision(session, item, answer, technician = session.jobContext || {}) {
  if (!item?.id || !["CONFIRM", "NOT_PROVIDED"].includes(answer?.decision)) throw new TypeError("A valid Resolve item decision is required.");
  const normalized = {
    decision: answer.decision,
    value: answer.decision === "CONFIRM" ? answer.value : null,
  };
  if (normalized.decision === "CONFIRM" && !hasValue(normalized.value)) throw new TypeError("A confirmed Resolve decision requires an observed value.");
  let next = normalized.decision === "CONFIRM" ? applyResolveAnswer(session, item, normalized.value, technician) : copy(session);
  next.resolveAnswers = { ...(session.resolveAnswers || {}), [item.id]: copy(normalized) };
  if (normalized.decision === "CONFIRM") {
    next.resolveQueue = createResolveQueue(next);
    next.unresolvedItems = copy(next.resolveQueue);
  } else {
    next.unresolvedItems = (session.unresolvedItems || []).map((candidate) => candidate.id === item.id ? { ...copy(candidate), answer: copy(normalized) } : copy(candidate));
    next.resolveQueue = copy(next.unresolvedItems);
  }
  next.resolveFlow = {
    total: Math.max(Number(session.resolveFlow?.total || 0), (session.unresolvedItems || []).length),
    completed: Number(session.resolveFlow?.completed || 0) + 1,
  };
  return next;
}

export function factsFromStructuredState(session) {
  const result = [];
  for (const state of Object.values(session.fieldStates || {})) {
    if (state.status !== "SUPPORTED" || !hasValue(state.value)) continue;
    const candidates = state.candidates || [];
    if (state.definition?.repeating) {
      for (const candidate of candidates.filter((item) => item.status === "SUPPORTED" && hasValue(item.value))) result.push(copy(candidate.raw));
    } else {
      const selected = [...candidates].reverse().find((candidate) => candidate.status === "SUPPORTED" && sameValue(candidate.value, state.value));
      if (selected) result.push(copy(selected.raw));
    }
  }
  const reportSchema = schemaFor(session.schemaId);
  const supportsProvenance = Boolean(reportSchema.fieldDefinitions["provenance.*"]);
  if (supportsProvenance && result.length && !result.some((fact) => String(fact.field || "").startsWith("provenance."))) {
    const factIds = result.map((fact) => fact.fact_id || fact.id).filter(Boolean);
    const sourceRefs = [...new Set(result.flatMap((fact) => factSupport(fact)))];
    result.push({
      fact_id: `provenance_${safeFactId(session.id)}`,
      field: "provenance.source",
      value: { fact_ids: factIds, source_refs: sourceRefs },
      support_status: "CONFIRMED_BY_EVIDENCE",
      source: "structured_state_mapper",
      source_refs: sourceRefs,
      critical: false,
    });
  }
  return result;
}

export function structuredStateSnapshot(session) {
  return {
    session_id: session.id,
    schema_id: session.schemaId,
    schema_version: session.schemaVersion,
    fields: copy(session.structuredState || {}),
    field_states: copy(session.fieldStates || {}),
    completeness: copy(session.completeness || evaluateCompleteness(session)),
    unsupported_fields: (session.unsupportedFacts || []).map((fact) => fact.field),
  };
}

export function correctionDecisionPayload({ candidateId, action, correctedText, critical = false }) {
  const decision = { candidate_id: candidateId, decision: action };
  if (hasValue(correctedText)) decision.corrected_text = String(correctedText);
  if (critical) decision.critical_value_confirmed = true;
  return decision;
}

export function createSessionRuntime() {
  const transients = new Map(); const latestRequests = new Map(); let activeSessionId = null; let generation = 0; let sequence = 0;
  return {
    activate(sessionIdToActivate) { if (typeof sessionIdToActivate === "object") sessionIdToActivate = sessionIdToActivate.id; if (activeSessionId !== sessionIdToActivate) { activeSessionId = sessionIdToActivate; generation += 1; } return activeSessionId; },
    activeSessionId() { return activeSessionId; },
    setTransient(sessionIdToUpdate, patch) {
      if (arguments.length === 2 && activeSessionId && typeof patch !== "object") { const previous = transients.get(activeSessionId) || {}; transients.set(activeSessionId, { ...previous, [sessionIdToUpdate]: patch }); return patch; }
      const previous = transients.get(sessionIdToUpdate) || {}; transients.set(sessionIdToUpdate, { ...previous, ...copy(patch) }); return this.getTransient(sessionIdToUpdate);
    },
    getTransient(sessionIdToRead) { if (sessionIdToRead === activeSessionId || transients.has(sessionIdToRead)) return copy(transients.get(sessionIdToRead) || {}); return copy((transients.get(activeSessionId) || {})[sessionIdToRead] ?? ""); },
    beginRequest(sessionIdForRequest, scope) {
      if (arguments.length === 1) { scope = sessionIdForRequest; sessionIdForRequest = activeSessionId; }
      sequence += 1; const token = { sessionId: sessionIdForRequest, scope, generation, requestId: sequence }; latestRequests.set(`${sessionIdForRequest}:${scope}`, sequence); return token;
    },
    accepts(token) { return Boolean(token) && token.sessionId === activeSessionId && token.generation === generation && latestRequests.get(`${token.sessionId}:${token.scope}`) === token.requestId; },
  };
}
