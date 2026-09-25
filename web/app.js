import { PcmWavRecorder } from './audio-recorder.js';

const ids = [
  'auth-gate', 'auth-token', 'auth-submit', 'auth-status', 'network-mode', 'network-warning', 'fill-demo',
  'refresh-health', 'health-summary', 'health-details', 'start-recording', 'stop-recording', 'audio-file',
  'recording-status', 'audio-preview', 'language', 'model', 'transcribe', 'retry', 'manual-transcript',
  'use-manual', 'transcription-status', 'transcript-output', 'artifact-output', 'build-report',
  'correction-section', 'correction-raw', 'correction-proposed', 'correction-list', 'correction-technician-name',
  'correction-technician-id', 'confirm-corrections', 'correction-status', 'correction-evidence',
  'questions-section', 'questions-list', 'apply-answers', 'evidence-section', 'facts-output', 'issues-output',
  'report-section', 'validator-banner', 'report-output', 'validator-output', 'confirm-section',
  'technician-name', 'technician-id', 'confirm-check', 'confirm-report', 'save-report', 'export-report',
  'copy-export', 'confirmation-status', 'export-output',
];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

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
let sessionToken = '';
const manualFields = {};
const sessionTokenKey = 'hvac_demo_session_token';
const demoNarration = 'The customer reports the air conditioner is not cooling. Inspection found the operating capacitor is damaged. Replaced it with a 35 µF capacitor. Test run is normal. Problem resolved. Recommendation: clean the filter at the next service.';

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
  try {
    result = await response.json();
  } catch {
    result = { status: 'FAIL', error_code: `HTTP_${response.status}` };
  }
  if (response.status === 401) requireLogin('Invalid passcode or expired session. Please re-enter.');
  if (!response.ok || (!allowToolFailure && (result.status === 'FAIL' || result.status === 'RETRYABLE_ERROR'))) {
    const error = new Error(result.data?.message || result.error_code || `HTTP ${response.status}`);
    error.result = result;
    throw error;
  }
  return result;
}

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function healthBadge(label, ready, detail) {
  const item = node('div', `health-item ${ready ? 'ready' : 'not-ready'}`);
  item.append(node('strong', '', `${ready ? '●' : '○'} ${label}`), node('span', '', detail));
  return item;
}

async function refreshHealth() {
  el['health-summary'].textContent = 'Checking local components…';
  try {
    const result = await api('/api/health', undefined, { allowToolFailure: true });
    const { whisper, ollama } = result.data;
    ollamaReady = ollama.ready;
    el['health-summary'].textContent = whisper.ready ? 'Voice entry available; manual text can also be used.' : 'Whisper is not prepared; use manual text on the right to complete the flow.';
    el['health-details'].replaceChildren(
      healthBadge('Whisper', whisper.ready, whisper.ready ? `${whisper.model} available` : whisper.error_code),
      healthBadge('Ollama', ollama.ready, ollama.ready ? `${ollama.models.length} models` : 'will use the deterministic flow'),
    );
  } catch (error) {
    el['health-summary'].textContent = `Health check failed: ${error.message}; the manual entry can still be tried.`;
    throw error;
  }
}

async function unlockWithToken(token) {
  setSessionToken(token);
  el['auth-status'].textContent = 'Verifying passcode…';
  try {
    await refreshHealth();
    el['auth-gate'].hidden = true;
    el['auth-status'].textContent = '';
  } catch (error) {
    if (sessionToken) requireLogin(`Cannot establish session: ${error.message}`);
  }
}

async function initializeSession() {
  const lanLike = !['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  el['network-mode'].textContent = lanLike ? 'LAN demo mode' : 'Local demo mode';
  el['network-warning'].textContent = !window.isSecureContext && lanLike
    ? 'This is a LAN HTTP page: browsers on phones or other computers usually disable the microphone. Record in the host browser and watch from another device, or use manual text on another device.'
    : 'The temporary passcode is kept only in the current tab session. Demo only on trusted Wi-Fi; do not expose it to the public internet.';
  if (!window.isSecureContext) {
    el['start-recording'].disabled = true;
    el['recording-status'].textContent = 'This page is not a secure context, so the browser microphone is disabled; upload a WAV or use manual text.';
  }

  const remembered = sessionStorage.getItem(sessionTokenKey);
  if (remembered) {
    await unlockWithToken(remembered);
    return;
  }
  try {
    const response = await fetch('/session-bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' } });
    if (response.ok) {
      const result = await response.json();
      await unlockWithToken(result.token);
      return;
    }
  } catch {
    // LAN mode intentionally has no automatic token bootstrap.
  }
  requireLogin();
}

function invalidateConfirmation(message = 'Report content has changed; re-validation and confirmation are required.') {
  confirmationToken = null;
  el['save-report'].disabled = true;
  el['export-report'].disabled = true;
  el['copy-export'].disabled = true;
  el['export-output'].hidden = true;
  el['confirmation-status'].textContent = message;
}

function acceptTranscript(artifact, message) {
  currentTranscript = artifact;
  currentDraft = null;
  currentValidation = null;
  currentFactsReceiptId = null;
  currentNormalization = null;
  currentCorrectionReceipt = null;
  Object.keys(manualFields).forEach((key) => delete manualFields[key]);
  invalidateConfirmation('Transcript exists; report not yet generated or confirmed.');
  el['transcript-output'].textContent = artifact.raw_text;
  el['transcript-output'].classList.remove('empty');
  el['artifact-output'].textContent = JSON.stringify(artifact, null, 2);
  el['transcription-status'].textContent = `${message} Source: ${artifact.provider}. The original text is saved as an immutable Artifact.`;
  el['build-report'].disabled = false;
  ['correction-section', 'questions-section', 'evidence-section', 'report-section', 'confirm-section'].forEach((id) => { el[id].hidden = true; });
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

el['start-recording'].addEventListener('click', async () => {
  el['start-recording'].disabled = true;
  try {
    recorder = new PcmWavRecorder();
    const { sampleRate } = await recorder.start();
    el['stop-recording'].disabled = false;
    el['recording-status'].textContent = `Recording (input ${sampleRate} Hz, saved as 16 kHz mono PCM WAV)…`;
    recordingTimer = setTimeout(() => el['stop-recording'].click(), 90_000);
  } catch (error) {
    el['recording-status'].textContent = `Cannot start recording: ${error.message}`;
    el['start-recording'].disabled = false;
  }
});

el['stop-recording'].addEventListener('click', async () => {
  clearTimeout(recordingTimer);
  el['stop-recording'].disabled = true;
  try {
    const wav = await recorder.stop();
    selectAudio(wav, `Recording ready: ${Math.round(wav.size / 1024)} KB.`);
  } catch (error) {
    el['recording-status'].textContent = `Failed to stop recording: ${error.message}`;
  } finally {
    recorder = null;
    el['start-recording'].disabled = false;
  }
});

el['audio-file'].addEventListener('change', () => {
  const file = el['audio-file'].files?.[0];
  if (file) selectAudio(file, `Selected ${file.name}; the server will validate the WAV.`);
});

async function uploadIfNeeded() {
  if (currentAudioId) return currentAudioId;
  const result = await api('/api/audio', undefined, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: currentBlob });
  currentAudioId = result.data.audio_id;
  return currentAudioId;
}

