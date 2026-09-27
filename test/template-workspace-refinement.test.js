import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { controlValueForField, groupTemplateFields, reportStatusSummary } from '../web/template-workspace.js';

test('visible shell keeps generic Field Report branding and focused navigation', async () => {
  const html = await fs.readFile('web/index.html', 'utf8');
  const shell = html.slice(html.indexOf('id="template-app"'), html.indexOf('<div class="app-shell"'));
  assert.match(shell, /aria-label="Field Report home"/);
  assert.match(shell, />\s*Reports\s*<\/button>/);
  assert.match(shell, />\s*New report\s*<\/button>/);
  assert.match(shell, />\s*Templates\s*<\/button>/);
  assert.doesNotMatch(shell, />\s*Knowledge\s*</i);
});

test('chooser stays concise and filterable', async () => {
  const [html, client] = await Promise.all([fs.readFile('web/index.html', 'utf8'), fs.readFile('web/template-app.js', 'utf8')]);
  const chooser = html.slice(html.indexOf('id="template-choose"'), html.indexOf('id="template-workspace"'));
  assert.match(chooser, /Choose a report/);
  for (const category of ['All', 'Bus', 'Rail', 'HVAC']) assert.match(chooser, new RegExp(`data-template-category="${category}"`));
  assert.doesNotMatch(chooser, /schema|renderer|provenance|chunk|model/iu);
  assert.match(client, /recentTechnicianTemplates/);
});

test('workspace has one capture primary, one embedded microphone, and two secondary evidence actions', async () => {
  const [client, view] = await Promise.all([fs.readFile('web/template-app.js', 'utf8'), fs.readFile('web/report-workspace-view.js', 'utf8')]);
  assert.match(view, /Tell us what happened/);
  assert.match(client, /workspace-microphone/);
  assert.match(client, /Upload recording/);
  assert.match(client, /Attach evidence/);
  assert.match(client, /submitLabel: 'Continue'/);
  assert.match(client, /const submit = button\(submitLabel, submitStyle/);
  assert.doesNotMatch(client, /Update report|workspace-analyze|workspace-confirm-check/);
});

test('active recording keeps one stop-and-fill action while report navigation remains available', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /function renderRecording\([\s\S]*task\.primary_action\.label[\s\S]*stopRecording/s);
  assert.match(client, /task\.kind === 'RECORDING'\) renderRecording\(panel, task\)/);
  assert.match(client, /createReportWorkspaceRegistry/);
  assert.match(client, /recorderWorkspace/);
  assert.match(client, /function syncCaptureNavigation\([\s\S]*node\.disabled = false/s);
  assert.match(client, /processing_session_id: state\.processingSessionId/);
});

test('shared legacy presentation helpers remain deterministic for non-workspace consumers', () => {
  const groups = groupTemplateFields([
    { id: 'work.date', label: 'Date', section: 'Job identity', displayOrder: 2, type: 'string' },
    { id: 'work.order', label: 'Work order', section: 'Job identity', displayOrder: 1, type: 'string' },
    { id: 'check.brakes.action', label: 'Brakes — action / remarks', section: 'Inspection checklist', displayOrder: 22, type: 'text' },
    { id: 'check.brakes.status', label: 'Brakes', section: 'Inspection checklist', displayOrder: 20, type: 'status' },
    { id: 'check.brakes.observation', label: 'Brakes — finding / measurement', section: 'Inspection checklist', displayOrder: 21, type: 'text' },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].rows.map((row) => row.fields[0].id), ['work.order', 'work.date']);
  assert.deepEqual(groups[1].rows[0].fields.map((field) => field.id), ['check.brakes.status', 'check.brakes.observation', 'check.brakes.action']);
  assert.equal(controlValueForField({ type: 'status' }, null), 'NOT_CHECKED');
  assert.equal(reportStatusSummary({ requiredFields: ['a'], missingFields: [], conflicts: [], needsConfirmation: [], complete: true }).stateLabel, 'Ready');
});

