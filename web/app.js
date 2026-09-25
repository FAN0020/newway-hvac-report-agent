import { PcmWavRecorder } from './audio-recorder.js';
import { t } from './i18n.js';
import {
  REPORT_SCHEMAS,
  createReportSession,
  createResolveQueue,
  createSessionRuntime,
  mapFactsToStructuredState,
  schemaFor,
} from './report-runtime.js';

const ids = [
  'auth-gate', 'auth-token', 'auth-submit', 'auth-status', 'network-mode', 'network-warning',
  'page-title', 'page-eyebrow', 'topbar-status', 'mobile-menu', 'journey', 'reports-list', 'report-search',
  'context-icon', 'context-title', 'context-schema', 'sbs-source-row', 'open-evidence', 'review-evidence',
  'evidence-drawer', 'close-evidence', 'drawer-backdrop', 'audit-timeline', 'fill-demo',
  'refresh-health', 'health-summary', 'health-details', 'start-recording', 'stop-recording', 'audio-file',
  'recording-status', 'audio-preview', 'language', 'model', 'transcribe', 'retry', 'manual-transcript',
  'use-manual', 'transcription-status', 'transcript-output', 'artifact-output', 'build-report',
  'correction-section', 'correction-raw', 'correction-proposed', 'correction-list', 'correction-technician-name',
  'correction-technician-id', 'confirm-corrections', 'correction-status', 'correction-evidence', 'resolve-count',
  'questions-section', 'questions-list', 'apply-answers', 'evidence-section', 'facts-output', 'issues-output',
  'fact-count', 'issue-count', 'validation-label', 'report-section', 'validator-banner', 'report-output',
  'validator-output', 'confirm-section', 'technician-name', 'technician-id', 'confirm-check', 'confirm-report',
  'save-report', 'export-report', 'copy-export', 'confirmation-status', 'export-output', 'complete-summary',
  'complete-meta', 'v2-upload-file', 'v2-upload-submit', 'v2-upload-status', 'v2-uploader', 'v2-upload-list',
  'v2-upload-progress', 'v2-upload-record', 'v2-upload-scope-hint', 'v2-retrieve-query', 'v2-retrieve-topk',
  'v2-retrieve-submit', 'v2-retrieve-status', 'v2-retrieve-warnings', 'v2-retrieve-results',
  'v2-retrieve-scope-hint', 'scope-selector-buttons', 'scope-selector-status', 'v1-panel', 'v2-panel',
  'v2-facts-text', 'v2-facts-extract', 'v2-report-build', 'v2-facts-status', 'v2-facts-table-wrap',
  'v2-facts-table', 'v2-report-output', 'v2-report-banner', 'v2-report-missing', 'v2-report-gates',
  'v2-report-sections', 'v2-demo-play', 'v2-demo-status', 'v2-demo-captions', 'v2-demo-fixes',
  'v2-demo-fix-list', 'v2-walkthrough-start', 'v2-walkthrough', 'v2-wt-progress', 'v2-wt-step',
  'v2-wt-title', 'v2-wt-desc', 'v2-wt-skip', 'v2-wt-next',
];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const runtime = createSessionRuntime();
const sessions = new Map();
const manualFields = {};
const sessionTokenKey = 'hvac_demo_session_token';
const demoNarration = '客户反映不制冷。检查发现运行电容损坏。更换了一个35微法电容。试机运行正常。问题已解决。建议下次保养清洗滤网。';
const examples = {
  HVAC: demoNarration,
  SBS_BUS: 'Preventive maintenance on bus MAN A95. The front door would not close. Inspection found the door control module was faulty. Replaced the door control module. Tested door opening and closing normal. Completion status completed.',
  SBS_RAIL: 'Corrective maintenance on train set C751A 7001/7002. TAMS access approved. Inspected car three door, replaced the worn door roller, tested operation, and returned the train to service.',
};
const scopeMeta = {
  HVAC: { icon: '❉', contextId: 'HVAC' },
  SBS_BUS: { icon: '▰', contextId: 'SBS/BUS' },
  SBS_RAIL: { icon: '▥', contextId: 'SBS/RAIL' },
};
const FINALIZATION_ROUTES = Object.freeze({
  HVAC: Object.freeze({ confirm: '/api/reports/confirm', save: '/api/reports/save', export: '/api/reports/export' }),
  SBS: Object.freeze({ confirm: '/api/v2/reports/confirm', save: '/api/v2/reports/save', export: '/api/v2/reports/export' }),
});

let sessionToken = '';
let activeSession = null;
let recorder;
let recordingTimer;
let currentBlob;
let currentAudioId;
let previewUrl;
let currentTranscript;
let currentNormalization;
let currentCorrectionReceipt;
let currentFacts = [];
let currentFactsReceiptId;
let currentDraft;
let currentValidation;
let confirmationToken;
let ollamaReady = false;
let currentView = 'reports';
let knowledgeScope = 'SBS_BUS';
let knowledgeRequestGeneration = 0;
const knowledgeTransients = new Map();

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function renderEmptyState(container, { icon = '▤', title, message, actionLabel, action } = {}) {
  const body = node('div');
  body.append(node('span', 'empty-icon', icon), node('h3', '', title), node('p', '', message));
  if (actionLabel) {
    const button = node('button', 'primary', actionLabel);
    button.addEventListener('click', action);
    body.append(button);
  }
  const wrapper = node('div', 'empty-state');
  wrapper.append(body);
  container.replaceChildren(wrapper);
}

function setSessionToken(value) {
  sessionToken = String(value || '').trim();
  if (sessionToken) sessionStorage.setItem(sessionTokenKey, sessionToken);
  else sessionStorage.removeItem(sessionTokenKey);
}

function requireLogin(message = 'Enter the temporary demo passcode set when the server started.') {
  setSessionToken('');
  el['auth-gate'].hidden = false;
  el['auth-status'].textContent = message;
  el['auth-token'].value = '';
  el['auth-token'].focus();
}

async function api(path, body, options = {}) {
  const { allowToolFailure = false, ...fetchOptions } = options;
  if (!sessionToken) throw new Error('No demo session established yet.');
  const headers = new Headers(fetchOptions.headers || {});
  headers.set('authorization', `Bearer ${sessionToken}`);
  const requestOptions = { ...fetchOptions, headers };
  if (body !== undefined) {
    requestOptions.method = requestOptions.method || 'POST';
    headers.set('content-type', 'application/json');
    requestOptions.body = JSON.stringify(body);
  }
  const response = await fetch(path, requestOptions);
  let result;
  try { result = await response.json(); } catch { result = { status: 'FAIL', error_code: `HTTP_${response.status}` }; }
  if (response.status === 401) requireLogin('Invalid passcode or expired session. Please re-enter.');
  if (!response.ok || (!allowToolFailure && ['FAIL', 'RETRYABLE_ERROR'].includes(result.status))) {
    const error = new Error(result.data?.message || result.error_code || `HTTP ${response.status}`);
    error.result = result;
    throw error;
  }
  return result;
}