async function transcribe(attempt) {
  el.transcribe.disabled = true;
  el.retry.disabled = true;
  el['transcription-status'].textContent = 'Transcribing locally…';
  try {
    const audioId = await uploadIfNeeded();
    const result = await api('/api/transcriptions', {
      audio_id: audioId, model: el.model.value, language: el.language.value, attempt,
      idempotency_key: `${audioId}:${el.model.value}:${el.language.value}:attempt-${attempt}`,
    });
    acceptTranscript(result.data.transcript, result.data.reused ? 'Reused the same transcription request' : 'Speech transcription complete');
  } catch (error) {
    el['transcription-status'].textContent = `Transcription failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}. Manual text can be used instead.`;
    el.retry.disabled = attempt >= 2;
  } finally {
    el.transcribe.disabled = false;
  }
}

el.transcribe.addEventListener('click', () => transcribe(1));
el.retry.addEventListener('click', () => transcribe(2));
el['use-manual'].addEventListener('click', async () => {
  el['use-manual'].disabled = true;
  try {
    const result = await api('/api/transcripts/manual', { raw_text: el['manual-transcript'].value, language: 'zh' });
    acceptTranscript(result.data.transcript, 'Manual text saved (not speech recognition)');
  } catch (error) {
    el['transcription-status'].textContent = `Failed to save manual text: ${error.message}`;
  } finally {
    el['use-manual'].disabled = false;
  }
});

function renderQuestions(inputValidation) {
  const questions = inputValidation.data.follow_up_questions || [];
  el['questions-section'].hidden = questions.length === 0;
  el['questions-list'].replaceChildren(...questions.map(({ field, question }) => {
    const wrapper = node('div', 'question');
    const label = node('label');
    label.append(node('strong', '', question));
    const input = node('textarea');
    input.rows = 2;
    input.dataset.field = field;
    input.value = manualFields[field] || '';
    input.placeholder = 'Enter what the technician actually observed or recorded';
    const missing = node('label', 'missing-check');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.missingField = field;
    missing.append(checkbox, document.createTextNode(' Not provided this time / fill in later'));
    label.append(input);
    wrapper.append(label, missing);
    return wrapper;
  }));
}

function renderEvidence(normalization, inputValidation) {
  const factNodes = currentFacts.length ? currentFacts.map((fact) => {
    const card = node('div', 'fact-card');
    card.append(node('strong', '', fact.field), node('span', '', typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)), node('small', '', `${fact.support_status} · ${fact.source_refs.join(', ')}`));
    return card;
  }) : [node('p', 'empty-note', 'No facts with sources were extracted.')];
  el['facts-output'].replaceChildren(...factNodes);
  const corrections = normalization.data.correction_candidates || [];
  const missing = inputValidation.data.missing_required_fields || [];
  const issueNodes = [
    node('div', 'fact-card', corrections.length ? `Terminology fix candidates: ${corrections.length}` : 'No terminology fixes applied; the original text is unchanged.'),
    node('div', `fact-card ${missing.length ? 'needs-attention' : ''}`, missing.length ? `Still missing: ${missing.join(', ')}` : 'Minimum fact set is covered.'),
  ];
  el['issues-output'].replaceChildren(...issueNodes);
  el['evidence-section'].hidden = false;
}

function renderCorrectionReview(normalization) {
  const candidates = normalization.data.correction_candidates || [];
  el['correction-raw'].textContent = normalization.data.raw_text;
  el['correction-proposed'].textContent = normalization.data.proposed_text;
  el['correction-evidence'].textContent = JSON.stringify({
    knowledge_version: normalization.data.knowledge_version,
    candidate_bundle_hash: normalization.data.candidate_bundle_hash,
    deterministic_fallback_used: normalization.data.deterministic_fallback_used,
    candidates,
    warnings: normalization.warnings,
  }, null, 2);
  el['correction-list'].replaceChildren(...(candidates.length ? candidates.map((candidate) => {
    const critical = candidate.status === 'NEEDS_TECHNICIAN_CONFIRMATION';
    const card = node('div', `correction-card ${critical ? 'critical' : ''}`);
    const change = node('div', 'correction-change');
    change.append(node('code', '', candidate.source_span.text), node('span', '', '→'), node('code', '', candidate.candidate));
    const reason = node('small', '', `${candidate.reason} · ${candidate.match_basis.match_basis} · ${candidate.knowledge_version}`);
    const controls = node('div', 'decision-controls');
    for (const [value, labelText] of [['ACCEPT', 'Accept this fix'], ['REJECT', 'Keep original']]) {
      const label = node('label');
      const radio = node('input');
      radio.type = 'radio';
      radio.name = `decision-${candidate.candidate_id}`;
      radio.value = value;
      radio.dataset.candidateId = candidate.candidate_id;
      label.append(radio, document.createTextNode(labelText));
      controls.append(label);
    }
    if (critical) {
      const label = node('label', 'critical-confirm');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.criticalCandidateId = candidate.candidate_id;
      label.append(checkbox, document.createTextNode('I have manually verified this critical value/meaning'));
      controls.append(label);
    }
    card.append(change, reason, controls);
    return card;
  }) : [node('div', 'fact-card', 'No controlled fix candidates found. The technician must still confirm the original text; the system will issue an "original text confirmation" receipt.')]));
  el['correction-status'].textContent = candidates.length
    ? `Found ${candidates.length} controlled candidates. Decide each one; the AI suggestions have not changed the original text.`
    : 'No fix candidates; confirm technician identity to issue the original-text confirmation receipt.';
  el['correction-section'].hidden = false;
}

function renderDraft(validation) {
  el['report-output'].replaceChildren(...currentDraft.sections.map((section) => {
    const block = node('section', 'report-section-block');
    block.append(node('h3', '', section.title));
    for (const item of section.items) {
      const line = node('p', item.type === 'template_text' ? 'placeholder' : '');
      line.textContent = item.text;
      if (item.fact_ids?.length) line.append(node('small', 'source-tag', `Source: ${item.fact_ids.join(', ')}`));
      block.append(line);
    }
    return block;
  }));
  const reviewable = validation.data.can_enter_technician_review;
  el['validator-banner'].className = `validator-banner ${reviewable ? 'pass' : 'fail'}`;
  el['validator-banner'].textContent = reviewable
    ? `Validator: ${validation.status}. Source coverage ${Math.round(validation.data.provenance_coverage * 100)}%; ready for technician review.`
    : `Validator: ${validation.status}. The report cannot be confirmed; fix the validation issues first.`;
  el['validator-output'].textContent = JSON.stringify(validation, null, 2);
  el['report-section'].hidden = false;
  el['confirm-section'].hidden = !reviewable;
  el['confirm-report'].disabled = !reviewable || !el['confirm-check'].checked;
}

