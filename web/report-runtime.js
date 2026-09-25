export const REPORT_SCHEMAS = Object.freeze({
  HVAC: Object.freeze({
    scope: "HVAC",
    id: "hvac_service",
    version: "1",
    reportType: "HVAC",
    name: "HVAC Service",
    statementPlaceholder: "Describe the customer complaint, inspection, work performed, and final test results.",
    fields: Object.freeze([
      "customer_complaint",
      "inspection_findings",
      "work_performed",
      "parts_used",
      "test_results",
      "completion_status",
      "follow_up_recommendations",
    ]),
    requiredFields: Object.freeze([
      "customer_complaint",
      "inspection_findings",
      "work_performed",
      "test_results",
      "completion_status",
    ]),
  }),
  SBS_BUS: Object.freeze({
    scope: "SBS_BUS",
    id: "sbs_bus_maintenance",
    version: "0",
    reportType: "SBS_BUS",
    name: "SBS Bus Maintenance",
    statementPlaceholder: "Describe the bus, reported issue, checks completed, work performed, and return-to-service result.",
    fields: Object.freeze([
      "asset.bus_model",
      "asset.bus_number",
      "work.type",
      "issue.reported",
      "inspection.findings",
      "work.performed",
      "parts.used",
      "test.results",
      "completion.status",
      "follow_up.recommendations",
    ]),
    requiredFields: Object.freeze([
      "asset.bus_model",
      "work.type",
      "issue.reported",
      "inspection.findings",
      "work.performed",
      "test.results",
      "completion.status",
    ]),
  }),
  SBS_RAIL: Object.freeze({
    scope: "SBS_RAIL",
    id: "sbs_rail_maintenance",
    version: "0",
    reportType: "SBS_RAIL",
    name: "SBS Rail Maintenance",
    statementPlaceholder: "Describe the train or rail asset, reported issue, checks completed, work performed, and return-to-service result.",
    fields: Object.freeze([
      "asset.train_model",
      "asset.train_number",
      "work.type",
      "issue.reported",
      "inspection.findings",
      "work.performed",
      "parts.used",
      "test.results",
      "completion.status",
      "follow_up.recommendations",
    ]),
    requiredFields: Object.freeze([
      "asset.train_model",
      "work.type",
      "issue.reported",
      "inspection.findings",
      "work.performed",
      "test.results",
      "completion.status",
    ]),
  }),
});

const SCHEMAS_BY_ID = new Map(Object.values(REPORT_SCHEMAS).map((schema) => [schema.id, schema]));
const SCHEMAS_BY_TYPE = new Map(Object.values(REPORT_SCHEMAS).map((schema) => [schema.reportType, schema]));

function copy(value) {
  return structuredClone(value);
}

function sessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function schemaFor(reportTypeOrSchemaId) {
  const schema = SCHEMAS_BY_ID.get(reportTypeOrSchemaId) || SCHEMAS_BY_TYPE.get(reportTypeOrSchemaId);
  if (!schema) throw new Error(`Unknown report type: ${reportTypeOrSchemaId}`);
  return schema;
}

export function createReportSession({ id, reportType, jobContext = {} } = {}) {
  const schema = schemaFor(reportType || REPORT_SCHEMAS.HVAC.id);
  const createdAt = new Date().toISOString();
  const fieldStates = Object.fromEntries(schema.fields.map((fieldId) => [fieldId, {
    fieldId,
    value: null,
    status: "MISSING",
    support: [],
    candidates: [],
  }]));

  return {
    id: id || sessionId(),
    scope: schema.scope,
    reportType: schema.reportType,
    schemaId: schema.id,
    schemaVersion: schema.version,
    status: "DRAFT",
    view: "capture",
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    jobContext: copy(jobContext),
    evidence: [],
    sources: [],
    transcript: { original: "", normalized: "", hash: null },
    corrections: [],
    correctionCandidates: [],
    correctionDecisions: [],
    facts: [],
    structuredState: {},
    fieldStates,
    unresolvedItems: [],
    resolveQueue: [],
    reportDraft: null,
    reportDocument: null,
    validation: null,
    confirmation: null,
    exportState: { saved: false, files: [], error: null },
  };
}

function factValue(fact) {
  return fact.value ?? fact.normalized_value ?? fact.text ?? null;
}

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
  return support.length ? "SUPPORTED" : "NEEDS_CONFIRMATION";
}

