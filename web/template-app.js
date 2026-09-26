import {
  applyTranscriptArtifact,
  bindSessionConfirmation,
  createReportSession,
  evaluateCompleteness,
  mapFactsToStructuredState,
  registerRuntimeTemplate,
} from './report-runtime.js';
import { PcmWavRecorder } from './audio-recorder.js';
import { controlValueForField, fieldStatusPresentation, groupTemplateFields, reportStatusSummary } from './template-workspace.js';
import { recentTechnicianTemplates, selectTechnicianTemplates } from './template-selection.js';

const $ = (id) => document.getElementById(id);
const state = {
  token: '', templates: [], activeTemplate: null, session: null, facts: new Map(),
  catalogCategory: 'All', templatesLoading: true, templatesError: null, recentTemplateIds: [],
  analysisRevision: 0,
  authoritySession: null, authoritySessionPromise: null, authorityMutation: Promise.resolve(), retryEvidenceId: null,
  hvacCorrectionReview: null,
  setupDraft: null, setupSchemaSaved: false, setupContextReady: false, setupTestPassed: false,
};
const mobileNavigation = window.matchMedia('(max-width: 760px)');
let workspaceRecorder = null;
let recordingStartedAt = 0;
let recordingElapsedTimer = null;
let recordingStopTimer = null;
const workspaceBusy = new Set();
const RECENT_TEMPLATES_KEY = 'field-report.recent-template-ids';

function loadRecentTemplateIds() {
  try {
    const value = JSON.parse(sessionStorage.getItem(RECENT_TEMPLATES_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 3) : [];
  } catch { return []; }
}

function recordRecentTemplate(templateId) {
  state.recentTemplateIds = [templateId, ...state.recentTemplateIds.filter((id) => id !== templateId)].slice(0, 3);
  try { sessionStorage.setItem(RECENT_TEMPLATES_KEY, JSON.stringify(state.recentTemplateIds)); } catch { /* Recents remain session-memory only. */ }
}

state.recentTemplateIds = loadRecentTemplateIds();

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
  document.querySelectorAll('#workspace-fields button, #workspace-corrections button').forEach((control) => { control.disabled = disabled; });
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
    choose: ['', 'New report'], workspace: ['', 'Field Report'],
    templates: ['MANAGER', 'Templates'], setup: ['MANAGER', 'Template setup'],
  };
  $('template-eyebrow').textContent = headings[name][0];
  $('template-eyebrow').hidden = !headings[name][0];
  $('template-page-title').textContent = headings[name][1];
  if (name === 'reports') renderReports();
  if (name === 'choose') renderCatalog();
  syncMobileNavigation(false);
}

function catalogButton(template) {
  const button = element('button', 'catalog-card');
  button.type = 'button';
  button.dataset.templateId = template.templateId;
  const category = element('span', 'catalog-category', template.category);
  const copy = element('span', 'catalog-card-copy');
  copy.append(
    element('strong', '', template.displayName),
    element('span', 'catalog-description', template.description),
    element('small', 'catalog-context', `${template.organizationLabel} · ${template.reportFamily}`),
  );
  const arrow = element('span', 'catalog-arrow', '→');
  arrow.setAttribute('aria-hidden', 'true');
  button.append(category, copy, arrow);
  button.addEventListener('click', () => openWorkspace(template.templateId));
  return button;
}