async function prepareCorrectionReview() {
  if (!currentTranscript) return;
  invalidateConfirmation();
  el['build-report'].disabled = true;
  currentCorrectionReceipt = null;
  el['transcription-status'].textContent = 'Searching versioned HVAC terminology candidates on the server…';
  try {
    currentNormalization = await api('/api/normalizations', { transcript_artifact_id: currentTranscript.artifact_id });
    renderCorrectionReview(currentNormalization);
    el['transcription-status'].textContent = 'Fix suggestions shown; the original TranscriptArtifact remains unchanged.';
  } catch (error) {
    el['transcription-status'].textContent = `Fix candidate check failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`;
  } finally {
    el['build-report'].disabled = false;
  }
}

async function generateReportFromReceipt() {
  if (!currentCorrectionReceipt) return;
  invalidateConfirmation();
  el['transcription-status'].textContent = 'Running the fixed flow: confirm text → fact extraction → missing check → section planning → draft → Validator…';
  try {
    const extracted = await api('/api/facts/extract', { correction_receipt_id: currentCorrectionReceipt.correction_receipt_id, manual_fields: manualFields, use_llm: ollamaReady });
    currentFacts = extracted.data.facts;
    currentFactsReceiptId = extracted.data.facts_receipt_id;
    const inputValidation = await api('/api/reports/validate-input', { facts_receipt_id: currentFactsReceiptId });
    const plan = await api('/api/reports/plan', { facts_receipt_id: currentFactsReceiptId, service_type: 'general_hvac' });
    const template = await api('/api/reports/template', { template_id: 'hvac_service_report', version: '1.0.0' });
    const generated = await api('/api/reports/generate', { facts_receipt_id: currentFactsReceiptId, plan: plan.data, template: template.data.template, use_llm: ollamaReady });
    currentDraft = generated.data.draft;
    currentValidation = await api('/api/reports/validate-draft', { draft: currentDraft, facts_receipt_id: currentFactsReceiptId });
    renderQuestions(inputValidation);
    renderEvidence(currentNormalization, inputValidation);
    renderDraft(currentValidation);
    el['transcription-status'].textContent = 'Report draft and independent validation are ready. Answer follow-up questions and complete the technician review.';
  } catch (error) {
    el['transcription-status'].textContent = `Generation failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`;
  }
}

el['build-report'].addEventListener('click', prepareCorrectionReview);
el['confirm-corrections'].addEventListener('click', async () => {
  if (!currentNormalization || !currentTranscript) return;
  el['confirm-corrections'].disabled = true;
  try {
    const decisions = (currentNormalization.data.correction_candidates || []).map((candidate) => {
      const selected = el['correction-list'].querySelector(`input[name="decision-${candidate.candidate_id}"]:checked`);
      if (!selected) throw new Error(`Choose accept or reject: ${candidate.source_span.text} → ${candidate.candidate}`);
      const critical = el['correction-list'].querySelector(`[data-critical-candidate-id="${candidate.candidate_id}"]`);
      return { candidate_id: candidate.candidate_id, decision: selected.value, critical_value_confirmed: critical ? critical.checked : false };
    });
    const result = await api('/api/corrections/confirm', {
      transcript_artifact_id: currentTranscript.artifact_id,
      candidate_bundle_hash: currentNormalization.data.candidate_bundle_hash,
      decisions,
      technician_id: el['correction-technician-id'].value,
      technician_name: el['correction-technician-name'].value,
    });
    currentCorrectionReceipt = result.data.correction_receipt;
    el['technician-id'].value = el['correction-technician-id'].value;
    el['technician-name'].value = el['correction-technician-name'].value;
    el['correction-status'].textContent = `Immutable text receipt ${currentCorrectionReceipt.correction_receipt_id} issued; confirmed at ${currentCorrectionReceipt.confirmed_at}.`;
    await generateReportFromReceipt();
  } catch (error) {
    el['correction-status'].textContent = `Text confirmation failed (${error.result?.error_code || 'INPUT'}): ${error.message}`;
  } finally {
    el['confirm-corrections'].disabled = false;
  }
});
el['apply-answers'].addEventListener('click', () => {
  for (const input of el['questions-list'].querySelectorAll('textarea[data-field]')) {
    const missing = el['questions-list'].querySelector(`[data-missing-field="${input.dataset.field}"]`)?.checked;
    if (!missing && input.value.trim()) manualFields[input.dataset.field] = input.value.trim();
    else delete manualFields[input.dataset.field];
  }
  generateReportFromReceipt();
});

el['confirm-check'].addEventListener('change', () => {
  el['confirm-report'].disabled = !el['confirm-check'].checked || !currentValidation?.data?.can_enter_technician_review;
});
el['confirm-report'].addEventListener('click', async () => {
  invalidateConfirmation('Binding the current report and validation results…');
  try {
    const result = await api('/api/reports/confirm', {
      draft: currentDraft,
      validator_run_id: currentValidation.trace_id,
      technician_id: el['technician-id'].value,
      technician_name: el['technician-name'].value,
    });
    confirmationToken = result.data.confirmation.confirmation_token;
    el['save-report'].disabled = false;
    el['export-report'].disabled = false;
    el['confirmation-status'].textContent = `Confirmed version ${result.data.confirmation.report_version}; confirmed at ${result.data.confirmation.confirmed_at}.`;
  } catch (error) {
    el['confirmation-status'].textContent = `Confirmation failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`;
  }
});

el['save-report'].addEventListener('click', async () => {
  try {
    const result = await api('/api/reports/save', { draft: currentDraft, confirmation_token: confirmationToken });
    el['confirmation-status'].textContent = `${result.data.reused ? 'Reused' : 'Saved'} official JSON: ${result.data.file}`;
  } catch (error) {
    el['confirmation-status'].textContent = `Save rejected (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`;
  }
});
el['export-report'].addEventListener('click', async () => {
  try {
    const result = await api('/api/reports/export', { draft: currentDraft, confirmation_token: confirmationToken });
    el['export-output'].value = result.data.copyable_text;
    el['export-output'].hidden = false;
    el['copy-export'].disabled = false;
    el['confirmation-status'].textContent = `${result.data.reused ? 'Reused' : 'Exported'} text: ${result.data.file}`;
  } catch (error) {
    el['confirmation-status'].textContent = `Export rejected (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`;
  }
});
el['copy-export'].addEventListener('click', async () => {
  await navigator.clipboard.writeText(el['export-output'].value);
  el['confirmation-status'].textContent = 'Report text copied to clipboard.';
});
el['fill-demo'].addEventListener('click', () => {
  el['manual-transcript'].value = demoNarration;
  el['transcription-status'].textContent = 'Synthetic demo text filled in; not yet saved, submitted, or confirmed.';
});
el['auth-submit'].addEventListener('click', () => unlockWithToken(el['auth-token'].value));
el['auth-token'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter') unlockWithToken(el['auth-token'].value);
});
el['refresh-health'].addEventListener('click', () => refreshHealth().catch(() => {}));
initializeSession();

