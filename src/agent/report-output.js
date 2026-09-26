import { deepFreeze, hashContract } from '../domain/index.js';

const OFFICIAL_STATES = new Set(['KNOWN_VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE', 'UNKNOWN']);

function matches(pattern, fieldId) {
  return pattern.endsWith('.*') ? fieldId.startsWith(pattern.slice(0, -1)) : pattern === fieldId;
}

function acceptedCandidates(field) {
  const selected = new Set(field.selected_candidate_ids || []);
  return (field.candidates || []).filter((candidate) => selected.has(candidate.candidate_id));
}

function fieldProjection(field) {
  const candidates = acceptedCandidates(field);
  const evidenceRefs = [...new Map(candidates.flatMap((candidate) => candidate.evidence_refs || [])
    .map((reference) => [`${reference.evidence_id}:${reference.span_id || ''}`, reference])).values()];
  const value = field.state === 'EXPLICIT_NONE'
    ? 'None'
    : field.state === 'NOT_APPLICABLE'
      ? 'Not applicable'
      : field.state === 'UNKNOWN'
        ? 'Unknown'
        : field.value;
  return {
    field_id: field.field_id,
    state: field.state,
    value,
    unit: field.unit || null,
    candidate_ids: candidates.map((candidate) => candidate.candidate_id),
    evidence_refs: evidenceRefs,
  };
}

export function structuredStateFor({ session, agentState } = {}) {
  return {
    session_id: session.session_id,
    template_binding: structuredClone(session.template_binding),
    fields: (agentState.report_fields || []).map(fieldProjection),
  };
}

export function structuredStateHash(input = {}) {
  return hashContract(structuredStateFor(input));
}

export function buildAuthoritativeReport({ session, agentState, template } = {}) {
  if (!session || !agentState || agentState.session_id !== session.session_id
    || agentState.session_revision !== session.revision) {
    throw Object.assign(new Error('The current Agent state does not match the ReportSession revision.'), {
      code: 'STALE_AGENT_STATE', status: 409,
    });
  }
  if (session.template_binding.template_id !== template?.templateId
    || session.template_binding.template_version !== template?.templateVersion) {
    throw Object.assign(new Error('The selected template does not match the ReportSession binding.'), {
      code: 'TEMPLATE_VERSION_MISMATCH', status: 409,
    });
  }
  const blocking = (agentState.validation_issues || []).filter((issue) => issue.blocking);
  const nonOfficial = (agentState.report_fields || []).filter((field) => !OFFICIAL_STATES.has(field.state));
  if (!agentState.completeness?.complete || agentState.resolution_queue?.length || blocking.length || nonOfficial.some((field) => {
    const definition = template.schema.fields.find((entry) => matches(entry.id, field.field_id));
    return Boolean(definition?.required || definition?.critical || definition?.requiresTechnicianConfirmation);
  })) {
    throw Object.assign(new Error('The authoritative report still has blocking validation or resolution work.'), {
      code: 'REPORT_NOT_COMPLETE', status: 409,
    });
  }

  const explicitFieldIds = new Set(template.schema.fields.filter((definition) => !definition.id.endsWith('.*')).map((definition) => definition.id));
  const byDefinition = template.schema.fields.map((definition) => ({
    definition,
    fields: (agentState.report_fields || []).filter((field) => matches(definition.id, field.field_id)
      && (!definition.id.endsWith('.*') || !explicitFieldIds.has(field.field_id))),
  }));
  const sections = [...new Set(template.schema.fields.map((definition) => definition.section))].map((title, index) => ({
    id: `section_${index + 1}`,
    title,
    content: byDefinition.filter(({ definition }) => definition.section === title).flatMap(({ definition, fields }) => {
      const renderFields = fields.length ? fields : [{
        field_id: definition.id, state: 'UNKNOWN', value: null, unit: null,
        selected_candidate_ids: [], candidates: [],
      }];
      return renderFields.map((field) => ({
        field: field.field_id,
        label: definition.label,
        ...fieldProjection(field),
      }));
    }),
  }));
  const stateHash = structuredStateHash({ session, agentState });
  const report = {
    contract: 'ExistingFormatReport',
    contract_version: '1',
    report_id: `report_${hashContract({ session_id: session.session_id, template: session.template_binding }).slice(7, 19)}`,
    report_version: 1,
    report_session_id: session.session_id,
    template_id: template.templateId,
    template_name: template.name,
    template_version: template.templateVersion,
    schema_id: template.schema.id,
    schema_version: template.schema.version,
    context_corpus_id: template.contextCorpus.id,
    context_version: template.contextCorpus.version,
    renderer_id: template.rendererMapping.id,
    renderer_version: template.rendererMapping.version,
    structured_state_hash: stateHash,
    sections,
    disclaimer: { text: 'Technician-confirmed report generated from authoritative job evidence. Guidance is not job evidence.' },
  };
  return deepFreeze({ report, structured_state_hash: stateHash });
}
