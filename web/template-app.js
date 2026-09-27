import { PcmWavRecorder } from './audio-recorder.js';
import { parseTechnicianFieldAnswer } from './report-input.js';
import { deriveWorkspaceView } from './report-workspace-view.js';
import { createReportWorkspaceRegistry, registerRuntimeTemplate } from './report-runtime.js';
import { recentTechnicianTemplates, selectTechnicianTemplates } from './template-selection.js';

const $ = (id) => document.getElementById(id);
const RECENT_TEMPLATES_KEY = 'field-report.recent-template-ids';
const ACTIVE_SESSION_KEY = 'field-report.active-authoritative-session';
const mobileNavigation = window.matchMedia('(max-width: 760px)');
const workspaceRegistry = createReportWorkspaceRegistry();
const state = {
  token: '', templates: [], catalogCategory: 'All', templatesLoading: true,
  templatesError: null, recentTemplateIds: [],
  setupDraft: null, setupSchemaSaved: false, setupContextReady: false, setupTestPassed: false,
};
let recorder = null;
let recorderWorkspace = null;
let recordingStartedAt = 0;
let recordingTimer = null;

function createWorkspace(template, key = `pending:${crypto.randomUUID()}`) {
  return {
    key,
    activeTemplate: template,
    session: null,
    agentState: null,
    chain: null,
    transcript: null,
    transcriptReview: null,
    processing: null,
    processingSessionId: null,
    recoverableError: null,
    interaction: { statement: '', microphone_available: Boolean(navigator.mediaDevices?.getUserMedia) },
    correctionDecisions: new Map(),
    confirmation: null,
    exportStatus: '',
    attachmentStatus: '',
    editingField: null,
    reviewFullReport: false,
    addingDetail: false,
    focusActiveTask: false,
    recordingFieldId: null,
  };
}

function activeWorkspace() { return workspaceRegistry.active(); }

for (const property of [
  'activeTemplate', 'session', 'agentState', 'chain', 'transcript', 'transcriptReview', 'processing',
  'processingSessionId', 'recoverableError', 'interaction', 'correctionDecisions', 'confirmation',
  'exportStatus', 'attachmentStatus', 'editingField', 'reviewFullReport',
  'addingDetail', 'focusActiveTask', 'recordingFieldId',
]) {
  Object.defineProperty(state, property, {
    get() { return activeWorkspace()?.[property] ?? null; },
    set(value) {
      const workspace = activeWorkspace();
      if (!workspace) throw new Error(`Cannot set ${property} without an active report workspace.`);
      workspace[property] = value;
    },
  });
}

function activateWorkspace(workspace) {
  workspaceRegistry.activate(workspace.key);
  rememberActiveSession(workspace);
  $('template-reports-nav').hidden = false;
  setView('workspace');
  renderWorkspace();
}

function renderWorkspaceIfActive(workspace) {
  if (activeWorkspace() === workspace) renderWorkspace();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function loadRecentTemplateIds() {
  try { return JSON.parse(sessionStorage.getItem(RECENT_TEMPLATES_KEY) || '[]').filter((item) => typeof item === 'string').slice(0, 3); }
  catch { return []; }
}

function recordRecentTemplate(templateId) {
  state.recentTemplateIds = [templateId, ...state.recentTemplateIds.filter((id) => id !== templateId)].slice(0, 3);
  try { sessionStorage.setItem(RECENT_TEMPLATES_KEY, JSON.stringify(state.recentTemplateIds)); } catch { /* memory fallback */ }
}

function rememberActiveSession(workspace = activeWorkspace()) {
  if (!workspace?.session || !workspace.activeTemplate) return;
  try {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
      session_id: workspace.session.session_id,
      template_id: workspace.activeTemplate.templateId,
    }));
  } catch { /* memory fallback */ }
}

function savedActiveSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(ACTIVE_SESSION_KEY) || 'null');
    return value?.session_id && value?.template_id ? value : null;
  } catch { return null; }
}
state.recentTemplateIds = loadRecentTemplateIds();

async function refreshLocalSessionToken() {
  const response = await fetch('/session-bootstrap', { method: 'POST' });
  const payload = await response.json();
  if (!response.ok || !payload.token) throw new Error(payload.data?.message || 'Local session could not be refreshed.');
  state.token = payload.token;
  return state.token;
}

async function api(pathname, options = {}, allowReauthentication = true) {
  const headers = { ...(options.headers || {}), authorization: `Bearer ${state.token}` };
  let body = options.body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    headers['content-type'] = 'application/json'; body = JSON.stringify(body);
  }
  const response = await fetch(pathname, { ...options, headers, body });
  if (response.status === 401 && allowReauthentication) {
    await refreshLocalSessionToken();
    return api(pathname, options, false);
  }
  const payload = await response.json();
  if (!response.ok || payload.status === 'FAIL') {
    const error = new Error(payload.data?.message || payload.error_code || `Request failed (${response.status})`);
    error.code = payload.error_code; error.status = response.status; error.payload = payload; throw error;
  }
  return payload.data;
}

function syncMobileNavigation(open = document.querySelector('.template-sidebar').classList.contains('open')) {
  const sidebar = document.querySelector('.template-sidebar');
  sidebar.classList.toggle('open', mobileNavigation.matches && open);
  sidebar.inert = mobileNavigation.matches && !open;
  sidebar.setAttribute('aria-hidden', String(mobileNavigation.matches && !open));
  $('template-mobile-menu').setAttribute('aria-expanded', String(!mobileNavigation.matches || open));
}

function syncCaptureNavigation() {
  document.querySelectorAll('[data-template-nav]').forEach((node) => {
    node.disabled = false;
    node.title = '';
  });
}

function setView(name) {
  const views = { reports: 'template-reports', choose: 'template-choose', workspace: 'template-workspace', templates: 'template-manager', setup: 'template-setup' };
  for (const [key, id] of Object.entries(views)) { $(id).hidden = key !== name; $(id).classList.toggle('active', key === name); }
  document.querySelectorAll('[data-template-nav]').forEach((button) => button.classList.toggle('active', button.dataset.templateNav === name));
  const headings = { reports: ['TECHNICIAN', 'Reports'], choose: ['', 'New report'], workspace: ['', 'Field Report'], templates: ['MANAGER', 'Templates'], setup: ['MANAGER', 'Template setup'] };
  $('template-eyebrow').textContent = headings[name][0]; $('template-eyebrow').hidden = !headings[name][0]; $('template-page-title').textContent = headings[name][1];
  if (name === 'reports') renderReports();
  if (name === 'choose') renderCatalog();
  syncMobileNavigation(false);
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  return true;
}

