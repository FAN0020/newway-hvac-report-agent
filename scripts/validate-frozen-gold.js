#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFrozenGold } from '../evaluation/frozen-gold.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { input: null, cases: null, output: path.join(root, '.tmp', 'evaluation-runs'), requireAll: true };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--input') options.input = path.resolve(process.argv[++i] || '');
  else if (arg === '--cases') options.cases = path.resolve(process.argv[++i] || '');
  else if (arg === '--output') options.output = path.resolve(process.argv[++i] || '');
  else if (arg === '--allow-partial') options.requireAll = false;
  else throw new Error(`Unknown argument ${arg}`);
}
if (!options.input) throw new Error('Usage: npm run eval:gold:validate -- --input <blind-package-or-annotations-directory>');
const annotationsDir = path.basename(options.input) === 'annotations' ? options.input : path.join(options.input, 'annotations');
const caseListPath = options.cases || path.join(path.dirname(annotationsDir), 'blind-cases.json');
const result = await validateFrozenGold({ annotationsDir, caseListPath, requireAll: options.requireAll });
await fs.mkdir(options.output, { recursive: true });
await fs.writeFile(path.join(options.output, 'frozen-gold-validation.json'), `${JSON.stringify(result, null, 2)}\n`);
const lines = ['# Frozen Gold validation', '', `Status: **${result.valid ? 'PASS' : 'FAIL'}**`, '', `Cases: ${result.annotation_files}/${result.expected_cases}`, `Source manifest SHA-256: ${result.source_manifest_sha256 || 'missing'}`, '', '## Errors', ''];
if (result.errors.length) for (const issue of result.errors) lines.push(`- ${issue.file || issue.case_id || 'batch'}: ${issue.errors.join('; ')}`);
else lines.push('None. The annotations are structurally ready for a separate Gold scoring run.');
await fs.writeFile(path.join(options.output, 'frozen-gold-validation.md'), `${lines.join('\n')}\n`);
console.log(`Frozen Gold validation: ${result.valid ? 'PASS' : 'FAIL'} (${result.annotation_files}/${result.expected_cases})`);
console.log(path.join(options.output, 'frozen-gold-validation.md'));
if (!result.valid) process.exitCode = 1;
