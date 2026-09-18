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
const demoNarration = '客户反映不制冷。检查发现运刑电容损坏。更换了一个三十五微法电容。试机运行正常。问题已解决。建议下次保养清洗滤网。';

function setSessionToken(value) {
  sessionToken = String(value || '').trim();
  if (sessionToken) sessionStorage.setItem(sessionTokenKey, sessionToken);
  else sessionStorage.removeItem(sessionTokenKey);
}

function requireLogin(message = '请输入启动服务时设置的临时演示口令。') {
  setSessionToken('');
  el['auth-gate'].hidden = false;
  el['auth-status'].textContent = message;
  el['auth-token'].value = '';
  el['auth-token'].focus();
}

async function api(path, body, options = {}) {
  const { allowToolFailure = false, ...fetchOptions } = options;
  if (!sessionToken) throw new Error('尚未建立演示会话。');
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
  if (response.status === 401) requireLogin('口令无效或会话已失效，请重新输入。');
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
  el['health-summary'].textContent = '正在检查本地组件…';
  try {
    const result = await api('/api/health', undefined, { allowToolFailure: true });
    const { whisper, ollama } = result.data;
    ollamaReady = ollama.ready;
    el['health-summary'].textContent = whisper.ready ? '语音入口可用；也可以使用手动原文。' : 'Whisper 未准备；请使用右侧手动原文完成流程。';
    el['health-details'].replaceChildren(
      healthBadge('Whisper', whisper.ready, whisper.ready ? `${whisper.model} 可用` : whisper.error_code),
      healthBadge('Ollama', ollama.ready, ollama.ready ? `${ollama.models.length} 个模型` : '将使用确定性流程'),
    );
  } catch (error) {
    el['health-summary'].textContent = `健康检查失败：${error.message}；手动入口仍可尝试。`;
    throw error;
  }
}

async function unlockWithToken(token) {
  setSessionToken(token);
  el['auth-status'].textContent = '正在验证口令…';
  try {
    await refreshHealth();
    el['auth-gate'].hidden = true;
    el['auth-status'].textContent = '';
  } catch (error) {
    if (sessionToken) requireLogin(`无法建立会话：${error.message}`);
  }
}

