import {
  bindSessionConfirmation,
  createReportSession,
  evaluateCompleteness,
  factsFromStructuredState,
  mapFactsToStructuredState,
  registerRuntimeTemplate,
} from './report-runtime.js';
import { PcmWavRecorder } from './audio-recorder.js';
import { fieldStatusPresentation, groupTemplateFields, reportStatusSummary } from './template-workspace.js';

const $ = (id) => document.getElementById(id);
const state = {
  token: '', templates: [], activeTemplate: null, session: null, facts: new Map(),
  analysisRevision: 0,
  statementArtifact: null, lastPreservedText: '', retryAudioBlob: null,
  setupDraft: null, setupSchemaSaved: false, setupContextReady: false, setupTestPassed: false,
};
const mobileNavigation = window.matchMedia('(max-width: 760px)');
let workspaceRecorder = null;
let recordingStartedAt = 0;
let recordingElapsedTimer = null;
let recordingStopTimer = null;
const workspaceBusy = new Set();

function syncMobileNavigation(open = document.querySelector('.template-sidebar').classList.contains('open')) {
  const sidebar = document.querySelector('.template-sidebar');
  const isOpen = !mobileNavigation.matches || open;
  sidebar.classList.toggle('open', mobileNavigation.matches && open);
  sidebar.inert = mobileNavigation.matches && !open;
  sidebar.setAttribute('aria-hidden', String(mobileNavigation.matches && !open));
  $('template-mobile-menu').setAttribute('aria-expanded', String(isOpen));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setWorkspaceControlsDisabled(disabled) {
  document.querySelectorAll('#workspace-fields input, #workspace-fields textarea, #workspace-fields select').forEach((control) => { control.disabled = disabled; });
  for (const id of ['workspace-statement', 'workspace-microphone', 'workspace-analyze', 'workspace-audio-upload', 'workspace-text-upload', 'workspace-retry', 'workspace-confirm-check']) $(id).disabled = disabled;
}

function setWorkspaceBusy(reason, busy) {
  if (busy) workspaceBusy.add(reason);
  else workspaceBusy.delete(reason);
  if (state.session && state.activeTemplate) renderReadiness();
}

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}), authorization: `Bearer ${state.token}` };
  let body = options.body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(pathname, { ...options, headers, body });
  const payload = await response.json();
  if (!response.ok || payload.status === 'FAIL') {
    const error = new Error(payload.data?.message || payload.error_code || `Request failed (${response.status})`);
    error.payload = payload;
    throw error;
  }
  return payload.data;
}

function setView(name) {
  const views = { reports: 'template-reports', choose: 'template-choose', workspace: 'template-workspace', templates: 'template-manager', setup: 'template-setup' };
  for (const [key, id] of Object.entries(views)) {
    const active = key === name;
    $(id).hidden = !active;
    $(id).classList.toggle('active', active);
  }
  document.querySelectorAll('[data-template-nav]').forEach((button) => button.classList.toggle('active', button.dataset.templateNav === name));
  const headings = {
    reports: ['TECHNICIAN', 'Reports'],
    choose: ['TECHNICIAN WORKSPACE', 'Choose a template'], workspace: ['FIELD REPORT', 'Report workspace'],
    templates: ['MANAGER', 'Templates'], setup: ['MANAGER', 'Template setup'],
  };
  $('template-eyebrow').textContent = headings[name][0];
  $('template-page-title').textContent = headings[name][1];
  if (name === 'reports') renderReports();
  syncMobileNavigation(false);
}

function iconFor(template) {
  if (template.domain === 'HVAC') return '❉';
  if (template.domain === 'SBS_BUS') return '▰';
  return '▥';
}

