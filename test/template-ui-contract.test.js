import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('visible technician journey is Choose Template → Report Workspace → Confirm', async () => {
  const html = await fs.readFile('web/index.html', 'utf8');
  assert.match(html, /id="template-app"/);
  assert.match(html, /id="template-choose"/);
  assert.match(html, /id="template-workspace"/);
  assert.match(html, /id="workspace-confirm"/);
  assert.match(html, /class="app-shell" hidden inert/);
  const visibleShell = html.slice(html.indexOf('id="template-app"'), html.indexOf('<div class="app-shell"'));
  assert.doesNotMatch(visibleShell, />\s*Knowledge\s*</i);
  assert.doesNotMatch(visibleShell, /Top-K|raw schema JSON|chunk controls|model controls/i);
});

test('manager journey exposes Templates → Template setup → Test → Publish', async () => {
  const html = await fs.readFile('web/index.html', 'utf8');
  for (const id of ['template-manager', 'template-setup', 'setup-source-file', 'setup-field-list', 'setup-context-file', 'setup-test', 'setup-publish']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Upload → analyze → review schema → add context → test → publish/i);
  assert.match(html, /Detected fields are never invented/i);
});

test('visible app imports the shared runtime and uses generic template routes', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /from '\.\/report-runtime\.js'/);
  assert.match(client, /createReportSession\(\{ templateId/);
  assert.match(client, /\/api\/template-reports\/build/);
  assert.match(client, /\/api\/v2\/reports\/confirm/);
  assert.match(client, /\/api\/templates\/drafts\/\$\{encodeURIComponent\(state\.setupDraft\.id\)\}\/publish/);
});

test('workspace renders template fields and inline missing/critical resolution without positive defaults', async () => {
  const [client, html] = await Promise.all([fs.readFile('web/template-app.js', 'utf8'), fs.readFile('web/index.html', 'utf8')]);
  assert.match(client, /fieldStatusPresentation\(fieldState, field\)/);
  assert.match(client, /groupTemplateFields\(state\.activeTemplate\.schema\.fields\)/);
  assert.match(client, /normalized !== 'NOT_CHECKED'/);
  assert.match(client, /CONFIRMED_BY_TECHNICIAN/);
  assert.match(html, /id="report-required-count"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="template-workspace"'), html.indexOf('id="template-manager"')), /Nothing becomes OK, passed, or complete from silence/i);
});
