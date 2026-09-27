#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_AUDIO = path.join(ROOT, '.tmp', 'synthetic-audio');
const DEFAULT_OUTPUT = path.join(ROOT, 'outputs', 'qiongwen-ground-truth-blind-package-2026-09-26');
const FORBIDDEN_KEYS = [
  'standard_text', 'expected_facts', 'expected_retrieval_ids',
  'relevant_retrieval_ids', 'seed',
];

function parseArgs(argv) {
  const options = { audio: DEFAULT_AUDIO, output: DEFAULT_OUTPUT, zip: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--audio') options.audio = path.resolve(argv[++index] || '');
    else if (arg === '--output') options.output = path.resolve(argv[++index] || '');
    else if (arg === '--no-zip') options.zip = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function flattenRecords(document) {
  if (Array.isArray(document.records)) return document.records;
  return [...(document.fixed_sections || []), ...(document.conditional_sections || [])];
}

async function knowledgeCatalog() {
  const registryPath = path.join(ROOT, 'data', 'knowledge', 'v2', 'scope-registry.v1.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const scopes = ['HVAC', 'SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID'];
  const rows = [];
  for (const scope of scopes) {
    for (const sourceFile of registry.knowledge_files[scope] || []) {
      const document = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'knowledge', sourceFile), 'utf8'));
      for (const record of flattenRecords(document)) {
        rows.push({
          knowledge_id: `knowledge:${scope}:${sourceFile}:${record.id}`,
          scope,
          source_file: sourceFile,
          title: record.name || record.canonical || record.title || record.id,
          description: record.description || null,
          aliases: record.aliases || record.terms || [],
        });
      }
    }
  }
  return { schema_version: 'blind-knowledge-catalog.v1', registry_version: registry.schema_version, records: rows };
}

function blankAnnotation(item, audioHash, manifestHash) {
  return {
    schema_version: 'audio-ground-truth.blind.v1',
    case_id: item.case_id,
    scope: item.scope,
    scenario: item.scenario,
    synthetic: true,
    source_manifest_sha256: manifestHash,
    audio_file: `${item.case_id}.wav`,
    audio_file_sha256: audioHash,
    annotation: {
      verbatim_transcript: null,
      normalized_transcript: null,
      technical_terms: [],
      numbers_units: [],
      equipment_ids: [],
      facts: [],
      negated_or_deferred_actions: [],
      relevant_knowledge_ids: [],
      missing_fields: [],
      report_points: [],
      target_report: null,
      uncertain_spans: [],
      reviewer_notes: null,
    },
    human_review_status: 'unreviewed',
    reviewer_id: null,
    reviewed_at: null,
    frozen_gold: false,
    freeze: { approved_by: null, approved_at: null, annotation_sha256: null },
  };
}

function readme(caseCount) {
  return [
    '# 琼文 Ground Truth 盲标包',
    '',
    `本包含 ${caseCount} 个明确标记为 SYNTHETIC 的合成音频案例。请不要索要或查看 Whisper 转写、seed 标准文本、系统事实抽取、RAG 输出、报告或评测分数。`,
    '',
    '## 需要完成',
    '',
    '1. 直接听 WAV，填写 `annotations/<case_id>.json`。',
    '2. 逐字转写和规范化转写分开记录。',
    '3. 标注专业术语、数字/单位、设备编号、事实、否定或延期动作。',
    '4. 先保存1–3的听写结果，然后再打开 `knowledge-catalog.json` 独立判断相关知识 ID，避免知识库反向影响转写。',
    '5. 标注缺失字段、报告要点和目标报告。',
    '6. 听不清的部分写入 `uncertain_spans`，不要猜测。',
    '7. 第二遍复核后填写 reviewer 信息。在第二人审核前，`frozen_gold` 必须保持 `false`。',
    '',
    '注意：`blind-cases.json` 只用于对应案例和音频，不含任何标准答案。',
    '',
  ].join('\n');
}

async function assertBlind(output, manifest) {
  const files = ['blind-cases.json', 'knowledge-catalog.json', 'README-FIRST.md'];
  for (const item of manifest.cases) files.push(path.join('annotations', `${item.case_id}.json`));
  const combined = (await Promise.all(files.map((file) => fs.readFile(path.join(output, file), 'utf8')))).join('\n');
  for (const key of FORBIDDEN_KEYS) {
    if (combined.includes(`"${key}"`)) throw new Error(`Blind package leaked forbidden key: ${key}`);
  }
  for (const item of manifest.cases) {
    if (combined.includes(item.standard_text)) throw new Error(`Blind package leaked standard text: ${item.case_id}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(ROOT, 'evaluation', 'synthetic-cases.v1.json');
  const manifestBuffer = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBuffer);
  const manifestHash = sha256(manifestBuffer);
  const audioMetadata = JSON.parse(await fs.readFile(path.join(options.audio, 'metadata.json'), 'utf8'));
  const audioByCase = new Map(audioMetadata.cases.map((item) => [item.case_id, item]));
  if (manifest.cases.length !== 15 || audioByCase.size !== manifest.cases.length) {
    throw new Error('Expected exactly 15 manifest cases and 15 generated audio records');
  }

  await fs.rm(options.output, { recursive: true, force: true });
  await fs.mkdir(path.join(options.output, 'audio'), { recursive: true });
  await fs.mkdir(path.join(options.output, 'annotations'), { recursive: true });
  const blindCases = [];
  for (const item of manifest.cases) {
    const audio = audioByCase.get(item.case_id);
    if (!audio) throw new Error(`Missing audio metadata for ${item.case_id}`);
    const source = path.join(options.audio, audio.file);
    const buffer = await fs.readFile(source);
    const actualHash = sha256(buffer);
    if (actualHash !== audio.sha256) throw new Error(`Audio checksum mismatch for ${item.case_id}`);
    await fs.copyFile(source, path.join(options.output, 'audio', audio.file));
    blindCases.push({ case_id: item.case_id, scope: item.scope, scenario: item.scenario, synthetic: true, audio_file: `audio/${audio.file}`, audio_file_sha256: actualHash });
    const blank = blankAnnotation(item, actualHash, manifestHash);
    await fs.writeFile(path.join(options.output, 'annotations', `${item.case_id}.json`), `${JSON.stringify(blank, null, 2)}\n`);
  }
  await fs.writeFile(path.join(options.output, 'blind-cases.json'), `${JSON.stringify({ schema_version: 'blind-case-list.v1', label: 'SYNTHETIC', source_manifest_sha256: manifestHash, cases: blindCases }, null, 2)}\n`);
  await fs.writeFile(path.join(options.output, 'knowledge-catalog.json'), `${JSON.stringify(await knowledgeCatalog(), null, 2)}\n`);
  await fs.writeFile(path.join(options.output, 'README-FIRST.md'), readme(blindCases.length));
  await assertBlind(options.output, manifest);

  let zipPath = null;
  if (options.zip) {
    zipPath = `${options.output}.zip`;
    await fs.rm(zipPath, { force: true });
    const result = spawnSync('/usr/bin/zip', ['-qr', zipPath, path.basename(options.output)], { cwd: path.dirname(options.output), encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `zip failed with ${result.status}`);
  }
  console.log(JSON.stringify({ cases: blindCases.length, output: options.output, zip: zipPath, label: 'SYNTHETIC', leakage_check: 'PASS' }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