async function apiRaw(path, body, headers = {}) {
  if (!sessionToken) throw new Error('No demo session established yet.');
  const requestHeaders = new Headers(headers);
  requestHeaders.set('authorization', `Bearer ${sessionToken}`);
  const response = await fetch(path, { method: 'POST', headers: requestHeaders, body });
  const result = await response.json();
  if (response.status === 401) requireLogin('Invalid passcode or expired session. Please re-enter.');
  if (!response.ok || ['FAIL', 'RETRYABLE_ERROR'].includes(result.status)) {
    const error = new Error(result.data?.message || result.error_code || `HTTP ${response.status}`);
    error.result = result;
    throw error;
  }
  return result;
}

function addAudit(label, detail = '') {
  if (!activeSession) return;
  activeSession.audit ||= [];
  activeSession.audit.push({ label, detail, at: new Date().toISOString() });
  renderAudit();
}

function renderAudit() {
  const entries = activeSession?.audit || [];
  el['audit-timeline'].replaceChildren(...entries.map((entry) => node('div', 'audit-entry', `${entry.label} · ${entry.at.slice(11, 19)}${entry.detail ? `\n${entry.detail}` : ''}`)));
}

function showEvidence() {
  el['evidence-drawer'].hidden = false;
  el['drawer-backdrop'].hidden = false;
  renderAudit();
}

function hideEvidence() {
  el['evidence-drawer'].hidden = true;
  el['drawer-backdrop'].hidden = true;
}

function resetCurrentReferences() {
  currentTranscript = activeSession?.transcriptArtifact || null;
  currentNormalization = activeSession?.normalization || null;
  currentCorrectionReceipt = activeSession?.correctionReceipt || null;
  currentFacts = activeSession?.facts || [];
  currentFactsReceiptId = activeSession?.factsReceiptId || null;
  currentDraft = activeSession?.reportDraft || null;
  currentValidation = activeSession?.validation || null;
  confirmationToken = activeSession?.confirmation?.confirmation_token || null;
}

function navigate(view) {
  currentView = view;
  if (view === 'resolve' && activeSession) activeSession.visitedResolve = true;
  for (const section of document.querySelectorAll('.view')) section.classList.toggle('active', section.id === `view-${view}`);
  const target = document.getElementById(`view-${view}`);
  if (!target) return;
  el['page-title'].textContent = target.dataset.title;
  el['page-eyebrow'].textContent = target.dataset.eyebrow;
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', item.dataset.nav === view || (['capture', 'resolve', 'review', 'complete'].includes(view) && item.dataset.nav === 'reports'));
  const journeyView = ['capture', 'resolve', 'review', 'complete'].includes(view);
  el.journey.hidden = !journeyView;
  if (journeyView) updateJourney(view);
  document.querySelector('.sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function updateJourney(step) {
  const order = ['capture', 'resolve', 'review', 'complete'];
  const index = order.indexOf(step);
  for (const button of el.journey.querySelectorAll('button')) {
    const buttonIndex = order.indexOf(button.dataset.step);
    button.classList.toggle('active', buttonIndex === index);
    button.classList.toggle('done', buttonIndex < index);
    button.disabled = !activeSession || buttonIndex > index || (buttonIndex === 1 && step !== 'resolve' && !activeSession.visitedResolve);
  }
}

function saveTransientFromDom() {
  if (!activeSession) return;
  runtime.setTransient(activeSession.id, {
    statement: el['manual-transcript'].value,
    technicianName: el['technician-name'].value || el['correction-technician-name'].value,
    technicianId: el['technician-id'].value || el['correction-technician-id'].value,
  });
}

function restoreTransientToDom() {
  const transient = activeSession ? runtime.getTransient(activeSession.id) : {};
  el['manual-transcript'].value = transient.statement || '';
  for (const id of ['technician-name', 'correction-technician-name']) el[id].value = transient.technicianName || '';
  for (const id of ['technician-id', 'correction-technician-id']) el[id].value = transient.technicianId || '';
}

function activateSession(session) {
  if (activeSession) saveTransientFromDom();
  activeSession = session;
  runtime.activate(session);
  resetCurrentReferences();
  restoreTransientToDom();
  updateCaptureContext();
}

function createNewReport(reportType) {
  const session = createReportSession({ reportType });
  session.audit = [];
  session.status = 'CAPTURE';
  sessions.set(session.id, session);
  activateSession(session);
  addAudit('Report created', `${session.schemaId} · version ${session.schemaVersion}`);
  navigate('capture');
}

function updateCaptureContext() {
  if (!activeSession) return;
  const schema = schemaFor(activeSession.schemaId);
  const meta = scopeMeta[activeSession.scope];
  el['context-icon'].textContent = meta.icon;
  el['context-title'].textContent = schema.name;
  el['context-schema'].textContent = `Schema ${schema.id} · v${schema.version}`;
  el['manual-transcript'].placeholder = schema.statementPlaceholder;
  el['sbs-source-row'].hidden = activeSession.scope === 'HVAC';
  el['topbar-status'].textContent = `${schema.name} · scope locked`;
}

function renderReports() {
  const query = el['report-search'].value.trim().toLowerCase();
  const filter = document.querySelector('.filter.active')?.dataset.filter || 'all';
  const rows = [...sessions.values()].filter((session) => {
    const confirmed = Boolean(session.confirmation);
    const matchesFilter = filter === 'all' || (filter === 'confirmed' ? confirmed : !confirmed);
    const haystack = `${session.id} ${session.schemaId} ${session.jobContext?.technicianName || ''}`.toLowerCase();
    return matchesFilter && haystack.includes(query);
  });
  if (!rows.length) {
    renderEmptyState(el['reports-list'], {
      title: sessions.size ? 'No reports match this view' : 'No reports yet',
      message: sessions.size ? 'Change the filter or search text.' : 'Create a report to capture on-site work and produce a technician-confirmed export.',
      actionLabel: sessions.size ? undefined : '＋ Create first report',
      action: () => navigate('new-report'),
    });
    return;
  }
  el['reports-list'].replaceChildren(...rows.map((session) => {
    const schema = schemaFor(session.schemaId);
    const row = node('button', 'report-row');
    const title = node('div');
    title.append(node('strong', '', schema.name), node('small', '', session.id));
    row.append(title, node('span', '', session.updatedAt.slice(0, 10)), node('span', 'status-pill', session.confirmation ? 'Confirmed' : session.status.replaceAll('_', ' ')), node('b', '', '→'));
    row.addEventListener('click', () => {
      activateSession(session);
      const destination = session.confirmation ? 'complete' : (session.reportDraft ? 'review' : 'capture');
      if (destination === 'review') renderReview();
      navigate(destination);
    });
    return row;
  }));
}

function healthBadge(label, ready, detail) {
  const item = node('div', `health-item ${ready ? 'ready' : 'not-ready'}`);
  item.append(node('strong', '', `${ready ? '●' : '○'} ${label}`), node('span', '', detail));
  return item;
}

async function refreshHealth() {
  el['health-summary'].textContent = 'Checking local components…';
  const result = await api('/api/health', undefined, { allowToolFailure: true });
  const { whisper, ollama } = result.data;
  ollamaReady = ollama.ready;
  el['health-summary'].textContent = whisper.ready ? 'Voice capture is available.' : 'Voice capture is not prepared; manual entry remains available.';
  el['health-details'].replaceChildren(healthBadge('Whisper', whisper.ready, whisper.ready ? `${whisper.model} available` : whisper.error_code), healthBadge('Ollama', ollama.ready, ollama.ready ? `${ollama.models.length} models` : 'deterministic fallback'));
}

async function unlockWithToken(token) {
  setSessionToken(token);
  el['auth-status'].textContent = 'Verifying passcode…';
  try {
    await refreshHealth();
    el['auth-gate'].hidden = true;
    el['auth-status'].textContent = '';
    el['topbar-status'].textContent = 'Local workspace ready';
    renderReports();
  } catch (error) {
    if (sessionToken) requireLogin(`Cannot establish session: ${error.message}`);
  }
}

async function initializeSession() {
  const lanLike = !['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  el['network-mode'].textContent = lanLike ? 'LAN demo mode' : 'Local demo mode';
  el['network-warning'].style.display = lanLike ? 'block' : 'none';
  el['network-warning'].textContent = !window.isSecureContext && lanLike ? 'Microphone capture may be unavailable over LAN HTTP. Use manual entry or upload a WAV.' : 'Use only on trusted networks; this is not a public deployment.';
  if (!window.isSecureContext) {
    el['start-recording'].disabled = true;
    el['recording-status'].textContent = 'Microphone capture is unavailable in this browser context; upload a WAV or type the statement.';
  }
  const remembered = sessionStorage.getItem(sessionTokenKey);
  if (remembered) return unlockWithToken(remembered);
  try {
    const response = await fetch('/session-bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' } });
    if (response.ok) return unlockWithToken((await response.json()).token);
  } catch { /* LAN mode intentionally has no automatic bootstrap. */ }
  requireLogin();
}

