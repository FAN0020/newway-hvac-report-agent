import { PcmWavRecorder } from './audio-recorder.js';
import { t } from './i18n.js';
import {
  REPORT_SCHEMAS,
  applyResolveAnswer,
  applyTranscriptArtifact,
  bindSessionConfirmation,
  confirmationViewState,
  correctionDecisionPayload,
  createReportSession,
  createResolveQueue,
  createSessionRuntime,
  factsFromStructuredState,
  globalViewStatus,
  hasMaterialReportChange,
  invalidateSessionConfirmation,
  knowledgeQueryState,
  mapFactsToStructuredState,
  reportSearchText,
  schemaFor,
  transcriptSourceLabel,
} from './report-runtime.js';

const ids = [
  'auth-gate', 'auth-token', 'auth-submit', 'auth-status', 'network-mode', 'network-warning',
  'page-title', 'page-eyebrow', 'topbar-status', 'mobile-menu', 'journey', 'reports-list', 'report-search',
  'context-icon', 'context-title', 'context-schema', 'sbs-source-row', 'open-evidence', 'review-evidence',
  'evidence-drawer', 'close-evidence', 'drawer-backdrop', 'audit-timeline', 'fill-demo',
  'refresh-health', 'health-summary', 'health-details', 'start-recording', 'stop-recording', 'audio-file',
  'recording-status', 'audio-preview', 'language', 'model', 'transcribe', 'retry', 'type-instead', 'manual-entry',
  'manual-transcript', 'manual-source-hint', 'statement-ready', 'statement-source', 'view-statement', 'edit-statement', 'statement-preview',
  'use-manual', 'transcription-status', 'transcript-output', 'artifact-output', 'build-report',
  'transcript-source', 'transcript-history',
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
let recordingElapsedTimer;
let recordingStartedAt = 0;
let recordingSessionId;
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
let knowledgeSearchPending = false;
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
  renderTranscriptEvidence();
  renderAudit();
}

function hideEvidence() {
  el['evidence-drawer'].hidden = true;
  el['drawer-backdrop'].hidden = true;
}

function renderTranscriptEvidence() {
  const artifact = activeSession?.transcriptArtifact;
  el['transcript-source'].textContent = artifact ? transcriptSourceLabel(artifact) : 'No source yet';
  el['transcript-output'].textContent = artifact?.raw_text || 'No transcript captured for this report.';
  el['transcript-output'].classList.toggle('empty', !artifact);
  el['artifact-output'].textContent = artifact ? JSON.stringify(artifact, null, 2) : '—';
  const history = activeSession?.transcriptHistory || [];
  el['transcript-history'].replaceChildren(...history.map((item) => {
    const entry = node('article');
    entry.append(node('small', '', `${transcriptSourceLabel(item)} · immutable earlier version`), document.createTextNode(item.raw_text));
    return entry;
  }));
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
  else el['topbar-status'].textContent = globalViewStatus(view, knowledgeScope);
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
    const confirmedComplete = button.dataset.step === 'complete' && Boolean(activeSession?.confirmation);
    button.disabled = !activeSession || (buttonIndex > index && !confirmedComplete) || (buttonIndex === 1 && step !== 'resolve' && !activeSession.visitedResolve);
  }
}

function saveTransientFromDom() {
  if (!activeSession) return;
  activeSession.capture.language = el.language.value;
  activeSession.capture.model = el.model.value;
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
  if (activeSession) {
    el.language.value = activeSession.capture.language;
    el.model.value = activeSession.capture.model;
  }
}

function restoreSessionUi() {
  const capture = activeSession?.capture;
  const artifact = activeSession?.transcriptArtifact;
  el['audio-preview'].hidden = !capture?.previewUrl;
  el['audio-preview'].src = capture?.previewUrl || '';
  el.transcribe.disabled = true;
  const transcriptionFailed = activeSession?.processing.status === 'error' && /^Transcription failed:/i.test(activeSession.processing.error || '');
  el.retry.hidden = !transcriptionFailed;
  el.retry.disabled = !transcriptionFailed;
  const ownsRecording = Boolean(recorder && recordingSessionId === activeSession?.id);
  const anotherReportRecording = Boolean(recorder && recordingSessionId !== activeSession?.id);
  el['recording-status'].textContent = ownsRecording
    ? `Recording… ${formatElapsed(Date.now() - recordingStartedAt)}`
    : (anotherReportRecording ? 'A recording is active in another report.' : (activeSession?.processing.error || (artifact ? 'Statement ready.' : (capture?.audioBlob ? 'Audio ready for transcription.' : 'Ready to record.'))));
  el['manual-entry'].hidden = !capture?.manualEntryOpen;
  el['statement-ready'].hidden = !artifact;
  el['statement-source'].textContent = artifact ? transcriptSourceLabel(artifact) : 'Captured statement';
  el['statement-preview'].textContent = artifact?.raw_text || '';
  el['statement-preview'].hidden = true;
  el['view-statement'].setAttribute('aria-expanded', 'false');
  el['manual-source-hint'].textContent = artifact ? 'Saving changes creates a new edited transcript and keeps this source immutable.' : 'Typed text is stored as manual input.';
  el['transcription-status'].textContent = activeSession?.processing.status === 'processing' ? 'Processing…' : (artifact ? 'Statement ready.' : 'Waiting for a statement.');
  el['start-recording'].hidden = ownsRecording;
  el['start-recording'].disabled = anotherReportRecording;
  el['start-recording'].classList.toggle('recording', ownsRecording);
  el['stop-recording'].hidden = !ownsRecording;
  el['stop-recording'].disabled = !ownsRecording;
  renderTranscriptEvidence();
  el['complete-summary'].textContent = activeSession?.complete.summary || '';
  renderCompleteMeta(activeSession?.complete.meta || '');
  el['export-output'].value = activeSession?.complete.copyableText || '';
  el['export-output'].hidden = !activeSession?.complete.copyableText;
  el['copy-export'].disabled = !activeSession?.complete.copyableText;
  el['save-report'].disabled = !activeSession?.confirmation;
  el['export-report'].disabled = !activeSession?.confirmation;
  el['use-manual'].disabled = !(artifact || el['manual-transcript'].value.trim());
  el['use-manual'].textContent = 'Continue';
  el['confirm-corrections'].disabled = false;
}

