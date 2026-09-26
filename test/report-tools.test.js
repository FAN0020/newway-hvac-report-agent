import assert from 'node:assert/strict';
import test from 'node:test';
import { extractServiceFacts } from '../src/tools/extract-service-facts.js';
import { generateReportDraft } from '../src/tools/generate-report-draft.js';
import { retrieveHvacKnowledge, retrieveReportTemplate } from '../src/tools/hvac-knowledge.js';
import { planReportSections } from '../src/tools/plan-report-sections.js';
import { validateReportDraft } from '../src/tools/validate-report-draft.js';
import { validateReportInput } from '../src/tools/validate-report-input.js';

async function makeDraft(rawText, provider) {
  const extracted = await extractServiceFacts({ transcript: { artifact_id: 'transcript_test', raw_text: rawText }, provider, model: 'fake', traceId: 'trace_extract' });
  const inputValidation = await validateReportInput({ facts: extracted.data.facts, traceId: 'trace_input' });
  const planned = await planReportSections({ facts: extracted.data.facts, traceId: 'trace_plan' });
  const template = await retrieveReportTemplate({ traceId: 'trace_template' });
  const generated = await generateReportDraft({ facts: extracted.data.facts, plan: planned.data, template: template.data.template, traceId: 'trace_generate' });
  const validated = await validateReportDraft({ draft: generated.data.draft, facts: extracted.data.facts, traceId: 'trace_validate' });
  return { extracted, inputValidation, planned, template, generated, validated };
}

test('complete HVAC narration produces a source-bound draft that passes', async () => {
  const result = await makeDraft('客户反映不制冷。检查发现运行电容损坏。更换了一个35微法电容。试机运行正常。问题已解决。建议下次保养清洗滤网。');
  assert.equal(result.inputValidation.status, 'PASS');
  assert.equal(result.generated.status, 'PASS');
  assert.equal(result.validated.status, 'PASS');
  assert.ok(result.extracted.data.facts.every((fact) => fact.source_refs.length > 0));
  assert.equal(result.generated.data.draft.schema_id, 'hvac_service');
  assert.equal(result.generated.data.draft.report_schema_version, '1');
  assert.match(result.generated.data.draft.report_session_id, /^session_/);
  assert.match(result.generated.data.draft.structured_state_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.generated.data.draft.facts_hash, /^sha256:[a-f0-9]{64}$/);
});

test('HVAC validator rejects a draft whose schema/state binding was tampered', async () => {
  const result = await makeDraft('客户反映不制冷。检查发现运行电容损坏。更换了一个35微法电容。试机运行正常。问题已解决。');
  const tampered = structuredClone(result.generated.data.draft);
  tampered.structured_state_hash = `sha256:${'0'.repeat(64)}`;
  const checked = await validateReportDraft({ draft: tampered, facts: result.extracted.data.facts, traceId: 'trace_state_binding' });
  assert.equal(checked.status, 'FAIL');
  assert.ok(checked.data.schema_errors.some((item) => item.path === 'structured_state_hash'));
});

test('parts-only narration stays incomplete and does not invent tests', async () => {
  const result = await makeDraft('换了一个35微法电容。');
  assert.equal(result.inputValidation.status, 'NEEDS_MORE_INFO');
  assert.ok(result.inputValidation.data.follow_up_questions.length <= 3);
  assert.ok(result.inputValidation.data.missing_required_fields.includes('test_results'));
  assert.equal(result.extracted.data.facts.some((fact) => fact.field === 'test_results'), false);
  assert.equal(result.validated.status, 'NEEDS_MORE_INFO');
});

test('negated replacement is not extracted as performed work or a used part', async () => {
  for (const raw_text of ['检查了电容，没有更换电容。', '并未进行更换电容。', '尚未实际更换电容。']) {
    const extracted = await extractServiceFacts({ transcript: { artifact_id: 't_neg', raw_text }, traceId: 'trace_neg' });
    assert.equal(extracted.data.facts.some((fact) => ['work_performed', 'parts_used'].includes(fact.field)), false);
  }
});

test('part quantity is omitted rather than invented when the narration gives no quantity', async () => {
  const extracted = await extractServiceFacts({ transcript: { artifact_id: 't_quantity', raw_text: '更换了35微法电容。' }, traceId: 'trace_quantity' });
  const part = extracted.data.facts.find((fact) => fact.field === 'parts_used');
  assert.ok(part);
  assert.equal(Object.hasOwn(part.value, 'quantity'), false);
});

