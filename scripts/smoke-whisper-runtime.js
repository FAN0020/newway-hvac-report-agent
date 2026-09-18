import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WhisperProvider } from '../src/providers/whisper.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(projectRoot, 'runtime', 'stt', `${process.platform}-${process.arch}`);
const sourceArchive = path.join(projectRoot, 'runtime', 'tools', 'downloads', 'whisper.cpp-b4938.tar.gz');
const temporaryRoot = path.join(projectRoot, '.tmp');
const expectedSampleSha256 = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';

function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, TMPDIR: temporaryRoot },
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${program} exited with code ${code}`)));
  });
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

await fs.mkdir(temporaryRoot, { recursive: true });
const smokeRoot = await fs.mkdtemp(path.join(temporaryRoot, 'whisper-smoke-'));
try {
  await fs.access(sourceArchive);
  await command('tar', [
    '-xzf', sourceArchive,
    '-C', smokeRoot,
    '--strip-components=2',
    'whisper.cpp-b4938/samples/jfk.wav',
  ]);
  const sample = path.join(smokeRoot, 'jfk.wav');
  const sampleSha256 = await sha256(sample);
  if (sampleSha256 !== expectedSampleSha256) {
    throw new Error(`Official smoke sample checksum mismatch: expected ${expectedSampleSha256}, got ${sampleSha256}`);
  }

  const provider = new WhisperProvider({
    runtimeRoot,
    tempRoot: path.join(smokeRoot, 'provider-output'),
    timeoutMs: 2 * 60 * 1000,
  });
  const health = await provider.health({ model: 'base' });
  if (!health.ready) throw new Error(`Whisper runtime is not ready: ${health.error_code}`);
  const startedAt = Date.now();
  const result = await provider.transcribe(sample, { model: 'base', language: 'en' });
  if (!/country/iu.test(result.raw_text)) {
    throw new Error(`Unexpected smoke transcription: ${result.raw_text}`);
  }
  console.log(JSON.stringify({
    ready: health.ready,
    integrity: health.runtime_integrity,
    provider: result.provider,
    model: result.model,
    language: result.language,
    elapsed_ms: Date.now() - startedAt,
    transcript: result.raw_text,
  }, null, 2));
} finally {
  await fs.rm(smokeRoot, { recursive: true, force: true });
}