function invalidateConfirmation(message = 'Report content changed; validation and confirmation are required again.') {
  confirmationToken = null;
  if (activeSession) activeSession.confirmation = null;
  el['save-report'].disabled = true;
  el['export-report'].disabled = true;
  el['copy-export'].disabled = true;
  el['export-output'].hidden = true;
  el['confirmation-status'].textContent = message;
}

function acceptTranscript(artifact, message) {
  currentTranscript = artifact;
  activeSession.transcriptArtifact = artifact;
  activeSession.transcript = { original: artifact.raw_text, normalized: artifact.raw_text, hash: artifact.source_hash || artifact.artifact_id };
  el['transcript-output'].textContent = artifact.raw_text;
  el['transcript-output'].classList.remove('empty');
  el['artifact-output'].textContent = JSON.stringify(artifact, null, 2);
  el['transcription-status'].textContent = message;
  addAudit('Original transcript captured', artifact.provider || 'manual');
}

function selectAudio(blob, message) {
  currentBlob = blob;
  currentAudioId = null;
  el.transcribe.disabled = false;
  el.retry.disabled = true;
  el['recording-status'].textContent = message;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  el['audio-preview'].src = previewUrl;
  el['audio-preview'].hidden = false;
}

async function uploadIfNeeded() {
  if (currentAudioId) return currentAudioId;
  const result = await apiRaw('/api/audio', currentBlob, { 'content-type': 'audio/wav' });
  currentAudioId = result.data.audio_id;
  return currentAudioId;
}

async function transcribe(attempt) {
  if (!activeSession) return;
  const requestToken = runtime.beginRequest(activeSession.id, 'transcribe');
  el.transcribe.disabled = true;
  el.retry.disabled = true;
  el['transcription-status'].textContent = 'Transcribing locally…';
  try {
    const audioId = await uploadIfNeeded();
    const result = await api('/api/transcriptions', { audio_id: audioId, model: el.model.value, language: el.language.value, attempt, idempotency_key: `${audioId}:${el.model.value}:${el.language.value}:attempt-${attempt}` });
    if (!runtime.accepts(requestToken)) return;
    acceptTranscript(result.data.transcript, result.data.reused ? 'Reused the same transcription request.' : 'Speech transcription complete.');
    el['manual-transcript'].value = result.data.transcript.raw_text;
  } catch (error) {
    if (runtime.accepts(requestToken)) el['transcription-status'].textContent = `Transcription failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}. Manual entry is still available.`;
    el.retry.disabled = attempt >= 2;
  } finally { el.transcribe.disabled = false; }
}

