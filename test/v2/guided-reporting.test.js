import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowUpQuestions } from '../../src/v2/guided-reporting.js';

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