function catalogButton(template) {
  const button = element('button', 'catalog-card'); button.type = 'button';
  button.append(element('span', 'catalog-category', template.category));
  const copy = element('span', 'catalog-card-copy');
  copy.append(element('strong', '', template.displayName), element('span', 'catalog-description', template.description), element('small', 'catalog-context', `${template.organizationLabel} · ${template.reportFamily}`));
  button.append(copy, element('span', 'catalog-arrow', '→'));
  button.addEventListener('click', () => openWorkspace(template.templateId)); return button;
}

function renderCatalog(filter = $('template-search').value) {
  const query = filter.trim(); const container = $('template-catalog'); container.replaceChildren(); $('template-recent').hidden = true;
  if (state.templatesLoading) { $('template-catalog-count').textContent = 'Loading…'; container.append(element('div', 'catalog-state', 'Loading reports…')); return; }
  if (state.templatesError) {
    $('template-catalog-count').textContent = 'Unavailable'; const box = element('div', 'catalog-state');
    box.append(element('strong', '', 'Reports are unavailable'), element('p', '', state.templatesError));
    const retry = element('button', 'secondary', 'Try again'); retry.addEventListener('click', init); box.append(retry); container.append(box); return;
  }
  const available = selectTechnicianTemplates(state.templates);
  const matches = selectTechnicianTemplates(state.templates, { query, category: state.catalogCategory });
  $('template-catalog-title').textContent = query ? 'Search results' : state.catalogCategory === 'All' ? 'All reports' : `${state.catalogCategory} reports`;
  $('template-catalog-count').textContent = `${matches.length} ${matches.length === 1 ? 'report' : 'reports'}`;
  if (!query && state.catalogCategory === 'All') {
    const recent = recentTechnicianTemplates(state.templates, state.recentTemplateIds);
    $('template-recent-list').replaceChildren(...recent.map(catalogButton)); $('template-recent').hidden = !recent.length;
  }
  if (!available.length) { container.append(element('div', 'catalog-state', 'No reports available')); return; }
  if (!matches.length) { container.append(element('div', 'catalog-state', 'No reports match this search.')); return; }
  container.append(...matches.map(catalogButton));
}

function renderManager() {
  const list = $('manager-template-list'); list.replaceChildren();
  for (const template of state.templates) {
    const row = element('article', 'manager-row'); const identity = element('div');
    identity.append(element('strong', '', template.name), element('p', '', `${template.provenance?.classification || 'user-supplied prototype'} · ${template.provenance?.official ? 'official' : 'not an official operator form'}`));
    row.append(identity, element('span', '', `Template ${template.templateVersion}`), element('span', '', `${template.schema.fields.length} fields · context ${template.contextCorpus.version}`));
    const use = element('button', 'secondary', 'Open'); use.addEventListener('click', () => openWorkspace(template.templateId)); row.append(use); list.append(row);
  }
}

function renderReports() {
  const list = $('template-report-list'); list.replaceChildren();
  const workspaces = workspaceRegistry.list().filter(({ workspace }) => workspace.session || workspace.activeTemplate);
  if (!workspaces.length) {
    const empty = element('div', 'report-list-empty'); empty.append(element('strong', '', 'No report in this browser session'), element('p', '', 'Start a new report to begin.')); list.append(empty); return;
  }
  for (const { workspace } of workspaces) {
    const row = element('article', 'manager-row'); const identity = element('div');
    const complete = workspace.agentState?.completeness?.complete_fields?.length || 0;
    const runtimeStatus = workspace === recorderWorkspace ? 'RECORDING' : workspace.processing || workspace.session?.phase || 'LOADING';
    identity.append(element('strong', '', workspace.activeTemplate.name), element('p', '', `${complete} fields complete`));
    row.append(identity, element('span', '', runtimeStatus.replaceAll('_', ' ')));
    const open = element('button', 'secondary', 'Open'); open.addEventListener('click', async () => {
      await refreshSession(workspace);
      activateWorkspace(workspace);
    }); row.append(open); list.append(row);
  }
}

function workspaceInput() {
  return {
    template: state.activeTemplate, session: state.session, agent_state: state.agentState,
    chain: state.chain,
    transcript: state.transcript, transcript_review: state.transcriptReview, processing: state.processing,
    processing_session_id: state.processingSessionId,
    recoverable_error: state.recoverableError, interaction: state.interaction, confirmation: state.confirmation,
  };
}

function currentView() { return deriveWorkspaceView(workspaceInput()); }

async function refreshSession(workspace = activeWorkspace()) {
  if (!workspace?.session) return;
  const sessionId = workspace.session.session_id;
  const chain = await api(`/api/report-sessions/${encodeURIComponent(sessionId)}`);
  if (workspace.session?.session_id !== sessionId) return;
  if ((workspace.session.revision || 0) > (chain.session.revision || 0)) return;
  workspace.chain = chain; workspace.session = chain.session; workspace.agentState = chain.agent_state;
  workspace.transcript = chain.transcripts.at(-1) || workspace.transcript;
  workspace.transcriptReview = chain.transcript_reviews.at(-1) || null;
  workspace.confirmation = chain.confirmation || workspace.confirmation;
  const latestAttachment = chain.evidence.filter((item) => item.evidence_type === 'DOCUMENT').at(-1);
  if (latestAttachment?.metadata?.filename) workspace.attachmentStatus = `Evidence attached: ${latestAttachment.metadata.filename}.`;
  if (activeWorkspace() === workspace) rememberActiveSession(workspace);
}

async function restoreReportWorkspaces() {
  const result = await api('/api/report-sessions');
  for (const report of result.reports || []) {
    const session = report.session;
    const template = state.templates.find((item) => (
      item.templateId === session.template_binding.template_id
      && item.templateVersion === session.template_binding.template_version
    ));
    if (!template || workspaceRegistry.get(session.session_id)) continue;
    const workspace = createWorkspace(template, session.session_id);
    workspace.session = session;
    workspace.agentState = report.agent_state;
    workspaceRegistry.register(workspace.key, workspace);
  }
  $('template-reports-nav').hidden = workspaceRegistry.list().length === 0;
}

function button(label, className, handler) {
  const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', handler); return node;
}

function sourceLabel(supportType, extractionMethod) {
  if (extractionMethod === 'deterministic-rule') return 'Technician statement';
  return ({ AUTHORITATIVE_SYSTEM_DATA: 'Work order', TRANSCRIPT_EVIDENCE: 'Technician dictation', MANUAL_TECHNICIAN_INPUT: 'Technician answer', TECHNICIAN_CONFIRMATION: 'Confirmed by technician', DOCUMENT_EVIDENCE: 'Attached evidence' })[supportType] || 'Report evidence';
}