function renderCorrectionReview(normalization) {
  const candidates = normalization.data.correction_candidates || [];
  el['correction-raw'].textContent = normalization.data.raw_text;
  el['correction-proposed'].textContent = normalization.data.proposed_text;
  el['correction-evidence'].textContent = JSON.stringify(normalization, null, 2);
  const resolveCount = Math.max(1, candidates.length);
  el['resolve-count'].textContent = `${resolveCount} item${resolveCount === 1 ? '' : 's'}`;
  el['correction-list'].replaceChildren(...(candidates.length ? candidates.map((candidate) => {
    const critical = candidate.status === 'NEEDS_TECHNICIAN_CONFIRMATION';
    const card = node('div', `correction-card ${critical ? 'critical' : ''}`);
    const head = node('div', 'resolve-item-head');
    head.append(node('strong', '', critical ? 'Verify critical terminology' : 'Review terminology'), node('span', 'item-type', critical ? 'CRITICAL VALUE' : 'TERMINOLOGY'));
    const change = node('div', 'correction-change');
    change.append(node('code', '', candidate.source_span.text), node('span', '', '→'), node('code', '', candidate.candidate));
    const controls = node('div', 'decision-controls');
    for (const [value, labelText] of [['ACCEPT', 'Accept supported reading'], ['REJECT', 'Keep original words']]) {
      const label = node('label');
      const radio = node('input');
      radio.type = 'radio'; radio.name = `decision-${candidate.candidate_id}`; radio.value = value; radio.dataset.candidateId = candidate.candidate_id;
      label.append(radio, document.createTextNode(labelText)); controls.append(label);
    }
    if (critical) {
      const label = node('label'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.criticalCandidateId = candidate.candidate_id;
      label.append(checkbox, document.createTextNode('I manually verified this critical value')); controls.append(label);
    }
    card.append(head, change, node('small', '', candidate.reason || ''), controls);
    return card;
  }) : [node('div', 'resolve-item', 'No terminology changes were proposed. Confirm the original statement and technician identity to continue.')]));
  el['questions-list'].replaceChildren();
  el['correction-status'].textContent = candidates.length ? 'Choose an outcome for each proposal.' : 'The original text will remain unchanged.';
}

function renderGenericResolve(queue) {
  el['correction-raw'].textContent = activeSession.transcript.original;
  el['correction-proposed'].textContent = activeSession.transcript.normalized || activeSession.transcript.original;
  el['correction-evidence'].textContent = JSON.stringify({ schema_id: activeSession.schemaId, schema_version: activeSession.schemaVersion, facts: currentFacts }, null, 2);
  el['resolve-count'].textContent = `${queue.length} item${queue.length === 1 ? '' : 's'}`;
  el['correction-list'].replaceChildren(...queue.map((item) => {
    const card = node('div', `resolve-item ${item.severity === 'high' ? 'critical' : ''}`);
    const head = node('div', 'resolve-item-head');
    head.append(node('strong', '', item.question), node('span', 'item-type', item.type.replaceAll('_', ' ')));
    const controls = node('div', 'decision-controls');
    for (const [value, label] of [['CONFIRM', 'Confirm from the on-site record'], ['NOT_PROVIDED', 'Mark not provided / pending']]) {
      const choice = node('label'); const radio = node('input'); radio.type = 'radio'; radio.name = item.id; radio.value = value; radio.dataset.resolveId = item.id;
      choice.append(radio, document.createTextNode(label)); controls.append(choice);
    }
    if (item.type === 'MISSING_FIELD') {
      const input = node('textarea');
      input.rows = 2;
      input.dataset.resolveValue = item.id;
      input.placeholder = 'Enter what the technician actually observed, or choose “not provided” below.';
      card.append(head, input, controls);
    } else card.append(head, controls);
    return card;
  }));
  el['questions-list'].replaceChildren();
  el['correction-status'].textContent = 'Resolve each item using only observed or recorded information.';
}

function collectGenericResolveDecisions() {
  for (const item of activeSession.unresolvedItems) {
    const selected = el['correction-list'].querySelector(`input[name="${CSS.escape(item.id)}"]:checked`);
    if (!selected) throw new Error('Resolve each item before continuing.');
    const value = el['correction-list'].querySelector(`[data-resolve-value="${CSS.escape(item.id)}"]`)?.value.trim() || '';
    if (selected.value === 'CONFIRM' && item.type === 'MISSING_FIELD' && !value) throw new Error('Enter the observed value, or mark the item not provided.');
    item.answer = { decision: selected.value, value: selected.value === 'CONFIRM' ? value : null };
  }
}

async function prepareHvacResolve() {
  currentNormalization = await api('/api/normalizations', { transcript_artifact_id: currentTranscript.artifact_id });
  activeSession.normalization = currentNormalization;
  activeSession.correctionCandidates = currentNormalization.data.correction_candidates || [];
  activeSession.unresolvedItems = createResolveQueue({ correctionCandidates: activeSession.correctionCandidates, missingFields: [], conflicts: [] });
  renderCorrectionReview(currentNormalization);
  addAudit('Terminology candidates prepared', `${activeSession.correctionCandidates.length} candidates`);
  navigate('resolve');
}

async function processSbsStatement(raw, requestToken) {
  const meta = scopeMeta[activeSession.scope];
  const artifact = { artifact_id: `manual_${activeSession.id}`, provider: 'manual', raw_text: raw, source_hash: null, language: 'en' };
  acceptTranscript(artifact, 'Manual statement captured.');
  const extracted = await api('/api/v2/facts/extract', { context_id: meta.contextId, raw_text: raw });
  if (!runtime.accepts(requestToken)) return;
  currentFacts = extracted.data.facts || [];
  const mapped = mapFactsToStructuredState(activeSession, currentFacts);
  Object.assign(activeSession, mapped);
  const conflicts = Object.values(activeSession.fieldStates).filter((field) => field.status === 'CONFLICT').map((field) => ({ field: field.fieldId, values: field.candidates.map((candidate) => candidate.value) }));
  activeSession.unresolvedItems = createResolveQueue({ correctionCandidates: [], missingFields: [], conflicts });
  addAudit('Facts extracted', `${currentFacts.length} grounded facts`);
  if (activeSession.unresolvedItems.length) {
    renderGenericResolve(activeSession.unresolvedItems);
    navigate('resolve');
  } else {
    await buildSbsReport(requestToken, true);
  }
}

async function buildSbsReport(existingToken, resolveMissing = false) {
  const requestToken = existingToken || runtime.beginRequest(activeSession.id, 'build-sbs-report');
  const result = await api('/api/v2/reports/build', { context_id: scopeMeta[activeSession.scope].contextId, facts: currentFacts, knowledge_hits: activeSession.knowledgeHits || [] }, { allowToolFailure: true });
  if (!runtime.accepts(requestToken)) return;
  if (!['PASS', 'NEEDS_CONFIRMATION'].includes(result.status)) throw new Error(result.error_code || 'Report could not be built.');
  currentDraft = result.data.draft;
  currentValidation = { trace_id: result.trace_id, status: result.status, data: { can_enter_technician_review: result.status === 'PASS', gates: result.data.gates, validation_receipt: result.data.validation_receipt } };
  activeSession.reportDraft = currentDraft;
  activeSession.reportDocument = currentDraft;
  activeSession.validation = currentValidation;
  const missingSections = result.data.report?.missing_required_fields || [];
  if (resolveMissing && missingSections.length) {
    activeSession.unresolvedItems = missingSections.map((fieldId, index) => ({
      id: `missing_field_${fieldId}_${index}`,
      type: 'MISSING_FIELD',
      fieldId,
      severity: 'high',
      question: `No grounded information was found for ${fieldId.replaceAll('_', ' ')}.`,
      evidence: [],
      answer: null,
    }));
    renderGenericResolve(activeSession.unresolvedItems);
    addAudit('Missing information queued for explicit review', `${missingSections.length} report sections`);
    navigate('resolve');
    return;
  }
  activeSession.status = 'REVIEW';
  addAudit('Report built and validated', result.status);
  renderReview();
  navigate('review');
}

async function generateHvacReport() {
  const extracted = await api('/api/facts/extract', { correction_receipt_id: currentCorrectionReceipt.correction_receipt_id, manual_fields: manualFields, use_llm: ollamaReady });
  currentFacts = extracted.data.facts;
  currentFactsReceiptId = extracted.data.facts_receipt_id;
  const inputValidation = await api('/api/reports/validate-input', { facts_receipt_id: currentFactsReceiptId });
  activeSession.facts = currentFacts;
  activeSession.factsReceiptId = currentFactsReceiptId;
  activeSession.inputValidation = inputValidation;
  const followUps = inputValidation.data.follow_up_questions || [];
  if (!activeSession.hvacMissingResolved && followUps.length) {
    activeSession.hvacMissingPhase = true;
    activeSession.unresolvedItems = followUps.map(({ field, question }, index) => ({
      id: `missing_field_${field}_${index}`,
      type: 'MISSING_FIELD',
      fieldId: field,
      severity: 'high',
      question,
      evidence: [],
      answer: null,
    }));
    renderGenericResolve(activeSession.unresolvedItems);
    addAudit('Missing information queued for explicit review', `${followUps.length} follow-up questions`);
    navigate('resolve');
    return;
  }
  const plan = await api('/api/reports/plan', { facts_receipt_id: currentFactsReceiptId, service_type: 'general_hvac' });
  const template = await api('/api/reports/template', { template_id: 'hvac_service_report', version: '1.0.0' });
  const generated = await api('/api/reports/generate', { facts_receipt_id: currentFactsReceiptId, plan: plan.data, template: template.data.template, use_llm: ollamaReady });
  currentDraft = generated.data.draft;
  currentValidation = await api('/api/reports/validate-draft', { draft: currentDraft, facts_receipt_id: currentFactsReceiptId });
  activeSession.reportDraft = currentDraft;
  activeSession.reportDocument = currentDraft;
  activeSession.validation = currentValidation;
  activeSession.inputValidation = inputValidation;
  activeSession.status = 'REVIEW';
  addAudit('Report built and independently validated', currentValidation.status);
  renderReview();
  navigate('review');
}

function renderReportSections() {
  const sections = currentDraft?.sections || [];
  el['report-output'].replaceChildren(...sections.map((section) => {
    const block = node('div', 'report-section-block');
    block.append(node('h3', section.required && (section.content || []).every((line) => line === 'Not provided / pending confirmation') ? 'v2-section-missing' : '', section.title));
    for (const item of section.items || section.content || []) {
      const text = typeof item === 'string' ? item : item.text;
      const line = node('p', typeof item === 'object' && item.type === 'template_text' ? 'placeholder' : '', text || 'Not provided / pending confirmation');
      if (typeof item === 'object' && item.fact_ids?.length) line.append(node('small', 'source-tag', `Source: ${item.fact_ids.join(', ')}`));
      block.append(line);
    }
    return block;
  }));
}

function renderReview() {
  resetCurrentReferences();
  renderReportSections();
  const reviewable = Boolean(currentValidation?.data?.can_enter_technician_review);
  el['validator-banner'].className = `validator-banner ${reviewable ? 'pass' : 'fail'}`;
  el['validator-banner'].textContent = reviewable ? `Validation ${currentValidation.status}: this exact version can enter technician review.` : `Validation ${currentValidation?.status || 'FAIL'}: resolve validation issues before confirmation.`;
  el['validator-output'].textContent = JSON.stringify(currentValidation, null, 2);
  el['fact-count'].textContent = String(currentFacts.length);
  const issueCount = activeSession?.unresolvedItems?.filter((item) => !item.answer).length || 0;
  el['issue-count'].textContent = String(issueCount);
  el['validation-label'].textContent = currentValidation?.status || 'Waiting';
  const transient = runtime.getTransient(activeSession.id);
  el['technician-name'].value = transient.technicianName || '';
  el['technician-id'].value = transient.technicianId || '';
  el['confirm-check'].checked = false;
  el['confirm-report'].disabled = true;
  el['confirmation-status'].textContent = reviewable ? 'Review and confirm this exact version.' : 'Confirmation is blocked by validation.';
  invalidateConfirmation(el['confirmation-status'].textContent);
}

async function confirmCurrentReport() {
  const technicianName = el['technician-name'].value.trim();
  const technicianId = el['technician-id'].value.trim();
  if (!technicianName || !technicianId) throw new Error('Technician name and ID are required.');
  const isHvac = activeSession.scope === 'HVAC';
  const endpoint = isHvac ? FINALIZATION_ROUTES.HVAC.confirm : FINALIZATION_ROUTES.SBS.confirm;
  const result = await api(endpoint, { draft: currentDraft, validator_run_id: currentValidation.trace_id, technician_id: technicianId, technician_name: technicianName });
  confirmationToken = result.data.confirmation.confirmation_token;
  activeSession.confirmation = result.data.confirmation;
  activeSession.jobContext = { technicianId, technicianName };
  activeSession.status = 'CONFIRMED';
  activeSession.updatedAt = new Date().toISOString();
  addAudit('Report confirmed', `${technicianName} · ${technicianId}`);
  el['save-report'].disabled = false;
  el['export-report'].disabled = false;
  el['complete-meta'].replaceChildren(node('span', '', `Report: ${currentDraft.report_id} · version ${currentDraft.report_version}`), node('span', '', `Schema: ${activeSession.schemaId} · ${activeSession.schemaVersion}`), node('span', '', `Confirmed: ${result.data.confirmation.confirmed_at}`), node('span', '', `Hash: ${result.data.confirmation.report_hash}`));
  navigate('complete');
  renderReports();
}

async function saveOrExport(kind) {
  const isHvac = activeSession.scope === 'HVAC';
  const endpoint = isHvac ? FINALIZATION_ROUTES.HVAC[kind] : FINALIZATION_ROUTES.SBS[kind];
  const result = await api(endpoint, { draft: currentDraft, confirmation_token: confirmationToken });
  activeSession.exportState.files.push(result.data.file);
  if (kind === 'save') {
    activeSession.exportState.saved = true;
    el['complete-summary'].textContent = `Official JSON saved at ${result.data.file}`;
    addAudit('Official JSON saved', result.data.file);
  } else {
    el['export-output'].value = result.data.copyable_text;
    el['export-output'].hidden = false;
    el['copy-export'].disabled = false;
    el['complete-summary'].textContent = 'Copyable text export is ready. The official confirmation binding remains intact.';
    addAudit('Text export created', result.data.file);
  }
}

async function uploadSbsDocument(file) {
  if (!activeSession || activeSession.scope === 'HVAC') return;
  const scopeAtStart = activeSession.scope;
  el['v2-upload-status'].textContent = `Uploading ${file.name}…`;
  try {
    const result = await apiRaw('/api/v2/uploads', file, { 'x-file-name': file.name, 'x-scope-id': scopeAtStart, 'x-mime-type': file.type || 'application/octet-stream', 'x-uploader': el['v2-uploader'].value || 'demo-technician', 'x-scenario': 'report-capture', 'content-type': 'application/octet-stream' });
    if (!activeSession || activeSession.scope !== scopeAtStart) return;
    activeSession.evidence.push(result.data.upload);
    el['v2-upload-status'].textContent = result.data.upload.status === 'READY' ? `${file.name} attached and indexed in ${scopeAtStart}.` : `${file.name} could not be processed.`;
    addAudit('Reference document uploaded', `${file.name} · ${result.data.upload.status}`);
  } catch (error) { el['v2-upload-status'].textContent = `Upload failed: ${error.message}`; }
}

function renderUploadRow(upload) {
  const row = node('div', 'upload-row');
  row.append(node('span', 'name', upload.filename || upload.upload_id || '—'), node('span', 'status-badge', upload.status || 'UNKNOWN'), node('span', 'meta', `${upload.scope_id || '—'} · ${upload.chunk_count ?? 0} chunks`));
  return row;
}

async function refreshKnowledgeUploads() {
  if (!sessionToken) return renderEmptyState(el['v2-upload-list'], { title: 'Sign in to view uploads', message: 'Upload records appear after the demo session is established.' });
  const scopeAtStart = knowledgeScope;
  const generation = ++knowledgeRequestGeneration;
  try {
    const result = await api(`/api/v2/uploads?scope_id=${encodeURIComponent(scopeAtStart)}`);
    if (generation !== knowledgeRequestGeneration || scopeAtStart !== knowledgeScope) return;
    const uploads = result.data?.uploads || [];
    el['v2-upload-list'].replaceChildren(...(uploads.length ? uploads.map(renderUploadRow) : [node('p', 'supporting', 'No upload records in this scope yet.')]));
  } catch (error) { el['v2-upload-list'].replaceChildren(node('p', 'supporting', `Could not load uploads: ${error.message}`)); }
}

function setKnowledgeScope(scope) {
  knowledgeTransients.set(knowledgeScope, { query: el['v2-retrieve-query'].value });
  knowledgeScope = scope;
  const schema = scope === 'SBS_BUS' ? REPORT_SCHEMAS.SBS_BUS : REPORT_SCHEMAS.SBS_RAIL;
  el['v2-retrieve-query'].value = knowledgeTransients.get(scope)?.query || '';
  el['scope-selector-status'].textContent = `${schema.name} · scope isolated`;
  el['v2-upload-scope-hint'].textContent = `Documents stay inside ${schema.name}.`;
  el['v2-retrieve-scope-hint'].textContent = `Search cannot return content from HVAC or the other SBS domain.`;
  for (const button of el['scope-selector-buttons'].querySelectorAll('button')) button.classList.toggle('active', button.dataset.scopeId === scope);
  el['v2-retrieve-results'].replaceChildren();
  el['v2-retrieve-warnings'].replaceChildren();
  refreshKnowledgeUploads();
}

function renderKnowledgeResults(results) {
  if (!results.length) return renderEmptyState(el['v2-retrieve-results'], { icon: '⌕', title: 'No results', message: 'Try a term that belongs to the selected scope.' });
  el['v2-retrieve-results'].replaceChildren(...results.map((item) => {
    const card = node('div', 'result-card');
    card.append(node('strong', '', item.source === 'upload' ? 'Uploaded reference' : 'Knowledge base'), node('p', '', item.text), node('p', 'prov', `Source: ${item.provenance?.file || item.doc_id || '—'} · score ${Number(item.score || 0).toFixed(2)}`));
    return card;
  }));
}

// The filler is deliberately non-submitting; security tests assert this handler stays free of network calls.
el['fill-demo'].addEventListener('click', () => {
  el['manual-transcript'].value = activeSession ? examples[activeSession.scope] : demoNarration;
  el['transcription-status'].textContent = 'Synthetic example filled in. Review it, then choose Continue.';
});

el['auth-submit'].addEventListener('click', (event) => { event.preventDefault(); unlockWithToken(el['auth-token'].value); });
el['auth-token'].addEventListener('keydown', (event) => { if (event.key === 'Enter') el['auth-submit'].click(); });
el['refresh-health'].addEventListener('click', () => refreshHealth().catch((error) => { el['health-summary'].textContent = `Health check failed: ${error.message}`; }));
el['mobile-menu'].addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-nav]');
  if (nav) { if (currentView === 'capture') saveTransientFromDom(); if (nav.dataset.nav === 'reports') renderReports(); navigate(nav.dataset.nav); }
});
document.getElementById('report-type-grid').addEventListener('click', (event) => { const card = event.target.closest('[data-report-type]'); if (card) createNewReport(card.dataset.reportType); });
el['report-search'].addEventListener('input', renderReports);
for (const filter of document.querySelectorAll('.filter')) filter.addEventListener('click', () => { document.querySelector('.filter.active')?.classList.remove('active'); filter.classList.add('active'); renderReports(); });
for (const id of ['open-evidence', 'review-evidence']) el[id].addEventListener('click', showEvidence);
el['close-evidence'].addEventListener('click', hideEvidence);
el['drawer-backdrop'].addEventListener('click', hideEvidence);