function renderCompleteMeta(meta) {
  el['complete-meta'].replaceChildren(...String(meta || '').split('\n').filter(Boolean).map((line) => node('span', '', line)));
}

function activateSession(session) {
  if (activeSession) saveTransientFromDom();
  activeSession = session;
  runtime.activate(session);
  resetCurrentReferences();
  restoreTransientToDom();
  restoreSessionUi();
  updateCaptureContext();
  if (session.capture.audioBlob && !session.transcriptArtifact && session.processing.status === 'idle') transcribe(1, session);
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
  const lastReference = activeSession.evidence?.at(-1);
  el['v2-upload-status'].textContent = activeSession.scope === 'HVAC' ? '' : (lastReference
    ? `${lastReference.filename || 'Supporting document'} is attached as reference material only; it is not proof that work occurred.`
    : 'Optional reference material for this report scope; it is not proof that work occurred.');
  el['topbar-status'].textContent = `${schema.name} · scope locked`;
}

function renderReports() {
  const query = el['report-search'].value.trim().toLowerCase();
  const filter = document.querySelector('.filter.active')?.dataset.filter || 'all';
  const rows = [...sessions.values()].filter((session) => {
    const confirmed = Boolean(session.confirmation);
    const matchesFilter = filter === 'all' || (filter === 'confirmed' ? confirmed : !confirmed);
    return matchesFilter && reportSearchText(session).includes(query);
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
    el['topbar-status'].textContent = globalViewStatus(currentView, knowledgeScope);
    renderReports();
    await refreshKnowledgeUploads();
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
  if (activeSession) invalidateSessionConfirmation(activeSession);
  el['save-report'].disabled = true;
  el['export-report'].disabled = true;
  el['copy-export'].disabled = true;
  el['export-output'].hidden = true;
  el['export-output'].value = '';
  el['complete-summary'].textContent = '';
  renderCompleteMeta('');
  el['confirmation-status'].textContent = message;
  if (activeSession) updateJourney(currentView);
  renderReports();
}

function invalidateConfirmationIfMaterialChanged(message) {
  if (activeSession?.confirmation && hasMaterialReportChange(activeSession)) invalidateConfirmation(message);
}

function acceptTranscript(artifact, message, session = activeSession) {
  applyTranscriptArtifact(session, artifact);
  runtime.setTransient(session.id, { ...runtime.getTransient(session.id), statement: artifact.raw_text });
  session.capture.manualEntryOpen = false;
  session.audit ||= [];
  session.audit.push({ label: 'Statement source captured', detail: `${transcriptSourceLabel(artifact)} · ${artifact.artifact_id}`, at: new Date().toISOString() });
  if (session.confirmation && hasMaterialReportChange(session)) invalidateSessionConfirmation(session);
  if (activeSession?.id !== session.id) return;
  currentTranscript = session.transcriptArtifact;
  invalidateConfirmationIfMaterialChanged('The source statement changed; validation and confirmation are required again.');
  renderTranscriptEvidence();
  renderAudit();
  el['statement-ready'].hidden = false;
  el['statement-source'].textContent = transcriptSourceLabel(artifact);
  el['statement-preview'].textContent = artifact.raw_text;
  el['manual-entry'].hidden = true;
  el.retry.hidden = true;
  el.retry.disabled = true;
  el['recording-status'].textContent = 'Statement ready.';
  el['use-manual'].disabled = false;
  el['transcription-status'].textContent = message;
}

function selectAudio(blob, message, session = activeSession) {
  if (!session) return;
  const capture = session.capture;
  capture.audioBlob = blob;
  capture.audioId = null;
  if (capture.previewUrl) URL.revokeObjectURL(capture.previewUrl);
  capture.previewUrl = URL.createObjectURL(blob);
  if (activeSession?.id !== session.id) return;
  el.retry.hidden = true;
  el.retry.disabled = true;
  el['recording-status'].textContent = message;
  el['audio-preview'].src = capture.previewUrl;
  el['audio-preview'].hidden = false;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function stopRecordingClock() {
  clearTimeout(recordingTimer);
  clearInterval(recordingElapsedTimer);
  recordingTimer = null;
  recordingElapsedTimer = null;
}

async function finishRecording() {
  if (!recorder || !recordingSessionId) return;
  stopRecordingClock();
  const ownedRecorder = recorder;
  const targetSession = sessions.get(recordingSessionId);
  if (activeSession?.id === targetSession?.id) {
    el['stop-recording'].disabled = true;
    el['recording-status'].textContent = 'Preparing recording…';
  }
  try {
    const wav = await ownedRecorder.stop();
    selectAudio(wav, `Recording captured · ${Math.round(wav.size / 1024)} KB`, targetSession);
    recorder = null;
    recordingSessionId = null;
    if (activeSession?.id === targetSession?.id) await transcribe(1, targetSession);
  } catch (error) {
    if (activeSession?.id === targetSession?.id) {
      el['recording-status'].textContent = `Could not finish the recording: ${error.message}`;
      el['transcription-status'].textContent = 'Use Type instead or upload a valid WAV recording.';
    }
  } finally {
    if (recorder === ownedRecorder) recorder = null;
    recordingSessionId = null;
    if (activeSession?.id === targetSession?.id) restoreSessionUi();
    else {
      el['start-recording'].hidden = false;
      el['start-recording'].disabled = false;
      el['stop-recording'].hidden = true;
    }
  }
}

async function uploadIfNeeded(session, requestToken) {
  if (session.capture.audioId) return session.capture.audioId;
  const result = await apiRaw('/api/audio', session.capture.audioBlob, { 'content-type': 'audio/wav' });
  if (!runtime.accepts(requestToken)) return null;
  session.capture.audioId = result.data.audio_id;
  return session.capture.audioId;
}

async function transcribe(attempt, session = activeSession) {
  if (!session) return;
  const requestToken = runtime.beginRequest(session.id, 'transcribe');
  if (activeSession?.id === session.id) {
    session.capture.language = el.language.value;
    session.capture.model = el.model.value;
  }
  session.processing = { status: 'processing', error: null };
  if (activeSession?.id === session.id) {
    el['start-recording'].hidden = false;
    el['start-recording'].disabled = true;
    el['stop-recording'].hidden = true;
    el['use-manual'].disabled = true;
    el.retry.hidden = true;
    el.retry.disabled = true;
    el['recording-status'].textContent = 'Transcribing…';
    el['transcription-status'].textContent = 'Transcribing locally…';
  }
  try {
    const audioId = await uploadIfNeeded(session, requestToken);
    if (!audioId) return;
    const result = await api('/api/transcriptions', { audio_id: audioId, model: session.capture.model, language: session.capture.language, attempt, idempotency_key: `${audioId}:${session.capture.model}:${session.capture.language}:attempt-${attempt}` });
    if (!runtime.accepts(requestToken)) return;
    acceptTranscript(result.data.transcript, result.data.reused ? 'Statement ready · reused verified transcription.' : 'Statement ready.', session);
    session.processing = { status: 'idle', error: null };
    if (activeSession?.id === session.id) {
      el['manual-transcript'].value = result.data.transcript.raw_text;
      el['recording-status'].textContent = 'Statement ready.';
    }
  } catch (error) {
    if (runtime.accepts(requestToken)) {
      session.processing = { status: 'error', error: `Transcription failed: ${error.message}` };
      if (activeSession?.id === session.id) {
        const reason = String(error.message || 'Transcription failed').replace(/[.!?。！？]+$/u, '');
        el['recording-status'].textContent = 'Transcription failed.';
        el['transcription-status'].textContent = `Transcription failed (${error.result?.error_code || 'UNKNOWN'}): ${reason}. Retry once or type instead.`;
        el.retry.hidden = false;
        el.retry.disabled = attempt >= 2;
        el['use-manual'].disabled = !el['manual-transcript'].value.trim();
      }
    }
  } finally {
    if (activeSession?.id === session.id && !recorder) {
      el['start-recording'].hidden = false;
      el['start-recording'].disabled = false;
      el['stop-recording'].hidden = true;
    }
  }
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
    if (item.type === 'MISSING_FIELD' || item.type === 'CRITICAL_VALUE') {
      const input = node('textarea');
      input.rows = 2;
      input.dataset.resolveValue = item.id;
      input.value = item.type === 'CRITICAL_VALUE' ? String(activeSession.fieldStates?.[item.targetField || item.fieldId]?.value ?? '') : '';
      input.placeholder = 'Enter what the technician actually observed, or choose “not provided” below.';
      card.append(head, input, controls);
    } else if (item.type === 'CONFLICT') {
      const select = node('select');
      select.dataset.resolveValue = item.id;
      select.append(node('option', '', 'Choose the supported value'));
      for (const candidate of item.candidates || []) {
        const option = node('option', '', String(candidate.value ?? candidate));
        option.value = String(candidate.value ?? candidate);
        select.append(option);
      }
      card.append(head, select, controls);
    } else card.append(head, controls);
    return card;
  }));
  el['questions-list'].replaceChildren();
  el['correction-status'].textContent = 'Resolve each item using only observed or recorded information.';
}