function renderCatalog(filter = $('template-search').value) {
  const query = filter.trim();
  const container = $('template-catalog');
  container.replaceChildren();
  const count = $('template-catalog-count');
  const heading = $('template-catalog-title');
  const recentSection = $('template-recent');
  recentSection.hidden = true;

  if (state.templatesLoading) {
    count.textContent = 'Loading…';
    container.append(element('div', 'catalog-state', 'Loading reports…'));
    return;
  }
  if (state.templatesError) {
    count.textContent = 'Unavailable';
    const unavailable = element('div', 'catalog-state');
    unavailable.append(element('strong', '', 'Reports are unavailable'), element('p', '', state.templatesError));
    const retry = element('button', 'secondary', 'Try again');
    retry.type = 'button'; retry.addEventListener('click', init); unavailable.append(retry); container.append(unavailable);
    return;
  }

  const available = selectTechnicianTemplates(state.templates);
  const matches = selectTechnicianTemplates(state.templates, { query, category: state.catalogCategory });
  heading.textContent = query ? 'Search results' : state.catalogCategory === 'All' ? 'All reports' : `${state.catalogCategory} reports`;
  count.textContent = `${matches.length} ${matches.length === 1 ? 'report' : 'reports'}`;

  if (!query && state.catalogCategory === 'All') {
    const recent = recentTechnicianTemplates(state.templates, state.recentTemplateIds);
    const recentList = $('template-recent-list');
    recentList.replaceChildren(...recent.map(catalogButton));
    recentSection.hidden = recent.length === 0;
  }

  if (available.length === 0) {
    const empty = element('div', 'catalog-state');
    empty.append(element('strong', '', 'No reports available'), element('p', '', 'Ask a manager to publish a report template.'));
    container.append(empty);
    return;
  }
  if (matches.length === 0) {
    const empty = element('div', 'catalog-state');
    empty.append(element('strong', '', `No reports match${query ? ` “${query}”` : ' this filter'}.`), element('p', '', 'Try another name, organization, or report type.'));
    const clear = element('button', 'secondary', 'Clear search and filters');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      $('template-search').value = '';
      state.catalogCategory = 'All';
      document.querySelectorAll('[data-template-category]').forEach((button) => {
        const active = button.dataset.templateCategory === 'All';
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
      $('template-search').focus(); renderCatalog('');
    });
    empty.append(clear); container.append(empty); return;
  }
  container.append(...matches.map(catalogButton));
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

async function ensureAuthoritativeSession() {
  if (state.authoritySession) return state.authoritySession;
  if (!state.authoritySessionPromise) throw new Error('ReportSession is not available. Reopen this report.');
  const result = await state.authoritySessionPromise;
  if (!result?.session) throw result?.error || new Error('ReportSession could not be created.');
  state.authoritySession = result.session;
  return state.authoritySession;
}

async function mutateAuthority(operation) {
  const pending = state.authorityMutation.then(operation);
  state.authorityMutation = pending.catch(() => {});
  return pending;
}

function factFromCandidate(candidate) {
  if (!candidate || candidate.claim?.kind !== 'VALUE') return null;
  const composite = candidate.claim.value && typeof candidate.claim.value === 'object' && !Array.isArray(candidate.claim.value)
    ? candidate.claim.value
    : { value: candidate.claim.value, ...(candidate.unit ? { unit: candidate.unit } : {}) };
  return {
    fact_id: candidate.candidate_id,
    candidate_id: candidate.candidate_id,
    field: candidate.field_id,
    value: composite.value,
    ...(composite.unit ? { unit: composite.unit } : {}),
    support_status: candidate.support_type === 'TECHNICIAN_CONFIRMATION'
      ? 'CONFIRMED_BY_TECHNICIAN'
      : candidate.assessment === 'UNCERTAIN' ? 'UNCERTAIN' : 'DIRECT_TRANSCRIPT',
    source: `report-session:${candidate.session_id}`,
    source_refs: candidate.evidence_refs.map((reference) => reference.span_id
      ? `${reference.evidence_id}#${reference.span_id}`
      : reference.evidence_id),
    critical: candidate.risk_class === 'CRITICAL',
  };
}

function applyCandidateFacts(candidates, revision, { replaceAll = true } = {}) {
  if (replaceAll) clearExtractedFacts();
  let accepted = 0;
  const allowed = state.activeTemplate.schema.fields.map((field) => field.id);
  for (const [index, candidate] of (candidates || []).entries()) {
    const fact = factFromCandidate(candidate);
    if (!fact) continue;
    if (allowed.some((pattern) => pattern.endsWith('.*') ? fact.field.startsWith(pattern.slice(0, -1)) : fact.field === pattern)) {
      state.facts.set(`extracted:${revision}:${fact.field}:${index}`, fact);
      accepted += 1;
    }
  }
  updateFromFacts();
  return accepted;
}

function fieldValue(fieldId) {
  return state.session?.structuredState?.[fieldId] ?? '';
}

function updateFromFacts() {
  state.session = mapFactsToStructuredState(state.session, currentFacts());
  for (const field of state.activeTemplate.schema.fields) {
    const control = document.querySelector(`[data-schema-field="${CSS.escape(field.id)}"]`);
    if (!control || document.activeElement === control) continue;
    const value = fieldValue(field.id);
    if (field.type === 'structured') control.value = value && typeof value === 'object' ? JSON.stringify(value) : controlValueForField(field, value);
    else control.value = controlValueForField(field, value);
  }
  renderReadiness();
}

async function setTechnicianFact(field, value) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  try {
    const result = await mutateAuthority(async () => {
      const authority = await ensureAuthoritativeSession();
      const answered = await api(`/api/report-sessions/${encodeURIComponent(authority.session_id)}/fields/${encodeURIComponent(field.id)}/answer`, {
        method: 'POST',
        body: {
          expected_revision: authority.revision,
          value: field.type === 'number' && normalized !== '' ? Number(normalized) : normalized,
        },
      });
      state.authoritySession = answered.session;
      return answered;
    });
    state.authoritySession = result.session;
    for (const [key, fact] of state.facts) if (fact.field === field.id) state.facts.delete(key);
    const fact = factFromCandidate(result.candidate);
    if (fact) state.facts.set(`manual:${field.id}`, fact);
    updateFromFacts();
  } catch (error) {
    $('workspace-input-status').textContent = `Could not save ${field.label}: ${error.message}`;
    updateFromFacts();
  }
}

