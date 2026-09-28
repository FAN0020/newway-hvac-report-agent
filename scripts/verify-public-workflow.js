import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const config = JSON.parse(await fs.readFile(path.resolve('data/settings/public-demo.json'), 'utf8'));
const credentials = await fs.readFile(path.resolve('data/settings/public-demo-operator.txt'), 'utf8');
const password = /^Password: (.+)$/mu.exec(credentials)?.[1];
if (!password) throw new Error('Operator credentials are missing.');
const base = config.frontendOrigin;
let token = '';

async function request(route, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${base}${route}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.arrayBuffer();
  return { response, payload };
}

async function api(route, { method = 'GET', headers = {}, body } = {}) {
  const requestBody = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const result = await request(route, { method, body: requestBody,
    headers: { ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers } });
  if (!result.response.ok || result.payload?.status === 'FAIL') {
    throw new Error(`${method} ${route}: HTTP ${result.response.status} ${result.payload?.error_code || result.payload?.data?.message || ''}`);
  }
  return result.payload.data;
}

const home = await request('/');
assert.equal(home.response.status, 200, 'Public frontend must load anonymously.');
assert.match(new TextDecoder().decode(home.payload), /public-auth-form/u);
const unauthorized = await request('/api/health');
assert.equal(unauthorized.response.status, 401);
const login = await request('/session-bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ username: config.user, password }) });
assert.equal(login.response.status, 200, `Operator login failed: ${login.response.status} ${login.payload?.error_code || ''}`);
token = login.payload.token;
const health = await api('/api/health');
assert.equal(health.whisper.ready, true);
assert.equal(health.ollama.ready, true);
assert.ok(health.ollama.models.includes(config.ollamaModel));
console.log(`Public frontend, operator login, Whisper ${health.whisper.model}, and Ollama ${config.ollamaModel}: PASS`);
if (process.argv.includes('--smoke')) process.exit(0);

const created = await api('/api/report-sessions', { method: 'POST', body: {
  template_id: 'bus-defect-rectification-corrective-maintenance',
  template_version: '1.0.0', job_context_ref: 'work-order:WO-111-1222',
} });
let current = created;
const sessionId = created.session.session_id;
console.log(`Report session created: ${sessionId}`);
const audio = await fs.readFile(path.resolve('.tmp/public-verify/SBS-BUS-NORMAL-001.wav'));
const queued = await api(`/api/report-sessions/${sessionId}/capture/audio`, { method: 'POST', body: audio,
  headers: { 'content-type': 'audio/wav', 'x-expected-revision': String(current.session.revision),
    'idempotency-key': `public-audio-${sessionId}`, 'x-stt-language': 'en' } });
assert.match(queued.job_id, /^[a-f0-9]{64}$/u);
const deadline = Date.now() + 15 * 60_000;
let job;
while (Date.now() < deadline) {
  job = await api(`/api/audio-jobs/${queued.job_id}`);
  if (['complete', 'failed'].includes(job.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
assert.equal(job?.status, 'complete', `Audio job did not complete: ${job?.error?.code || job?.status}`);
current = job.result;
assert.ok(!current.failure, `Audio pipeline returned ${current.failure?.code}`);
assert.equal(current.transcript.provider, 'whisper.cpp');
assert.match(current.transcript.raw_text, /door/iu);
const reloaded = await api(`/api/report-sessions/${sessionId}`);
assert.equal(reloaded.session.revision, current.session.revision);
assert.equal(reloaded.transcripts.length, 1);
assert.ok(reloaded.field_candidates.some((candidate) => candidate.support_type === 'TRANSCRIPT_EVIDENCE'));
console.log(`Audio transcription and field routing: PASS (${current.transcript.raw_text})`);

if (current.review?.status === 'PENDING') {
  current = await api(`/api/report-sessions/${sessionId}/transcript-reviews/${current.review.review_id}/decide`, {
    method: 'POST', body: { expected_revision: current.session.revision,
      decisions: current.review.items.map((item) => ({ review_item_id: item.review_item_id, decision: 'REJECT' })) },
  });
}
assert.ok(current.agent_state?.resolution_queue?.length > 0 || !current.agent_state?.completeness?.complete,
  'The report should expose missing or unresolved fields before correction.');
let answers = 0;
const repeated = new Map();
while (current.agent_state.resolution_queue.length) {
  if (answers > 20) throw new Error('Resolution queue did not converge.');
  const item = current.agent_state.resolution_queue[0];
  repeated.set(item.field_id, (repeated.get(item.field_id) || 0) + 1);
  if (repeated.get(item.field_id) > 2) throw new Error(`Resolution did not converge for ${item.field_id}: ${item.reason}`);
  const field = current.agent_state.report_fields.find((entry) => entry.field_id === item.field_id);
  const permitted = field?.candidates.filter((entry) => item.candidate_ids.includes(entry.candidate_id)) || [];
  const candidate = permitted.find((entry) => entry.support_type === 'AUTHORITATIVE_SYSTEM_DATA')
    || permitted.find((entry) => entry.support_type === 'TRANSCRIPT_EVIDENCE') || permitted[0];
  const option = item.options?.[0];
  const answer = item.field_id === 'completion.state' ? { kind: 'VALUE', value: 'READY' }
    : item.field_id === 'diagnosis.root_cause' ? { kind: 'SEMANTIC_STATE', state: 'NOT_ESTABLISHED' }
      : item.field_id === 'measurement.odometer_km' ? { kind: 'VALUE', value: 51020, unit: 'km' }
        : candidate ? { kind: 'SELECT_CANDIDATE', candidate_id: candidate.candidate_id }
          : { kind: 'VALUE', value: option?.value || 'Not established' };
  current = await api(`/api/report-sessions/${sessionId}/resolution-items/${item.resolution_id}/answer`, {
    method: 'POST', body: { expected_revision: current.session.revision,
      answer,
      idempotency_key: `public-resolution-${item.resolution_id}` },
  });
  answers += 1;
}
assert.equal(current.agent_state.completeness.complete, true);
const review = await api(`/api/report-sessions/${sessionId}/review`, {
  method: 'POST', body: { expected_revision: current.session.revision },
});
const ready = await api(`/api/report-sessions/${sessionId}/review/complete`, {
  method: 'POST', body: { expected_revision: review.session.revision },
});
assert.equal(ready.session.phase, 'READY');
const confirmed = await api(`/api/report-sessions/${sessionId}/confirm`, {
  method: 'POST', body: { expected_revision: ready.session.revision },
});
assert.equal(confirmed.session.phase, 'CONFIRMED');
assert.equal(confirmed.confirmation.technician_principal_ref, `principal:${config.user}`);
const exportResult = await api(`/api/report-sessions/${sessionId}/export`, {
  method: 'POST', headers: { accept: 'application/json' }, body: { expected_revision: confirmed.session.revision },
});
const downloaded = await request(exportResult.download_url);
assert.equal(downloaded.response.status, 200);
assert.equal(new TextDecoder().decode(downloaded.payload.slice(0, 5)), '%PDF-');
console.log(`Missing-field correction, review, confirmation, and PDF export: PASS (${answers} resolution answers)`);
console.log(JSON.stringify({ status: 'PASS', public_url: base, session_id: sessionId,
  audio_job_id: queued.job_id, transcript: current.transcript?.raw_text || job.result.transcript.raw_text,
  resolution_answers: answers, snapshot_id: exportResult.snapshot_id, pdf_bytes: downloaded.payload.byteLength }));