function collectGenericResolveDecisions() {
  const session = activeSession;
  const items = [...session.unresolvedItems];
  for (const item of items) {
    const selected = el['correction-list'].querySelector(`input[name="${CSS.escape(item.id)}"]:checked`);
    if (!selected) throw new Error('Resolve each item before continuing.');
    const control = el['correction-list'].querySelector(`[data-resolve-value="${CSS.escape(item.id)}"]`);
    const value = control?.value.trim() || String(session.fieldStates?.[item.targetField || item.fieldId]?.value ?? '').trim();
    if (selected.value === 'CONFIRM' && !value) throw new Error('Enter or choose the observed value, or mark the item not provided.');
    item.answer = { decision: selected.value, value: selected.value === 'CONFIRM' ? value : null };
    if (selected.value === 'CONFIRM') {
      const transient = runtime.getTransient(session.id);
      Object.assign(session, applyResolveAnswer(session, item, value, {
        technicianId: transient.technicianId,
        technicianName: transient.technicianName,
      }));
    } else {
      const unresolved = session.unresolvedItems.find((candidate) => candidate.id === item.id);
      if (unresolved) unresolved.answer = item.answer;
    }
  }
  currentFacts = factsFromStructuredState(session);
  invalidateConfirmationIfMaterialChanged('Resolved report information changed; validation and confirmation are required again.');
}

