import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAtomicFacts } from '../src/semantic/atomic-facts.js';

test('uncertain and self-corrected identifiers abstain instead of becoming report IDs', async () => {
  const facts = await extractAtomicFacts({
    scope_id: 'HVAC', transcript_id: 'uncertain-ids',
    raw_text: 'Work order maybe 9976? No, could be 9978. I cannot confirm. Unit AHU... maybe AHU-3, not sure.',
  });
  assert.deepEqual(facts.filter((fact) => ['WORK_ORDER', 'EQUIPMENT_OR_ASSET'].includes(fact.semantic_type)), []);
});

test('a clear identifier after filler speech remains extractable', async () => {
  const facts = await extractAtomicFacts({
    scope_id: 'HVAC', transcript_id: 'clear-after-filler',
    raw_text: 'Uh, the work order is 5521. Unit AC-104.',
  });
  assert.equal(facts.find((fact) => fact.semantic_type === 'WORK_ORDER')?.value, '5521');
  assert.equal(facts.find((fact) => fact.semantic_type === 'EQUIPMENT_OR_ASSET')?.value, 'AC-104');
});
