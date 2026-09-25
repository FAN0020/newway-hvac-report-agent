/**
 * Unit tests for the V2 SBS report builder (src/v2/report-builder.js).
 *
 * Design basis: 06_V2_REPORT_SCHEMA_DRAFT.md §2.2/§2.3/§3,
 * 08_V2_CRITICAL_ERROR_TAXONOMY.md, contract §3/§12/§13 (ZX-47), and the V1
 * "generate from facts, never invent" discipline.
 *
 * Imports the real modules: src/v2/report-builder.js and
 * src/v2/fact-schemas.js (no fixtures, no mocks).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUS_REPORT_SECTIONS,
  RAIL_REPORT_SECTIONS,
  assertNoServiceFactInvention,
  buildBusReportSections,
  buildRailReportSections,
  checkHardGates,
  planV2Report,
} from '../../src/v2/report-builder.js';
import {
  SUPPORTED_V2_SCOPES,
  SUPPORT_STATUSES,
  isCriticalField,
} from '../../src/v2/fact-schemas.js';

const PLACEHOLDER = 'Not provided / pending confirmation';

test('module imports resolve real fact-schemas.js exports (contract surface)', () => {
  assert.deepEqual(SUPPORTED_V2_SCOPES, ['SBS_BUS', 'SBS_RAIL']);
  assert.equal(SUPPORT_STATUSES.DIRECT_TRANSCRIPT, 'DIRECT_TRANSCRIPT');
  assert.equal(SUPPORT_STATUSES.UNCERTAIN, 'UNCERTAIN');
  assert.equal(isCriticalField({ scopeId: 'SBS_BUS', field: 'completion.state' }), true);
  assert.equal(isCriticalField({ scopeId: 'SBS_RAIL', field: 'test.result' }), true);
});

test('BUS_REPORT_SECTIONS defines exactly the 11 sections of 06 §2.2, in order, frozen', () => {
  assert.deepEqual(BUS_REPORT_SECTIONS.map((s) => s.id), [
    'vehicle_identification',
    'works_summary',
    'inspection_findings',
    'diagnosis',
    'work_performed',
    'parts_materials',
    'tests_results',
    'completion_state',
    'safety_hv_notes',
    'compliance_audit',
    'provenance',
  ]);
  assert.ok(Object.isFrozen(BUS_REPORT_SECTIONS));
  assert.ok(BUS_REPORT_SECTIONS.every((s) => Object.isFrozen(s) && typeof s.title === 'string' && typeof s.required === 'boolean'));
  // required per 06 §2.2 core + V1 provenance baseline
  for (const id of ['vehicle_identification', 'works_summary', 'inspection_findings', 'work_performed', 'tests_results', 'completion_state', 'safety_hv_notes', 'compliance_audit', 'provenance']) {
    assert.equal(BUS_REPORT_SECTIONS.find((s) => s.id === id).required, true, `expected ${id} required`);
  }
  for (const id of ['diagnosis', 'parts_materials']) {
    assert.equal(BUS_REPORT_SECTIONS.find((s) => s.id === id).required, false, `expected ${id} conditional`);
  }
});

test('RAIL_REPORT_SECTIONS defines exactly the 12 sections of 06 §2.3, in order, frozen', () => {
  assert.deepEqual(RAIL_REPORT_SECTIONS.map((s) => s.id), [
    'asset_identification',
    'works_summary',
    'trigger_findings',
    'diagnosis',
    'work_performed',
    'parts_materials',
    'tests_results',
    'track_access_record',
    'completion_state_return_to_service',
    'safety_ops_notes',
    'reliability_compliance',
    'provenance',
  ]);
  assert.ok(Object.isFrozen(RAIL_REPORT_SECTIONS));
});

test('Rail is NOT a clone of Bus: scope-specific section sets are disjoint', () => {
  assert.notEqual(BUS_REPORT_SECTIONS, RAIL_REPORT_SECTIONS);
  const busIds = new Set(BUS_REPORT_SECTIONS.map((s) => s.id));
  const railIds = new Set(RAIL_REPORT_SECTIONS.map((s) => s.id));
  // Rail-only sections (06 §2.3): TAMS track access and reliability/compliance.
  for (const railOnly of ['track_access_record', 'reliability_compliance', 'trigger_findings', 'completion_state_return_to_service', 'safety_ops_notes']) {
    assert.ok(railIds.has(railOnly), `rail must contain ${railOnly}`);
    assert.ok(!busIds.has(railOnly), `bus must NOT contain ${railOnly}`);
  }
  // Bus-only sections (06 §2.2).
  for (const busOnly of ['safety_hv_notes', 'compliance_audit', 'inspection_findings']) {
    assert.ok(busIds.has(busOnly), `bus must contain ${busOnly}`);
    assert.ok(!railIds.has(busOnly), `rail must NOT contain ${busOnly}`);
  }
});

test('Bus report: section ids/order/required match BUS_REPORT_SECTIONS; content comes from facts', () => {
  const facts = [
    { field: 'asset.registration_no', value: 'SG3050Z', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript:1' },
    { field: 'asset.bus_model', value: 'MAN A95', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript:2' },
    { field: 'work.type', value: 'corrective', support_status: 'MANUAL_ENTRY', source: 'technician' },
    { field: 'work.fault_code', value: 'P0216', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript:3' },
    { field: 'diagnosis.root_cause', value: 'brake pad wear', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'technician' },
    { field: 'parts.replaced', value: true, support_status: 'DIRECT_TRANSCRIPT', source: 'transcript:4' },
    { field: 'test.result', value: 'brake efficiency pass', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'technician' },
    { field: 'completion.state', value: 'completed', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'technician' },
    { field: 'safety.hv_isolation', value: { status: 'isolated', cert: 'NESS-2026-014' }, support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'technician' },
    { field: 'work_performed', value: 'replaced brake pads', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript:5' },
    { field: 'provenance.upload', value: 'upload:u1', support_status: 'MANUAL_ENTRY', source: 'system' },
  ];
  const report = buildBusReportSections({ facts, factsReceiptId: 'receipt-bus-1' });

  assert.equal(report.reportVersion, 'v2-bus-1');
  assert.ok(Object.isFrozen(report.sections));
  assert.ok(Object.isFrozen(report.sections[0]));
  assert.ok(Object.isFrozen(report.sections[0].content));
  assert.deepEqual(report.sections.map((s) => s.id), BUS_REPORT_SECTIONS.map((s) => s.id));
  assert.deepEqual(report.sections.map((s) => s.required), BUS_REPORT_SECTIONS.map((s) => s.required));
  assert.deepEqual(report.sections.map((s) => s.title), BUS_REPORT_SECTIONS.map((s) => s.title));

  const byId = new Map(report.sections.map((s) => [s.id, s]));
  // Content is grounded in the passed facts (labels + values + optional units).
  assert.deepEqual(byId.get('vehicle_identification').content, ['Registration No. (VRN): SG3050Z.', 'Bus model: MAN A95.']);
  assert.deepEqual(byId.get('works_summary').content, ['Work type: corrective.']);
  assert.deepEqual(byId.get('inspection_findings').content, ['Fault code: P0216.']);
  assert.deepEqual(byId.get('diagnosis').content, ['Root cause: brake pad wear.']);
  assert.deepEqual(byId.get('work_performed').content, ['Work performed: replaced brake pads.']);
  assert.deepEqual(byId.get('parts_materials').content, ['Part replaced: Yes.']);
  assert.deepEqual(byId.get('tests_results').content, ['Test result: brake efficiency pass.']);
  assert.deepEqual(byId.get('completion_state').content, ['Completion state: completed.']);
  assert.deepEqual(byId.get('safety_hv_notes').content, ['Safety · hv_isolation: status: isolated, cert: NESS-2026-014.']);
  // Provenance gets the receipt id plus provenance.* facts.
  assert.deepEqual(byId.get('provenance').content, ['Facts receipt: receipt-bus-1', 'Provenance · upload: upload:u1.']);
});

test('Bus report: missing required section renders the V1 placeholder', () => {
  const facts = [
    { field: 'asset.registration_no', value: 'SG3050Z', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'work_performed', value: 'replaced brake pads', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
  ];
  const report = buildBusReportSections({ facts, factsReceiptId: 'rc' });
  const byId = new Map(report.sections.map((s) => [s.id, s]));
  // compliance_audit has no facts and no receipt → placeholder (same as V1).
  assert.deepEqual(byId.get('compliance_audit').content, [PLACEHOLDER]);
  // sections that DO have content are not placeholder
  assert.notDeepEqual(byId.get('vehicle_identification').content, [PLACEHOLDER]);
  assert.notDeepEqual(byId.get('work_performed').content, [PLACEHOLDER]);
});

test('Bus report: UNCERTAIN facts are not rendered into content (V1 discipline), but stay visible to gates', () => {
  const report = buildBusReportSections({ facts: [
    { field: 'asset.registration_no', value: 'SG1111Z', support_status: 'UNCERTAIN', source: 'knowledge' },
    { field: 'test.result', value: 'passed', support_status: 'UNCERTAIN', source: 'knowledge' },
  ] });
  const byId = new Map(report.sections.map((s) => [s.id, s]));
  assert.deepEqual(byId.get('vehicle_identification').content, [PLACEHOLDER]);
  assert.deepEqual(byId.get('tests_results').content, [PLACEHOLDER]);
  // The same facts DO trip the invented-test hard gate.
  const gates = checkHardGates({ scopeId: 'SBS_BUS', facts: [
    { field: 'asset.registration_no', value: 'SG1111Z', support_status: 'UNCERTAIN', source: 'knowledge' },
    { field: 'test.result', value: 'passed', support_status: 'UNCERTAIN', source: 'knowledge' },
  ] });
  assert.ok(gates.violations.some((v) => v.class === 'INVENTED_TEST_RESULT'));
});

test('Rail report: Rail-unique sections exist and Bus report does not contain them', () => {
  const facts = [
    { field: 'asset.line', value: 'NEL', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'asset.train_set', value: 'C751A 7001/7002', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'work.fault_code', value: 'faulty lighting', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'access.approval', value: 'approved', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'tams' },
    { field: 'reliability.mkbf', value: '1,234,567 train-km', support_status: 'MANUAL_ENTRY', source: 'technician' },
    { field: 'completion.state', value: 'completed', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'technician' },
  ];
  const rail = buildRailReportSections({ facts, factsReceiptId: 'rail-rc' });
  assert.equal(rail.reportVersion, 'v2-rail-1');
  assert.deepEqual(rail.sections.map((s) => s.id), RAIL_REPORT_SECTIONS.map((s) => s.id));
  const railById = new Map(rail.sections.map((s) => [s.id, s]));

  // Rail-unique sections present with their own content.
  assert.deepEqual(railById.get('track_access_record').content, ['Track access approval: approved.']);
  assert.deepEqual(railById.get('reliability_compliance').content, ['Reliability · mkbf: 1,234,567 train-km.']);
  assert.deepEqual(railById.get('asset_identification').content, ['Line: NEL.', 'Train set: C751A 7001/7002.']);

  // The same-scope Bus report must NOT contain the Rail-unique sections.
  const bus = buildBusReportSections({ facts, factsReceiptId: 'bus-rc' });
  const busById = new Map(bus.sections.map((s) => [s.id, s]));
  for (const railOnly of ['track_access_record', 'reliability_compliance', 'trigger_findings', 'completion_state_return_to_service', 'safety_ops_notes']) {
    assert.ok(!busById.has(railOnly), `Bus report must not contain ${railOnly}`);
  }
  // And Rail must not contain Bus-unique sections.
  for (const busOnly of ['safety_hv_notes', 'compliance_audit', 'inspection_findings']) {
    assert.ok(!railById.has(busOnly), `Rail report must not contain ${busOnly}`);
  }
});

test('assertNoServiceFactInvention: unsupported replacement suggestion yields INVENTED_ACTION_REPLACEMENT', () => {
  const violations = assertNoServiceFactInvention({ facts: [], knowledgeHits: ['replace unit'] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].class, 'INVENTED_ACTION_REPLACEMENT');
  assert.ok(violations[0].detail.includes('replace unit'));
  assert.ok(violations[0].detail.includes('parts.replaced'));
});

test('assertNoServiceFactInvention: grounded work_performed (DIRECT_TRANSCRIPT) → no violation', () => {
  const violations = assertNoServiceFactInvention({
    facts: [{ field: 'work_performed', value: 'replaced capacitor', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' }],
    knowledgeHits: ['replace unit'],
  });
  assert.deepEqual(violations, []);
});

test('assertNoServiceFactInvention: parts.replaced=true also grounds the action', () => {
  const violations = assertNoServiceFactInvention({
    facts: [{ field: 'parts.replaced', value: true, support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' }],
    knowledgeHits: ['replacement recommended'],
  });
  assert.deepEqual(violations, []);
});

test('assertNoServiceFactInvention: MANUAL_ENTRY grounds; UNCERTAIN does not', () => {
  const manual = assertNoServiceFactInvention({
    facts: [{ field: 'work_performed', value: 'replaced pump', support_status: 'MANUAL_ENTRY', source: 'technician' }],
    knowledgeHits: ['replace pump'],
  });
  assert.deepEqual(manual, []);
  const uncertain = assertNoServiceFactInvention({
    facts: [{ field: 'work_performed', value: 'replaced pump', support_status: 'UNCERTAIN', source: 'knowledge' }],
    knowledgeHits: ['replacement recommended'],
  });
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0].class, 'INVENTED_ACTION_REPLACEMENT');
});

test('checkHardGates: INCORRECT_SAFETY_RETURN_TO_SERVICE fires only without technician confirmation', () => {
  const bad = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'safety.return_to_service', value: '已回役', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(bad.violations.some((v) => v.class === 'INCORRECT_SAFETY_RETURN_TO_SERVICE' && v.field === 'safety.return_to_service'));
  const badEn = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'completion.state', value: 'back in service', support_status: 'MANUAL_ENTRY' }] });
  assert.ok(badEn.violations.some((v) => v.class === 'INCORRECT_SAFETY_RETURN_TO_SERVICE'));
  const ok = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'safety.return_to_service', value: '已回役', support_status: 'CONFIRMED_BY_TECHNICIAN' }] });
  assert.ok(!ok.violations.some((v) => v.class === 'INCORRECT_SAFETY_RETURN_TO_SERVICE'));
});

test('checkHardGates: INCORRECT_COMPLETION_STATE outside the shared enum', () => {
  const bad = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'completion.state', value: 'scrapped', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(bad.violations.some((v) => v.class === 'INCORRECT_COMPLETION_STATE' && v.field === 'completion.state'));
  // allowed enum values pass (shared across BUS/RAIL)
  for (const state of ['completed', 'deferred', 'off-road', 'out_of_service', 'restricted_speed']) {
    const r = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'completion.state', value: state, support_status: 'DIRECT_TRANSCRIPT' }] });
    assert.ok(!r.violations.some((v) => v.class === 'INCORRECT_COMPLETION_STATE'), `"${state}" must be allowed`);
  }
  // technician confirmation resolves a non-standard state (quarantine model)
  const confirmed = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'completion.state', value: 'awaiting_spares', support_status: 'CONFIRMED_BY_TECHNICIAN' }] });
  assert.ok(!confirmed.violations.some((v) => v.class === 'INCORRECT_COMPLETION_STATE'));
});

test('checkHardGates: INVENTED_TEST_RESULT for UNCERTAIN or knowledge-sourced test.result', () => {
  const uncertain = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'test.result', value: 'brake test passed', support_status: 'UNCERTAIN' }] });
  assert.ok(uncertain.violations.some((v) => v.class === 'INVENTED_TEST_RESULT'));
  const knowledge = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'test.result', value: 'ultrasonic ok', support_status: 'DIRECT_TRANSCRIPT', source: 'knowledge:SBS_RAIL:manual' }] });
  assert.ok(knowledge.violations.some((v) => v.class === 'INVENTED_TEST_RESULT'));
  const ok = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'test.result', value: 'brake test passed', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'transcript' }] });
  assert.ok(!ok.violations.some((v) => v.class === 'INVENTED_TEST_RESULT'));
});

test('checkHardGates: CHANGED_NUMBER_UNIT for unknown inline or explicit units', () => {
  const psi = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'measurement.pressure', value: '30 psi', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(psi.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'));
  const kw = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'measurement.power', value: '1500 kW', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(kw.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'));
  const explicit = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'measurement.depth', value: 12, unit: 'cm', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(explicit.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'));
  // valid dictionary units pass (BUS and RAIL)
  const okBus = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'measurement.temp', value: '45 °C', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!okBus.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'));
  const okRailKm = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'measurement.distance', value: '120 train-km', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!okRailKm.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'));
  const okRailV = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'measurement.voltage', value: '1500 V DC', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!okRailV.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'));
});

test('checkHardGates: identity fields never raise CHANGED_NUMBER_UNIT (identifiers are not measurements)', () => {
  // Regression: "SBS6025Z" was mis-read as "6025 + inline unit Z" by
  // INLINE_UNIT_RE and falsely flagged CHANGED_NUMBER_UNIT. 08 class 2 unit
  // checks target measured values; identity fields are identifiers, not
  // measurements, so the unit check is skipped for them.
  const plate = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'asset.registration_no', value: 'SBS6025Z', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!plate.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'),
    `plate SBS6025Z must not raise CHANGED_NUMBER_UNIT: ${JSON.stringify(plate.violations)}`);
  assert.equal(plate.violations.length, 0, 'a clean identity fact must yield no violations at all');

  // Train set and part number identifiers must be exempt too.
  const train = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'asset.train_set', value: 'C751A', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!train.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'),
    `train set C751A must not raise CHANGED_NUMBER_UNIT: ${JSON.stringify(train.violations)}`);
  const part = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'parts.part_number', value: 'MCEM91', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!part.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'),
    `part number MCEM91 must not raise CHANGED_NUMBER_UNIT: ${JSON.stringify(part.violations)}`);
  const fault = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'work.fault_code', value: 'F3Z', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!fault.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'),
    `fault code F3Z must not raise CHANGED_NUMBER_UNIT: ${JSON.stringify(fault.violations)}`);
});

test('checkHardGates: non-identity measurement values still undergo the strict unit check', () => {
  // Unknown unit on a measurement value keeps raising CHANGED_NUMBER_UNIT
  // (the non-identity path must not have been relaxed).
  const kw = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'measurement.power', value: '12 kW', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(kw.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT' && v.field === 'measurement.power'),
    `measurement "12 kW" must still raise CHANGED_NUMBER_UNIT: ${JSON.stringify(kw.violations)}`);
  // A unit present in the BUS dictionary passes cleanly.
  const mm = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'measurement.clearance', value: '12 mm', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!mm.violations.some((v) => v.class === 'CHANGED_NUMBER_UNIT'),
    `measurement "12 mm" must pass: ${JSON.stringify(mm.violations)}`);
});

test('checkHardGates: WRONG_IDENTITY for empty or garbled identity fields', () => {
  const empty = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'asset.registration_no', value: '', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(empty.violations.some((v) => v.class === 'WRONG_IDENTITY' && v.field === 'asset.registration_no'));
  const garbled = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'asset.train_set', value: 'C751\uFFFDA', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(garbled.violations.some((v) => v.class === 'WRONG_IDENTITY'));
  const qmarks = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'parts.part_number', value: '???', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(qmarks.violations.some((v) => v.class === 'WRONG_IDENTITY'));
  const ok = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'asset.train_set', value: 'C751A 7001/7002', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!ok.violations.some((v) => v.class === 'WRONG_IDENTITY'));
});

test('checkHardGates: RAG_UNSUPPORTED_FACT when knowledge is the source of a service action', () => {
  const r = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'work_performed', value: 'replaced compressor', support_status: 'DIRECT_TRANSCRIPT', source: 'knowledge:SBS_BUS:manual' }] });
  assert.ok(r.violations.some((v) => v.class === 'RAG_UNSUPPORTED_FACT'));
});

test('checkHardGates: CROSS_DOMAIN_LEAKAGE and UPLOAD_CONTAMINATION for cross-scope sources', () => {
  const leak = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'diagnosis.root_cause', value: 'x', support_status: 'DIRECT_TRANSCRIPT', source: 'knowledge:SBS_RAIL:manual' }] });
  assert.ok(leak.violations.some((v) => v.class === 'CROSS_DOMAIN_LEAKAGE'));
  const hvac = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'diagnosis.root_cause', value: 'x', support_status: 'DIRECT_TRANSCRIPT', source: 'knowledge:HVAC:manual' }] });
  assert.ok(hvac.violations.some((v) => v.class === 'CROSS_DOMAIN_LEAKAGE'));
  const contam = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'work.description', value: 'x', support_status: 'MANUAL_ENTRY', source: 'upload:u9:SBS_BUS' }] });
  assert.ok(contam.violations.some((v) => v.class === 'UPLOAD_CONTAMINATION'));
  const sameScope = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'diagnosis.root_cause', value: 'x', support_status: 'DIRECT_TRANSCRIPT', source: 'knowledge:SBS_BUS:manual' }] });
  assert.ok(!sameScope.violations.some((v) => v.class === 'CROSS_DOMAIN_LEAKAGE' || v.class === 'UPLOAD_CONTAMINATION'));
});

test('checkHardGates: CHANGED_NEGATION for negated UNCERTAIN statements only', () => {
  const cn = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'work.description', value: '未更换刹车片', support_status: 'UNCERTAIN' }] });
  assert.ok(cn.violations.some((v) => v.class === 'CHANGED_NEGATION'));
  const en = checkHardGates({ scopeId: 'SBS_RAIL', facts: [{ field: 'work_performed', value: 'did not replace the brake pads', support_status: 'UNCERTAIN' }] });
  assert.ok(en.violations.some((v) => v.class === 'CHANGED_NEGATION'));
  const grounded = checkHardGates({ scopeId: 'SBS_BUS', facts: [{ field: 'work.description', value: '未更换刹车片', support_status: 'DIRECT_TRANSCRIPT' }] });
  assert.ok(!grounded.violations.some((v) => v.class === 'CHANGED_NEGATION'));
});

test('checkHardGates aggregates every deterministic class from one violating fact set', () => {
  const facts = [
    { field: 'safety.return_to_service', value: 'restored', support_status: 'MANUAL_ENTRY', source: 'technician' },
    { field: 'completion.state', value: 'scrapped', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'test.result', value: 'passed', support_status: 'UNCERTAIN', source: 'knowledge' },
    { field: 'measurement.pressure', value: '30 psi', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'asset.registration_no', value: '', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'work_performed', value: 'replaced pump', support_status: 'DIRECT_TRANSCRIPT', source: 'knowledge:SBS_RAIL:manual' },
    { field: 'work.description', value: '未完成测试', support_status: 'UNCERTAIN', source: 'transcript' },
  ];
  const { violations } = checkHardGates({ scopeId: 'SBS_BUS', facts });
  assert.ok(Object.isFrozen(violations));
  const classes = new Set(violations.map((v) => v.class));
  for (const cls of [
    'INCORRECT_SAFETY_RETURN_TO_SERVICE',
    'INCORRECT_COMPLETION_STATE',
    'INVENTED_TEST_RESULT',
    'CHANGED_NUMBER_UNIT',
    'WRONG_IDENTITY',
    'RAG_UNSUPPORTED_FACT',
    'CROSS_DOMAIN_LEAKAGE',
    'CHANGED_NEGATION',
  ]) {
    assert.ok(classes.has(cls), `expected ${cls} among [${[...classes].join(', ')}]`);
  }
});

test('checkHardGates: unknown scope throws (mirrors fact-schemas contract)', () => {
  assert.throws(() => checkHardGates({ scopeId: 'HVAC', facts: [] }), /Unknown V2 scope "HVAC"/);
  assert.throws(() => planV2Report({ scopeId: 'NOPE', facts: [] }), /Unknown V2 scope/);
});

test('ZX-47 (contract §13): no invented replacement in report content or hard gates', () => {
  // The technician never says a replacement occurred; the manual recommends it.
  const facts = [
    { field: 'asset.registration_no', value: 'SG3050Z', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'work.description', value: 'ZX-47 has intermittent failure', support_status: 'DIRECT_TRANSCRIPT', source: 'transcript' },
    { field: 'completion.state', value: 'deferred', support_status: 'CONFIRMED_BY_TECHNICIAN', source: 'technician' },
  ];
  const knowledgeHits = ['ZX-47 replacement recommended'];

  // 1) Report content must not assert the replacement as an occurred action.
  const report = buildBusReportSections({ facts, factsReceiptId: 'zx-47' });
  const allContent = report.sections.flatMap((s) => s.content).join('\n');
  assert.ok(!/\breplaced\b/i.test(allContent), 'report must not contain "replaced"');
  assert.ok(!allContent.includes('更换'), 'report must not contain 更换');
  assert.ok(!allContent.includes('ZX-47 replacement recommended'), 'manual text must not leak into the report');
  // The transcript's failure description IS grounded and present.
  assert.ok(allContent.includes('ZX-47 has intermittent failure'));

  // 2) The knowledge hit is flagged as an unsupported invented action.
  const violations = assertNoServiceFactInvention({ facts, knowledgeHits });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].class, 'INVENTED_ACTION_REPLACEMENT');
  assert.ok(violations[0].detail.includes('ZX-47'));

  // 3) Hard gates see no invented replacement on these grounded facts.
  const gates = checkHardGates({ scopeId: 'SBS_BUS', facts });
  assert.ok(!gates.violations.some((v) => v.class === 'INVENTED_ACTION_REPLACEMENT' || v.class === 'RAG_UNSUPPORTED_FACT'));
});

test('planV2Report: missing required sections are reported deterministically', () => {
  const plan = planV2Report({ scopeId: 'SBS_BUS', facts: [
    { field: 'asset.registration_no', value: 'SG3050Z', support_status: 'DIRECT_TRANSCRIPT' },
    { field: 'work.fault_code', value: 'P0216', support_status: 'DIRECT_TRANSCRIPT' },
    { field: 'safety.hv_isolation', value: 'isolated', support_status: 'CONFIRMED_BY_TECHNICIAN' },
    { field: 'completion.state', value: 'completed', support_status: 'CONFIRMED_BY_TECHNICIAN' },
  ], factsReceiptId: 'rc-1' });
  assert.equal(plan.scopeId, 'SBS_BUS');
  assert.ok(Object.isFrozen(plan.sections));
  assert.deepEqual(plan.sections.map((s) => s.id), BUS_REPORT_SECTIONS.map((s) => s.id));
  assert.deepEqual(plan.missing_required_fields, ['works_summary', 'work_performed', 'tests_results', 'compliance_audit']);

  const railPlan = planV2Report({ scopeId: 'SBS_RAIL', facts: [
    { field: 'asset.train_set', value: 'C751A 7001/7002', support_status: 'DIRECT_TRANSCRIPT' },
    { field: 'access.approval', value: 'approved', support_status: 'CONFIRMED_BY_TECHNICIAN' },
  ] });
  assert.deepEqual(railPlan.missing_required_fields, [
    'works_summary', 'trigger_findings', 'work_performed', 'tests_results',
    'completion_state_return_to_service', 'safety_ops_notes', 'reliability_compliance', 'provenance',
  ]);
});

test('planV2Report: full coverage leaves no missing required sections', () => {
  const plan = planV2Report({ scopeId: 'SBS_BUS', facts: [
    { field: 'asset.registration_no', value: 'SG3050Z', support_status: 'DIRECT_TRANSCRIPT' },
    { field: 'work.type', value: 'corrective', support_status: 'DIRECT_TRANSCRIPT' },
    { field: 'work.fault_code', value: 'P0216', support_status: 'DIRECT_TRANSCRIPT' },
    { field: 'work_performed', value: 'replaced brake pads', support_status: 'DIRECT_TRANSCRIPT' },
    { field: 'test.result', value: 'brake pass', support_status: 'CONFIRMED_BY_TECHNICIAN' },
    { field: 'completion.state', value: 'completed', support_status: 'CONFIRMED_BY_TECHNICIAN' },
    { field: 'safety.hv_isolation', value: 'isolated', support_status: 'CONFIRMED_BY_TECHNICIAN' },
    { field: 'compliance.audit_ref', value: 'LTA-2026-01', support_status: 'MANUAL_ENTRY' },
  ], factsReceiptId: 'rc-full' });
  assert.deepEqual(plan.missing_required_fields, []);
});
