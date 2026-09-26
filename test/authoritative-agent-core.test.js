import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFieldCandidate,
  createGuidanceContext,
  createReportSession,
} from '../src/domain/index.js';
import {
  officialFactsFromAgentState,
  runAuthoritativeAgent,
} from '../src/agent/index.js';

const CREATED_AT = '2026-09-27T10:00:00.000Z';

function template(fields) {
  return {
    templateId: 'agent-core-test-template',
    templateVersion: '1.0.0',
    domain: 'SBS_BUS',
    schema: { id: 'agent-core-test-schema', version: '1.0.0', fields },
  };
}

function session() {
  return createReportSession({
    session_id: 'session_agent_core_test',
    template_binding: { template_id: 'agent-core-test-template', template_version: '1.0.0' },
    context_binding: { context_id: 'SBS/BUS', context_version: '1.0.0', scope_id: 'SBS_BUS' },
    job_context_ref: 'job-context:AGENT-CORE',
    created_at: CREATED_AT,
  });
}

let evidenceSequence = 0;
function candidate({ field, claim, support = 'TRANSCRIPT_EVIDENCE', assessment = 'VALID', unit, risk = 'STANDARD', confidence } = {}) {
  evidenceSequence += 1;
  return createFieldCandidate({
    session_id: 'session_agent_core_test',
    field_id: field,
    claim,
    unit,
    support_type: support,
    assessment,
    evidence_refs: support === 'AI_INFERENCE' ? [] : [{ evidence_id: `evidence_agent_${evidenceSequence}`, span_id: `span_agent_${evidenceSequence}` }],
    source_ref: support === 'AI_INFERENCE' ? null : `evidence_agent_${evidenceSequence}`,
    extraction: { method: 'agent-core-test', version: '1' },
    risk_class: risk,
    confidence_class: confidence || (support === 'AI_INFERENCE' ? 'INFERRED' : assessment === 'UNCERTAIN' ? 'UNCERTAIN' : 'DIRECT_EVIDENCE'),
    source_context: { domain: 'SBS_BUS', context_id: 'SBS/BUS', context_version: '1.0.0', scope_id: 'SBS_BUS' },
  });
}

function byField(result, fieldId) {
  return result.report_fields.find((field) => field.field_id === fieldId);
}

test('MergeEngine preserves all eight FieldState meanings independently from SupportType', () => {
  const reportTemplate = template([
    { id: 'known', label: 'Known', type: 'string' },
    { id: 'none', label: 'None', type: 'string' },
    { id: 'na', label: 'N/A', type: 'string' },
    { id: 'unknown', label: 'Unknown', type: 'string' },
    { id: 'uncertain', label: 'Uncertain', type: 'string' },
    { id: 'conflict', label: 'Conflict', type: 'string' },
    { id: 'invalid', label: 'Invalid', type: 'measurement', allowedUnits: ['mm'] },
    { id: 'inferred', label: 'Inferred', type: 'string' },
  ]);
  const result = runAuthoritativeAgent({
    session: session(),
    template: reportTemplate,
    candidates: [
      candidate({ field: 'known', claim: { kind: 'VALUE', value: 'observed' } }),
      candidate({ field: 'none', claim: { kind: 'EXPLICIT_NONE' }, support: 'MANUAL_TECHNICIAN_INPUT' }),
      candidate({ field: 'na', claim: { kind: 'NOT_APPLICABLE' }, support: 'AUTHORITATIVE_SYSTEM_DATA' }),
      candidate({ field: 'uncertain', claim: { kind: 'VALUE', value: 'possibly worn' }, assessment: 'UNCERTAIN' }),
      candidate({ field: 'conflict', claim: { kind: 'VALUE', value: '8300-354' }, support: 'AUTHORITATIVE_SYSTEM_DATA' }),
      candidate({ field: 'conflict', claim: { kind: 'VALUE', value: '8300-345' } }),
      candidate({ field: 'invalid', claim: { kind: 'VALUE', value: { value: 12, unit: 'bar' } }, unit: 'bar' }),
      candidate({ field: 'inferred', claim: { kind: 'VALUE', value: 'possible bearing wear' }, support: 'AI_INFERENCE' }),
    ],
    guidance_contexts: [],
    created_at: CREATED_AT,
  });

  assert.deepEqual(Object.fromEntries(result.report_fields.map((field) => [field.field_id, field.state])), {
    known: 'KNOWN_VALUE',
    none: 'EXPLICIT_NONE',
    na: 'NOT_APPLICABLE',
    unknown: 'UNKNOWN',
    uncertain: 'UNCERTAIN',
    conflict: 'CONFLICT',
    invalid: 'INVALID',
    inferred: 'INFERRED',
  });
  assert.equal(byField(result, 'known').candidates[0].support_type, 'TRANSCRIPT_EVIDENCE');
  assert.equal(byField(result, 'inferred').candidates[0].support_type, 'AI_INFERENCE');
  assert.equal(byField(result, 'conflict').candidates.length, 2);
  assert.deepEqual(byField(result, 'conflict').candidates.flatMap((item) => item.evidence_refs.map((ref) => ref.evidence_id)).length, 2);
  assert.ok(result.resolution_queue.some((item) => item.field_id === 'uncertain' && item.type === 'UNCERTAIN'));
  assert.equal(result.validation_issues.find((item) => item.field_id === 'uncertain').blocking, false);
});

