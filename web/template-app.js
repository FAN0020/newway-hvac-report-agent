import { PcmWavRecorder } from './audio-recorder.js';
import { deriveWorkspaceView } from './report-workspace-view.js';
import { registerRuntimeTemplate } from './report-runtime.js';
import { recentTechnicianTemplates, selectTechnicianTemplates } from './template-selection.js';

const $ = (id) => document.getElementById(id);
const RECENT_TEMPLATES_KEY = 'field-report.recent-template-ids';
const ACTIVE_SESSION_KEY = 'field-report.active-authoritative-session';
const mobileNavigation = window.matchMedia('(max-width: 760px)');
const state = {
  token: '', templates: [], activeTemplate: null, catalogCategory: 'All', templatesLoading: true,
  templatesError: null, recentTemplateIds: [], session: null, agentState: null, chain: null,
  transcript: null, transcriptReview: null, processing: null, recoverableError: null,
  interaction: { statement: '', microphone_available: Boolean(navigator.mediaDevices?.getUserMedia) },
  correctionDecisions: new Map(), confirmation: null, editingField: null,
  reviewFullReport: false,
  setupDraft: null, setupSchemaSaved: false, setupContextReady: false, setupTestPassed: false,
};
let recorder = null;
let recordingStartedAt = 0;
let recordingTimer = null;

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

function rememberActiveSession() {
  if (!state.session || !state.activeTemplate) return;
  try {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
      session_id: state.session.session_id,
      template_id: state.activeTemplate.templateId,
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

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}), authorization: `Bearer ${state.token}` };
  let body = options.body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    headers['content-type'] = 'application/json'; body = JSON.stringify(body);
  }
  const response = await fetch(pathname, { ...options, headers, body });
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

function setView(name) {
  const views = { reports: 'template-reports', choose: 'template-choose', workspace: 'template-workspace', templates: 'template-manager', setup: 'template-setup' };
  for (const [key, id] of Object.entries(views)) { $(id).hidden = key !== name; $(id).classList.toggle('active', key === name); }
  document.querySelectorAll('[data-template-nav]').forEach((button) => button.classList.toggle('active', button.dataset.templateNav === name));
  const headings = { reports: ['TECHNICIAN', 'Reports'], choose: ['', 'New report'], workspace: ['', 'Field Report'], templates: ['MANAGER', 'Templates'], setup: ['MANAGER', 'Template setup'] };
  $('template-eyebrow').textContent = headings[name][0]; $('template-eyebrow').hidden = !headings[name][0]; $('template-page-title').textContent = headings[name][1];
  if (name === 'reports') renderReports();
  if (name === 'choose') renderCatalog();
  syncMobileNavigation(false);
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
  if (!state.session || !state.activeTemplate) {
    const empty = element('div', 'report-list-empty'); empty.append(element('strong', '', 'No report in this browser session'), element('p', '', 'Start a new report to begin.')); list.append(empty); return;
  }
  const row = element('article', 'manager-row'); const identity = element('div');
  const complete = state.agentState?.completeness?.complete_fields?.length || 0;
  identity.append(element('strong', '', state.activeTemplate.name), element('p', '', `${complete} fields complete`));
  row.append(identity, element('span', '', state.session.phase.replaceAll('_', ' ')));
  const open = element('button', 'secondary', 'Open'); open.addEventListener('click', () => setView('workspace')); row.append(open); list.append(row);
}

function workspaceInput() {
  return {
    template: state.activeTemplate, session: state.session, agent_state: state.agentState,
    transcript: state.transcript, transcript_review: state.transcriptReview, processing: state.processing,
    recoverable_error: state.recoverableError, interaction: state.interaction, confirmation: state.confirmation,
  };
}

function currentView() { return deriveWorkspaceView(workspaceInput()); }

