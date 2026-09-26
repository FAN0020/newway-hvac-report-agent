import assert from 'node:assert/strict';
import test from 'node:test';

test('unified report contracts expose the required field, support, and phase vocabularies', async () => {
  const contracts = await import('../src/domain/index.js');

  assert.deepEqual([...contracts.FIELD_STATES], [
    'KNOWN_VALUE',
    'EXPLICIT_NONE',
    'NOT_APPLICABLE',
    'UNKNOWN',
    'UNCERTAIN',
    'CONFLICT',
    'INVALID',
    'INFERRED',
  ]);
  assert.deepEqual([...contracts.SUPPORT_TYPES], [
    'TRANSCRIPT_EVIDENCE',
    'AUTHORITATIVE_SYSTEM_DATA',
    'DOCUMENT_EVIDENCE',
    'MANUAL_TECHNICIAN_INPUT',
    'TECHNICIAN_CONFIRMATION',
    'AI_INFERENCE',
    'RAG_GUIDANCE',
  ]);
  assert.deepEqual([...contracts.SESSION_PHASES], [
    'CONTEXT',
    'CAPTURE',
    'PROCESSING',
    'CORRECTION_IF_NEEDED',
    'RESOLVE',
    'REVIEW',
    'READY',
    'CONFIRMED',
    'RECOVERABLE_ERROR',
  ]);

  assert.equal(Object.isFrozen(contracts.FIELD_STATES), true);
  assert.equal(Object.isFrozen(contracts.SUPPORT_TYPES), true);
  assert.equal(Object.isFrozen(contracts.SESSION_PHASES), true);
});

