import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { extractAtomicFacts } from '../src/semantic/atomic-facts.js';
import { routeAtomicFacts } from '../src/semantic/field-router.js';
import { templateFor } from '../web/template-catalog.js';

const corpus = JSON.parse(await fs.readFile(new URL('../evaluation/semantic-routing-frozen.v1.json', import.meta.url), 'utf8'));

function valueOf(entry) {
  const value = entry.value;
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? String(value.value) : String(value);
}

function routedClaim(entry) {
  return {
    semantic_type: entry.semantic_type,
    field_id: entry.field_id,
    value: valueOf(entry),
    ...(entry.unit === undefined ? {} : { unit: entry.unit }),
  };
}

function sharedSpanPairs(facts) {
  const pairs = [];
  for (let first = 0; first < facts.length; first += 1) {
    for (let second = first + 1; second < facts.length; second += 1) {
      const a = facts[first];
      const b = facts[second];
      if (a.transcript_id === b.transcript_id && a.char_start < b.char_end && b.char_start < a.char_end) {
        pairs.push([a.semantic_type, b.semantic_type].sort().join('+'));
      }
    }
  }
  return pairs.sort();
}

async function evaluate(entry) {
  const template = templateFor(entry.template_id);
  const captures = entry.captures || [entry.effective_input || entry.input];
  const atomicFacts = [];
  const assignments = [];
  const unassigned = [];
  for (let index = 0; index < captures.length; index += 1) {
    const rawText = captures[index];
    const facts = await extractAtomicFacts({
      scope_id: entry.scope_id,
      raw_text: rawText,
      transcript_id: `${entry.id}:transcript:${index}`,
      capture_context: entry.capture_context,
    });
    const routed = routeAtomicFacts({ facts, template, capture_context: entry.capture_context });
    atomicFacts.push(...facts);
    assignments.push(...routed.assignments);
    unassigned.push(...routed.unassigned);
  }
  return { atomicFacts, assignments, unassigned };
}