async function refreshSession() {
  if (!state.session) return;
  const chain = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}`);
  state.chain = chain; state.session = chain.session; state.agentState = chain.agent_state;
  state.transcript = chain.transcripts.at(-1) || state.transcript;
  state.transcriptReview = chain.transcript_reviews.at(-1) || null;
  state.confirmation = chain.confirmation || state.confirmation;
  rememberActiveSession();
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

function renderField(section, field) {
  const row = element('div', `report-field state-${field.state.toLowerCase()}`);
  const copy = element('div', 'report-field-copy'); copy.append(element('span', 'field-name', field.name));
  if (state.editingField === field.field_id) {
    const input = element('input'); input.value = field.value === '—' ? '' : field.value; input.setAttribute('aria-label', `Edit ${field.name}`);
    const actions = element('div', 'field-edit-actions');
    actions.append(button('Cancel', 'text-button', () => { state.editingField = null; renderWorkspace(); }), button('Save', 'secondary', () => saveField(field.field_id, input.value)));
    copy.append(input, actions); setTimeout(() => input.focus(), 0);
  } else {
    const value = element('strong', 'field-value', field.value); value.title = field.value; copy.append(value);
    const meta = element('div', 'field-meta');
    if (field.label !== 'Confirmed' || field.actionable) meta.append(element('span', 'field-state', field.label));
    if (field.source_label) {
      const accepted = ['KNOWN_VALUE', 'EXPLICIT_NONE', 'NOT_APPLICABLE'].includes(field.state);
      meta.append(element('span', 'field-source', `${accepted ? '✓ ' : ''}${field.source_label}`));
    }
    copy.append(meta);
  }
  const actions = element('div', 'report-field-actions');
  if (field.has_provenance) actions.append(button('Source', 'text-button', () => showProvenance(field.field_id)));
  if (state.session?.phase === 'RESOLVE') actions.append(button('Edit', 'text-button', () => { state.editingField = field.field_id; renderWorkspace(); }));
  row.append(copy, actions); return row;
}

function renderReportSections(view) {
  const container = $('workspace-sections'); container.replaceChildren();
  for (const section of view.report_sections) {
    const details = element('details', `report-section-accordion${section.needs_attention ? ' needs-attention' : ''}`);
    details.open = state.session?.phase === 'REVIEW' && state.reviewFullReport ? true : section.expanded;
    const summaryStatus = section.needs_attention
      ? `⚠ ${section.status}`
      : state.session?.phase === 'REVIEW' && section.review_priority ? `Review · ${section.status}` : '✓ Complete';
    const summary = element('summary'); summary.append(element('strong', '', section.title), element('span', '', summaryStatus));
    const reviewFocus = state.session?.phase === 'REVIEW' && !state.reviewFullReport;
    const visibleFields = reviewFocus && section.review_priority ? section.fields.filter((field) => field.review_priority) : section.fields;
    const body = element('div', 'report-section-fields'); for (const field of visibleFields) body.append(renderField(section, field)); details.append(summary, body); container.append(details);
  }
}

function renderCapture(panel, task) {
  panel.append(element('h3', '', task.title)); panel.lastChild.id = 'active-task-title';
  const composer = element('div', 'workspace-composer'); const textarea = element('textarea'); textarea.id = 'workspace-statement'; textarea.rows = 4;
  textarea.placeholder = 'Describe the issue, findings, work performed, tests, and handover.'; textarea.value = state.interaction.statement;
  textarea.addEventListener('input', () => { state.interaction.statement = textarea.value; submit.disabled = !textarea.value.trim(); });
  textarea.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && textarea.value.trim()) captureText(); });
  const mic = button(recorder ? '■ Stop' : '● Record', `composer-microphone${recorder ? ' recording' : ''}`, () => recorder ? stopRecording() : startRecording());
  mic.id = 'workspace-microphone'; mic.setAttribute('aria-label', recorder ? 'Stop recording' : 'Start recording'); mic.setAttribute('aria-pressed', String(Boolean(recorder)));
  mic.disabled = !state.interaction.microphone_available; composer.append(textarea, mic); panel.append(composer);
  const actions = element('div', 'capture-actions');
  const submit = button('Continue', 'primary', captureText); submit.id = 'workspace-capture-submit'; submit.disabled = !textarea.value.trim();
  const upload = button('Upload recording', 'secondary', () => $('workspace-audio-upload').click());
  const attach = button('Attach evidence', 'text-button', () => $('workspace-attachment-dialog').showModal());
  actions.append(submit, upload, attach); panel.append(actions);
  if (!state.interaction.microphone_available) panel.append(element('p', 'task-note', 'Microphone unavailable. Type a statement or upload a recording.'));
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

function candidateForResolution(item) {
  const field = state.agentState.report_fields.find((entry) => entry.field_id === item.field_id);
  return (field?.candidates || []).filter((candidate) => item.candidate_ids.includes(candidate.candidate_id));
}

function submitOtherAnswer(panel, item, semantic = null) {
  panel.querySelector('.compact-answer')?.remove();
  const form = element('form', 'compact-answer'); const input = element('input'); input.required = true; input.placeholder = semantic === 'SUSPECTED' ? 'Describe the suspected cause' : `Enter ${item.field_id}`;
  const submit = element('button', 'primary', 'Continue'); submit.type = 'submit'; form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const definition = state.activeTemplate.schema.fields.find((field) => field.id === item.field_id);
    const value = definition?.type === 'number' ? Number(input.value) : input.value;
    const unit = item.field_id.endsWith('_km') ? 'km' : undefined;
    answerResolution(item, semantic ? { kind: 'SEMANTIC_STATE', state: semantic, value: input.value } : { kind: 'VALUE', value, ...(unit ? { unit } : {}) });
  });
  panel.append(form); input.focus();
}

function renderResolution(panel, task) {
  const item = task.item; panel.append(element('p', 'task-counter', `${task.remaining} ${task.remaining === 1 ? 'item' : 'items'} need input`), element('h3', '', item.prompt)); panel.lastChild.id = 'active-task-title';
  const choices = element('div', 'task-choices'); const candidates = candidateForResolution(item);
  const addChoice = (label, answer, note = '') => {
    const choice = button(label, 'choice-button', () => answerResolution(item, answer)); if (note) choice.append(element('small', '', note)); choices.append(choice);
  };
  if (item.answer_type === 'SELECT_OR_PROVIDE') {
    for (const option of item.options) {
      const candidate = candidates.find((entry) => entry.candidate_id === option.candidate_id);
      addChoice(`${option.value}${option.unit ? ` ${option.unit}` : ''}`, { kind: 'SELECT_CANDIDATE', candidate_id: option.candidate_id }, sourceLabel(option.support_type, candidate?.extraction?.method));
    }
    addChoice('Enter another', { kind: 'OTHER' });
  } else if (item.answer_type === 'SINGLE_SELECT') {
    const labels = { READY: 'Returned to service', NOT_READY: 'Out of service', DEFERRED: 'Further inspection required', 'N/A': 'Not applicable' };
    for (const option of item.options.filter((entry) => entry.value !== 'NOT_CHECKED')) addChoice(labels[option.value] || String(option.label || option.value).replaceAll('_', ' '), { kind: 'VALUE', value: option.value });
  } else if (item.answer_type === 'SEMANTIC_STATE') {
    for (const option of item.options) addChoice(option.label || option.value, option.value === 'SUSPECTED' || option.value === 'CONFIRMED' ? { kind: 'SEMANTIC_OTHER', state: option.value } : { kind: 'SEMANTIC_STATE', state: option.value });
  } else if (item.answer_type === 'NONE_OR_VALUE') {
    addChoice('None', { kind: 'EXPLICIT_NONE' }); addChoice('Yes — describe', { kind: 'OTHER' });
  } else if (item.answer_type === 'CONFIRM_OR_REPLACE') {
    for (const candidate of candidates) {
      const raw = candidate.claim?.value; const value = raw && typeof raw === 'object' ? `${raw.value}${raw.unit ? ` ${raw.unit}` : ''}` : String(raw ?? '');
      addChoice(`Confirm ${value}`, { kind: 'SELECT_CANDIDATE', candidate_id: candidate.candidate_id }, sourceLabel(candidate.support_type));
    }
    addChoice('Enter correction', { kind: 'OTHER' });
  }
  if (choices.childElementCount) panel.append(choices); else submitOtherAnswer(panel, item);
  if (state.transcript?.raw_text) {
    const transcript = element('details', 'transcript-disclosure');
    transcript.append(element('summary', '', 'Initial statement captured ✓ · View transcript'), element('p', '', state.transcript.raw_text));
    panel.append(transcript);
  }
  if (item.reason) { const why = element('details', 'why-required'); why.append(element('summary', '', 'Why is this required?'), element('p', '', item.reason)); panel.append(why); }
}

function renderReview(panel) {
  panel.append(element('p', 'eyebrow', 'REVIEW'), element('h3', '', 'Review exceptions and critical details')); panel.lastChild.id = 'active-task-title';
  panel.append(element('p', 'task-note', 'Normal fields are already supported. Check the highlighted sections, edited values, and completion details below.'));
  panel.append(button('Finish review', 'primary', completeReview));
}

function renderActiveTask(view) {
  const panel = $('workspace-active-task'); panel.className = `active-task-panel task-${view.active_task.kind.toLowerCase()}`; panel.replaceChildren(); const task = view.active_task;
  if (task.kind === 'LOADING_CONTEXT') { const heading = element('h3', 'task-loading', 'Loading job…'); heading.id = 'active-task-title'; panel.append(heading); return; }
  if (task.kind === 'CAPTURE') { renderCapture(panel, task); return; }
  if (task.kind === 'CORRECTION') { renderCorrection(panel, task); return; }
  if (task.kind === 'RESOLUTION') { renderResolution(panel, task); return; }
  if (task.kind === 'REVIEW') { renderReview(panel); return; }
  if (task.kind === 'READY') {
    panel.append(element('p', 'eyebrow', 'READY'), element('h3', '', task.title), element('p', 'task-note', 'This action confirms the exact server-approved report version.'));
    panel.children[1].id = 'active-task-title'; panel.append(button('Confirm report', 'primary', confirmReport)); return;
  }
  if (task.kind === 'CONFIRMED') {
    panel.append(element('p', 'success-kicker', '✓ Confirmed'), element('h3', '', task.title)); panel.lastChild.id = 'active-task-title'; panel.append(button('Export report', 'primary', exportReport)); return;
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
  const view = currentView(); $('workspace-title').textContent = view.job_header.title;
  $('workspace-company').textContent = state.activeTemplate.domain === 'HVAC' ? 'NEWWAY' : state.activeTemplate.domain.startsWith('SBS_') ? 'SBS TRANSIT' : 'REPORT WORKSPACE';
  $('workspace-identity').textContent = view.job_header.identity_line || 'Preparing work-order details…';
  $('report-complete-count').textContent = `${view.job_header.complete} / ${view.job_header.total} complete`;
  $('report-need-input').textContent = view.job_header.need_input ? `${view.job_header.need_input} need input` : state.session?.phase === 'READY' ? 'Ready to confirm' : state.session?.phase === 'CONFIRMED' ? 'Confirmed' : 'No blocking questions';
  renderActiveTask(view); renderReportSections(view);
  $('workspace-full-report').textContent = state.session?.phase === 'REVIEW'
    ? state.reviewFullReport ? 'Show review items' : 'View full report'
    : 'Expand all';
  $('workspace-progress-detail').replaceChildren(element('p', '', view.job_header.need_input ? `${view.job_header.need_input} unresolved ${view.job_header.need_input === 1 ? 'item' : 'items'} remain.` : 'No unresolved blocking items.'));
}

async function openWorkspace(templateId) {
  const template = state.templates.find((item) => item.templateId === templateId && item.status === 'PUBLISHED' && item.presentation?.technicianVisible !== false); if (!template) return;
  recordRecentTemplate(templateId); state.activeTemplate = template; state.session = null; state.agentState = null; state.chain = null; state.transcript = null; state.transcriptReview = null; state.confirmation = null; state.recoverableError = null; state.interaction.statement = '';
  state.reviewFullReport = false;
  $('template-reports-nav').hidden = false; setView('workspace'); renderWorkspace();
  try {
    const jobRef = template.templateId === 'bus-defect-rectification-corrective-maintenance' ? 'work-order:WO-111-1222' : `new-report:${crypto.randomUUID()}`;
    const created = await api('/api/report-sessions', { method: 'POST', body: { template_id: template.templateId, template_version: template.templateVersion, job_context_ref: jobRef } });
    state.session = created.session; state.agentState = created.agent_state; rememberActiveSession(); await refreshSession(); renderWorkspace();
  } catch (error) { state.recoverableError = { kind: 'NETWORK', message: `Could not start this report. ${error.message}`, retry_action: 'RETRY_CONNECTION' }; renderWorkspace(); }
}

function setProcessing(value) { state.processing = value; renderWorkspace(); }

async function captureText() {
  const text = state.interaction.statement.trim(); if (!text || !state.session) return;
  setProcessing('EXTRACTING');
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/capture/text`, { method: 'POST', body: { expected_revision: state.session.revision, text, language: 'auto', idempotency_key: crypto.randomUUID() } });
    state.session = result.session; state.agentState = result.agent_state || state.agentState; state.transcript = result.transcript || null; state.transcriptReview = result.review || null; state.interaction.statement = ''; setProcessing('CHECKING_COMPLETENESS');
    await refreshSession(); await enterReviewIfComplete();
  } catch (error) { handleMutationError(error, 'NETWORK', 'Your statement is still in the text box.'); }
  finally { state.processing = null; renderWorkspace(); }
}