test('evidence, spans, transcripts, and transcript reviews preserve immutable provenance', async () => {
  const {
    createEvidence,
    createEvidenceSpan,
    createTranscriptArtifact,
    createTranscriptReview,
  } = await import('../src/domain/index.js');
  const createdAt = '2026-09-27T01:00:00.000Z';
  const audio = createEvidence({
    evidence_type: 'AUDIO',
    source_hash: `sha256:${'a'.repeat(64)}`,
    storage_ref: 'artifact://audio/audio_123.wav',
    created_at: createdAt,
    metadata: { mime_type: 'audio/wav', size_bytes: 128 },
  });
  const sameAudio = createEvidence({
    metadata: { size_bytes: 128, mime_type: 'audio/wav' },
    created_at: createdAt,
    storage_ref: 'artifact://audio/audio_123.wav',
    source_hash: `sha256:${'a'.repeat(64)}`,
    evidence_type: 'AUDIO',
  });
  const transcript = createTranscriptArtifact({
    session_id: 'session_contract_1',
    source_evidence_id: audio.evidence_id,
    raw_text: 'Replaced the door actuator.',
    language: 'en',
    provider_ref: 'local-whisper/base',
    created_at: createdAt,
    segments: [{ start_ms: 0, end_ms: 1400, text: 'Replaced the door actuator.' }],
  });
  const span = createEvidenceSpan({
    evidence_id: transcript.transcript_id,
    start_offset: 0,
    end_offset: 8,
    quote: 'Replaced',
    source_text: transcript.raw_text,
  });
  const review = createTranscriptReview({
    session_id: 'session_contract_1',
    transcript_id: transcript.transcript_id,
    status: 'REVIEWED',
    decisions: [{ review_item_id: 'term_door_1', decision: 'ACCEPT' }],
    reviewer_principal_ref: 'principal:future-tech-7',
    reviewed_at: '2026-09-27T01:01:00.000Z',
  });

  assert.match(audio.evidence_id, /^evidence_[a-f0-9]{24}$/);
  assert.equal(sameAudio.evidence_id, audio.evidence_id);
  assert.match(transcript.transcript_id, /^transcript_[a-f0-9]{24}$/);
  assert.match(span.span_id, /^span_[a-f0-9]{24}$/);
  assert.match(span.quote_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(span.offset_unit, 'UTF16_CODE_UNIT');
  assert.equal(review.transcript_id, transcript.transcript_id);
  assert.equal(Object.isFrozen(audio.metadata), true);
  assert.equal(Object.isFrozen(transcript.segments), true);
  assert.equal(Object.isFrozen(review.decisions[0]), true);

  assert.throws(() => createEvidenceSpan({
    evidence_id: transcript.transcript_id,
    start_offset: 8,
    end_offset: 8,
    quote: '',
    source_text: transcript.raw_text,
  }), { code: 'INVALID_EVIDENCE_SPAN' });
  assert.throws(() => createEvidenceSpan({
    evidence_id: transcript.transcript_id,
    start_offset: 0,
    end_offset: 8,
    quote: 'Actuator',
    source_text: transcript.raw_text,
  }), { code: 'EVIDENCE_SPAN_TEXT_MISMATCH' });
  assert.throws(() => createTranscriptArtifact({
    session_id: 'session_contract_1',
    source_evidence_id: audio.evidence_id,
    raw_text: '',
    created_at: createdAt,
  }), { code: 'INVALID_TRANSCRIPT_ARTIFACT' });
  assert.throws(() => createEvidence({
    evidence_id: `evidence_${'0'.repeat(24)}`,
    evidence_type: 'AUDIO',
    source_hash: `sha256:${'a'.repeat(64)}`,
    storage_ref: 'artifact://audio/audio_123.wav',
    created_at: createdAt,
  }), { code: 'CONTENT_ID_MISMATCH' });
});

test('GuidanceContext is structurally separate and permanently ineligible as job evidence', async () => {
  const { createGuidanceContext } = await import('../src/domain/index.js');
  const guidance = createGuidanceContext({
    session_id: 'session_contract_1',
    context_id: 'SBS/BUS',
    scope_id: 'SBS_BUS',
    context_version: 'scope-registry.v1',
    retrieved_at: '2026-09-27T01:02:00.000Z',
    passages: [{
      source_id: 'sbs-bus-parts.v1.json',
      chunk_id: 'knowledge:SBS_BUS:parts:door-actuator',
      text: 'Inspect the door actuator and replace it when defective.',
      score: 0.92,
    }],
  });

  assert.match(guidance.guidance_context_id, /^guidance_[a-f0-9]{24}$/);
  assert.equal(guidance.support_type, 'RAG_GUIDANCE');
  assert.equal(guidance.eligible_as_job_evidence, false);
  assert.equal(Object.hasOwn(guidance, 'evidence_id'), false);
  assert.equal(Object.isFrozen(guidance.passages[0]), true);
});

test('validation and resolution contracts retain exact candidate and evidence references', async () => {
  const { createValidationIssue, createResolutionItem } = await import('../src/domain/index.js');
  const issue = createValidationIssue({
    issue_id: 'issue_completion_conflict',
    code: 'FIELD_CONFLICT',
    severity: 'ERROR',
    field_id: 'completion.state',
    candidate_ids: ['candidate_completed', 'candidate_deferred'],
    evidence_refs: [{ evidence_id: 'transcript_123', span_id: 'span_123' }],
    message: 'Completion state has competing supported values.',
  });
  const resolution = createResolutionItem({
    resolution_id: 'resolution_completion_conflict',
    issue_id: issue.issue_id,
    type: 'SELECT_CANDIDATE',
    field_id: 'completion.state',
    candidate_ids: issue.candidate_ids,
    prompt: 'Which completion state did you observe?',
    status: 'OPEN',
  });

  assert.deepEqual(resolution.candidate_ids, ['candidate_completed', 'candidate_deferred']);
  assert.equal(Object.isFrozen(issue.evidence_refs[0]), true);
  assert.equal(Object.isFrozen(resolution), true);
});

test('UNKNOWN, EXPLICIT_NONE, and NOT_APPLICABLE remain distinct field states', async () => {
  const { createFieldCandidate, createReportField } = await import('../src/domain/index.js');
  const unknown = createReportField({ session_id: 'session_contract_1', field_id: 'parts.part_number', candidates: [] });
  const explicitNoneCandidate = createFieldCandidate({
    session_id: 'session_contract_1',
    field_id: 'parts.part_number',
    claim: { kind: 'EXPLICIT_NONE' },
    support_type: 'MANUAL_TECHNICIAN_INPUT',
    evidence_refs: [{ evidence_id: 'evidence_manual_1' }],
  });
  const notApplicableCandidate = createFieldCandidate({
    session_id: 'session_contract_1',
    field_id: 'warranty.reference',
    claim: { kind: 'NOT_APPLICABLE' },
    support_type: 'AUTHORITATIVE_SYSTEM_DATA',
    evidence_refs: [{ evidence_id: 'evidence_system_1' }],
  });

  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(createReportField({ session_id: 'session_contract_1', field_id: 'parts.part_number', candidates: [explicitNoneCandidate] }).state, 'EXPLICIT_NONE');
  assert.equal(createReportField({ session_id: 'session_contract_1', field_id: 'warranty.reference', candidates: [notApplicableCandidate] }).state, 'NOT_APPLICABLE');
  assert.notDeepEqual(explicitNoneCandidate.claim, notApplicableCandidate.claim);
});

test('multiple competing candidates produce CONFLICT without losing provenance', async () => {
  const { createFieldCandidate, createReportField } = await import('../src/domain/index.js');
  const completed = createFieldCandidate({
    session_id: 'session_contract_1',
    field_id: 'completion.state',
    claim: { kind: 'VALUE', value: 'completed' },
    support_type: 'TRANSCRIPT_EVIDENCE',
    evidence_refs: [{ evidence_id: 'transcript_1', span_id: 'span_completed' }],
  });
  const deferred = createFieldCandidate({
    session_id: 'session_contract_1',
    field_id: 'completion.state',
    claim: { kind: 'VALUE', value: 'deferred' },
    support_type: 'DOCUMENT_EVIDENCE',
    evidence_refs: [{ evidence_id: 'document_1', span_id: 'span_deferred' }],
  });
  const field = createReportField({ session_id: 'session_contract_1', field_id: 'completion.state', candidates: [completed, deferred] });

  assert.equal(field.session_id, 'session_contract_1');
  assert.equal(field.state, 'CONFLICT');
  assert.equal(field.candidates.length, 2);
  assert.deepEqual(field.candidates.map((candidate) => candidate.support_type), [
    'TRANSCRIPT_EVIDENCE',
    'DOCUMENT_EVIDENCE',
  ]);
  assert.deepEqual(field.candidates.map((candidate) => candidate.evidence_refs[0].span_id), [
    'span_completed',
    'span_deferred',
  ]);
  assert.throws(() => createReportField({
    session_id: 'session_other',
    field_id: 'completion.state',
    candidates: [completed],
  }), { code: 'CROSS_SESSION_CANDIDATE' });
});

test('FieldState is derived separately from SupportType for known, inferred, uncertain, and invalid values', async () => {
  const { createFieldCandidate, createReportField } = await import('../src/domain/index.js');
  const candidate = (supportType, assessment = 'VALID') => createFieldCandidate({
    session_id: 'session_contract_1',
    field_id: 'inspection_findings',
    claim: { kind: 'VALUE', value: 'Door actuator was worn.' },
    support_type: supportType,
    assessment,
    evidence_refs: supportType === 'AI_INFERENCE' ? [] : [{ evidence_id: `evidence_${supportType.toLowerCase()}` }],
  });

  assert.equal(createReportField({ session_id: 'session_contract_1', field_id: 'inspection_findings', candidates: [candidate('TRANSCRIPT_EVIDENCE')] }).state, 'KNOWN_VALUE');
  assert.equal(createReportField({ session_id: 'session_contract_1', field_id: 'inspection_findings', candidates: [candidate('AI_INFERENCE')] }).state, 'INFERRED');
  assert.equal(createReportField({ session_id: 'session_contract_1', field_id: 'inspection_findings', candidates: [candidate('TRANSCRIPT_EVIDENCE', 'UNCERTAIN')] }).state, 'UNCERTAIN');
  assert.equal(createReportField({ session_id: 'session_contract_1', field_id: 'inspection_findings', candidates: [candidate('TRANSCRIPT_EVIDENCE', 'INVALID')] }).state, 'INVALID');
});

test('ordinary client candidates cannot establish technician confirmation or promote RAG guidance', async () => {
  const { createFieldCandidate } = await import('../src/domain/index.js');
  const base = {
    session_id: 'session_contract_1',
    field_id: 'completion.state',
    claim: { kind: 'VALUE', value: 'completed' },
    evidence_refs: [{ evidence_id: 'transcript_1', span_id: 'span_1' }],
  };

  assert.throws(() => createFieldCandidate({ ...base, support_type: 'TECHNICIAN_CONFIRMATION' }), {
    code: 'UNTRUSTED_TECHNICIAN_CONFIRMATION',
  });
  assert.throws(() => createFieldCandidate({
    ...base,
    support_type: 'RAG_GUIDANCE',
    evidence_refs: [{ evidence_id: 'guidance_123' }],
  }), { code: 'GUIDANCE_NOT_JOB_EVIDENCE' });
  assert.throws(() => createFieldCandidate({
    ...base,
    candidate_id: `candidate_${'0'.repeat(24)}`,
    support_type: 'TRANSCRIPT_EVIDENCE',
  }), { code: 'CONTENT_ID_MISMATCH' });
});

test('technician confirmation support requires a server-issued event with a future principal binding', async () => {
  const {
    createConfirmedFieldCandidate,
    createReportField,
    createTechnicianConfirmationEvent,
  } = await import('../src/domain/index.js');
  const event = createTechnicianConfirmationEvent({
    session_id: 'session_contract_1',
    revision: 6,
    field_id: 'completion.state',
    candidate_id: 'candidate_completion_source',
    technician_principal_ref: 'principal:future-tech-7',
    occurred_at: '2026-09-27T01:03:00.000Z',
  });
  const confirmed = createConfirmedFieldCandidate({
    session_id: 'session_contract_1',
    field_id: 'completion.state',
    confirmed_candidate_id: 'candidate_completion_source',
    claim: { kind: 'VALUE', value: 'completed' },
    evidence_refs: [{ evidence_id: 'transcript_1', span_id: 'span_1' }],
  }, { confirmation_event: event });

  assert.equal(event.issued_by, 'SERVER');
  assert.equal(event.event_type, 'TECHNICIAN_CONFIRMATION');
  assert.equal(confirmed.support_type, 'TECHNICIAN_CONFIRMATION');
  assert.equal(confirmed.confirmation_event_id, event.event_id);
  assert.equal(confirmed.technician_principal_ref, 'principal:future-tech-7');
  assert.equal(createReportField({ session_id: 'session_contract_1', field_id: 'completion.state', candidates: [confirmed] }).state, 'KNOWN_VALUE');

  assert.throws(() => createConfirmedFieldCandidate({
    session_id: 'session_contract_1',
    field_id: 'completion.state',
    confirmed_candidate_id: 'candidate_completion_source',
    claim: { kind: 'VALUE', value: 'completed' },
    evidence_refs: [],
  }, { confirmation_event: { ...event, issued_by: 'CLIENT' } }), { code: 'INVALID_CONFIRMATION_EVENT' });

  assert.throws(() => createConfirmedFieldCandidate({
    session_id: 'session_contract_1',
    field_id: 'completion.state',
    confirmed_candidate_id: 'candidate_other',
    claim: { kind: 'VALUE', value: 'completed' },
    evidence_refs: [{ evidence_id: 'transcript_1', span_id: 'span_1' }],
  }, { confirmation_event: event }), { code: 'CONFIRMATION_BINDING_MISMATCH' });
});

function sessionInput() {
  return {
    session_id: 'session_contract_1',
    template_binding: {
      template_id: 'bus-defect-rectification-corrective-maintenance',
      template_version: '1.0.0',
    },
    context_binding: {
      context_id: 'SBS/BUS',
      context_version: 'scope-registry.v1',
      scope_id: 'SBS_BUS',
    },
    job_context_ref: 'job-context:WO-123',
    created_at: '2026-09-27T02:00:00.000Z',
  };
}

test('ReportSession is server-authoritative, version-bound, revisioned, and immutable', async () => {
  const { createReportSession } = await import('../src/domain/index.js');
  const session = createReportSession(sessionInput());

  assert.equal(session.contract, 'ReportSession');
  assert.equal(session.authority, 'SERVER');
  assert.equal(session.client_input_trusted, false);
  assert.equal(session.phase, 'CONTEXT');
  assert.equal(session.status, 'ACTIVE');
  assert.equal(session.revision, 0);
  assert.equal(session.template_binding.template_version, '1.0.0');
  assert.equal(session.context_binding.scope_id, 'SBS_BUS');
  assert.deepEqual(session.audit_event_ids, []);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.template_binding), true);
});

