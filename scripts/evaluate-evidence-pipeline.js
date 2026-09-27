#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateEvidencePipelines } from '../evaluation/evidence-pipeline-evaluation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'evaluation', 'evidence-pipeline-frozen.v1.json');
const fixtureRaw = await fs.readFile(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureRaw);
const fixtureSha256 = crypto.createHash('sha256').update(fixtureRaw).digest('hex');
const result = await evaluateEvidencePipelines({ fixture, fixtureSha256, repeats: 5 });
const output = path.join(root, '.tmp', 'evaluation-runs');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'evidence-pipeline-comparison.json'), `${JSON.stringify(result, null, 2)}\n`);
const lines = [
  '# Evidence pipeline comparison', '',
  `Fixture: \`${result.fixture_version}\` (${result.cases} cases; ${result.repeats} repeats)`,
  `Fixture SHA-256: \`${result.fixture_sha256}\``,
  `Selected: **${result.decision.selected || 'NONE'}**`, '',
  '| Approach | Field P/R/F1 | Value P/R/F1 | Negation | False supported | Missed | Provenance | Hit@3 | Isolation | Required completeness | Interventions | Unnecessary | Mean latency |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
];
for (const approach of result.approaches) {
  const item = result.summary[approach];
  lines.push(`| ${approach} | ${item.extraction_precision.toFixed(3)}/${item.extraction_recall.toFixed(3)}/${item.extraction_f1.toFixed(3)} | ${item.fact_value_precision.toFixed(3)}/${item.fact_value_recall.toFixed(3)}/${item.fact_value_f1.toFixed(3)} | ${item.negation_accuracy.toFixed(3)} | ${item.false_supported_count} | ${item.missed_fact_count} | ${item.provenance_rate.toFixed(3)} | ${item.retrieval_hit_at_3.toFixed(3)} | ${item.scope_isolation_rate.toFixed(3)} | ${item.mean_required_completeness.toFixed(3)} | ${item.intervention_count} | ${item.unnecessary_interventions} | ${item.mean_latency_ms.toFixed(2)} ms |`);
}
lines.push('', result.decision.rule, '', '> This is a frozen deterministic regression comparison, not real-world accuracy or human Gold.');
await fs.writeFile(path.join(output, 'evidence-pipeline-comparison.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
