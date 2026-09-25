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
