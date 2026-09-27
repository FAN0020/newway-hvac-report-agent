import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { WhisperProvider } from '../src/providers/whisper.js';
import { pcmWav } from './helpers.js';

const root = path.resolve('.tmp-tests', 'whisper');

test('reports explicit missing runtime health', async (t) => {
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new WhisperProvider({ runtimeRoot: path.join(root, 'runtime'), tempRoot: path.join(root, 'temp') });
  const health = await provider.health();
  assert.equal(health.ready, false);
  assert.equal(health.error_code, 'STT_RUNTIME_MISSING');
});

test('transcribes through an injected provider runner', async (t) => {
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const binary = path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, 'models'), { recursive: true });
  await fs.writeFile(binary, 'fake');
  await fs.chmod(binary, 0o755);
  await fs.writeFile(path.join(runtimeRoot, 'models', 'ggml-base.bin'), 'fake');
  const audio = path.join(root, 'audio.wav');
  await fs.writeFile(audio, pcmWav());
  const runner = async (_command, args) => {
    const prefix = args[args.indexOf('--output-file') + 1];
    await fs.writeFile(`${prefix}.json`, JSON.stringify({ result: { language: 'zh' }, transcription: [{ offsets: { from: 0, to: 900 }, text: '更换了电容' }] }));
  };
  const provider = new WhisperProvider({
    runtimeRoot, tempRoot: path.join(root, 'temp'), runner,
    modelManager: { status: async () => ({ state: 'installed', ready: true, path: path.join(runtimeRoot, 'models', 'ggml-base.bin') }) },
  });
  const result = await provider.transcribe(audio, { model: 'base', language: 'zh' });
  assert.equal(result.raw_text, '更换了电容');
  assert.deepEqual(result.segments[0], { start_ms: 0, end_ms: 900, text: '更换了电容' });
});

test('fails health when a managed runtime manifest does not match its files', async (t) => {
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const binary = path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, 'models'), { recursive: true });
  await fs.writeFile(binary, 'fake');
  await fs.chmod(binary, 0o755);
  await fs.writeFile(path.join(runtimeRoot, 'models', 'ggml-base.bin'), 'fake');
  await fs.writeFile(path.join(runtimeRoot, 'manifest.json'), JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    version: 'b4938',
    binary: { sha256: '0'.repeat(64) },
    model: { filename: 'ggml-base.bin', sha256: '0'.repeat(64) },
  }));

  const provider = new WhisperProvider({ runtimeRoot, tempRoot: path.join(root, 'temp') });
  const health = await provider.health();
  assert.equal(health.ready, false);
  assert.equal(health.error_code, 'STT_INTEGRITY_FAILED');
  assert.equal(health.runtime_integrity.status, 'checksum-mismatch');
});

test('serializes transcription work so local Whisper processes never overlap', async (t) => {
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const binary = path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, 'models'), { recursive: true });
  await fs.writeFile(binary, 'fake');
  await fs.chmod(binary, 0o755);
  await fs.writeFile(path.join(runtimeRoot, 'models', 'ggml-base.bin'), 'fake');
  const audio = path.join(root, 'audio.wav');
  await fs.writeFile(audio, pcmWav());
  let active = 0;
  let maximumActive = 0;
  const runner = async (_command, args) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const prefix = args[args.indexOf('--output-file') + 1];
    await fs.writeFile(`${prefix}.json`, JSON.stringify({ text: 'serialized transcript' }));
    active -= 1;
  };
  const modelManager = { status: async () => ({ state: 'installed', ready: true, path: path.join(runtimeRoot, 'models', 'ggml-base.bin') }) };
  const provider = new WhisperProvider({ runtimeRoot, tempRoot: path.join(root, 'temp'), runner, modelManager });
  await Promise.all([
    provider.transcribe(audio, { model: 'base', language: 'en' }),
    provider.transcribe(audio, { model: 'base', language: 'en' }),
  ]);
  assert.equal(maximumActive, 1);
});