async function enterReviewIfComplete() {
  if (state.session?.phase !== 'RESOLVE' || !state.agentState?.completeness.complete || state.agentState.resolution_queue.length) return;
  const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/review`, { method: 'POST', body: { expected_revision: state.session.revision } }); state.session = result.session; state.agentState = result.agent_state;
}

function handleMutationError(error, kind = 'NETWORK', fallback = 'Your saved work is still available.') {
  if (error.code === 'STALE_REVISION') { state.recoverableError = { kind: 'STALE_REVISION', message: 'This report changed elsewhere. Refresh to continue.', retry_action: 'REFRESH_SESSION' }; return; }
  const message = kind === 'NETWORK' ? 'Connection interrupted. Try again when your connection returns.' : error.message || fallback;
  state.recoverableError = { kind, message, retry_action: kind === 'UPLOAD' ? 'RETRY_ATTACHMENT' : kind === 'STT' ? 'RETRY_TRANSCRIPTION' : 'RETRY_CONNECTION' };
}

async function decideCorrection(reviewItemId, decision) {
  state.correctionDecisions.set(reviewItemId, decision); const review = state.transcriptReview;
  const pending = review.items.filter((item) => !state.correctionDecisions.has(item.review_item_id));
  if (pending.length) { renderWorkspace(); return; }
  setProcessing('EXTRACTING');
  try {
    const decisions = review.items.map((item) => ({ review_item_id: item.review_item_id, decision: state.correctionDecisions.get(item.review_item_id) }));
    const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/transcript-reviews/${encodeURIComponent(review.review_id)}/decide`, { method: 'POST', body: { expected_revision: state.session.revision, decisions } });
    state.session = result.session; state.agentState = result.agent_state; state.transcriptReview = result.review; state.correctionDecisions.clear(); await refreshSession(); await enterReviewIfComplete();
  } catch (error) { handleMutationError(error); }
  finally { state.processing = null; renderWorkspace(); }
}