test('the complete happy path uses deterministic transitions and increments one revision per event', async () => {
  const { createReportSession, transitionReportSession } = await import('../src/domain/index.js');
  let session = createReportSession(sessionInput());
  const steps = [
    ['CAPTURE', '2026-09-27T02:01:00.000Z'],
    ['PROCESSING', '2026-09-27T02:02:00.000Z'],
    ['CORRECTION_IF_NEEDED', '2026-09-27T02:03:00.000Z'],
    ['RESOLVE', '2026-09-27T02:04:00.000Z'],
    ['REVIEW', '2026-09-27T02:05:00.000Z'],
    ['READY', '2026-09-27T02:06:00.000Z'],
    ['CONFIRMED', '2026-09-27T02:07:00.000Z'],
  ];
  for (const [toPhase, occurredAt] of steps) {
    const before = session;
    const transition = transitionReportSession(session, {
      expected_revision: session.revision,
      to_phase: toPhase,
      occurred_at: occurredAt,
    });
    session = transition.session;
    assert.equal(session.revision, before.revision + 1);
    assert.equal(session.phase, toPhase);
    assert.equal(transition.event.event_type, 'PHASE_TRANSITION');
    assert.equal(transition.event.payload.from_phase, before.phase);
    assert.equal(transition.event.payload.to_phase, toPhase);
    assert.deepEqual(session.audit_event_ids.slice(0, -1), before.audit_event_ids);
    assert.equal(session.audit_event_ids.at(-1), transition.event.event_id);
  }

  assert.equal(session.status, 'CONFIRMED');
  assert.equal(session.revision, 7);
  assert.equal(session.audit_event_ids.length, 7);
  assert.throws(() => transitionReportSession(session, {
    expected_revision: 7,
    to_phase: 'REVIEW',
    occurred_at: '2026-09-27T02:08:00.000Z',
  }), { code: 'INVALID_PHASE_TRANSITION' });
});

