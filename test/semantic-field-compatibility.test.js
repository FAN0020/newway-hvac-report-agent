import assert from 'node:assert/strict';
import test from 'node:test';
import { routeAtomicFacts } from '../src/semantic/field-router.js';
import { templateFor } from '../web/template-catalog.js';

function fact(semanticType, value, overrides = {}) {
  return {
    fact_id: `fact:${semanticType}:${value}`,
    semantic_type: semanticType,
    value,
    source_role: 'TECHNICIAN',
    temporality: 'CURRENT',
    claim_kind: 'VALUE',
    support_status: 'CONFIRMED_BY_EVIDENCE',
    char_start: 0,
    char_end: String(value).length,
    evidence_quote: String(value),
    attributes: {},
    ...overrides,
  };
}

test('declared semantic roles exclude incompatible fallback assignments', () => {
  const template = {
    schema: {
      fields: [
        { id: 'test.result', semanticRoles: ['TEST_OUTCOME'] },
        { id: 'inspection_findings', semanticRoles: [] },
      ],
    },
  };
  const routed = routeAtomicFacts({
    facts: [fact('TEST_OUTCOME', 'passed'), fact('INSPECTION_FINDING', 'loose connector')],
    template,
  });
  assert.deepEqual(routed.assignments.map((item) => item.field_id), ['test.result']);
  assert.deepEqual(routed.unassigned.map((item) => item.fact.semantic_type), ['INSPECTION_FINDING']);
});

test('customer-origin finding cannot become a technician finding, even with a focused field', () => {
  const routed = routeAtomicFacts({
    facts: [fact('INSPECTION_FINDING', 'door would not close', { source_role: 'CUSTOMER' })],
    template: templateFor('hvac-service-report'),
    capture_context: { capture_mode: 'FIELD_DICTATION', target_field_id: 'inspection_findings' },
  });
  assert.equal(routed.assignments.length, 0);
  assert.equal(routed.unassigned[0].reason, 'INCOMPATIBLE_SEMANTIC_CONTEXT');
});

test('an unattributed finding does not become a technician finding', () => {
  const routed = routeAtomicFacts({
    facts: [fact('INSPECTION_FINDING', 'door was sticking', { source_role: 'UNATTRIBUTED' })],
    template: templateFor('hvac-service-report'),
  });
  assert.equal(routed.assignments.length, 0);
  assert.equal(routed.unassigned[0].reason, 'INCOMPATIBLE_SEMANTIC_CONTEXT');
});

test('a completed-action proposal missing temporality cannot claim completed work', () => {
  const routed = routeAtomicFacts({
    facts: [fact('COMPLETED_ACTION', 'replaced compressor', { temporality: undefined })],
    template: templateFor('hvac-service-report'),
  });
  assert.equal(routed.assignments.length, 0);
  assert.equal(routed.unassigned[0].reason, 'INCOMPATIBLE_SEMANTIC_CONTEXT');
});

test('future actions and future part claims cannot become completed work or parts used', () => {
  const routed = routeAtomicFacts({
    facts: [
      fact('COMPLETED_ACTION', 'replace compressor', { temporality: 'FUTURE' }),
      fact('PART_USED', 'compressor', { temporality: 'FUTURE' }),
    ],
    template: templateFor('bus-defect-rectification-corrective-maintenance'),
  });
  assert.equal(routed.assignments.length, 0);
  assert.deepEqual(routed.unassigned.map((item) => item.reason), [
    'INCOMPATIBLE_SEMANTIC_CONTEXT',
    'INCOMPATIBLE_SEMANTIC_CONTEXT',
  ]);
});

test('future explicit-none wording cannot claim that no parts were used today', () => {
  const routed = routeAtomicFacts({
    facts: [fact('PART_USED', null, { claim_kind: 'EXPLICIT_NONE', temporality: 'FUTURE' })],
    template: templateFor('bus-defect-rectification-corrective-maintenance'),
  });
  assert.equal(routed.assignments.length, 0);
  assert.equal(routed.unassigned[0].reason, 'INCOMPATIBLE_SEMANTIC_CONTEXT');
});

test('a part reference alone does not populate parts or materials used', () => {
  const routed = routeAtomicFacts({
    facts: [fact('PART_REFERENCE', 'door control module')],
    template: templateFor('rail-maintenance-completion-handover'),
    capture_context: { capture_mode: 'FIELD_DICTATION', target_field_id: 'parts.part_number' },
  });
  assert.equal(routed.assignments.length, 0);
  assert.equal(routed.unassigned[0].reason, 'NO_COMPATIBLE_FIELD');
});

test('rear door findings route to the rear checklist row, not the first row', () => {
  const routed = routeAtomicFacts({
    facts: [fact('INSPECTION_FINDING', 'rear door connector loose')],
    template: templateFor('bus-passenger-door-safety-equipment-inspection'),
  });
  assert.deepEqual(routed.assignments.map((item) => item.field_id), ['check.rear_door.observation']);
});

test('ambiguous door finding uses generic findings instead of guessing a checklist row', () => {
  const routed = routeAtomicFacts({
    facts: [fact('INSPECTION_FINDING', 'door controller loose')],
    template: templateFor('bus-passenger-door-safety-equipment-inspection'),
  });
  assert.deepEqual(routed.assignments.map((item) => item.field_id), ['inspection_findings']);
});

test('ambiguous checklist finding abstains when no generic finding exists', () => {
  const template = {
    schema: {
      fields: [
        { id: 'check.front_door.observation', semanticRoles: ['INSPECTION_FINDING'] },
        { id: 'check.rear_door.observation', semanticRoles: ['INSPECTION_FINDING'] },
      ],
    },
  };
  const routed = routeAtomicFacts({ facts: [fact('INSPECTION_FINDING', 'door controller loose')], template });
  assert.equal(routed.assignments.length, 0);
  assert.equal(routed.unassigned[0].reason, 'AMBIGUOUS_CHECKLIST_SUBJECT');
});

test('a focused test-result field cannot absorb a completed-action fact', () => {
  const routed = routeAtomicFacts({
    facts: [fact('COMPLETED_ACTION', 'replaced compressor')],
    template: templateFor('hvac-service-report'),
    capture_context: { capture_mode: 'FIELD_DICTATION', target_field_id: 'test_results' },
  });
  assert.deepEqual(routed.assignments.map((item) => item.field_id), ['work_performed']);
});