async function prepareHvacResolve() {
  if (!activeSession || !currentTranscript) return;
  const session = activeSession;
  const requestToken = runtime.beginRequest(session.id, 'prepare-hvac-resolve');
  const normalization = await api('/api/normalizations', { transcript_artifact_id: currentTranscript.artifact_id });
  if (!runtime.accepts(requestToken)) return;
  currentNormalization = normalization;
  session.normalization = normalization;
  session.correctionCandidates = normalization.data.correction_candidates || [];
  session.unresolvedItems = createResolveQueue({ correctionCandidates: session.correctionCandidates, missingFields: [], conflicts: [] });
  session.processing = { status: 'idle', error: null };
  el['transcription-status'].textContent = 'Statement ready.';
  renderCorrectionReview(currentNormalization);
  addAudit('Terminology candidates prepared', `${session.correctionCandidates.length} candidates`);
  navigate('resolve');
}

async function processSbsStatement(raw, requestToken) {
  const session = activeSession;
  const meta = scopeMeta[session.scope];
  const previous = session.transcriptArtifact;
  const sameStatement = previous?.raw_text === raw;
  const editedFromArtifactId = !sameStatement && previous?.artifact_id ? previous.artifact_id : null;
  const artifact = sameStatement ? previous : {
    artifact_id: `manual_${session.id}_${(session.transcriptHistory?.length || 0) + 1}`,
    provider: 'manual',
    model: 'manual-entry',
    raw_text: raw,
    source_hash: null,
    language: 'en',
    input_mode: editedFromArtifactId ? 'EDITED_TRANSCRIPT' : 'MANUAL_TRANSCRIPT',
    edited_from_artifact_id: editedFromArtifactId,
  };
  acceptTranscript(artifact, 'Manual statement captured.');
  const extracted = await api('/api/v2/facts/extract', { context_id: meta.contextId, raw_text: raw });
  if (!runtime.accepts(requestToken)) return;
  currentFacts = extracted.data.facts || [];
  Object.assign(session, mapFactsToStructuredState(session, currentFacts));
  session.unresolvedItems = createResolveQueue(session);
  session.processing = { status: 'idle', error: null };
  el['transcription-status'].textContent = 'Statement ready.';
  addAudit('Facts extracted', `${currentFacts.length} grounded facts`);
  if (session.unresolvedItems.length) {
    renderGenericResolve(session.unresolvedItems);
    navigate('resolve');
  } else {
    await buildSbsReport(requestToken, true);
  }
}

async function buildSbsReport(existingToken, resolveMissing = false) {
  const session = activeSession;
  const requestToken = existingToken || runtime.beginRequest(session.id, 'build-sbs-report');
  const authoritativeFacts = factsFromStructuredState(session);
  const result = await api('/api/v2/reports/build', { context_id: scopeMeta[session.scope].contextId, report_session_id: session.id, facts: authoritativeFacts, knowledge_hits: session.knowledgeHits || [] }, { allowToolFailure: true });
  if (!runtime.accepts(requestToken)) return;
  if (!['PASS', 'NEEDS_CONFIRMATION'].includes(result.status)) throw new Error(result.error_code || 'Report could not be built.');
  currentDraft = result.data.draft;
  currentValidation = { trace_id: result.trace_id, status: result.status, data: { can_enter_technician_review: result.status === 'PASS', gates: result.data.gates, validation_receipt: result.data.validation_receipt } };
  session.reportDraft = currentDraft;
  session.reportDocument = currentDraft;
  session.validation = currentValidation;
  session.completeness = result.data.structured_job_state?.completeness || session.completeness;
  const missingSections = result.data.report?.missing_required_fields || [];
  if (resolveMissing && missingSections.length) {
    session.unresolvedItems = missingSections.map((fieldId, index) => ({
      id: `missing_field_${fieldId}_${index}`,
      type: 'MISSING_FIELD',
      fieldId,
      targetField: schemaFor(session.schemaId).requiredGroups.find((group) => group.id === fieldId)?.targetField || fieldId,
      severity: 'high',
      question: `No grounded information was found for ${fieldId.replaceAll('_', ' ')}.`,
      evidence: [],
      answer: null,
    }));
    renderGenericResolve(session.unresolvedItems);
    addAudit('Missing information queued for explicit review', `${missingSections.length} report sections`);
    navigate('resolve');
    return;
  }
  session.status = 'REVIEW';
  invalidateConfirmationIfMaterialChanged('The report content changed; validation and confirmation are required again.');
  addAudit('Report built and validated', result.status);
  renderReview();
  navigate('review');
}