function showProvenance(fieldId) {
  const field = state.agentState?.report_fields.find((entry) => entry.field_id === fieldId);
  const selectedIds = field?.selected_candidate_ids?.length ? field.selected_candidate_ids : field?.active_candidate_ids || [];
  const selected = new Set(selectedIds);
  const candidates = (field?.candidates || []).filter((candidate) => selected.has(candidate.candidate_id));
  const content = $('workspace-evidence-content'); content.replaceChildren();
  if (!candidates.length) content.append(element('p', '', 'No accepted source is attached to this field.'));
  for (const candidate of candidates) {
    const card = element('article', 'source-detail'); card.append(element('strong', '', sourceLabel(candidate.support_type, candidate.extraction?.method)));
    for (const reference of candidate.evidence_refs || []) {
      const span = state.chain?.evidence_spans.find((entry) => entry.span_id === reference.span_id);
      const transcript = state.chain?.transcripts.find((entry) => entry.transcript_id === reference.evidence_id);
      if (span && transcript) card.append(element('blockquote', '', `“${transcript.raw_text.slice(span.start_offset, span.end_offset)}”`));
      else {
        const evidence = state.chain?.evidence.find((entry) => entry.evidence_id === reference.evidence_id);
        card.append(element('p', '', evidence?.metadata?.record_id || evidence?.metadata?.filename || 'Saved evidence'));
      }
    }
    content.append(card);
  }
  $('workspace-evidence-dialog').showModal();
}

function representationChoice(option, onSelect) {
  const choice = button(option.value, 'representation-choice', onSelect);
  choice.setAttribute('aria-pressed', String(Boolean(option.selected)));
  choice.classList.toggle('selected', Boolean(option.selected));
  const detail = [option.selected ? 'Selected' : null, option.source_label].filter(Boolean).join(' · ');
  if (detail) choice.append(element('small', '', detail));
  return choice;
}

function renderFieldDictationAction(container, field) {
  const workspace = activeWorkspace();
  const actions = element('div', 'field-dictation-actions');
  const recordingThisField = recorderWorkspace === workspace
    && workspace.recordingFieldId === field.field_id
    && workspace.processing === 'RECORDING';
  if (recordingThisField) {
    const status = element('span', 'recording-time inline-field-recording-time', `Recording ${formatElapsed()}`);
    status.role = 'status'; status.setAttribute('aria-live', 'polite');
    const stop = button('Stop & fill report', 'primary', stopRecording);
    stop.id = 'workspace-stop-recording';
    stop.setAttribute('aria-label', `Stop recording for ${field.name} and fill report`);
    actions.append(status, stop);
  } else {
    const microphoneInUse = Boolean(recorder);
    const dictate = button('● Dictate edit', 'secondary', () => startRecording(field.field_id));
    dictate.disabled = !workspace.interaction.microphone_available || microphoneInUse;
    dictate.setAttribute('aria-label', microphoneInUse
      ? 'Microphone is in use by another report field'
      : `Dictate a replacement for ${field.name}`);
    actions.append(dictate);
  }
  container.append(actions);
}

function renderManualFieldEditor(container, field, { label = 'My edit', placeholder = '' } = {}) {
  const group = element('div', 'field-representation-group');
  group.append(element('span', 'representation-label', label));
  const row = element('div', 'manual-field-entry');
  const input = element('input'); input.value = field.value === '—' ? '' : field.value;
  input.placeholder = placeholder || `Enter ${field.name.toLowerCase()}`;
  input.setAttribute('aria-label', `${label} for ${field.name}`);
  const save = button('Save', 'secondary', () => saveField(field.field_id, input.value));
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && input.value.trim()) save.click(); });
  row.append(input, save); group.append(row); renderFieldDictationAction(group, field); container.append(group);
}

function renderSemanticCauseEditor(container, field) {
  const group = element('div', 'field-representation-group');
  group.append(element('span', 'representation-label', 'Describe the cause if known'));
  const input = element('input'); input.placeholder = 'Cause observed or suspected'; input.setAttribute('aria-label', `Cause for ${field.name}`);
  const actions = element('div', 'semantic-cause-actions');
  const suspected = button('Save as suspected', 'secondary', () => {
    if (input.value.trim()) selectFieldRepresentation(field.field_id, { kind: 'SEMANTIC_STATE', state: 'SUSPECTED', value: input.value.trim() });
  });
  const confirmed = button('Save as confirmed', 'secondary', () => {
    if (input.value.trim()) selectFieldRepresentation(field.field_id, { kind: 'SEMANTIC_STATE', state: 'CONFIRMED', value: input.value.trim() });
  });
  actions.append(suspected, confirmed); group.append(input, actions); renderFieldDictationAction(group, field); container.append(group);
}

function renderRepresentationGroup(container, title, options, field) {
  if (!options?.length) return;
  const group = element('div', 'field-representation-group');
  group.append(element('span', 'representation-label', title));
  const choices = element('div', 'representation-choices');
  for (const option of options) {
    choices.append(representationChoice(option, () => selectFieldRepresentation(field.field_id, {
      kind: option.kind,
      candidate_id: option.candidate_id,
      ...(option.span_id ? { span_id: option.span_id } : {}),
    })));
  }
  group.append(choices); container.append(group);
}

function renderInlineResolution(container, field) {
  const item = field.resolution_item;
  if (!item) return;
  const editor = element('div', 'inline-field-editor unresolved-field-editor');
  editor.append(element('p', 'inline-question', item.prompt));
  const choices = element('div', 'task-choices inline-choices');
  const choose = (label, selection, note = '') => {
    const choice = button(label, 'choice-button', () => selectFieldRepresentation(field.field_id, selection));
    if (note) choice.append(element('small', '', note));
    choices.append(choice);
  };
  if (item.answer_type === 'SELECT_OR_PROVIDE') {
    for (const option of item.options || []) choose(`${option.value}${option.unit ? ` ${option.unit}` : ''}`, { kind: 'CANDIDATE', candidate_id: option.candidate_id }, option.source_label || 'Report evidence');
  } else if (item.answer_type === 'SINGLE_SELECT') {
    const labels = { READY: 'Returned to service', NOT_READY: 'Out of service', DEFERRED: 'Further inspection required', 'N/A': 'Not applicable' };
    for (const option of (item.options || []).filter((entry) => entry.value !== 'NOT_CHECKED')) choose(labels[option.value] || String(option.label || option.value).replaceAll('_', ' '), { kind: 'MANUAL', value: option.value });
  } else if (item.answer_type === 'SEMANTIC_STATE') {
    for (const option of item.options || []) {
      if (!['SUSPECTED', 'CONFIRMED'].includes(option.value)) choose(option.label || option.value, { kind: 'SEMANTIC_STATE', state: option.value });
    }
  } else if (item.answer_type === 'NONE_OR_VALUE') {
    choose('None', { kind: 'EXPLICIT_NONE' });
  } else if (item.answer_type === 'CONFIRM_OR_REPLACE') {
    const options = item.options?.length ? item.options : field.representations?.drafts || [];
    for (const option of options) choose(`Use ${option.value}${option.unit ? ` ${option.unit}` : ''}`, { kind: 'CANDIDATE', candidate_id: option.candidate_id }, option.source_label || 'Report evidence');
  }
  if (choices.childElementCount) editor.append(choices);
  if (item.answer_type === 'SEMANTIC_STATE') renderSemanticCauseEditor(editor, field);
  else if (item.answer_type !== 'SINGLE_SELECT') renderManualFieldEditor(editor, field);
  container.append(editor);
}

