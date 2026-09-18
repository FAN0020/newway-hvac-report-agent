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
