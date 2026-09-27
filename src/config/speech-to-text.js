import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_WHISPER_MODEL_ID, whisperModel } from '../providers/whisper-models.js';

const INVALID_WARNING = Object.freeze({
  code: 'STT_CONFIG_INVALID',
  message: 'The saved speech-to-text model setting was invalid; Base is active.',
});

export class SpeechToTextConfigStore {
  constructor({ filePath, defaultModel = DEFAULT_WHISPER_MODEL_ID } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    whisperModel(defaultModel);
    this.filePath = path.resolve(filePath);
    this.defaultModel = defaultModel;
    this.writeTail = Promise.resolve();
  }

  async load() {
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { model: this.defaultModel, recovered: false, warning: null };
      return { model: this.defaultModel, recovered: true, warning: { ...INVALID_WARNING } };
    }
    try {
      const model = whisperModel(saved?.speechToText?.model).id;
      return { model, recovered: false, warning: null };
    } catch {
      return { model: this.defaultModel, recovered: true, warning: { ...INVALID_WARNING } };
    }
  }

  async setModel(modelId) {
    const model = whisperModel(modelId).id;
    const write = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      const body = `${JSON.stringify({ schema_version: 1, speechToText: { model } }, null, 2)}\n`;
      try {
        await fs.writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, this.filePath);
      } catch (error) {
        await fs.rm(temporary, { force: true });
        throw Object.assign(new Error(`Could not save the speech-to-text setting: ${error.message}`), {
          code: 'STT_CONFIG_WRITE_FAILED', status: 500,
        });
      }
      return { model, recovered: false, warning: null };
    };
    const pending = this.writeTail.then(write, write);
    this.writeTail = pending.catch(() => {});
    return pending;
  }
}
