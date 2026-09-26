import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createAuditEvent,
  appendReportSessionEvent,
  createReportSession,
  deepFreeze,
  deserializeReportSession,
  hashContract,
  transitionReportSession,
} from '../domain/index.js';

function storageError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function safeId(value, label = 'session_id') {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(id)) {
    throw storageError(`${label} is invalid.`, `INVALID_${label.toUpperCase()}`, 400);
  }
  return id;
}

async function atomicJson(filename, value, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  if (exclusive) {
    try {
      await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (error.code === 'EEXIST') throw storageError('ReportSession already exists.', 'REPORT_SESSION_ALREADY_EXISTS', 409);
      throw error;
    }
  }
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

export class ReportSessionStore {
  constructor({ root } = {}) {
    if (!root) throw new TypeError('ReportSessionStore root is required.');
    this.root = path.resolve(root);
    this.sessionsRoot = path.join(this.root, 'sessions');
    this.eventsRoot = path.join(this.root, 'audit-events');
    this.recordsRoot = path.join(this.root, 'records');
    this.textRoot = path.join(this.root, 'text-sources');
    this.binaryRoot = path.join(this.root, 'binary-sources');
    this.captureRoot = path.join(this.root, 'capture-index');
    this.answerRoot = path.join(this.root, 'answer-index');
    this.locks = new Map();
  }

  sessionPath(sessionId) {
    return path.join(this.sessionsRoot, `${safeId(sessionId)}.json`);
  }

  eventPath(eventId) {
    return path.join(this.eventsRoot, `${safeId(eventId, 'event_id')}.json`);
  }

  async withLock(sessionId, operation) {
    const id = safeId(sessionId);
    const previous = this.locks.get(id) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.locks.set(id, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(id) === chain) this.locks.delete(id);
    }
  }

  async writeSession(session, options) {
    await atomicJson(this.sessionPath(session.session_id), {
      trusted_hash: hashContract(session),
      value: session,
    }, options);
  }

  async writeEvent(event) {
    await atomicJson(this.eventPath(event.event_id), event, { exclusive: true }).catch(async (error) => {
      if (error.code !== 'REPORT_SESSION_ALREADY_EXISTS') throw error;
      const existing = JSON.parse(await fs.readFile(this.eventPath(event.event_id), 'utf8'));
      if (hashContract(existing) !== hashContract(event)) {
        throw storageError('AuditEvent identity collision.', 'AUDIT_EVENT_COLLISION', 409);
      }
    });
  }

  async create(input) {
    const base = createReportSession(input);
    const event = createAuditEvent({
      session_id: base.session_id,
      revision: 0,
      event_type: 'SESSION_CREATED',
      occurred_at: base.created_at,
      payload: {
        template_binding: base.template_binding,
        context_binding: base.context_binding,
        job_context_ref: base.job_context_ref,
      },
    });
    const session = deepFreeze({ ...base, audit_event_ids: [event.event_id] });
    await this.withLock(session.session_id, async () => {
      await this.writeEvent(event);
      await this.writeSession(session, { exclusive: true });
    });
    return deepFreeze({ session, event });
  }

  async load(sessionId) {
    try {
      const persisted = JSON.parse(await fs.readFile(this.sessionPath(sessionId), 'utf8'));
      return deserializeReportSession(persisted.value, { trusted_persistence_hash: persisted.trusted_hash });
    } catch (error) {
      if (error.code === 'ENOENT') throw storageError('ReportSession was not found.', 'REPORT_SESSION_NOT_FOUND', 404);
      throw error;
    }
  }

  async transition(command) {
    return this.withLock(command.session_id, async () => {
      const current = await this.load(command.session_id);
      const result = transitionReportSession(current, command);
      const additions = command.additions || {};
      const append = (key) => [...new Set([...(result.session[key] || []), ...(additions[key] || [])])];
      const session = deepFreeze({
        ...result.session,
        evidence_ids: append('evidence_ids'),
        transcript_ids: append('transcript_ids'),
        transcript_review_ids: append('transcript_review_ids'),
        evidence_span_ids: append('evidence_span_ids'),
        field_candidate_ids: append('field_candidate_ids'),
        guidance_upload_ids: append('guidance_upload_ids'),
        guidance_context_ids: append('guidance_context_ids'),
        agent_run_ids: append('agent_run_ids'),
        current_agent_run_id: command.current_agent_run_id || result.session.current_agent_run_id || null,
      });
      await this.writeEvent(result.event);
      await this.writeSession(session);
      return deepFreeze({ session, event: result.event });
    });
  }

  async recordEvent(command) {
    return this.withLock(command.session_id, async () => {
      const current = await this.load(command.session_id);
      const result = appendReportSessionEvent(current, command);
      const additions = command.additions || {};
      const append = (key) => [...new Set([...(result.session[key] || []), ...(additions[key] || [])])];
      const session = deepFreeze({
        ...result.session,
        evidence_ids: append('evidence_ids'),
        transcript_ids: append('transcript_ids'),
        transcript_review_ids: append('transcript_review_ids'),
        evidence_span_ids: append('evidence_span_ids'),
        field_candidate_ids: append('field_candidate_ids'),
        guidance_upload_ids: append('guidance_upload_ids'),
        guidance_context_ids: append('guidance_context_ids'),
        agent_run_ids: append('agent_run_ids'),
        current_agent_run_id: command.current_agent_run_id || result.session.current_agent_run_id || null,
      });
      await this.writeEvent(result.event);
      await this.writeSession(session);
      return deepFreeze({ session, event: result.event });
    });
  }

  recordPath(kind, id) {
    return path.join(this.recordsRoot, safeId(kind, 'record_kind'), `${safeId(id, 'record_id')}.json`);
  }

  async putRecord(kind, id, value) {
    const filename = this.recordPath(kind, id);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    try {
      await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (hashContract(existing) !== hashContract(value)) {
        throw storageError('Immutable record identity collision.', 'IMMUTABLE_RECORD_COLLISION', 409);
      }
      return deepFreeze(existing);
    }
    return value;
  }

  async readRecord(kind, id) {
    try {
      return deepFreeze(JSON.parse(await fs.readFile(this.recordPath(kind, id), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') throw storageError('Immutable record was not found.', 'IMMUTABLE_RECORD_NOT_FOUND', 404);
      throw error;
    }
  }

  async putTextSource(digest, text) {
    const normalized = safeId(digest, 'source_digest');
    const filename = path.join(this.textRoot, `${normalized}.txt`);
    await fs.mkdir(this.textRoot, { recursive: true });
    await fs.writeFile(filename, text, { flag: 'wx', mode: 0o600 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const existing = await fs.readFile(filename, 'utf8');
    if (existing !== text) throw storageError('Text source hash collision.', 'SOURCE_HASH_COLLISION', 409);
    return `authority://text/${normalized}`;
  }

  async putBinarySource(digest, buffer) {
    const normalized = safeId(digest, 'source_digest');
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw storageError('Binary evidence is required.', 'EMPTY_BINARY_SOURCE', 400);
    }
    const filename = path.join(this.binaryRoot, `${normalized}.bin`);
    await fs.mkdir(this.binaryRoot, { recursive: true });
    await fs.writeFile(filename, buffer, { flag: 'wx', mode: 0o600 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const existing = await fs.readFile(filename);
    if (!existing.equals(buffer)) throw storageError('Binary source hash collision.', 'SOURCE_HASH_COLLISION', 409);
    return `authority://binary/${normalized}`;
  }

  async loadChain(sessionId) {
    const session = await this.load(sessionId);
    const loadMany = (kind, ids) => Promise.all(ids.map((id) => this.readRecord(kind, id)));
    const agentRuns = await loadMany('agent-runs', session.agent_run_ids);
    const currentRun = agentRuns.find((run) => run.run_id === session.current_agent_run_id) || null;
    return deepFreeze({
      session,
      audit_events: await this.listAuditEvents(sessionId),
      evidence: await loadMany('evidence', session.evidence_ids),
      transcripts: await loadMany('transcripts', session.transcript_ids),
      transcript_reviews: await loadMany('transcript-reviews', session.transcript_review_ids),
      evidence_spans: await loadMany('evidence-spans', session.evidence_span_ids),
      field_candidates: await loadMany('field-candidates', session.field_candidate_ids),
      guidance_uploads: await loadMany('guidance-uploads', session.guidance_upload_ids),
      guidance_contexts: await loadMany('guidance-contexts', session.guidance_context_ids),
      agent_runs: agentRuns,
      agent_state: currentRun?.agent_state || null,
    });
  }

  async attachAgentRun({ session_id: sessionId, expected_revision: expectedRevision, run } = {}) {
    await this.putRecord('agent-runs', run.run_id, run);
    return this.withLock(sessionId, async () => {
      const current = await this.load(sessionId);
      if (current.revision !== expectedRevision) {
        throw storageError('ReportSession changed while its AgentRun was being persisted.', 'STALE_REVISION', 409);
      }
      const session = deepFreeze({
        ...current,
        agent_run_ids: [...new Set([...current.agent_run_ids, run.run_id])],
        current_agent_run_id: run.run_id,
      });
      await this.writeSession(session);
      return session;
    });
  }

  answerKeyPath(sessionId, key) {
    const keyHash = crypto.createHash('sha256').update(`${safeId(sessionId)}:${String(key)}`).digest('hex');
    return path.join(this.answerRoot, 'by-key', `${keyHash}.json`);
  }

  async claimAnswer({ session_id: sessionId, idempotency_key: key, request_hash: requestHash } = {}) {
    if (!key) throw storageError('Resolution answers require an idempotency key.', 'IDEMPOTENCY_KEY_REQUIRED', 400);
    const filename = this.answerKeyPath(sessionId, key);
    try {
      const existing = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (existing.request_hash !== requestHash) {
        throw storageError('Idempotency key is already bound to another resolution answer.', 'IDEMPOTENCY_KEY_REUSE', 409);
      }
      return deepFreeze(existing.response);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveAnswer({ session_id: sessionId, idempotency_key: key, request_hash: requestHash, response } = {}) {
    const filename = this.answerKeyPath(sessionId, key);
    await atomicJson(filename, { request_hash: requestHash, response }, { exclusive: true }).catch(async (error) => {
      if (error.code !== 'REPORT_SESSION_ALREADY_EXISTS') throw error;
      const existing = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (existing.request_hash !== requestHash) throw storageError('Idempotency key is already bound to another resolution answer.', 'IDEMPOTENCY_KEY_REUSE', 409);
    });
    return deepFreeze(structuredClone(response));
  }

  capturePath(identityHash) {
    return path.join(this.captureRoot, 'by-identity', `${safeId(identityHash, 'identity_hash')}.json`);
  }

  captureKeyPath(key) {
    const keyHash = crypto.createHash('sha256').update(String(key)).digest('hex');
    return path.join(this.captureRoot, 'by-custom-key', `${keyHash}.json`);
  }

  captureEvidencePath(evidenceId) {
    return path.join(this.captureRoot, 'by-evidence', `${safeId(evidenceId, 'evidence_id')}.json`);
  }

  async claimCapture({ identity_hash: identityHash, idempotency_key: idempotencyKey } = {}) {
    const normalizedIdentity = safeId(identityHash, 'identity_hash');
    if (idempotencyKey) {
      const filename = this.captureKeyPath(idempotencyKey);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      try {
        await fs.writeFile(filename, `${JSON.stringify({ identity_hash: normalizedIdentity }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pointer = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (pointer.identity_hash !== normalizedIdentity) {
          throw storageError('Idempotency key is already bound to a different capture source identity.', 'IDEMPOTENCY_KEY_REUSE', 409);
        }
      }
    }
    try {
      return deepFreeze(JSON.parse(await fs.readFile(this.capturePath(normalizedIdentity), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveCapture(record) {
    const identityHash = safeId(record?.identity_hash, 'identity_hash');
    await atomicJson(this.capturePath(identityHash), record);
    if (record.evidence_id) {
      await atomicJson(this.captureEvidencePath(record.evidence_id), { identity_hash: identityHash });
    }
    return deepFreeze(structuredClone(record));
  }

  async readCaptureByEvidence(evidenceId) {
    try {
      const pointer = JSON.parse(await fs.readFile(this.captureEvidencePath(evidenceId), 'utf8'));
      return deepFreeze(JSON.parse(await fs.readFile(this.capturePath(pointer.identity_hash), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') throw storageError('Capture evidence was not found.', 'CAPTURE_EVIDENCE_NOT_FOUND', 404);
      throw error;
    }
  }

  async readAuditEvent(eventId) {
    try {
      return deepFreeze(JSON.parse(await fs.readFile(this.eventPath(eventId), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') throw storageError('AuditEvent was not found.', 'AUDIT_EVENT_NOT_FOUND', 404);
      throw error;
    }
  }

  async listAuditEvents(sessionId) {
    const session = await this.load(sessionId);
    return Promise.all(session.audit_event_ids.map((eventId) => this.readAuditEvent(eventId)));
  }
}
