import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TemplateStore } from '../src/storage/templates.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

async function publish(store, name, { context, mimeType = 'text/plain' } = {}) {
  let draft = await store.createDraft({ name, filename: 'form.txt', mimeType: 'text/plain', bytes: Buffer.from('Asset\nFinding\nReference') });
  draft = await store.saveSchema(draft.id, { fields: [
    { id: 'asset.id', label: 'Asset ID', section: 'Job', required: true },
    { id: 'inspection.finding', label: 'Finding', section: 'Job', required: true },
    { id: 'standard.reference', label: 'Reference', section: 'Reference', fieldRole: 'NORMATIVE_REFERENCE', allowedSources: ['TECHNICIAN', 'KNOWLEDGE'] },
  ] });
  draft = context ? await store.addContext(draft.id, { filename: mimeType === 'text/plain' ? 'guide.txt' : 'guide.pdf', mimeType, bytes: Buffer.from(context) })
    : await store.waiveContext(draft.id, 'No guide');
  draft = await store.runContractTest(draft.id);
  assert.equal(draft.test.status, 'PASSED');
  return store.publish(draft.id);
}

test('manager text upload, publication, bound session, retrieval, question and report state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-guidance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TemplateStore({ root: path.join(root, 'templates') });
  const alpha = await publish(store, 'Alpha Guide', { context: 'Connector AX-17 uses reference STD-42 for inspection terminology. This is a reference, not proof of work.' });
  const beta = await publish(store, 'Beta Guide', { context: 'Connector BX-90 uses reference STD-99 for inspection terminology.' });
  let binaryDraft = await store.createDraft({ name: 'Binary Guide', filename: 'form.txt', mimeType: 'text/plain', bytes: Buffer.from('Reference') });
  binaryDraft = await store.saveSchema(binaryDraft.id, { fields: [{ id: 'standard.reference', label: 'Reference', fieldRole: 'NORMATIVE_REFERENCE', allowedSources: ['TECHNICIAN', 'KNOWLEDGE'] }] });
  binaryDraft = await store.addContext(binaryDraft.id, { filename: 'guide.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF fake guide') });
  assert.equal(binaryDraft.context.documents[0].analysisStatus, 'PRESERVED_UNDETECTED');
  assert.equal((await store.runContractTest(binaryDraft.id)).test.status, 'FAILED');
  const waived = await publish(store, 'Waived Guide');
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'sessions') });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }), sessionStore,
    whisperProvider: { transcribe: async () => { throw new Error('unexpected'); } },
    templateProvider: async (id) => (await store.listPublished()).find((item) => item.templateId === id) || null,
    clock: () => '2026-10-01T00:00:00.000Z',
  });
  const open = async (template) => service.createSession({ template_id: template.templateId, template_version: template.templateVersion, job_context_ref: `new-report:${template.templateId}` });
  const first = await open(alpha);
  const plan = await service.getSourcePlan(first.session.session_id);
  assert.deepEqual(plan.fields.find((item) => item.field_id === 'standard.reference').eligible_sources, ['TECHNICIAN', 'KNOWLEDGE']);
  assert.deepEqual(plan.fields.find((item) => item.field_id === 'inspection.finding').eligible_sources, ['TECHNICIAN']);
  const captured = await service.captureText({ session_id: first.session.session_id, expected_revision: first.session.revision,
    text: 'Please check connector AX-17 inspection terminology.', language: 'en' });
  assert.equal(captured.guidance_context.eligible_as_job_evidence, false);
  assert.equal(captured.guidance_context.passages[0].provenance.filename, 'guide.txt');
  assert.equal(captured.guidance_context.passages[0].document_version, `1.0.0:${alpha.contextCorpus.sources[0].sha256}`);
  assert.ok(captured.guidance_context.follow_up_questions.some((item) => item.field === 'standard.reference'));
  assert.equal(captured.agent_state.report_fields.find((item) => item.field_id === 'standard.reference').state, 'UNKNOWN');
  const chain = await sessionStore.loadChain(first.session.session_id);
  assert.equal(chain.guidance_contexts.length, 1);
  assert.ok(chain.audit_events.some((item) => item.event_type === 'GUIDANCE_RETRIEVED'));
  const second = await open(beta);
  const secondCapture = await service.captureText({ session_id: second.session.session_id, expected_revision: second.session.revision,
    text: 'Please check connector AX-17 inspection terminology.', language: 'en' });
  assert.ok(secondCapture.guidance_context.passages.every((item) => item.document_id !== alpha.contextCorpus.sources[0].sha256));
  const empty = await open(waived);
  assert.equal((await service.getSourcePlan(empty.session.session_id)).fields.find((item) => item.field_id === 'standard.reference').knowledge_available, false);
  assert.equal((await service.captureText({ session_id: empty.session.session_id, expected_revision: empty.session.revision,
    text: 'Check connector AX-17.', language: 'en' })).guidance_context, null);
  await fs.writeFile(alpha.contextCorpus.sources[0].path, Buffer.alloc(alpha.contextCorpus.sources[0].size, 0x58));
  await assert.rejects(() => service.getSourcePlan(first.session.session_id), { code: 'TEMPLATE_CONTEXT_HASH_MISMATCH' });
  const corrupted = await open(alpha);
  await assert.rejects(() => service.getSourcePlan(corrupted.session.session_id), { code: 'TEMPLATE_CONTEXT_HASH_MISMATCH' });
  await assert.rejects(() => service.captureText({ session_id: corrupted.session.session_id, expected_revision: corrupted.session.revision,
    text: 'Check connector AX-17.', language: 'en' }), { code: 'TEMPLATE_CONTEXT_HASH_MISMATCH' });
});
