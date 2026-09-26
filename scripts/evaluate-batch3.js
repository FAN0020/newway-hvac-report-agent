#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRag, runReports, SCOPES, sha } from '../evaluation/batch3-core.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'evaluation/synthetic-cases.v1.json');
const fixturePath = path.join(root, 'evaluation/batch3-fixtures.v1.json');
const [manifestRaw, fixturesRaw] = await Promise.all([fs.readFile(manifestPath), fs.readFile(fixturePath)]);
const manifest = JSON.parse(manifestRaw);
const fixtures = JSON.parse(fixturesRaw);
if (manifest.gold_status !== 'seed_only' || fixtures.label_status !== 'SYNTHETIC_SEED_ONLY') throw new Error('Expected provisional synthetic seeds');
const options = { components: ['rag', 'report'], ids: [], output: path.join(root, '.tmp/evaluation-runs') };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--component') options.components = [process.argv[++i]];
  else if (arg === '--case') options.ids.push(process.argv[++i]);
  else if (arg === '--output') options.output = path.resolve(process.argv[++i]);
  else throw new Error(`Unknown argument ${arg}`);
}
if (options.components.some((component) => !['rag', 'report'].includes(component))) throw new Error('Invalid component');
const cases = manifest.cases.filter((item) => !options.ids.length || options.ids.includes(item.case_id));
if (cases.length !== (options.ids.length ? new Set(options.ids).size : manifest.cases.length)) throw new Error('Unknown or duplicate case ID');
for (const item of cases) if (!SCOPES.includes(item.scope)) throw new Error(`Invalid scope ${item.scope}`);
const components = {};
if (options.components.includes('rag')) components.rag = await runRag({ root, cases, fixtures });
if (options.components.includes('report')) components.report = await runReports({ root, cases, fixtures });
const summary = {};
for (const [name, result] of Object.entries(components)) {
  summary[name] = {};
  for (const scope of SCOPES) {
    const rows = result.results.filter((row) => row.scope === scope);
    const run = rows.filter((row) => row.status === 'RUN');
    const counts = Object.fromEntries(['RUN', 'NOT_RUN', 'NOT_SUPPORTED', 'ERROR'].map((status) => [status, rows.filter((row) => row.status === status).length]));
    const mean = (key) => run.length ? run.reduce((sum, row) => sum + (row.metrics[key] || 0), 0) / run.length : null;
    summary[name][scope] = { status_counts: counts, ...(name === 'rag' ? { hit_at_3: mean('hit_at_3'), recall_at_3: mean('recall_at_3'), precision_at_3: mean('precision_at_3'), mrr_at_3: mean('mrr_at_3') } : { required_section_completeness: mean('required_section_completeness'), required_section_populated: mean('required_section_populated'), fact_value_coverage: mean('fact_value_coverage'), unsupported_claim_count: run.reduce((sum, row) => sum + row.metrics.unsupported_claim_count, 0) }), hard_gate_failures: run.flatMap((row) => row.hard_gate_failures.map((failure) => ({ case_id: row.case_id, ...failure }))) };
  }
}
const output = { contract_version: 'batch3-component-evaluation.v1', generated_at: new Date().toISOString(), label_status: 'PROVISIONAL_SYNTHETIC_SEED', frozen_gold: false, source: { manifest_sha256: sha(manifestRaw), fixture_sha256: sha(fixturesRaw) }, summary, components };
await fs.mkdir(options.output, { recursive: true });
await fs.writeFile(path.join(options.output, 'batch3-results.json'), `${JSON.stringify(output, null, 2)}\n`);
const lines = ['# Batch 3 component evaluation', '', `Status: **${output.label_status}**; synthetic seed only, no human frozen Gold.`, '', '| Component | Scope | Run | Not run | Not supported | Error | Primary metric | Gate failures |', '|---|---|---:|---:|---:|---:|---:|---:|'];
for (const [name, scopes] of Object.entries(summary)) for (const [scope, data] of Object.entries(scopes)) lines.push(`| ${name} | ${scope} | ${data.status_counts.RUN} | ${data.status_counts.NOT_RUN} | ${data.status_counts.NOT_SUPPORTED} | ${data.status_counts.ERROR} | ${name === 'rag' ? `Hit@3 ${data.hit_at_3?.toFixed(3) ?? 'NA'}; Recall@3 ${data.recall_at_3?.toFixed(3) ?? 'NA'}` : `Populated ${data.required_section_populated?.toFixed(3) ?? 'NA'}; fact value ${data.fact_value_coverage?.toFixed(3) ?? 'NA'}`} | ${data.hard_gate_failures.length} |`);
lines.push('', '## Case details', '');
for (const [name, component] of Object.entries(components)) {
  lines.push(`### ${name}`, '');
  for (const row of component.results) lines.push(`- ${row.case_id}: ${row.status}${row.reason ? ` (${row.reason})` : ''}${row.status === 'RUN' ? `; gates ${row.hard_gate_failures.length}` : ''}`);
  lines.push('');
}
lines.push('Missing report facts and approvals remain placeholders. Fixed report context is not a source of service facts. See evaluation/README.md for metric denominators and limits.', '');
await fs.writeFile(path.join(options.output, 'batch3-results.md'), `${lines.join('\n')}\n`);
console.log(`Wrote ${path.join(options.output, 'batch3-results.json')}`);
console.log(`Wrote ${path.join(options.output, 'batch3-results.md')}`);
console.log(JSON.stringify(summary));
