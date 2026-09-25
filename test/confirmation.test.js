import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ReportStore } from '../src/storage/reports.js';
import { confirmReportDraft } from '../src/tools/confirm-report-draft.js';
import { exportConfirmedReport } from '../src/tools/export-confirmed-report.js';
import { extractServiceFacts } from '../src/tools/extract-service-facts.js';
import { generateReportDraft } from '../src/tools/generate-report-draft.js';
import { retrieveReportTemplate } from '../src/tools/hvac-knowledge.js';
import { planReportSections } from '../src/tools/plan-report-sections.js';
import { saveConfirmedReport } from '../src/tools/save-confirmed-report.js';
import { validateReportDraft } from '../src/tools/validate-report-draft.js';

const root = path.resolve('.tmp-tests', 'confirmation');

async function validDraft() {
  const raw = '客户反映不制冷。检查发现运行电容损坏。更换了一个35微法电容。试机运行正常。问题已解决。';
  const extracted = await extractServiceFacts({ transcript: { artifact_id: 'transcript_confirmation', raw_text: raw }, traceId: 'trace_extract_confirmation' });
  const plan = await planReportSections({ facts: extracted.data.facts, traceId: 'trace_plan_confirmation' });
  const template = await retrieveReportTemplate({ traceId: 'trace_template_confirmation' });
  const generated = await generateReportDraft({ facts: extracted.data.facts, plan: plan.data, template: template.data.template, traceId: 'trace_generate_confirmation' });
  const validation = await validateReportDraft({ draft: generated.data.draft, facts: extracted.data.facts, traceId: 'trace_validator_confirmation' });
  return { draft: generated.data.draft, validation };
}

test('official writes require a current technician confirmation and are idempotent', async (t) => {
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReportStore({ root });
  const { draft, validation } = await validDraft();
  assert.equal(validation.status, 'PASS');
  await store.recordValidation({ draft, validation, factsReceipt: {
    facts_receipt_id: `facts_${'a'.repeat(24)}`,
    facts_hash: `sha256:${'b'.repeat(64)}`,
    correction_receipt_id: `correction_${'c'.repeat(24)}`,
    correction_receipt_hash: `sha256:${'d'.repeat(64)}`,
  } });

  const unconfirmed = await saveConfirmedReport({ draft, confirmationToken: '', store, traceId: 'trace_unconfirmed' });
  assert.equal(unconfirmed.status, 'FAIL');

  const confirmed = await confirmReportDraft({
    draft, validatorRunId: validation.trace_id, technicianId: 'TECH-007', technicianName: '陈师傅', store, traceId: 'trace_confirm',
  });
  assert.equal(confirmed.status, 'PASS');
  const token = confirmed.data.confirmation.confirmation_token;
  assert.equal(confirmed.data.confirmation.report_hash, validation.data.report_hash);
  assert.equal(confirmed.data.confirmation.schema_id, 'hvac_service');
  assert.equal(confirmed.data.confirmation.schema_version, '1');
  assert.equal(confirmed.data.confirmation.report_session_id, draft.report_session_id);
  assert.equal(confirmed.data.confirmation.structured_state_hash, draft.structured_state_hash);

  const saved = await saveConfirmedReport({ draft, confirmationToken: token, store, traceId: 'trace_save' });
  const savedAgain = await saveConfirmedReport({ draft, confirmationToken: token, store, traceId: 'trace_save_again' });
  assert.equal(saved.status, 'PASS');
  assert.equal(saved.data.reused, false);
  assert.equal(savedAgain.data.reused, true);
  assert.equal(savedAgain.data.file, saved.data.file);

  const exported = await exportConfirmedReport({ draft, confirmationToken: token, store, traceId: 'trace_export' });
  const exportedAgain = await exportConfirmedReport({ draft, confirmationToken: token, store, traceId: 'trace_export_again' });
  assert.equal(exported.status, 'PASS');
  assert.match(exported.data.copyable_text, /陈师傅/);
  assert.equal(exportedAgain.data.reused, true);

  const tampered = structuredClone(draft);
  tampered.sections[0].items[0].text = '被修改的内容';
  const stale = await saveConfirmedReport({ draft: tampered, confirmationToken: token, store, traceId: 'trace_stale' });
  assert.equal(stale.status, 'FAIL');
  assert.equal(stale.error_code, 'STALE_CONFIRMATION');
});

test('different confirmations of the same report have distinct official artifact identities', async (t) => {
  const collisionRoot = path.resolve('.tmp-tests', 'confirmation-identities');
  await fs.rm(collisionRoot, { recursive: true, force: true });
  t.after(() => fs.rm(collisionRoot, { recursive: true, force: true }));
  const store = new ReportStore({ root: collisionRoot });
  const { draft, validation } = await validDraft();
  await store.recordValidation({ draft, validation, factsReceipt: {
    facts_receipt_id: `facts_${'1'.repeat(24)}`,
    facts_hash: `sha256:${'2'.repeat(64)}`,
    correction_receipt_id: `correction_${'3'.repeat(24)}`,
    correction_receipt_hash: `sha256:${'4'.repeat(64)}`,
  } });

  const first = await confirmReportDraft({
    draft, validatorRunId: validation.trace_id, technicianId: 'TECH-1', technicianName: 'Alex', store, traceId: 'trace_confirm_first',
  });
  const second = await confirmReportDraft({
    draft, validatorRunId: validation.trace_id, technicianId: 'TECH-2', technicianName: 'Blair', store, traceId: 'trace_confirm_second',
  });
  const firstSave = await saveConfirmedReport({ draft, confirmationToken: first.data.confirmation.confirmation_token, store, traceId: 'trace_save_first' });
  const secondSave = await saveConfirmedReport({ draft, confirmationToken: second.data.confirmation.confirmation_token, store, traceId: 'trace_save_second' });
  const firstExport = await exportConfirmedReport({ draft, confirmationToken: first.data.confirmation.confirmation_token, store, traceId: 'trace_export_first' });
  const secondExport = await exportConfirmedReport({ draft, confirmationToken: second.data.confirmation.confirmation_token, store, traceId: 'trace_export_second' });

  assert.equal(firstSave.status, 'PASS');
  assert.equal(secondSave.status, 'PASS');
  assert.notEqual(firstSave.data.file, secondSave.data.file);
  assert.notEqual(firstExport.data.file, secondExport.data.file);
  assert.match(await fs.readFile(firstSave.data.file, 'utf8'), /Alex/);
  assert.match(await fs.readFile(secondSave.data.file, 'utf8'), /Blair/);
});
