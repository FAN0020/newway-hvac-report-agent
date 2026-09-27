import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { WhisperModelManager } from './whisper-model-manager.js';
import { DEFAULT_WHISPER_MODEL_ID, WHISPER_MODELS, whisperModel } from './whisper-models.js';

export const WHISPER_LANGUAGES = Object.freeze(['auto', 'zh', 'en', 'ms', 'ta']);
export { WHISPER_MODELS } from './whisper-models.js';

async function accessible(file, executable = false) {
  try {
    await fs.access(file, executable && process.platform !== 'win32' ? fsConstants.X_OK : fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

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

export function runWhisperCommand(command, args, {
  cwd,
  signal,
  timeoutMs = 10 * 60 * 1000,
  maxOutputBytes = 64 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Whisper request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR', status: 499 }));
      return;
    }
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const appendTail = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => child.kill('SIGTERM');
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, Math.max(1, Number(timeoutMs) || 10 * 60 * 1000));
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = appendTail(stderr, chunk); });
    child.on('error', (error) => finish(reject, Object.assign(
      new Error(`Cannot start Whisper: ${error.message}`),
      { code: 'STT_START_FAILED', status: 503 },
    )));
    child.on('close', (code) => {
      if (timedOut) {
        finish(reject, Object.assign(new Error('Whisper transcription timed out.'), { code: 'STT_TIMEOUT', status: 504 }));
      } else if (signal?.aborted) {
        finish(reject, Object.assign(new Error('Whisper request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR', status: 499 }));
      } else if (code !== 0) {
        finish(reject, Object.assign(
          new Error(`Whisper exited with code ${code}: ${stderr.trim().slice(-800)}`),
          { code: 'STT_PROCESS_FAILED', status: 502 },
        ));
      } else {
        finish(resolve, { stdout, stderr });
      }
    });
  });
}

function parseSegments(result) {
  const source = result.segments || result.transcription || [];
  return source.map((segment) => ({
    start_ms: Math.round(Number(segment.start ?? segment.offsets?.from ?? 0) * (segment.offsets ? 1 : 1000)),
    end_ms: Math.round(Number(segment.end ?? segment.offsets?.to ?? 0) * (segment.offsets ? 1 : 1000)),
    text: String(segment.text || segment.tokens?.map((token) => token.text).join('') || '').trim(),
  })).filter((segment) => segment.text);
}

