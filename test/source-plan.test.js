import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSourcePlan } from '../src/agent/source-plan.js';

const template = { templateId: 'source-plan', templateVersion: '1', schema: { fields: [
  { id: 'job.order', label: 'Job order', allowedSources: ['WORK_ORDER', 'TECHNICIAN'], required: true },
  { id: 'job.action', label: 'Action completed', allowedSources: ['TECHNICIAN', 'KNOWLEDGE'], required: true },
  { id: 'standard.reference', label: 'Reference standard', fieldRole: 'NORMATIVE_REFERENCE', allowedSources: ['TECHNICIAN', 'KNOWLEDGE'], required: false },
  { id: 'standard.terms', label: 'Terminology', fieldRole: 'NORMATIVE_REFERENCE', allowedSources: ['KNOWLEDGE'], required: false },
] } };
const session = { session_id: 'session_source_plan', template_binding: { template_id: 'source-plan', template_version: '1' } };
const agentState = { report_fields: [{ field_id: 'job.order', selected_candidate_ids: ['candidate_order'], candidates: [
  { candidate_id: 'candidate_order', support_type: 'AUTHORITATIVE_SYSTEM_DATA' },
] }] };

test('source plan permits model choice only between manager-approved and bound evidence sources', async () => {
  let input;
  const provider = { generateJson: async (request) => {
    input = JSON.parse(request.prompt);
    return { provider: 'ollama', model: 'local-test', data: { fields: [
      { field_id: 'job.order', source: 'TECHNICIAN' },
      { field_id: 'job.action', source: 'KNOWLEDGE' },
      { field_id: 'standard.reference', source: 'KNOWLEDGE' },
    ] } };
  } };
  const plan = await buildSourcePlan({ session, template, agentState, knowledgeAvailable: true, provider, model: 'local-test' });
  assert.deepEqual(input.fields.map((field) => field.field_id), ['job.order', 'standard.reference']);
  assert.deepEqual(input.fields[0].eligible_sources, ['WORK_ORDER', 'TECHNICIAN']);
  assert.equal(plan.fields[0].suggested_source, 'TECHNICIAN');
  assert.equal(plan.fields[0].basis, 'MODEL_SUGGESTION');
  assert.equal(plan.fields[1].suggested_source, 'TECHNICIAN');
  assert.equal(plan.fields[1].basis, 'RULE_FALLBACK');
  assert.equal(plan.fields[2].suggested_source, 'KNOWLEDGE');
  assert.equal(plan.fields[2].basis, 'MODEL_SUGGESTION');
  assert.equal(plan.fields[3].suggested_source, 'KNOWLEDGE');
  assert.equal(plan.fields[3].basis, 'RULE_FALLBACK');
  assert.equal(plan.model.status, 'MODEL_SUGGESTED');
});

test('invalid model output and provider failure fail back to reviewed work order without job-fact invention', async () => {
  for (const provider of [
    { generateJson: async () => ({ data: { fields: [{ field_id: 'job.order', source: 'KNOWLEDGE' }] } }) },
    { generateJson: async () => { throw Object.assign(new Error('offline'), { code: 'OLLAMA_UNAVAILABLE' }); } },
  ]) {
    const plan = await buildSourcePlan({ session, template, agentState, knowledgeAvailable: true, provider, model: 'local-test' });
    assert.equal(plan.fields[0].suggested_source, 'WORK_ORDER');
    assert.equal(plan.fields[0].basis, 'RULE_FALLBACK');
    assert.equal(plan.fields[1].suggested_source, 'TECHNICIAN');
    assert.equal(plan.fields[2].suggested_source, 'TECHNICIAN');
    assert.equal(plan.fields[3].suggested_source, 'KNOWLEDGE');
  }
});

test('work order is not eligible without selected reviewed evidence', async () => {
  const plan = await buildSourcePlan({ session, template, agentState: { report_fields: [] }, knowledgeAvailable: true });
  assert.deepEqual(plan.fields[0].eligible_sources, ['TECHNICIAN']);
  assert.equal(plan.fields[0].suggested_source, 'TECHNICIAN');
  assert.deepEqual(plan.fields[2].eligible_sources, ['TECHNICIAN', 'KNOWLEDGE']);
});

test('knowledge is not suggested when no retrievable template-bound corpus is available', async () => {
  const plan = await buildSourcePlan({ session, template, agentState });
  assert.deepEqual(plan.fields[2].eligible_sources, ['TECHNICIAN']);
  assert.equal(plan.fields[2].suggested_source, 'TECHNICIAN');
  assert.equal(plan.fields[3].suggested_source, null);
});