test('processing may skip transcript correction but cannot skip Resolve or Review', async () => {
  const { createReportSession, transitionReportSession } = await import('../src/domain/index.js');
  let session = createReportSession(sessionInput());
  for (const toPhase of ['CAPTURE', 'PROCESSING']) {
    session = transitionReportSession(session, {
      expected_revision: session.revision,
      to_phase: toPhase,
      occurred_at: `2026-09-27T02:0${session.revision + 1}:00.000Z`,
    }).session;
  }
  session = transitionReportSession(session, {
    expected_revision: 2,
    to_phase: 'RESOLVE',
    occurred_at: '2026-09-27T02:03:00.000Z',
  }).session;
  assert.equal(session.phase, 'RESOLVE');

  assert.throws(() => transitionReportSession(session, {
    expected_revision: 3,
    to_phase: 'READY',
    occurred_at: '2026-09-27T02:04:00.000Z',
  }), { code: 'INVALID_PHASE_TRANSITION' });
});

test('stale expected revisions fail before mutation and invalid transitions fail explicitly', async () => {
  const { createReportSession, transitionReportSession } = await import('../src/domain/index.js');
  const original = createReportSession(sessionInput());
  const capture = transitionReportSession(original, {
    expected_revision: 0,
    to_phase: 'CAPTURE',
    occurred_at: '2026-09-27T02:01:00.000Z',
  }).session;

  assert.throws(() => transitionReportSession(capture, {
    expected_revision: 0,
    to_phase: 'PROCESSING',
    occurred_at: '2026-09-27T02:02:00.000Z',
  }), (error) => error.code === 'STALE_REVISION' && error.expected_revision === 0 && error.actual_revision === 1);
  assert.throws(() => transitionReportSession(original, {
    expected_revision: 0,
    to_phase: 'REVIEW',
    occurred_at: '2026-09-27T02:01:00.000Z',
  }), { code: 'INVALID_PHASE_TRANSITION' });
  assert.equal(original.phase, 'CONTEXT');
  assert.equal(original.revision, 0);
});

