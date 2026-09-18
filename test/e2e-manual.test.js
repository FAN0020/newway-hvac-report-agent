import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/storage/artifacts.js';
import { ReportStore } from '../src/storage/reports.js';
import { confirmReportDraft } from '../src/tools/confirm-report-draft.js';
import { candidateBundleHash } from '../src/tools/correction-integrity.js';
import { exportConfirmedReport } from '../src/tools/export-confirmed-report.js';
import { extractServiceFacts } from '../src/tools/extract-service-facts.js';
import { generateReportDraft } from '../src/tools/generate-report-draft.js';
import { buildTranscriptCorrectionCandidates, retrieveReportTemplate } from '../src/tools/hvac-knowledge.js';
import { planReportSections } from '../src/tools/plan-report-sections.js';
import { saveConfirmedReport } from '../src/tools/save-confirmed-report.js';
import { validateReportDraft } from '../src/tools/validate-report-draft.js';
import { validateReportInput } from '../src/tools/validate-report-input.js';

const root = path.resolve('.tmp-tests', 'manual-e2e');

test('manual transcript completes the direct-function report workflow and cleans its artifacts', async (t) => {
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore({ root });
  const reports = new ReportStore({ root });
  const transcript = await artifacts.putManualTranscript({
    raw_text: '客户反映不制冷。检查发现运行电容损坏。更换了一个35微法电容。试机运行正常。问题已解决。建议下次保养清洗滤网。',
  });
  const knowledge = await buildTranscriptCorrectionCandidates({ rawText: transcript.raw_text });
  const correctionReceipt = await artifacts.putCorrectionReceipt({
    transcriptArtifactId: transcript.artifact_id,
    knowledgeVersion: knowledge.knowledge_version,
    candidates: knowledge.candidates,
    candidatesHash: candidateBundleHash({ transcriptArtifactId: transcript.artifact_id, rawText: transcript.raw_text, knowledgeVersion: knowledge.knowledge_version, candidates: knowledge.candidates }),
    decisions: [],
    technicianId: 'DEMO-001',
    technicianName: '黑客松演示技师',
  });
  const extracted = await extractServiceFacts({ transcript: { ...transcript, raw_text: correctionReceipt.final_text }, correctionReceipt, traceId: 'trace_e2e_extract' });
  const factsReceipt = await artifacts.putFacts({ correctionReceipt, facts: extracted.data.facts });
  const input = await validateReportInput({ facts: factsReceipt.facts, traceId: 'trace_e2e_input' });
  assert.equal(input.status, 'PASS');
  const plan = await planReportSections({ facts: factsReceipt.facts, traceId: 'trace_e2e_plan' });
  const template = await retrieveReportTemplate({ traceId: 'trace_e2e_template' });
  const generated = await generateReportDraft({ facts: factsReceipt.facts, plan: plan.data, template: template.data.template, traceId: 'trace_e2e_generate' });
  const validation = await validateReportDraft({ draft: generated.data.draft, facts: factsReceipt.facts, traceId: 'trace_e2e_validator' });
  assert.equal(validation.status, 'PASS');
  await reports.recordValidation({ draft: generated.data.draft, validation, factsReceipt });
  const confirmed = await confirmReportDraft({ draft: generated.data.draft, validatorRunId: validation.trace_id, technicianId: 'DEMO-001', technicianName: '黑客松演示技师', store: reports, traceId: 'trace_e2e_confirm' });
  assert.equal(confirmed.status, 'PASS');
  const confirmationToken = confirmed.data.confirmation.confirmation_token;
  const saved = await saveConfirmedReport({ draft: generated.data.draft, confirmationToken, store: reports, traceId: 'trace_e2e_save' });
  const exported = await exportConfirmedReport({ draft: generated.data.draft, confirmationToken, store: reports, traceId: 'trace_e2e_export' });
  assert.equal(saved.status, 'PASS');
  assert.equal(exported.status, 'PASS');
  assert.ok(path.resolve(saved.data.file).startsWith(`${root}${path.sep}`));
  assert.ok(path.resolve(exported.data.file).startsWith(`${root}${path.sep}`));
  const official = JSON.parse(await fs.readFile(saved.data.file, 'utf8'));
  assert.equal(official.confirmation.facts_receipt_id, factsReceipt.facts_receipt_id);
  assert.equal(official.confirmation.correction_receipt_id, correctionReceipt.correction_receipt_id);
  assert.match(await fs.readFile(exported.data.file, 'utf8'), /黑客松演示技师/);
});