async function initializeSession() {
  const lanLike = !['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  el['network-mode'].textContent = lanLike ? '局域网演示模式' : '本机演示模式';
  el['network-warning'].textContent = !window.isSecureContext && lanLike
    ? '当前是局域网 HTTP 页面：手机或其他电脑的浏览器通常会禁用麦克风。可在主机浏览器录音，异机观看；或在异机使用手动文本。'
    : '临时口令只保存在当前标签页会话。请仅在可信 Wi-Fi 演示，不要暴露到公网。';
  if (!window.isSecureContext) {
    el['start-recording'].disabled = true;
    el['recording-status'].textContent = '当前页面不是安全上下文，浏览器麦克风已停用；请上传 WAV 或使用手动文本。';
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

function invalidateConfirmation(message = '报告内容已变化，需要重新校验和确认。') {
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
  invalidateConfirmation('已有原文，尚未生成和确认报告。');
  el['transcript-output'].textContent = artifact.raw_text;
  el['transcript-output'].classList.remove('empty');
  el['artifact-output'].textContent = JSON.stringify(artifact, null, 2);
  el['transcription-status'].textContent = `${message} 来源：${artifact.provider}。原文已作为不可变 Artifact 保存。`;
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
    el['recording-status'].textContent = `录音中（输入 ${sampleRate} Hz，保存为 16 kHz mono PCM WAV）…`;
    recordingTimer = setTimeout(() => el['stop-recording'].click(), 90_000);
  } catch (error) {
    el['recording-status'].textContent = `无法开始录音：${error.message}`;
    el['start-recording'].disabled = false;
  }
});

el['stop-recording'].addEventListener('click', async () => {
  clearTimeout(recordingTimer);
  el['stop-recording'].disabled = true;
  try {
    const wav = await recorder.stop();
    selectAudio(wav, `录音已就绪：${Math.round(wav.size / 1024)} KB。`);
  } catch (error) {
    el['recording-status'].textContent = `停止录音失败：${error.message}`;
  } finally {
    recorder = null;
    el['start-recording'].disabled = false;
  }
});

el['audio-file'].addEventListener('change', () => {
  const file = el['audio-file'].files?.[0];
  if (file) selectAudio(file, `已选择 ${file.name}，服务端将验证 WAV。`);
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
  el['transcription-status'].textContent = '正在本地转写…';
  try {
    const audioId = await uploadIfNeeded();
    const result = await api('/api/transcriptions', {
      audio_id: audioId, model: el.model.value, language: el.language.value, attempt,
      idempotency_key: `${audioId}:${el.model.value}:${el.language.value}:attempt-${attempt}`,
    });
    acceptTranscript(result.data.transcript, result.data.reused ? '复用了同一转写请求' : '语音转写完成');
  } catch (error) {
    el['transcription-status'].textContent = `转写失败（${error.result?.error_code || 'UNKNOWN'}）：${error.message}。可改用手动原文。`;
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
    acceptTranscript(result.data.transcript, '手动原文已保存（不是语音识别结果）');
  } catch (error) {
    el['transcription-status'].textContent = `手动原文保存失败：${error.message}`;
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
    input.placeholder = '填写技师实际观察或记录的内容';
    const missing = node('label', 'missing-check');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.missingField = field;
    missing.append(checkbox, document.createTextNode(' 本次未提供 / 稍后填写'));
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
  }) : [node('p', 'empty-note', '未提取到有来源的事实。')];
  el['facts-output'].replaceChildren(...factNodes);
  const corrections = normalization.data.correction_candidates || [];
  const missing = inputValidation.data.missing_required_fields || [];
  const issueNodes = [
    node('div', 'fact-card', corrections.length ? `术语修复候选：${corrections.length} 项` : '没有应用术语修复；原文保持不变。'),
    node('div', `fact-card ${missing.length ? 'needs-attention' : ''}`, missing.length ? `仍缺失：${missing.join('、')}` : '最低事实集合已覆盖。'),
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
    for (const [value, labelText] of [['ACCEPT', '接受此修复'], ['REJECT', '保留原文']]) {
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
      label.append(checkbox, document.createTextNode('我已人工核对该关键值/语义'));
      controls.append(label);
    }
    card.append(change, reason, controls);
    return card;
  }) : [node('div', 'fact-card', '未找到受控修复候选。技师仍需确认原文，系统将签发“原文确认”凭证。')]));
  el['correction-status'].textContent = candidates.length
    ? `找到 ${candidates.length} 项受控候选。请逐项决定；AI 建议尚未改动原文。`
    : '没有修复候选；请确认技师身份以签发原文确认凭证。';
  el['correction-section'].hidden = false;
}

function renderDraft(validation) {
  el['report-output'].replaceChildren(...currentDraft.sections.map((section) => {
    const block = node('section', 'report-section-block');
    block.append(node('h3', '', section.title));
    for (const item of section.items) {
      const line = node('p', item.type === 'template_text' ? 'placeholder' : '');
      line.textContent = item.text;
      if (item.fact_ids?.length) line.append(node('small', 'source-tag', `来源：${item.fact_ids.join(', ')}`));
      block.append(line);
    }
    return block;
  }));
  const reviewable = validation.data.can_enter_technician_review;
  el['validator-banner'].className = `validator-banner ${reviewable ? 'pass' : 'fail'}`;
  el['validator-banner'].textContent = reviewable
    ? `Validator：${validation.status}。来源覆盖率 ${Math.round(validation.data.provenance_coverage * 100)}%，可以进入技师复核。`
    : `Validator：${validation.status}。报告不能确认，请先修正校验问题。`;
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
  el['transcription-status'].textContent = '正在由服务端检索版本化 HVAC 术语候选…';
  try {
    currentNormalization = await api('/api/normalizations', { transcript_artifact_id: currentTranscript.artifact_id });
    renderCorrectionReview(currentNormalization);
    el['transcription-status'].textContent = '修复建议已展示，原始 TranscriptArtifact 仍未改动。';
  } catch (error) {
    el['transcription-status'].textContent = `修复候选检查失败（${error.result?.error_code || 'UNKNOWN'}）：${error.message}`;
  } finally {
    el['build-report'].disabled = false;
  }
}