el['start-recording'].addEventListener('click', async () => {
  el['start-recording'].disabled = true;
  try { recorder = new PcmWavRecorder(); const { sampleRate } = await recorder.start(); el['stop-recording'].disabled = false; el['recording-status'].textContent = `Recording ${sampleRate} Hz input…`; recordingTimer = setTimeout(() => el['stop-recording'].click(), 90_000); }
  catch (error) { el['recording-status'].textContent = `Cannot start recording: ${error.message}`; el['start-recording'].disabled = false; }
});
el['stop-recording'].addEventListener('click', async () => {
  clearTimeout(recordingTimer); el['stop-recording'].disabled = true;
  try { const wav = await recorder.stop(); selectAudio(wav, `Recording ready · ${Math.round(wav.size / 1024)} KB`); }
  catch (error) { el['recording-status'].textContent = `Failed to stop recording: ${error.message}`; }
  finally { recorder = null; el['start-recording'].disabled = false; }
});
el['audio-file'].addEventListener('change', () => { const file = el['audio-file'].files?.[0]; if (file) selectAudio(file, `Selected ${file.name}`); });
el.transcribe.addEventListener('click', () => transcribe(1));
el.retry.addEventListener('click', () => transcribe(2));
el['v2-upload-file'].addEventListener('change', () => { const file = el['v2-upload-file'].files?.[0]; if (file) uploadSbsDocument(file); });

