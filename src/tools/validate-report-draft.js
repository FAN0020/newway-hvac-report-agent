import { FIELD_TO_SECTION, renderFact } from './hvac-schema.js';
import { loadReportModulesConfig, loadReportTemplateConfig } from './hvac-knowledge.js';
import { hashReportDraft, hashValue } from './report-integrity.js';
import { toolEnvelope, toolFailure } from './tool-envelope.js';
import {
  createReportSession,
  factsFromStructuredState,
  mapFactsToStructuredState,
  structuredStateSnapshot,
} from '../../web/report-runtime.js';

function issue(section, claimId, reason) {
  return { section, claim_id: claimId || null, reason };
}

function factEvidenceError(fact) {
  if (!fact?.fact_id || !FIELD_TO_SECTION[fact.field] || !Array.isArray(fact.source_refs) || fact.source_refs.length === 0) return 'Fact is missing an ID, allowed field, or source reference.';
  if (fact.support_status === 'DIRECT_TRANSCRIPT') {
    const hasRawSpan = fact.source_refs.some((ref) => /^transcript:\d+-\d+$/.test(String(ref)));
    const hasConfirmedSpan = fact.source_refs.some((ref) => /^confirmed_text:\d+-\d+$/.test(String(ref)));
    const hasCorrectionReceipt = fact.source_refs.some((ref) => /^correction_receipt:correction_[a-f0-9]{24}$/.test(String(ref)));
    if ((!hasRawSpan && !(hasConfirmedSpan && hasCorrectionReceipt)) || !fact.source_span?.text) return 'DIRECT_TRANSCRIPT fact lacks a verified raw or confirmed-text span.';
    return null;
  }
  if (fact.support_status === 'MANUAL_ENTRY') {
    return fact.source_refs.includes(`manual:${fact.field}`) ? null : 'MANUAL_ENTRY fact lacks its field-specific manual source.';
  }
  if (fact.support_status === 'UNCERTAIN') return null;
  return `Unsupported fact status: ${fact.support_status || 'missing'}.`;
}