function renderFieldEditor(container, field) {
  const editor = element('div', 'inline-field-editor');
  renderRepresentationGroup(editor, 'Report draft', field.representations?.drafts, field);
  renderRepresentationGroup(editor, 'Original words', field.representations?.original_words, field);
  renderRepresentationGroup(editor, 'My edit', field.representations?.manual, field);
  renderManualFieldEditor(editor, field);
  const cancel = button('Close editor', 'text-button', () => { state.editingField = null; renderWorkspace(); });
  editor.append(cancel); container.append(editor); setTimeout(() => editor.querySelector('input')?.focus(), 0);
}

function renderField(section, field) {
  const row = element('div', `report-field state-${field.state.toLowerCase()}`);
  const copy = element('div', 'report-field-copy'); copy.append(element('span', 'field-name', field.name));
  const isEditing = state.editingField === field.field_id;
  const value = element('strong', 'field-value', field.value); value.title = field.value; copy.append(value);
  const meta = element('div', 'field-meta');
  if (field.label !== 'Confirmed' || field.actionable) meta.append(element('span', 'field-state', field.label));
  if (field.source_label) {
    const accepted = ['KNOWN_VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE'].includes(field.state);
    meta.append(element('span', 'field-source', `${accepted ? '✓ ' : ''}${field.source_label}`));
  }
  copy.append(meta);
  const actions = element('div', 'report-field-actions');
  if (!isEditing) {
    if (field.has_provenance) actions.append(button('Source', 'text-button', () => showProvenance(field.field_id)));
    if (['RESOLVE', 'REVIEW'].includes(state.session?.phase) && !field.resolution_item) actions.append(button('Edit', 'text-button', () => { state.editingField = field.field_id; renderWorkspace(); }));
  }
  row.append(copy, actions);
  if (field.resolution_item) renderInlineResolution(row, field);
  else if (isEditing) renderFieldEditor(row, field);
  return row;
}

function renderReportSections(view) {
  const container = $('workspace-sections'); container.replaceChildren();
  for (const section of view.report_sections) {
    const details = element('details', `report-section-accordion${section.needs_attention ? ' needs-attention' : ''}`);
    const containsEditingField = section.fields.some((field) => field.field_id === state.editingField);
    details.open = containsEditingField || (state.session?.phase === 'REVIEW' && state.reviewFullReport ? true : section.expanded);
    const summaryStatus = section.needs_attention
      ? `⚠ ${section.status}`
      : state.session?.phase === 'REVIEW' && section.review_priority ? `Review · ${section.status}` : '✓ Complete';
    const summary = element('summary'); summary.append(element('strong', '', section.title), element('span', '', summaryStatus));
    const body = element('div', 'report-section-fields'); for (const field of section.fields) body.append(renderField(section, field)); details.append(summary, body); container.append(details);
  }
}

function renderReporterComposer(container, {
  inputId,
  microphoneId,
  placeholder,
  submitLabel = 'Continue',
  compact = false,
  onSubmit,
} = {}) {
  const workspace = activeWorkspace();
  const microphoneInUseElsewhere = Boolean(recorder && recorderWorkspace !== workspace);
  const wrapper = element('div', compact ? 'workspace-composer compact-composer' : 'workspace-composer');
  const textarea = element('textarea'); textarea.id = inputId; textarea.rows = compact ? 3 : 4;
  textarea.placeholder = placeholder; textarea.value = workspace.interaction.statement;
  textarea.setAttribute('aria-label', placeholder);
  const actions = element('div', 'capture-actions');
  const submit = button(submitLabel, 'primary', () => onSubmit(textarea.value.trim())); submit.disabled = !textarea.value.trim();
  textarea.addEventListener('input', () => { workspace.interaction.statement = textarea.value; submit.disabled = !textarea.value.trim(); });
  textarea.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && textarea.value.trim()) onSubmit(textarea.value.trim());
  });
  const mic = button('● Record', 'composer-microphone', () => startRecording()); mic.id = microphoneId;
  mic.setAttribute('aria-label', microphoneInUseElsewhere ? 'Microphone in use by another report' : 'Record an answer');
  mic.setAttribute('aria-pressed', 'false'); mic.disabled = !workspace.interaction.microphone_available || microphoneInUseElsewhere;
  wrapper.append(textarea, mic); actions.append(submit); container.append(wrapper, actions);
  return { textarea, submit, mic, actions, microphoneInUseElsewhere };
}

function renderCapture(panel, task) {
  const workspace = activeWorkspace();
  panel.append(element('h3', '', task.title)); panel.lastChild.id = 'active-task-title';
  const composer = renderReporterComposer(panel, {
    inputId: 'workspace-statement', microphoneId: 'workspace-microphone',
    placeholder: 'Describe the issue, findings, work performed, tests, and handover.',
    submitLabel: 'Continue', onSubmit: captureText,
  });
  composer.submit.id = 'workspace-capture-submit';
  if (!composer.microphoneInUseElsewhere) composer.mic.setAttribute('aria-label', 'Start recording');
  const upload = button('Upload recording', 'secondary', () => $('workspace-audio-upload').click());
  const attach = button('Attach evidence', 'text-button', () => $('workspace-attachment-dialog').showModal());
  composer.actions.append(upload, attach);
  if (state.attachmentStatus) { const status = element('p', 'task-note', state.attachmentStatus); status.role = 'status'; panel.append(status); }
  if (!state.interaction.microphone_available) panel.append(element('p', 'task-note', 'Microphone unavailable. Type a statement or upload a recording.'));
  else if (composer.microphoneInUseElsewhere) panel.append(element('p', 'task-note', 'The microphone is recording another report. You can continue with text here or return to that report to stop it.'));
}

function renderRecording(panel, task) {
  panel.append(element('p', 'task-counter', 'LIVE RECORDING'), element('h3', '', `Recording ${formatElapsed()}`));
  panel.children[1].id = 'active-task-title';
  if (state.recordingFieldId) {
    const definition = state.activeTemplate.schema.fields.find((field) => field.id === state.recordingFieldId);
    panel.append(element('p', 'task-note', `Recording an edit for ${definition?.label || 'this report field'}. Use the Stop & fill report action beside that field when you finish.`));
    return;
  }
  panel.append(element('p', 'task-note', 'When you finish, stop the recording to transcribe it and fill this report automatically.'));
  const stop = button(task.primary_action.label, 'primary', stopRecording);
  stop.id = 'workspace-stop-recording';
  stop.setAttribute('aria-label', 'Stop recording and fill report');
  panel.append(stop);
}

