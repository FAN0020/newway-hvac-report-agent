import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createReportSession, createReportSnapshot } from '../src/domain/index.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { VehicleHistoryService } from '../src/workflows/vehicle-history.js';

const ROOT = path.resolve('.tmp-tests', 'vehicle-history');
const HASH = 'a'.repeat(64);

async function fixture(t) {
  await fs.rm(ROOT, { recursive: true, force: true });
  t.after(() => fs.rm(ROOT, { recursive: true, force: true }));
  const store = new ReportSessionStore({ root: ROOT });
  return { store, history: new VehicleHistoryService({ sessionStore: store }) };
}

async function persistReport(store, { number, vehicleId, workOrderId, fieldVehicleId = vehicleId, confirmed = true, noOrder = false }) {
  const id = `session_vehicle_${number}`;
  const workOrderRef = `work-order:wo_${String(number).padStart(36, '0')}@1`;
  const base = createReportSession({
    session_id: id,
    template_binding: { template_id: 'bus-report', template_version: '1' },
    context_binding: { context_id: 'SBS/BUS', context_version: '1', scope_id: 'SBS_BUS' },
    job_context_ref: noOrder ? `new-report:manual-${number}` : workOrderRef,
    created_at: `2026-10-01T00:00:${String(number).padStart(2, '0')}.000Z`,
  });
  if (!confirmed) {
    await store.writeSession(base);
    return { session: base, snapshot: null };
  }
  const session = {
    ...base, phase: 'CONFIRMED', revision: 1,
    confirmation_ref: `confirmation_${number}`,
    job_context_binding: vehicleId && !noOrder ? {
      record_id: workOrderRef, version: '1', vehicle_id: vehicleId,
      source_sha256: HASH, review_sha256: HASH,
    } : undefined,
  };
  const fields = [
    ...(fieldVehicleId === null ? [] : [{ contract: 'ReportField', session_id: id, field_id: 'asset.internal_fleet_no', state: 'KNOWN_VALUE', value: fieldVehicleId }]),
    { contract: 'ReportField', session_id: id, field_id: 'work.work_order_id', state: 'KNOWN_VALUE', value: workOrderId },
  ];
  const snapshot = createReportSnapshot({
    session, fields, evidence_ids: [], transcript_ids: [], guidance_context_ids: [],
    validation_issues: [], resolution_items: [], structured_state_hash: 'sha256:state',
    validation_ref: `validation_${number}`, confirmation_ref: session.confirmation_ref,
    technician_principal_ref: 'principal:tech', confirmed_at: `2026-10-01T00:00:${String(number).padStart(2, '0')}.000Z`,
    report: { contract: 'ExistingFormatReport', report_session_id: id, structured_state_hash: 'sha256:state',
      report_id: `report_${number}`, report_version: 1, sections: [] },
    created_at: `2026-10-01T00:00:${String(number).padStart(2, '0')}.000Z`,
  });
  await store.putRecord('report-snapshots', snapshot.snapshot_id, snapshot);
  await store.writeSession({ ...session, snapshot_ref: snapshot.snapshot_id });
  return { session, snapshot };
}

test('two confirmed reports for one reviewed vehicle remain separate across restart and exclude another vehicle', async (t) => {
  const { store, history } = await fixture(t);
  const first = await persistReport(store, { number: 1, vehicleId: 'BUS-101', workOrderId: 'WO-1' });
  const second = await persistReport(store, { number: 2, vehicleId: 'BUS-101', workOrderId: 'WO-2' });
  await persistReport(store, { number: 3, vehicleId: 'BUS-202', workOrderId: 'WO-3' });
  await persistReport(store, { number: 4, vehicleId: 'BUS-101', workOrderId: 'WO-4', confirmed: false });
  const result = await history.list('BUS-101');
  assert.deepEqual(result.reports.map((item) => item.snapshot_id), [first.snapshot.snapshot_id, second.snapshot.snapshot_id]);
  assert.deepEqual(result.reports.map((item) => item.work_order_ref), [first.snapshot.job_context_ref, second.snapshot.job_context_ref]);
  assert.deepEqual(result.reports.map((item) => item.report_version), [1, 1]);
  assert.ok(result.reports.every((item) => item.confirmation_ref && item.work_order_ref && item.review_sha256));
  const restarted = new VehicleHistoryService({ sessionStore: new ReportSessionStore({ root: ROOT }) });
  assert.deepEqual(await restarted.list('BUS-101'), result);
  assert.equal((await restarted.list('BUS-202')).reports.length, 1);
});