el['use-manual'].addEventListener('click', async () => {
  const raw = el['manual-transcript'].value.trim();
  if (!activeSession || !raw) { el['transcription-status'].textContent = 'Enter or record a service statement first.'; return; }
  saveTransientFromDom(); invalidateConfirmation();
  activeSession.status = 'PROCESSING';
  const requestToken = runtime.beginRequest(activeSession.id, 'process-statement');
  el['use-manual'].disabled = true; el['use-manual'].textContent = 'Organising report…'; el['transcription-status'].textContent = 'Preserving the original statement and checking grounded facts…';
  try {
    if (activeSession.scope === 'HVAC') {
      const result = currentTranscript?.raw_text === raw ? { data: { transcript: currentTranscript } } : await api('/api/transcripts/manual', { raw_text: raw, language: 'zh' });
      if (!runtime.accepts(requestToken)) return;
      acceptTranscript(result.data.transcript, 'Manual statement saved as the immutable original.');
      await prepareHvacResolve();
    } else await processSbsStatement(raw, requestToken);
  } catch (error) { if (runtime.accepts(requestToken)) el['transcription-status'].textContent = `Could not prepare the report (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`; }
  finally { el['use-manual'].disabled = false; el['use-manual'].textContent = 'Continue'; }
});
el['build-report'].addEventListener('click', prepareHvacResolve);