function processingTitle(kind) {
  return ({ RECORDING: 'Recording…', PREPARING_AUDIO: 'Preparing recording…', UPLOADING_AUDIO: 'Uploading recording…', TRANSCRIBING: 'Transcribing…', EXTRACTING: 'Extracting report details…', CHECKING_COMPLETENESS: 'Checking completeness…' })[kind] || 'Working…';
}

function renderCorrection(panel, task) {
  const correction = task.correction; panel.append(element('p', 'eyebrow', 'CHECK WHAT WE HEARD'), element('h3', '', 'Is this correction right?'));
  panel.lastChild.id = 'active-task-title';
  const comparison = element('div', 'correction-comparison');
  comparison.append(element('div', '', `I heard: “${correction.source_span.quote}”`), element('div', '', `Suggested: “${correction.proposed_text || correction.source_span.quote}”`)); panel.append(comparison);
  const choices = element('div', 'task-choices');
  choices.append(button('Keep original', 'choice-button', () => decideCorrection(correction.review_item_id, 'REJECT')), button('Use correction', 'choice-button', () => decideCorrection(correction.review_item_id, 'ACCEPT'))); panel.append(choices);
}

function renderReportReview(panel, task) {
  panel.append(element('p', 'eyebrow', 'REPORT DRAFT'), element('h3', '', task.title));
  panel.lastChild.id = 'active-task-title';
  panel.append(element('p', 'task-note', 'Review the report below. Missing or conflicting details are shown where they belong.'));
  if (state.addingDetail) {
    const composer = renderReporterComposer(panel, {
      inputId: 'workspace-missing-details', microphoneId: 'workspace-missing-details-microphone',
      placeholder: 'Describe any missing details in one statement.',
      submitLabel: 'Fill report', onSubmit: captureText,
    });
    composer.actions.append(button('Cancel', 'text-button', () => { state.addingDetail = false; state.interaction.statement = ''; renderWorkspace(); }));
  } else {
    panel.append(button('Fill missing details by voice or text', 'primary', () => { state.addingDetail = true; renderWorkspace(); }));
  }
  if (state.attachmentStatus) { const status = element('p', 'task-note', state.attachmentStatus); status.role = 'status'; panel.append(status); }
}

function renderReview(panel) {
  panel.append(element('p', 'eyebrow', 'REVIEW'), element('h3', '', 'Review the completed report')); panel.lastChild.id = 'active-task-title';
  panel.append(element('p', 'task-note', 'Check the report fields and their sources. You can still edit any field below before submitting this exact version.'));
  panel.append(button('Submit report', 'primary', submitReport));
}

function renderActiveTask(view) {
  const panel = $('workspace-active-task'); panel.className = `active-task-panel task-${view.active_task.kind.toLowerCase()}`; panel.replaceChildren(); const task = view.active_task;
  if (task.kind === 'LOADING_CONTEXT') { const heading = element('h3', 'task-loading', 'Loading job…'); heading.id = 'active-task-title'; panel.append(heading); return; }
  if (task.kind === 'CAPTURE') { renderCapture(panel, task); return; }
  if (task.kind === 'RECORDING') { renderRecording(panel, task); return; }
  if (task.kind === 'CORRECTION') { renderCorrection(panel, task); return; }
  if (task.kind === 'REPORT_REVIEW') { renderReportReview(panel, task); return; }
  if (task.kind === 'REVIEW') { renderReview(panel); return; }
  if (task.kind === 'READY') {
    panel.append(element('p', 'eyebrow', 'READY'), element('h3', '', task.title), element('p', 'task-note', 'Submitting confirms the exact server-approved report version.'));
    panel.children[1].id = 'active-task-title'; panel.append(button('Submit report', 'primary', submitReport)); return;
  }
  if (task.kind === 'CONFIRMED') {
    panel.append(element('p', 'success-kicker', '✓ Confirmed'), element('h3', '', task.title)); panel.lastChild.id = 'active-task-title'; panel.append(button('Export report', 'primary', exportReport));
    if (state.exportStatus) { const status = element('p', 'task-note', state.exportStatus); status.role = 'status'; panel.append(status); }
    return;
  }
  if (task.kind === 'RECOVERABLE_ERROR') {
    panel.append(element('p', 'error-kicker', 'Action needed'), element('h3', '', task.title), element('p', 'task-note', task.message)); panel.children[1].id = 'active-task-title';
    panel.append(button(task.primary_action.label, 'primary', retryActiveTask));
    if (task.error_kind === 'MICROPHONE') panel.append(button('Use text instead', 'secondary', () => { state.recoverableError = null; renderWorkspace(); }));
    return;
  }
  if (task.kind === 'CAPTURED') {
    panel.append(element('p', 'success-kicker', '✓ Captured'), element('h3', '', 'Initial statement captured')); panel.lastChild.id = 'active-task-title';
    const transcript = element('details', 'transcript-disclosure'); transcript.append(element('summary', '', 'View transcript'), element('p', '', state.transcript?.raw_text || '')); panel.append(transcript, button('Add more detail', 'primary', () => { state.transcript = null; renderWorkspace(); })); return;
  }
  panel.append(element('span', 'task-spinner'), element('h3', '', processingTitle(task.kind))); panel.lastChild.id = 'active-task-title';
}

function renderWorkspace() {
  if (!state.activeTemplate) return;
  syncCaptureNavigation();
  const view = currentView(); $('workspace-title').textContent = view.job_header.title;
  $('workspace-company').textContent = state.activeTemplate.domain === 'HVAC' ? 'NEWWAY' : state.activeTemplate.domain.startsWith('SBS_') ? 'SBS TRANSIT' : 'REPORT WORKSPACE';
  $('workspace-identity').textContent = view.job_header.identity_line || 'Preparing work-order details…';
  $('report-complete-count').textContent = `${view.job_header.complete} / ${view.job_header.total} complete`;
  $('report-need-input').textContent = view.job_header.need_input ? `${view.job_header.need_input} need input` : state.session?.phase === 'READY' ? 'Ready to confirm' : state.session?.phase === 'CONFIRMED' ? 'Confirmed' : 'No blocking questions';
  renderActiveTask(view); renderReportSections(view);
  $('workspace-full-report').textContent = view.report_sections.every((section) => section.expanded) ? 'Collapse all' : 'Expand all';
  $('workspace-progress-detail').replaceChildren(element('p', '', view.job_header.need_input ? `${view.job_header.need_input} unresolved ${view.job_header.need_input === 1 ? 'item' : 'items'} remain.` : 'No unresolved blocking items.'));
  if (state.focusActiveTask) {
    state.focusActiveTask = false;
    requestAnimationFrame(() => {
      const panel = $('workspace-active-task');
      panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      panel.querySelector('button.primary')?.focus({ preventScroll: true });
    });
  }
}