function renderCatalog(filter = '') {
  const query = filter.trim().toLowerCase();
  const container = $('template-catalog');
  container.replaceChildren();
  const matches = state.templates.filter((template) => `${template.name} ${template.description || ''}`.toLowerCase().includes(query));
  for (const template of matches) {
    const button = element('button', 'catalog-card');
    button.type = 'button';
    const icon = element('span', 'catalog-card-icon', iconFor(template));
    const title = element('strong', '', template.name);
    const description = element('p', '', template.description || 'Organization-defined maintenance report.');
    const organization = element('small', 'catalog-context', template.domain === 'HVAC' ? 'Newway' : template.domain.startsWith('SBS_') ? 'SBS Transit' : 'Organization');
    button.append(icon, title, description, organization);
    button.addEventListener('click', () => openWorkspace(template.templateId));
    container.append(button);
  }
  if (!matches.length) container.append(element('p', 'template-panel', 'No templates match this search.'));
}

function renderReports() {
  const list = $('template-report-list');
  list.replaceChildren();
  if (!state.session || !state.activeTemplate) {
    const empty = element('div', 'report-list-empty');
    empty.append(element('strong', '', 'No report in this browser session'), element('p', '', 'Start a new report to begin.'));
    list.append(empty);
    return;
  }
  const completeness = evaluateCompleteness(state.session);
  const summary = reportStatusSummary(completeness, Boolean(state.session.confirmation));
  const row = element('article', 'manager-row');
  const identity = element('div');
  identity.append(element('strong', '', state.activeTemplate.name), element('p', '', `${state.activeTemplate.domain === 'HVAC' ? 'Newway' : 'SBS Transit'} · ${summary.countLabel}`));
  row.append(identity, element('span', '', summary.stateLabel));
  const open = element('button', 'secondary', 'Open');
  open.addEventListener('click', () => setView('workspace'));
  row.append(open);
  list.append(row);
}

function renderManager() {
  const list = $('manager-template-list');
  list.replaceChildren();
  for (const template of state.templates) {
    const row = element('article', 'manager-row');
    const identity = element('div');
    identity.append(element('strong', '', template.name), element('p', '', `${template.provenance?.classification || 'user-supplied prototype'} · ${template.provenance?.official ? 'official' : 'not an official operator form'}`));
    row.append(identity, element('span', '', `Template ${template.templateVersion}`), element('span', '', `${template.schema.fields.length} fields · context ${template.contextCorpus.version}`));
    const use = element('button', 'secondary', 'Open');
    use.addEventListener('click', () => openWorkspace(template.templateId));
    row.append(use);
    list.append(row);
  }
}

function currentFacts() { return [...state.facts.values()]; }

function fieldValue(fieldId) {
  return state.session?.structuredState?.[fieldId] ?? '';
}

function updateFromFacts() {
  state.session = mapFactsToStructuredState(state.session, currentFacts());
  for (const field of state.activeTemplate.schema.fields) {
    const control = document.querySelector(`[data-schema-field="${CSS.escape(field.id)}"]`);
    if (!control || document.activeElement === control) continue;
    const value = fieldValue(field.id);
    if (field.type === 'structured') control.value = value && typeof value === 'object' ? JSON.stringify(value) : value;
    else control.value = value;
  }
  renderReadiness();
}

function setTechnicianFact(field, value) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  for (const [key, fact] of state.facts) if (fact.field === field.id) state.facts.delete(key);
  if (normalized !== '' && normalized !== 'NOT_CHECKED') state.facts.set(`manual:${field.id}`, {
    fact_id: `manual_${field.id.replace(/[^A-Za-z0-9_-]/gu, '_')}`,
    field: field.id,
    value: field.type === 'number' ? Number(normalized) : normalized,
    support_status: 'CONFIRMED_BY_TECHNICIAN',
    source: 'manual_field',
    source_refs: [`manual-field:${field.id}`],
  });
  updateFromFacts();
}