async function generateReportFromReceipt() {
  if (!currentCorrectionReceipt) return;
  invalidateConfirmation();
  el['transcription-status'].textContent = '正在执行固定流程：确认文本 → 事实提取 → 缺失检查 → 模块规划 → 草稿 → Validator…';
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
    el['transcription-status'].textContent = '报告草稿和独立校验已生成。请处理追问并完成技师复核。';
  } catch (error) {
    el['transcription-status'].textContent = `生成失败（${error.result?.error_code || 'UNKNOWN'}）：${error.message}`;
  }
}

el['build-report'].addEventListener('click', prepareCorrectionReview);
el['confirm-corrections'].addEventListener('click', async () => {
  if (!currentNormalization || !currentTranscript) return;
  el['confirm-corrections'].disabled = true;
  try {
    const decisions = (currentNormalization.data.correction_candidates || []).map((candidate) => {
      const selected = el['correction-list'].querySelector(`input[name="decision-${candidate.candidate_id}"]:checked`);
      if (!selected) throw new Error(`请选择是否接受：${candidate.source_span.text} → ${candidate.candidate}`);
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
    el['correction-status'].textContent = `已签发不可变文本凭证 ${currentCorrectionReceipt.correction_receipt_id}，确认时间 ${currentCorrectionReceipt.confirmed_at}。`;
    await generateReportFromReceipt();
  } catch (error) {
    el['correction-status'].textContent = `文本确认失败（${error.result?.error_code || 'INPUT'}）：${error.message}`;
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
  invalidateConfirmation('正在绑定当前报告和校验结果…');
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
    el['confirmation-status'].textContent = `已确认版本 ${result.data.confirmation.report_version}；确认时间 ${result.data.confirmation.confirmed_at}。`;
  } catch (error) {
    el['confirmation-status'].textContent = `确认失败（${error.result?.error_code || 'UNKNOWN'}）：${error.message}`;
  }
});

el['save-report'].addEventListener('click', async () => {
  try {
    const result = await api('/api/reports/save', { draft: currentDraft, confirmation_token: confirmationToken });
    el['confirmation-status'].textContent = `${result.data.reused ? '已复用' : '已保存'}正式 JSON：${result.data.file}`;
  } catch (error) {
    el['confirmation-status'].textContent = `保存被拒绝（${error.result?.error_code || 'UNKNOWN'}）：${error.message}`;
  }
});
el['export-report'].addEventListener('click', async () => {
  try {
    const result = await api('/api/reports/export', { draft: currentDraft, confirmation_token: confirmationToken });
    el['export-output'].value = result.data.copyable_text;
    el['export-output'].hidden = false;
    el['copy-export'].disabled = false;
    el['confirmation-status'].textContent = `${result.data.reused ? '已复用' : '已导出'}文本：${result.data.file}`;
  } catch (error) {
    el['confirmation-status'].textContent = `导出被拒绝（${error.result?.error_code || 'UNKNOWN'}）：${error.message}`;
  }
});
el['copy-export'].addEventListener('click', async () => {
  await navigator.clipboard.writeText(el['export-output'].value);
  el['confirmation-status'].textContent = '报告文本已复制到剪贴板。';
});
el['fill-demo'].addEventListener('click', () => {
  el['manual-transcript'].value = demoNarration;
  el['transcription-status'].textContent = '已填入合成演示文本；尚未保存、提交或确认。';
});
el['auth-submit'].addEventListener('click', () => unlockWithToken(el['auth-token'].value));
el['auth-token'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter') unlockWithToken(el['auth-token'].value);
});
el['refresh-health'].addEventListener('click', () => refreshHealth().catch(() => {}));
initializeSession();