// =====================================================================
// V2 · SBS Bus / SBS Rail panel (additive — V1 flow and ids untouched)
// Reuses V1 module-level sessionToken / api() / node() / requireLogin().
// =====================================================================
const V2_SCOPE_DEFAULTS = Object.freeze({
  HVAC: Object.freeze({ contextId: 'HVAC', scopeId: 'HVAC', display: 'HVAC', v2: false }),
  SBS_BUS: Object.freeze({ contextId: 'SBS/BUS', scopeId: 'SBS_BUS', display: 'SBS / Bus', v2: true }),
  SBS_RAIL: Object.freeze({ contextId: 'SBS/RAIL', scopeId: 'SBS_RAIL', display: 'SBS / Rail', v2: true }),
});

const v2Ids = [
  'v1-panel', 'v2-panel', 'scope-selector-status', 'scope-selector-buttons',
  'v2-upload-scope-hint', 'v2-upload-file', 'v2-upload-submit', 'v2-uploader',
  'v2-upload-status', 'v2-upload-progress', 'v2-upload-record', 'v2-upload-list',
  'v2-retrieve-scope-hint', 'v2-retrieve-query', 'v2-retrieve-topk', 'v2-retrieve-submit',
  'v2-retrieve-status', 'v2-retrieve-warnings', 'v2-retrieve-results',
  'v2-facts-text', 'v2-facts-extract', 'v2-report-build', 'v2-facts-status',
  'v2-facts-table-wrap', 'v2-facts-table', 'v2-report-output', 'v2-report-banner',
  'v2-report-missing', 'v2-report-gates', 'v2-report-sections',
];
const v2El = Object.fromEntries(v2Ids.map((id) => [id, document.getElementById(id)]));

const v2 = {
  scopeId: 'HVAC',
  contextId: 'HVAC',
  display: 'HVAC',
  scopes: [],
  scopesLoaded: false,
  facts: [],
  knowledgeHits: [],
  uploadTimer: null,
  reportBlocked: false,
};

const V2_UPLOAD_STEPS = ['UPLOADED', 'PROCESSING', 'PARSED', 'CHUNKED', 'INDEXED'];

function v2SetStatus(id, text) {
  v2El[id].textContent = text;
}

function v2UpdateScopeSelector() {
  for (const button of v2El['scope-selector-buttons'].querySelectorAll('.scope-button')) {
    const scopeId = button.dataset.scopeId;
    button.classList.toggle('active', scopeId === v2.scopeId);
    const info = V2_SCOPE_DEFAULTS[scopeId];
    if (info && v2.scopes.length) {
      const found = v2.scopes.find((scope) => scope.scope_id === scopeId);
      if (found && found.display) button.textContent = found.display;
    }
  }
  const info = V2_SCOPE_DEFAULTS[v2.scopeId];
  v2El['scope-selector-status'].textContent = info.v2
    ? `Current scope: ${info.display} (V2 panel)`
    : `Current scope: ${info.display} (V1 panel)`;
}

function v2SetScopeHints() {
  v2El['v2-upload-scope-hint'].textContent = `Uploaded documents enter scope ${v2.display} and are visible only to retrieval in that scope.`;
  const others = v2.scopeId === 'SBS_BUS' ? 'HVAC or Rail' : 'HVAC or Bus';
  v2El['v2-retrieve-scope-hint'].textContent = `Search scope: ${v2.display}; ${others} content will never be returned.`;
}

function v2SetScope(scopeId) {
  const info = V2_SCOPE_DEFAULTS[scopeId];
  if (!info) return;
  v2.scopeId = scopeId;
  v2.contextId = info.contextId;
  v2.display = info.display;
  v2.facts = [];
  v2.knowledgeHits = [];
  v2.reportBlocked = false;
  v2StopDemo();
  v2StopUploadAnimation();
  v2UpdateScopeSelector();
  v2El['v1-panel'].hidden = info.v2;
  v2El['v2-panel'].hidden = !info.v2;
  if (!info.v2) return;
  v2El['v2-report-build'].disabled = true;
  v2El['v2-report-output'].hidden = true;
  v2El['v2-facts-table-wrap'].hidden = true;
  v2El['v2-upload-record'].hidden = true;
  v2El['v2-upload-progress'].hidden = true;
  v2El['v2-retrieve-results'].replaceChildren();
  v2El['v2-retrieve-warnings'].replaceChildren();
  v2SetScopeHints();
  v2El['v2-upload-status'].className = 'live-status';
  v2El['v2-facts-status'].className = 'live-status';
  v2SetStatus('v2-upload-status', 'No document selected yet.');
  v2SetStatus('v2-retrieve-status', '');
  v2SetStatus('v2-facts-status', '');
  v2RefreshScopes();
  v2RefreshUploads();
}

async function v2RefreshScopes() {
  if (v2.scopesLoaded) return;
  try {
    const result = await api('/api/v2/scopes');
    v2.scopes = Array.isArray(result.data?.scopes) ? result.data.scopes : [];
    v2.scopesLoaded = true;
    v2UpdateScopeSelector();
  } catch (error) {
    v2SetStatus('v2-upload-status', `Scope info temporarily unavailable (${error.message}); continuing with the default scope.`);
  }
}

function v2StatusBadge(status) {
  const ready = status === 'READY';
  const failed = status === 'FAILED';
  return node('span', `status-badge ${ready ? 'ready' : failed ? 'failed' : ''}`, status || 'UNKNOWN');
}

function v2UploadRow(upload) {
  const row = node('div', 'upload-row');
  const name = node('span', 'name', upload.filename || upload.upload_id || '—');
  const at = String(upload.provenance?.uploaded_at || '').slice(0, 19).replace('T', ' ');
  const meta = node('span', 'meta', `${upload.scope_id || '—'} · ${upload.chunk_count ?? 0} chunks · ${at || '—'}`);
  row.append(name, v2StatusBadge(upload.status), meta);
  return row;
}

async function v2RefreshUploads() {
  if (!sessionToken) {
    v2El['v2-upload-list'].replaceChildren(node('p', 'empty-note', 'Upload records for this scope load after login.'));
    return;
  }
  v2SetStatus('v2-upload-status', 'Loading upload records…');
  try {
    const listPath = `/api/v2/uploads?scope_id=${encodeURIComponent(v2.scopeId)}`;
    const result = await api(listPath);
    const uploads = Array.isArray(result.data?.uploads) ? result.data.uploads : [];
    v2El['v2-upload-list'].replaceChildren(
      uploads.length ? uploads.map(v2UploadRow) : [node('p', 'empty-note', 'No upload records in this scope yet.')],
    );
    if (v2El['v2-upload-status'].textContent === 'Loading upload records…') v2SetStatus('v2-upload-status', '');
  } catch (error) {
    v2SetStatus('v2-upload-status', `Failed to load upload records: ${error.message}`);
  }
}

