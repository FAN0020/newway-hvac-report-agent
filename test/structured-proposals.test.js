import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaProvider } from '../src/providers/ollama.js';

let verifyStructuredFactProposals;
let proposeStructuredAtomicFacts;
try {
  ({ verifyStructuredFactProposals, proposeStructuredAtomicFacts } = await import('../src/semantic/structured-proposals.js'));
} catch {
  // Keep the first test red as a behavioral assertion while the new boundary is absent.
}

test('an exact, extractive proposal becomes an evidence-backed atomic fact', () => {
  const result = verifyStructuredFactProposals?.({
    scope_id: 'HVAC',
    transcript_id: 'transcript-1',
    raw_text: 'Work order 1122344.',
    proposals: [{
      semantic_type: 'WORK_ORDER', value: '1122344', source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: 18, evidence_quote: 'Work order 1122344',
    }],
  });
  assert.equal(result?.facts.length, 1);
  assert.equal(result.facts[0].semantic_type, 'WORK_ORDER');
  assert.equal(result.facts[0].value, '1122344');
  assert.equal(result.facts[0].evidence_quote, 'Work order 1122344');
  assert.equal(result.facts[0].char_start, 0);
  assert.equal(result.facts[0].char_end, 18);
  assert.equal(result.facts[0].transcript_id, 'transcript-1');
  assert.equal(result.facts[0].support_status, 'CONFIRMED_BY_EVIDENCE');
  assert.match(result.facts[0].fact_id, /^fact_[a-f0-9]{24}$/u);
});

test('a unique exact quote is located deterministically when model character counting is wrong', () => {
  const text = 'I inspected the BFGH and I did HIJM.';
  const quote = 'I did HIJM';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-offset-repair', raw_text: text,
    proposals: [{ semantic_type: 'COMPLETED_ACTION', value: 'HIJM',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: 5, evidence_quote: quote }],
  });
  assert.equal(result.facts.length, 1);
  assert.equal(text.slice(result.facts[0].char_start, result.facts[0].char_end), quote);
  assert.equal(result.facts[0].char_start, text.indexOf(quote));
});

test('a compact model proposal needs only an exact quote and never controls evidence metadata', () => {
  const text = 'Customer said room warm. I sealed the flange.';
  const result = verifyStructuredFactProposals({
    transcript_id: 'compact-proposal', raw_text: text,
    proposals: [
      { semantic_type: 'CUSTOMER_OBSERVATION', value: 'room warm', evidence_quote: 'Customer said room warm' },
      { semantic_type: 'COMPLETED_ACTION', value: 'sealed the flange', evidence_quote: 'I sealed the flange' },
    ],
  });
  assert.deepEqual(result.facts.map((fact) => [fact.source_role, fact.temporality]), [
    ['CUSTOMER', 'CURRENT'], ['TECHNICIAN', 'CURRENT'],
  ]);
  assert.deepEqual(result.facts.map((fact) => text.slice(fact.char_start, fact.char_end)), [
    'Customer said room warm', 'I sealed the flange',
  ]);
});

test('a fragment with postposed customer attribution stays a customer observation', () => {
  const quote = 'Room felt warm, customer said';
  const result = verifyStructuredFactProposals({
    transcript_id: 'postposed-role', raw_text: `${quote}.`,
    proposals: [{ semantic_type: 'CUSTOMER_OBSERVATION', value: 'Room felt warm', evidence_quote: quote }],
  });
  assert.equal(result.facts[0]?.source_role, 'CUSTOMER');
});

test('an asset named before its label may fill equipment when the exact quote grounds it', () => {
  const quote = 'AC-104 is the unit';
  const result = verifyStructuredFactProposals({
    transcript_id: 'postposed-asset', raw_text: `${quote}.`,
    proposals: [{ semantic_type: 'EQUIPMENT_OR_ASSET', value: 'AC-104', evidence_quote: quote }],
  });
  assert.equal(result.facts[0]?.value, 'AC-104');
});

test('an ambiguous repeated quote cannot be offset-repaired into arbitrary evidence', () => {
  const quote = 'The test passed';
  const text = `${quote}. ${quote}.`;
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-ambiguous-offset', raw_text: text,
    proposals: [{ semantic_type: 'TEST_OUTCOME', value: 'passed',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 4, char_end: 9, evidence_quote: quote }],
  });
  assert.deepEqual(result.facts, []);
});

