import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { whisperModel } from '../src/providers/whisper-models.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = path.join(projectRoot, '.tmp');
const toolsRoot = path.join(projectRoot, 'runtime', 'tools');
const downloadsRoot = path.join(toolsRoot, 'downloads');

const whisper = Object.freeze({
  version: 'b4938',
  sourceUrl: 'https://github.com/ggml-org/whisper.cpp/archive/refs/tags/b4938.tar.gz',
  // Recorded from the fixed official GitHub tag archive on 2026-09-18.
  sourceSha256: '6d8d70a014ca2b10f8a6d006b8f423e5f5ef2afcfbe92b57ab4e01107238112a',
});
const model = whisperModel('base');
const cmake = Object.freeze({
  version: '3.31.10',
  filename: 'cmake-3.31.10-macos-universal.tar.gz',
  url: 'https://github.com/Kitware/CMake/releases/download/v3.31.10/cmake-3.31.10-macos-universal.tar.gz',
  checksumUrl: 'https://github.com/Kitware/CMake/releases/download/v3.31.10/cmake-3.31.10-SHA-256.txt',
  // Published in Kitware's official cmake-3.31.10-SHA-256.txt.
  sha256: 'be9f3faeeaf7921cc2d77cea711dd5e6f72c63af2810cacd9205b3ce8d1593c9',
});

const target = path.join(projectRoot, 'runtime', 'stt', `${process.platform}-${process.arch}`);
const cmakeRoot = path.join(toolsRoot, `cmake-${cmake.version}`);
const cmakeBinary = path.join(cmakeRoot, 'CMake.app', 'Contents', 'bin', 'cmake');

function command(program, args, cwd = projectRoot, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      env: {
        ...process.env,
        TMPDIR: temporaryRoot,
      },
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${program} exited with code ${code}${capture && stderr ? `: ${stderr.trim().slice(-800)}` : ''}`)));
  });
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
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

async function downloadVerified({ url, destination, expectedSha256, label }) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (await exists(destination)) {
    const existingSha256 = await sha256(destination);
    if (existingSha256 === expectedSha256) {
      console.log(`${label} already downloaded and verified.`);
      return existingSha256;
    }
    console.warn(`${label} cache has the wrong checksum; downloading a clean copy.`);
  }

  const partial = `${destination}.part-${process.pid}`;
  await fs.rm(partial, { force: true });
  try {
    await command('curl', ['--fail', '--location', '--retry', '3', '--output', partial, url]);
    const actualSha256 = await sha256(partial);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`${label} checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
    }
    await fs.rm(destination, { force: true });
    await fs.rename(partial, destination);
    return actualSha256;
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }
}