async function v2UploadFile(file) {
  if (!sessionToken) throw new Error('No demo session established yet.');
  const uploadPath = '/api/v2/uploads';
  const headers = {
    authorization: `Bearer ${sessionToken}`,
    'x-file-name': file.name,
    'x-scope-id': v2.scopeId,
    'x-mime-type': file.type || 'application/octet-stream',
    'x-uploader': v2El['v2-uploader'].value.trim() || 'demo-technician',
    'x-scenario': 'demo',
    'content-type': 'application/octet-stream',
  };
  const response = await fetch(uploadPath, { method: 'POST', headers, body: file });
  let result;
  try {
    result = await response.json();
  } catch {
    result = { status: 'FAIL', error_code: `HTTP_${response.status}` };
  }
  if (response.status === 401) requireLogin('Invalid passcode or expired session. Please re-enter.');
  if (!response.ok || result.status === 'FAIL' || result.status === 'RETRYABLE_ERROR') {
    const error = new Error(result.data?.message || result.error_code || `HTTP ${response.status}`);
    error.result = result;
    throw error;
  }
  return result;
}

function v2UploadStepChip(status, extra = '') {
  const ready = status === 'READY';
  const failed = status === 'FAILED';
  const chip = node('span', `v2-step-chip ${ready ? 'ready' : failed ? 'failed' : ''}`);
  chip.append(document.createTextNode(status), node('time', '', extra));
  return chip;
}

function v2StopUploadAnimation() {
  if (v2.uploadTimer) {
    clearInterval(v2.uploadTimer);
    v2.uploadTimer = null;
  }
}

function v2StartUploadAnimation() {
  v2StopUploadAnimation();
  const box = v2El['v2-upload-progress'];
  box.hidden = false;
  box.replaceChildren();
  let index = 0;
  const step = () => {
    if (index < V2_UPLOAD_STEPS.length) {
      box.append(v2UploadStepChip(V2_UPLOAD_STEPS[index], new Date().toLocaleTimeString()));
      index += 1;
    }
  };
  step();
  v2.uploadTimer = setInterval(step, 400);
}

function v2RenderUploadRecord(upload) {
  const box = v2El['v2-upload-record'];
  box.hidden = false;
  const lines = [
    ['upload_id', upload.upload_id],
    ['filename', upload.filename],
    ['scope_id', upload.scope_id],
    ['chunk_count', upload.chunk_count],
    ['token_count', upload.indexed?.token_count ?? '—'],
    ['sha256 (first 8 chars)', upload.sha256 ? upload.sha256.slice(0, 8) : '—'],
    ['size_bytes', upload.size_bytes],
  ];
  box.replaceChildren(...lines.map(([label, value]) => {
    const line = node('div', 'kv');
    line.append(node('b', '', `${label}: `), document.createTextNode(String(value ?? '—')));
    return line;
  }));
}

v2El['v2-upload-file'].addEventListener('change', () => {
  const file = v2El['v2-upload-file'].files?.[0];
  v2El['v2-upload-submit'].disabled = !file;
  v2El['v2-upload-status'].className = 'live-status';
  if (!file) {
    v2SetStatus('v2-upload-status', 'No document selected yet.');
    return;
  }
  v2SetStatus('v2-upload-status', `Selected ${file.name} (${(file.size / 1024).toFixed(1)} KB).`);
  if (!v2El['v2-uploader'].value.trim() && el['technician-name']?.value) {
    v2El['v2-uploader'].value = el['technician-name'].value;
  }
});

v2El['v2-upload-submit'].addEventListener('click', async () => {
  const file = v2El['v2-upload-file'].files?.[0];
  if (!file) {
    v2SetStatus('v2-upload-status', 'Select a document to upload first.');
    return;
  }
  v2El['v2-upload-submit'].disabled = true;
  v2El['v2-upload-file'].disabled = true;
  v2El['v2-upload-record'].hidden = true;
  v2SetStatus('v2-upload-status', 'Uploading and indexing (server runs the Upload → Parse → Chunk → Index → Ready state machine)…');
  v2StartUploadAnimation();
  try {
    const result = await v2UploadFile(file);
    const upload = result.data?.upload;
    if (!upload) throw new Error('The server did not return an upload record.');
    if (upload.status === 'FAILED') {
      v2El['v2-upload-progress'].append(v2UploadStepChip('FAILED', new Date().toLocaleTimeString()));
      const reason = upload.errors?.[0]?.message || 'Document processing failed.';
      v2SetStatus('v2-upload-status', `Upload failed: ${reason}`);
      v2El['v2-upload-status'].className = 'live-status v2-error-text';
    } else {
      v2El['v2-upload-progress'].append(v2UploadStepChip('READY', new Date().toLocaleTimeString()));
      v2RenderUploadRecord(upload);
      v2SetStatus('v2-upload-status', `Upload complete: ${upload.filename} is ready.`);
      v2El['v2-upload-status'].className = 'live-status';
    }
    v2RefreshUploads();
  } catch (error) {
    v2SetStatus('v2-upload-status', `Upload failed: ${error.message}`);
    v2El['v2-upload-status'].className = 'live-status v2-error-text';
  } finally {
    v2StopUploadAnimation();
    v2El['v2-upload-submit'].disabled = false;
    v2El['v2-upload-file'].disabled = false;
  }
});

function v2RenderRetrieveWarnings(warnings) {
  const box = v2El['v2-retrieve-warnings'];
  if (!Array.isArray(warnings) || warnings.length === 0) {
    box.replaceChildren();
    return;
  }
  const blocked = warnings.includes('CROSS_DOMAIN_BLOCKED');
  const note = blocked ? node('p', 'warning-line', 'Cross-domain content blocked: this search cannot return content from other scopes (HVAC / the other SBS domain).') : null;
  const detail = node('p', 'hint', `Server warnings: ${warnings.join(', ')}`);
  box.replaceChildren(...(note ? [note, detail] : [detail]));
}

function v2RenderRetrieveResults(results) {
  const box = v2El['v2-retrieve-results'];
  if (!results.length) {
    box.replaceChildren(node('p', 'empty-note', 'No results found.'));
    return;
  }
  box.replaceChildren(...results.map((item) => {
    const card = node('div', 'result-card');
    const head = node('div', 'head');
    head.append(
      node('span', 'status-badge', item.source === 'upload' ? 'Upload' : 'Knowledge base'),
      node('span', '', item.scope_id || '—'),
      node('span', 'score', `score ${Number(item.score || 0).toFixed(2)}`),
    );
    const full = String(item.text || '');
    const text = node('p', 'text', full.slice(0, 120) + (full.length > 120 ? '…' : ''));
    const prov = node('p', 'prov', `Source: ${item.provenance?.file || item.doc_id || '—'}${item.provenance?.uploader ? ` · Uploader: ${item.provenance.uploader}` : ''}`);
    card.append(head, text, prov);
    return card;
  }));
}