test('recoverable errors retain the failed phase and only recover to that phase', async () => {
  const { createReportSession, transitionReportSession } = await import('../src/domain/index.js');
  let session = createReportSession(sessionInput());
  for (const toPhase of ['CAPTURE', 'PROCESSING']) {
    session = transitionReportSession(session, {
      expected_revision: session.revision,
      to_phase: toPhase,
      occurred_at: `2026-09-27T02:0${session.revision + 1}:00.000Z`,
    }).session;
  }
  const failed = transitionReportSession(session, {
    expected_revision: 2,
    to_phase: 'RECOVERABLE_ERROR',
    occurred_at: '2026-09-27T02:03:00.000Z',
    error: { code: 'TRANSCRIPTION_FAILED', message: 'Audio remains stored.' },
  });
  assert.equal(failed.session.status, 'ERROR');
  assert.equal(failed.session.recovery_phase, 'PROCESSING');
  assert.deepEqual(failed.session.last_error, {
    code: 'TRANSCRIPTION_FAILED',
    message: 'Audio remains stored.',
    retryable: true,
  });
  assert.equal(failed.event.event_type, 'RECOVERABLE_ERROR_RECORDED');

  assert.throws(() => transitionReportSession(failed.session, {
    expected_revision: 3,
    to_phase: 'CAPTURE',
    occurred_at: '2026-09-27T02:04:00.000Z',
  }), { code: 'INVALID_RECOVERY_TRANSITION' });

  const recovered = transitionReportSession(failed.session, {
    expected_revision: 3,
    to_phase: 'PROCESSING',
    occurred_at: '2026-09-27T02:04:00.000Z',
  });
  assert.equal(recovered.session.phase, 'PROCESSING');
  assert.equal(recovered.session.status, 'ACTIVE');
  assert.equal(recovered.session.recovery_phase, null);
  assert.equal(recovered.session.last_error, null);
  assert.equal(recovered.event.event_type, 'SESSION_RECOVERED');
});

