import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TemplateStore } from '../src/storage/templates.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newway-template-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new TemplateStore({ root });
}

test('upload preserves source and truthfully reports manual schema review', async (t) => {
  const store = await fixture(t);
  const draft = await store.createDraft({
    name: 'Depot Daily Check', filename: 'daily-check.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: Buffer.from('prototype binary'),
  });
  assert.equal(draft.source.filename, 'daily-check.docx');
  assert.equal(draft.source.preserved, true);
  assert.equal(draft.analysis.status, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(draft.analysis.detectedFields.length, 0);
  assert.ok(draft.source.sha256);
  assert.equal((await fs.readFile(draft.source.path)).toString(), 'prototype binary');
});

test('manual schema, text context, test and publish form one immutable version contract', async (t) => {
  const store = await fixture(t);
  let draft = await store.createDraft({ name: 'Depot Daily Check', filename: 'daily-check.txt', mimeType: 'text/plain', bytes: Buffer.from('asset\ncondition\naction') });
  draft = await store.saveSchema(draft.id, {
    fields: [
      { id: 'asset.id', label: 'Asset ID', section: 'Identity', type: 'string', required: true },
      { id: 'inspection.condition', label: 'Condition', section: 'Inspection', type: 'status', required: true, allowedStatuses: ['NOT_CHECKED', 'OK', 'NOT_OK', 'N/A'] },
    ],
  });
  draft = await store.addContext(draft.id, { filename: 'guide.txt', mimeType: 'text/plain', bytes: Buffer.from('Use asset identifiers. Context is not job evidence.') });
  draft = await store.runContractTest(draft.id);
  assert.equal(draft.test.status, 'PASSED');
  const published = await store.publish(draft.id);
  assert.equal(published.status, 'PUBLISHED');
  assert.equal(published.templateVersion, '1.0.0');
  assert.equal(published.schema.version, '1.0.0');
  assert.equal(published.contextCorpus.version, '1.0.0');
  assert.equal(published.contextCorpus.jobFactPolicy, 'CONTEXT_MUST_NOT_ASSERT_JOB_FACTS');
  assert.equal((await store.listPublished()).length, 1);
  await assert.rejects(() => store.saveSchema(draft.id, { fields: [] }), /published|immutable/iu);
});

test('publish fails honestly when schema review, context decision, or test is incomplete', async (t) => {
  const store = await fixture(t);
  const draft = await store.createDraft({ name: 'Incomplete', filename: 'unknown.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF prototype') });
  await assert.rejects(() => store.publish(draft.id), (error) => {
    assert.equal(error.code, 'TEMPLATE_PUBLISH_GATES_FAILED');
    assert.ok(error.gates.includes('schema_review'));
    assert.ok(error.gates.includes('context'));
    assert.ok(error.gates.includes('test'));
    return true;
  });
});
