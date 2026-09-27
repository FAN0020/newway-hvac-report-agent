import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  WHISPER_MODEL_REGISTRY,
  whisperModel,
} from '../src/providers/whisper-models.js';
import { WhisperModelManager } from '../src/providers/whisper-model-manager.js';
import { SpeechToTextConfigStore } from '../src/config/speech-to-text.js';
import { LocalSpeechToTextService } from '../src/services/local-speech-to-text.js';

const root = path.resolve('.tmp-tests', 'whisper-model-management');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('central registry exposes every supported local Whisper model with runtime metadata', () => {
  assert.deepEqual(WHISPER_MODEL_REGISTRY.map((entry) => entry.id), [
    'tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo',
  ]);
  for (const entry of WHISPER_MODEL_REGISTRY) {
    assert.match(entry.displayName, /\S/u);
    assert.match(entry.filename, /^ggml-.+\.bin$/u);
    assert.match(entry.download.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[a-f0-9]{40}\//u);
    assert.match(entry.download.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(entry.download.bytes > 1_000_000);
    assert.equal(entry.runtime.provider, 'whisper.cpp');
    assert.ok(entry.runtime.versions.includes('b4938'));
  }
  assert.equal(whisperModel('large-v3').filename, 'ggml-large-v3.bin');
  assert.throws(() => whisperModel('invented'), { code: 'STT_MODEL_UNSUPPORTED' });
});

test('speech-to-text selection persists across a new store instance and rejects malformed values', async (t) => {
  const directory = path.join(root, 'config');
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'speech-to-text.json');

  const first = new SpeechToTextConfigStore({ filePath });
  assert.deepEqual(await first.load(), { model: 'base', recovered: false, warning: null });
  await first.setModel('medium');
  assert.equal((await new SpeechToTextConfigStore({ filePath }).load()).model, 'medium');
  await assert.rejects(() => first.setModel('not-a-model'), { code: 'STT_MODEL_UNSUPPORTED' });

  await fs.writeFile(filePath, '{broken json', 'utf8');
  assert.deepEqual(await new SpeechToTextConfigStore({ filePath }).load(), {
    model: 'base',
    recovered: true,
    warning: { code: 'STT_CONFIG_INVALID', message: 'The saved speech-to-text model setting was invalid; Base is active.' },
  });
});

test('model manager installs once, validates content, and never redownloads a valid model', async (t) => {
  const directory = path.join(root, 'install');
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('verified-model-content');
  const registry = [{
    id: 'test-model', displayName: 'Test model', filename: 'ggml-test-model.bin',
    description: 'Test only', quality: 'test', speed: 'test',
    download: { url: 'https://example.invalid/model.bin', sha256: sha256(content), bytes: content.length },
    runtime: { provider: 'whisper.cpp', versions: ['b4938'] },
  }];
  let downloads = 0;
  const manager = new WhisperModelManager({
    runtimeRoot: directory,
    registry,
    diskSpace: async () => content.length * 10,
    download: async ({ destination }) => {
      downloads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fs.writeFile(destination, content);
    },
  });

  assert.equal((await manager.status('test-model')).state, 'not_installed');
  const [left, right] = await Promise.all([manager.install('test-model'), manager.install('test-model')]);
  assert.equal(left.state, 'installed');
  assert.equal(right.state, 'installed');
  assert.equal(downloads, 1);
  assert.equal((await manager.install('test-model')).state, 'installed');
  assert.equal(downloads, 1);

  await fs.writeFile(path.join(directory, 'models', 'ggml-test-model.bin'), 'corrupted');
  const corrupted = await manager.status('test-model', { refresh: true });
  assert.equal(corrupted.state, 'error');
  assert.equal(corrupted.error_code, 'STT_MODEL_CORRUPTED');
});

test('model manager cleans interrupted downloads and reports insufficient disk space', async (t) => {
  const directory = path.join(root, 'failures');
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('larger-model');
  const registry = [{
    id: 'large-test', displayName: 'Large test', filename: 'ggml-large-test.bin',
    description: 'Test only', quality: 'test', speed: 'test',
    download: { url: 'https://example.invalid/large.bin', sha256: sha256(content), bytes: content.length },
    runtime: { provider: 'whisper.cpp', versions: ['b4938'] },
  }];
  const noSpace = new WhisperModelManager({
    runtimeRoot: directory,
    registry,
    diskSpace: async () => content.length - 1,
    download: async () => assert.fail('download must not start without sufficient disk space'),
  });
  await assert.rejects(() => noSpace.install('large-test'), { code: 'STT_INSUFFICIENT_DISK_SPACE' });

  const interrupted = new WhisperModelManager({
    runtimeRoot: directory,
    registry,
    diskSpace: async () => content.length * 10,
    download: async ({ destination }) => {
      await fs.writeFile(destination, content.subarray(0, 2));
      throw Object.assign(new Error('connection lost'), { code: 'DOWNLOAD_INTERRUPTED' });
    },
  });
  await assert.rejects(() => interrupted.install('large-test'), { code: 'STT_MODEL_INSTALL_FAILED' });
  const files = await fs.readdir(path.join(directory, 'models'));
  assert.deepEqual(files, []);
  assert.equal((await interrupted.status('large-test', { refresh: true })).state, 'error');
});

test('model installation recovers from a transient interrupted transfer with a bounded retry', async (t) => {
  const directory = path.join(root, 'transient-download');
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('retry-safe-model');
  const registry = [{
    id: 'retry-test', displayName: 'Retry test', filename: 'ggml-retry-test.bin',
    description: 'Test only', quality: 'test', speed: 'test',
    download: { url: 'https://example.invalid/retry.bin', sha256: sha256(content), bytes: content.length },
    runtime: { provider: 'whisper.cpp', versions: ['b4938'] },
  }];
  let attempts = 0;
  const manager = new WhisperModelManager({
    runtimeRoot: directory,
    registry,
    diskSpace: async () => content.length * 10,
    download: async ({ destination }) => {
      attempts += 1;
      if (attempts === 1) {
        await fs.writeFile(destination, content.subarray(0, 3));
        throw new Error('terminated');
      }
      await fs.writeFile(destination, content);
    },
  });
  assert.equal((await manager.install('retry-test')).state, 'installed');
  assert.equal(attempts, 2);
});

test('verified model metadata avoids rehashing unchanged multi-gigabyte files after restart', async (t) => {
  const directory = path.join(root, 'validation-cache');
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('restart-cache-model');
  const registry = [{
    id: 'cache-test', displayName: 'Cache test', filename: 'ggml-cache-test.bin',
    description: 'Test only', quality: 'test', speed: 'test',
    download: { url: 'https://example.invalid/cache.bin', sha256: sha256(content), bytes: content.length },
    runtime: { provider: 'whisper.cpp', versions: ['b4938'] },
  }];
  let digestCalls = 0;
  const fileDigest = async (file) => { digestCalls += 1; return sha256(await fs.readFile(file)); };
  const first = new WhisperModelManager({
    runtimeRoot: directory, registry, fileDigest,
    diskSpace: async () => content.length * 10,
    download: async ({ destination }) => fs.writeFile(destination, content),
  });
  await first.install('cache-test');
  assert.ok(digestCalls > 0);
  const callsAfterInstall = digestCalls;
  const restarted = new WhisperModelManager({ runtimeRoot: directory, registry, fileDigest });
  assert.equal((await restarted.status('cache-test')).state, 'installed');
  assert.equal(digestCalls, callsAfterInstall);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.writeFile(path.join(directory, 'models', 'ggml-cache-test.bin'), Buffer.from('restart-cache-modeX'));
  assert.equal((await restarted.status('cache-test')).state, 'error');
  assert.ok(digestCalls > callsAfterInstall);
});

test('local speech-to-text service persists only verified model selections', async (t) => {
  const directory = path.join(root, 'service');
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const installed = new Set(['base']);
  const manager = {
    registry: WHISPER_MODEL_REGISTRY,
    list: async () => WHISPER_MODEL_REGISTRY.map((model) => ({
      id: model.id, display_name: model.displayName, description: model.description,
      state: installed.has(model.id) ? 'installed' : 'not_installed', ready: installed.has(model.id),
      error_code: installed.has(model.id) ? null : 'STT_MODEL_MISSING',
    })),
    status: async (id) => ({ id, state: installed.has(id) ? 'installed' : 'not_installed', ready: installed.has(id) }),
    install: async (id) => { installed.add(id); return { id, state: 'installed', ready: true }; },
  };
  const configStore = new SpeechToTextConfigStore({ filePath: path.join(directory, 'speech-to-text.json') });
  const service = new LocalSpeechToTextService({ configStore, modelManager: manager });

  await assert.rejects(() => service.selectModel('medium'), { code: 'STT_MODEL_NOT_INSTALLED' });
  assert.equal((await service.getState()).selected_model, 'base');
  await service.installModel('medium');
  assert.equal((await service.selectModel('medium')).selected_model, 'medium');
  assert.equal(await service.resolveModel(), 'medium');
  assert.equal((await new SpeechToTextConfigStore({ filePath: path.join(directory, 'speech-to-text.json') }).load()).model, 'medium');
});

test('installing another model does not change the active model used by transcription', async (t) => {
  const directory = path.join(root, 'install-while-transcribing');
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let finishInstall;
  const installPending = new Promise((resolve) => { finishInstall = resolve; });
  const manager = {
    registry: WHISPER_MODEL_REGISTRY,
    list: async () => [],
    status: async (id) => ({ id, state: id === 'base' ? 'installed' : 'not_installed', ready: id === 'base' }),
    install: async (id) => {
      await installPending;
      return { id, state: 'installed', ready: true };
    },
  };
  const service = new LocalSpeechToTextService({
    configStore: new SpeechToTextConfigStore({ filePath: path.join(directory, 'speech-to-text.json') }),
    modelManager: manager,
  });

  const installing = service.installModel('medium');
  assert.equal(await service.resolveModel(), 'base');
  finishInstall();
  await installing;
  assert.equal(await service.resolveModel(), 'base');
});
