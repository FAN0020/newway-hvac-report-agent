import assert from 'node:assert/strict';
import test from 'node:test';

test('report-impact comparison ignores punctuation, capitalization, and spacing only', async () => {
  const workflow = await import('../src/workflows/authoritative-capture.js');
  assert.equal(typeof workflow.compareReportClaimImpact, 'function');

  const result = workflow.compareReportClaimImpact({
    rawFacts: [{ field: 'work_performed', value: 'Cleaned the condenser coil.', support_status: 'DIRECT_TRANSCRIPT' }],
    proposedFacts: [{ field: 'work_performed', value: '  cleaned the condenser coil  ', support_status: 'DIRECT_TRANSCRIPT' }],
  });

  assert.deepEqual(result, {
    impact_class: 'NON_MATERIAL',
    material: false,
    affected_fields: [],
  });
});

test('report-impact comparison detects identity, measurement, negation, and field-assignment changes', async () => {
  const workflow = await import('../src/workflows/authoritative-capture.js');
  assert.equal(typeof workflow.compareReportClaimImpact, 'function');

  const cases = [
    {
      name: 'identity',
      rawFacts: [{ field: 'asset.bus_model', value: 'MAN A95' }],
      proposedFacts: [{ field: 'asset.bus_model', value: 'MAN A22' }],
      fields: ['asset.bus_model'],
    },
    {
      name: 'measurement',
      rawFacts: [{ field: 'measurement.pressure', value: 25, unit: 'psi' }],
      proposedFacts: [{ field: 'measurement.pressure', value: 125, unit: 'psi' }],
      fields: ['measurement.pressure'],
    },
    {
      name: 'negation',
      rawFacts: [{ field: 'completion.state', value: 'NOT_READY' }],
      proposedFacts: [{ field: 'completion.state', value: 'READY' }],
      fields: ['completion.state'],
    },
    {
      name: 'field assignment',
      rawFacts: [{ field: 'inspection_findings', value: 'Door module faulty' }],
      proposedFacts: [{ field: 'work_performed', value: 'Door module faulty' }],
      fields: ['inspection_findings', 'work_performed'],
    },
  ];

  for (const item of cases) {
    const result = workflow.compareReportClaimImpact(item);
    assert.equal(result.material, true, item.name);
    assert.equal(result.impact_class, 'MATERIAL', item.name);
    assert.deepEqual(result.affected_fields, item.fields, item.name);
  }
});
