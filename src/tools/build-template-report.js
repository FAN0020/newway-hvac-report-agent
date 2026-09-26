import { hashValue } from './report-integrity.js';

function fieldMatches(pattern, candidate) {
  return pattern.endsWith('.*')
    ? candidate.startsWith(pattern.slice(0, -1))
    : pattern === candidate;
}

function hasProvidedValue(fact) {
  return fact?.value !== null
    && fact?.value !== undefined
    && String(fact.value).trim() !== ''
    && fact.value !== 'NOT_CHECKED';
}

export async function buildTemplateReport({
  template,
  facts = [],
  reportSessionId,
  traceId,
  reportStore,
}) {
  if (!template?.templateId || !template?.schema?.id || !Array.isArray(template.schema.fields)) {
    throw Object.assign(new Error('A published template version is required.'), { code: 'TEMPLATE_REQUIRED', status: 400 });
  }
  if (!reportStore?.recordStructuredValidation) {
    throw new TypeError('A report store is required.');
  }

  const definitions = template.schema.fields;
  const submittedFacts = Array.isArray(facts) ? facts : [];
  const accepted = submittedFacts.filter((fact) => definitions.some(
    (definition) => fieldMatches(definition.id, String(fact.field || '')),
  ));
  const unsupported = submittedFacts.filter((fact) => !definitions.some(
    (definition) => fieldMatches(definition.id, String(fact.field || '')),
  ));
  const state = new Map();
  for (const fact of accepted) state.set(String(fact.field), fact);

  const factsForDefinition = (definition) => [...state.entries()]
    .filter(([fieldId]) => fieldMatches(definition.id, fieldId))
    .map(([, fact]) => fact);
  const missing = definitions
    .filter((definition) => definition.required && !factsForDefinition(definition).some(hasProvidedValue))
    .map((definition) => definition.id);
  const violations = [
    ...missing.map((field) => ({
      class: 'SCHEMA_REQUIRED_FIELD_MISSING',
      field,
      message: `${field} requires technician evidence or explicit input.`,
    })),
    ...unsupported.map((fact) => ({
      class: 'SCHEMA_UNSUPPORTED_FIELD',
      field: fact.field,
      message: `${fact.field} is outside this template version.`,
    })),
  ];

  for (const definition of definitions) {
    const fact = factsForDefinition(definition)[0];
    if (!fact) continue;
    const support = String(fact.support_status || '').toUpperCase();
    const sources = Array.isArray(fact.source_refs) ? fact.source_refs : [];
    if ((definition.critical || definition.requiresTechnicianConfirmation)
      && support !== 'CONFIRMED_BY_TECHNICIAN') {
      violations.push({
        class: 'SCHEMA_FIELD_NEEDS_CONFIRMATION',
        field: definition.id,
        message: `${definition.id} requires technician confirmation.`,
      });
    }
    if (sources.length > 0 && sources.every((source) => /^(knowledge|context|rag):/iu.test(String(source)))) {
      violations.push({
        class: 'CONTEXT_NOT_JOB_EVIDENCE',
        field: definition.id,
        message: 'Template context cannot assert a job fact.',
      });
    }
    const allowed = definition.allowedValues || definition.allowedStatuses;
    if (allowed && !allowed.includes(String(fact.value))) {
      violations.push({
        class: 'SCHEMA_INVALID_VALUE',
        field: definition.id,
        message: `${fact.value} is not allowed for ${definition.id}.`,
      });
    }
  }

  const sections = [...new Set(definitions.map((definition) => definition.section))]
    .map((section, index) => ({
      id: `section_${index + 1}`,
      title: section,
      content: definitions.filter((definition) => definition.section === section).map((definition) => {
        const fact = factsForDefinition(definition)[0];
        return {
          field: definition.id,
          label: definition.label,
          value: fact?.value ?? null,
          status: fact ? 'SUPPORTED' : 'MISSING',
        };
      }),
    }));
  const boundSessionId = String(reportSessionId || `server_${traceId}`).slice(0, 160);
  const stateSnapshot = {
    session_id: boundSessionId,
    schema_id: template.schema.id,
    schema_version: template.schema.version,
    fields: Object.fromEntries([...state].map(([key, fact]) => [key, fact.value])),
    unsupported_fields: unsupported.map((fact) => fact.field),
  };
  const draft = {
    report_id: `report_${hashValue({ templateId: template.templateId, reportSessionId: boundSessionId, accepted }).slice(7, 19)}`,
    report_version: 1,
    report_session_id: boundSessionId,
    template_id: template.templateId,
    template_name: template.name,
    template_version: template.templateVersion,
    schema_id: template.schema.id,
    schema_version: template.schema.version,
    context_corpus_id: template.contextCorpus.id,
    context_version: template.contextCorpus.version,
    renderer_id: template.rendererMapping.id,
    renderer_version: template.rendererMapping.version,
    facts_hash: hashValue(accepted),
    structured_state_hash: hashValue(stateSnapshot),
    sections,
    missing_required_fields: missing,
    provenance: template.provenance,
    disclaimer: {
      text: 'Prototype form. Technician confirmation covers only this exact version. Template context is not evidence that work occurred.',
    },
  };
  const status = violations.length ? 'NEEDS_CONFIRMATION' : 'PASS';
  const validation = {
    trace_id: traceId,
    status,
    data: {
      can_enter_technician_review: violations.length === 0,
      gates: { violations },
    },
  };
  const validationReceipt = await reportStore.recordStructuredValidation({
    draft,
    validation,
    facts: accepted,
  });
  return {
    status,
    data: {
      structured_job_state: stateSnapshot,
      draft,
      validation_receipt: validationReceipt,
      gates: { violations },
    },
  };
}
