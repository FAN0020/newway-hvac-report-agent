import assert from 'node:assert/strict';
import test from 'node:test';
import { applyConfirmedTranscriptCorrections, reviewV2Transcript } from '../../src/v2/transcript-review.js';

const realBaseline = "Today's aerial corrective maintenance on train set Z751A car 3 are the passenger door would not close.\nInspection from the door control model 40.\nI replaced the door control module after replacement, the door opening and closing test passed.";

test('Rail review proposes bounded domain corrections without silently changing the transcript', () => {
  const review = reviewV2Transcript({ scopeId: 'SBS_RAIL', rawText: realBaseline });
  assert.deepEqual(review.correction_suggestions.map((item) => item.correction_id), [
    'rail_asset_c751a_z751a_0',
    'rail_door_module_model_40_0',
  ]);
  assert.ok(review.correction_suggestions.every((item) => item.requires_confirmation));
  assert.equal(realBaseline.includes('Z751A'), true);
});

test('only explicitly accepted corrections are applied', () => {
  const review = reviewV2Transcript({ scopeId: 'SBS_RAIL', rawText: realBaseline });
  const assetOnly = applyConfirmedTranscriptCorrections(
    realBaseline,
    review.correction_suggestions,
    ['rail_asset_c751a_z751a_0'],
  );
  assert.match(assetOnly, /C751A/u);
  assert.match(assetOnly, /door control model 40/u);

  const all = applyConfirmedTranscriptCorrections(
    realBaseline,
    review.correction_suggestions,
    review.correction_suggestions.map((item) => item.correction_id),
  );
  assert.match(all, /C751A/u);
  assert.match(all, /door control module faulty/u);
});

test('future or planned work raises a critical clarification and is never auto-corrected', () => {
  const text = 'I will replace the door control module. After replacement, the test passed.';
  const review = reviewV2Transcript({ scopeId: 'SBS_RAIL', rawText: text });
  assert.equal(review.confirmation_questions.length, 1);
  assert.equal(review.confirmation_questions[0].field, 'work_performed');
  assert.equal(review.confirmation_questions[0].critical, true);
  assert.equal(applyConfirmedTranscriptCorrections(text, review.correction_suggestions, []), text);
});

test('round-one retest catches repeated terminology errors and ASR future-action variation', () => {
  const text = 'Today at around corrective maintenance on train set Z751A Car 3 the passenger door would not close.\ninspection from the door control model 40\nI will place the door control model after replacement, the door opening and closing test passed.';
  const review = reviewV2Transcript({ scopeId: 'SBS_RAIL', rawText: text });
  assert.equal(review.correction_suggestions.length, 3);
  assert.equal(review.correction_suggestions.filter((item) => item.category === 'DOMAIN_TERMINOLOGY').length, 2);
  assert.equal(review.confirmation_questions.length, 1);
  assert.match(review.confirmation_questions[0].source_text, /I will place/iu);
});

test('Bus scope does not apply Rail-only asset correction rules', () => {
  const review = reviewV2Transcript({ scopeId: 'SBS_BUS', rawText: realBaseline });
  assert.equal(review.correction_suggestions.some((item) => item.suggested_text === 'C751A'), false);
  assert.equal(review.correction_suggestions.some((item) => item.suggested_text === 'door control module'), true);
});

test('round-two Bus ASR variants are reviewable and registration requires identity confirmation', () => {
  const text = 'MAN 9-5 bus. Registration SBS6025J. Inspection found the door control model faulty.';
  const review = reviewV2Transcript({ scopeId: 'SBS_BUS', rawText: text });
  assert.deepEqual(review.correction_suggestions.map((item) => item.suggested_text), [
    'MAN A95',
    'door control module',
  ]);
  assert.equal(review.confirmation_questions.length, 1);
  assert.equal(review.confirmation_questions[0].field, 'asset.registration_no');
  assert.equal(review.confirmation_questions[0].source_text, 'SBS6025J');
  assert.equal(review.confirmation_questions[0].critical, true);
});

test('industrial spoken correction and return-to-service require confirmation', () => {
  const review = reviewV2Transcript({
    scopeId: 'OILFIELD',
    rawText: '依据GB50235，错了，改为GB50253-2014。管段恢复运行。',
  });
  assert.ok(review.confirmation_questions.some((item) => item.field === 'standard.reference'));
  assert.ok(review.confirmation_questions.some((item) => item.field === 'safety.assertion'));
});

test('industrial negated return-to-service does not request positive authorisation', () => {
  const review = reviewV2Transcript({
    scopeId: 'OILFIELD',
    rawText: '设备暂未恢复运行，已创建后续维修工单。',
  });
  assert.ok(!review.confirmation_questions.some((item) => item.question_id === 'industrial_return_to_service_confirmation'));
});

test('Rail module 40 ASR variant is reviewable as module faulty', () => {
  const review = reviewV2Transcript({
    scopeId: 'SBS_RAIL',
    rawText: 'Inspection found the door control module 40.',
  });
  assert.equal(review.correction_suggestions.length, 1);
  assert.equal(review.correction_suggestions[0].suggested_text, 'door control module faulty');
  assert.equal(review.correction_suggestions[0].requires_confirmation, true);
});
