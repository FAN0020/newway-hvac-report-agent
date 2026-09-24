import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveFieldServiceKnowledge } from '../src/tools/rag-knowledge.js';
import { generateReportDraft } from '../src/tools/generate-report-draft.js';
import { retrieveReportTemplate } from '../src/tools/hvac-knowledge.js';
import { planReportSections } from '../src/tools/plan-report-sections.js';

test('RAG retrieves domain evidence with stable source citations', async () => {
  const result = await retrieveFieldServiceKnowledge({
    query: '原油输油管道 安全检查 实际情况 检查结果',
    domains: ['petrochemical'],
    topK: 3,
    traceId: 'trace_rag_pipeline',
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.data.results.length > 0);
  assert.ok(result.data.results.every((item) => item.domain === 'petrochemical'));
  assert.ok(result.data.results.every((item) => item.chunk_id && item.document_id && item.source_hash));
  assert.equal(result.data.results[0].document_id, 'crude-oil-pipeline-safety');
});

test('RAG query can be built from source-bound facts', async () => {
  const result = await retrieveFieldServiceKnowledge({
    facts: [{ field: 'inspection_findings', value: '充电站接地电阻检测异常', support_status: 'DIRECT_TRANSCRIPT' }],
    domains: ['power_energy'],
    traceId: 'trace_rag_facts',
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.data.query.includes('充电站'));
  assert.ok(result.data.results.some((item) => item.document_id === 'charging-station-periodic-inspection'));
});

test('retrieved knowledge is carried as reference-only citations, never report facts', async () => {
  const facts = [{
    fact_id: 'fact_test',
    field: 'inspection_findings',
    value: '发现运行电容损坏',
    source_refs: ['transcript:0-10'],
    source_span: { start: 0, end: 10, text: '发现运行电容损坏' },
    support_status: 'DIRECT_TRANSCRIPT',
  }];
  const planned = await planReportSections({ facts, traceId: 'trace_plan_rag' });
  const template = await retrieveReportTemplate({ traceId: 'trace_template_rag' });
  planned.data.knowledge_version = 'test-version';
  planned.data.retrieved_evidence = [{
    chunk_id: 'source:chunk-001', document_id: 'source', title: 'Source', section: 'Check',
    source: 'source.docx', source_hash: 'sha256:abc', score: 1.25, text: 'Customary inspection step',
  }];
  const generated = await generateReportDraft({ facts, plan: planned.data, template: template.data.template, traceId: 'trace_generate_rag' });
  assert.equal(generated.status, 'PASS');
  assert.equal(generated.data.draft.knowledge_context.usage, 'REFERENCE_ONLY_NOT_SERVICE_FACTS');
  assert.equal(generated.data.draft.knowledge_context.citations[0].chunk_id, 'source:chunk-001');
  assert.equal(JSON.stringify(generated.data.draft.sections).includes('Customary inspection step'), false);
});

