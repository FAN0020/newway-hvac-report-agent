import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTechnicianFieldAnswer } from '../web/report-input.js';

test('numeric report answers accept a spoken-style value with its unit', () => {
  assert.deepEqual(parseTechnicianFieldAnswer({
    definition: { type: 'number' },
    fieldId: 'measurement.odometer_km',
    text: '51020 km',
  }), { value: 51020, unit: 'km' });
});

test('numeric report answers preserve thousands-grouped values', () => {
  assert.deepEqual(parseTechnicianFieldAnswer({
    definition: { type: 'number' },
    fieldId: 'measurement.odometer_km',
    text: '51,020 km',
  }), { value: 51020, unit: 'km' });
});

test('numeric report answers preserve invalid text for server validation instead of serializing NaN as null', () => {
  assert.deepEqual(parseTechnicianFieldAnswer({
    definition: { type: 'number' },
    fieldId: 'measurement.odometer_km',
    text: 'about fifty thousand',
  }), { value: 'about fifty thousand', unit: 'km' });
});

test('text report answers remain unchanged apart from surrounding whitespace', () => {
  assert.deepEqual(parseTechnicianFieldAnswer({
    definition: { type: 'text' },
    fieldId: 'inspection_findings',
    text: '  Connector was loose.  ',
  }), { value: 'Connector was loose.' });
});