async function readySession(contracts) {
  let session = contracts.createReportSession(sessionInput());
  for (const [index, toPhase] of ['CAPTURE', 'PROCESSING', 'RESOLVE', 'REVIEW', 'READY'].entries()) {
    session = contracts.transitionReportSession(session, {
      expected_revision: session.revision,
      to_phase: toPhase,
      occurred_at: `2026-09-27T03:0${index + 1}:00.000Z`,
    }).session;
  }
  return session;
}

test('ReportSnapshot captures an immutable exact session revision without mixing guidance into evidence', async () => {
  const contracts = await import('../src/domain/index.js');
  const session = await readySession(contracts);
  const candidate = contracts.createFieldCandidate({
    session_id: session.session_id,
    field_id: 'work_performed',
    claim: { kind: 'VALUE', value: 'Replaced the door actuator.' },
    support_type: 'TRANSCRIPT_EVIDENCE',
    evidence_refs: [{ evidence_id: 'transcript_1', span_id: 'span_work' }],
  });
  const field = contracts.createReportField({ session_id: session.session_id, field_id: 'work_performed', candidates: [candidate] });
  const snapshot = contracts.createReportSnapshot({
    session,
    fields: [field],
    evidence_ids: ['audio_1', 'transcript_1'],
    transcript_ids: ['transcript_1'],
    guidance_context_ids: ['guidance_1'],
    validation_issues: [],
    resolution_items: [],
    created_at: '2026-09-27T03:06:00.000Z',
  });

  assert.match(snapshot.snapshot_id, /^snapshot_[a-f0-9]{24}$/);
  assert.match(snapshot.snapshot_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.session_id, session.session_id);
  assert.equal(snapshot.session_revision, 5);
  assert.deepEqual(snapshot.evidence_ids, ['audio_1', 'transcript_1']);
  assert.deepEqual(snapshot.guidance_context_ids, ['guidance_1']);
  assert.equal(snapshot.fields[0].state, 'KNOWN_VALUE');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.fields[0].candidates[0].evidence_refs[0]), true);
  assert.throws(() => { snapshot.fields[0].state = 'UNKNOWN'; }, TypeError);

  const otherCandidate = contracts.createFieldCandidate({
    session_id: 'session_other',
    field_id: 'work_performed',
    claim: { kind: 'VALUE', value: 'Unrelated work.' },
    support_type: 'MANUAL_TECHNICIAN_INPUT',
    evidence_refs: [{ evidence_id: 'evidence_other' }],
  });
  const otherField = contracts.createReportField({
    session_id: 'session_other',
    field_id: 'work_performed',
    candidates: [otherCandidate],
  });
  assert.throws(() => contracts.createReportSnapshot({
    session,
    fields: [otherField],
    evidence_ids: ['evidence_other'],
    transcript_ids: [],
    guidance_context_ids: [],
    validation_issues: [],
    resolution_items: [],
    created_at: '2026-09-27T03:06:00.000Z',
  }), { code: 'CROSS_SESSION_FIELD' });
});