async function answerResolution(item, answer) {
  if (answer.kind === 'OTHER') { submitOtherAnswer($('workspace-active-task'), item); return; }
  if (answer.kind === 'SEMANTIC_OTHER') { submitOtherAnswer($('workspace-active-task'), item, answer.state); return; }
  setProcessing('CHECKING_COMPLETENESS');
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/resolution-items/${encodeURIComponent(item.resolution_id)}/answer`, { method: 'POST', body: { expected_revision: state.session.revision, answer, idempotency_key: crypto.randomUUID() } });
    state.session = result.session; state.agentState = result.agent_state; await refreshSession(); await enterReviewIfComplete();
  } catch (error) { handleMutationError(error); }
  finally { state.processing = null; renderWorkspace(); }
}

async function saveField(fieldId, value) {
  try {
    const definition = state.activeTemplate.schema.fields.find((field) => field.id === fieldId);
    const normalized = definition?.type === 'number' && value !== '' ? Number(value) : value;
    const unit = fieldId.endsWith('_km') ? 'km' : undefined;
    const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/fields/${encodeURIComponent(fieldId)}/answer`, { method: 'POST', body: { expected_revision: state.session.revision, value: normalized, ...(unit ? { unit } : {}) } });
    state.session = result.session; state.agentState = result.agent_state; state.editingField = null; await refreshSession(); await enterReviewIfComplete(); renderWorkspace();
  } catch (error) { handleMutationError(error); renderWorkspace(); }
}

