import {
  bindSessionConfirmation,
  createReportSession,
  createResolveQueue,
  evaluateCompleteness,
  factsFromStructuredState,
  mapFactsToStructuredState,
  registerRuntimeTemplate,
} from './report-runtime.js';

const $ = (id) => document.getElementById(id);
const state = {
  token: '', templates: [], activeTemplate: null, session: null, facts: new Map(),
  analysisRevision: 0,
  setupDraft: null, setupSchemaSaved: false, setupContextReady: false, setupTestPassed: false,
};
const mobileNavigation = window.matchMedia('(max-width: 760px)');

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
  const views = { choose: 'template-choose', workspace: 'template-workspace', templates: 'template-manager', setup: 'template-setup' };
  for (const [key, id] of Object.entries(views)) {
    const active = key === name;
    $(id).hidden = !active;
    $(id).classList.toggle('active', active);
  }
  document.querySelectorAll('[data-template-nav]').forEach((button) => button.classList.toggle('active', button.dataset.templateNav === name));
  const headings = {
    choose: ['TECHNICIAN WORKSPACE', 'Choose a template'], workspace: ['REPORT WORKSPACE', state.activeTemplate?.name || 'Report workspace'],
    templates: ['MANAGER', 'Templates'], setup: ['MANAGER', 'Template setup'],
  };
  $('template-eyebrow').textContent = headings[name][0];
  $('template-page-title').textContent = headings[name][1];
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
    const footer = element('footer');
    footer.append(element('span', 'prototype-chip', template.provenance?.classification || 'user-supplied prototype'), element('span', 'version-chip', `v${template.templateVersion}`));
    button.append(icon, title, description, footer);
    button.addEventListener('click', () => openWorkspace(template.templateId));
    container.append(button);
  }
  if (!matches.length) container.append(element('p', 'template-panel', 'No templates match this search.'));
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