test('a correct quote cannot authorize an invented value', () => {
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-2', raw_text: 'I replaced the valve.',
    proposals: [{
      semantic_type: 'COMPLETED_ACTION', value: 'replaced compressor',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: 20, evidence_quote: 'I replaced the valve',
    }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'UNSUPPORTED_VALUE' }]);
});

test('a finding or customer complaint cannot be mislabeled as a work order', () => {
  for (const quote of [
    'The return-air flange had a hairline crack',
    'The customer reported that the front door would not close',
  ]) {
    const result = verifyStructuredFactProposals({
      transcript_id: 'identifier-guard', raw_text: `${quote}.`,
      proposals: [{ semantic_type: 'WORK_ORDER', value: quote,
        source_role: quote.startsWith('The customer') ? 'CUSTOMER' : 'TECHNICIAN',
        temporality: 'CURRENT', char_start: 0, char_end: quote.length, evidence_quote: quote }],
    });
    assert.deepEqual(result.facts, []);
    assert.deepEqual(result.rejections, [{ index: 0, reason: 'SEMANTIC_TYPE_MISMATCH' }]);
  }
});

test('uncertain identifiers cannot become authoritative even if a quote itself is exact', () => {
  const text = 'Work order maybe 9976? No, could be 9978.';
  const result = verifyStructuredFactProposals({
    transcript_id: 'uncertain-model-id', raw_text: text,
    proposals: [
      { semantic_type: 'WORK_ORDER', value: 'maybe', evidence_quote: 'Work order maybe' },
      { semantic_type: 'WORK_ORDER', value: '9976', evidence_quote: '9976' },
    ],
  });
  assert.deepEqual(result.facts, []);
});

test('a customer complaint cannot be mislabeled as equipment', () => {
  const quote = 'The customer reported that the front door would not close';
  const result = verifyStructuredFactProposals({
    transcript_id: 'asset-guard', raw_text: `${quote}.`,
    proposals: [{ semantic_type: 'EQUIPMENT_OR_ASSET', value: quote,
      source_role: 'CUSTOMER', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'SEMANTIC_TYPE_MISMATCH' }]);
});

test('a customer statement cannot be relabeled as a technician finding', () => {
  const quote = 'The customer reported a loose connector';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-3', raw_text: `${quote}.`,
    proposals: [{
      semantic_type: 'INSPECTION_FINDING', value: 'loose connector',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote,
    }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'SOURCE_ROLE_MISMATCH' }]);
});

test('future and negated replacement evidence cannot become completed work or a used part', () => {
  const future = 'Recommend replacing the compressor next visit';
  const negated = 'The compressor was not replaced today';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-4', raw_text: `${future}. ${negated}.`,
    proposals: [
      {
        semantic_type: 'COMPLETED_ACTION', value: 'replacing compressor',
        source_role: 'TECHNICIAN', temporality: 'CURRENT',
        char_start: 0, char_end: future.length, evidence_quote: future,
      },
      {
        semantic_type: 'PART_USED', value: 'compressor',
        source_role: 'TECHNICIAN', temporality: 'CURRENT',
        char_start: future.length + 2, char_end: future.length + 2 + negated.length,
        evidence_quote: negated,
      },
    ],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [
    { index: 0, reason: 'TEMPORALITY_MISMATCH' },
    { index: 1, reason: 'TEMPORALITY_MISMATCH' },
  ]);
});

test('testing without an outcome cannot be proposed as a test result', () => {
  const quote = 'I tested the door';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-5', raw_text: `${quote}.`,
    proposals: [{
      semantic_type: 'TEST_OUTCOME', value: 'tested',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote,
    }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'SEMANTIC_TYPE_MISMATCH' }]);
});

test('a result statement cannot be relabeled as a test action', () => {
  const quote = 'test result is passed';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-test-action-guard', raw_text: `${quote}.`,
    proposals: [{ semantic_type: 'TEST_ACTION', value: 'passed',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'SEMANTIC_TYPE_MISMATCH' }]);
});