function renderSchemaField(field, { labelText = field.label, role = '' } = {}) {
  const wrapper = element('div', `schema-field${field.critical ? ' critical' : ''}${role ? ` ${role}` : ''}`);
  wrapper.dataset.fieldWrapper = field.id;
  const label = element('label');
  const controlId = `field-${field.id.replace(/[^A-Za-z0-9_-]/gu, '-')}`;
  label.htmlFor = controlId;
  label.append(document.createTextNode(labelText));
  if (field.required) label.append(element('span', 'required-mark', '*'));
  const status = element('span', 'schema-field-status');
  status.dataset.fieldStatus = field.id;
  label.append(status);

  let control;
  const allowed = field.allowedStatuses || field.allowedValues;
  if (field.type === 'status' || allowed) {
    control = element('select');
    for (const value of allowed || ['NOT_CHECKED', 'OK', 'NOT_OK', 'N/A']) {
      const option = element('option', '', value === 'NOT_CHECKED' ? 'Needs information' : value.replaceAll('_', ' '));
      option.value = value;
      control.append(option);
    }
  } else if (field.type === 'text') {
    control = element('textarea'); control.rows = 1;
  } else {
    control = element('input'); control.type = field.type === 'number' ? 'number' : 'text';
  }
  control.id = controlId;
  control.dataset.schemaField = field.id;
  control.setAttribute('aria-required', String(Boolean(field.required)));
  if (field.required && control.tagName !== 'SELECT') control.placeholder = 'Needs information';
  control.addEventListener('change', () => setTechnicianFact(field, control.value));
  const help = element('small', 'schema-field-help');
  help.dataset.fieldHelp = field.id;
  wrapper.append(label, control, help);
  return wrapper;
}

function renderFields() {
  const form = $('workspace-fields');
  form.replaceChildren();
  for (const group of groupTemplateFields(state.activeTemplate.schema.fields)) {
    const section = element('section', `field-section report-section ${group.layout}`);
    const header = element('header');
    header.append(element('h3', '', group.name));
    section.append(header);
    if (group.layout === 'compact') {
      const grid = element('div', 'field-grid compact');
      for (const row of group.rows) grid.append(renderSchemaField(row.fields[0]));
      section.append(grid);
    } else {
      const standalone = group.rows.filter((row) => row.kind === 'field');
      if (standalone.length) {
        const grid = element('div', 'field-grid compact checklist-intro');
        for (const row of standalone) grid.append(renderSchemaField(row.fields[0]));
        section.append(grid);
      }
      const table = element('div', 'checklist-table');
      const tableHead = element('div', 'checklist-head');
      for (const text of ['Item', 'Status', 'Finding', 'Action / remarks']) tableHead.append(element('span', '', text));
      table.append(tableHead);
      for (const row of group.rows.filter((candidate) => candidate.kind === 'checklist')) {
        const line = element('div', 'checklist-row');
        line.append(element('strong', 'checklist-item', row.label));
        for (const field of row.fields) {
          const role = field.id.endsWith('.status') ? 'status-cell' : field.id.endsWith('.observation') ? 'finding-cell' : 'action-cell';
          const labelText = role === 'status-cell' ? 'Status' : role === 'finding-cell' ? 'Finding' : 'Action / remarks';
          line.append(renderSchemaField(field, { labelText, role }));
        }
        table.append(line);
      }
      section.append(table);
    }
    form.append(section);
  }
}

function renderContext() {
  const corpus = state.activeTemplate.contextCorpus;
  $('workspace-context').textContent = `${corpus.id} · v${corpus.version}. Retrieval is limited to this template version. Context cannot assert job facts.`;
  const sources = $('workspace-context-sources'); sources.replaceChildren();
  for (const source of corpus.sources || []) {
    const item = element('div', 'context-source');
    const link = element('a', '', source.title || source.filename || 'Context source');
    if (source.url) { link.href = source.url; link.target = '_blank'; link.rel = 'noreferrer'; }
    item.append(link, element('p', '', source.usage || source.analysisStatus || 'Template context metadata.'));
    sources.append(item);
  }
  if (!(corpus.sources || []).length) sources.append(element('p', '', 'No context document is attached to this version.'));
}

