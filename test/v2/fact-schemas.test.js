import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUS_FACT_FIELDS,
  INDUSTRIAL_FACT_FIELDS,
  MANUAL_ONLY_FIELDS_V2,
  RAIL_FACT_FIELDS,
  SUPPORTED_V2_SCOPES,
  SUPPORT_STATUSES,
  isCriticalField,
} from '../../src/v2/fact-schemas.js';

const TAGS = new Set(['CONFIRMED_BY_EVIDENCE', 'PROVISIONAL', 'REQUIRES_SBS_CONFIRMATION']);
const EVIDENCE_LEVELS = new Set(['A', 'B', 'C', 'D']);

test('SUPPORTED_V2_SCOPES lists transport and industrial scopes, frozen', () => {
  assert.deepEqual(SUPPORTED_V2_SCOPES, ['SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID']);
  assert.ok(Object.isFrozen(SUPPORTED_V2_SCOPES));
});

test('all field arrays are non-empty and every entry carries the full contract shape', () => {
  for (const fields of [BUS_FACT_FIELDS, RAIL_FACT_FIELDS, INDUSTRIAL_FACT_FIELDS]) {
    assert.ok(fields.length > 0, 'field array must not be empty');
    for (const entry of fields) {
      assert.equal(typeof entry.field, 'string');
      assert.ok(entry.field.length > 0);
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.tag, 'string');
      assert.equal(typeof entry.evidence_level, 'string');
      assert.equal(typeof entry.critical, 'boolean');
      assert.equal(typeof entry.notes, 'string');
    }
  }
});

test('every tag is one of CONFIRMED_BY_EVIDENCE / PROVISIONAL / REQUIRES_SBS_CONFIRMATION', () => {
  for (const fields of [BUS_FACT_FIELDS, RAIL_FACT_FIELDS, INDUSTRIAL_FACT_FIELDS]) {
    for (const entry of fields) {
      assert.ok(TAGS.has(entry.tag), `unexpected tag "${entry.tag}" on ${entry.field}`);
    }
  }
});

test('every evidence_level is A/B/C/D', () => {
  for (const fields of [BUS_FACT_FIELDS, RAIL_FACT_FIELDS, INDUSTRIAL_FACT_FIELDS]) {
    for (const entry of fields) {
      assert.ok(EVIDENCE_LEVELS.has(entry.evidence_level), `unexpected evidence_level "${entry.evidence_level}" on ${entry.field}`);
    }
  }
});

test('field names are unique within each scope', () => {
  for (const fields of [BUS_FACT_FIELDS, RAIL_FACT_FIELDS, INDUSTRIAL_FACT_FIELDS]) {
    const seen = new Set();
    for (const entry of fields) {
      assert.ok(!seen.has(entry.field), `duplicate field "${entry.field}"`);
      seen.add(entry.field);
    }
  }
});

test('BUS_FACT_FIELDS covers the required Bus fact fields', () => {
  const busFields = new Set(BUS_FACT_FIELDS.map((entry) => entry.field));
  for (const field of [
    'asset.registration_no', 'asset.internal_fleet_no', 'asset.bus_model', 'asset.depot', 'asset.package',
    'work.type', 'work.trigger', 'work.work_order_id', 'work.fault_code', 'work.description',
    'diagnosis.root_cause', 'parts.part_number', 'parts.replaced', 'measurement.*', 'test.result',
    'completion.state', 'safety.*', 'provenance.*',
  ]) {
    assert.ok(busFields.has(field), `BUS_FACT_FIELDS is missing "${field}"`);
  }
});

test('RAIL_FACT_FIELDS covers the required Rail fact fields', () => {
  const railFields = new Set(RAIL_FACT_FIELDS.map((entry) => entry.field));
  for (const field of [
    'asset.line', 'asset.train_set', 'asset.car', 'asset.stock_class', 'asset.subsystem',
    'work.type', 'work.trigger', 'work.order_id', 'work.fault_code', 'diagnosis.root_cause',
    'parts.part_number', 'measurement.*', 'test.result', 'access.approval', 'completion.state',
    'safety.*', 'reliability.*', 'provenance.*',
  ]) {
    assert.ok(railFields.has(field), `RAIL_FACT_FIELDS is missing "${field}"`);
  }
});

test('isCriticalField returns true for critical BUS fields (completion, safety, test, parts, fault code)', () => {
  for (const field of [
    'completion.state',
    'safety.hv_isolation',
    'safety.fire_response',
    'safety.*',
    'test.result',
    'parts.replaced',
    'parts.part_number',
    'work.fault_code',
    'asset.registration_no',
    'measurement.brake_percent',
  ]) {
    assert.equal(isCriticalField({ scopeId: 'SBS_BUS', field }), true, `expected "${field}" to be critical in BUS`);
  }
});