async function generateHvacReport() {
  const session = activeSession;
  const requestToken = runtime.beginRequest(session.id, 'generate-hvac-report');
  session.processing = { status: 'processing', error: null };
  const extracted = await api('/api/facts/extract', { correction_receipt_id: currentCorrectionReceipt.correction_receipt_id, manual_fields: session.manualFields, use_llm: ollamaReady });
  if (!runtime.accepts(requestToken)) return;
  currentFacts = extracted.data.facts;
  currentFactsReceiptId = extracted.data.facts_receipt_id;
  const inputValidation = await api('/api/reports/validate-input', { facts_receipt_id: currentFactsReceiptId });
  if (!runtime.accepts(requestToken)) return;
  Object.assign(session, mapFactsToStructuredState(session, currentFacts));
  session.factsReceiptId = currentFactsReceiptId;
  session.inputValidation = inputValidation;
  const followUps = inputValidation.data.follow_up_questions || [];
  if (!session.hvacMissingResolved && followUps.length) {
    session.hvacMissingPhase = true;
    session.unresolvedItems = followUps.map(({ field, question }, index) => ({
      id: `missing_field_${field}_${index}`,
      type: 'MISSING_FIELD',
      fieldId: field,
      severity: 'high',
      question,
      evidence: [],
      answer: null,
    }));
    renderGenericResolve(session.unresolvedItems);
    addAudit('Missing information queued for explicit review', `${followUps.length} follow-up questions`);
    navigate('resolve');
    return;
  }
  const plan = await api('/api/reports/plan', { facts_receipt_id: currentFactsReceiptId, service_type: 'general_hvac' });
  if (!runtime.accepts(requestToken)) return;
  const template = await api('/api/reports/template', { template_id: 'hvac_service_report', version: '1.0.0' });
  if (!runtime.accepts(requestToken)) return;
  const generated = await api('/api/reports/generate', { facts_receipt_id: currentFactsReceiptId, report_session_id: session.id, plan: plan.data, template: template.data.template, use_llm: ollamaReady });
  if (!runtime.accepts(requestToken)) return;
  currentDraft = generated.data.draft;
  currentValidation = await api('/api/reports/validate-draft', { draft: currentDraft, facts_receipt_id: currentFactsReceiptId });
  if (!runtime.accepts(requestToken)) return;
  session.reportDraft = currentDraft;
  session.reportDocument = currentDraft;
  session.validation = currentValidation;
  session.inputValidation = inputValidation;
  session.status = 'REVIEW';
  session.processing = { status: 'idle', error: null };
  invalidateConfirmationIfMaterialChanged('The report content changed; validation and confirmation are required again.');
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
  invalidateConfirmationIfMaterialChanged('The report content changed; validation and confirmation are required again.');
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
  const confirmationState = confirmationViewState(activeSession, { reviewable });
  el['confirm-check'].checked = confirmationState.checkboxChecked;
  el['confirm-check'].disabled = confirmationState.confirmed;
  el['confirm-report'].disabled = confirmationState.confirmationDisabled;
  el['confirmation-status'].textContent = confirmationState.message;
  el['save-report'].disabled = !confirmationState.canFinalize;
  el['export-report'].disabled = !confirmationState.canFinalize;
}

async function confirmCurrentReport() {
  const session = activeSession;
  const requestToken = runtime.beginRequest(session.id, 'confirm-report');
  const technicianName = el['technician-name'].value.trim();
  const technicianId = el['technician-id'].value.trim();
  if (!technicianName || !technicianId) throw new Error('Technician name and ID are required.');
  const isHvac = session.scope === 'HVAC';
  const endpoint = isHvac ? FINALIZATION_ROUTES.HVAC.confirm : FINALIZATION_ROUTES.SBS.confirm;
  const result = await api(endpoint, { draft: currentDraft, validator_run_id: currentValidation.trace_id, technician_id: technicianId, technician_name: technicianName });
  if (!runtime.accepts(requestToken)) return;
  confirmationToken = result.data.confirmation.confirmation_token;
  bindSessionConfirmation(session, result.data.confirmation);
  session.jobContext = { technicianId, technicianName };
  session.updatedAt = new Date().toISOString();
  addAudit('Report confirmed', `${technicianName} · ${technicianId}`);
  el['save-report'].disabled = false;
  el['export-report'].disabled = false;
  session.complete.meta = `Report: ${currentDraft.report_id} · version ${currentDraft.report_version}\nSchema: ${session.schemaId} · ${session.schemaVersion}\nConfirmed: ${result.data.confirmation.confirmed_at}\nHash: ${result.data.confirmation.report_hash}`;
  renderCompleteMeta(session.complete.meta);
  navigate('complete');
  renderReports();
}