async function confirmTechnicianFact(field) {
  const source = [...state.facts.values()].reverse().find((fact) => fact.field === field.id && fact.candidate_id);
  if (!source) return;
  try {
    const result = await mutateAuthority(async () => {
      const authority = await ensureAuthoritativeSession();
      const confirmed = await api(`/api/report-sessions/${encodeURIComponent(authority.session_id)}/candidates/${encodeURIComponent(source.candidate_id)}/confirm`, {
        method: 'POST', body: { expected_revision: authority.revision },
      });
      state.authoritySession = confirmed.session;
      return confirmed;
    });
    state.authoritySession = result.session;
    for (const [key, fact] of state.facts) if (fact.field === field.id) state.facts.delete(key);
    state.facts.set(`confirmed:${field.id}`, factFromCandidate(result.candidate));
    updateFromFacts();
  } catch (error) {
    $('workspace-input-status').textContent = `Could not confirm ${field.label}: ${error.message}`;
  }
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
      const option = element('option', '', value === 'NOT_CHECKED' ? 'Not checked' : value.replaceAll('_', ' '));
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
  const action = element('button', 'schema-field-action text-button');
  action.type = 'button'; action.hidden = true; action.dataset.fieldAction = field.id;
  action.addEventListener('click', () => confirmTechnicianFact(field));
  wrapper.append(label, control, help, action);
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
  const pendingCorrectionReview = Boolean(state.hvacCorrectionReview);
  const summary = reportStatusSummary(completeness, confirmed);
  const percent = summary.required ? Math.round((summary.resolved / summary.required) * 100) : 100;
  $('readiness-meter-fill').style.width = `${percent}%`;
  $('report-required-count').textContent = summary.countLabel;
  $('report-state').textContent = busy && !confirmed ? 'Processing' : pendingCorrectionReview && !confirmed ? 'Needs confirmation' : summary.stateLabel;
  $('report-state').dataset.state = busy && !confirmed ? 'PROCESSING' : pendingCorrectionReview && !confirmed ? 'NEEDS_CONFIRMATION' : summary.state;
  for (const field of state.activeTemplate.schema.fields) {
    const fieldState = state.session.fieldStates?.[field.id];
    const presentation = fieldStatusPresentation(fieldState, field);
    const wrapper = document.querySelector(`[data-field-wrapper="${CSS.escape(field.id)}"]`);
    if (!wrapper) continue;
    wrapper.classList.remove('missing', 'conflict', 'confirmation', 'supported');
    wrapper.classList.add(presentation.tone);
    const status = wrapper.querySelector(`[data-field-status="${CSS.escape(field.id)}"]`);
    const help = wrapper.querySelector(`[data-field-help="${CSS.escape(field.id)}"]`);
    const action = wrapper.querySelector(`[data-field-action="${CSS.escape(field.id)}"]`);
    if (status) status.textContent = presentation.label;
    if (help) help.textContent = presentation.detail;
    if (action) {
      const needsDecision = ['confirmation', 'conflict'].includes(presentation.tone) && controlValueForField(field, fieldState?.value) !== 'NOT_CHECKED';
      action.hidden = !needsDecision;
      action.textContent = presentation.tone === 'conflict' ? 'Use shown value' : 'Confirm value';
      action.setAttribute('aria-label', `${action.textContent}: ${field.label}`);
      action.disabled = busy || confirmed;
    }
  }
  $('workspace-confirm').disabled = confirmed || busy || pendingCorrectionReview || !completeness.complete || !$('workspace-confirm-check').checked;
  renderReports();
}