el['confirm-corrections'].addEventListener('click', async () => {
  if (!activeSession) return;
  const technicianName = el['correction-technician-name'].value.trim();
  const technicianId = el['correction-technician-id'].value.trim();
  if (!technicianName || !technicianId) { el['correction-status'].textContent = 'Technician name and ID are required.'; return; }
  runtime.setTransient(activeSession.id, { ...runtime.getTransient(activeSession.id), technicianName, technicianId });
  el['confirm-corrections'].disabled = true;
  try {
    if (activeSession.scope === 'HVAC' && activeSession.hvacMissingPhase) {
      collectGenericResolveDecisions();
      for (const item of activeSession.unresolvedItems) manualFields[item.fieldId] = item.answer.decision === 'CONFIRM' ? item.answer.value : '未提供/待确认';
      activeSession.hvacMissingPhase = false;
      activeSession.hvacMissingResolved = true;
      addAudit('Missing fields resolved', `${activeSession.unresolvedItems.length} explicit decisions`);
      await generateHvacReport();
    } else if (activeSession.scope === 'HVAC') {
      const decisions = (currentNormalization.data.correction_candidates || []).map((candidate) => {
        const selected = el['correction-list'].querySelector(`input[name="decision-${candidate.candidate_id}"]:checked`);
        const verified = !el['correction-list'].querySelector(`[data-critical-candidate-id="${candidate.candidate_id}"]`) || el['correction-list'].querySelector(`[data-critical-candidate-id="${candidate.candidate_id}"]`).checked;
        if (!selected || !verified) throw new Error('Choose a decision and verify each critical candidate.');
        return { candidate_id: candidate.candidate_id, decision: selected.value, critical_value_verified: verified };
      });
      const result = await api('/api/corrections/confirm', { transcript_artifact_id: currentTranscript.artifact_id, candidate_bundle_hash: currentNormalization.data.candidate_bundle_hash, decisions, technician_id: technicianId, technician_name: technicianName });
      currentCorrectionReceipt = result.data.correction_receipt;
      activeSession.correctionReceipt = currentCorrectionReceipt;
      activeSession.corrections = decisions;
      addAudit('Transcript decisions confirmed', `${decisions.length} decisions`);
      await generateHvacReport();
    } else {
      collectGenericResolveDecisions();
      addAudit('Unresolved items completed', `${activeSession.unresolvedItems.length} decisions`);
      await buildSbsReport();
    }
  } catch (error) { el['correction-status'].textContent = error.message; }
  finally { el['confirm-corrections'].disabled = false; }
});

el['confirm-check'].addEventListener('change', () => { el['confirm-report'].disabled = !el['confirm-check'].checked || !currentValidation?.data?.can_enter_technician_review; });
el['confirm-report'].addEventListener('click', async () => { el['confirm-report'].disabled = true; try { await confirmCurrentReport(); } catch (error) { el['confirmation-status'].textContent = `Confirmation failed: ${error.message}`; el['confirm-report'].disabled = false; } });
el['save-report'].addEventListener('click', () => saveOrExport('save').catch((error) => { el['complete-summary'].textContent = `Save failed: ${error.message}`; }));
el['export-report'].addEventListener('click', () => saveOrExport('export').catch((error) => { el['complete-summary'].textContent = `Export failed: ${error.message}`; }));
el['copy-export'].addEventListener('click', async () => { await navigator.clipboard.writeText(el['export-output'].value); el['complete-summary'].textContent = 'Exported text copied.'; });

el['scope-selector-buttons'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope-id]');
  if (!button) return;
  setKnowledgeScope(button.dataset.scopeId);
  if (v2Wt.active) v2WtRestart();
});
el['v2-retrieve-submit'].addEventListener('click', async () => {
  const scopeAtStart = knowledgeScope; const generation = ++knowledgeRequestGeneration; const query = el['v2-retrieve-query'].value.trim();
  el['v2-retrieve-submit'].disabled = true; el['v2-retrieve-status'].textContent = 'Searching within the selected scope…';
  try {
    const result = await api('/api/v2/retrieve', { context_id: scopeMeta[scopeAtStart].contextId, query, top_k: Number(el['v2-retrieve-topk'].value) || 5, include_uploads: true });
    if (generation !== knowledgeRequestGeneration || scopeAtStart !== knowledgeScope) return;
    const warnings = result.warnings || [];
    el['v2-retrieve-warnings'].replaceChildren(...warnings.map((warning) => node('p', 'warning-line', warning === 'CROSS_DOMAIN_BLOCKED' ? 'Cross-domain content was blocked.' : warning)));
    renderKnowledgeResults(result.data.results || []); el['v2-retrieve-status'].textContent = `${result.data.results?.length || 0} results.`;
  } catch (error) { if (generation === knowledgeRequestGeneration) el['v2-retrieve-status'].textContent = `Search failed: ${error.message}`; }
  finally { el['v2-retrieve-submit'].disabled = false; }
});