test('semantic routing corpus is frozen, complete, and contains A through Z', () => {
  assert.equal(corpus.schema_version, 'semantic-routing-evaluation.v1');
  assert.deepEqual(corpus.cases.map((entry) => entry.id[0]), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
});

for (const entry of corpus.cases) {
  test(`semantic routing: ${entry.id}`, async () => {
    const result = await evaluate(entry);
    for (const expected of entry.expected) {
      const facts = result.atomicFacts.filter((fact) => fact.semantic_type === expected.semantic_type
        && valueOf(fact) === String(expected.value)
        && (expected.unit === undefined || fact.unit === expected.unit));
      assert.ok(facts.length, `missing atomic fact ${expected.semantic_type}=${expected.value}`);
      if (expected.field_id === null) {
        assert.ok(result.unassigned.some((item) => facts.some((fact) => fact.fact_id === item.fact.fact_id)), `${expected.semantic_type} should abstain from routing`);
      } else {
        assert.ok(result.assignments.some((item) => item.field_id === expected.field_id
          && facts.some((fact) => fact.fact_id === item.fact.fact_id)), `${expected.semantic_type} should route to ${expected.field_id}`);
      }
    }
    assert.deepEqual(
      result.assignments.map(routedClaim).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      entry.expected.filter((item) => item.field_id !== null).map(routedClaim)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      `${entry.id} must not route extra or duplicate claims`,
    );
    assert.deepEqual(
      sharedSpanPairs(result.atomicFacts),
      (entry.allow_shared_span_for || []).map((pair) => [...pair].sort().join('+')).sort(),
      `${entry.id} must reuse or overlap evidence spans only for explicitly compatible fact pairs`,
    );
    for (const fieldId of entry.forbidden_fields || []) {
      assert.equal(result.assignments.some((item) => item.field_id === fieldId), false, `${fieldId} must remain unassigned`);
    }
    for (const semanticType of entry.forbidden_fact_types || []) {
      assert.equal(result.atomicFacts.some((fact) => fact.semantic_type === semanticType), false,
        `${entry.id} must not propose unsupported ${semanticType} facts`);
    }
    for (const value of entry.forbidden_values || []) {
      assert.equal(result.assignments.some((item) => valueOf(item) === value), false, `whole-clause value must not be routed: ${value}`);
    }
    for (const fact of result.atomicFacts) {
      assert.equal((entry.effective_input || entry.input || entry.captures?.find((capture) => capture.includes(fact.evidence_quote)) || '').slice(fact.char_start, fact.char_end), fact.evidence_quote);
    }
  });
}

test('one natural utterance yields several independently routed facts without value duplication', async () => {
  const input = 'The replacement valve was installed, cooling was tested and passed, the customer had no further complaints, and no follow-up is required.';
  const template = templateFor('bus-defect-rectification-corrective-maintenance');
  const facts = await extractAtomicFacts({ scope_id: 'SBS_BUS', raw_text: input, transcript_id: 'multi-fact' });
  const routed = routeAtomicFacts({ facts, template });
  const values = Object.fromEntries(routed.assignments.map((item) => [item.semantic_type, item.value]));

  assert.equal(values.COMPLETED_ACTION, 'installed replacement valve');
  assert.equal(values.PART_USED, 'replacement valve');
  assert.equal(facts.find((fact) => fact.semantic_type === 'TEST_ACTION').value, 'tested cooling');
  assert.equal(values.TEST_OUTCOME, 'passed');
  assert.equal(values.CUSTOMER_OBSERVATION, 'no further complaints');
  assert.equal(routed.assignments.some((item) => item.semantic_type === 'FOLLOW_UP'
    && item.field_id === 'completion.outstanding_issues' && item.claim_kind === 'EXPLICIT_NONE'), true);
  assert.equal(routed.assignments.some((item) => item.value === input), false);
});

test('imperfect compound speech retains asset, finding, work, explicit-none, test, and completion semantics', async () => {
  const input = "Okay, I'm done with bus 354. Customer said the front door was sticking earlier. I checked it and found the connector at the controller was loose, so I reseated that and secured it. Didn't change any parts. Ran the door open-close test twice afterward and both were normal. Bus is okay to return to service, nothing else needed.";
  const facts = await extractAtomicFacts({ scope_id: 'SBS_BUS', raw_text: input, transcript_id: 'compound-natural' });
  const types = new Set(facts.map((fact) => fact.semantic_type));

  for (const semanticType of ['EQUIPMENT_OR_ASSET', 'CUSTOMER_OBSERVATION', 'INSPECTION_FINDING', 'COMPLETED_ACTION', 'PART_USED', 'TEST_ACTION', 'TEST_OUTCOME', 'COMPLETION_STATE', 'FOLLOW_UP']) {
    assert.equal(types.has(semanticType), true, `missing ${semanticType}`);
  }
  assert.equal(facts.find((fact) => fact.semantic_type === 'PART_USED').claim_kind, 'EXPLICIT_NONE');
  assert.equal(facts.find((fact) => fact.semantic_type === 'TEST_OUTCOME').value, 'passed');
  assert.equal(facts.some((fact) => fact.value === input), false);
});

test('real local Whisper punctuation remains atomic across comma-separated predicates', async () => {
  const input = 'At fictional unit AC-104, I found the drain line blocked, I cleared the drain line and ran a cooling test, cooling was normal, the job is complete.';
  const facts = await extractAtomicFacts({ scope_id: 'HVAC', raw_text: input, transcript_id: 'real-whisper-audio' });
  const byType = new Map();
  for (const fact of facts) {
    if (!byType.has(fact.semantic_type)) byType.set(fact.semantic_type, []);
    byType.get(fact.semantic_type).push(fact);
  }

  assert.equal(byType.get('EQUIPMENT_OR_ASSET')[0].value, 'AC-104');
  assert.equal(byType.get('INSPECTION_FINDING')[0].value, 'the drain line blocked');
  assert.equal(byType.get('COMPLETED_ACTION')[0].value, 'cleared the drain line');
  assert.equal(byType.get('TEST_ACTION')[0].value, 'ran a cooling test');
  assert.equal(byType.get('TEST_OUTCOME')[0].value, 'passed');
  assert.equal(byType.get('COMPLETION_STATE')[0].value, 'complete');
});