function openWorkspace(templateId) {
  const template = state.templates.find((item) => item.templateId === templateId && item.status === 'PUBLISHED' && item.presentation?.technicianVisible !== false);
  if (!template) return;
  recordRecentTemplate(templateId);
  $('template-reports-nav').hidden = false;
  state.activeTemplate = template;
  state.session = createReportSession({ templateId, jobContext: { technicianId: 'LOCAL-TECH', technicianName: 'Local technician' } });
  const localSessionId = state.session.id;
  state.authoritySession = null;
  state.authorityMutation = Promise.resolve();
  state.authoritySessionPromise = api('/api/report-sessions', { method: 'POST', body: {
    template_id: template.templateId,
    template_version: template.templateVersion,
    job_context_ref: `browser-session:${localSessionId}`,
  } }).then((result) => {
    if (state.session?.id === localSessionId) state.authoritySession = result.session;
    return result;
  }).catch((error) => {
    if (state.session?.id === localSessionId) $('workspace-input-status').textContent = `Could not start the report session: ${error.message}`;
    return { session: null, error };
  });
  state.facts = new Map();
  state.analysisRevision = 0;
  state.retryEvidenceId = null;
  state.hvacCorrectionReview = null;
  workspaceBusy.clear();
  $('workspace-title').textContent = template.name;
  $('workspace-description').textContent = template.description || 'Organization-defined maintenance report.';
  $('workspace-company').textContent = template.domain === 'HVAC' ? 'NEWWAY' : template.domain.startsWith('SBS_') ? 'SBS TRANSIT' : 'REPORT WORKSPACE';
  $('workspace-metadata').textContent = `${template.provenance?.classification || 'user-supplied prototype'} · Template ${template.templateVersion} · Schema ${template.schema.version}`;
  $('workspace-statement').value = '';
  for (const id of ['workspace-statement', 'workspace-microphone', 'workspace-analyze', 'workspace-audio-upload', 'workspace-text-upload', 'workspace-retry']) $(id).disabled = false;
  $('workspace-input-status').textContent = '';
  renderWorkspaceCorrections();
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

function applyAuthoritativeCapture(result, sessionId, revision) {
  state.authoritySession = result.session;
  $('workspace-text-upload').disabled = true;
  if (result.transcript) {
    applyTranscriptArtifact(state.session, { ...result.transcript, artifact_id: result.transcript.transcript_id });
    $('workspace-statement').value = result.transcript.raw_text;
  }
  clearExtractedFacts();
  updateFromFacts();
  if (result.failure) {
    state.retryEvidenceId = result.evidence?.evidence_id || null;
    $('workspace-retry').hidden = false;
    $('workspace-input-status').textContent = `Audio preserved, but transcription failed: ${result.failure.message}`;
    return 0;
  }
  state.retryEvidenceId = null;
  $('workspace-retry').hidden = true;
  if (result.review) {
    state.hvacCorrectionReview = {
      authoritative: true,
      sessionId,
      revision,
      reviewId: result.review.review_id,
      serverRevision: result.session.revision,
      candidates: result.review.items.map((item) => ({
        candidate_id: item.review_item_id,
        source_span: { ...item.source_span, text: item.source_span.quote },
        candidate: item.proposed_text || item.source_span.quote,
        status: item.material ? 'NEEDS_TECHNICIAN_CONFIRMATION' : 'OPTIONAL',
        reason: item.reason,
      })),
      decisions: new Map(),
    };
    renderWorkspaceCorrections();
    $('workspace-input-status').textContent = `${result.review.items.length} transcript detail${result.review.items.length === 1 ? '' : 's'} need your review before fields update.`;
    return 0;
  }
  const accepted = applyCandidateFacts(result.candidates, revision);
  $('workspace-input-status').textContent = `${accepted} supported field${accepted === 1 ? '' : 's'} updated.`;
  return accepted;
}

function clearExtractedFacts() {
  for (const key of state.facts.keys()) if (key.startsWith('extracted:')) state.facts.delete(key);
}

function renderWorkspaceCorrections() {
  const container = $('workspace-corrections');
  container.replaceChildren();
  const review = state.hvacCorrectionReview;
  if (!review) { container.hidden = true; return; }
  container.hidden = false;
  const intro = element('div', 'workspace-correction-intro');
  intro.append(element('strong', '', 'Review transcript wording'), element('span', '', `${review.decisions.size} / ${review.candidates.length} decided`));
  container.append(intro);
  for (const candidate of review.candidates) {
    const row = element('div', 'workspace-correction-row');
    const copy = element('div', 'workspace-correction-copy');
    copy.append(
      element('strong', '', `“${candidate.source_span.text}” → “${candidate.candidate}”`),
      element('small', '', candidate.status === 'NEEDS_TECHNICIAN_CONFIRMATION' ? `Critical review · ${candidate.reason}` : candidate.reason),
    );
    const actions = element('div', 'workspace-correction-actions');
    const decision = review.decisions.get(candidate.candidate_id);
    for (const [label, value] of [['Keep original', 'REJECT'], ['Use correction', 'ACCEPT']]) {
      const button = element('button', decision === value ? 'secondary selected' : 'text-button', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(decision === value));
      button.addEventListener('click', () => chooseWorkspaceCorrection(candidate.candidate_id, value));
      actions.append(button);
    }
    row.append(copy, actions); container.append(row);
  }
}

async function extractReviewedHvacFacts(review) {
  const decisions = review.candidates.map((candidate) => ({
    review_item_id: candidate.candidate_id,
    decision: review.decisions.get(candidate.candidate_id),
  }));
  const result = await mutateAuthority(async () => {
    const decided = await api(
      `/api/report-sessions/${encodeURIComponent(state.authoritySession.session_id)}/transcript-reviews/${encodeURIComponent(review.reviewId)}/decide`,
      { method: 'POST', body: { expected_revision: state.authoritySession.revision, decisions } },
    );
    state.authoritySession = decided.session;
    return decided;
  });
  if (state.session?.id !== review.sessionId || state.analysisRevision !== review.revision) return null;
  state.authoritySession = result.session;
  state.session.corrections = structuredClone(review.candidates);
  state.session.correctionDecisions = structuredClone(decisions);
  return applyCandidateFacts(result.candidates, review.revision);
}

async function chooseWorkspaceCorrection(candidateId, decision) {
  const review = state.hvacCorrectionReview;
  if (!review || !review.candidates.some((candidate) => candidate.candidate_id === candidateId)) return;
  review.decisions.set(candidateId, decision);
  renderWorkspaceCorrections();
  if (review.decisions.size !== review.candidates.length) return;
  setWorkspaceBusy('hvac-corrections', true);
  document.querySelectorAll('#workspace-corrections button').forEach((button) => { button.disabled = true; });
  $('workspace-input-status').textContent = 'Applying reviewed wording and updating the report…';
  try {
    const accepted = await extractReviewedHvacFacts(review);
    if (accepted === null) return;
    state.hvacCorrectionReview = null;
    renderWorkspaceCorrections();
    $('workspace-input-status').textContent = `${accepted} supported field${accepted === 1 ? '' : 's'} updated.`;
  } catch (error) {
    if (state.session?.id === review.sessionId) $('workspace-input-status').textContent = `Could not update the report: ${error.message}`;
  } finally {
    if (state.session?.id === review.sessionId) {
      setWorkspaceBusy('hvac-corrections', false);
      renderWorkspaceCorrections();
    }
  }
}

async function analyzeStatement() {
  const text = $('workspace-statement').value.trim();
  if (!text) { $('workspace-input-status').textContent = 'Add a technician statement first.'; return; }
  const sessionId = state.session.id;
  const revision = ++state.analysisRevision;
  state.hvacCorrectionReview = null;
  renderWorkspaceCorrections();
  setWorkspaceBusy('analysis', true);
  $('workspace-analyze').disabled = true;
  $('workspace-input-status').textContent = 'Saving evidence and updating the report…';
  try {
    const result = await mutateAuthority(async () => {
      const authority = await ensureAuthoritativeSession();
      const captured = await api(`/api/report-sessions/${encodeURIComponent(authority.session_id)}/capture/text`, {
        method: 'POST', body: { expected_revision: authority.revision, text, language: 'auto' },
      });
      state.authoritySession = captured.session;
      return captured;
    });
    if (state.session.id !== sessionId || state.analysisRevision !== revision) return;
    applyAuthoritativeCapture(result, sessionId, revision);
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
  $('workspace-retry').hidden = true;
  $('workspace-input-status').textContent = 'Transcribing locally…';
  $('workspace-microphone').disabled = true;
  try {
    const revision = ++state.analysisRevision;
    const result = await mutateAuthority(async () => {
      const authority = await ensureAuthoritativeSession();
      const captured = await api(`/api/report-sessions/${encodeURIComponent(authority.session_id)}/capture/audio`, {
        method: 'POST',
        headers: {
          'content-type': 'audio/wav',
          'x-expected-revision': String(authority.revision),
          'x-stt-model': 'base',
          'x-stt-language': 'auto',
        },
        body: wav,
      });
      state.authoritySession = captured.session;
      return captured;
    });
    if (state.session?.id !== sessionId) return;
    if (!result.failure) $('workspace-input-status').textContent = `${label} transcribed. Updating the report…`;
    applyAuthoritativeCapture(result, sessionId, revision);
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

async function retryWorkspaceTranscription() {
  if (!state.retryEvidenceId || !state.session) return;
  const sessionId = state.session.id;
  setWorkspaceBusy('audio-retry', true);
  $('workspace-input-status').textContent = 'Retrying transcription from preserved audio…';
  try {
    const revision = ++state.analysisRevision;
    const result = await mutateAuthority(async () => {
      const authority = await ensureAuthoritativeSession();
      const retried = await api(`/api/report-sessions/${encodeURIComponent(authority.session_id)}/transcription/retry`, {
        method: 'POST',
        body: { expected_revision: authority.revision, evidence_id: state.retryEvidenceId },
      });
      state.authoritySession = retried.session;
      return retried;
    });
    if (state.session?.id === sessionId) applyAuthoritativeCapture(result, sessionId, revision);
  } catch (error) {
    if (state.session?.id === sessionId) $('workspace-input-status').textContent = `Transcription retry failed: ${error.message}`;
  } finally {
    if (state.session?.id === sessionId) setWorkspaceBusy('audio-retry', false);
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
    const authority = await ensureAuthoritativeSession();
    const built = await api('/api/template-reports/build', { method: 'POST', body: {
      template_id: state.activeTemplate.templateId, report_session_id: authority.session_id,
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
    registerRuntimeTemplate(data.template); state.templates.push(data.template); renderCatalog(); renderManager();
    $('setup-test-status').className = 'setup-status success'; $('setup-test-status').textContent = `Published ${data.template.name} v${data.template.templateVersion}. The source, schema, context, renderer, and adapter are now immutable.`;
    $('setup-publish').disabled = true; setSetupStep(5);
  } catch (error) { $('setup-test-status').textContent = `Publish blocked: ${error.message}`; }
}

async function init() {
  state.templatesLoading = true; state.templatesError = null; renderCatalog();
  try {
    const bootstrap = await fetch('/session-bootstrap', { method: 'POST' }).then((response) => response.json());
    state.token = bootstrap.token;
    const result = await api('/api/templates');
    state.templates = result.templates;
    for (const template of state.templates) registerRuntimeTemplate(template);
    state.templatesLoading = false;
    renderCatalog(); renderManager(); $('template-runtime-status').textContent = 'Local';
  } catch (error) {
    state.templatesLoading = false; state.templatesError = error.message;
    $('template-runtime-status').textContent = 'Connection unavailable';
    renderCatalog();
  }
}

document.querySelectorAll('[data-template-nav]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.templateNav)));
$('template-mobile-menu').addEventListener('click', () => syncMobileNavigation(!document.querySelector('.template-sidebar').classList.contains('open')));
mobileNavigation.addEventListener('change', () => syncMobileNavigation(false));
$('template-search').addEventListener('input', (event) => renderCatalog(event.target.value));
document.querySelectorAll('[data-template-category]').forEach((button) => button.addEventListener('click', () => {
  state.catalogCategory = button.dataset.templateCategory;
  document.querySelectorAll('[data-template-category]').forEach((candidate) => {
    const active = candidate === button;
    candidate.classList.toggle('active', active); candidate.setAttribute('aria-pressed', String(active));
  });
  renderCatalog();
}));
$('workspace-analyze').addEventListener('click', () => analyzeStatement());
$('workspace-microphone').addEventListener('click', () => (workspaceRecorder ? stopWorkspaceRecording() : startWorkspaceRecording()));
$('workspace-retry').addEventListener('click', retryWorkspaceTranscription);
$('workspace-text-upload').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $('workspace-input-status').textContent = `Adding ${file.name} as scoped guidance…`;
  try {
    const uploaded = await mutateAuthority(async () => {
      const authority = await ensureAuthoritativeSession();
      const result = await api(`/api/report-sessions/${encodeURIComponent(authority.session_id)}/guidance/uploads`, {
        method: 'POST',
        headers: {
          'content-type': file.type || 'text/plain',
          'x-file-name': file.name,
          'x-expected-revision': String(authority.revision),
        },
        body: file,
      });
      state.authoritySession = result.session;
      return result;
    });
    $('workspace-input-status').textContent = `${uploaded.upload.filename} added as guidance. It cannot establish job facts.`;
  } catch (error) {
    $('workspace-input-status').textContent = `Could not add guidance: ${error.message}`;
  } finally {
    event.target.value = '';
  }
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
