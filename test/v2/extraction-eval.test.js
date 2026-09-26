import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { extractV2Facts } from '../../src/tools/extract-v2-facts.js';
import { createReportSession, createResolveQueue, mapFactsToStructuredState } from '../../web/report-runtime.js';

const fixture = JSON.parse(await fs.readFile(new URL('../fixtures/sbs-extraction-eval.v1.json', import.meta.url), 'utf8'));

for (const evaluationCase of fixture.cases) {
  test(`SBS extraction eval: ${evaluationCase.id}`, async () => {
    const { facts } = await extractV2Facts({ contextId: evaluationCase.context_id, rawText: evaluationCase.input });
    const fields = new Set(facts.map((fact) => fact.field));
    for (const field of evaluationCase.expected_fields) assert.ok(fields.has(field), `false missing: ${field}`);
    for (const field of evaluationCase.forbidden_fields) assert.ok(!fields.has(field), `false supported: ${field}`);
    for (const [field, expected] of Object.entries(evaluationCase.expected_values || {})) {
      assert.equal(facts.find((fact) => fact.field === field)?.value, expected, `wrong value: ${field}`);
    }
    for (const fact of facts) {
      assert.equal(fact.support_status, 'DIRECT_TRANSCRIPT');
      assert.equal(fact.source, 'manual');
    }
    if (evaluationCase.expected_resolve) {
      const session = mapFactsToStructuredState(createReportSession({ id: evaluationCase.id, reportType: evaluationCase.report_type }), facts);
      assert.deepEqual(createResolveQueue(session).map((item) => `${item.type}:${item.fieldId}`), evaluationCase.expected_resolve);
    }
  });
}
