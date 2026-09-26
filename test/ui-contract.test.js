import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('technician UI and server expose every stage needed for the complete workflow', async () => {
  const [html, client, server] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
    fs.readFile('src/server.js', 'utf8'),
  ]);
  for (const id of ['manual-transcript', 'build-report', 'correction-raw', 'correction-proposed', 'correction-list', 'confirm-corrections', 'questions-list', 'facts-output', 'report-output', 'validator-output', 'technician-name', 'technician-id', 'confirm-report', 'save-report', 'export-report']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(client, new RegExp(id));
  }
  for (const id of ['v2-facts-text', 'resolve-count', 'resolve-progress', 'correction-list', 'questions-list']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(client, new RegExp(id));
  }
  assert.match(client, /processSbsStatement/);
  for (const route of ['/api/transcripts/manual', '/api/normalizations', '/api/corrections/confirm', '/api/facts/extract', '/api/reports/validate-input', '/api/reports/plan', '/api/reports/template', '/api/reports/generate', '/api/reports/validate-draft', '/api/reports/confirm', '/api/reports/save', '/api/reports/export']) {
    assert.match(server, new RegExp(route.replaceAll('/', '\\/')));
    assert.match(client, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.match(server, /readFacts\(input\.facts_receipt_id\)/);
  assert.match(client, /facts_receipt_id: currentFactsReceiptId/);
  assert.doesNotMatch(server, /validateReportDraft\(\{ draft: input\.draft, facts: input\.facts/);
  const normalizationCall = client.split('\n').find((line) => line.includes("api('/api/normalizations'"));
  assert.ok(normalizationCall);
  assert.doesNotMatch(normalizationCall, /model: el\.model\.value/);
  assert.doesNotMatch(normalizationCall, /knowledge_candidates/);
  const factsCall = client.split('\n').find((line) => line.includes("api('/api/facts/extract'"));
  assert.match(factsCall, /correction_receipt_id/);
  assert.doesNotMatch(factsCall, /transcript_artifact_id|corrected_text|confirmed_corrections/);
  assert.match(server, /process\.env\.HVAC_OLLAMA_MODEL/);
  assert.doesNotMatch(server, /input\.model \|\| process\.env\.HVAC_OLLAMA_MODEL/);
});

test('Capture technician flow transcribes recording and WAV inputs automatically and hides diagnostic controls', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
  ]);
  assert.match(html, /id="transcribe"[^>]*hidden[^>]*aria-hidden="true"[^>]*tabindex="-1"/);
  assert.match(html, /id="retry"[^>]*hidden[^>]*disabled/);
  assert.match(html, />Try again<\/button>/);

  const finishRecording = client.slice(client.indexOf('async function finishRecording()'), client.indexOf('async function uploadIfNeeded'));
  assert.match(finishRecording, /await ownedRecorder\.stop\(\)/);
  assert.match(finishRecording, /await transcribe\(1, targetSession\)/);

  const audioUpload = client.slice(client.indexOf("el['audio-file'].addEventListener"), client.indexOf("el.retry.addEventListener"));
  assert.match(audioUpload, /selectAudio\(file/);
  assert.match(audioUpload, /await transcribe\(1\)/);

  const manualFallback = client.slice(client.indexOf("el['type-instead'].addEventListener"), client.indexOf("el['view-statement'].addEventListener"));
  assert.match(manualFallback, /runtime\.beginRequest\(activeSession\.id, 'transcribe'\)/);
  assert.match(manualFallback, /Manual entry selected/);
  assert.match(manualFallback, /start-recording'\]\.disabled = false/);
  assert.match(client, /transcriptionState === 'failed'[\s\S]*Couldn't transcribe this recording\. Try again or type instead\./);
});

test('Capture supporting documents carry report and scope binding without gating manual readiness', async () => {
  const client = await fs.readFile('web/app.js', 'utf8');
  const upload = client.slice(client.indexOf('async function uploadSbsDocument'), client.indexOf('function renderUploadRow'));
  assert.match(upload, /'x-report-session-id': session\.id/);
  assert.match(upload, /binding\?\.report_session_id !== session\.id/);
  assert.match(upload, /refreshCaptureReadiness\(session\)/);
  assert.doesNotMatch(upload, /use-manual.*disabled\s*=\s*true/s);
  assert.match(client, /runtime\.activate\(session\);[\s\S]*audio-file'\]\.value = '';[\s\S]*v2-upload-file'\]\.value = '';/);
  assert.match(client, /await uploadSbsDocument\(file\);[\s\S]*v2-upload-file'\]\.value = '';/);
});
