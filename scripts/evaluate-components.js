#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { whisperAdapter, correctionAdapter, factsAdapter, missingAdapter } from '../evaluation/component-adapters.js';
import { errorRate, categoryHits, setCounts, scores, aggregateFieldScores, normalizedText } from '../evaluation/component-metrics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const components = ['asr', 'correction', 'facts', 'missing'];
const scopes = ['HVAC', 'SBS_BUS', 'SBS_RAIL', 'OILFIELD', 'POWER_GRID'];
const opts = { component: 'all', dryRun: false, ids: [], output: path.join(root, '.tmp/evaluation-runs'), audio: path.join(root, '.tmp/synthetic-audio') };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--dry-run') opts.dryRun = true;
  else if (arg === '--component') opts.component = process.argv[++i];
  else if (arg === '--case') opts.ids.push(process.argv[++i]);
  else if (arg === '--output') opts.output = path.resolve(process.argv[++i]);
  else if (arg === '--audio') opts.audio = path.resolve(process.argv[++i]);
  else throw new Error(`Unknown argument ${arg}`);
}
if (opts.component !== 'all' && !components.includes(opts.component)) throw new Error('Unknown component');
const selectedComponents = opts.component === 'all' ? components : [opts.component];
const manifestPath = path.join(root, 'evaluation/synthetic-cases.v1.json');
const fixturePath = path.join(root, 'evaluation/component-fixtures.v1.json');
const manifest = JSON.parse(await fs.readFile(manifestPath));
const fixtures = JSON.parse(await fs.readFile(fixturePath));
if (manifest.label !== 'SYNTHETIC' || manifest.gold_status !== 'seed_only' || fixtures.label_status !== 'SYNTHETIC_SEED_ONLY') throw new Error('Expected synthetic seed contracts');
const cases = manifest.cases.filter((item) => !opts.ids.length || opts.ids.includes(item.case_id));
if (cases.length !== (opts.ids.length ? new Set(opts.ids).size : manifest.cases.length)) throw new Error('Unknown or duplicate case ID');
for (const item of cases) if (!scopes.includes(item.scope) || !Array.isArray(fixtures.fact_fields[item.case_id])) throw new Error(`Missing fixture for ${item.case_id}`);
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const manifestHash = sha(await fs.readFile(manifestPath));
const fixtureHash = sha(await fs.readFile(fixturePath));
const results = [];
const add = (component, item, status, extra = {}) => results.push({ contract_version: 'component-result.v1', component, case_id: item.case_id, scope: item.scope, scenario: item.scenario, status, ...extra });
const whisper = selectedComponents.includes('asr') && !opts.dryRun ? whisperAdapter(root) : null;
const health = whisper ? await whisper.health({ model: 'base' }) : null;
let audioMetadata = null;
try { audioMetadata = JSON.parse(await fs.readFile(path.join(opts.audio, 'metadata.json'))); } catch { /* no audio metadata */ }
for (const item of cases) {
  for (const component of selectedComponents) {
    try {
      if (component === 'asr') {
        if (opts.dryRun) { add(component, item, 'NOT_RUN', { reason: 'dry_run' }); continue; }
        if (!health.ready) { add(component, item, 'NOT_RUN', { reason: health.error_code, detail: health.message }); continue; }
        const wav = path.join(opts.audio, `${item.case_id}.wav`);
        if (audioMetadata?.manifest_sha256 !== manifestHash) { add(component, item, 'NOT_RUN', { reason: 'AUDIO_MANIFEST_MISMATCH' }); continue; }
        let buffer;
        try { buffer = await fs.readFile(wav); } catch { add(component, item, 'NOT_RUN', { reason: 'WAV_MISSING' }); continue; }
        const meta = audioMetadata?.cases?.find?.((entry) => entry.case_id === item.case_id);
        if (!meta || meta.sha256 !== sha(buffer)) { add(component, item, 'NOT_RUN', { reason: 'WAV_CHECKSUM_MISMATCH' }); continue; }
        const prediction = await whisper.transcribe(wav, { model: 'base', language: 'en' });
        const categories = {
          term: categoryHits(prediction.raw_text, item.terms),
          number_unit: categoryHits(prediction.raw_text, item.numbers_units),
          equipment_id: categoryHits(prediction.raw_text, item.equipment_ids, 'equipment_id'),
        };
        const failures = Object.entries(categories).flatMap(([category, score]) => score.missed.map((phrase) => ({ category, phrase })));
        add(component, item, 'RUN', { input: { wav_sha256: sha(buffer), reference_text: item.standard_text }, prediction: { text: prediction.raw_text, provider: prediction.provider, model: prediction.model }, metrics: { wer: errorRate(item.standard_text, prediction.raw_text), cer: errorRate(item.standard_text, prediction.raw_text, 'character'), categories }, hard_gate_failures: failures });
      } else if (component === 'correction') {
        if (['OILFIELD', 'POWER_GRID'].includes(item.scope)) { add(component, item, 'NOT_SUPPORTED', { reason: 'No scope-specific correction module' }); continue; }
        const fixture = fixtures.correction.find((entry) => entry.case_id === item.case_id);
        if (!fixture) { add(component, item, 'NOT_RUN', { reason: 'NO_FIXED_NOISY_FIXTURE' }); continue; }
        const prediction = await correctionAdapter(item.scope, fixture.raw_text, item.case_id);
        const preservation = Object.fromEntries(Object.entries(fixture.critical).map(([category, phrases]) => [category, categoryHits(prediction.text, phrases)]));
        const failures = Object.entries(preservation).flatMap(([category, score]) => score.missed.map((phrase) => ({ category, phrase })));
        if (normalizedText(prediction.text) !== normalizedText(fixture.expected_text)) failures.push({ category: 'expected_correction', expected_text: fixture.expected_text });
        add(component, item, 'RUN', { input: { raw_text: fixture.raw_text }, expected: { text: fixture.expected_text }, prediction, metrics: { exact_match: prediction.text === fixture.expected_text, critical_preservation: preservation }, hard_gate_failures: failures });
      } else if (component === 'facts') {
        const prediction = await factsAdapter(item.scope, item.standard_text, item.case_id);
        if (prediction.status !== 'PASS') { add(component, item, 'ERROR', { reason: prediction.error_code || prediction.status }); continue; }
        const expected = fixtures.fact_fields[item.case_id];
        const actual = [...new Set(prediction.facts.map((fact) => fact.field))];
        const counts = setCounts(expected, actual);
        const critical = ['asset.registration_no', 'asset.train_set', 'completion.state', 'work_performed', 'parts.replaced'];
        const failures = expected.filter((field) => critical.includes(field) && !actual.includes(field)).map((field) => ({ category: 'critical_fact_missing', field }));
        if (!expected.includes('work_performed') && actual.includes('work_performed')) failures.push({ category: 'unsupported_action', field: 'work_performed' });
        if (!expected.includes('parts.replaced') && actual.includes('parts.replaced')) failures.push({ category: 'unsupported_replacement', field: 'parts.replaced' });
        add(component, item, 'RUN', { input: { reference_text: item.standard_text }, expected: { fields: expected }, prediction: { facts: prediction.facts, fields: actual }, counts, metrics: scores(counts), hard_gate_failures: failures });
      } else {
        const fixture = fixtures.missing.find((entry) => entry.case_id === item.case_id);
        if (!fixture) { add(component, item, 'NOT_RUN', { reason: 'NO_FIXED_FACTS_SCHEMA_FIXTURE' }); continue; }
        const prediction = await missingAdapter(item.scope, fixture.facts, item.case_id);
        if (prediction.status === 'FAIL') { add(component, item, 'ERROR', { reason: prediction.error_code }); continue; }
        const counts = setCounts(fixture.expected, prediction.missing);
        add(component, item, 'RUN', { input: { facts: fixture.facts, schema: item.scope === 'HVAC' ? 'report-modules.v1' : 'v2-report-sections' }, expected: { missing: fixture.expected }, prediction: { missing: prediction.missing }, counts, metrics: scores(counts), hard_gate_failures: [] });
      }
    } catch (error) { add(component, item, 'ERROR', { reason: error.code || error.name, detail: error.message }); }
  }
}
const summary = {};
for (const component of selectedComponents) {
  summary[component] = {};
  for (const scope of scopes) {
    const subset = results.filter((item) => item.component === component && item.scope === scope);
    const run = subset.filter((item) => item.status === 'RUN');
    const grouped = Object.groupBy(subset, (item) => item.status);
    const hardGateFailures = run.flatMap((item) => item.hard_gate_failures.map((failure) => ({ case_id: item.case_id, ...failure })));
    summary[component][scope] = { status_counts: Object.fromEntries(Object.entries(grouped).map(([key, value]) => [key, value.length])), ...(component === 'facts' || component === 'missing' ? { field_scores: aggregateFieldScores(subset) } : {}), ...(component === 'asr' && run.length ? { mean_wer: run.reduce((sum, item) => sum + item.metrics.wer, 0) / run.length, mean_cer: run.reduce((sum, item) => sum + item.metrics.cer, 0) / run.length, categories: Object.fromEntries(['term', 'number_unit', 'equipment_id'].map((category) => [category, { matched: run.reduce((sum, item) => sum + item.metrics.categories[category].matched, 0), total: run.reduce((sum, item) => sum + item.metrics.categories[category].total, 0) }])) } : {}), ...(component === 'correction' && run.length ? { exact_matches: run.filter((item) => item.metrics.exact_match).length, cases: run.length } : {}), hard_gate_failures: hardGateFailures, error_class_counts: Object.fromEntries(Object.entries(Object.groupBy(hardGateFailures, (failure) => failure.category)).map(([category, failures]) => [category, failures.length])) };
  }
}
for (const item of results) {
  if (item.status === 'RUN' && (!item.input || !item.prediction || !item.metrics || !Array.isArray(item.hard_gate_failures))) throw new Error(`Incomplete RUN result ${item.case_id}/${item.component}`);
  if (item.status !== 'RUN' && !item.reason) throw new Error(`Missing reason ${item.case_id}/${item.component}`);
}
const report = { contract_version: 'component-evaluation.v1', generated_at: new Date().toISOString(), label_status: 'PROVISIONAL_SYNTHETIC_SEED', frozen_gold: false, source: { case_set_version: manifest.case_set_version, manifest_sha256: manifestHash, fixture_sha256: fixtureHash }, runtime: { asr_health: health ? { ready: health.ready, error_code: health.error_code, runtime_integrity: health.runtime_integrity?.status, model: health.model } : null, dry_run: opts.dryRun }, summary, results };
await fs.mkdir(opts.output, { recursive: true });
await fs.writeFile(path.join(opts.output, 'component-results.json'), `${JSON.stringify(report, null, 2)}\n`);
const lines = ['# Component evaluation', '', `Status: **${report.label_status}**. These are synthetic seed labels, not frozen human Gold.`, '', `Generated: ${report.generated_at}`, '', '| Component | Scope | Run | Not run | Not supported | Errors | Hard gate failures |', '|---|---|---:|---:|---:|---:|---:|'];
for (const component of selectedComponents) for (const scope of scopes) {
  const row = summary[component][scope];
  lines.push(`| ${component} | ${scope} | ${row.status_counts.RUN || 0} | ${row.status_counts.NOT_RUN || 0} | ${row.status_counts.NOT_SUPPORTED || 0} | ${row.status_counts.ERROR || 0} | ${row.hard_gate_failures.length} |`);
  if (row.field_scores) lines.push(`  Field-level micro P/R/F1: ${Object.values(row.field_scores.micro).map((x) => x.toFixed(3)).join(' / ')}; macro P/R/F1: ${Object.values(row.field_scores.macro).map((x) => x.toFixed(3)).join(' / ')}.`);
  if (row.mean_wer !== undefined) lines.push(`  WER ${row.mean_wer.toFixed(3)}, CER ${row.mean_cer.toFixed(3)}; term ${row.categories.term.matched}/${row.categories.term.total}, number/unit ${row.categories.number_unit.matched}/${row.categories.number_unit.total}, equipment ID ${row.categories.equipment_id.matched}/${row.categories.equipment_id.total}.`);
  if (Object.keys(row.error_class_counts).length) lines.push(`  Critical check failures by class: ${Object.entries(row.error_class_counts).map(([category, count]) => `${category} ${count}`).join(', ')}.`);
}
lines.push('', '## Hard gate failures', '');
for (const component of selectedComponents) for (const scope of scopes) for (const failure of summary[component][scope].hard_gate_failures) lines.push(`- ${component} / ${scope} / ${failure.case_id}: ${failure.category} ${failure.field || failure.phrase || ''}`);
if (!lines.at(-1).startsWith('- ')) lines.push('None.');
lines.push('', '## Not run and errors', '');
for (const item of results.filter((entry) => entry.status !== 'RUN')) lines.push(`- ${item.component} / ${item.case_id}: ${item.status} (${item.reason}${item.detail ? `: ${item.detail}` : ''})`);
await fs.writeFile(path.join(opts.output, 'component-results.md'), `${lines.join('\n')}\n`);
if (results.some((item) => item.status === 'ERROR')) process.exitCode = 1;
console.log(`Component evaluation: ${results.filter((item) => item.status === 'RUN').length} RUN, ${results.filter((item) => item.status === 'NOT_RUN').length} NOT_RUN, ${results.filter((item) => item.status === 'NOT_SUPPORTED').length} NOT_SUPPORTED, ${results.filter((item) => item.status === 'ERROR').length} ERROR`);
console.log(`${opts.output}/component-results.md`);