test('contract hashing and snapshot identity are deterministic across key order', async () => {
  const contracts = await import('../src/domain/index.js');
  assert.equal(contracts.hashContract({ b: 2, a: 1 }), contracts.hashContract({ a: 1, b: 2 }));

  const session = await readySession(contracts);
  const input = {
    session,
    fields: [],
    evidence_ids: [],
    transcript_ids: [],
    guidance_context_ids: [],
    validation_issues: [],
    resolution_items: [],
    created_at: '2026-09-27T03:06:00.000Z',
  };
  const first = contracts.createReportSnapshot(input);
  const second = contracts.createReportSnapshot({
    created_at: input.created_at,
    resolution_items: [],
    validation_issues: [],
    guidance_context_ids: [],
    transcript_ids: [],
    evidence_ids: [],
    fields: [],
    session,
  });
  assert.equal(first.snapshot_id, second.snapshot_id);
  assert.equal(first.snapshot_hash, second.snapshot_hash);
});

test('ReportSession and ReportSnapshot round-trip only with an out-of-band trusted persistence hash', async () => {
  const contracts = await import('../src/domain/index.js');
  const session = await readySession(contracts);
  const snapshot = contracts.createReportSnapshot({
    session,
    fields: [],
    evidence_ids: [],
    transcript_ids: [],
    guidance_context_ids: [],
    validation_issues: [],
    resolution_items: [],
    created_at: '2026-09-27T03:06:00.000Z',
  });
  const serializedSession = contracts.serializeContract(session);
  const serializedSnapshot = contracts.serializeContract(snapshot);

  const restoredSession = contracts.deserializeReportSession(serializedSession, {
    trusted_persistence_hash: contracts.hashContract(session),
  });
  const restoredSnapshot = contracts.deserializeReportSnapshot(serializedSnapshot, {
    trusted_persistence_hash: contracts.hashContract(snapshot),
  });
  assert.deepEqual(restoredSession, session);
  assert.deepEqual(restoredSnapshot, snapshot);
  assert.equal(Object.isFrozen(restoredSession.audit_event_ids), true);
  assert.equal(Object.isFrozen(restoredSnapshot.fields), true);

  assert.throws(() => contracts.deserializeReportSession(serializedSession), {
    code: 'UNTRUSTED_DESERIALIZATION',
  });
  assert.throws(() => contracts.deserializeReportSnapshot(serializedSnapshot, {
    trusted_persistence_hash: `sha256:${'0'.repeat(64)}`,
  }), { code: 'PERSISTENCE_HASH_MISMATCH' });
});
