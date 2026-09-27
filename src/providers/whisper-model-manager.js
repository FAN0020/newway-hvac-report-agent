import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WHISPER_MODEL_REGISTRY, whisperModel as registeredModel } from './whisper-models.js';

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function defaultDiskSpace(directory) {
  const stats = await fs.statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function defaultDownload({ url, destination }) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`Model download failed with HTTP ${response.status}.`), { code: 'STT_MODEL_DOWNLOAD_FAILED' });
  }
  const handle = await fs.open(destination, 'wx', 0o600);
  try {
    await pipeline(Readable.fromWeb(response.body), handle.createWriteStream());
  } finally {
    await handle.close().catch(() => {});
  }
}

export class WhisperModelManager {
  constructor({
    runtimeRoot,
    registry = WHISPER_MODEL_REGISTRY,
    download = defaultDownload,
    diskSpace = defaultDiskSpace,
    fileDigest = sha256,
  } = {}) {
    if (!runtimeRoot) throw new TypeError('runtimeRoot is required');
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.modelRoot = path.join(this.runtimeRoot, 'models');
    this.registry = Object.freeze([...registry]);
    this.byId = new Map(this.registry.map((entry) => [entry.id, entry]));
    this.download = download;
    this.diskSpace = diskSpace;
    this.fileDigest = fileDigest;
    this.installations = new Map();
    this.validationCache = new Map();
    this.errors = new Map();
  }

  model(modelId) {
    const local = this.byId.get(String(modelId || ''));
    if (local) return local;
    if (this.registry === WHISPER_MODEL_REGISTRY) return registeredModel(modelId);
    throw Object.assign(new Error(`Unsupported Whisper model: ${modelId}`), { code: 'STT_MODEL_UNSUPPORTED', status: 400 });
  }

  modelPath(modelId) {
    return path.join(this.modelRoot, this.model(modelId).filename);
  }

  verificationPath(model) {
    return path.join(this.modelRoot, `.${model.filename}.verified.json`);
  }

