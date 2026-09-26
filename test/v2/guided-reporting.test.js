import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowUpQuestions, buildGateConfirmationQuestions } from '../../src/v2/guided-reporting.js';

test('Bus missing modules become scoped technician questions', () => {
  const questions = buildFollowUpQuestions({
    scopeId: 'SBS_BUS',
    missingSections: ['inspection_findings', 'tests_results', 'provenance'],
  });
  assert.deepEqual(questions.map((item) => item.field), ['inspection_findings', 'test.result']);
  assert.ok(questions.every((item) => item.answer_source === 'technician_confirmation'));
});

test('Rail questions include track access and return-to-service confirmation', () => {
  const questions = buildFollowUpQuestions({
    scopeId: 'SBS_RAIL',
    missingSections: ['track_access_record', 'completion_state_return_to_service'],
  });
  assert.deepEqual(questions.map((item) => item.field), ['access.approval', 'completion.state']);
});

test('Unknown scopes fail closed', () => {
  assert.throws(() => buildFollowUpQuestions({ scopeId: 'HVAC', missingSections: [] }), /Unknown V2 scope/);
});

test('return-to-service hard gate becomes an exact technician confirmation question', () => {
  const questions = buildGateConfirmationQuestions({
    violations: [{
      class: 'INCORRECT_SAFETY_RETURN_TO_SERVICE',
      field: 'safety.assertion',
      detail: 'Return-to-service/safety assertion "管段恢复运行" on safety.assertion lacks CONFIRMED_BY_TECHNICIAN support.',
    }],
  });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].field, 'safety.assertion');
  assert.equal(questions[0].target_value, '管段恢复运行');
  assert.equal(questions[0].confirmation_only, true);
});
