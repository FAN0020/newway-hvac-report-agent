import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { hashContract } from '../src/domain/index.js';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportSessionStore } from '../src/storage/report-sessions.js';
import { createRetriever } from '../src/v2/retrieval.js';
import { loadScopeRegistry } from '../src/v2/scope.js';
import { createUploadStore } from '../src/v2/upload.js';
import { AuthoritativeCaptureService } from '../src/workflows/authoritative-capture.js';

async function fixture(t, name) {
  const root = path.resolve('.tmp-tests', `authoritative-guidance-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = await loadScopeRegistry();
  const uploadStore = createUploadStore({ baseDir: path.join(root, 'uploads') });
  const sessionStore = new ReportSessionStore({ root: path.join(root, 'authority') });
  const service = new AuthoritativeCaptureService({
    artifactStore: new ArtifactStore({ root: path.join(root, 'artifacts') }),
    sessionStore,
    whisperProvider: { transcribe: async () => { throw new Error('Unexpected transcription.'); } },
    scopeRegistry: registry,
    uploadStore,
    retriever: createRetriever({ registry, uploadStore }),
    clock: () => '2026-09-27T08:00:00.000Z',
  });
  return { service, sessionStore };
}

async function createBusSession(service, suffix) {
  return service.createSession({
    template_id: 'bus-defect-rectification-corrective-maintenance',
    template_version: '1.0.0',
    job_context_ref: `job-context:GUIDANCE-${suffix}`,
  });
}

test('ReportSession owns upload scope, retrieval query, persisted GuidanceContext, and candidate provenance', async (t) => {
  const { service, sessionStore } = await fixture(t, 'owned');
  const created = await createBusSession(service, 'OWNED');
  const uploaded = await service.ingestGuidanceUpload({
    session_id: created.session.session_id,
    expected_revision: 0,
    filename: 'depot-door-sop.txt',
    mime_type: 'text/plain',
    buffer: Buffer.from('For a door control module fault, inspect connector ZX-47 before replacement.', 'utf8'),
  });

  assert.equal(uploaded.upload.scope_id, 'SBS_BUS');
  assert.equal(uploaded.upload.provenance.report_session_id, created.session.session_id);
  assert.deepEqual(uploaded.session.guidance_upload_ids, [uploaded.upload.upload_id]);

  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: uploaded.session.revision,
    text: 'Bus MAN A95 had a door control module fault. Replaced the door control module.',
    language: 'en',
  });

  assert.equal(captured.guidance_context.support_type, 'RAG_GUIDANCE');
  assert.equal(captured.guidance_context.eligible_as_job_evidence, false);
  assert.equal(captured.guidance_context.query, captured.transcript.raw_text);
  assert.ok(captured.guidance_context.passages.some((passage) => passage.document_id === uploaded.upload.upload_id));
  assert.ok(captured.guidance_context.passages.every((passage) => passage.document_version));
  assert.ok(captured.candidates.every((candidate) => candidate.extraction.method === 'deterministic-rule'));
  assert.ok(captured.candidates.every((candidate) => candidate.extraction.version));
  assert.ok(captured.candidates.every((candidate) => candidate.risk_class));
  assert.ok(captured.candidates.every((candidate) => candidate.source_context.scope_id === 'SBS_BUS'));
  assert.ok(captured.candidates.every((candidate) => candidate.evidence_refs[0].evidence_id === captured.transcript.transcript_id));
  assert.ok(captured.candidates.every((candidate) => !candidate.evidence_refs.some((ref) => ref.evidence_id.startsWith('guidance_'))));

  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.deepEqual(chain.session.guidance_context_ids, [captured.guidance_context.guidance_context_id]);
  assert.equal(chain.guidance_contexts.length, 1);
  assert.deepEqual(chain.guidance_uploads.map((upload) => upload.upload_id), [uploaded.upload.upload_id]);
  assert.ok(chain.audit_events.some((event) => event.event_type === 'GUIDANCE_UPLOAD_INGESTED'));
  assert.ok(chain.audit_events.some((event) => event.event_type === 'GUIDANCE_RETRIEVED'));
  for (const candidate of chain.field_candidates) {
    const reference = candidate.evidence_refs[0];
    const span = chain.evidence_spans.find((item) => item.span_id === reference.span_id);
    assert.ok(span);
    assert.equal(
      hashContract(captured.transcript.raw_text.slice(span.start_offset, span.end_offset)),
      span.quote_hash,
    );
  }
});

test('same-domain uploads remain isolated to the ReportSession that ingested them', async (t) => {
  const { service } = await fixture(t, 'session-isolation');
  const first = await createBusSession(service, 'FIRST');
  const second = await createBusSession(service, 'SECOND');
  await service.ingestGuidanceUpload({
    session_id: first.session.session_id,
    expected_revision: 0,
    filename: 'private-session-a.txt',
    mime_type: 'text/plain',
    buffer: Buffer.from('Proprietary Zebra-991 door actuator procedure.', 'utf8'),
  });

  const captured = await service.captureText({
    session_id: second.session.session_id,
    expected_revision: 0,
    text: 'Bus MAN A95 has proprietary Zebra-991 door actuator fault.',
    language: 'en',
  });

  assert.ok(captured.guidance_context.passages.every((passage) => passage.source_type !== 'upload'));
  assert.deepEqual(captured.guidance_context.permitted_corpora.filter((item) => item.startsWith('upload:')), []);
});

test('technician field answers and confirmations remain server-owned evidence, never GuidanceContext', async (t) => {
  const { service, sessionStore } = await fixture(t, 'field-answer');
  const created = await createBusSession(service, 'FIELD');
  const captured = await service.captureText({
    session_id: created.session.session_id,
    expected_revision: 0,
    text: 'Bus MAN A95 had a door fault.',
    language: 'en',
  });
  const answered = await service.submitFieldAnswer({
    session_id: created.session.session_id,
    expected_revision: captured.session.revision,
    field_id: 'completion.state',
    value: 'NOT_READY',
  });
  assert.equal(answered.candidate.support_type, 'MANUAL_TECHNICIAN_INPUT');
  assert.equal(answered.candidate.risk_class, 'CRITICAL');
  assert.ok(answered.candidate.evidence_refs.every((ref) => !ref.evidence_id.startsWith('guidance_')));

  const confirmed = await service.confirmFieldCandidate({
    session_id: created.session.session_id,
    expected_revision: answered.session.revision,
    candidate_id: answered.candidate.candidate_id,
  });
  assert.equal(confirmed.candidate.support_type, 'TECHNICIAN_CONFIRMATION');
  assert.equal(confirmed.candidate.confirmed_candidate_id, answered.candidate.candidate_id);
  assert.notEqual(confirmed.candidate.source_ref, captured.guidance_context.guidance_context_id);

  const chain = await sessionStore.loadChain(created.session.session_id);
  assert.ok(chain.field_candidates.some((candidate) => candidate.candidate_id === confirmed.candidate.candidate_id));
  assert.ok(chain.guidance_contexts.every((context) => context.support_type === 'RAG_GUIDANCE'));
});