async function saveOrExport(kind) {
  const session = activeSession;
  const requestToken = runtime.beginRequest(session.id, `finalize-${kind}`);
  const isHvac = session.scope === 'HVAC';
  const endpoint = isHvac ? FINALIZATION_ROUTES.HVAC[kind] : FINALIZATION_ROUTES.SBS[kind];
  const result = await api(endpoint, { draft: currentDraft, confirmation_token: confirmationToken });
  if (!runtime.accepts(requestToken)) return;
  session.exportState.files.push(result.data.file);
  if (kind === 'save') {
    session.exportState.saved = true;
    session.complete.summary = `Official JSON saved at ${result.data.file}`;
    el['complete-summary'].textContent = session.complete.summary;
    addAudit('Official JSON saved', result.data.file);
  } else {
    el['export-output'].value = result.data.copyable_text;
    el['export-output'].hidden = false;
    el['copy-export'].disabled = false;
    session.complete.copyableText = result.data.copyable_text;
    session.complete.summary = 'Copyable text export is ready. The official confirmation binding remains intact.';
    el['complete-summary'].textContent = session.complete.summary;
    addAudit('Text export created', result.data.file);
  }
}

async function uploadSbsDocument(file) {
  if (!activeSession || activeSession.scope === 'HVAC') return;
  const session = activeSession;
  const scopeAtStart = session.scope;
  const requestToken = runtime.beginRequest(session.id, 'upload-reference');
  el['v2-upload-status'].textContent = `Uploading ${file.name}…`;
  try {
    const result = await apiRaw('/api/v2/uploads', file, { 'x-file-name': file.name, 'x-scope-id': scopeAtStart, 'x-mime-type': file.type || 'application/octet-stream', 'x-uploader': el['v2-uploader'].value || 'demo-technician', 'x-scenario': 'report-capture', 'content-type': 'application/octet-stream' });
    if (!runtime.accepts(requestToken)) return;
    session.evidence.push(result.data.upload);
    invalidateConfirmationIfMaterialChanged('Report evidence changed; validation and confirmation are required again.');
    el['v2-upload-status'].textContent = result.data.upload.status === 'READY'
      ? `${file.name} is attached as reference material only; it is not proof that work occurred.`
      : `${file.name} could not be processed.`;
    addAudit('Reference document uploaded', `${file.name} · ${result.data.upload.status}`);
  } catch (error) { if (runtime.accepts(requestToken)) el['v2-upload-status'].textContent = `Upload failed: ${error.message}`; }
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
  updateKnowledgeSearchState();
  if (currentView === 'knowledge') el['topbar-status'].textContent = globalViewStatus('knowledge', knowledgeScope);
  refreshKnowledgeUploads();
}

function updateKnowledgeSearchState() {
  const state = knowledgeQueryState(el['v2-retrieve-query'].value);
  el['v2-retrieve-submit'].disabled = knowledgeSearchPending || !state.valid;
  return state;
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
  if (!activeSession) createNewReport('hvac_service');
  else navigate('capture');
  activeSession.capture.manualEntryOpen = true;
  el['manual-entry'].hidden = false;
  el['manual-transcript'].value = examples[activeSession.scope] || demoNarration;
  runtime.setTransient(activeSession.id, { ...runtime.getTransient(activeSession.id), statement: el['manual-transcript'].value });
  el['use-manual'].disabled = false;
  el['manual-source-hint'].textContent = 'Synthetic demo text is stored as manual input only if you continue.';
  el['transcription-status'].textContent = 'Synthetic example filled in. Review it, then choose Continue.';
  el['manual-transcript'].focus();
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
el['v2-retrieve-query'].addEventListener('input', () => {
  const state = updateKnowledgeSearchState();
  if (!state.valid) el['v2-retrieve-status'].textContent = 'Enter a search term to search this scope.';
});
for (const filter of document.querySelectorAll('.filter')) filter.addEventListener('click', () => { document.querySelector('.filter.active')?.classList.remove('active'); filter.classList.add('active'); renderReports(); });
for (const id of ['open-evidence', 'review-evidence']) el[id].addEventListener('click', showEvidence);
el['close-evidence'].addEventListener('click', hideEvidence);
el['drawer-backdrop'].addEventListener('click', hideEvidence);

el['start-recording'].addEventListener('click', async () => {
  if (recorder) return;
  const session = activeSession;
  el['start-recording'].disabled = true;
  recordingSessionId = session?.id;
  el['recording-status'].textContent = 'Waiting for microphone permission…';
  try {
    recorder = new PcmWavRecorder();
    await recorder.start();
    recordingStartedAt = Date.now();
    if (activeSession?.id === session?.id) {
      el['start-recording'].hidden = true;
      el['stop-recording'].hidden = false;
      el['stop-recording'].disabled = false;
      el['recording-status'].textContent = 'Recording… 0:00';
    }
    recordingElapsedTimer = setInterval(() => {
      if (activeSession?.id === recordingSessionId) el['recording-status'].textContent = `Recording… ${formatElapsed(Date.now() - recordingStartedAt)}`;
    }, 1000);
    recordingTimer = setTimeout(() => { finishRecording(); }, 90_000);
  } catch (error) {
    recorder = null;
    recordingSessionId = null;
    if (activeSession?.id === session?.id) {
      el['recording-status'].textContent = `Microphone permission or capture failed: ${error.message}`;
      el['transcription-status'].textContent = 'Use Type instead or upload a valid WAV recording.';
      el['start-recording'].disabled = false;
    }
  }
});
el['stop-recording'].addEventListener('click', finishRecording);
el['audio-file'].addEventListener('change', async () => {
  const file = el['audio-file'].files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.wav') && file.type !== 'audio/wav') {
    el['recording-status'].textContent = 'Choose a valid WAV recording.';
    el['transcription-status'].textContent = 'The selected file was not sent.';
    return;
  }
  activeSession.capture.audioOrigin = 'upload';
  selectAudio(file, `Uploaded ${file.name}`);
  await transcribe(1);
});
el.retry.addEventListener('click', async () => transcribe(2));
el['type-instead'].addEventListener('click', () => {
  if (!activeSession) return;
  activeSession.capture.manualEntryOpen = true;
  el['manual-entry'].hidden = false;
  el['manual-source-hint'].textContent = activeSession.transcriptArtifact ? 'Saving changes creates a new edited transcript and keeps the prior source immutable.' : 'Typed text is stored as manual input.';
  el['manual-transcript'].focus();
});
el['view-statement'].addEventListener('click', () => {
  const expanded = el['statement-preview'].hidden;
  el['statement-preview'].hidden = !expanded;
  el['view-statement'].setAttribute('aria-expanded', String(expanded));
  el['view-statement'].textContent = expanded ? 'Hide transcript' : 'View transcript';
});
el['edit-statement'].addEventListener('click', () => {
  if (!activeSession) return;
  activeSession.capture.manualEntryOpen = true;
  el['manual-entry'].hidden = false;
  el['manual-transcript'].value = activeSession.transcriptArtifact?.raw_text || el['manual-transcript'].value;
  el['manual-source-hint'].textContent = 'Saving changes creates a new edited transcript and keeps the prior source immutable.';
  el['manual-transcript'].focus();
});
el['manual-transcript'].addEventListener('input', () => {
  el['use-manual'].disabled = !el['manual-transcript'].value.trim() || activeSession?.processing.status === 'processing';
});
el['v2-upload-file'].addEventListener('change', () => { const file = el['v2-upload-file'].files?.[0]; if (file) uploadSbsDocument(file); });

