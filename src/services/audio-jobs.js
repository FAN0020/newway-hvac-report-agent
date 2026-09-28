import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function jobError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

export class AudioJobQueue {
  constructor({ root, captureService }) {
    this.root = path.resolve(root);
    this.captureService = captureService;
    this.running = false;
    this.reschedule = false;
    this.pending = new Map();
  }

  file(id) { return path.join(this.root, `${id}.json`); }
  audioFile(id) { return path.join(this.root, `${id}.wav`); }

  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.schedule();
  }

  async enqueue(input = {}) {
    const kind = input.kind || 'capture';
    const sessionId = input.session_id;
    const key = String(input.idempotency_key || crypto.randomUUID());
    if (key.length > 128) throw jobError('Idempotency key is too long.', 'INVALID_IDEMPOTENCY_KEY');
    const id = crypto.createHash('sha256').update(`${kind}:${sessionId}:${key}`).digest('hex');
    const previous = this.pending.get(id);
    if (previous) {
      await previous;
      return this.enqueue({ ...input, idempotency_key: key });
    }
    const pending = this.writeJob({ ...input, idempotency_key: key }, id);
    this.pending.set(id, pending);
    try { return await pending; }
    finally { this.pending.delete(id); }
  }

  async writeJob({ kind = 'capture', session_id, expected_revision, wav_buffer, model, language,
    idempotency_key, target_field_id, target_section_id, capture_mode, evidence_id } = {}, id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(String(session_id || ''))) throw jobError('Invalid session ID.', 'INVALID_SESSION_ID');
    if (kind === 'capture' && (!Buffer.isBuffer(wav_buffer) || !wav_buffer.length)) throw jobError('WAV bytes are required.', 'INVALID_WAV');
    if (kind === 'retry' && !evidence_id) throw jobError('Evidence ID is required.', 'INVALID_EVIDENCE_ID');
    const key = idempotency_key;
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ kind, session_id, expected_revision,
      model, language, target_field_id, target_section_id, capture_mode, evidence_id }))
      .update(wav_buffer || Buffer.alloc(0)).digest('hex');
    let existing;
    try { existing = JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (existing.session_id !== session_id || existing.kind !== kind || existing.input_hash !== inputHash) {
        throw jobError('Idempotency key was reused for different audio or options.', 'JOB_COLLISION', 409);
      }
      return { job_id: id, status: existing.status };
    }
    const job = {
      job_id: id, kind, session_id, expected_revision, model, language, idempotency_key: key,
      target_field_id, target_section_id, capture_mode, evidence_id,
      input_hash: inputHash,
      status: 'queued', created_at: new Date().toISOString(),
    };
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    if (kind === 'capture') await fs.writeFile(this.audioFile(id), wav_buffer, { flag: 'wx', mode: 0o600 });
    await atomicJson(this.file(id), job);
    this.schedule();
    return { job_id: id, status: 'queued' };
  }

  async get(id) {
    if (!/^[a-f0-9]{64}$/.test(String(id || ''))) throw jobError('Invalid job ID.', 'INVALID_JOB_ID');
    try {
      const job = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
      return { job_id: job.job_id, session_id: job.session_id, status: job.status,
        ...(job.status === 'complete' ? { result: job.result } : {}),
        ...(job.status === 'failed' ? { error: job.error } : {}) };
    } catch (error) {
      if (error.code === 'ENOENT') throw jobError('Job not found.', 'JOB_NOT_FOUND', 404);
      throw error;
    }
  }

  schedule() {
    if (this.running) { this.reschedule = true; return; }
    this.running = true;
    setImmediate(() => this.drain().catch((error) => console.error('Audio job queue failed:', error)).finally(() => {
      this.running = false;
      if (this.reschedule) { this.reschedule = false; this.schedule(); }
    }));
  }

  async drain() {
    const names = (await fs.readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    for (const name of names) {
      const job = JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8'));
      if (!['queued', 'running'].includes(job.status)) continue;
      await atomicJson(this.file(job.job_id), { ...job, status: 'running' });
      try {
        const result = job.kind === 'retry'
          ? await this.captureService.retryTranscription({ session_id: job.session_id,
            expected_revision: job.expected_revision, evidence_id: job.evidence_id })
          : await this.captureService.captureAudio({ session_id: job.session_id,
            expected_revision: job.expected_revision, wav_buffer: await fs.readFile(this.audioFile(job.job_id)),
            model: job.model, language: job.language, idempotency_key: job.idempotency_key,
            target_field_id: job.target_field_id, target_section_id: job.target_section_id, capture_mode: job.capture_mode });
        await atomicJson(this.file(job.job_id), { ...job, status: 'complete', result, completed_at: new Date().toISOString() });
        if (job.kind === 'capture') await fs.unlink(this.audioFile(job.job_id)).catch(() => {});
      } catch (error) {
        await atomicJson(this.file(job.job_id), { ...job, status: 'failed',
          error: { code: error.code || 'AUDIO_JOB_FAILED', message: Number(error.status) >= 500 ? 'Audio processing failed.' : String(error.message) },
          completed_at: new Date().toISOString() });
      }
    }
  }
}
