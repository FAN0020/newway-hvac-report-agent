import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TemplateStore } from '../src/storage/templates.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';
import { createFieldCandidate, createReportSession } from '../src/domain/index.js';
import { officialFactsFromAgentState, runAuthoritativeAgent } from '../src/agent/index.js';

async function storeFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'servicescribe-template-batch1-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new TemplateStore({ root });
}

function candidate(field, value, support, sequence) {
  return createFieldCandidate({
    session_id: 'session_batch1', field_id: field, claim: value && typeof value === 'object' && value.kind ? value : { kind: 'VALUE', value },
    support_type: support, assessment: 'VALID',
    evidence_refs: [{ evidence_id: `evidence_${sequence}`, span_id: `span_${sequence}` }],
    source_ref: `evidence_${sequence}`, extraction: { method: 'batch1-test', version: '1' },
    risk_class: 'STANDARD', confidence_class: 'DIRECT_EVIDENCE',
    source_context: { domain: 'CUSTOM', context_id: 'custom-context', context_version: '1.0.0', scope_id: 'CUSTOM' },
  });
}

function agent(template, candidates) {
  return runAuthoritativeAgent({
    session: createReportSession({ session_id: 'session_batch1',
      template_binding: { template_id: template.templateId, template_version: template.templateVersion },
      context_binding: { context_id: 'custom-context', context_version: '1.0.0', scope_id: 'CUSTOM' },
      job_context_ref: 'job-context:none', created_at: '2026-10-01T00:00:00.000Z' }),
    template, candidates, created_at: '2026-10-01T00:00:00.000Z',
  });
}

test('text template proposals are unreviewed; model suggestions cannot publish before manager saves rules', async (t) => {
  const store = await storeFor(t);
  let draft = await store.createDraft({ name: 'Bus Checks', filename: 'checks.md', mimeType: 'text/markdown',
    bytes: Buffer.from('# Job\n- Parts replaced:\n- Part numbers:\n') });
  assert.equal(draft.analysis.status, 'PROPOSED_FOR_REVIEW');
  assert.deepEqual(draft.analysis.detectedFields.map((field) => field.id), ['parts_replaced', 'part_numbers']);
  assert.equal(draft.schemaReview.status, 'PENDING');
  await assert.rejects(() => store.publish(draft.id), { code: 'TEMPLATE_PUBLISH_GATES_FAILED' });
  draft = await store.proposeWithModel(draft.id, { model: 'test-local-model', provider: { generateJson: async () => ({ data: { fields: [
    { id: 'parts_replaced', label: 'Parts replaced', required: true, allowedSources: ['KNOWLEDGE'] },
  ] } }) } });
  assert.equal(draft.analysis.detectedFields[0].proposalOrigin, 'LOCAL_LLM_UNREVIEWED');
  assert.equal(draft.schemaReview.status, 'PENDING');
  await assert.rejects(() => store.saveSchema(draft.id, { fields: draft.analysis.detectedFields }), { code: 'INVALID_TEMPLATE_SCHEMA' });
  await assert.rejects(() => store.publish(draft.id), { code: 'TEMPLATE_PUBLISH_GATES_FAILED' });
});