test('Active Completeness blocks required missing fields but reports optional missing without a question', () => {
  const result = runAuthoritativeAgent({
    session: session(),
    template: template([
      { id: 'required.value', label: 'Required value', type: 'string', required: true },
      { id: 'optional.value', label: 'Optional value', type: 'string', required: false },
    ]),
    candidates: [], guidance_contexts: [], created_at: CREATED_AT,
  });

  assert.deepEqual(result.completeness.missing_required_fields, ['required.value']);
  assert.deepEqual(result.completeness.missing_optional_fields, ['optional.value']);
  assert.equal(result.completeness.complete, false);
  assert.deepEqual(result.resolution_queue.map((item) => item.field_id), ['required.value']);
  assert.equal(result.resolution_queue[0].type, 'MISSING');
});

test('ValidationEngine rejects invalid units and explicit ranges and official facts omit blocked candidates', () => {
  const result = runAuthoritativeAgent({
    session: session(),
    template: template([
      { id: 'measurement.clearance', label: 'Clearance', type: 'measurement', allowedUnits: ['mm'], minimum: 0, maximum: 100 },
      { id: 'work_performed', label: 'Work performed', type: 'string' },
    ]),
    candidates: [
      candidate({ field: 'measurement.clearance', claim: { kind: 'VALUE', value: { value: 120, unit: 'cm' } }, unit: 'cm' }),
      candidate({ field: 'work_performed', claim: { kind: 'VALUE', value: 'Will replace the door actuator tomorrow.' } }),
    ],
    guidance_contexts: [], created_at: CREATED_AT,
  });

  assert.equal(byField(result, 'measurement.clearance').state, 'INVALID');
  assert.ok(result.validation_issues.some((issue) => issue.code === 'UNIT_NOT_ALLOWED'));
  assert.ok(result.validation_issues.some((issue) => issue.code === 'VALUE_ABOVE_MAXIMUM'));
  assert.ok(result.validation_issues.some((issue) => issue.code === 'PLANNED_ACTION_NOT_COMPLETED'));
  assert.deepEqual(officialFactsFromAgentState(result), []);
});

test('conditional post-work testing is required only when rectification occurred', () => {
  const reportTemplate = template([
    { id: 'work_performed', label: 'Rectification', type: 'string' },
    {
      id: 'test.result', label: 'Post-work test', type: 'string',
      requiredWhen: { field: 'work_performed', operator: 'HAS_VALUE' },
    },
  ]);
  const noRectification = runAuthoritativeAgent({
    session: session(), template: reportTemplate,
    candidates: [candidate({ field: 'work_performed', claim: { kind: 'EXPLICIT_NONE' } })],
    guidance_contexts: [], created_at: CREATED_AT,
  });
  const rectified = runAuthoritativeAgent({
    session: session(), template: reportTemplate,
    candidates: [candidate({ field: 'work_performed', claim: { kind: 'VALUE', value: 'Replaced the bearing.' } })],
    guidance_contexts: [], created_at: CREATED_AT,
  });

  assert.equal(noRectification.validation_issues.some((issue) => issue.field_id === 'test.result'), false);
  assert.ok(rectified.validation_issues.some((issue) => issue.code === 'CONDITIONAL_FIELD_REQUIRED' && issue.field_id === 'test.result'));
  assert.ok(rectified.resolution_queue.some((item) => item.type === 'CONDITIONAL_REQUIREMENT' && item.field_id === 'test.result'));
});

