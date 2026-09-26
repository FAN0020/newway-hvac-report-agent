import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { controlValueForField, groupTemplateFields, reportStatusSummary } from '../web/template-workspace.js';

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
  assert.doesNotMatch(visibleShell, /Local workspace|version-bound/i);
});

test('organization context uses the catalog spelling without replacing the generic product brand', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');

  assert.match(client, /template\.domain === 'HVAC' \? 'NEWWAY'/);
  assert.doesNotMatch(client, /template\.domain === 'HVAC' \? 'NEWAY'/);
});

test('new report chooser is concise, filterable, and keeps implementation metadata out of technician cards', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/template-app.js', 'utf8'),
  ]);
  const chooser = html.slice(html.indexOf('id="template-choose"'), html.indexOf('id="template-workspace"'));

  assert.match(chooser, /<h2 id="choose-title">Choose a report<\/h2>/);
  assert.match(chooser, /placeholder="Search reports"/);
  for (const category of ['All', 'Bus', 'Rail', 'HVAC']) assert.match(chooser, new RegExp(`data-template-category="${category}"`));
  assert.match(chooser, /id="template-recent"[^>]*hidden/);
  assert.match(chooser, /Loading reports/);
  assert.doesNotMatch(chooser, /schema|context|renderer|provenance|prototype|version/i);
  assert.match(client, /selectTechnicianTemplates/);
  assert.match(client, /sessionStorage\.setItem\(RECENT_TEMPLATES_KEY/);
  assert.match(client, /No reports available/);
  assert.match(client, /No reports match/);
  assert.match(client, /Reports are unavailable/);
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
  assert.match(client, /\/capture\/audio/);
  assert.match(client, /applyAuthoritativeCapture\(result, sessionId, revision\)/);
  assert.match(client, /value === 'NOT_CHECKED' \? 'Not checked'/);
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
  assert.deepEqual(reportStatusSummary({ requiredFields: ['a'], missingFields: [], conflicts: ['a'], needsConfirmation: [], complete: false }), {
    resolved: 0, required: 1, countLabel: '0 / 1 required', state: 'NEEDS_CONFIRMATION', stateLabel: 'Needs confirmation',
  });
  assert.equal(reportStatusSummary({ requiredFields: ['a'], missingFields: [], conflicts: [], needsConfirmation: ['a'], complete: false }).resolved, 0);
  assert.equal(reportStatusSummary({ requiredFields: ['a'], missingFields: [], conflicts: [], needsConfirmation: [], complete: true }).stateLabel, 'Ready');
  assert.equal(reportStatusSummary({ requiredFields: ['a'], missingFields: [], conflicts: [], needsConfirmation: [], complete: true }, true).stateLabel, 'Confirmed');
});

test('missing status controls show a truthful needs-information value without creating a positive result', () => {
  assert.equal(controlValueForField({ type: 'status' }, null), 'NOT_CHECKED');
  assert.equal(controlValueForField({ type: 'status' }, ''), 'NOT_CHECKED');
  assert.equal(controlValueForField({ type: 'status' }, 'OK'), 'OK');
  assert.equal(controlValueForField({ type: 'text' }, null), '');
});

test('HVAC composer uses the authoritative transcript review pipeline with explicit inline decisions', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/template-app.js', 'utf8'),
  ]);
  const workspace = html.slice(html.indexOf('id="template-workspace"'), html.indexOf('id="template-manager"'));

  assert.match(workspace, /id="workspace-corrections"[^>]*hidden/);
  assert.match(client, /\/transcript-reviews\//);
  assert.match(client, /review_item_id:\s*candidate\.candidate_id/);
  assert.match(client, /expected_revision:\s*state\.authoritySession\.revision/);
  assert.match(client, /Use correction/);
  assert.match(client, /Keep original/);
  assert.match(client, /applyTranscriptArtifact\(state\.session, \{ \.\.\.result\.transcript/);
  assert.doesNotMatch(client, /correction_candidates\.map\([^)]*decision:\s*'ACCEPT'/s);
});

test('critical and conflicting field values expose an inline technician decision', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/template-app.js', 'utf8'),
  ]);
  const workspace = html.slice(html.indexOf('id="template-workspace"'), html.indexOf('id="template-manager"'));

  assert.match(workspace, /Tell us what happened/);
  assert.match(client, /schema-field-action/);
  assert.match(client, /Confirm value/);
  assert.match(client, /Use shown value/);
  assert.match(client, /setTechnicianFact\(field, control\.value\)/);
});

test('a pending transcript decision blocks confirmation and clears stale extracted values', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  const readiness = client.slice(client.indexOf('function renderReadiness()'), client.indexOf('function openWorkspace'));
  const captureApplication = client.slice(client.indexOf('function applyAuthoritativeCapture'), client.indexOf('function clearExtractedFacts'));

  assert.match(readiness, /pendingCorrectionReview\s*=\s*Boolean\(state\.hvacCorrectionReview\)/);
  assert.match(readiness, /Needs confirmation/);
  assert.match(readiness, /\|\|\s*pendingCorrectionReview\s*\|\|/);
  assert.match(captureApplication, /clearExtractedFacts\(\)/);
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

test('visible workspace delegates capture, extraction, field answers, and report facts to ReportSession backend', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /api\('\/api\/report-sessions'/);
  assert.match(client, /\/capture\/text/);
  assert.match(client, /\/capture\/audio/);
  assert.match(client, /\/transcript-reviews\//);
  assert.match(client, /\/fields\//);
  assert.match(client, /\/candidates\//);
  assert.doesNotMatch(client, /api\('\/api\/v2\/facts\/extract'/);
  assert.doesNotMatch(client, /api\('\/api\/facts\/extract'/);
  assert.doesNotMatch(client, /knowledge_hits/);
  const confirmation = client.slice(client.indexOf('async function confirmWorkspace()'), client.indexOf('function setSetupStep'));
  assert.doesNotMatch(confirmation, /facts:\s*factsFromStructuredState/);
});