  async validate(model, file, { refresh = false } = {}) {
    let stats;
    try {
      stats = await fs.stat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, valid: false, error_code: 'STT_MODEL_MISSING' };
      throw error;
    }
    const cacheKey = `${stats.size}:${stats.mtimeMs}`;
    const cached = this.validationCache.get(model.id);
    if (!refresh && cached?.key === cacheKey) return cached.value;
    if (!refresh) {
      try {
        const recorded = JSON.parse(await fs.readFile(this.verificationPath(model), 'utf8'));
        if (recorded.schema_version === 1
          && recorded.model_id === model.id
          && recorded.filename === model.filename
          && recorded.bytes === stats.size
          && recorded.mtime_ms === stats.mtimeMs
          && recorded.sha256 === model.download.sha256) {
          const value = { exists: true, valid: true, bytes: stats.size, sha256: recorded.sha256, error_code: null };
          this.validationCache.set(model.id, { key: cacheKey, value });
          return value;
        }
      } catch { /* No trusted unchanged-file record yet; hash the model below. */ }
    }
    if (stats.size !== model.download.bytes) {
      const value = { exists: true, valid: false, bytes: stats.size, error_code: 'STT_MODEL_CORRUPTED' };
      this.validationCache.set(model.id, { key: cacheKey, value });
      return value;
    }
    const digest = await this.fileDigest(file);
    const value = {
      exists: true,
      valid: digest === model.download.sha256,
      bytes: stats.size,
      sha256: digest,
      error_code: digest === model.download.sha256 ? null : 'STT_MODEL_CORRUPTED',
    };
    this.validationCache.set(model.id, { key: cacheKey, value });
    if (value.valid && file === this.modelPath(model.id)) {
      const verification = {
        schema_version: 1,
        model_id: model.id,
        filename: model.filename,
        bytes: stats.size,
        mtime_ms: stats.mtimeMs,
        sha256: digest,
        verified_at: new Date().toISOString(),
      };
      const marker = this.verificationPath(model);
      const temporary = `${marker}.tmp-${process.pid}`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(verification, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, marker);
      } catch {
        await fs.rm(temporary, { force: true });
      }
    }
    return value;
  }

  publicDefinition(model) {
    return {
      id: model.id,
      display_name: model.displayName,
      description: model.description,
      quality: model.quality,
      speed: model.speed,
      approximate_storage_bytes: model.approximateStorageBytes ?? model.download.bytes,
      runtime: model.runtime,
    };
  }

  async status(modelId, { refresh = false } = {}) {
    const model = this.model(modelId);
    if (this.installations.has(model.id)) {
      return { ...this.publicDefinition(model), state: 'installing', ready: false, error_code: null, message: `${model.displayName} is installing.` };
    }
    const validation = await this.validate(model, this.modelPath(model.id), { refresh });
    if (!validation.exists) {
      const prior = this.errors.get(model.id);
      return {
        ...this.publicDefinition(model), state: prior ? 'error' : 'not_installed', ready: false,
        error_code: prior?.code || 'STT_MODEL_MISSING',
        message: prior?.message || `${model.displayName} is not installed.`,
      };
    }
    if (!validation.valid) {
      return {
        ...this.publicDefinition(model), state: 'error', ready: false,
        error_code: validation.error_code, message: `${model.displayName} failed integrity validation. Reinstall it before use.`,
      };
    }
    this.errors.delete(model.id);
    return {
      ...this.publicDefinition(model), state: 'installed', ready: true, error_code: null,
      installed_bytes: validation.bytes, path: this.modelPath(model.id), message: `${model.displayName} is installed and verified.`,
    };
  }

  async list() {
    return Promise.all(this.registry.map((model) => this.status(model.id)));
  }

  async install(modelId) {
    const model = this.model(modelId);
    const existing = await this.status(model.id, { refresh: true });
    if (existing.ready) return existing;
    if (this.installations.has(model.id)) return this.installations.get(model.id);
    const pending = this.installVerified(model).then(async () => {
      this.installations.delete(model.id);
      return this.status(model.id, { refresh: true });
    }, (error) => {
      this.installations.delete(model.id);
      throw error;
    });
    this.installations.set(model.id, pending);
    return pending;
  }

  async installVerified(model) {
    await fs.mkdir(this.modelRoot, { recursive: true });
    const available = await this.diskSpace(this.modelRoot);
    const required = Math.ceil(model.download.bytes * 1.05);
    if (available < required) {
      const error = Object.assign(new Error(`Not enough disk space to install ${model.displayName}.`), {
        code: 'STT_INSUFFICIENT_DISK_SPACE', status: 507, expose: true, required_bytes: required, available_bytes: available,
      });
      this.errors.set(model.id, error);
      throw error;
    }
    const destination = this.modelPath(model.id);
    const partial = `${destination}.part-${process.pid}-${crypto.randomUUID()}`;
    try {
      let lastFailure;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await fs.rm(partial, { force: true });
        try {
          await this.download({ url: model.download.url, destination: partial, model, attempt });
          const validation = await this.validate(model, partial, { refresh: true });
          if (!validation.valid) {
            throw Object.assign(new Error(`Downloaded ${model.displayName} failed integrity validation.`), { code: 'STT_MODEL_CORRUPTED' });
          }
          lastFailure = null;
          break;
        } catch (error) {
          lastFailure = error;
          await fs.rm(partial, { force: true });
        }
      }
      if (lastFailure) throw lastFailure;
      await fs.rename(partial, destination);
      this.validationCache.delete(model.id);
      this.errors.delete(model.id);
      return true;
    } catch (cause) {
      await fs.rm(partial, { force: true });
      const error = cause.code === 'STT_INSUFFICIENT_DISK_SPACE'
        ? cause
        : Object.assign(new Error(`Could not install ${model.displayName}: ${cause.message}`), {
          code: 'STT_MODEL_INSTALL_FAILED', status: 502, expose: true, cause_code: cause.code || null,
        });
      this.errors.set(model.id, error);
      throw error;
    }
  }
}
