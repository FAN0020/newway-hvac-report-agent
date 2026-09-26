#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let output = path.join(root, '.tmp/evaluation-runs');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--output') output = path.resolve(process.argv[++i]);
  else throw new Error(`Unknown argument ${process.argv[i]}`);
}
async function load(name) { try { return JSON.parse(await fs.readFile(path.join(output, name))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
const [batch2, batch3, deep] = await Promise.all([load('component-results.json'), load('batch3-results.json'), load('deepeval-results.json')]);
if (!batch2 || !batch3) throw new Error('Run eval:components and eval:batch3 before summarizing');
if (batch2.source.manifest_sha256 !== batch3.source.manifest_sha256) throw new Error('Batch 2 and 3 use different case manifests');
if (deep && (deep.source?.manifest_sha256 !== batch3.source.manifest_sha256 || deep.source?.batch2_fixture_sha256 !== batch2.source.fixture_sha256 || deep.source?.batch3_fixture_sha256 !== batch3.source.fixture_sha256)) throw new Error('DeepEval results use different component sources; rerun eval:deepeval:adapter or eval:deepeval:smoke');
const combined = { contract_version: 'component-evaluation-summary.v1', label_status: 'PROVISIONAL_SYNTHETIC_SEED', frozen_gold: false, source: { manifest_sha256: batch3.source.manifest_sha256, batch2_fixture_sha256: batch2.source.fixture_sha256, batch3_fixture_sha256: batch3.source.fixture_sha256 }, batch2: batch2.summary, batch3: batch3.summary, deepeval: deep ? { judge: deep.judge, status_counts: { RUN: deep.results.filter((row) => row.status === 'RUN').length, NOT_RUN: deep.results.filter((row) => row.status === 'NOT_RUN').length }, results: deep.results } : { status: 'NOT_RUN', reason: 'DEEPEVAL_RESULTS_MISSING' } };
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'summary.json'), `${JSON.stringify(combined, null, 2)}\n`);
const lines = ['# Component evaluation summary', '', 'PROVISIONAL_SYNTHETIC_SEED; no human frozen Gold or end-to-end run.', '', `Manifest SHA-256: ${combined.source.manifest_sha256}`, '', '## Batch 2: ASR, correction, facts, missing fields', '', '| Component | Scope | Run | Not run | Not supported | Error | Gate failures |', '|---|---|---:|---:|---:|---:|---:|'];
for (const [name, scopes] of Object.entries(batch2.summary)) for (const [scope, data] of Object.entries(scopes)) lines.push(`| ${name} | ${scope} | ${data.status_counts.RUN || 0} | ${data.status_counts.NOT_RUN || 0} | ${data.status_counts.NOT_SUPPORTED || 0} | ${data.status_counts.ERROR || 0} | ${data.hard_gate_failures.length} |`);
lines.push('', '## Batch 3: RAG and report', '', '| Component | Scope | Run | Not run | Not supported | Error | Gate failures |', '|---|---|---:|---:|---:|---:|---:|');
for (const [name, scopes] of Object.entries(batch3.summary)) for (const [scope, data] of Object.entries(scopes)) lines.push(`| ${name} | ${scope} | ${data.status_counts.RUN} | ${data.status_counts.NOT_RUN} | ${data.status_counts.NOT_SUPPORTED} | ${data.status_counts.ERROR} | ${data.hard_gate_failures.length} |`);
lines.push('', '## DeepEval', '', deep ? `${combined.deepeval.status_counts.RUN} semantic scores RUN; ${combined.deepeval.status_counts.NOT_RUN} NOT_RUN. Judge: ${deep.judge || 'unavailable'}.` : 'NOT_RUN: deepeval-results.json missing.', '', 'Read component-results.md, batch3-results.md and deepeval-results.md for case details and metric limits.', '');
await fs.writeFile(path.join(output, 'summary.md'), `${lines.join('\n')}\n`);
console.log(`Wrote ${path.join(output, 'summary.json')} and summary.md`);