v2El['v2-retrieve-submit'].addEventListener('click', async () => {
  const query = v2El['v2-retrieve-query'].value.trim();
  const topK = Math.max(1, Math.min(20, Math.floor(Number(v2El['v2-retrieve-topk'].value) || 5)));
  v2El['v2-retrieve-submit'].disabled = true;
  v2El['v2-retrieve-results'].replaceChildren();
  v2El['v2-retrieve-warnings'].replaceChildren();
  v2SetStatus('v2-retrieve-status', 'Searching…');
  try {
    const result = await api('/api/v2/retrieve', {
      context_id: v2.contextId,
      query,
      top_k: topK,
      include_uploads: true,
    });
    v2.knowledgeHits = (result.data?.results || []).map((item) => item.text);
    v2RenderRetrieveWarnings(result.warnings || []);
    v2RenderRetrieveResults(result.data?.results || []);
    v2SetStatus('v2-retrieve-status', `Search complete: ${(result.data?.results || []).length} results.`);
  } catch (error) {
    v2.knowledgeHits = [];
    v2SetStatus('v2-retrieve-status', `Search failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`);
  } finally {
    v2El['v2-retrieve-submit'].disabled = false;
  }
});

function v2RenderFacts(facts) {
  const table = v2El['v2-facts-table'];
  if (!facts.length) {
    table.replaceChildren(node('p', 'empty-note', 'No facts extracted.'));
    return;
  }
  const head = node('div', 'fact-table head');
  head.append(node('span', '', 'Field'), node('span', '', 'Value'), node('span', '', 'Unit'), node('span', '', 'Support status'), node('span', '', ''));
  const rows = facts.map((fact) => {
    const row = node('div', 'fact-table');
    row.append(
      node('span', '', fact.field || '—'),
      node('span', '', typeof fact.value === 'object' ? JSON.stringify(fact.value) : String(fact.value ?? '—')),
      node('span', '', fact.unit || '—'),
      node('span', '', fact.support_status || '—'),
      fact.critical ? node('span', 'badge-critical', 'critical') : node('span', '', ''),
    );
    return row;
  });
  table.replaceChildren(head, ...rows);
}

v2El['v2-facts-extract'].addEventListener('click', async () => {
  const raw = v2El['v2-facts-text'].value.trim();
  if (!raw) {
    v2SetStatus('v2-facts-status', 'Enter dictation or manual content first.');
    return;
  }
  v2El['v2-facts-extract'].disabled = true;
  v2El['v2-facts-status'].className = 'live-status';
  v2El['v2-report-output'].hidden = true;
  v2SetStatus('v2-facts-status', 'Extracting facts…');
  try {
    const result = await api('/api/v2/facts/extract', { context_id: v2.contextId, raw_text: raw });
    v2.facts = Array.isArray(result.data?.facts) ? result.data.facts : [];
    v2.reportBlocked = false;
    v2RenderFacts(v2.facts);
    v2El['v2-facts-table-wrap'].hidden = v2.facts.length === 0;
    v2El['v2-report-build'].disabled = v2.facts.length === 0;
    v2SetStatus('v2-facts-status', `Extracted ${v2.facts.length} facts.`);
  } catch (error) {
    v2.facts = [];
    v2El['v2-report-build'].disabled = true;
    v2SetStatus('v2-facts-status', `Fact extraction failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`);
  } finally {
    v2El['v2-facts-extract'].disabled = false;
  }
});

function v2RenderReport(result) {
  const report = result.data?.report || {};
  const gates = result.data?.gates || {};
  const violations = Array.isArray(gates.violations) ? gates.violations : [];
  const needsConfirm = result.status === 'NEEDS_CONFIRMATION' || violations.length > 0;
  v2El['v2-report-output'].hidden = false;

  const banner = v2El['v2-report-banner'];
  banner.className = `validator-banner ${needsConfirm ? 'fail' : 'pass'}`;
  banner.textContent = needsConfirm ? 'Report has hard-gate violations and is not confirmed.' : 'Report passed hard-gate checks.';

  const missing = Array.isArray(report.missing_required_fields) ? report.missing_required_fields : [];
  const missingBox = v2El['v2-report-missing'];
  missingBox.textContent = missing.length
    ? `Missing required fields: ${missing.join(', ')} (add them before confirming).`
    : 'All required fields are covered.';
  missingBox.hidden = missing.length === 0;

  v2El['v2-report-gates'].replaceChildren(...(violations.length ? violations.map((violation) => {
    const item = node('p', 'gate-item');
    item.append(
      node('strong', '', `[${violation.class}]`),
      node('code', '', violation.field || ''),
      document.createTextNode(` ${violation.detail || ''}`),
    );
    return item;
  }) : []));

  const sections = Array.isArray(report.sections) ? report.sections : [];
  v2El['v2-report-sections'].replaceChildren(...sections.map((section) => {
    const block = node('div', 'report-section-block');
    const content = Array.isArray(section.content) && section.content.length ? section.content : ['Not provided / pending confirmation'];
    const isMissing = section.required === true && content.every((line) => line === 'Not provided / pending confirmation');
    block.append(node('h3', isMissing ? 'v2-section-missing' : '', `${section.title}${section.required ? ' (required)' : ''}`));
    for (const line of content) block.append(node('p', '', line));
    return block;
  }));
}

v2El['v2-report-build'].addEventListener('click', async () => {
  if (!v2.facts.length) return;
  v2El['v2-report-build'].disabled = true;
  v2SetStatus('v2-facts-status', 'Building report…');
  try {
    const result = await api('/api/v2/reports/build', {
      context_id: v2.contextId,
      facts: v2.facts,
      knowledge_hits: v2.knowledgeHits,
    });
    v2RenderReport(result);
    if (result.status === 'NEEDS_CONFIRMATION') {
      v2.reportBlocked = true;
      v2SetStatus('v2-facts-status', 'Report has hard-gate violations and is not confirmed.');
      v2El['v2-report-build'].disabled = true;
    } else {
      v2SetStatus('v2-facts-status', `Report generated (${result.data?.report?.reportVersion || 'v2'}) with no hard-gate violations.`);
    }
  } catch (error) {
    v2SetStatus('v2-facts-status', `Report build failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`);
  } finally {
    if (!v2.reportBlocked) v2El['v2-report-build'].disabled = false;
  }
});

v2El['scope-selector-buttons'].addEventListener('click', (event) => {
  const button = event.target.closest('.scope-button');
  if (!button) return;
  v2SetScope(button.dataset.scopeId);
});

function v2WatchLogin() {
  const gate = document.getElementById('auth-gate');
  if (!gate) return;
  new MutationObserver(() => {
    if (gate.hidden && !v2El['v2-panel'].hidden && sessionToken) {
      v2RefreshScopes();
      v2RefreshUploads();
    }
  }).observe(gate, { attributes: true, attributeFilter: ['hidden'] });
}

function v2Init() {
  v2UpdateScopeSelector();
  v2WatchLogin();
}

v2Init();

// =====================================================================
// V2 · Guided demo player (additive — simulated recording, voice captions,
// terminology fixes for mis-heard words, facts, report). No Whisper needed.
// Uses only browser built-ins: speechSynthesis, setInterval/clearInterval,
// and the existing api() / v2RenderFacts / v2RenderReport / v2SetStatus.
// =====================================================================

/** Demo scenarios keyed by SBS scope: dictation (with mis-heard words),
 *  terminology fixes, and the corrected text used for fact extraction. */