test('RAG customary step is never promoted to a service fact', async () => {
  const knowledge = await retrieveHvacKnowledge({ queryType: 'TERM_NORMALIZATION', query: '试机', traceId: 'trace_rag' });
  assert.equal(knowledge.status, 'PASS');
  assert.ok(knowledge.data.records.some((record) => record.id === 'term_cooling_test'));
  const extracted = await extractServiceFacts({ transcript: { artifact_id: 't_part', raw_text: '换了一个35微法电容。' }, traceId: 'trace_part' });
  assert.equal(extracted.data.facts.some((fact) => fact.field === 'test_results'), false);
});

test('validator rejects a claim that adds an unsupported test result', async () => {
  const result = await makeDraft('客户反映不制冷。检查发现运行电容损坏。更换了一个35微法电容。试机运行正常。问题已解决。');
  const malicious = structuredClone(result.generated.data.draft);
  const claim = malicious.sections.flatMap((section) => section.items).find((item) => item.type === 'claim');
  claim.text += ' 额外测试了20分钟，温度完全正常。';
  const checked = await validateReportDraft({ draft: malicious, facts: result.extracted.data.facts, traceId: 'trace_attack' });
  assert.equal(checked.status, 'FAIL');
  assert.ok(checked.data.unsupported_claims.length > 0);
});

test('validator rejects forged template text and content hidden beyond validation bounds', async () => {
  const result = await makeDraft('客户反映不制冷。检查发现运行电容损坏。更换了一个35微法电容。试机运行正常。问题已解决。');
  const forged = structuredClone(result.generated.data.draft);
  forged.sections[0].items = [{ type: 'template_text', text: '设备已经安全检测，可以使用。' }];
  const forgedCheck = await validateReportDraft({ draft: forged, facts: result.extracted.data.facts, traceId: 'trace_forged_template' });
  assert.equal(forgedCheck.status, 'FAIL');
  assert.ok(forgedCheck.data.unsupported_claims.length > 0);

  const oversized = structuredClone(result.generated.data.draft);
  oversized.sections.push(...Array.from({ length: 31 }, (_, index) => ({ section_id: `hidden_${index}`, title: 'hidden', items: [{ type: 'template_text', text: '伪造内容' }] })));
  const oversizedCheck = await validateReportDraft({ draft: oversized, facts: result.extracted.data.facts, traceId: 'trace_oversized' });
  assert.equal(oversizedCheck.status, 'FAIL');
  assert.ok(oversizedCheck.data.schema_errors.some((item) => item.reason.includes('30-section')));
});

test('validator rejects client-shaped facts without valid evidence status and source', async () => {
  const result = await makeDraft('客户反映不制冷。检查发现运行电容损坏。更换了一个35微法电容。试机运行正常。问题已解决。');
  const forgedFacts = structuredClone(result.extracted.data.facts);
  forgedFacts[0].support_status = 'DIRECT_TRANSCRIPT';
  forgedFacts[0].source_refs = ['client:asserted'];
  const checked = await validateReportDraft({ draft: result.generated.data.draft, facts: forgedFacts, traceId: 'trace_bad_evidence' });
  assert.equal(checked.status, 'FAIL');
  assert.ok(checked.data.invalid_fact_evidence.length > 0);
});

test('invalid provider JSON shape and provider failure use deterministic extraction', async () => {
  const raw = '换了一个35微法电容。';
  const invalid = await extractServiceFacts({ transcript: { artifact_id: 't_bad_json', raw_text: raw }, provider: { generateJson: async () => ({ data: 'not-an-object' }) }, model: 'fake', traceId: 'trace_bad_json' });
  assert.equal(invalid.status, 'PASS');
  assert.equal(invalid.data.deterministic_fallback_used, true);
  assert.ok(invalid.data.facts.some((fact) => fact.field === 'parts_used'));
  const failed = await extractServiceFacts({ transcript: { artifact_id: 't_failed', raw_text: raw }, provider: { generateJson: async () => { throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); } }, model: 'fake', traceId: 'trace_failed' });
  assert.equal(failed.status, 'PASS');
  assert.ok(failed.warnings.some((warning) => warning.includes('OFFLINE')));
});

test('provider facts with invalid spans and manual-only inference are discarded', async () => {
  const raw = '客户反映不制冷。';
  const provider = { generateJson: async () => ({ data: { facts: [
    { field: 'test_results', value: '运行20分钟正常', source_span: { start: 0, end: 2, text: '不匹配' } },
    { field: 'cost_quote', value: 500, source_span: { start: 0, end: raw.length, text: raw } },
  ] } }) };
  const result = await extractServiceFacts({ transcript: { artifact_id: 't_attack', raw_text: raw }, provider, model: 'fake', traceId: 'trace_attack_fact' });
  assert.equal(result.data.facts.some((fact) => ['test_results', 'cost_quote'].includes(fact.field)), false);
});
