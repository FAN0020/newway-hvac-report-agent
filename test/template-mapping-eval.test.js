import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { extractV2Facts } from '../src/tools/extract-v2-facts.js';
import { mapFactsForTemplate } from '../web/template-catalog.js';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/template-mapping-eval.v1.json', import.meta.url), 'utf8'));

for (const evaluationCase of fixture.cases) {
  test(`template extraction adapter: ${evaluationCase.id}`, async () => {
    const extracted = await extractV2Facts({ contextId: evaluationCase.context_id, rawText: evaluationCase.input });
    const mapped = mapFactsForTemplate(evaluationCase.template_id, extracted.facts);
    assert.ok(mapped.facts.some((fact) => fact.field === evaluationCase.expected_accepted),
      `${evaluationCase.expected_accepted} should map into ${evaluationCase.template_id}`);
    assert.ok(mapped.facts.every((fact) => fact.support_status === 'DIRECT_TRANSCRIPT'));
  });
}

test('negated and recommended part replacements never enter any bus template as performed work', async () => {
  for (const input of ['Did not replace the door control module.', 'Recommend replacing the door control module.']) {
    const extracted = await extractV2Facts({ contextId: 'SBS/BUS', rawText: input });
    for (const templateId of ['bus-preventive-maintenance-inspection', 'bus-defect-rectification-corrective-maintenance', 'bus-passenger-door-safety-equipment-inspection']) {
      const mapped = mapFactsForTemplate(templateId, extracted.facts);
      assert.equal(mapped.facts.some((fact) => fact.field === 'parts.replaced' && fact.value === true), false);
      assert.equal(mapped.facts.some((fact) => fact.field === 'work_performed'), false);
    }
  }
});
