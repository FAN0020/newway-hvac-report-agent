import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { extractCuedFieldAssignments } from '../src/semantic/structured-proposals.js';

const corpus = JSON.parse(await fs.readFile(new URL('../evaluation/schema-identifier-autofill.v1.json', import.meta.url), 'utf8'));
const template = { schema: { fields: [
  { id: 'asset.id', label: 'Asset ID', type: 'string', required: true },
  { id: 'inspection.result', label: 'Inspection result', type: 'text', required: true },
] } };

test('schema identifier autofill corpus is frozen and covers positive and abstention behavior', () => {
  assert.equal(corpus.schema_version, 'schema-identifier-autofill.v1');
  assert.ok(corpus.cases.some((entry) => entry.category === 'regression'));
  assert.ok(corpus.cases.some((entry) => entry.category === 'ambiguous'));
  assert.ok(corpus.cases.some((entry) => entry.category === 'negative'));
});

for (const entry of corpus.cases) {
  test(`schema identifier autofill: ${entry.id}`, () => {
    const result = extractCuedFieldAssignments({
      template,
      raw_text: entry.input,
      capture_context: entry.capture_context || null,
    });
    assert.deepEqual(
      result.assignments.map(({ field_id, value }) => ({ field_id, value })),
      entry.expected,
    );
    for (const forbidden of entry.forbidden) {
      assert.equal(result.assignments.some((assignment) => assignment.field_id === forbidden.field_id), false);
    }
  });
}