function renderReadiness() {
  const completeness = evaluateCompleteness(state.session);
  state.session.completeness = completeness;
  const confirmed = Boolean(state.session.confirmation);
  const busy = workspaceBusy.size > 0;
  const summary = reportStatusSummary(completeness, confirmed);
  const percent = summary.required ? Math.round((summary.resolved / summary.required) * 100) : 100;
  $('readiness-meter-fill').style.width = `${percent}%`;
  $('report-required-count').textContent = summary.countLabel;
  $('report-state').textContent = busy && !confirmed ? 'Processing' : summary.stateLabel;
  $('report-state').dataset.state = busy && !confirmed ? 'PROCESSING' : summary.state;
  for (const field of state.activeTemplate.schema.fields) {
    const fieldState = state.session.fieldStates?.[field.id];
    const presentation = fieldStatusPresentation(fieldState, field);
    const wrapper = document.querySelector(`[data-field-wrapper="${CSS.escape(field.id)}"]`);
    if (!wrapper) continue;
    wrapper.classList.remove('missing', 'conflict', 'confirmation', 'supported');
    wrapper.classList.add(presentation.tone);
    const status = wrapper.querySelector(`[data-field-status="${CSS.escape(field.id)}"]`);
    const help = wrapper.querySelector(`[data-field-help="${CSS.escape(field.id)}"]`);
    if (status) status.textContent = presentation.label;
    if (help) help.textContent = presentation.detail;
  }
  $('workspace-confirm').disabled = confirmed || busy || !completeness.complete || !$('workspace-confirm-check').checked;
  renderReports();
}

