import { buildSourcePlan } from '../src/agent/source-plan.js';
import { OllamaProvider } from '../src/providers/ollama.js';

const model = process.env.HVAC_OLLAMA_MODEL || 'qwen3.5:9b';
const provider = new OllamaProvider();
const health = await provider.health();
if (!health.ready || !health.models.includes(model)) {
  throw new Error(`Local Ollama model ${model} is unavailable.`);
}

const template = { templateId: 'batch3-synthetic-source-plan', templateVersion: '1', schema: { fields: [
  { id: 'work.order', label: 'Reviewed work order number', section: 'Job', required: true, allowedSources: ['WORK_ORDER', 'TECHNICIAN'], fieldRole: 'JOB_FACT' },
  { id: 'work.action', label: 'Action completed on this job', section: 'Job', required: true, allowedSources: ['TECHNICIAN', 'KNOWLEDGE'], fieldRole: 'JOB_FACT' },
  { id: 'standard.reference', label: 'Applicable maintenance standard reference', section: 'Reference', required: false, allowedSources: ['TECHNICIAN', 'KNOWLEDGE'], fieldRole: 'NORMATIVE_REFERENCE' },
] } };
const session = { session_id: 'batch3-synthetic-session', template_binding: { template_id: template.templateId, template_version: template.templateVersion } };
const agentState = { report_fields: [{ field_id: 'work.order', selected_candidate_ids: ['reviewed_order'], candidates: [
  { candidate_id: 'reviewed_order', support_type: 'AUTHORITATIVE_SYSTEM_DATA' },
] }] };
const plan = await buildSourcePlan({ session, template, agentState, knowledgeAvailable: true, provider, model });
if (plan.fields[1].suggested_source !== 'TECHNICIAN') throw new Error('A job fact was assigned to knowledge.');
if (!['TECHNICIAN', 'KNOWLEDGE'].includes(plan.fields[2].suggested_source)) throw new Error('Normative reference has an invalid source.');
console.log(JSON.stringify({ model: plan.model, fields: plan.fields.map((field) => ({
  id: field.field_id, role: field.field_role, allowed: field.allowed_sources,
  eligible: field.eligible_sources, suggested: field.suggested_source, basis: field.basis,
})) }, null, 2));