const v2Wt = { active: false, index: 0 };
const walkthroughStatement = examples.SBS_BUS;
function v2WtSteps() {
  const domain = knowledgeScope === 'SBS_RAIL' ? 'SBS / Rail' : 'SBS / Bus';
  return [
    [t('walkthrough.scope.title'), t('walkthrough.scope.description', { domain })],
    [t('walkthrough.upload.title'), t('walkthrough.upload.description')],
    [t('walkthrough.retrieval.title'), t('walkthrough.retrieval.description')],
    [t('walkthrough.statement.title'), t('walkthrough.statement.description')],
    [t('walkthrough.facts.title'), t('walkthrough.facts.description', { count: currentFacts.length })],
    [t('walkthrough.report.title'), t('walkthrough.report.description')],
    [t('walkthrough.done.title'), t('walkthrough.done.description')],
  ];
}
function v2WtSampleDoc() { return knowledgeScope === 'SBS_RAIL' ? 'SBS-Rail-Door-Bulletin.txt' : 'SBS-Bus-Door-Service-Note.txt'; }
function v2WtQuery() { return knowledgeScope === 'SBS_RAIL' ? 'C751A door inspection' : 'MAN A95 door module'; }
function v2WtTarget(selector) {
  document.querySelector('.walkthrough-target')?.classList.remove('walkthrough-target');
  const target = document.querySelector(selector);
  target?.classList.add('walkthrough-target');
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function v2WtRender() {
  const steps = v2WtSteps();
  const [title, description] = steps[v2Wt.index];
  el['v2-wt-step'].textContent = `STEP ${v2Wt.index + 1} OF ${steps.length}`;
  el['v2-wt-title'].textContent = title;
  el['v2-wt-desc'].textContent = `${description}${v2Wt.index === 1 ? ` Example: ${v2WtSampleDoc()}` : ''}${v2Wt.index === 2 ? ` Example: ${v2WtQuery()}` : ''}`;
  el['v2-wt-progress'].style.opacity = String(.35 + (v2Wt.index + 1) / steps.length * .65);
  el['v2-wt-next'].textContent = v2Wt.index === steps.length - 1 ? 'Finish' : 'Next';
  if (v2Wt.index === 0) { navigate('new-report'); v2WtTarget('[data-report-type="sbs_bus_maintenance"]'); }
  if (v2Wt.index === 1) { navigate('capture'); v2WtTarget('#sbs-source-row'); }
  if (v2Wt.index === 2) { navigate('knowledge'); setKnowledgeScope(activeSession?.scope === 'SBS_RAIL' ? 'SBS_RAIL' : 'SBS_BUS'); el['v2-retrieve-query'].value = v2WtQuery(); v2WtTarget('#v2-retrieve-submit'); }
  if (v2Wt.index === 3) { navigate('capture'); el['manual-transcript'].value = activeSession?.scope === 'SBS_RAIL' ? examples.SBS_RAIL : walkthroughStatement; v2WtTarget('#manual-transcript'); }
  if (v2Wt.index === 4) v2WtTarget('#correction-list');
  if (v2Wt.index === 5) v2WtTarget('#report-section');
  if (v2Wt.index === 6) v2WtTarget('#confirm-section');
}
function v2WtStop() { v2Wt.active = false; el['v2-walkthrough'].hidden = true; document.querySelector('.walkthrough-target')?.classList.remove('walkthrough-target'); }
function v2WtRestart() { if (!v2Wt.active) return; v2Wt.index = 0; v2WtRender(); }
function v2WtStart() { if (v2Wt.active) v2WtStop(); v2Wt.active = true; v2Wt.index = 0; el['v2-walkthrough'].hidden = false; v2WtRender(); }
async function v2WtAdvance() {
  el['v2-wt-next'].disabled = true;
  try {
    if (v2Wt.index === 0) createNewReport(knowledgeScope === 'SBS_RAIL' ? 'sbs_rail_maintenance' : 'sbs_bus_maintenance');
    if (v2Wt.index === 1) {
      const sample = new File(['Synthetic walkthrough reference: inspect the door mechanism and record the actual on-site result.'], v2WtSampleDoc(), { type: 'text/plain' });
      await uploadSbsDocument(sample);
    }
    if (v2Wt.index === 2) {
      const result = await api('/api/v2/retrieve', { context_id: scopeMeta[activeSession.scope].contextId, query: v2WtQuery(), top_k: 5, include_uploads: true });
      activeSession.knowledgeHits = (result.data.results || []).map((item) => item.text);
      renderKnowledgeResults(result.data.results || []);
    }
    if (v2Wt.index === 3) {
      const raw = el['manual-transcript'].value.trim();
      runtime.setTransient(activeSession.id, { statement: raw });
      const token = runtime.beginRequest(activeSession.id, 'walkthrough-statement');
      await processSbsStatement(raw, token);
    }
    if (v2Wt.index === 4 && currentView === 'resolve') {
      for (const item of activeSession.unresolvedItems) item.answer = { decision: 'NOT_PROVIDED', value: null };
      addAudit('Walkthrough marked missing sections as pending', 'Synthetic guided walkthrough');
      await buildSbsReport();
    }
    if (v2Wt.index >= v2WtSteps().length - 1) return v2WtStop();
    v2Wt.index += 1;
    v2WtRender();
  } catch (error) {
    el['v2-wt-desc'].textContent = `The walkthrough could not continue: ${error.message}`;
  } finally { el['v2-wt-next'].disabled = false; }
}
el['v2-walkthrough-start'].addEventListener('click', v2WtStart);
el['v2-wt-skip'].addEventListener('click', v2WtStop);
el['v2-wt-next'].addEventListener('click', v2WtAdvance);
el['v2-demo-play'].addEventListener('click', async () => {
  if (v2Wt.active) v2WtStop();
  el['v2-demo-play'].disabled = true;
  el['v2-demo-fixes'].hidden = true;
  el['v2-demo-captions'].textContent = '';
  try {
    const session = createReportSession({ reportType: 'sbs_bus_maintenance' });
    session.audit = []; session.status = 'CAPTURE'; session.demo = true;
    sessions.set(session.id, session); activateSession(session); addAudit('Synthetic guided demo started', 'No real customer or asset data');
    navigate('help');
    el['v2-demo-status'].textContent = 'Simulating an on-site recording…';
    const misheard = 'Preventive maintenance on bus MAN A ninety five. The front door would not close. Inspection found the door control modular was faulty.';
    for (const word of misheard.split(' ')) { el['v2-demo-captions'].textContent += `${word} `; await new Promise((resolve) => setTimeout(resolve, 24)); }
    el['v2-demo-fix-list'].replaceChildren(node('div', 'resolve-item', 'A ninety five → A95'), node('div', 'resolve-item', 'door control modular → door control module'));
    el['v2-demo-fixes'].hidden = false;
    el['v2-demo-status'].textContent = 'Applying synthetic terminology decisions, then running the real extraction and report builder…';
    el['manual-transcript'].value = examples.SBS_BUS;
    runtime.setTransient(session.id, { statement: examples.SBS_BUS });
    const token = runtime.beginRequest(session.id, 'demo-statement');
    await processSbsStatement(examples.SBS_BUS, token);
    if (currentView === 'resolve') {
      for (const item of activeSession.unresolvedItems) item.answer = { decision: 'NOT_PROVIDED', value: null };
      addAudit('Demo explicitly marked missing sections pending', 'Synthetic demo decision');
      await buildSbsReport();
    }
    el['v2-demo-status'].textContent = 'Demo report ready for review. No technician confirmation was applied.';
  } catch (error) {
    el['v2-demo-status'].textContent = `Demo stopped: ${error.message}`;
  } finally { el['v2-demo-play'].disabled = false; }
});

for (const button of el.journey.querySelectorAll('button')) button.addEventListener('click', () => { if (!button.disabled) { if (button.dataset.step === 'review') renderReview(); navigate(button.dataset.step); } });

renderReports();
setKnowledgeScope('SBS_BUS');
initializeSession();