test('a prior test does not make an unrelated leading verb a structured test outcome', () => {
  for (const sentence of ['Failed to replace the valve', 'Passed the depot inspection paperwork to manager']) {
    const raw_text = `I tested the unit. ${sentence}.`;
    const word = sentence.split(' ')[0];
    const start = raw_text.indexOf(sentence);
    const result = verifyStructuredFactProposals({
      transcript_id: 'structured-outcome-context', raw_text,
      proposals: [{ semantic_type: 'TEST_OUTCOME', value: word.toLowerCase(),
        source_role: 'TECHNICIAN', temporality: 'CURRENT',
        char_start: start, char_end: start + word.length, evidence_quote: word }],
    });
    assert.deepEqual(result.facts, [], sentence);
  }
  const raw_text = 'I tested the unit. It passed.';
  const start = raw_text.indexOf('passed');
  const supported = verifyStructuredFactProposals({
    transcript_id: 'structured-adjacent-outcome', raw_text,
    proposals: [{ semantic_type: 'TEST_OUTCOME', value: 'passed',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: start, char_end: start + 6, evidence_quote: 'passed' }],
  });
  assert.equal(supported.facts[0]?.value, 'passed');
});

test('a fragmentary passing retest after a repair retains the earlier test context', () => {
  const raw_text = 'Door test failed first... wait, after I reseated the connector it passed twice.';
  const evidence_quote = 'it passed twice';
  const supported = verifyStructuredFactProposals({
    transcript_id: 'fragmentary-retest', raw_text,
    proposals: [{ semantic_type: 'TEST_OUTCOME', value: 'passed', evidence_quote }],
  });
  assert.equal(supported.facts[0]?.value, 'passed');
  const unsupported = verifyStructuredFactProposals({
    transcript_id: 'no-test-context', raw_text: 'The compressor failed. After I reseated it, it passed twice.',
    proposals: [{ semantic_type: 'TEST_OUTCOME', value: 'passed', evidence_quote: 'it passed twice' }],
  });
  assert.deepEqual(unsupported.facts, []);
});

test('a measured post-test state can be an outcome only for the named test subject', () => {
  const supported = verifyStructuredFactProposals({
    transcript_id: 'cooling-outcome', raw_text: 'I ran a cooling test. Cooling was normal.',
    proposals: [{ semantic_type: 'TEST_OUTCOME', value: 'normal', evidence_quote: 'Cooling was normal' }],
  });
  assert.equal(supported.facts[0]?.value, 'normal');
  const unrelated = verifyStructuredFactProposals({
    transcript_id: 'unrelated-outcome', raw_text: 'I ran a cooling test. The room was normal.',
    proposals: [{ semantic_type: 'TEST_OUTCOME', value: 'normal', evidence_quote: 'The room was normal' }],
  });
  assert.deepEqual(unrelated.facts, []);
});

test('an outcome proposal cannot carry the whole multi-fact narration as its evidence', () => {
  const input = 'I inspected the valve. I replaced it. The test passed.';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-6', raw_text: input,
    proposals: [{
      semantic_type: 'TEST_OUTCOME', value: 'passed',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: input.length, evidence_quote: input,
    }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'NON_ATOMIC_EVIDENCE' }]);
});

test('explicitly using no parts is preserved as explicit none, not missing', () => {
  const quote = 'No parts were used';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-7', raw_text: `${quote}.`,
    proposals: [{
      semantic_type: 'PART_USED', value: null, claim_kind: 'EXPLICIT_NONE',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote,
    }],
  });
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].claim_kind, 'EXPLICIT_NONE');
  assert.equal(result.facts[0].value, null);
});

test('a failed component is not a failed post-work test', () => {
  const quote = 'The compressor failed';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-8', raw_text: `${quote}.`,
    proposals: [{
      semantic_type: 'TEST_OUTCOME', value: 'failed',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote,
    }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'SEMANTIC_TYPE_MISMATCH' }]);
});

test('a negated pass cannot be accepted as a positive outcome', () => {
  const quote = 'The test was not passed';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-9', raw_text: `${quote}.`,
    proposals: [{
      semantic_type: 'TEST_OUTCOME', value: 'passed',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote,
    }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'NEGATED_OUTCOME' }]);
});