function openWorkspace(templateId) {
  const template = state.templates.find((item) => item.templateId === templateId);
  if (!template) return;
  state.activeTemplate = template;
  state.session = createReportSession({ templateId, jobContext: { technicianId: 'LOCAL-TECH', technicianName: 'Local technician' } });
  state.facts = new Map();
  state.analysisRevision = 0;
  state.statementArtifact = null;
  state.lastPreservedText = '';
  state.retryAudioBlob = null;
  workspaceBusy.clear();
  $('workspace-title').textContent = template.name;
  $('workspace-description').textContent = template.description || 'Organization-defined maintenance report.';
  $('workspace-company').textContent = template.domain === 'HVAC' ? 'NEWAY' : template.domain.startsWith('SBS_') ? 'SBS TRANSIT' : 'REPORT WORKSPACE';
  $('workspace-metadata').textContent = `${template.provenance?.classification || 'user-supplied prototype'} · Template ${template.templateVersion} · Schema ${template.schema.version}`;
  $('workspace-statement').value = '';
  for (const id of ['workspace-statement', 'workspace-microphone', 'workspace-analyze', 'workspace-audio-upload', 'workspace-text-upload', 'workspace-retry']) $(id).disabled = false;
  $('workspace-input-status').textContent = '';
  $('workspace-confirm-check').checked = false;
  $('workspace-confirm-check').disabled = false;
  $('workspace-confirm-status').textContent = '';
  resetMicrophoneUi();
  renderFields(); renderContext(); updateFromFacts(); setView('workspace');
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function stopRecordingClock() {
  clearInterval(recordingElapsedTimer);
  clearTimeout(recordingStopTimer);
  recordingElapsedTimer = null;
  recordingStopTimer = null;
}

function resetMicrophoneUi() {
  stopRecordingClock();
  if (workspaceRecorder) workspaceRecorder.release().catch(() => {});
  workspaceRecorder = null;
  recordingStartedAt = 0;
  $('workspace-microphone').disabled = false;
  $('workspace-microphone').classList.remove('recording');
  $('workspace-microphone').setAttribute('aria-pressed', 'false');
  $('workspace-microphone').setAttribute('aria-label', 'Start recording');
  $('workspace-microphone-label').textContent = 'Record';
  $('workspace-recording-time').hidden = true;
}

async function preserveWorkspaceStatement(text) {
  if (text === state.lastPreservedText) return state.statementArtifact;
  const editedFrom = state.statementArtifact?.artifact_id || null;
  const result = await api('/api/transcripts/manual', { method: 'POST', body: {
    raw_text: text,
    language: 'auto',
    input_mode: editedFrom ? 'EDITED_TRANSCRIPT' : 'MANUAL_TRANSCRIPT',
    edited_from_artifact_id: editedFrom,
  } });
  state.statementArtifact = result.transcript;
  state.lastPreservedText = text;
  return result.transcript;
}

async function analyzeStatement({ preserveStatement = true } = {}) {
  const text = $('workspace-statement').value.trim();
  if (!text) { $('workspace-input-status').textContent = 'Add a technician statement first.'; return; }
  const sessionId = state.session.id;
  const revision = ++state.analysisRevision;
  setWorkspaceBusy('analysis', true);
  $('workspace-analyze').disabled = true;
  $('workspace-input-status').textContent = preserveStatement ? 'Saving evidence and updating the report…' : 'Updating the report…';
  try {
    if (preserveStatement) await preserveWorkspaceStatement(text);
    if (state.session.id !== sessionId || state.analysisRevision !== revision) return;
    if (!['SBS_BUS', 'SBS_RAIL'].includes(state.activeTemplate.domain)) {
      $('workspace-input-status').textContent = 'Statement preserved. Fill the remaining report fields directly.';
      return;
    }
    const contextId = state.activeTemplate.domain === 'SBS_BUS' ? 'SBS/BUS' : 'SBS/RAIL';
    const result = await api('/api/v2/facts/extract', { method: 'POST', body: { context_id: contextId, raw_text: text } });
    if (state.session.id !== sessionId || state.analysisRevision !== revision) return;
    for (const key of state.facts.keys()) if (key.startsWith('extracted:')) state.facts.delete(key);
    let accepted = 0;
    const allowed = state.activeTemplate.schema.fields.map((field) => field.id);
    for (const [index, fact] of (result.facts || []).entries()) {
      if (allowed.some((pattern) => pattern.endsWith('.*') ? fact.field.startsWith(pattern.slice(0, -1)) : fact.field === pattern)) {
        state.facts.set(`extracted:${revision}:${fact.field}:${index}`, fact); accepted += 1;
      }
    }
    updateFromFacts();
    $('workspace-input-status').textContent = `${accepted} supported field${accepted === 1 ? '' : 's'} updated.`;
  } catch (error) {
    if (state.session?.id === sessionId) $('workspace-input-status').textContent = `Could not update the report: ${error.message}`;
  } finally {
    if (state.session?.id === sessionId) {
      $('workspace-analyze').disabled = false;
      setWorkspaceBusy('analysis', false);
    }
  }
}

async function processWorkspaceAudio(wav, label = 'Recording') {
  const sessionId = state.session?.id;
  if (!sessionId) return;
  setWorkspaceBusy('audio', true);
  state.retryAudioBlob = wav;
  $('workspace-retry').hidden = true;
  $('workspace-input-status').textContent = 'Transcribing locally…';
  $('workspace-microphone').disabled = true;
  try {
    const audio = await api('/api/audio', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
    const transcriptResult = await api('/api/transcriptions', { method: 'POST', body: {
      audio_id: audio.audio_id, model: 'base', language: 'auto', attempt: 1,
    } });
    if (state.session?.id !== sessionId) return;
    state.statementArtifact = transcriptResult.transcript;
    state.lastPreservedText = transcriptResult.transcript.raw_text;
    $('workspace-statement').value = transcriptResult.transcript.raw_text;
    $('workspace-input-status').textContent = `${label} transcribed. Updating the report…`;
    await analyzeStatement({ preserveStatement: false });
  } catch (error) {
    if (state.session?.id === sessionId) {
      $('workspace-input-status').textContent = `Audio preserved, but transcription failed: ${error.message}`;
      $('workspace-retry').hidden = false;
    }
  } finally {
    if (state.session?.id === sessionId) {
      if (!workspaceRecorder) $('workspace-microphone').disabled = false;
      setWorkspaceBusy('audio', false);
    }
  }
}

async function startWorkspaceRecording() {
  if (workspaceRecorder || !state.session) return;
  const sessionId = state.session.id;
  setWorkspaceBusy('recording', true);
  $('workspace-microphone').disabled = true;
  $('workspace-input-status').textContent = 'Waiting for microphone permission…';
  try {
    workspaceRecorder = new PcmWavRecorder();
    await workspaceRecorder.start();
    if (state.session?.id !== sessionId) { await workspaceRecorder.release(); workspaceRecorder = null; return; }
    recordingStartedAt = Date.now();
    $('workspace-microphone').disabled = false;
    $('workspace-microphone').classList.add('recording');
    $('workspace-microphone').setAttribute('aria-pressed', 'true');
    $('workspace-microphone').setAttribute('aria-label', 'Stop recording');
    $('workspace-microphone-label').textContent = 'Stop';
    $('workspace-recording-time').hidden = false;
    $('workspace-recording-time').textContent = 'Recording 0:00';
    $('workspace-input-status').textContent = 'Recording…';
    recordingElapsedTimer = setInterval(() => {
      $('workspace-recording-time').textContent = `Recording ${formatElapsed(Date.now() - recordingStartedAt)}`;
    }, 1000);
    recordingStopTimer = setTimeout(() => { stopWorkspaceRecording(); }, 90_000);
  } catch (error) {
    workspaceRecorder = null;
    resetMicrophoneUi();
    setWorkspaceBusy('recording', false);
    $('workspace-input-status').textContent = `Could not start recording: ${error.message}`;
  }
}

async function stopWorkspaceRecording() {
  if (!workspaceRecorder) return;
  stopRecordingClock();
  const ownedRecorder = workspaceRecorder;
  workspaceRecorder = null;
  $('workspace-microphone').disabled = true;
  $('workspace-recording-time').textContent = 'Preparing recording…';
  try {
    const wav = await ownedRecorder.stop();
    resetMicrophoneUi();
    setWorkspaceBusy('recording', false);
    await processWorkspaceAudio(wav, 'Recording');
  } catch (error) {
    await ownedRecorder.release();
    resetMicrophoneUi();
    setWorkspaceBusy('recording', false);
    $('workspace-input-status').textContent = `Could not finish recording: ${error.message}`;
  }
}

async function confirmWorkspace() {
  $('workspace-confirm').disabled = true; $('workspace-confirm-status').textContent = 'Validating exact template and evidence bindings…';
  setWorkspaceControlsDisabled(true);
  try {
    const built = await api('/api/template-reports/build', { method: 'POST', body: {
      template_id: state.activeTemplate.templateId, report_session_id: state.session.id, facts: factsFromStructuredState(state.session),
    } });
    const confirmed = await api('/api/v2/reports/confirm', { method: 'POST', body: {
      draft: built.draft, validator_run_id: built.validation_receipt.validator_run_id,
      technician_id: state.session.jobContext.technicianId, technician_name: state.session.jobContext.technicianName,
    } });
    bindSessionConfirmation(state.session, confirmed.confirmation);
    $('workspace-confirm-status').textContent = 'Report confirmed. This exact version is locked.';
    renderReadiness();
  } catch (error) {
    setWorkspaceControlsDisabled(false);
    $('workspace-confirm-status').textContent = `Confirmation blocked: ${error.message}`;
    renderReadiness();
  }
}

function setSetupStep(index) {
  [...$('setup-steps').children].forEach((item, position) => {
    item.classList.toggle('done', position < index); item.classList.toggle('active', position === index);
  });
}

function addSetupField(values = {}) {
  const row = element('div', 'setup-field-row');
  const id = element('input'); id.placeholder = 'field.id'; id.value = values.id || '';
  const label = element('input'); label.placeholder = 'Field label'; label.value = values.label || '';
  const type = element('select');
  for (const value of ['string', 'text', 'number', 'status']) { const option = element('option', '', value); option.value = value; type.append(option); }
  type.value = values.type || 'string';
  const requiredLabel = element('label'); const required = element('input'); required.type = 'checkbox'; required.checked = Boolean(values.required); requiredLabel.append(required, document.createTextNode('Required'));
  row.append(id, label, type, requiredLabel); row._controls = { id, label, type, required }; $('setup-field-list').append(row);
}

function setupFields() {
  return [...document.querySelectorAll('.setup-field-row')].map((row) => ({
    id: row._controls.id.value.trim(), label: row._controls.label.value.trim(), section: 'Report fields', type: row._controls.type.value, required: row._controls.required.checked,
  })).filter((field) => field.id && field.label);
}

async function uploadTemplateSource() {
  const file = $('setup-source-file').files[0]; const name = $('setup-name').value.trim();
  if (!file || !name) { $('setup-analysis-status').textContent = 'Add a template name and source file.'; return; }
  $('setup-analysis-status').textContent = 'Preserving source and checking parser support…';
  try {
    const data = await api(`/api/templates/drafts/source?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
    state.setupDraft = data.draft; state.setupSchemaSaved = false; state.setupContextReady = false; state.setupTestPassed = false;
    $('setup-analysis-status').className = 'setup-status warning';
    $('setup-analysis-status').textContent = `${data.draft.analysis.status.replaceAll('_', ' ')}. Source preserved (${data.draft.source.sha256.slice(0, 12)}…). ${data.draft.analysis.undetectedReason}`;
    $('setup-schema-status').textContent = 'No fields were fabricated. Define and review the schema manually.';
    $('setup-field-list').replaceChildren(); addSetupField({ id: 'asset.id', label: 'Asset ID', required: true });
    setSetupStep(2);
  } catch (error) { $('setup-analysis-status').textContent = `Upload failed: ${error.message}`; }
}

async function saveSetupSchema() {
  if (!state.setupDraft) { $('setup-schema-status').textContent = 'Upload the source template first.'; return; }
  const fields = setupFields();
  try {
    const data = await api(`/api/templates/drafts/${encodeURIComponent(state.setupDraft.id)}/schema`, { method: 'POST', body: { fields } });
    state.setupDraft = data.draft; state.setupSchemaSaved = true;
    $('setup-schema-status').className = 'setup-status success'; $('setup-schema-status').textContent = `${fields.length} explicit fields reviewed. Positive checklist defaults remain disabled.`; setSetupStep(3);
  } catch (error) { $('setup-schema-status').textContent = `Schema review failed: ${error.message}`; }
}

async function uploadSetupContext() {
  const file = $('setup-context-file').files[0];
  if (!state.setupDraft || !file) { $('setup-context-status').textContent = 'Choose a context document after uploading the template.'; return; }
  try {
    const data = await api(`/api/templates/drafts/${encodeURIComponent(state.setupDraft.id)}/context?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
    state.setupDraft = data.draft; state.setupContextReady = data.draft.context.status === 'READY';
    $('setup-context-status').className = `setup-status ${state.setupContextReady ? 'success' : 'warning'}`;
    $('setup-context-status').textContent = state.setupContextReady ? 'Text context preserved and ready within this template version only.' : 'Artifact preserved, but content was not robustly detected. Publication remains blocked pending review.';
    setSetupStep(4);
  } catch (error) { $('setup-context-status').textContent = `Context upload failed: ${error.message}`; }
}

async function testSetup() {
  if (!state.setupDraft || !state.setupSchemaSaved || !state.setupContextReady) { $('setup-test-status').textContent = 'Complete schema review and add a ready text context document first.'; return; }
  try {
    const data = await api(`/api/templates/drafts/${encodeURIComponent(state.setupDraft.id)}/test`, { method: 'POST', body: {} });
    state.setupDraft = data.draft; state.setupTestPassed = data.draft.test.status === 'PASSED';
    $('setup-test-status').className = `setup-status ${state.setupTestPassed ? 'success' : 'warning'}`;
    $('setup-test-status').textContent = data.draft.test.notes;
    $('setup-publish').disabled = !state.setupTestPassed; setSetupStep(5);
  } catch (error) { $('setup-test-status').textContent = `Test failed: ${error.message}`; }
}

async function publishSetup() {
  try {
    const data = await api(`/api/templates/drafts/${encodeURIComponent(state.setupDraft.id)}/publish`, { method: 'POST', body: {} });
    registerRuntimeTemplate(data.template); state.templates.push(data.template); renderCatalog($('template-search').value); renderManager();
    $('setup-test-status').className = 'setup-status success'; $('setup-test-status').textContent = `Published ${data.template.name} v${data.template.templateVersion}. The source, schema, context, renderer, and adapter are now immutable.`;
    $('setup-publish').disabled = true; setSetupStep(5);
  } catch (error) { $('setup-test-status').textContent = `Publish blocked: ${error.message}`; }
}

async function init() {
  try {
    const bootstrap = await fetch('/session-bootstrap', { method: 'POST' }).then((response) => response.json());
    state.token = bootstrap.token;
    const result = await api('/api/templates');
    state.templates = result.templates;
    for (const template of state.templates) registerRuntimeTemplate(template);
    renderCatalog(); renderManager(); $('template-runtime-status').textContent = 'Local · version-bound';
  } catch (error) {
    $('template-runtime-status').textContent = 'Connection unavailable';
    $('template-catalog').append(element('p', 'template-panel', `Templates could not be loaded: ${error.message}`));
  }
}

document.querySelectorAll('[data-template-nav]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.templateNav)));
$('template-mobile-menu').addEventListener('click', () => syncMobileNavigation(!document.querySelector('.template-sidebar').classList.contains('open')));
mobileNavigation.addEventListener('change', () => syncMobileNavigation(false));
$('template-search').addEventListener('input', (event) => renderCatalog(event.target.value));
$('workspace-analyze').addEventListener('click', () => analyzeStatement());
$('workspace-microphone').addEventListener('click', () => (workspaceRecorder ? stopWorkspaceRecording() : startWorkspaceRecording()));
$('workspace-retry').addEventListener('click', () => { if (state.retryAudioBlob) processWorkspaceAudio(state.retryAudioBlob, 'Recording'); });
$('workspace-text-upload').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $('workspace-statement').value = await file.text();
  $('workspace-input-status').textContent = `${file.name} added. Updating the report…`;
  try { await analyzeStatement(); } finally { event.target.value = ''; }
});
$('workspace-audio-upload').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.wav') && file.type !== 'audio/wav') {
    $('workspace-input-status').textContent = 'Choose a WAV recording.';
    event.target.value = '';
    return;
  }
  try { await processWorkspaceAudio(file, file.name); } finally { event.target.value = ''; }
});
$('workspace-confirm-check').addEventListener('change', renderReadiness);
$('workspace-confirm').addEventListener('click', confirmWorkspace);
$('setup-add-field').addEventListener('click', () => addSetupField());
$('setup-upload').addEventListener('click', uploadTemplateSource);
$('setup-save-schema').addEventListener('click', saveSetupSchema);
$('setup-context-upload').addEventListener('click', uploadSetupContext);
$('setup-test').addEventListener('click', testSetup);
$('setup-publish').addEventListener('click', publishSetup);

syncMobileNavigation(false);
init();
