import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAtomicFacts } from '../src/semantic/atomic-facts.js';

test('customer speech cannot establish technician-owned measurements, completion, parts, recommendation, or follow-up', async () => {
  const statements = [
    'The customer reported cooling pressure measured 120 psi.',
    'The customer said the bus is okay to return to service.',
    'The customer said no parts were used.',
    'The customer said recommend replacing the compressor next visit.',
    'The customer said no follow-up is required.',
  ];
  for (const raw_text of statements) {
    const facts = await extractAtomicFacts({ scope_id: 'HVAC', transcript_id: 'customer-source-test', raw_text });
    assert.deepEqual(
      facts.map((fact) => [fact.semantic_type, fact.source_role]),
      [['CUSTOMER_OBSERVATION', 'CUSTOMER']],
      raw_text,
    );
  }
});