test('generated report is the correction workspace and keeps structured field controls inline', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  for (const type of ['SELECT_OR_PROVIDE', 'SINGLE_SELECT', 'SEMANTIC_STATE', 'NONE_OR_VALUE', 'CONFIRM_OR_REPLACE']) assert.match(client, new RegExp(type));
  assert.match(client, /function renderInlineResolution/);
  assert.match(client, /Tell us anything you know…/);
  assert.match(client, /AI draft/);
  assert.match(client, /Original words/);
  assert.match(client, /My edit/);
  assert.doesNotMatch(client, /function renderResolution/);
  assert.doesNotMatch(client, /Why is this required\?/);
  assert.match(client, /function renderReporterComposer/);
  assert.match(client, /renderReporterComposer\(panel/);
  assert.doesNotMatch(client, /Enter \$\{item\.field_id\}/u);
  assert.doesNotMatch(client, /retrieval score|chunk id|AI confidence|trace id/iu);
});

test('missing-field controls stay collapsed until the selected report row is opened', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /field\.resolution_item && isEditing\) renderInlineResolution/);
  assert.match(client, /field\.action\.label/);
  assert.doesNotMatch(client, /if \(field\.resolution_item\) renderInlineResolution/);
});

test('an opened missing-field editor can be dismissed without changing the report', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  const inlineEditor = client.slice(client.indexOf('function renderInlineResolution('), client.indexOf('function renderFieldEditor('));
  assert.match(client, /function appendFieldEditorFooter\([\s\S]*button\('Close editor'/u);
  assert.match(inlineEditor, /appendFieldEditorFooter\(editor, field\)/u);
});

test('inline editors group source and close controls as secondary actions', async () => {
  const [client, css] = await Promise.all([fs.readFile('web/template-app.js', 'utf8'), fs.readFile('web/styles.css', 'utf8')]);
  const inlineEditor = client.slice(client.indexOf('function renderInlineResolution('), client.indexOf('function renderFieldEditor('));
  const normalEditor = client.slice(client.indexOf('function renderFieldEditor('), client.indexOf('function renderField('));
  assert.match(inlineEditor, /appendFieldEditorFooter\(editor, field\)/u);
  assert.match(normalEditor, /appendFieldEditorFooter\(editor, field\)/u);
  assert.match(css, /\.field-editor-footer/u);
});

test('report fields carry missing state without repeating a missing list above the composer', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.doesNotMatch(client, /missingHint: task\.missing_hint/);
  assert.doesNotMatch(client, /textarea\.value\s*=\s*[^;]*missing_hint/);
  assert.doesNotMatch(client, /Still missing:/);
  assert.doesNotMatch(client, /Needs review:/);
});

test('report correction composer is compact on desktop and mobile', async () => {
  const [client, css] = await Promise.all([
    fs.readFile('web/template-app.js', 'utf8'),
    fs.readFile('web/styles.css', 'utf8'),
  ]);
  assert.match(client, /function renderReportReview[\s\S]*compact: true,[\s\S]*submitLabel: 'Add to report'/s);
  assert.match(css, /\.compact-composer textarea[^}]*min-height:\s*44px/s);
});

test('inline field editing offers report-owned dictation and exposes one stop action', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /recordingFieldId: null/);
  assert.match(client, /function renderFieldDictationAction/);
  assert.match(client, /Dictate edit/);
  assert.match(client, /startRecording\(field\.field_id\)/);
  assert.match(client, /Stop & fill report/);
  assert.match(client, /workspace\.recordingFieldId = fieldId/);
  assert.match(client, /workspace\.recordingFieldId === field\.field_id/);
  assert.match(client, /headers\['x-target-field-id'\] = fieldId/);
  assert.match(client, /headers\['x-target-section-id'\] = definition\?\.section/);
  assert.match(client, /headers\['x-capture-mode'\] = 'FIELD_DICTATION'/);
  assert.match(client, /renderRecording\([\s\S]*state\.recordingFieldId[\s\S]*return/s);
});