export class WhisperProvider {
  constructor({
    runtimeRoot,
    tempRoot,
    runner = runWhisperCommand,
    modelManager,
    timeoutMs = Number(process.env.HVAC_STT_TIMEOUT_MS) || 10 * 60 * 1000,
  }) {
    if (!runtimeRoot || !tempRoot) throw new TypeError('runtimeRoot and tempRoot are required');
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.tempRoot = path.resolve(tempRoot);
    this.binary = path.join(this.runtimeRoot, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    this.modelRoot = path.join(this.runtimeRoot, 'models');
    this.manifestPath = path.join(this.runtimeRoot, 'manifest.json');
    this.runner = runner;
    this.modelManager = modelManager || new WhisperModelManager({ runtimeRoot: this.runtimeRoot });
    this.timeoutMs = Math.max(1, timeoutMs);
    this.binaryIntegrityPromise = null;
    this.transcriptionTail = Promise.resolve();
  }

  modelPath(model) {
    return path.join(this.modelRoot, whisperModel(model).filename);
  }

  async runtimeIntegrity() {
    if (!this.binaryIntegrityPromise) {
      this.binaryIntegrityPromise = (async () => {
        let manifest;
        try {
          manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') return { available: false, valid: null, status: 'not-recorded' };
          return { available: true, valid: false, status: 'invalid-manifest', message: error.message };
        }
        try {
          const binarySha256 = await sha256(this.binary);
          const valid = manifest.platform === process.platform
            && manifest.arch === process.arch
            && manifest.binary?.sha256 === binarySha256;
          return {
            available: true,
            valid,
            status: valid ? 'sha256-verified' : 'checksum-mismatch',
            version: manifest.version || null,
            binary_sha256: binarySha256,
          };
        } catch (error) {
          return { available: true, valid: false, status: 'verification-failed', message: error.message };
        }
      })();
    }
    return this.binaryIntegrityPromise;
  }

  async health({ model = DEFAULT_WHISPER_MODEL_ID } = {}) {
    whisperModel(model);
    const [runtimeAvailable, modelStatus] = await Promise.all([
      accessible(this.binary, true),
      this.modelManager.status(model),
    ]);
    const integrity = runtimeAvailable
      ? await this.runtimeIntegrity()
      : { available: false, valid: null, status: 'not-checked' };
    const integrityFailed = integrity.available && !integrity.valid;
    const runtimeCompatible = !integrity.available || !integrity.version || whisperModel(model).runtime.versions.includes(integrity.version);
    const modelAvailable = modelStatus.ready === true;
    const ready = runtimeAvailable && modelAvailable && !integrityFailed && runtimeCompatible;
    return {
      provider: 'whisper.cpp',
      ready,
      runtime_available: runtimeAvailable,
      model_available: modelAvailable,
      model,
      binary_path: this.binary,
      model_path: modelStatus.path || this.modelPath(model),
      model_state: modelStatus.state,
      runtime_integrity: integrity,
      error_code: ready ? null : (!runtimeAvailable
        ? 'STT_RUNTIME_MISSING'
        : (integrityFailed ? 'STT_INTEGRITY_FAILED' : (!runtimeCompatible ? 'STT_RUNTIME_INCOMPATIBLE' : modelStatus.error_code))),
      message: ready
        ? `Whisper runtime and model are ready (${integrity.status}).`
        : (integrityFailed
          ? 'Whisper runtime integrity verification failed. Run "npm run stt:prepare" to replace it with verified artifacts.'
          : (!runtimeCompatible
            ? `The installed Whisper runtime is not compatible with ${whisperModel(model).displayName}.`
            : (!runtimeAvailable
            ? 'Whisper runtime is not prepared. Run "npm run stt:prepare" from this project.'
            : modelStatus.message))),
    };
  }

  async transcribe(audioPath, { model = DEFAULT_WHISPER_MODEL_ID, language = 'auto', signal } = {}) {
    const pending = this.transcriptionTail.then(
      () => this.transcribeNow(audioPath, { model, language, signal }),
      () => this.transcribeNow(audioPath, { model, language, signal }),
    );
    this.transcriptionTail = pending.catch(() => {});
    return pending;
  }

  async transcribeNow(audioPath, { model, language, signal }) {
    if (!WHISPER_LANGUAGES.includes(language)) {
      throw Object.assign(new Error(`Unsupported language: ${language}`), { code: 'STT_LANGUAGE_UNSUPPORTED', status: 400 });
    }
    const health = await this.health({ model });
    if (!health.ready) throw Object.assign(new Error(health.message), { code: health.error_code, status: 503, retryable: false });

    await fs.mkdir(this.tempRoot, { recursive: true });
    const outputDir = await fs.mkdtemp(path.join(this.tempRoot, 'whisper-'));
    try {
      const prefix = path.join(outputDir, 'transcript');
      const args = [
        '--model', health.model_path,
        '--file', path.resolve(audioPath),
        '--output-json',
        '--output-file', prefix,
        '--language', language,
        '--threads', '2',
        '--no-prints',
        ...(process.platform === 'darwin' ? ['--no-gpu'] : []),
      ];
      await this.runner(this.binary, args, {
        cwd: path.dirname(this.binary),
        signal,
        timeoutMs: this.timeoutMs,
      });
      let result;
      try {
        result = JSON.parse(await fs.readFile(`${prefix}.json`, 'utf8'));
      } catch (error) {
        throw Object.assign(new Error(`Whisper output is not valid JSON: ${error.message}`), { code: 'STT_INVALID_OUTPUT', status: 502, retryable: true });
      }
      const segments = parseSegments(result);
      const rawText = (segments.length
        ? segments.map((segment) => segment.text).join(' ')
        : String(result.text || result.transcription?.map?.((item) => item.text || '').join(' ') || ''))
        .replace(/\s+/gu, ' ')
        .trim();
      if (!rawText) throw Object.assign(new Error('Whisper found no speech.'), { code: 'NO_SPEECH', status: 422, retryable: true });
      return {
        raw_text: rawText,
        language: result.result?.language || result.language || language,
        segments,
        provider: 'whisper.cpp',
        model,
      };
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  }
}