export function mapFactsToStructuredState(session, facts = []) {
  const next = copy(session);
  const schema = schemaFor(next.schemaId);
  next.facts = copy(facts);
  next.structuredState = {};
  next.fieldStates = Object.fromEntries(schema.fields.map((fieldId) => [fieldId, {
    fieldId,
    value: null,
    status: "MISSING",
    support: [],
    candidates: [],
  }]));

  for (const fact of facts) {
    const fieldId = fact.field || fact.field_id || fact.key;
    if (!fieldId || !next.fieldStates[fieldId]) continue;
    const fieldState = next.fieldStates[fieldId];
    const value = factValue(fact);
    const support = factSupport(fact);
    const candidate = { factId: fact.id || fact.fact_id || null, value, support, raw: copy(fact) };
    fieldState.candidates.push(candidate);
    fieldState.support.push(...support);

    if (fieldState.value !== null && value !== null && String(fieldState.value) !== String(value)) {
      fieldState.status = "CONFLICT";
    } else {
      fieldState.value = value;
      const candidateStatus = supportStatus(fact, support);
      if (candidateStatus === "CONFLICT" || fieldState.status === "CONFLICT") fieldState.status = "CONFLICT";
      else if (candidateStatus === "NEEDS_CONFIRMATION") fieldState.status = "NEEDS_CONFIRMATION";
      else if (fieldState.status === "MISSING") fieldState.status = "SUPPORTED";
    }

    next.structuredState[fieldId] = fieldState.value;
  }

  next.revision += 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

function resolveItem(type, fieldId, severity, question, evidence = [], meta = {}) {
  return {
    id: `${type.toLowerCase()}_${fieldId}_${meta.index ?? 0}`,
    type,
    fieldId,
    severity,
    question,
    evidence: copy(evidence),
    answer: null,
    ...meta,
  };
}

export function createResolveQueue(session) {
  const schema = session.schemaId ? schemaFor(session.schemaId) : null;
  const items = [];

  session.correctionCandidates.forEach((candidate, index) => {
    const fieldId = candidate.field || candidate.fieldId || "transcript";
    const evidence = candidate.evidence || candidate.source_refs || [];
    items.push(resolveItem(
      "TERMINOLOGY",
      fieldId,
      "medium",
      candidate.question || `Confirm the proposed terminology for ${fieldId}.`,
      evidence,
      { index, candidate: copy(candidate) },
    ));
    const status = String(candidate.status || candidate.confidence || "").toUpperCase();
    if (["UNCERTAIN", "NEEDS_CONFIRMATION", "NEEDS_TECHNICIAN_CONFIRMATION", "CRITICAL"].includes(status) || candidate.critical === true) {
      items.push(resolveItem(
        "CRITICAL_VALUE",
        fieldId,
        "high",
        candidate.criticalQuestion || `Confirm the critical value for ${fieldId}.`,
        evidence,
        { index, candidate: copy(candidate) },
      ));
    }
  });

  const missingFields = schema
    ? schema.requiredFields.filter((fieldId) => {
        const field = session.fieldStates?.[fieldId];
        return !field || field.status === "MISSING" || field.value === null || field.value === "";
      })
    : (session.missingFields || []);
  for (const fieldId of missingFields) {
    const field = session.fieldStates?.[fieldId];
    if (!field || field.status === "MISSING" || field.value === null || field.value === "") items.push(resolveItem("MISSING_FIELD", fieldId, "high", `Provide the required ${fieldId.replaceAll(/[._]/g, " ")}.`));
  }

  for (const [fieldId, field] of Object.entries(session.fieldStates || {})) {
    if (field.status === "CONFLICT") {
      items.push(resolveItem(
        "CONFLICT",
        fieldId,
        "high",
        `Choose the supported value for ${fieldId.replaceAll(/[._]/g, " ")}.`,
        field.support,
        { candidates: copy(field.candidates) },
      ));
    } else if (field.status === "NEEDS_CONFIRMATION" && !items.some((item) => item.type === "CRITICAL_VALUE" && item.fieldId === fieldId)) {
      items.push(resolveItem("CRITICAL_VALUE", fieldId, "high", `Confirm ${fieldId.replaceAll(/[._]/g, " ")} before review.`, field.support));
    }
  }

  for (const [index, conflict] of (session.conflicts || []).entries()) {
    const fieldId = conflict.field || conflict.fieldId || "conflict";
    items.push(resolveItem(
      "CONFLICT",
      fieldId,
      "high",
      conflict.question || `Choose the supported value for ${fieldId.replaceAll(/[._]/g, " ")}.`,
      conflict.evidence || [],
      { index, candidates: copy(conflict.values || conflict.candidates || []) },
    ));
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.fieldId.localeCompare(b.fieldId));
}

export function createSessionRuntime() {
  const transients = new Map();
  let activeSessionId = null;
  let generation = 0;
  let sequence = 0;

  return {
    activate(sessionIdToActivate) {
      if (typeof sessionIdToActivate === "object") sessionIdToActivate = sessionIdToActivate.id;
      if (activeSessionId !== sessionIdToActivate) {
        activeSessionId = sessionIdToActivate;
        generation += 1;
      }
      return activeSessionId;
    },
    activeSessionId() {
      return activeSessionId;
    },
    setTransient(sessionIdToUpdate, patch) {
      if (arguments.length === 2 && activeSessionId && typeof patch !== "object") {
        const previous = transients.get(activeSessionId) || {};
        transients.set(activeSessionId, { ...previous, [sessionIdToUpdate]: patch });
        return patch;
      }
      const previous = transients.get(sessionIdToUpdate) || {};
      transients.set(sessionIdToUpdate, { ...previous, ...copy(patch) });
      return this.getTransient(sessionIdToUpdate);
    },
    getTransient(sessionIdToRead) {
      if (sessionIdToRead === activeSessionId || transients.has(sessionIdToRead)) return copy(transients.get(sessionIdToRead) || {});
      return copy((transients.get(activeSessionId) || {})[sessionIdToRead] ?? "");
    },
    beginRequest(sessionIdForRequest, scope) {
      if (arguments.length === 1) {
        scope = sessionIdForRequest;
        sessionIdForRequest = activeSessionId;
      }
      sequence += 1;
      return { sessionId: sessionIdForRequest, scope, generation, requestId: sequence };
    },
    accepts(token) {
      return Boolean(token) && token.sessionId === activeSessionId && token.generation === generation;
    },
  };
}