test('reversible representation controls expose the currently selected source accessibly', async () => {
  const [client, css] = await Promise.all([
    fs.readFile('web/template-app.js', 'utf8'),
    fs.readFile('web/styles.css', 'utf8'),
  ]);
  assert.match(client, /aria-pressed/);
  assert.match(client, /option\.selected/);
  assert.match(css, /\.representation-choice\.selected/);
});

test('resolution submission parses measurement text and distinguishes input failures from network failures', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /parseTechnicianFieldAnswer/);
  assert.match(client, /mutationErrorKind/);
  assert.match(client, /error\.status >= 500/);
});

test('responsive and accessibility rules provide focus and practical mobile targets', async () => {
  const css = await fs.readFile('web/styles.css', 'utf8');
  assert.match(css, /:focus-visible[^}]*outline:/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.choice-button[^}]*min-height:\s*50px/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.capture-actions \.primary[^}]*min-height:\s*46px/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.report-field-actions \.text-button[^}]*min-height:\s*44px/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.inline-field-editor button[^}]*min-height:\s*44px/s);
  assert.match(css, /\.report-section-fields\s*\{[^}]*repeat\(2,/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.report-section-fields[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.report-history-status[^}]*display:\s*block/s);
});

test('entering review brings the single next action back into view after an inline field decision', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /focusActiveTask/);
  assert.match(client, /scrollIntoView\(\{ block: 'start'/);
  assert.match(client, /querySelector\('button\.primary'\)\?\.focus/);
});

test('recoverable capture failures preserve work and expose a non-voice alternative', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /Recording saved, but transcription could not finish/);
  assert.match(client, /Type a statement or upload a recording/);
  assert.match(client, /STALE_REVISION/);
  assert.match(client, /refreshSession\(workspace\)/);
});

test('confirmed export gives the technician visible completion feedback', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /exportStatus/);
  assert.match(client, /Export downloaded\./);
  assert.match(client, /role = 'status'/);
});

test('successful evidence attachment is visibly acknowledged without becoming a report fact', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /attachmentStatus/);
  assert.match(client, /Evidence attached:/);
  assert.match(client, /workspace\.attachmentStatus = `Evidence attached:/);
});

test('the global missing-details composer stays visible after capture without another click', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /function renderReportReview\(panel,[\s\S]*renderReporterComposer\(panel,[\s\S]*submitLabel: 'Add to report'/s);
  assert.match(client, /if \(task\.kind === 'CAPTURED'\)[\s\S]*renderReporterComposer\(panel/s);
  assert.match(client, /function renderReview\(panel, task\)[\s\S]*renderReporterComposer\(panel/s);
  assert.doesNotMatch(client, /addingDetail/);
});

test('malformed audio asks for a replacement recording instead of claiming transcription can retry', async () => {
  const [client, view] = await Promise.all([
    fs.readFile('web/template-app.js', 'utf8'),
    fs.readFile('web/report-workspace-view.js', 'utf8'),
  ]);
  assert.match(client, /AUDIO_UPLOAD/);
  assert.match(client, /RETRY_AUDIO_UPLOAD/);
  assert.match(view, /Choose another recording/);
});

test('local API client reacquires its ephemeral token once after a server restart', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /response\.status === 401/);
  assert.match(client, /refreshLocalSessionToken/);
  assert.match(client, /allowReauthentication/);
});

test('field source stays secondary inside the inline editor', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  assert.match(client, /const isEditing = state\.editingField === field\.field_id/);
  const row = client.slice(client.indexOf('function renderField('), client.indexOf('function renderReportSections('));
  assert.doesNotMatch(row, /button\('Source'/);
  assert.match(client, /button\('Source details'/);
});