test('isCriticalField returns true for critical RAIL fields (completion, safety, test, access, identity)', () => {
  for (const field of [
    'completion.state',
    'safety.return_to_service',
    'safety.*',
    'test.result',
    'access.approval',
    'asset.train_set',
    'parts.part_number',
    'work.fault_code',
    'measurement.rail_defect_depth',
  ]) {
    assert.equal(isCriticalField({ scopeId: 'SBS_RAIL', field }), true, `expected "${field}" to be critical in RAIL`);
  }
});

test('isCriticalField returns false for non-critical fields', () => {
  for (const { scopeId, field } of [
    { scopeId: 'SBS_BUS', field: 'asset.depot' },
    { scopeId: 'SBS_BUS', field: 'asset.package' },
    { scopeId: 'SBS_BUS', field: 'work.work_order_id' },
    { scopeId: 'SBS_BUS', field: 'provenance.source' },
    { scopeId: 'SBS_RAIL', field: 'asset.line' },
    { scopeId: 'SBS_RAIL', field: 'reliability.mkbf' },
    { scopeId: 'SBS_RAIL', field: 'diagnosis.root_cause' },
  ]) {
    assert.equal(isCriticalField({ scopeId, field }), false, `expected "${field}" not to be critical in ${scopeId}`);
  }
});

test('isCriticalField returns false for unknown fields but throws for unknown scopes', () => {
  assert.equal(isCriticalField({ scopeId: 'SBS_BUS', field: 'asset.unknown_thing' }), false);
  assert.equal(isCriticalField({ scopeId: 'SBS_RAIL', field: 'does.not.exist' }), false);
  assert.throws(() => isCriticalField({ scopeId: 'HVAC', field: 'completion.state' }), /Unknown V2 scope "HVAC"/);
  assert.throws(() => isCriticalField({ scopeId: 'NOPE', field: 'x' }), /Unknown V2 scope/);
  assert.throws(() => isCriticalField({ scopeId: '', field: 'x' }), /Unknown V2 scope/);
});

test('Rail is not a clone of Bus: scope-specific fields exist only on their own side', () => {
  const busFields = new Set(BUS_FACT_FIELDS.map((entry) => entry.field));
  const railFields = new Set(RAIL_FACT_FIELDS.map((entry) => entry.field));
  // Rail-only fields (04 §2): train set identity and TAMS track-access approval.
  for (const field of ['asset.train_set', 'access.approval']) {
    assert.ok(railFields.has(field), `RAIL_FACT_FIELDS is missing "${field}"`);
    assert.ok(!busFields.has(field), `BUS_FACT_FIELDS must not contain "${field}"`);
  }
  // Bus-only fields (03 §2 / 05 §3.3): VRN registration and LTA bus package.
  for (const field of ['asset.registration_no', 'asset.package']) {
    assert.ok(busFields.has(field), `BUS_FACT_FIELDS is missing "${field}"`);
    assert.ok(!railFields.has(field), `RAIL_FACT_FIELDS must not contain "${field}"`);
  }
});

test('SUPPORT_STATUSES exposes exactly the four V1 statuses, frozen', () => {
  assert.deepEqual(SUPPORT_STATUSES, {
    DIRECT_TRANSCRIPT: 'DIRECT_TRANSCRIPT',
    MANUAL_ENTRY: 'MANUAL_ENTRY',
    CONFIRMED_BY_TECHNICIAN: 'CONFIRMED_BY_TECHNICIAN',
    UNCERTAIN: 'UNCERTAIN',
  });
  assert.ok(Object.isFrozen(SUPPORT_STATUSES));
  for (const key of Object.keys(SUPPORT_STATUSES)) {
    assert.equal(SUPPORT_STATUSES[key], key);
  }
});

test('MANUAL_ONLY_FIELDS_V2 keeps V1 cost_quote/warranty and adds the SBS candidates', () => {
  const fields = MANUAL_ONLY_FIELDS_V2.map((entry) => entry.field);
  assert.ok(fields.includes('cost_quote'), 'cost_quote must remain manual-only');
  assert.ok(fields.includes('warranty'), 'warranty must remain manual-only');
  for (const candidate of ['estimated_completion_time', 'part_price', 'contract_reference', 'penalty_or_claim']) {
    assert.ok(fields.includes(candidate), `MANUAL_ONLY_FIELDS_V2 is missing candidate "${candidate}"`);
  }
  for (const entry of MANUAL_ONLY_FIELDS_V2) {
    assert.equal(entry.tag, 'REQUIRES_SBS_CONFIRMATION');
    assert.equal(typeof entry.notes, 'string');
    assert.ok(entry.notes.length > 0);
  }
});
