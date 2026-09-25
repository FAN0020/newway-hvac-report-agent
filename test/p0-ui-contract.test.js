import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('P0 SPA exposes the technician journey and secondary surfaces', async () => {
  const html = await fs.readFile('web/index.html', 'utf8');
  for (const id of [
    'view-reports', 'view-new-report', 'view-capture', 'view-resolve', 'view-review',
    'view-complete', 'view-knowledge', 'view-settings', 'view-help', 'evidence-drawer',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const label of ['Reports', 'New report', 'Capture', 'Resolve', 'Review', 'Complete']) {
    assert.match(html, new RegExp(label, 'i'));
  }
});

test('primary technician UI removes mandatory implementation-stage buttons', async () => {
  const html = await fs.readFile('web/index.html', 'utf8');
  assert.doesNotMatch(html, />\s*Extract facts\s*</i);
  assert.doesNotMatch(html, />\s*Build report\s*</i);
  assert.match(html, /Original transcript/);
  assert.match(html, /View audit details/);
});

test('generic EmptyState and scope-aware placeholders replace observed P0 defects', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
  ]);
  assert.match(client, /function renderEmptyState/);
  assert.doesNotMatch(client, /replaceChildren\(\s*uploads\.length\s*\?/s);
  assert.doesNotMatch(html, /e\.g\. \(Bus\)/);
  assert.match(client, /statementPlaceholder/);
});

test('V2 finalization routes are present and use the shared confirmation tools', async () => {
  const server = await fs.readFile('src/server.js', 'utf8');
  for (const route of ['/api/v2/reports/confirm', '/api/v2/reports/save', '/api/v2/reports/export']) {
    assert.match(server, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.match(server, /schema_id/);
  assert.match(server, /schema_version/);
  assert.match(server, /confirmReportDraft/);
  assert.match(server, /saveConfirmedReport/);
  assert.match(server, /exportConfirmedReport/);
});

test('Capture keeps voice primary while manual entry, retry, and transcript disclosure are progressive', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
  ]);
  for (const id of ['type-instead', 'manual-entry', 'statement-ready', 'view-statement', 'edit-statement']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(client, new RegExp(id));
  }
  assert.match(html, /id="manual-entry"[^>]*hidden/);
  assert.match(html, /id="retry"[^>]*hidden/);
  assert.doesNotMatch(html, />\s*Transcribe audio\s*</i);
  assert.match(client, /await transcribe\(1\)/);
  assert.match(html, /Audio &amp; transcription options/);
  assert.match(html, /Add supporting document/);
  assert.match(html, /not proof that work occurred/i);
  assert.match(client, /reference material only; it is not proof that work occurred/i);
});

test('Resolve uses one session-bound generic card without repeating technician identity fields', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
  ]);
  for (const id of ['capture-technician-name', 'capture-technician-id', 'resolve-progress', 'review-identity-summary', 'change-technician']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="correction-technician-(?:name|id)"/);
  assert.match(client, /resolveProgress/);
  assert.match(client, /applyResolveDecision/);
  assert.doesNotMatch(client, /Math\.max\(1, candidates\.length\)/);
});

test('Review, Evidence, and Complete expose the P0 trust and recovery controls', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
  ]);
  for (const id of [
    'edit-information', 'complete-status', 'start-another-report',
    'evidence-source', 'evidence-corrections', 'evidence-facts', 'evidence-state',
    'evidence-resolve', 'evidence-context', 'evidence-validation', 'evidence-finalization',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="evidence-drawer"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="evidence-title"/);
  assert.match(client, /previousEvidenceFocus/);
  assert.match(client, /event\.key === 'Escape'/);
  assert.match(client, /navigator\.clipboard\.writeText/);
  assert.match(client, /Copy failed:/);
});

test('Knowledge, Demo, and Settings expose bounded P0 trust controls', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
  ]);
  for (const id of ['settings-language', 'settings-model', 'knowledge-boundary', 'demo-boundary']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Manual search only/);
  assert.match(html, /Stop · keep demo data/);
  assert.match(client, /session\.demo/);
  assert.match(client, /demoRunGeneration/);
  assert.match(client, /function cancelDemoRun/);
  assert.match(client, /v2Wt\.generation/);
  assert.match(client, /knowledgeScope === 'SBS_RAIL' \? 'sbs_rail_maintenance' : 'sbs_bus_maintenance'/);
  assert.match(client, /setAttribute\('aria-pressed'/);
  assert.match(client, /generation === knowledgeRequestGeneration/);
});