test('a customer report cannot establish actual work or parts used', () => {
  const quote = 'Customer said the valve was installed';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-10', raw_text: `${quote}.`,
    proposals: [{
      semantic_type: 'PART_USED', value: 'valve',
      source_role: 'CUSTOMER', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote,
    }],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [{ index: 0, reason: 'SOURCE_ROLE_MISMATCH' }]);
});

test('provider proposals pass through verification before becoming atomic facts', async () => {
  const provider = {
    async generateJson() {
      return { provider: 'ollama', model: 'qwen-test', data: { facts: [
        {
          semantic_type: 'WORK_ORDER', value: '1122344', source_role: 'TECHNICIAN', temporality: 'CURRENT',
          char_start: 0, char_end: 18, evidence_quote: 'Work order 1122344',
        },
        {
          semantic_type: 'EQUIPMENT_OR_ASSET', value: 'invented asset', source_role: 'TECHNICIAN', temporality: 'CURRENT',
          char_start: 0, char_end: 18, evidence_quote: 'Work order 1122344',
        },
      ] } };
    },
  };
  const result = await proposeStructuredAtomicFacts?.({
    provider, model: 'qwen-test', transcript_id: 'transcript-11', raw_text: 'Work order 1122344.', scope_id: 'HVAC',
  });
  assert.deepEqual(result?.facts.map((fact) => fact.value), ['1122344']);
  assert.deepEqual(result.rejections, [{ index: 1, reason: 'UNSUPPORTED_VALUE' }]);
  assert.equal(result.provider, 'ollama');
});

test('semantic extraction sends a constrained facts-array schema to the local provider', async () => {
  let chatRequest;
  const provider = new OllamaProvider({ fetcher: async (_url, options) => {
    chatRequest = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: '{"facts":[]}' } }) };
  } });
  await proposeStructuredAtomicFacts({
    provider, model: 'local-test', transcript_id: 'schema-test', scope_id: 'HVAC', raw_text: 'I checked the unit.',
  });
  assert.equal(chatRequest.format.type, 'object');
  assert.equal(chatRequest.format.properties.facts.type, 'array');
  assert.equal(chatRequest.format.required.includes('facts'), true);
});

test('inspection alone cannot authorize completed work or parts used', () => {
  const quote = 'I inspected the valve';
  const result = verifyStructuredFactProposals({
    transcript_id: 'transcript-12', raw_text: `${quote}.`,
    proposals: [
      {
        semantic_type: 'COMPLETED_ACTION', value: 'inspected valve',
        source_role: 'TECHNICIAN', temporality: 'CURRENT',
        char_start: 0, char_end: quote.length, evidence_quote: quote,
      },
      {
        semantic_type: 'PART_USED', value: 'valve',
        source_role: 'TECHNICIAN', temporality: 'CURRENT',
        char_start: 0, char_end: quote.length, evidence_quote: quote,
      },
    ],
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.rejections, [
    { index: 0, reason: 'SEMANTIC_TYPE_MISMATCH' },
    { index: 1, reason: 'SEMANTIC_TYPE_MISMATCH' },
  ]);
});

test('a repair or inspection action cannot be mislabeled as an inspection finding', () => {
  for (const quote of ['I replaced the valve', 'I inspected the valve', 'I did HIJM']) {
    const result = verifyStructuredFactProposals({
      transcript_id: 'finding-predicate-guard', raw_text: `${quote}.`,
      proposals: [{ semantic_type: 'INSPECTION_FINDING', value: quote.slice(2),
        source_role: 'TECHNICIAN', temporality: 'CURRENT',
        char_start: 0, char_end: quote.length, evidence_quote: quote }],
    });
    assert.deepEqual(result.facts, [], quote);
    assert.deepEqual(result.rejections, [{ index: 0, reason: 'SEMANTIC_TYPE_MISMATCH' }], quote);
  }
});

test('an observed defect remains eligible as an inspection finding', () => {
  const quote = 'The return-air flange had a hairline crack';
  const result = verifyStructuredFactProposals({
    transcript_id: 'natural-finding', raw_text: `${quote}.`,
    proposals: [{ semantic_type: 'INSPECTION_FINDING', value: 'hairline crack',
      source_role: 'TECHNICIAN', temporality: 'CURRENT',
      char_start: 0, char_end: quote.length, evidence_quote: quote }],
  });
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].value, 'hairline crack');
});