el['use-manual'].addEventListener('click', async () => {
  const raw = el['manual-transcript'].value.trim();
  if (!activeSession || !raw) { el['transcription-status'].textContent = 'Enter or record a service statement first.'; return; }
  saveTransientFromDom();
  activeSession.status = 'PROCESSING';
  const requestToken = runtime.beginRequest(activeSession.id, 'process-statement');
  const session = activeSession;
  session.processing = { status: 'processing', error: null };
  el['use-manual'].disabled = true; el['use-manual'].textContent = 'Organising report…'; el['transcription-status'].textContent = 'Organising report…';
  try {
    if (activeSession.scope === 'HVAC') {
      const changedSource = currentTranscript?.artifact_id && currentTranscript.raw_text !== raw ? currentTranscript : null;
      const result = currentTranscript?.raw_text === raw ? { data: { transcript: currentTranscript } } : await api('/api/transcripts/manual', {
        raw_text: raw,
        language: activeSession.capture.language === 'auto' ? (currentTranscript?.language || 'zh') : activeSession.capture.language,
        input_mode: changedSource ? 'EDITED_TRANSCRIPT' : 'MANUAL_TRANSCRIPT',
        edited_from_artifact_id: changedSource?.artifact_id || null,
      });
      if (!runtime.accepts(requestToken)) return;
      acceptTranscript(result.data.transcript, changedSource ? 'Edited statement saved; original evidence preserved.' : 'Manual statement saved as immutable input.');
      el['transcription-status'].textContent = 'Checking required information…';
      await prepareHvacResolve();
    } else {
      el['transcription-status'].textContent = 'Checking required information…';
      await processSbsStatement(raw, requestToken);
    }
  } catch (error) { if (runtime.accepts(requestToken)) { session.processing = { status: 'error', error: error.message }; el['transcription-status'].textContent = `Could not prepare the report (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`; } }
  finally { if (runtime.accepts(requestToken)) { el['use-manual'].disabled = false; el['use-manual'].textContent = 'Continue'; } }
});
el['build-report'].addEventListener('click', prepareHvacResolve);