async function ensureProjectCmake() {
  const archive = path.join(downloadsRoot, cmake.filename);
  await downloadVerified({
    url: cmake.url,
    destination: archive,
    expectedSha256: cmake.sha256,
    label: `CMake ${cmake.version}`,
  });

  if (await exists(cmakeBinary)) {
    const version = await command(cmakeBinary, ['--version'], projectRoot, { capture: true });
    if (version.stdout.startsWith(`cmake version ${cmake.version}`)) return cmakeBinary;
  }

  const staging = await fs.mkdtemp(path.join(temporaryRoot, 'cmake-install-'));
  try {
    await command('tar', ['-xzf', archive, '-C', staging, '--strip-components=1']);
    const stagedBinary = path.join(staging, 'CMake.app', 'Contents', 'bin', 'cmake');
    const version = await command(stagedBinary, ['--version'], projectRoot, { capture: true });
    if (!version.stdout.startsWith(`cmake version ${cmake.version}`)) {
      throw new Error(`Unexpected CMake version: ${version.stdout.trim()}`);
    }
    await fs.rm(cmakeRoot, { recursive: true, force: true });
    await fs.rename(staging, cmakeRoot);
    return cmakeBinary;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.platform !== 'darwin') {
  throw new Error('This MVP preparation script currently supports macOS only. Add a pinned, checksummed recipe before using another platform.');
}
if (!['arm64', 'x64'].includes(process.arch)) {
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
}

await fs.mkdir(temporaryRoot, { recursive: true });
await fs.mkdir(downloadsRoot, { recursive: true });

const localCmake = await ensureProjectCmake();
const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'whisper-build-'));
try {
  const sourceArchive = path.join(downloadsRoot, `whisper.cpp-${whisper.version}.tar.gz`);
  const sourceSha256 = await downloadVerified({
    url: whisper.sourceUrl,
    destination: sourceArchive,
    expectedSha256: whisper.sourceSha256,
    label: `whisper.cpp ${whisper.version} source`,
  });
  await command('tar', ['-xzf', sourceArchive, '-C', temporary]);

  const source = path.join(temporary, `whisper.cpp-${whisper.version}`);
  const build = path.join(source, 'build');
  await command(localCmake, [
    '-S', source,
    '-B', build,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
    '-DGGML_METAL=OFF',
    '-DCMAKE_DISABLE_FIND_PACKAGE_Git=TRUE',
    '-DGIT_EXECUTABLE=',
    '-DGIT_EXE=',
  ]);
  await command(localCmake, ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '--parallel', '4']);

  const candidates = [path.join(build, 'bin', 'whisper-cli'), path.join(build, 'whisper-cli')];
  let compiled = null;
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      compiled = candidate;
      break;
    }
  }
  if (!compiled) throw new Error('whisper-cli was not produced by the build.');

  const stagedTarget = path.join(temporary, 'runtime-target');
  const stagedBinary = path.join(stagedTarget, 'bin', 'whisper-cli');
  const stagedModel = path.join(stagedTarget, 'models', model.filename);
  await fs.mkdir(path.dirname(stagedBinary), { recursive: true });
  await fs.mkdir(path.dirname(stagedModel), { recursive: true });
  await fs.copyFile(compiled, stagedBinary);
  await fs.chmod(stagedBinary, 0o755);
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(stagedTarget, 'LICENSE.whisper.cpp'));

  const modelArchive = path.join(downloadsRoot, model.filename);
  const modelSha256 = await downloadVerified({
    url: model.download.url,
    destination: modelArchive,
    expectedSha256: model.download.sha256,
    label: 'Whisper multilingual Base model',
  });
  await fs.copyFile(modelArchive, stagedModel);
  const binarySha256 = await sha256(stagedBinary);
  const binaryStat = await fs.stat(stagedBinary);
  const modelStat = await fs.stat(stagedModel);

  const manifest = {
    schema_version: 1,
    provider: 'whisper.cpp',
    version: whisper.version,
    platform: process.platform,
    arch: process.arch,
    source: {
      url: whisper.sourceUrl,
      archive_sha256: sourceSha256,
    },
    build: {
      cmake_version: cmake.version,
      cmake_url: cmake.url,
      cmake_checksum_url: cmake.checksumUrl,
      cmake_archive_sha256: cmake.sha256,
      metal: false,
    },
    binary: {
      path: 'bin/whisper-cli',
      sha256: binarySha256,
      bytes: binaryStat.size,
    },
    model: {
      name: model.id,
      filename: model.filename,
      multilingual: true,
      url: model.download.url,
      sha256: modelSha256,
      bytes: modelStat.size,
    },
    prepared_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(stagedTarget, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const previous = `${target}.previous-${process.pid}`;
  if (await exists(target)) await fs.rename(target, previous);
  try {
    await fs.rename(stagedTarget, target);
    await fs.rm(previous, { recursive: true, force: true });
  } catch (error) {
    if (await exists(previous) && !await exists(target)) await fs.rename(previous, target);
    throw error;
  }
  console.log(`Whisper runtime prepared and verified inside project: ${target}`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
