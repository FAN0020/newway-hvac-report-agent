#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'evaluation', 'synthetic-cases.v1.json');
const defaultOutput = path.join(root, '.tmp', 'synthetic-audio');
const profiles = Object.freeze({ clean: null, mild_bandlimit: 'highpass=f=120,lowpass=f=6500', telephone: 'highpass=f=300,lowpass=f=3400' });
const requiredArrays = ['terms', 'numbers_units', 'equipment_ids', 'expected_facts', 'expected_retrieval_ids', 'relevant_retrieval_ids', 'missing_fields', 'report_points'];
const scopes = ['HVAC', 'SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID'];
const scenarios = ['normal', 'confusable_term', 'negation_missing'];

function fail(message) { throw new Error(message); }
function parseArgs(argv) {
  const options = { validate: false, dryRun: false, output: defaultOutput, ids: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--validate') options.validate = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--case') options.ids.push(argv[++i] || fail('--case requires an ID'));
    else if (arg === '--output') options.output = path.resolve(argv[++i] || fail('--output requires a path'));
    else if (arg === '--help') { console.log('Usage: node scripts/generate-synthetic-audio.js [--validate] [--dry-run] [--case ID] [--output DIR]'); process.exit(0); }
    else fail(`Unknown argument: ${arg}`);
  }
  if (options.validate && (options.dryRun || options.ids.length)) fail('--validate cannot be combined with --dry-run or --case');
  return options;
}
async function sha256(file) { return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
function command(name, args, capture = false) {
  const result = spawnSync(name, args, { encoding: 'utf8', stdio: capture ? 'pipe' : ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  if (result.error || result.status !== 0) fail(`${name} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout?.trim() || '';
}
async function loadAndValidate() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const registry = JSON.parse(await fs.readFile(path.join(root, 'data/knowledge/v2/scope-registry.v1.json'), 'utf8'));
  if (manifest.schema_version !== 'synthetic-audio-eval.v1' || manifest.label !== 'SYNTHETIC' || manifest.gold_status !== 'seed_only') fail('Manifest version, label, or gold status is invalid');
  if (!Array.isArray(manifest.cases) || manifest.cases.length < 15) fail('At least 15 cases are required');
  const seen = new Set();
  const knowledgeIds = new Map();
  for (const scope of scopes) {
    if (registry.scopes[scope]?.kind !== 'domain') fail(`Unknown scope ${scope}`);
    const ids = new Set();
    for (const filename of registry.knowledge_files[scope]) {
      const doc = JSON.parse(await fs.readFile(path.join(root, 'data/knowledge', filename), 'utf8'));
      const records = doc.records || [...(doc.fixed_sections || []), ...(doc.conditional_sections || [])];
      records.forEach((record) => ids.add(`knowledge:${scope}:${filename}:${record.id}`));
    }
    knowledgeIds.set(scope, ids);
  }
  for (const item of manifest.cases) {
    if (!/^[A-Z0-9-]+$/.test(item.case_id || '') || seen.has(item.case_id)) fail(`Invalid or duplicate case_id: ${item.case_id}`);
    seen.add(item.case_id);
    if (!scopes.includes(item.scope) || !scenarios.includes(item.scenario) || item.synthetic !== true) fail(`${item.case_id}: scope/scenario/synthetic invalid`);
    if (typeof item.standard_text !== 'string' || !item.standard_text.trim() || !/fictional/i.test(item.standard_text)) fail(`${item.case_id}: text needs explicit fictional label`);
    if (typeof item.voice !== 'string' || !item.voice || !Number.isInteger(item.rate_wpm) || item.rate_wpm < 100 || item.rate_wpm > 250) fail(`${item.case_id}: voice/rate invalid`);
    if (!Object.hasOwn(profiles, item.noise_profile)) fail(`${item.case_id}: unknown noise profile`);
    for (const key of requiredArrays) if (!Array.isArray(item[key]) || (key !== 'numbers_units' && item[key].length === 0) || item[key].some((x) => typeof x !== 'string' || !x.trim())) fail(`${item.case_id}: ${key} invalid`);
    if (item.expected_retrieval_ids.some((id) => !item.relevant_retrieval_ids.includes(id))) fail(`${item.case_id}: expected ID absent from relevant set`);
    for (const id of item.relevant_retrieval_ids) if (!knowledgeIds.get(item.scope).has(id)) fail(`${item.case_id}: missing or cross-scope knowledge ID ${id}`);
  }
  for (const scope of scopes) for (const scenario of scenarios) if (!manifest.cases.some((x) => x.scope === scope && x.scenario === scenario)) fail(`${scope}: missing ${scenario}`);
  return { manifest, manifestSha256: await sha256(manifestPath) };
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { manifest, manifestSha256 } = await loadAndValidate();
  if (opts.validate) { console.log(`Valid: ${manifest.cases.length} SYNTHETIC seed cases; manifest sha256 ${manifestSha256}`); return; }
  const selected = opts.ids.length ? manifest.cases.filter((x) => opts.ids.includes(x.case_id)) : manifest.cases;
  if (selected.length !== (new Set(opts.ids)).size && opts.ids.length) fail('Unknown --case ID');
  if (opts.dryRun) { console.log(JSON.stringify({ label: 'SYNTHETIC', output: opts.output, cases: selected.map((x) => ({ case_id: x.case_id, voice: x.voice, rate_wpm: x.rate_wpm, noise_profile: x.noise_profile, wav: `${x.case_id}.wav` })) }, null, 2)); return; }
  if (process.platform !== 'darwin') fail('Audio generation requires macOS say');
  for (const tool of ['say', 'ffmpeg', 'ffprobe']) command('which', [tool], true);
  const availableVoices = command('say', ['-v', '?'], true);
  for (const voice of new Set(selected.map((x) => x.voice))) if (!new RegExp(`^${voice}\\s`, 'm').test(availableVoices)) fail(`macOS voice unavailable: ${voice}`);
  await fs.mkdir(opts.output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-audio-'));
  const generated = [];
  try {
    for (const item of selected) {
      const aiff = path.join(temp, `${item.case_id}.aiff`);
      const wav = path.join(temp, `${item.case_id}.wav`);
      command('say', ['-v', item.voice, '-r', String(item.rate_wpm), '-o', aiff, item.standard_text]);
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff];
      if (profiles[item.noise_profile]) args.push('-af', profiles[item.noise_profile]);
      args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
      command('ffmpeg', args);
      const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', wav], true));
      const stream = probe.streams?.[0];
      if (stream?.codec_name !== 'pcm_s16le' || Number(stream.sample_rate) !== 16000 || stream.channels !== 1 || !(Number(probe.format?.duration) > 0)) fail(`${item.case_id}: invalid WAV output`);
      const destination = path.join(opts.output, `${item.case_id}.wav`);
      await fs.copyFile(wav, destination);
      generated.push({ case_id: item.case_id, file: `${item.case_id}.wav`, sha256: await sha256(destination), duration_seconds: Number(probe.format.duration), voice: item.voice, rate_wpm: item.rate_wpm, noise_profile: item.noise_profile });
      console.log(`Generated ${item.case_id}.wav`);
    }
    await fs.writeFile(path.join(opts.output, 'metadata.json'), `${JSON.stringify({ schema_version: 'synthetic-audio-metadata.v1', label: 'SYNTHETIC', manifest_sha256: manifestSha256, generator: 'macOS say + ffmpeg pcm_s16le mono 16000 Hz', cases: generated }, null, 2)}\n`);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