const V2_DEMO_SCOPES = Object.freeze({
  SBS_BUS: Object.freeze({
    dictation: 'Preventive maintenance on bus MAN A ninety five. The front door would not close. Inspection found the door control modular was faulty. Replaced the door control modular. Tested the door opening and closing normal. Completion status completed.',
    fixes: Object.freeze([
      Object.freeze({ from: 'A ninety five', to: 'A95' }),
      Object.freeze({ from: 'door control modular', to: 'door control module' }),
    ]),
    correctedText: 'Preventive maintenance on bus MAN A95. The front door would not close. Inspection found the door control module was faulty. Replaced the door control module. Tested the door opening and closing normal. Completion status completed.',
  }),
  SBS_RAIL: Object.freeze({
    dictation: 'Corrective maintenance on train set C seven five one A. Reported a door fault on car three. Inspection found the train door worn. Replaced the train door. Test passed. Returned to service.',
    fixes: Object.freeze([
      Object.freeze({ from: 'C seven five one A', to: 'C751A' }),
    ]),
    correctedText: 'Corrective maintenance on train set C751A. Reported a door fault on car three. Inspection found the train door worn. Replaced the train door. Test passed. Returned to service.',
  }),
});

const V2_DEMO_SCOPE_IDS = Object.freeze(Object.keys(V2_DEMO_SCOPES));

/** Caption pacing is aligned to a ~280 ms per-word speech estimate so the
 *  subtitle text neither races ahead of nor trails the voice by much. */
const V2_DEMO_MS_PER_WORD = 280;
const V2_DEMO_SENTENCE_GAP_MS = 400;
const V2_DEMO_FIX_PAUSE_MS = 800;

/** Demo-specific element map (kept separate; v2Ids / v2El are untouched). */
const v2DemoEl = {
  play: document.getElementById('v2-demo-play'),
  status: document.getElementById('v2-demo-status'),
  captions: document.getElementById('v2-demo-captions'),
  fixes: document.getElementById('v2-demo-fixes'),
  fixList: document.getElementById('v2-demo-fix-list'),
};

/** Runtime state of the demo player. */
const v2Demo = {
  playing: false,
  stopped: false,
  captionsOnly: false,
  timer: null,
  pauseTimer: null,
  sleepResolve: null,
  utterance: null,
};

function v2DemoIdleStatus() {
  const info = V2_SCOPE_DEFAULTS[v2.scopeId];
  return info && info.v2
    ? 'Ready. Click "Play demo" to run the guided SBS scenario automatically.'
    : 'Demo is available for SBS Bus and SBS Rail only.';
}

/** Reflects scope availability on the play button (disabled for HVAC). */
function v2UpdateDemoAvailability() {
  const demoOnly = V2_DEMO_SCOPE_IDS.includes(v2.scopeId);
  v2DemoEl.play.disabled = !demoOnly;
  v2DemoEl.play.title = demoOnly ? '' : 'Demo is available for SBS Bus and SBS Rail only.';
}

function v2DemoResetStatusIfIdle() {
  if (!v2Demo.playing) v2SetStatus('v2-demo-status', v2DemoIdleStatus());
}

/** Cancels in-flight timers / TTS without touching UI state. */
function v2DemoCancelPlayback() {
  if (v2Demo.timer) { clearInterval(v2Demo.timer); v2Demo.timer = null; }
  if (v2Demo.pauseTimer) { clearTimeout(v2Demo.pauseTimer); v2Demo.pauseTimer = null; }
  if (v2Demo.sleepResolve) { v2Demo.sleepResolve(); v2Demo.sleepResolve = null; }
  if (v2Demo.utterance) {
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    v2Demo.utterance = null;
  }
}

/** Stops the demo and resets its UI. Called from v2SetScope on scope change. */
function v2StopDemo() {
  v2DemoCancelPlayback();
  v2Demo.playing = false;
  v2Demo.stopped = true;
  v2DemoEl.status.classList.remove('v2-recording');
  v2DemoEl.captions.replaceChildren();
  v2DemoEl.fixes.hidden = true;
  v2DemoEl.fixList.replaceChildren();
  v2UpdateDemoAvailability();
  v2DemoResetStatusIfIdle();
}

/** Re-enables the play button after the demo ends (keeps final status). */
function v2DemoFinish() {
  v2Demo.playing = false;
  v2UpdateDemoAvailability();
}

/** Whether the browser has speechSynthesis with at least one voice. */
async function v2ResolveSpeechAvailability() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  const synth = window.speechSynthesis;
  if (!synth) return false;
  const hasVoices = () => {
    try { return (synth.getVoices?.() || []).length > 0; } catch { return false; }
  };
  if (hasVoices()) return true;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 400);
    try {
      synth.addEventListener('voiceschanged', () => { clearTimeout(timer); resolve(); }, { once: true });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  return hasVoices();
}

/** Picks an en-US (or any English) TTS voice, or null. */
function v2PickEnVoice() {
  try {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    return voices.find((voice) => /en[-_]US/i.test(voice.lang || ''))
      || voices.find((voice) => /^en/i.test(voice.lang || ''))
      || null;
  } catch {
    return null;
  }
}

/** Splits dictation into sentences (keeps trailing punctuation). */
function v2SplitSentences(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const matches = raw.match(/[^.!?]+(?:[.!?]+|$)/gu) || [];
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

/** Sleep helper that resolves immediately when the demo is stopped. */
function v2DemoSleep(ms) {
  return new Promise((resolve) => {
    v2Demo.sleepResolve = resolve;
    v2Demo.pauseTimer = setTimeout(() => {
      v2Demo.sleepResolve = null;
      resolve();
    }, ms);
  });
}

/** Speaks one sentence while its words appear one by one in the captions. */
function v2SpeakSentence(sentence, index) {
  return new Promise((resolve) => {
    const words = sentence.split(/\s+/u).filter(Boolean);
    const line = node('p', 'v2-demo-line');
    v2DemoEl.captions.append(line);
    const estimatedMs = Math.max(600, words.length * V2_DEMO_MS_PER_WORD);
    const intervalMs = Math.max(90, Math.min(300, Math.round(estimatedMs / Math.max(1, words.length))));
    let wordIndex = 0;
    let settled = false;
    let timer = null;
    let timeout = null;

    const cleanup = () => {
      if (timer) { clearInterval(timer); timer = null; }
      if (timeout) { clearTimeout(timeout); timeout = null; }
      if (v2Demo.utterance) v2Demo.utterance = null;
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!v2Demo.stopped) {
        while (wordIndex < words.length) appendWord();
      }
      resolve();
    };
    const appendWord = () => {
      if (v2Demo.stopped || wordIndex >= words.length) return;
      const span = node('span', 'v2-demo-word');
      span.textContent = words[wordIndex];
      const previous = line.querySelector('.v2-demo-word.current');
      if (previous) previous.classList.remove('current');
      span.classList.add('current');
      line.append(span, document.createTextNode(' '));
      wordIndex += 1;
      v2DemoEl.captions.scrollTop = v2DemoEl.captions.scrollHeight;
    };
    const startCaptionTicker = () => {
      appendWord();
      if (index === 0) {
        v2DemoEl.status.classList.remove('v2-recording');
        v2SetStatus('v2-demo-status', '● Transcribing…');
      }
      timer = setInterval(() => {
        if (v2Demo.stopped) { clearInterval(timer); timer = null; return; }
        appendWord();
        if (wordIndex >= words.length) { clearInterval(timer); timer = null; }
      }, intervalMs);
    };

    startCaptionTicker();
    if (v2Demo.captionsOnly) {
      timeout = setTimeout(settle, estimatedMs);
      return;
    }
    let utterance;
    try {
      utterance = new SpeechSynthesisUtterance(sentence);
      utterance.lang = 'en-US';
      utterance.rate = 0.95;
      const voice = v2PickEnVoice();
      if (voice) utterance.voice = voice;
      utterance.onend = () => settle();
      utterance.onerror = (event) => {
        if (event.error === 'canceled' || event.error === 'interrupted') { settle(); return; }
        v2Demo.captionsOnly = true;
        v2SetStatus('v2-demo-status', 'Voice unavailable; captions only.');
        try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
        settle();
      };
      v2Demo.utterance = utterance;
      window.speechSynthesis?.resume?.();
      window.speechSynthesis.speak(utterance);
      timeout = setTimeout(settle, estimatedMs + 5000);
    } catch {
      v2Demo.captionsOnly = true;
      v2SetStatus('v2-demo-status', 'Voice unavailable; captions only.');
      timeout = setTimeout(settle, estimatedMs);
    }
  });
}