async function openWorkspace(templateId) {
  const template = state.templates.find((item) => item.templateId === templateId && item.status === 'PUBLISHED' && item.presentation?.technicianVisible !== false); if (!template) return;
  recordRecentTemplate(templateId);
  const workspace = createWorkspace(template);
  workspaceRegistry.register(workspace.key, workspace);
  activateWorkspace(workspace);
  try {
    const jobRef = template.templateId === 'bus-defect-rectification-corrective-maintenance' ? 'work-order:WO-111-1222' : `new-report:${crypto.randomUUID()}`;
    const created = await api('/api/report-sessions', { method: 'POST', body: { template_id: template.templateId, template_version: template.templateVersion, job_context_ref: jobRef } });
    const previousKey = workspace.key;
    workspace.session = created.session; workspace.agentState = created.agent_state; workspace.key = created.session.session_id;
    workspaceRegistry.rekey(previousKey, workspace.key);
    rememberActiveSession(workspace); await refreshSession(workspace); renderWorkspaceIfActive(workspace);
  } catch (error) { workspace.recoverableError = { kind: 'NETWORK', message: `Could not start this report. ${error.message}`, retry_action: 'RETRY_CONNECTION' }; renderWorkspaceIfActive(workspace); }
}

function setProcessing(value, workspace = activeWorkspace()) {
  if (!workspace) return;
  workspace.processing = value;
  workspace.processingSessionId = value ? workspace.session?.session_id || workspace.key : null;
  renderWorkspaceIfActive(workspace);
}

function clearProcessing(workspace = activeWorkspace()) {
  if (!workspace) return;
  workspace.processing = null;
  workspace.processingSessionId = null;
}

async function captureText() {
  const workspace = activeWorkspace();
  const text = workspace?.interaction.statement.trim(); if (!text || !workspace.session) return;
  setProcessing('EXTRACTING', workspace);
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/capture/text`, { method: 'POST', body: { expected_revision: workspace.session.revision, text, language: 'auto', idempotency_key: crypto.randomUUID() } });
    workspace.session = result.session; workspace.agentState = result.agent_state || workspace.agentState; workspace.transcript = result.transcript || null; workspace.transcriptReview = result.review || null; workspace.interaction.statement = ''; setProcessing('CHECKING_COMPLETENESS', workspace);
    await refreshSession(workspace); await enterReviewIfComplete(workspace); workspace.addingDetail = false;
  } catch (error) { handleMutationError(error, 'NETWORK', 'Your statement is still in the text box.', workspace); }
  finally { clearProcessing(workspace); renderWorkspaceIfActive(workspace); }
}

async function enterReviewIfComplete(workspace = activeWorkspace()) {
  if (workspace?.session?.phase !== 'RESOLVE' || !workspace.agentState?.completeness.complete || workspace.agentState.resolution_queue.length) return;
  const result = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/review`, { method: 'POST', body: { expected_revision: workspace.session.revision } });
  workspace.session = result.session; workspace.agentState = result.agent_state; workspace.focusActiveTask = true;
}

function handleMutationError(error, kind = 'NETWORK', fallback = 'Your saved work is still available.', workspace = activeWorkspace()) {
  if (!workspace) return;
  if (error.code === 'STALE_REVISION') { workspace.recoverableError = { kind: 'STALE_REVISION', message: 'This report changed elsewhere. Refresh to continue.', retry_action: 'REFRESH_SESSION' }; return; }
  const message = kind === 'NETWORK' ? 'Connection interrupted. Try again when your connection returns.' : error.message || fallback;
  workspace.recoverableError = {
    kind,
    message,
    retry_action: kind === 'UPLOAD' ? 'RETRY_ATTACHMENT'
      : kind === 'AUDIO_UPLOAD' ? 'RETRY_AUDIO_UPLOAD'
        : kind === 'STT' ? 'RETRY_TRANSCRIPTION'
          : kind === 'INPUT' ? 'RETRY_INPUT' : 'RETRY_CONNECTION',
  };
}

function mutationErrorKind(error, networkKind = 'NETWORK') {
  return !Number.isInteger(error?.status) || error.status >= 500 ? networkKind : 'INPUT';
}

async function decideCorrection(reviewItemId, decision) {
  const workspace = activeWorkspace();
  workspace.correctionDecisions.set(reviewItemId, decision); const review = workspace.transcriptReview;
  const pending = review.items.filter((item) => !workspace.correctionDecisions.has(item.review_item_id));
  if (pending.length) { renderWorkspaceIfActive(workspace); return; }
  setProcessing('EXTRACTING', workspace);
  try {
    const decisions = review.items.map((item) => ({ review_item_id: item.review_item_id, decision: workspace.correctionDecisions.get(item.review_item_id) }));
    const result = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/transcript-reviews/${encodeURIComponent(review.review_id)}/decide`, { method: 'POST', body: { expected_revision: workspace.session.revision, decisions } });
    workspace.session = result.session; workspace.agentState = result.agent_state; workspace.transcriptReview = result.review; workspace.correctionDecisions.clear(); await refreshSession(workspace); await enterReviewIfComplete(workspace);
  } catch (error) { handleMutationError(error, mutationErrorKind(error), undefined, workspace); }
  finally { clearProcessing(workspace); renderWorkspaceIfActive(workspace); }
}

async function selectFieldRepresentation(fieldId, selection) {
  const workspace = activeWorkspace();
  setProcessing('CHECKING_COMPLETENESS', workspace);
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/fields/${encodeURIComponent(fieldId)}/select`, {
      method: 'POST',
      body: { expected_revision: workspace.session.revision, selection, idempotency_key: crypto.randomUUID() },
    });
    workspace.session = result.session; workspace.agentState = result.agent_state; workspace.editingField = null;
    await refreshSession(workspace); await enterReviewIfComplete(workspace);
  } catch (error) { handleMutationError(error, mutationErrorKind(error), undefined, workspace); }
  finally { clearProcessing(workspace); renderWorkspaceIfActive(workspace); }
}

async function saveField(fieldId, value) {
  const workspace = activeWorkspace();
  try {
    const definition = workspace.activeTemplate.schema.fields.find((field) => field.id === fieldId);
    const parsed = parseTechnicianFieldAnswer({ definition, fieldId, text: value });
    await selectFieldRepresentation(fieldId, { kind: 'MANUAL', ...parsed });
  } catch (error) { handleMutationError(error, mutationErrorKind(error), undefined, workspace); renderWorkspaceIfActive(workspace); }
}

