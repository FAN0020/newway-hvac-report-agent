import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('visible technician journey is Choose Report → generated report review → one report-level confirmation', async () => {
  const [html, client] = await Promise.all([fs.readFile('web/index.html', 'utf8'), fs.readFile('web/template-app.js', 'utf8')]);
  const workspace = html.slice(html.indexOf('id="template-workspace"'), html.indexOf('id="template-manager"'));
  assert.match(html, /id="template-app"/);
  assert.match(html, /id="template-choose"/);
  assert.match(workspace, /data-workspace-area="JOB_HEADER"/);
  assert.match(workspace, /data-workspace-area="ACTIVE_TASK_PANEL"/);
  assert.match(workspace, /data-workspace-area="REPORT_SUMMARY"/);
  assert.match(client, /workspace\.session\.phase !== 'READY'/);
  assert.match(client, /window\.scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\)/u);
  assert.match(client, /\/review\/complete/);
  assert.match(client, /\/confirm/);
  assert.match(client, /\/export/);
  assert.match(client, /async function confirmAndSubmitReport/);
  assert.match(workspace, /id="workspace-report-confirmation"/);
  assert.match(workspace, /Back to report/);
  assert.doesNotMatch(workspace, /REPORT COMPLETE/);
  assert.match(workspace, /Confirm &amp; submit/);
  assert.doesNotMatch(client, /button\('Finish review'/);
  assert.doesNotMatch(client, /button\('Confirm report'/);
  assert.doesNotMatch(workspace, /Update report|workspace-confirm-check|workspace-fields/iu);
  assert.match(workspace, /class="back-link" data-template-nav="reports">← Reports<\/button>/u);
  assert.match(html, /class="app-shell" hidden inert/);
});

test('manager journey remains available without redesign', async () => {
  const html = await fs.readFile('web/index.html', 'utf8');
  for (const id of ['template-manager', 'template-setup', 'setup-source-file', 'setup-field-list', 'setup-context-file', 'setup-test', 'setup-publish']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Upload → analyze → review schema → add context → test → publish/i);
});

test('workspace uses authoritative ReportSession routes and never submits browser facts', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  for (const route of ['/api/report-sessions', '/capture/text', '/capture/audio', '/select', '/review', '/attachments']) assert.ok(client.includes(route), `missing ${route}`);
  assert.match(client, /deriveWorkspaceView/);
  assert.doesNotMatch(client, /\/api\/template-reports\/build|\/api\/v2\/reports\/(?:confirm|export)/);
  assert.doesNotMatch(client, /facts:\s*factsFromStructuredState|evaluateCompleteness|mapFactsToStructuredState|knowledge_hits/);
});

test('browser helper modules imported by the workspace are served explicitly', async () => {
  const server = await fs.readFile('src/server.js', 'utf8');
  assert.match(server, /\['\/report-input\.js', \['report-input\.js', 'text\/javascript; charset=utf-8'\]\]/u);
  assert.match(server, /\['\/transcript-inline\.js', \['transcript-inline\.js', 'text\/javascript; charset=utf-8'\]\]/u);
});

test('capture and report display are progressive, read-first, and source-aware', async () => {
  const [html, client] = await Promise.all([fs.readFile('web/index.html', 'utf8'), fs.readFile('web/template-app.js', 'utf8')]);
  const workspace = html.slice(html.indexOf('id="template-workspace"'), html.indexOf('id="template-manager"'));
  assert.match(workspace, /id="workspace-active-task"/);
  assert.match(workspace, /id="workspace-evidence-dialog"/);
  assert.match(workspace, /id="workspace-attachment-purpose"/);
  assert.doesNotMatch(client, /Initial statement captured ✓ · View transcript/);
  assert.match(client, /report-section-accordion/);
  assert.match(client, /showProvenance/);
  assert.match(client, /state\.editingField === field\.field_id/);
  assert.match(client, /section\.fields\.some\(\(field\) => field\.field_id === state\.editingField\)/u);
  assert.match(client, /AI draft/);
  assert.match(client, /Original words/);
  assert.match(client, /My edit/);
  assert.match(client, /field\.resolution_item/);
  assert.doesNotMatch(workspace, /<main[\s>]/u);
  assert.doesNotMatch(workspace, /confidence|chunk[_ -]?id|trace[_ -]?id|model|provider|raw json/iu);
});
