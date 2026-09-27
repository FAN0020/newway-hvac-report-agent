import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAtomicFacts } from '../src/semantic/atomic-facts.js';

async function outcomeValues(raw_text) {
  const facts = await extractAtomicFacts({ scope_id: 'HVAC', transcript_id: 'test-outcome-context', raw_text });
  return facts.filter((fact) => fact.semantic_type === 'TEST_OUTCOME').map((fact) => fact.value);
}

test('a prior test does not turn unrelated action verbs into test outcomes', async () => {
  assert.deepEqual(await outcomeValues('I tested the unit. Failed to replace the valve.'), []);
  assert.deepEqual(await outcomeValues('I tested the unit. Passed the depot inspection paperwork to manager.'), []);
  assert.deepEqual(await outcomeValues('I tested the unit. I packed up the tools. Passed.'), []);
});

test('an immediately following standalone outcome remains supported by its test action', async () => {
  assert.deepEqual(await outcomeValues('I tested the unit. It passed.'), ['passed']);
  assert.deepEqual(await outcomeValues('I tested the unit, and both passed.'), ['passed']);
  assert.deepEqual(await outcomeValues('I tested the unit. Failed.'), ['failed']);
});