test('unsupported and undecodable files have a manual definition path', async (t) => {
  const store = await storeFor(t);
  const binary = await store.createDraft({ name: 'Binary Form', filename: 'form.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from('PK prototype') });
  const malformed = await store.createDraft({ name: 'Malformed Form', filename: 'form.txt', mimeType: 'text/plain', bytes: Buffer.from([0xff, 0x00]) });
  for (const draft of [binary, malformed]) {
    assert.equal(draft.analysis.status, 'MANUAL_REVIEW_REQUIRED');
    assert.match(draft.analysis.undetectedReason, /manually/iu);
    await assert.rejects(() => store.proposeWithModel(draft.id, { model: 'test', provider: { generateJson: () => { throw new Error('should not run'); } } }), { code: 'TEMPLATE_MANUAL_DEFINITION_REQUIRED' });
  }
});

test('published manager rules control conditional requirements, sources, explicit states and confirmation', async (t) => {
  const store = await storeFor(t);
  let draft = await store.createDraft({ name: 'Parts Record', filename: 'parts.txt', mimeType: 'text/plain', bytes: Buffer.from('Parts replaced:\nPart numbers:\n') });
  const fields = [
    { id: 'parts_replaced', label: 'Parts replaced?', type: 'string', required: true, allowedSources: ['TECHNICIAN'] },
    { id: 'part_numbers', label: 'Part numbers', type: 'string', required: false,
      requiredWhen: { field: 'parts_replaced', operator: 'IS', value: 'yes' },
      allowedSources: ['TECHNICIAN'], critical: true, requiresTechnicianConfirmation: true,
      allowExplicitNone: false, allowNotApplicable: false },
  ];
  draft = await store.saveSchema(draft.id, { fields });
  assert.equal(draft.schemaReview.fields[1].requiredWhen.value, 'yes');
  assert.deepEqual(draft.schemaReview.fields[1].allowedSources, ['TECHNICIAN']);
  await store.waiveContext(draft.id, 'No reference needed');
  await store.runContractTest(draft.id);
  const published = await store.publish(draft.id);
  assert.equal(published.schema.fields[1].requiresTechnicianConfirmation, true);
  assert.equal((await store.listPublished()).length, 1);
  await assert.rejects(() => store.saveSchema(draft.id, { fields }), /immutable/iu);
  await assert.rejects(() => store.publish(draft.id), /immutable/iu);

  const unknown = agent(published, []);
  assert.ok(unknown.validation_issues.some((issue) => issue.code === 'REQUIRED_FIELD_MISSING' && issue.field_id === 'parts_replaced'));
  assert.ok(!unknown.validation_issues.some((issue) => issue.code === 'CONDITIONAL_FIELD_REQUIRED'));
  const no = agent(published, [candidate('parts_replaced', 'no', 'TRANSCRIPT_EVIDENCE', 1)]);
  assert.ok(!no.validation_issues.some((issue) => issue.code === 'CONDITIONAL_FIELD_REQUIRED'));
  const unsupportedNone = agent(published, [candidate('parts_replaced', { kind: 'EXPLICIT_NONE' }, 'MANUAL_TECHNICIAN_INPUT', 11)]);
  assert.ok(unsupportedNone.validation_issues.some((issue) => issue.code === 'EXPLICIT_NONE_NOT_ALLOWED'));
  assert.ok(!officialFactsFromAgentState(unsupportedNone).length);
  const yes = agent(published, [candidate('parts_replaced', 'yes', 'TRANSCRIPT_EVIDENCE', 2)]);
  assert.ok(yes.validation_issues.some((issue) => issue.code === 'CONDITIONAL_FIELD_REQUIRED' && issue.field_id === 'part_numbers'));
  const unauthorized = agent(published, [candidate('parts_replaced', 'yes', 'TRANSCRIPT_EVIDENCE', 3), candidate('part_numbers', 'PN-42', 'AUTHORITATIVE_SYSTEM_DATA', 4)]);
  assert.ok(unauthorized.validation_issues.some((issue) => issue.code === 'SOURCE_NOT_ALLOWED' && issue.field_id === 'part_numbers'));
  assert.ok(!officialFactsFromAgentState(unauthorized).some((fact) => fact.field === 'part_numbers'));
  const unconfirmed = agent(published, [candidate('parts_replaced', 'yes', 'TRANSCRIPT_EVIDENCE', 5), candidate('part_numbers', 'PN-42', 'TRANSCRIPT_EVIDENCE', 6)]);
  assert.ok(unconfirmed.validation_issues.some((issue) => issue.code === 'CRITICAL_CONFIRMATION_REQUIRED' && issue.field_id === 'part_numbers'));
  assert.ok(!officialFactsFromAgentState(unconfirmed).some((fact) => fact.field === 'part_numbers'));
});

test('invalid conditional references and cycles fail schema review', async (t) => {
  const store = await storeFor(t);
  const draft = await store.createDraft({ name: 'Invalid Rules', filename: 'rules.txt', mimeType: 'text/plain', bytes: Buffer.from('A:\nB:\n') });
  await assert.rejects(() => store.saveSchema(draft.id, { fields: [{ id: 'a', label: 'A', requiredWhen: { field: 'absent', operator: 'HAS_VALUE' } }] }), { code: 'INVALID_TEMPLATE_SCHEMA' });
  await assert.rejects(() => store.saveSchema(draft.id, { fields: [
    { id: 'a', label: 'A', requiredWhen: { field: 'b', operator: 'HAS_VALUE' } },
    { id: 'b', label: 'B', requiredWhen: { field: 'a', operator: 'HAS_VALUE' } },
  ] }), { code: 'INVALID_TEMPLATE_SCHEMA' });
  await assert.rejects(() => store.saveSchema(draft.id, { fields: [
    { id: 'inspection', label: 'Inspection', type: 'status', required: true, allowedStatuses: ['OK', 'NOT_CHECKED'] },
  ] }), { code: 'INVALID_TEMPLATE_SCHEMA' });
});

test('another draft with the same template id cannot overwrite a published version', async (t) => {
  const store = await storeFor(t);
  const makeReady = async () => {
    const draft = await store.createDraft({ name: 'Immutable Checklist', filename: 'check.txt', mimeType: 'text/plain', bytes: Buffer.from('Result:\n') });
    await store.saveSchema(draft.id, { fields: [{ id: 'result', label: 'Result', required: true }] });
    await store.waiveContext(draft.id, 'No context');
    await store.runContractTest(draft.id);
    return draft;
  };
  const first = await makeReady();
  const published = await store.publish(first.id);
  const second = await makeReady();
  await assert.rejects(() => store.publish(second.id), { code: 'TEMPLATE_VERSION_EXISTS' });
  assert.deepEqual((await store.listPublished())[0], published);
});

test('session creation prefills only fields whose published rules allow work orders', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'servicescribe-prefill-batch1-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const template = {
    templateId: 'batch1-prefill', name: 'Prefill', status: 'PUBLISHED', templateVersion: '1.0.0', domain: 'CUSTOM',
    presentation: { displayName: 'Prefill' },
    schema: { id: 'batch1-prefill-schema', version: '1.0.0', fields: [
      { id: 'asset.id', label: 'Vehicle ID', type: 'string', required: true, allowedSources: ['TECHNICIAN', 'WORK_ORDER'] },
      { id: 'work_performed', label: 'Work performed', type: 'string', required: true, allowedSources: ['TECHNICIAN'] },
    ] },
    contextCorpus: { id: 'batch1-prefill-context', version: '1.0.0', sources: [] },
    adapter: { id: 'manual-schema-v1', version: '1.0.0' },
  };
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore: new ReportSessionStore({ root: path.join(root, 'authority') }),
    whisperProvider: { transcribe: async () => { throw new Error('Unexpected transcription.'); } },
    templateProvider: async () => template,
    jobContextProvider: { resolve: async () => ({ record_id: 'WO-1', version: 'reviewed-v1', fields: [
      { field_id: 'asset.id', value: 'BUS-1' }, { field_id: 'work_performed', value: 'Replaced brakes' },
    ] }) },
    clock: () => '2026-10-01T00:00:00.000Z',
  });
  const result = await service.createSession({ template_id: template.templateId, template_version: template.templateVersion, job_context_ref: 'work-order:WO-1' });
  assert.equal(result.agent_state.report_fields.find((field) => field.field_id === 'asset.id').value, 'BUS-1');
  assert.equal(result.agent_state.report_fields.find((field) => field.field_id === 'work_performed').state, 'UNKNOWN');
  assert.ok(result.agent_state.validation_issues.some((issue) => issue.code === 'REQUIRED_FIELD_MISSING' && issue.field_id === 'work_performed'));
});
