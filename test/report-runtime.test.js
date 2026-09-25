import assert from 'node:assert/strict';
import test from 'node:test';

let runtime = {};
try {
  runtime = await import('../web/report-runtime.js');
} catch {
  // The first RED run intentionally reaches these assertions before the runtime exists.
}

test('built-in report schemas expose stable P0 ids and versions', () => {
  assert.deepEqual(
    Object.values(runtime.REPORT_SCHEMAS || {}).map(({ scope, id, version }) => ({ scope, id, version })),
    [
      { scope: 'HVAC', id: 'hvac_service', version: '1' },
      { scope: 'SBS_BUS', id: 'sbs_bus_maintenance', version: '0' },
      { scope: 'SBS_RAIL', id: 'sbs_rail_maintenance', version: '0' },
    ],
  );
});

test('a ReportSession is schema-bound and contains the complete P0 state contract', () => {
  assert.equal(typeof runtime.createReportSession, 'function');
  const session = runtime.createReportSession({
    reportType: 'sbs_bus_maintenance',
    jobContext: { technicianId: 'TECH-1', technicianName: 'Alex' },
    id: 'session_bus',
  });
  assert.equal(session.id, 'session_bus');
  assert.equal(session.scope, 'SBS_BUS');
  assert.equal(session.schemaId, 'sbs_bus_maintenance');
  assert.equal(session.schemaVersion, '0');
  for (const key of [
    'jobContext', 'evidence', 'transcript', 'corrections', 'facts', 'structuredState',
    'fieldStates', 'unresolvedItems', 'reportDraft', 'validation', 'confirmation', 'exportState',
  ]) assert.ok(Object.hasOwn(session, key), `missing ReportSession.${key}`);
});

test('facts map to StructuredJobState with explicit field support and status', () => {
  assert.equal(typeof runtime.mapFactsToStructuredState, 'function');
  const session = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'session_bus' });
  const mapped = runtime.mapFactsToStructuredState(session, [
    { field: 'asset.bus_model', value: 'MAN A95', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript:1' },
  ]);
  assert.equal(mapped.structuredState['asset.bus_model'], 'MAN A95');
  assert.deepEqual(mapped.fieldStates['asset.bus_model'].support, ['transcript:1']);
  assert.equal(mapped.fieldStates['asset.bus_model'].status, 'SUPPORTED');
  assert.equal(mapped.fieldStates['work.type'].status, 'MISSING');
});

test('ResolveQueue normalizes terminology, critical, missing and conflict work', () => {
  assert.equal(typeof runtime.createResolveQueue, 'function');
  const queue = runtime.createResolveQueue({
    correctionCandidates: [{ candidate_id: 'c1', source_span: { text: 'A ninety five' }, candidate: 'A95', status: 'NEEDS_TECHNICIAN_CONFIRMATION' }],
    missingFields: ['work.type'],
    conflicts: [{ field: 'completion.state', values: ['completed', 'deferred'] }],
  });
  assert.deepEqual(new Set(queue.map((item) => item.type)), new Set(['TERMINOLOGY', 'CRITICAL_VALUE', 'MISSING_FIELD', 'CONFLICT']));
  assert.ok(queue.every((item) => item.id && item.question && item.severity && Object.hasOwn(item, 'answer')));
});

test('session runtime scopes transient input and rejects stale async completions', () => {
  assert.equal(typeof runtime.createSessionRuntime, 'function');
  const controller = runtime.createSessionRuntime();
  const bus = runtime.createReportSession({ reportType: 'sbs_bus_maintenance', id: 'bus' });
  const rail = runtime.createReportSession({ reportType: 'sbs_rail_maintenance', id: 'rail' });
  controller.activate(bus);
  controller.setTransient('query', 'A95 door query');
  controller.setTransient('statement', 'Bus statement');
  const busRequest = controller.beginRequest('retrieve');
  controller.activate(rail);
  assert.equal(controller.getTransient('query'), '');
  assert.equal(controller.getTransient('statement'), '');
  assert.equal(controller.accepts(busRequest), false);
  const railRequest = controller.beginRequest('retrieve');
  assert.equal(controller.accepts(railRequest), true);
  controller.activate(bus);
  assert.equal(controller.getTransient('query'), 'A95 door query');
  assert.equal(controller.getTransient('statement'), 'Bus statement');
});
