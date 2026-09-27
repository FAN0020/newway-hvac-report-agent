import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ReportSessionStore } from '../src/storage/report-sessions.js';

const ROOT = path.resolve('.tmp-tests', 'authoritative-report-session-store');

function sessionInput(id = 'session_store_1') {
  return {
    session_id: id,
    template_binding: {
      template_id: 'bus-defect-rectification-corrective-maintenance',
      template_version: '1.0.0',
    },
    context_binding: {
      context_id: 'SBS/BUS',
      context_version: '1.0.0',
      scope_id: 'SBS_BUS',
    },
    job_context_ref: 'job-context:WO-STORE-1',
    created_at: '2026-09-27T05:00:00.000Z',
  };
}

test('persisted ReportSession and its creation event survive a new store instance', async (t) => {
  await fs.rm(ROOT, { recursive: true, force: true });
  t.after(() => fs.rm(ROOT, { recursive: true, force: true }));

  const firstProcess = new ReportSessionStore({ root: ROOT });
  const created = await firstProcess.create(sessionInput());
  const secondProcess = new ReportSessionStore({ root: ROOT });
  const reloaded = await secondProcess.load(created.session.session_id);
  const events = await secondProcess.listAuditEvents(created.session.session_id);

  assert.deepEqual(reloaded, created.session);
  assert.equal(reloaded.revision, 0);
  assert.deepEqual(reloaded.audit_event_ids, [created.event.event_id]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'SESSION_CREATED');
  assert.equal(events[0].revision, 0);
});

test('session transitions persist exact revisions and reject stale writes after reload', async (t) => {
  await fs.rm(ROOT, { recursive: true, force: true });
  t.after(() => fs.rm(ROOT, { recursive: true, force: true }));

  const store = new ReportSessionStore({ root: ROOT });
  const created = await store.create(sessionInput('session_store_revision'));
  const captured = await store.transition({
    session_id: created.session.session_id,
    expected_revision: 0,
    to_phase: 'CAPTURE',
    occurred_at: '2026-09-27T05:01:00.000Z',
    details: { source: 'TECHNICIAN_TEXT' },
  });

  assert.equal(captured.session.revision, 1);
  assert.equal(captured.session.phase, 'CAPTURE');
  assert.equal(captured.event.payload.source, 'TECHNICIAN_TEXT');

  const restarted = new ReportSessionStore({ root: ROOT });
  await assert.rejects(restarted.transition({
    session_id: created.session.session_id,
    expected_revision: 0,
    to_phase: 'PROCESSING',
    occurred_at: '2026-09-27T05:02:00.000Z',
  }), { code: 'STALE_REVISION' });
  assert.equal((await restarted.load(created.session.session_id)).revision, 1);
});

test('persisted ReportSessions can be listed after restart in most-recently-updated order', async (t) => {
  await fs.rm(ROOT, { recursive: true, force: true });
  t.after(() => fs.rm(ROOT, { recursive: true, force: true }));

  const firstProcess = new ReportSessionStore({ root: ROOT });
  await firstProcess.create(sessionInput('session_store_old'));
  await firstProcess.create({
    ...sessionInput('session_store_new'),
    created_at: '2026-09-27T05:10:00.000Z',
  });

  const restarted = new ReportSessionStore({ root: ROOT });
  const sessions = await restarted.listSessions();
  assert.deepEqual(sessions.map((session) => session.session_id), ['session_store_new', 'session_store_old']);
  assert.equal(sessions.every((session) => session.authority === 'SERVER'), true);
});

test('daily report names stay unique when another store created one after a stale listing', async (t) => {
  await fs.rm(ROOT, { recursive: true, force: true });
  t.after(() => fs.rm(ROOT, { recursive: true, force: true }));

  const firstStore = new ReportSessionStore({ root: ROOT });
  const secondStore = new ReportSessionStore({ root: ROOT });
  const originalList = secondStore.listSessions.bind(secondStore);
  let snapshotReady;
  let releaseSnapshot;
  const ready = new Promise((resolve) => { snapshotReady = resolve; });
  const held = new Promise((resolve) => { releaseSnapshot = resolve; });
  secondStore.listSessions = async () => {
    const snapshot = await originalList();
    snapshotReady();
    await held;
    return snapshot;
  };
  const namedInput = (id) => ({
    ...sessionInput(id),
    report_name_base: 'Bus Defect Rectification',
    report_time_zone: 'Asia/Shanghai',
  });

  const waiting = secondStore.create(namedInput('session_store_parallel_second'));
  await ready;
  const first = await firstStore.create(namedInput('session_store_parallel_first'));
  releaseSnapshot();
  const second = await waiting;

  assert.equal(first.session.report_name, 'Bus Defect Rectification · 2026-09-27');
  assert.equal(second.session.report_name, 'Bus Defect Rectification · 2026-09-27 (2)');
});
