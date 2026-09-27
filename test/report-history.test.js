import assert from 'node:assert/strict';
import test from 'node:test';
import { templateFor } from '../web/template-catalog.js';

const field = (fieldId, value) => ({
  field_id: fieldId,
  state: 'KNOWN_VALUE',
  value,
  unit: null,
});

function session(overrides = {}) {
  return {
    session_id: 'session_history_1',
    template_binding: {
      template_id: 'bus-defect-rectification-corrective-maintenance',
      template_version: '1.0.0',
    },
    phase: 'RESOLVE',
    status: 'ACTIVE',
    created_at: '2026-09-26T03:00:00.000Z',
    updated_at: '2026-09-27T04:30:00.000Z',
    job_context_ref: 'work-order:WO-10482',
    ...overrides,
  };
}

test('report history projection uses explicit template bindings and human-facing status', async () => {
  const agent = await import('../src/agent/index.js');
  assert.equal(typeof agent.buildReportHistorySummary, 'function');

  const summary = agent.buildReportHistorySummary({
    session: session(),
    template: templateFor('bus-defect-rectification-corrective-maintenance'),
    agentState: {
      report_fields: [
        field('work.work_order_id', 'WO-10482'),
        field('work.date_time', '2026-09-27 10:42'),
        field('asset.internal_fleet_no', '8300-354'),
        field('technician.name', 'Alex Tan'),
      ],
    },
    outputArtifacts: [],
  });

  assert.deepEqual(summary, {
    session_id: 'session_history_1',
    report_id: null,
    template: {
      template_id: 'bus-defect-rectification-corrective-maintenance',
      display_name: 'Bus Defect Rectification / Corrective Maintenance',
      version: '1.0.0',
    },
    created_at: '2026-09-26T03:00:00.000Z',
    updated_at: '2026-09-27T04:30:00.000Z',
    service_date: '2026-09-27 10:42',
    display_date: '2026-09-27 10:42',
    display_date_source: 'SERVICE_DATE',
    technician: 'Alex Tan',
    work_order: 'WO-10482',
    asset: '8300-354',
    status: { code: 'NEEDS_INPUT', label: 'Needs your input' },
    confirmed_at: null,
    report_version: null,
    snapshot_id: null,
    output_artifacts: [],
  });
});

test('confirmed history binds immutable report version and generated outputs', async () => {
  const agent = await import('../src/agent/index.js');
  assert.equal(typeof agent.buildReportHistorySummary, 'function');
  const reportSnapshot = {
    snapshot_id: 'snapshot_history_1',
    confirmed_at: '2026-09-27T05:00:00.000Z',
    report: { report_id: 'report_history_1', report_version: 1 },
  };
  const output = {
    output_id: 'output_history_1',
    snapshot_id: reportSnapshot.snapshot_id,
    format: 'text/plain',
    storage_ref: 'authority://official-exports/snapshot_history_1.txt',
    content_hash: `sha256:${'a'.repeat(64)}`,
    created_at: '2026-09-27T05:01:00.000Z',
  };

  const summary = agent.buildReportHistorySummary({
    session: session({ phase: 'CONFIRMED', status: 'CONFIRMED' }),
    template: templateFor('bus-defect-rectification-corrective-maintenance'),
    agentState: { report_fields: [] },
    confirmation: { confirmed_at: reportSnapshot.confirmed_at, technician_name: 'Alex Tan' },
    reportSnapshot,
    outputArtifacts: [output],
  });

  assert.equal(summary.status.label, 'Confirmed');
  assert.equal(summary.report_id, 'report_history_1');
  assert.equal(summary.report_version, 1);
  assert.equal(summary.snapshot_id, 'snapshot_history_1');
  assert.equal(summary.confirmed_at, '2026-09-27T05:00:00.000Z');
  assert.deepEqual(summary.output_artifacts, [output]);
  assert.equal(summary.display_date_source, 'CREATED_AT');
});