/** Reads every sentence sequentially with a short gap between them. */
async function v2SpeakCaptions(sentences) {
  for (let index = 0; index < sentences.length; index += 1) {
    if (v2Demo.stopped) return;
    await v2SpeakSentence(sentences[index], index);
    if (v2Demo.stopped) return;
    await v2DemoSleep(V2_DEMO_SENTENCE_GAP_MS);
  }
}

/** Runs the full guided demo: recording → captions → fixes → facts → report. */
async function v2PlayDemo() {
  if (v2Demo.playing) return;
  if (!V2_DEMO_SCOPE_IDS.includes(v2.scopeId)) return;
  if (!sessionToken) {
    requireLogin('Enter the temporary demo passcode set when the server started to run the guided demo.');
    return;
  }
  const demo = V2_DEMO_SCOPES[v2.scopeId];
  v2DemoCancelPlayback();
  v2Demo.playing = true;
  v2Demo.stopped = false;
  v2DemoEl.play.disabled = true;
  v2DemoEl.captions.replaceChildren();
  v2DemoEl.fixes.hidden = true;
  v2DemoEl.fixList.replaceChildren();
  v2DemoEl.status.classList.remove('v2-recording');

  v2Demo.captionsOnly = !(await v2ResolveSpeechAvailability());
  if (v2Demo.stopped) return;
  if (v2Demo.captionsOnly) {
    v2SetStatus('v2-demo-status', 'Voice unavailable; captions only.');
    v2DemoEl.captions.append(node('p', 'v2-demo-note', 'Voice unavailable; captions only.'));
  }

  v2DemoEl.status.classList.add('v2-recording');
  v2SetStatus('v2-demo-status', 'Recording… (simulated)');

  const sentences = v2SplitSentences(demo.dictation);
  await v2SpeakCaptions(sentences);
  if (v2Demo.stopped) return;

  v2DemoEl.status.classList.remove('v2-recording');
  v2SetStatus('v2-demo-status', 'Transcription complete.');

  // Keep the dictated (mis-heard) text visible for the technician.
  v2El['v2-facts-text'].value = demo.dictation;

  // Show the terminology fixes applied to the mis-heard words.
  v2DemoEl.fixList.replaceChildren(...demo.fixes.map((fix) => {
    const row = node('div', 'v2-demo-fix-row');
    row.append(
      node('s', 'v2-demo-fix-from', `"${fix.from}"`),
      node('span', 'v2-demo-fix-arrow', '→'),
      node('b', 'v2-demo-fix-to', `"${fix.to}"`),
    );
    return row;
  }));
  v2DemoEl.fixes.hidden = false;
  v2SetStatus('v2-demo-status', `ASR terminology fixes applied: ${demo.fixes.length}.`);
  await v2DemoSleep(V2_DEMO_FIX_PAUSE_MS);
  if (v2Demo.stopped) return;

  // Extract facts from the corrected text (deterministic V2 extractor).
  v2SetStatus('v2-demo-status', 'Extracting facts from corrected text…');
  let extracted;
  try {
    extracted = await api('/api/v2/facts/extract', { context_id: v2.contextId, raw_text: demo.correctedText });
  } catch (error) {
    if (v2Demo.stopped) return;
    v2.facts = [];
    v2SetStatus('v2-demo-status', `Fact extraction failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`);
    v2DemoFinish();
    return;
  }
  if (v2Demo.stopped) return;
  v2.facts = Array.isArray(extracted.data?.facts) ? extracted.data.facts : [];
  v2.reportBlocked = false;
  v2RenderFacts(v2.facts);
  v2El['v2-facts-table-wrap'].hidden = v2.facts.length === 0;
  v2El['v2-report-build'].disabled = v2.facts.length === 0;
  v2SetStatus('v2-demo-status', `Extracted ${v2.facts.length} facts from corrected text.`);
  v2El['v2-facts-table-wrap'].scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Build the report from the corrected facts.
  v2SetStatus('v2-demo-status', 'Building report…');
  let report;
  try {
    report = await api('/api/v2/reports/build', {
      context_id: v2.contextId,
      facts: v2.facts,
      knowledge_hits: v2.knowledgeHits,
    });
  } catch (error) {
    if (v2Demo.stopped) return;
    v2SetStatus('v2-demo-status', `Report build failed (${error.result?.error_code || 'UNKNOWN'}): ${error.message}`);
    v2DemoFinish();
    return;
  }
  if (v2Demo.stopped) return;
  v2RenderReport(report);
  if (report.status === 'NEEDS_CONFIRMATION') {
    const classes = (report.data?.gates?.violations || []).map((violation) => violation.class).join(', ') || 'UNKNOWN';
    v2.reportBlocked = true;
    v2El['v2-report-build'].disabled = true;
    v2SetStatus('v2-demo-status', `Demo ended: hard-gate violations (${classes}); report not confirmed.`);
    v2DemoFinish();
    return;
  }
  v2El['v2-report-output'].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  v2SetStatus('v2-demo-status', `Report generated (${report.data?.report?.reportVersion || 'v2'}) with no hard-gate violations.`);
  await v2DemoSleep(600);
  if (v2Demo.stopped) return;
  v2SetStatus('v2-demo-status', 'Demo complete: transcript → fixes → facts → report.');
  v2DemoFinish();
}

v2DemoEl.play.addEventListener('click', () => { v2PlayDemo(); });
v2UpdateDemoAvailability();
