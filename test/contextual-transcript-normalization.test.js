import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContextualTranscript } from '../src/semantic/transcript-normalization.js';

const template = {
  templateId: 'qa-pump-checklist', name: 'QA Pump Checklist', domain: 'CUSTOM',
  schema: { fields: [
    { id: 'asset.id', label: 'Asset ID', type: 'string' },
    { id: 'inspection.result', label: 'Inspection result', type: 'text' },
  ] },
};

test('active schema corrects terminology with exact raw and normalized spans', () => {
  const rawText = 'The AZERT ID is ABCD1234.';
  const result = normalizeContextualTranscript({ rawText, template });
  assert.equal(result.normalizedText, 'The Asset ID is ABCD1234.');
  assert.equal(result.corrections.length, 1);
  const [correction] = result.corrections;
  assert.equal(correction.original, 'AZERT');
  assert.equal(correction.replacement, 'Asset');
  assert.equal(rawText.slice(correction.sourceSpan.start, correction.sourceSpan.end), 'AZERT');
  assert.equal(result.normalizedText.slice(correction.normalizedSpan.start, correction.normalizedSpan.end), 'Asset');
  assert.equal(correction.contextSource, 'schema-field-label');
  assert.equal(correction.fieldId, 'asset.id');
  assert.equal(correction.confidence, 'HIGH');
});

test('multiple and adjacent errors retain ordered spans and leave values untouched', () => {
  const rawText = 'The AZERT ID is ABCD1234. The inspextion reslt is 120 PSI.';
  const result = normalizeContextualTranscript({ rawText, template });
  assert.equal(result.normalizedText, 'The Asset ID is ABCD1234. The Inspection result is 120 PSI.');
  assert.deepEqual(result.corrections.map(({ original, replacement }) => [original, replacement]), [
    ['AZERT', 'Asset'], ['inspextion', 'Inspection'], ['reslt', 'result'],
  ]);
  for (const correction of result.corrections) {
    assert.equal(rawText.slice(correction.sourceSpan.start, correction.sourceSpan.end), correction.original);
    assert.equal(result.normalizedText.slice(correction.normalizedSpan.start, correction.normalizedSpan.end), correction.replacement);
  }
});

test('the mechanism also uses active field aliases for other maintenance terms', () => {
  const pressureTemplate = { ...template, schema: { fields: [
    { id: 'measurement.pressure', label: 'Outlet pressure', aliases: ['Compressor pressure'], type: 'number' },
  ] } };
  const result = normalizeContextualTranscript({ rawText: 'Compressor presure is 120 PSI.', template: pressureTemplate });
  assert.equal(result.normalizedText, 'Compressor pressure is 120 PSI.');
  assert.deepEqual(result.corrections.map(({ original, replacement, contextSource }) => [original, replacement, contextSource]), [
    ['presure', 'pressure', 'schema-field-alias'],
  ]);
});

test('facts, negation, future work, and unrelated template language are never rewritten', () => {
  for (const rawText of [
    'Pressure is 120 PSI.',
    'Compressor was not replaced.',
    'Replace compressor next visit.',
    'The Asset ID is ABCD1234.',
  ]) {
    assert.deepEqual(normalizeContextualTranscript({ rawText, template }), { normalizedText: rawText, corrections: [] });
  }
  const unrelated = { ...template, schema: { fields: [{ id: 'motor.id', label: 'Motor ID', type: 'string' }] } };
  assert.deepEqual(normalizeContextualTranscript({ rawText: 'The AZERT ID is ABCD1234.', template: unrelated }), {
    normalizedText: 'The AZERT ID is ABCD1234.', corrections: [],
  });
});

test('ambiguous active schema terms abstain without a correction decoration', () => {
  const ambiguous = { ...template, schema: { fields: [
    { id: 'asset.id', label: 'Asset ID', type: 'string' },
    { id: 'alert.id', label: 'Alert ID', type: 'string' },
  ] } };
  assert.deepEqual(normalizeContextualTranscript({ rawText: 'The AZERT ID is ABCD1234.', template: ambiguous }), {
    normalizedText: 'The AZERT ID is ABCD1234.', corrections: [],
  });
});

test('meaningful nearby words do not become active field terminology', () => {
  for (const term of ['Agent', 'Alert', 'Assert', 'AGENT', 'ALERT', 'ASSERT']) {
    const rawText = `The ${term} ID is ABCD1234.`;
    assert.deepEqual(normalizeContextualTranscript({ rawText, template }), {
      normalizedText: rawText, corrections: [],
    }, term);
  }
});