function renderFields() {
  const form = $('workspace-fields');
  form.replaceChildren();
  const sections = [...new Set(state.activeTemplate.schema.fields.map((field) => field.section))];
  for (const sectionName of sections) {
    const section = element('section', 'field-section');
    const fields = state.activeTemplate.schema.fields.filter((field) => field.section === sectionName);
    const header = element('header');
    header.append(element('h3', '', sectionName), element('span', '', `${fields.filter((field) => field.required).length} required`));
    const grid = element('div', 'field-grid');
    for (const field of fields) {
      const wrapper = element('div', `schema-field${field.critical ? ' critical' : ''}`);
      wrapper.dataset.fieldWrapper = field.id;
      const label = element('label');
      label.htmlFor = `field-${field.displayOrder}`;
      label.append(document.createTextNode(field.label));
      if (field.required) label.append(element('span', '', '*'));
      let control;
      const allowed = field.allowedStatuses || field.allowedValues;
      if (field.type === 'status' || allowed) {
        control = element('select');
        for (const value of allowed || ['NOT_CHECKED', 'OK', 'NOT_OK', 'N/A']) {
          const option = element('option', '', value.replaceAll('_', ' ')); option.value = value; control.append(option);
        }
      } else if (field.type === 'text') {
        control = element('textarea'); control.rows = 2;
      } else {
        control = element('input'); control.type = field.type === 'number' ? 'number' : 'text';
      }
      control.id = `field-${field.displayOrder}`;
      control.dataset.schemaField = field.id;
      control.setAttribute('aria-required', String(Boolean(field.required)));
      control.addEventListener('change', () => setTechnicianFact(field, control.value));
      wrapper.append(label, control, element('small', '', `${field.inferencePolicy.replaceAll('_', ' ').toLowerCase()}${field.critical ? ' · critical confirmation' : ''}`));
      grid.append(wrapper);
    }
    section.append(header, grid); form.append(section);
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
  const required = completeness.requiredFields.length;
  const missing = completeness.missingFields.length;
  const confirmed = Boolean(state.session.confirmation);
  const resolved = Math.max(0, required - missing);
  const percent = required ? Math.round((resolved / required) * 100) : 100;
  $('readiness-meter-fill').style.width = `${percent}%`;
  const status = $('readiness-state');
  status.className = `readiness-state${confirmed ? ' confirmed' : completeness.complete ? ' ready' : ''}`;
  status.textContent = confirmed ? 'CONFIRMED' : completeness.complete ? 'READY' : 'NEEDS INFORMATION';
  $('readiness-summary').textContent = confirmed ? 'This exact report version is technician-confirmed.' : completeness.complete
    ? 'All required fields are supported and ready for exact-version confirmation.'
    : `${resolved} of ${required} required fields resolved · ${missing} remaining.`;
  const resolve = $('inline-resolve'); resolve.replaceChildren();
  const queue = createResolveQueue(state.session).slice(0, 6);
  for (const item of queue) {
    const row = element('button', 'resolve-row', item.question);
    row.type = 'button';
    row.addEventListener('click', () => document.querySelector(`[data-schema-field="${CSS.escape(item.targetField || item.fieldId)}"]`)?.focus());
    resolve.append(row);
    document.querySelector(`[data-field-wrapper="${CSS.escape(item.targetField || item.fieldId)}"]`)?.classList.add('missing');
  }
  if (createResolveQueue(state.session).length > queue.length) resolve.append(element('p', 'microcopy', `+ ${createResolveQueue(state.session).length - queue.length} more fields in the form`));
  $('workspace-confirm').disabled = confirmed || !completeness.complete || !$('workspace-confirm-check').checked;
}

function openWorkspace(templateId) {
  const template = state.templates.find((item) => item.templateId === templateId);
  if (!template) return;
  state.activeTemplate = template;
  state.session = createReportSession({ templateId, jobContext: { technicianId: 'LOCAL-TECH', technicianName: 'Local technician' } });
  state.facts = new Map();
  state.analysisRevision = 0;
  $('workspace-title').textContent = template.name;
  $('workspace-description').textContent = template.description || 'Organization-defined maintenance report.';
  $('workspace-provenance').textContent = template.provenance?.classification || 'user-supplied prototype';
  $('workspace-version').textContent = `Template ${template.templateVersion} · Schema ${template.schema.version}`;
  $('workspace-statement').value = '';
  $('workspace-input-status').textContent = 'Manual field entry is always available.';
  $('workspace-confirm-check').checked = false;
  $('workspace-confirm-status').textContent = '';
  renderFields(); renderContext(); updateFromFacts(); setView('workspace');
}

async function analyzeStatement() {
  const text = $('workspace-statement').value.trim();
  if (!text) { $('workspace-input-status').textContent = 'Add a technician statement first.'; return; }
  if (!['SBS_BUS', 'SBS_RAIL'].includes(state.activeTemplate.domain)) {
    $('workspace-input-status').textContent = 'This template has no robust automatic parser enabled. The statement is preserved; review and enter its fields manually.';
    return;
  }
  $('workspace-analyze').disabled = true; $('workspace-input-status').textContent = 'Extracting only directly supported facts…';
  try {
    const contextId = state.activeTemplate.domain === 'SBS_BUS' ? 'SBS/BUS' : 'SBS/RAIL';
    const result = await api('/api/v2/facts/extract', { method: 'POST', body: { context_id: contextId, raw_text: text } });
    state.analysisRevision += 1;
    let accepted = 0;
    const allowed = state.activeTemplate.schema.fields.map((field) => field.id);
    for (const [index, fact] of (result.facts || []).entries()) {
      if (allowed.some((pattern) => pattern.endsWith('.*') ? fact.field.startsWith(pattern.slice(0, -1)) : fact.field === pattern)) {
        state.facts.set(fact.fact_id || `extracted:${state.analysisRevision}:${fact.field}:${index}`, fact); accepted += 1;
      }
    }
    updateFromFacts();
    $('workspace-input-status').textContent = `${accepted} directly supported field${accepted === 1 ? '' : 's'} mapped. Review critical and remaining fields inline.`;
  } catch (error) { $('workspace-input-status').textContent = `Analysis failed: ${error.message}`; }
  finally { $('workspace-analyze').disabled = false; }
}

async function confirmWorkspace() {
  $('workspace-confirm').disabled = true; $('workspace-confirm-status').textContent = 'Validating exact template and evidence bindings…';
  try {
    const built = await api('/api/template-reports/build', { method: 'POST', body: {
      template_id: state.activeTemplate.templateId, report_session_id: state.session.id, facts: factsFromStructuredState(state.session),
    } });
    const confirmed = await api('/api/v2/reports/confirm', { method: 'POST', body: {
      draft: built.draft, validator_run_id: built.validation_receipt.validator_run_id,
      technician_id: state.session.jobContext.technicianId, technician_name: state.session.jobContext.technicianName,
    } });
    bindSessionConfirmation(state.session, confirmed.confirmation);
    $('workspace-confirm-status').textContent = `Confirmed ${confirmed.confirmation.confirmation_token}. Any material change requires a new confirmation.`;
    document.querySelectorAll('#workspace-fields input, #workspace-fields textarea, #workspace-fields select').forEach((control) => { control.disabled = true; });
    renderReadiness();
  } catch (error) {
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
$('workspace-analyze').addEventListener('click', analyzeStatement);
$('workspace-text-upload').addEventListener('change', async (event) => { const file = event.target.files[0]; if (file) { $('workspace-statement').value = await file.text(); $('workspace-input-status').textContent = `${file.name} loaded as technician-provided text. Choose Analyze statement to map supported fields.`; } });
$('workspace-audio-upload').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  $('workspace-input-status').textContent = 'Uploading and transcribing audio locally…';
  try {
    const audio = await api('/api/audio', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: file });
    const transcript = await api('/api/transcriptions', { method: 'POST', body: { audio_id: audio.audio_id, model: 'base', language: 'auto' } });
    $('workspace-statement').value = transcript.transcript.raw_text; $('workspace-input-status').textContent = 'Local transcript ready. Choose Analyze statement to map supported fields.';
  } catch (error) { $('workspace-input-status').textContent = `Audio preserved but transcription is unavailable: ${error.message}`; }
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