function formatElapsed() { const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

async function startRecording() {
  if (!state.interaction.microphone_available || recorder) return;
  try { recorder = new PcmWavRecorder(); await recorder.start(); recordingStartedAt = Date.now(); setProcessing('RECORDING'); recordingTimer = setInterval(() => { const title = $('active-task-title'); if (title) title.textContent = `Recording ${formatElapsed()}`; }, 1000); }
  catch (error) { recorder = null; state.interaction.microphone_available = false; state.processing = null; state.recoverableError = { kind: 'MICROPHONE', message: 'Microphone permission is unavailable. Type a statement or upload a recording.', retry_action: 'RETRY_CONNECTION' }; renderWorkspace(); }
}

async function stopRecording() {
  if (!recorder) return; clearInterval(recordingTimer); const owned = recorder; recorder = null; setProcessing('PREPARING_AUDIO');
  try { const wav = await owned.stop(); await uploadAudio(wav); } catch (error) { await owned.release(); handleMutationError(error, 'STT'); }
  finally { state.processing = null; renderWorkspace(); }
}

async function uploadAudio(blob) {
  setProcessing('UPLOADING_AUDIO');
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/capture/audio`, { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-expected-revision': String(state.session.revision), 'idempotency-key': crypto.randomUUID(), 'x-stt-language': 'auto' }, body: blob });
    state.session = result.session; state.agentState = result.agent_state || state.agentState; state.transcript = result.transcript; state.transcriptReview = result.review;
    if (result.failure) state.recoverableError = { kind: 'STT', message: 'Recording saved, but transcription could not finish.', retry_action: 'RETRY_TRANSCRIPTION', evidence_id: result.evidence.evidence_id };
    else { await refreshSession(); await enterReviewIfComplete(); }
  } catch (error) { handleMutationError(error, 'STT'); }
}

async function retryActiveTask() {
  const error = state.recoverableError; state.recoverableError = null;
  try {
    if (error.kind === 'NETWORK' && state.interaction.statement.trim()) { await captureText(); return; }
    if (error.kind === 'STALE_REVISION' || error.kind === 'NETWORK' || error.kind === 'MICROPHONE') await refreshSession();
    else if (error.kind === 'STT' && error.evidence_id) {
      const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/transcription/retry`, { method: 'POST', body: { expected_revision: state.session.revision, evidence_id: error.evidence_id } }); state.session = result.session; state.agentState = result.agent_state; state.transcript = result.transcript; state.transcriptReview = result.review;
    }
  } catch (retryError) { handleMutationError(retryError, error.kind); }
  renderWorkspace();
  if (error.kind === 'UPLOAD' && !state.recoverableError) $('workspace-attachment-dialog').showModal();
  if (error.kind === 'STT' && !error.evidence_id && !state.recoverableError) $('workspace-audio-upload').click();
}