test('structured export reads the confirmed snapshot; a report with no reviewed vehicle stays pending', async (t) => {
  const { store, history } = await fixture(t);
  const confirmed = await persistReport(store, { number: 1, vehicleId: 'BUS-101', workOrderId: 'WO-1' });
  const pending = await persistReport(store, { number: 2, vehicleId: null, workOrderId: 'WO-2' });
  const exported = await history.export(confirmed.session.session_id);
  assert.equal(exported.vehicle_identity_status, 'VERIFIED');
  assert.equal(exported.source_snapshot_hash, confirmed.snapshot.snapshot_hash);
  assert.deepEqual(exported.fields, confirmed.snapshot.fields);
  assert.deepEqual(exported.report, confirmed.snapshot.report);
  assert.equal((await history.export(pending.session.session_id)).vehicle_identity_status, 'PENDING_VERIFICATION');
  assert.equal((await history.list('BUS-101')).reports.length, 1);
  await assert.rejects(() => history.export('missing'), { code: 'REPORT_SESSION_NOT_FOUND' });
});

test('wrong vehicle and altered immutable link are rejected instead of merged', async (t) => {
  const { store, history } = await fixture(t);
  const wrong = await persistReport(store, { number: 1, vehicleId: 'BUS-101', fieldVehicleId: 'BUS-202', workOrderId: 'WO-1' });
  await assert.rejects(() => history.export(wrong.session.session_id), { code: 'VEHICLE_ID_MISMATCH' });
  await fs.rm(ROOT, { recursive: true, force: true });
  const good = await persistReport(store, { number: 2, vehicleId: 'BUS-101', workOrderId: 'WO-2' });
  await history.export(good.session.session_id);
  const file = path.join(ROOT, 'records', 'vehicle-history-links', `${good.snapshot.snapshot_id}.json`);
  const link = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...link, vehicle_id: 'BUS-202' }));
  await assert.rejects(() => history.list('BUS-101'), { code: 'VEHICLE_HISTORY_LINK_MISMATCH' });
});

test('manual review links two no-order confirmed snapshots without changing either snapshot', async (t) => {
  const { store, history } = await fixture(t);
  const first = await persistReport(store, { number: 1, vehicleId: 'BUS-101', workOrderId: 'WO-1', noOrder: true });
  const second = await persistReport(store, { number: 2, vehicleId: 'BUS-101', workOrderId: 'WO-2', noOrder: true });
  assert.equal((await history.list('BUS-101')).reports.length, 0);
  for (const report of [first, second]) {
    const link = await history.reviewIdentity(report.session.session_id,
      { vehicle_id: 'BUS-101', attested: true, review_note: 'Fleet register record BUS-101 checked' }, 'principal:reviewer');
    assert.equal(link.vehicle_identity_source, 'MANUAL_REVIEW');
    assert.equal(link.work_order_ref, null);
    assert.equal((await store.readRecord('report-snapshots', report.snapshot.snapshot_id)).snapshot_hash, report.snapshot.snapshot_hash);
  }
  const restarted = new VehicleHistoryService({ sessionStore: new ReportSessionStore({ root: ROOT }) });
  assert.deepEqual((await restarted.list('BUS-101')).reports.map((item) => item.snapshot_id),
    [first.snapshot.snapshot_id, second.snapshot.snapshot_id]);
  assert.equal((await restarted.export(first.session.session_id)).vehicle_identity_status, 'VERIFIED');
  assert.equal((await restarted.list('BUS-202')).reports.length, 0);
});

test('manual review rejects missing attestation, wrong ID, conflicting retry and altered review', async (t) => {
  const { store, history } = await fixture(t);
  const report = await persistReport(store, { number: 1, vehicleId: 'BUS-101', workOrderId: 'WO-1', noOrder: true });
  const review = (vehicleId, attested = true) => history.reviewIdentity(report.session.session_id,
    { vehicle_id: vehicleId, attested, review_note: 'Fleet register checked' }, 'principal:reviewer');
  await assert.rejects(() => review('BUS-101', false), { code: 'VEHICLE_IDENTITY_REVIEW_REQUIRED' });
  await assert.rejects(() => review('BUS-202'), { code: 'VEHICLE_ID_MISMATCH' });
  await assert.rejects(() => review('../BUS-101'), { code: 'INVALID_VEHICLE_ID' });
  const link = await review('BUS-101');
  assert.deepEqual(await review('BUS-101'), link);
  await assert.rejects(() => review('BUS-202'), { code: 'VEHICLE_ID_MISMATCH' });
  const fieldless = await persistReport(store, { number: 2, vehicleId: 'BUS-101', fieldVehicleId: null, workOrderId: 'WO-2', noOrder: true });
  const reviewFieldless = (vehicleId) => history.reviewIdentity(fieldless.session.session_id,
    { vehicle_id: vehicleId, attested: true, review_note: 'Fleet register checked' }, 'principal:reviewer');
  await reviewFieldless('BUS-101');
  await assert.rejects(() => reviewFieldless('BUS-202'), { code: 'VEHICLE_IDENTITY_CONFLICT' });
  const file = path.join(ROOT, 'records', 'vehicle-identity-reviews', `${report.snapshot.snapshot_id}.json`);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...persisted, vehicle_id: 'BUS-202' }));
  await assert.rejects(() => history.list('BUS-101'), { code: 'VEHICLE_IDENTITY_REVIEW_MISMATCH' });
});