el['confirm-corrections'].addEventListener('click', async () => {
  if (!activeSession) return;
  const session = activeSession;
  const requestToken = runtime.beginRequest(session.id, 'resolve-decisions');
  const technicianName = el['correction-technician-name'].value.trim();
  const technicianId = el['correction-technician-id'].value.trim();
  if (!technicianName || !technicianId) { el['correction-status'].textContent = 'Technician name and ID are required.'; return; }
  runtime.setTransient(activeSession.id, { ...runtime.getTransient(activeSession.id), technicianName, technicianId });
  el['confirm-corrections'].disabled = true;
  try {
    if (session.scope === 'HVAC' && session.hvacMissingPhase) {
      collectGenericResolveDecisions();
      for (const item of session.unresolvedItems) session.manualFields[item.fieldId] = item.answer.decision === 'CONFIRM' ? item.answer.value : '未提供/待确认';
      invalidateConfirmationIfMaterialChanged('Resolved report information changed; validation and confirmation are required again.');
      session.hvacMissingPhase = false;
      session.hvacMissingResolved = true;
      addAudit('Missing fields resolved', `${session.unresolvedItems.length} explicit decisions`);
      await generateHvacReport();
    } else if (session.scope === 'HVAC') {
      const decisions = (currentNormalization.data.correction_candidates || []).map((candidate) => {
        const selected = el['correction-list'].querySelector(`input[name="decision-${candidate.candidate_id}"]:checked`);
        const criticalControl = el['correction-list'].querySelector(`[data-critical-candidate-id="${candidate.candidate_id}"]`);
        const verified = !criticalControl || criticalControl.checked;
        if (!selected || !verified) throw new Error('Choose a decision and verify each critical candidate.');
        return correctionDecisionPayload({ candidateId: candidate.candidate_id, action: selected.value, critical: Boolean(criticalControl) && verified });
      });
      const result = await api('/api/corrections/confirm', { transcript_artifact_id: currentTranscript.artifact_id, candidate_bundle_hash: currentNormalization.data.candidate_bundle_hash, decisions, technician_id: technicianId, technician_name: technicianName });
      if (!runtime.accepts(requestToken)) return;
      currentCorrectionReceipt = result.data.correction_receipt;
      session.correctionReceipt = currentCorrectionReceipt;
      session.corrections = decisions;
      session.unresolvedItems = session.unresolvedItems.map((item) => {
        const candidateId = item.candidate?.candidate_id;
        const decision = decisions.find((entry) => entry.candidate_id === candidateId);
        return decision ? { ...item, answer: { decision: decision.decision, criticalValueConfirmed: decision.critical_value_confirmed === true } } : item;
      });
      invalidateConfirmationIfMaterialChanged('Transcript decisions changed; validation and confirmation are required again.');
      addAudit('Transcript decisions confirmed', `${decisions.length} decisions`);
      await generateHvacReport();
    } else {
      collectGenericResolveDecisions();
      addAudit('Unresolved items completed', `${session.unresolvedItems.length} decisions`);
      await buildSbsReport();
    }
  } catch (error) { if (runtime.accepts(requestToken)) el['correction-status'].textContent = error.message; }
  finally { if (runtime.accepts(requestToken)) el['confirm-corrections'].disabled = false; }
});

el['confirm-check'].addEventListener('change', () => { el['confirm-report'].disabled = !el['confirm-check'].checked || !currentValidation?.data?.can_enter_technician_review; });
el['confirm-report'].addEventListener('click', async () => {
  const sessionId = activeSession?.id;
  el['confirm-report'].disabled = true;
  try { await confirmCurrentReport(); }
  catch (error) { if (activeSession?.id === sessionId) { el['confirmation-status'].textContent = `Confirmation failed: ${error.message}`; el['confirm-report'].disabled = false; } }
});
el['save-report'].addEventListener('click', () => {
  const session = activeSession;
  saveOrExport('save').catch((error) => { if (activeSession?.id === session?.id) { session.complete.summary = `Save failed: ${error.message}`; el['complete-summary'].textContent = session.complete.summary; } });
});
el['export-report'].addEventListener('click', () => {
  const session = activeSession;
  saveOrExport('export').catch((error) => { if (activeSession?.id === session?.id) { session.complete.summary = `Export failed: ${error.message}`; el['complete-summary'].textContent = session.complete.summary; } });
});
el['copy-export'].addEventListener('click', async () => {
  const session = activeSession;
  const text = el['export-output'].value;
  await navigator.clipboard.writeText(text);
  if (activeSession?.id === session?.id) {
    session.complete.summary = 'Exported text copied.';
    el['complete-summary'].textContent = session.complete.summary;
  }
});

el['scope-selector-buttons'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope-id]');
  if (!button) return;
  setKnowledgeScope(button.dataset.scopeId);
  if (v2Wt.active) v2WtRestart();
});
el['v2-retrieve-submit'].addEventListener('click', async () => {
  const queryState = updateKnowledgeSearchState();
  if (!queryState.valid) { el['v2-retrieve-status'].textContent = 'Enter a search term to search this scope.'; return; }
  const scopeAtStart = knowledgeScope; const generation = ++knowledgeRequestGeneration; const query = queryState.query;
  knowledgeSearchPending = true; updateKnowledgeSearchState(); el['v2-retrieve-status'].textContent = 'Searching within the selected scope…';
  try {
    const result = await api('/api/v2/retrieve', { context_id: scopeMeta[scopeAtStart].contextId, query, top_k: Number(el['v2-retrieve-topk'].value) || 5, include_uploads: true });
    if (generation !== knowledgeRequestGeneration || scopeAtStart !== knowledgeScope) return;
    const warnings = result.data?.warnings || [];
    el['v2-retrieve-warnings'].replaceChildren(...warnings.map((warning) => node('p', 'warning-line', warning === 'CROSS_DOMAIN_BLOCKED' ? 'Cross-domain content was blocked.' : warning)));
    renderKnowledgeResults(result.data.results || []); el['v2-retrieve-status'].textContent = `${result.data.results?.length || 0} results.`;
  } catch (error) { if (generation === knowledgeRequestGeneration) el['v2-retrieve-status'].textContent = `Search failed: ${error.message}`; }
  finally { knowledgeSearchPending = false; updateKnowledgeSearchState(); }
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