async function completeReview() {
  try { const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/review/complete`, { method: 'POST', body: { expected_revision: state.session.revision } }); state.session = result.session; state.agentState = result.agent_state; renderWorkspace(); }
  catch (error) { handleMutationError(error); renderWorkspace(); }
}

async function confirmReport() {
  if (state.session.phase !== 'READY') return;
  setProcessing('CHECKING_COMPLETENESS');
  try {
    const confirmed = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/confirm`, { method: 'POST', body: { expected_revision: state.session.revision } });
    state.confirmation = confirmed.confirmation; state.session = confirmed.session; state.agentState = confirmed.agent_state; rememberActiveSession();
  } catch (error) { handleMutationError(error); }
  finally { state.processing = null; renderWorkspace(); }
}

async function exportReport() {
  if (state.session?.phase !== 'CONFIRMED') { state.recoverableError = { kind: 'NETWORK', message: 'Reopen the confirmed report package before exporting.', retry_action: 'REFRESH_SESSION' }; renderWorkspace(); return; }
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/export`, { method: 'POST', body: { expected_revision: state.session.revision } });
    const text = result.export_text || result.text || JSON.stringify(result, null, 2); const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); const link = element('a'); link.href = url; link.download = `${state.activeTemplate.templateId}.txt`; link.click(); URL.revokeObjectURL(url);
  } catch (error) { handleMutationError(error); renderWorkspace(); }
}

async function attachEvidence(file, purpose) {
  try {
    const result = await api(`/api/report-sessions/${encodeURIComponent(state.session.session_id)}/attachments`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': file.name, 'x-attachment-purpose': purpose, 'x-expected-revision': String(state.session.revision) }, body: file });
    state.session = result.session; state.agentState = result.agent_state; await refreshSession(); renderWorkspace();
  } catch (error) { handleMutationError(error, 'UPLOAD'); renderWorkspace(); }
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
    const bootstrap = await fetch('/session-bootstrap', { method: 'POST' }).then((response) => response.json()); state.token = bootstrap.token;
    const result = await api('/api/templates'); state.templates = result.templates; for (const template of state.templates) registerRuntimeTemplate(template);
    state.templatesLoading = false; renderCatalog(); renderManager(); $('template-runtime-status').textContent = 'Local';
    const saved = savedActiveSession();
    const template = saved && state.templates.find((item) => item.templateId === saved.template_id);
    if (saved && template) {
      state.activeTemplate = template; state.session = { session_id: saved.session_id }; $('template-reports-nav').hidden = false;
      try { await refreshSession(); setView('workspace'); renderWorkspace(); }
      catch { sessionStorage.removeItem(ACTIVE_SESSION_KEY); state.session = null; state.activeTemplate = null; }
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
  if (state.session?.phase === 'REVIEW') { state.reviewFullReport = !state.reviewFullReport; renderWorkspace(); return; }
  const sections = [...document.querySelectorAll('.report-section-accordion')]; const expand = sections.some((section) => !section.open);
  sections.forEach((section) => { section.open = expand; }); $('workspace-full-report').textContent = expand ? 'Collapse all' : 'Expand all';
});
$('workspace-evidence-close').addEventListener('click', () => $('workspace-evidence-dialog').close());
$('workspace-attachment-choose').addEventListener('click', (event) => { event.preventDefault(); $('workspace-attachment-dialog').close(); $('workspace-evidence-upload').click(); });
$('workspace-evidence-upload').addEventListener('change', async (event) => { const file = event.target.files[0]; if (file) await attachEvidence(file, $('workspace-attachment-purpose').value); event.target.value = ''; });
$('workspace-audio-upload').addEventListener('change', async (event) => { const file = event.target.files[0]; if (file) await uploadAudio(file); event.target.value = ''; state.processing = null; renderWorkspace(); });
$('setup-add-field').addEventListener('click', () => addSetupField()); $('setup-upload').addEventListener('click', uploadTemplateSource); $('setup-save-schema').addEventListener('click', saveSetupSchema); $('setup-context-upload').addEventListener('click', uploadSetupContext); $('setup-test').addEventListener('click', testSetup); $('setup-publish').addEventListener('click', publishSetup);
syncMobileNavigation(false); init();