function formatElapsed() { const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

async function startRecording(fieldId = null) {
  const workspace = activeWorkspace();
  if (!workspace?.interaction.microphone_available || recorder) return;
  recorder = new PcmWavRecorder(); recorderWorkspace = workspace; workspace.recordingFieldId = fieldId;
  try {
    await recorder.start(); recordingStartedAt = Date.now(); setProcessing('RECORDING', workspace);
    recordingTimer = setInterval(() => {
      if (activeWorkspace() !== workspace) return;
      const title = $('active-task-title'); if (title) title.textContent = `Recording ${formatElapsed()}`;
      const inlineTimer = document.querySelector('.inline-field-recording-time');
      if (inlineTimer) inlineTimer.textContent = `Recording ${formatElapsed()}`;
    }, 1000);
  }
  catch (error) {
    recorder = null; recorderWorkspace = null; workspace.recordingFieldId = null; workspace.interaction.microphone_available = false; clearProcessing(workspace);
    workspace.recoverableError = { kind: 'MICROPHONE', message: 'Microphone permission is unavailable. Type a statement or upload a recording.', retry_action: 'RETRY_CONNECTION' };
    renderWorkspaceIfActive(workspace);
  }
}

async function stopRecording() {
  if (!recorder || !recorderWorkspace) return;
  clearInterval(recordingTimer); const owned = recorder; const workspace = recorderWorkspace; setProcessing('PREPARING_AUDIO', workspace);
  try {
    const wav = await owned.stop(); recorder = null; recorderWorkspace = null; workspace.recordingFieldId = null; await uploadAudio(wav, workspace);
  } catch (error) {
    await owned.release(); recorder = null; recorderWorkspace = null; workspace.recordingFieldId = null; handleMutationError(error, 'STT', undefined, workspace);
  }
  finally { workspace.recordingFieldId = null; clearProcessing(workspace); renderWorkspaceIfActive(workspace); }
}

async function uploadAudio(blob, workspace = activeWorkspace()) {
  if (!workspace?.session) return;
  setProcessing('UPLOADING_AUDIO', workspace);
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/capture/audio`, { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-expected-revision': String(workspace.session.revision), 'idempotency-key': crypto.randomUUID(), 'x-stt-language': 'auto' }, body: blob });
    workspace.session = result.session; workspace.agentState = result.agent_state || workspace.agentState; workspace.transcript = result.transcript; workspace.transcriptReview = result.review;
    if (result.failure) workspace.recoverableError = { kind: 'STT', message: 'Recording saved, but transcription could not finish.', retry_action: 'RETRY_TRANSCRIPTION', evidence_id: result.evidence.evidence_id };
    else {
      setProcessing('CHECKING_COMPLETENESS', workspace);
      await refreshSession(workspace);
      await enterReviewIfComplete(workspace);
      workspace.addingDetail = false;
    }
  } catch (error) {
    const kind = !error.status ? 'NETWORK' : error.status < 500 ? 'AUDIO_UPLOAD' : 'STT';
    handleMutationError(error, kind, undefined, workspace);
  }
  finally { clearProcessing(workspace); renderWorkspaceIfActive(workspace); }
}

async function retryActiveTask() {
  const workspace = activeWorkspace();
  const error = workspace.recoverableError; workspace.recoverableError = null;
  try {
    if (error.kind === 'NETWORK' && workspace.interaction.statement.trim()) { await captureText(); return; }
    if (error.kind === 'STALE_REVISION' || error.kind === 'NETWORK' || error.kind === 'MICROPHONE') await refreshSession(workspace);
    else if (error.kind === 'STT' && error.evidence_id) {
      const result = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/transcription/retry`, { method: 'POST', body: { expected_revision: workspace.session.revision, evidence_id: error.evidence_id } }); workspace.session = result.session; workspace.agentState = result.agent_state; workspace.transcript = result.transcript; workspace.transcriptReview = result.review;
    }
  } catch (retryError) { handleMutationError(retryError, error.kind, undefined, workspace); }
  renderWorkspaceIfActive(workspace);
  if (activeWorkspace() === workspace && error.kind === 'UPLOAD' && !workspace.recoverableError) $('workspace-attachment-dialog').showModal();
  if (activeWorkspace() === workspace && error.kind === 'AUDIO_UPLOAD' && !workspace.recoverableError) $('workspace-audio-upload').click();
  if (activeWorkspace() === workspace && error.kind === 'STT' && !error.evidence_id && !workspace.recoverableError) $('workspace-audio-upload').click();
}

async function submitReport() {
  const workspace = activeWorkspace();
  setProcessing('CHECKING_COMPLETENESS', workspace);
  try {
    if (workspace.session.phase === 'REVIEW') {
      const reviewed = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/review/complete`, {
        method: 'POST', body: { expected_revision: workspace.session.revision },
      });
      workspace.session = reviewed.session; workspace.agentState = reviewed.agent_state;
    }
    if (workspace.session.phase !== 'READY') throw new Error('The server has not approved this report version for submission.');
    const confirmed = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/confirm`, { method: 'POST', body: { expected_revision: workspace.session.revision } });
    workspace.confirmation = confirmed.confirmation; workspace.session = confirmed.session; workspace.agentState = confirmed.agent_state; rememberActiveSession(workspace);
  } catch (error) { handleMutationError(error, 'NETWORK', undefined, workspace); }
  finally { clearProcessing(workspace); renderWorkspaceIfActive(workspace); }
}

async function exportReport() {
  const workspace = activeWorkspace();
  if (workspace.session?.phase !== 'CONFIRMED') { workspace.recoverableError = { kind: 'NETWORK', message: 'Reopen the confirmed report package before exporting.', retry_action: 'REFRESH_SESSION' }; renderWorkspaceIfActive(workspace); return; }
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/export`, { method: 'POST', body: { expected_revision: workspace.session.revision } });
    if (!result.content_base64 || result.mime_type !== 'application/pdf') throw new Error('The server did not return a PDF report.');
    const binary = atob(result.content_base64); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mime_type })); const link = element('a'); link.href = url; link.download = result.filename || `${workspace.activeTemplate.templateId}.pdf`; link.click(); URL.revokeObjectURL(url);
    workspace.exportStatus = 'Export downloaded.'; renderWorkspaceIfActive(workspace);
  } catch (error) { handleMutationError(error, 'NETWORK', undefined, workspace); renderWorkspaceIfActive(workspace); }
}

async function attachEvidence(file, purpose) {
  const workspace = activeWorkspace();
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(workspace.session.session_id)}/attachments`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': file.name, 'x-attachment-purpose': purpose, 'x-expected-revision': String(workspace.session.revision) }, body: file });
    workspace.session = result.session; workspace.agentState = result.agent_state; workspace.attachmentStatus = `Evidence attached: ${file.name}.`; await refreshSession(workspace); renderWorkspaceIfActive(workspace);
  } catch (error) { handleMutationError(error, 'UPLOAD', undefined, workspace); renderWorkspaceIfActive(workspace); }
}