test('safety work is first, duplicate questions collapse, and one item can own multiple issues', () => {
  const result = runAuthoritativeAgent({
    session: session(),
    template: template([
      { id: 'ordinary.required', label: 'Ordinary required', type: 'string', required: true },
      { id: 'completion.state', label: 'Return to service', type: 'status', required: true, critical: true, requiresTechnicianConfirmation: true, allowedValues: ['READY', 'NOT_READY', 'RESTRICTED', 'FURTHER_INSPECTION'] },
    ]),
    candidates: [candidate({
      field: 'completion.state', claim: { kind: 'VALUE', value: 'BROKEN' },
      support: 'AUTHORITATIVE_SYSTEM_DATA', risk: 'CRITICAL',
    })],
    guidance_contexts: [], created_at: CREATED_AT,
  });

  assert.equal(result.resolution_queue[0].field_id, 'completion.state');
  assert.equal(result.resolution_queue[0].type, 'SAFETY_CONFIRMATION');
  assert.ok(result.resolution_queue[0].issue_ids.length >= 2);
  assert.equal(result.resolution_queue.filter((item) => item.field_id === 'completion.state').length, 1);
  assert.equal(result.resolution_queue[0].answer_type, 'SINGLE_SELECT');
});

test('root cause absence remains UNKNOWN while explicit not-established and suspected meanings remain distinct', () => {
  const reportTemplate = template([{ id: 'diagnosis.root_cause', label: 'Root cause', type: 'string', allowNotEstablished: true }]);
  const absent = runAuthoritativeAgent({ session: session(), template: reportTemplate, candidates: [], guidance_contexts: [], created_at: CREATED_AT });
  const notEstablished = runAuthoritativeAgent({
    session: session(), template: reportTemplate,
    candidates: [candidate({ field: 'diagnosis.root_cause', claim: { kind: 'VALUE', value: 'Root cause not established' }, support: 'MANUAL_TECHNICIAN_INPUT' })],
    guidance_contexts: [], created_at: CREATED_AT,
  });
  const suspected = runAuthoritativeAgent({
    session: session(), template: reportTemplate,
    candidates: [candidate({ field: 'diagnosis.root_cause', claim: { kind: 'VALUE', value: 'Suspected bearing wear' }, support: 'MANUAL_TECHNICIAN_INPUT', assessment: 'UNCERTAIN' })],
    guidance_contexts: [], created_at: CREATED_AT,
  });

  assert.equal(byField(absent, 'diagnosis.root_cause').state, 'UNKNOWN');
  assert.equal(byField(notEstablished, 'diagnosis.root_cause').state, 'KNOWN_VALUE');
  assert.equal(byField(notEstablished, 'diagnosis.root_cause').value, 'Root cause not established');
  assert.equal(byField(suspected, 'diagnosis.root_cause').state, 'UNCERTAIN');
  assert.deepEqual(officialFactsFromAgentState(suspected), []);
});

test('GuidanceContext can trigger a targeted question but can never satisfy work performed', () => {
  const guidance = createGuidanceContext({
    session_id: 'session_agent_core_test', context_id: 'SBS/BUS', scope_id: 'SBS_BUS', context_version: '1.0.0',
    query: 'door rectification', retrieval_method: 'LEXICAL_DETERMINISTIC', retrieval_version: '1', permitted_corpora: ['knowledge:SBS_BUS'],
    retrieved_at: CREATED_AT,
    passages: [{ source_type: 'knowledge', scope_id: 'SBS_BUS', document_id: 'door-sop', chunk_id: 'chunk-1', document_version: '1', text: 'Rectification normally requires a post-work functional test.', score: 1, provenance: { version: '1' } }],
    applicable_modules: ['tests_results'],
    follow_up_questions: [{ section_id: 'tests_results', field: 'test.result', question: 'What post-work test was performed?', answer_source: 'technician_confirmation' }],
  });
  const result = runAuthoritativeAgent({
    session: session(),
    template: template([
      { id: 'work_performed', label: 'Work performed', type: 'string' },
      { id: 'test.result', label: 'Post-work test', type: 'string' },
    ]),
    candidates: [], guidance_contexts: [guidance], created_at: CREATED_AT,
  });

  assert.equal(byField(result, 'work_performed').state, 'UNKNOWN');
  assert.deepEqual(officialFactsFromAgentState(result), []);
  assert.ok(result.resolution_queue.some((item) => item.field_id === 'test.result' && item.type === 'CONDITIONAL_REQUIREMENT'));
  assert.equal(result.report_fields.some((field) => field.candidates.some((item) => item.support_type === 'RAG_GUIDANCE')), false);
});
