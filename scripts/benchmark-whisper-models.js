import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WhisperProvider } from '../src/providers/whisper.js';
import { WHISPER_MODEL_REGISTRY } from '../src/providers/whisper-models.js';
import { inspectPcmWav } from '../src/wav.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(projectRoot, 'runtime', 'stt', `${process.platform}-${process.arch}`);
const temporaryRoot = path.join(projectRoot, '.tmp');
const sourceArchive = path.join(projectRoot, 'runtime', 'tools', 'downloads', 'whisper.cpp-b4938.tar.gz');
const expectedSampleSha256 = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';

function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: projectRoot, stdio: 'ignore', shell: false });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${program} exited with code ${code}`)));
  });
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

await fs.mkdir(temporaryRoot, { recursive: true });
const benchmarkRoot = await fs.mkdtemp(path.join(temporaryRoot, 'whisper-benchmark-'));
try {
  let audioPath = process.argv.find((argument) => argument.startsWith('--audio='))?.slice('--audio='.length);
  if (audioPath) {
    audioPath = path.resolve(audioPath);
  } else {
    await command('tar', ['-xzf', sourceArchive, '-C', benchmarkRoot, '--strip-components=2', 'whisper.cpp-b4938/samples/jfk.wav']);
    audioPath = path.join(benchmarkRoot, 'jfk.wav');
    const sample = await fs.readFile(audioPath);
    if (digest(sample) !== expectedSampleSha256) throw new Error('Pinned benchmark fixture failed checksum validation.');
  }
  const wav = inspectPcmWav(await fs.readFile(audioPath));
  const provider = new WhisperProvider({ runtimeRoot, tempRoot: path.join(benchmarkRoot, 'provider-output') });
  const rows = [];
  for (const model of WHISPER_MODEL_REGISTRY) {
    const health = await provider.health({ model: model.id });
    if (!health.ready) {
      rows.push({ model: model.id, audio_duration_seconds: wav.durationMs / 1000, transcription_duration_seconds: null, real_time_factor: null, success: false, error_code: health.error_code });
      continue;
    }
    const started = performance.now();
    try {
      const result = await provider.transcribe(audioPath, { model: model.id, language: 'en' });
      const durationSeconds = (performance.now() - started) / 1000;
      rows.push({
        model: model.id,
        audio_duration_seconds: wav.durationMs / 1000,
        transcription_duration_seconds: Number(durationSeconds.toFixed(3)),
        real_time_factor: Number((durationSeconds / (wav.durationMs / 1000)).toFixed(3)),
        success: true,
        transcript: result.raw_text,
      });
    } catch (error) {
      rows.push({ model: model.id, audio_duration_seconds: wav.durationMs / 1000, transcription_duration_seconds: null, real_time_factor: null, success: false, error_code: error.code || 'UNKNOWN' });
    }
  }
  console.log(JSON.stringify({ fixture: path.basename(audioPath), fixture_sha256: digest(await fs.readFile(audioPath)), results: rows }, null, 2));
} finally {
  await fs.rm(benchmarkRoot, { recursive: true, force: true });
}
