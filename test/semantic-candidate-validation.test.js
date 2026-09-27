import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateRuleViolations } from '../src/agent/validation-rules.js';
import { templateFor } from '../web/template-catalog.js';

const template = templateFor('bus-defect-rectification-corrective-maintenance');
const definition = (id) => template.schema.fields.find((field) => field.id === id);
const candidate = (fieldId, semanticType, overrides = {}) => ({
  field_id: fieldId,
  claim: { kind: 'VALUE', value: 'replaced valve' },
  evidence_refs: [{ evidence_id: 'transcript_test', span_id: 'span_test' }],
  support_type: 'TRANSCRIPT_EVIDENCE',
  semantic: { semantic_type: semanticType, source_role: 'TECHNICIAN', temporality: 'CURRENT' },
  ...overrides,
});

test('validation rejects future work even if an extractor labeled it completed', () => {
  const violations = candidateRuleViolations(candidate('work_performed', 'COMPLETED_ACTION', {
    semantic: { semantic_type: 'COMPLETED_ACTION', source_role: 'TECHNICIAN', temporality: 'FUTURE' },
  }), definition('work_performed'));
  assert.equal(violations.some((item) => item.code === 'SEMANTIC_TEMPORALITY_MISMATCH'), true);
});

test('validation rejects a customer claim mislabeled as a technician finding', () => {
  const violations = candidateRuleViolations(candidate('inspection_findings', 'INSPECTION_FINDING', {
    semantic: { semantic_type: 'INSPECTION_FINDING', source_role: 'CUSTOMER', temporality: 'CURRENT' },
  }), definition('inspection_findings'));
  assert.equal(violations.some((item) => item.code === 'SEMANTIC_SOURCE_MISMATCH'), true);
});

test('semantic compatibility is checked for explicit-none claims too', () => {
  const violations = candidateRuleViolations(candidate('test.result', 'TEST_ACTION', {
    claim: { kind: 'EXPLICIT_NONE' },
  }), definition('test.result'));
  assert.equal(violations.some((item) => item.code === 'EXPLICIT_NONE_SEMANTIC_MISMATCH'), true);
});

test('a current technician work claim passes semantic ownership checks', () => {
  const violations = candidateRuleViolations(candidate('work_performed', 'COMPLETED_ACTION'), definition('work_performed'));
  assert.equal(violations.some((item) => item.code.startsWith('SEMANTIC_')), false);
});