export async function validateReportDraft({ draft, facts = [], traceId, knowledgeRoot, templateRoot } = {}) {
  try {
    const [config, template] = await Promise.all([
      loadReportModulesConfig({ knowledgeRoot }),
      loadReportTemplateConfig({ templateRoot }),
    ]);
    const factMap = new Map(facts.filter((fact) => fact?.fact_id).map((fact) => [fact.fact_id, fact]));
    const schemaErrors = [];
    const invalidRefs = [];
    const unsupportedClaims = [];
    const uncertaintyViolations = [];
    const contradictions = [];
    const invalidFactEvidence = facts.map((fact) => ({ fact_id: fact?.fact_id || null, reason: factEvidenceError(fact) })).filter((item) => item.reason);
    const referenced = new Set();
    if (!draft || draft.schema_version !== 'hvac-report-draft.v1' || !Array.isArray(draft.sections)) {
      schemaErrors.push({ path: 'draft', reason: 'Expected hvac-report-draft.v1 with sections array.' });
    }
    if (draft?.schema_id !== 'hvac_service' || draft?.report_schema_version !== '1') {
      schemaErrors.push({ path: 'report_schema', reason: 'Draft must be bound to hvac_service schema version 1.' });
    }
    if (typeof draft?.report_session_id !== 'string' || !draft.report_session_id.trim()) {
      schemaErrors.push({ path: 'report_session_id', reason: 'Draft must be bound to a ReportSession.' });
    } else {
      const state = mapFactsToStructuredState(createReportSession({ id: draft.report_session_id, reportType: 'hvac_service' }), facts);
      const expectedStateHash = hashValue(structuredStateSnapshot(state));
      const expectedFactsHash = hashValue(factsFromStructuredState(state));
      if (draft.structured_state_hash !== expectedStateHash) schemaErrors.push({ path: 'structured_state_hash', reason: 'Draft StructuredJobState binding does not match the validated facts.' });
      if (draft.facts_hash !== expectedFactsHash) schemaErrors.push({ path: 'facts_hash', reason: 'Draft facts binding does not match the validated StructuredJobState.' });
    }
    if (draft?.template_id !== template.template_id || draft?.template_version !== template.template_version) {
      schemaErrors.push({ path: 'template', reason: 'Draft must use the canonical report template and version.' });
    }
    if (draft?.disclaimer?.type !== 'template_text' || draft?.disclaimer?.text !== template.disclaimer) {
      schemaErrors.push({ path: 'disclaimer', reason: 'Draft disclaimer differs from the canonical template.' });
    }
    if (draft?.generation?.deterministic_claim_text !== true) {
      schemaErrors.push({ path: 'generation.deterministic_claim_text', reason: 'Draft does not declare deterministic claim rendering.' });
    }
    if (Array.isArray(draft?.sections) && draft.sections.length > 30) {
      schemaErrors.push({ path: 'sections', reason: 'Draft exceeds the 30-section validation limit.' });
    }
    const allowedSections = new Map([...config.fixed_sections, ...config.conditional_sections].map((section) => [section.id, section]));
    const sectionIds = new Set();
    for (const section of Array.isArray(draft?.sections) ? draft.sections : []) {
      if (!section?.section_id || !Array.isArray(section.items)) {
        schemaErrors.push({ path: 'sections', reason: 'Each section requires section_id and items.' });
        continue;
      }
      const canonicalSection = allowedSections.get(section.section_id);
      if (!canonicalSection) schemaErrors.push({ path: section.section_id, reason: 'Unknown report section.' });
      else if (section.title !== canonicalSection.title) schemaErrors.push({ path: `${section.section_id}.title`, reason: 'Section title differs from the canonical module.' });
      if (sectionIds.has(section.section_id)) schemaErrors.push({ path: section.section_id, reason: 'Duplicate report section.' });
      sectionIds.add(section.section_id);
      if (section.items.length > 100) schemaErrors.push({ path: `${section.section_id}.items`, reason: 'Section exceeds the 100-item validation limit.' });
      for (const item of section.items) {
        if (item?.type === 'template_text') {
          if (item.text !== template.placeholder || Object.hasOwn(item, 'fact_ids')) {
            unsupportedClaims.push(issue(section.section_id, item.claim_id, 'Template text differs from the canonical placeholder or cites facts.'));
          }
          continue;
        }
        if (item?.type !== 'claim' || !item.claim_id || !Array.isArray(item.fact_ids) || item.fact_ids.length === 0 || typeof item.text !== 'string') {
          schemaErrors.push({ path: `${section.section_id}.items`, reason: 'Malformed report claim.' });
          continue;
        }
        if (item.fact_ids.length > 20) {
          schemaErrors.push({ path: `${section.section_id}.${item.claim_id}.fact_ids`, reason: 'Claim exceeds the 20-fact validation limit.' });
          continue;
        }
        if (item.section !== section.section_id) {
          schemaErrors.push({ path: `${section.section_id}.${item.claim_id}.section`, reason: 'Claim section does not match its containing section.' });
        }
        const claimFacts = [];
        for (const factId of item.fact_ids) {
          const fact = factMap.get(String(factId));
          if (!fact) invalidRefs.push(issue(section.section_id, item.claim_id, `Unknown fact_id: ${factId}`));
          else {
            referenced.add(fact.fact_id);
            claimFacts.push(fact);
            if (fact.support_status === 'UNCERTAIN') uncertaintyViolations.push(issue(section.section_id, item.claim_id, `Uncertain fact rendered as a claim: ${fact.fact_id}`));
            if (FIELD_TO_SECTION[fact.field] !== section.section_id) unsupportedClaims.push(issue(section.section_id, item.claim_id, `Fact ${fact.fact_id} belongs to ${FIELD_TO_SECTION[fact.field]}.`));
          }
        }
        const expectedText = claimFacts.map(renderFact).join(' ');
        if (claimFacts.length && (item.claim_mode !== 'FACT_RENDERED' || item.text !== expectedText)) {
          unsupportedClaims.push(issue(section.section_id, item.claim_id, 'Claim text is not the deterministic rendering of its cited facts.'));
        }
      }
    }
    const missingFixedSections = config.fixed_sections.filter((section) => !sectionIds.has(section.id)).map((section) => section.id);
    const eligibleFacts = facts.filter((fact) => fact?.fact_id && fact.support_status !== 'UNCERTAIN' && FIELD_TO_SECTION[fact.field]);
    const omittedFacts = eligibleFacts.filter((fact) => !referenced.has(fact.fact_id)).map((fact) => fact.fact_id);
    const supportedFields = new Set(eligibleFacts.map((fact) => fact.field));
    const missingRequiredFields = config.required_fact_fields.filter((field) => !supportedFields.has(field));
    const completion = eligibleFacts.filter((fact) => fact.field === 'completion_status').map((fact) => JSON.stringify(fact.value));
    if (new Set(completion).size > 1) contradictions.push({ field: 'completion_status', fact_ids: eligibleFacts.filter((fact) => fact.field === 'completion_status').map((fact) => fact.fact_id) });
    let status = 'PASS';
    if (schemaErrors.length || invalidRefs.length || unsupportedClaims.length || omittedFacts.length || contradictions.length || missingFixedSections.length || invalidFactEvidence.length) status = 'FAIL';
    else if (uncertaintyViolations.length) status = 'NEEDS_CONFIRMATION';
    else if (missingRequiredFields.length) status = 'NEEDS_MORE_INFO';
    return toolEnvelope('validate_report_draft', traceId, status, {
      report_hash: draft ? hashReportDraft(draft) : null,
      schema_errors: schemaErrors,
      invalid_fact_references: invalidRefs,
      invalid_fact_evidence: invalidFactEvidence,
      unsupported_claims: unsupportedClaims,
      omitted_supported_fact_ids: omittedFacts,
      contradictions,
      uncertainty_violations: uncertaintyViolations,
      missing_fixed_sections: missingFixedSections,
      missing_required_fields: missingRequiredFields,
      provenance_coverage: eligibleFacts.length ? (eligibleFacts.length - omittedFacts.length) / eligibleFacts.length : 1,
      can_enter_technician_review: status === 'PASS' || status === 'NEEDS_MORE_INFO',
      can_save_or_export: false,
    });
  } catch (error) {
    return toolFailure('validate_report_draft', traceId, error, 'DRAFT_VALIDATION_FAILED');
  }
}
