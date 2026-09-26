import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { groupTemplateFields, reportStatusSummary } from '../web/template-workspace.js';

test('visible product shell uses generic Field Report branding and focused navigation', async () => {
  const html = await fs.readFile('web/index.html', 'utf8');
  const visibleShell = html.slice(html.indexOf('id="template-app"'), html.indexOf('<div class="app-shell"'));

  assert.match(html, /<title>Field Report<\/title>/);
  assert.match(visibleShell, /aria-label="Field Report home"/);
  assert.match(visibleShell, /<span>FR<\/span><strong>Field Report/);
  assert.doesNotMatch(visibleShell, /Newway/i);
  assert.match(visibleShell, />\s*Reports\s*<\/button>/);
  assert.match(visibleShell, />\s*New report\s*<\/button>/);
  assert.match(visibleShell, />\s*Templates\s*<\/button>/);
  assert.doesNotMatch(visibleShell, /data-template-nav="setup"[^>]*>[^<]*<span[^>]*>.*Template setup/is);
});

test('report workspace makes the composer, microphone, and inline report status primary', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/template-app.js', 'utf8'),
  ]);
  const workspace = html.slice(html.indexOf('id="template-workspace"'), html.indexOf('id="template-manager"'));

  assert.match(workspace, /class="workspace-status"/);
  assert.match(workspace, /id="report-required-count"/);
  assert.match(workspace, /id="report-state"/);
  assert.match(workspace, /class="workspace-composer"/);
  assert.match(workspace, /id="workspace-microphone"[^>]*aria-pressed="false"/);
  assert.match(workspace, /id="workspace-recording-time"/);
  assert.match(workspace, /Upload recording/);
  assert.match(workspace, /Add supporting document/);
  assert.doesNotMatch(workspace, />\s*CAPTURE\s*</i);
  assert.doesNotMatch(workspace, /Technician statement|Voice, typed text|Nothing becomes OK|Manual field entry is always available/i);
  assert.doesNotMatch(workspace, /id="inline-resolve"|class="[^\"]*readiness-card/);
  assert.doesNotMatch(workspace, /id="workspace-provenance"|id="workspace-version"/);

  assert.match(client, /import \{ PcmWavRecorder \} from '\.\/audio-recorder\.js'/);
  assert.match(client, /async function startWorkspaceRecording/);
  assert.match(client, /async function stopWorkspaceRecording/);
  assert.match(client, /await processWorkspaceAudio\(wav/);
  assert.match(client, /await analyzeStatement\(\{ preserveStatement: false \}\)/);
  assert.match(client, /\/api\/transcripts\/manual/);
});

test('shared field renderer groups checklist rows without template-specific branches', () => {
  const groups = groupTemplateFields([
    { id: 'work.date', label: 'Date', section: 'Job identity', displayOrder: 2, type: 'string' },
    { id: 'work.order', label: 'Work order', section: 'Job identity', displayOrder: 1, type: 'string' },
    { id: 'check.brakes.action', label: 'Brakes — action / remarks', section: 'Inspection checklist', displayOrder: 22, type: 'text' },
    { id: 'check.brakes.status', label: 'Brakes', section: 'Inspection checklist', displayOrder: 20, type: 'status' },
    { id: 'check.brakes.observation', label: 'Brakes — finding / measurement', section: 'Inspection checklist', displayOrder: 21, type: 'text' },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].layout, 'compact');
  assert.deepEqual(groups[0].rows.map((row) => row.fields[0].id), ['work.order', 'work.date']);
  assert.equal(groups[1].layout, 'checklist');
  assert.equal(groups[1].rows.length, 1);
  assert.equal(groups[1].rows[0].label, 'Brakes');
  assert.deepEqual(groups[1].rows[0].fields.map((field) => field.id), [
    'check.brakes.status', 'check.brakes.observation', 'check.brakes.action',
  ]);
});

test('compact report status distinguishes missing, confirmation, ready, and confirmed states', () => {
  assert.deepEqual(reportStatusSummary({ requiredFields: ['a', 'b'], missingFields: ['b'], conflicts: [], needsConfirmation: [], complete: false }), {
    resolved: 1, required: 2, countLabel: '1 / 2 required', state: 'NEEDS_INFORMATION', stateLabel: 'Needs information',
  });
  assert.equal(reportStatusSummary({ requiredFields: ['a'], missingFields: [], conflicts: ['a'], needsConfirmation: [], complete: false }).stateLabel, 'Needs confirmation');
  assert.equal(reportStatusSummary({ requiredFields: ['a'], missingFields: [], conflicts: [], needsConfirmation: [], complete: true }).stateLabel, 'Ready');
  assert.equal(reportStatusSummary({ requiredFields: ['a'], missingFields: [], conflicts: [], needsConfirmation: [], complete: true }, true).stateLabel, 'Confirmed');
});

test('report-oriented CSS uses dense desktop columns and intentional mobile collapse', async () => {
  const css = await fs.readFile('web/styles.css', 'utf8');
  assert.match(css, /\.field-grid\.compact\s*\{[^}]*repeat\(4,/s);
  assert.match(css, /\.checklist-row\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.schema-field-status/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.field-grid\.compact[^{]*\{[^}]*grid-template-columns:\s*1fr/s);
});

test('exact-version confirmation locks both report fields and the shared composer', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  const confirmation = client.slice(client.indexOf('async function confirmWorkspace()'), client.indexOf('function setSetupStep'));
  assert.match(client, /#workspace-fields input, #workspace-fields textarea, #workspace-fields select/);
  assert.match(client, /workspace-statement.*workspace-microphone.*workspace-analyze.*workspace-audio-upload.*workspace-text-upload/s);
  assert.match(confirmation, /setWorkspaceControlsDisabled\(true\)/);
  assert.match(confirmation, /This exact version is locked/);
});

test('in-flight evidence and confirmation cannot race the exact-version lock', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  const readiness = client.slice(client.indexOf('function renderReadiness()'), client.indexOf('function openWorkspace'));
  const confirmation = client.slice(client.indexOf('async function confirmWorkspace()'), client.indexOf('function setSetupStep'));

  assert.match(readiness, /workspaceBusy\.size > 0/);
  assert.match(readiness, /workspace-confirm'\)\.disabled = .*busy/s);
  assert.match(confirmation, /setWorkspaceControlsDisabled\(true\)/);
  assert.match(confirmation, /catch[\s\S]*setWorkspaceControlsDisabled\(false\)/);
});
