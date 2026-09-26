import assert from 'node:assert/strict';
import test from 'node:test';

import { reportToText } from '../src/tools/report-integrity.js';

test('template report export uses its bound name and renderer field labels', () => {
  const text = reportToText({
    schema_id: 'bus-passenger-door-safety-equipment-inspection-schema',
    template_name: 'Bus Passenger Door / Safety Equipment Inspection',
    report_id: 'report_demo', report_version: 1,
    sections: [{ title: 'Inspection checklist', content: [{ field: 'check.front_door.status', label: 'Front passenger door', value: 'OK', status: 'SUPPORTED' }] }],
  }, { technician_name: 'Alex', technician_id: 'TECH-1', confirmed_at: '2026-09-26T00:00:00Z', validator_run_id: 'trace_demo', report_hash: 'sha256:demo' });
  assert.match(text, /^Bus Passenger Door \/ Safety Equipment Inspection/mu);
  assert.match(text, /Front passenger door: OK/u);
  assert.doesNotMatch(text, /空调现场服务报告/u);
});