function setSetupStep(index) { [...$('setup-steps').children].forEach((item, position) => { item.classList.toggle('done', position < index); item.classList.toggle('active', position === index); }); }
function addSetupField(values = {}) {
  const row = element('div', 'setup-field-row'); const id = element('input'); id.placeholder = 'field.id'; id.value = values.id || ''; const label = element('input'); label.placeholder = 'Field label'; label.value = values.label || ''; const type = element('select');
  for (const value of ['string', 'text', 'number', 'status']) { const option = element('option', '', value); option.value = value; type.append(option); } type.value = values.type || 'string';
  const requiredLabel = element('label'); const required = element('input'); required.type = 'checkbox'; required.checked = Boolean(values.required); requiredLabel.append(required, document.createTextNode('Required')); row.append(id, label, type, requiredLabel); row._controls = { id, label, type, required }; $('setup-field-list').append(row);
}
function setupFields() { return [...document.querySelectorAll('.setup-field-row')].map((row) => ({ id: row._controls.id.value.trim(), label: row._controls.label.value.trim(), section: 'Report fields', type: row._controls.type.value, required: row._controls.required.checked })).filter((field) => field.id && field.label); }
async function uploadTemplateSource() {
  const file = $('setup-source-file').files[0]; const name = $('setup-name').value.trim(); if (!file || !name) { $('setup-analysis-status').textContent = 'Add a template name and source file.'; return; }
  try { const data = await api(`/api/templates/drafts/source?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }); state.setupDraft = data.draft; state.setupSchemaSaved = false; state.setupContextReady = false; state.setupTestPassed = false; $('setup-analysis-status').textContent = `${data.draft.analysis.status.replaceAll('_', ' ')}. Source preserved.`; $('setup-field-list').replaceChildren(); addSetupField({ id: 'asset.id', label: 'Asset ID', required: true }); setSetupStep(2); } catch (error) { $('setup-analysis-status').textContent = `Upload failed: ${error.message}`; }
}
async function saveSetupSchema() { if (!state.setupDraft) return; try { const fields = setupFields(); const data = await api(`/api/templates/drafts/${encodeURIComponent(state.setupDraft.id)}/schema`, { method: 'POST', body: { fields } }); state.setupDraft = data.draft; state.setupSchemaSaved = true; $('setup-schema-status').textContent = `${fields.length} explicit fields reviewed.`; setSetupStep(3); } catch (error) { $('setup-schema-status').textContent = error.message; } }
async function uploadSetupContext() { const file = $('setup-context-file').files[0]; if (!state.setupDraft || !file) return; try { const data = await api(`/api/templates/drafts/${encodeURIComponent(state.setupDraft.id)}/context?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }); state.setupDraft = data.draft; state.setupContextReady = data.draft.context.status === 'READY'; $('setup-context-status').textContent = state.setupContextReady ? 'Context preserved.' : 'Context needs review.'; setSetupStep(4); } catch (error) { $('setup-context-status').textContent = error.message; } }
async function testSetup() { if (!state.setupDraft || !state.setupSchemaSaved || !state.setupContextReady) return; try { const data = await api(`/api/templates/drafts/${encodeURIComponent(state.setupDraft.id)}/test`, { method: 'POST', body: {} }); state.setupDraft = data.draft; state.setupTestPassed = data.draft.test.status === 'PASSED'; $('setup-test-status').textContent = data.draft.test.notes; $('setup-publish').disabled = !state.setupTestPassed; setSetupStep(5); } catch (error) { $('setup-test-status').textContent = error.message; } }
async function publishSetup() { try { const data = await api(`/api/templates/drafts/${encodeURIComponent(state.setupDraft.id)}/publish`, { method: 'POST', body: {} }); registerRuntimeTemplate(data.template); state.templates.push(data.template); renderCatalog(); renderManager(); $('setup-test-status').textContent = `Published ${data.template.name} v${data.template.templateVersion}.`; $('setup-publish').disabled = true; } catch (error) { $('setup-test-status').textContent = error.message; } }

async function init() {
  state.templatesLoading = true; renderCatalog();
  try {
    await refreshLocalSessionToken();
    const result = await api('/api/templates'); state.templates = result.templates; for (const template of state.templates) registerRuntimeTemplate(template);
    state.templatesLoading = false; renderCatalog(); renderManager(); $('template-runtime-status').textContent = 'Local';
    await restoreReportWorkspaces();
    const saved = savedActiveSession();
    const workspace = saved && workspaceRegistry.get(saved.session_id);
    if (workspace) {
      workspaceRegistry.activate(workspace.key);
      try { await refreshSession(workspace); setView('workspace'); renderWorkspace(); }
      catch { sessionStorage.removeItem(ACTIVE_SESSION_KEY); }
    }
  }
  catch (error) { state.templatesLoading = false; state.templatesError = error.message; $('template-runtime-status').textContent = 'Connection unavailable'; renderCatalog(); }
}

document.querySelectorAll('[data-template-nav]').forEach((node) => node.addEventListener('click', () => setView(node.dataset.templateNav)));
$('template-mobile-menu').addEventListener('click', () => syncMobileNavigation(!document.querySelector('.template-sidebar').classList.contains('open')));
mobileNavigation.addEventListener('change', () => syncMobileNavigation(false));
$('template-search').addEventListener('input', (event) => renderCatalog(event.target.value));
document.querySelectorAll('[data-template-category]').forEach((node) => node.addEventListener('click', () => { state.catalogCategory = node.dataset.templateCategory; document.querySelectorAll('[data-template-category]').forEach((candidate) => { const active = candidate === node; candidate.classList.toggle('active', active); candidate.setAttribute('aria-pressed', String(active)); }); renderCatalog(); }));
$('workspace-progress').addEventListener('click', () => { const detail = $('workspace-progress-detail'); detail.hidden = !detail.hidden; $('workspace-progress').setAttribute('aria-expanded', String(!detail.hidden)); });
$('workspace-full-report').addEventListener('click', () => {
  const sections = [...document.querySelectorAll('.report-section-accordion')]; const expand = sections.some((section) => !section.open);
  sections.forEach((section) => { section.open = expand; }); $('workspace-full-report').textContent = expand ? 'Collapse all' : 'Expand all';
});
$('workspace-evidence-close').addEventListener('click', () => $('workspace-evidence-dialog').close());
$('workspace-attachment-choose').addEventListener('click', (event) => { event.preventDefault(); $('workspace-attachment-dialog').close(); $('workspace-evidence-upload').click(); });
$('workspace-evidence-upload').addEventListener('change', async (event) => { const file = event.target.files[0]; if (file) await attachEvidence(file, $('workspace-attachment-purpose').value); event.target.value = ''; });
$('workspace-audio-upload').addEventListener('change', async (event) => { const workspace = activeWorkspace(); const file = event.target.files[0]; if (file) await uploadAudio(file, workspace); event.target.value = ''; renderWorkspaceIfActive(workspace); });
$('setup-add-field').addEventListener('click', () => addSetupField()); $('setup-upload').addEventListener('click', uploadTemplateSource); $('setup-save-schema').addEventListener('click', saveSetupSchema); $('setup-context-upload').addEventListener('click', uploadSetupContext); $('setup-test').addEventListener('click', testSetup); $('setup-publish').addEventListener('click', publishSetup);
syncMobileNavigation(false); init();
