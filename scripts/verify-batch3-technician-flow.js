import { spawnSync } from 'node:child_process';

const checks = [
  { name: 'HTTP ReportSession 20/8/6/2 capture and answers', file: 'test/authoritative-capture-server.test.js', pattern: '20-field report immediately' },
  { name: 'HTTP model source plan keeps knowledge out of job facts', file: 'test/authoritative-capture-server.test.js', pattern: 'HTTP source plan accepts' },
  { name: 'Technician checklist, questions, and source advice', file: 'test/report-workspace-view.test.js', pattern: 'technician view shows' },
  { name: 'Manager-bounded model source planning and fallback', file: 'test/source-plan.test.js' },
  { name: 'Technician UI route and control contract', file: 'test/template-ui-contract.test.js' },
];

for (const check of checks) {
  process.stdout.write(`\n${check.name}\n`);
  const args = ['--test', ...(check.pattern ? [`--test-name-pattern=${check.pattern}`] : []), check.file];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write('\nBatch 3 local acceptance passed. Browser and real-model checks require separate runs.\n');
