import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const template = {
  schema: {
    fields: [
      { id: 'work.order', label: 'Work order', section: 'Job identity' },
      { id: 'inspection.findings', label: 'Inspection findings', section: 'Inspection' },
      { id: 'work.performed', label: 'Work performed', section: 'Work' },
      { id: 'completion.state', label: 'Completion status', section: 'Completion', critical: true },
    ],
  },
};

function field(fieldId, state, value, candidateId = null) {
  return {
    field_id: fieldId,
    state,
    value,
    unit: null,
    selected_candidate_ids: candidateId ? [candidateId] : [],
    active_candidate_ids: candidateId ? [candidateId] : [],
    candidates: candidateId ? [{
      candidate_id: candidateId,
      support_type: 'TRANSCRIPT_EVIDENCE',
      claim: { kind: 'VALUE', value },
      extraction: { method: 'deterministic-rule', version: 'test' },
      evidence_refs: [{ evidence_id: 'transcript_1', span_id: `span_${candidateId}` }],
    }] : [],
  };
}

function agent(reportFields, completeness = {}) {
  return {
    report_fields: reportFields,
    resolution_queue: [],
    validation_issues: [],
    completeness: {
      complete: false,
      complete_fields: [],
      missing_required_fields: [],
      missing_optional_fields: [],
      uncertain_fields: [],
      conflicting_fields: [],
      invalid_fields: [],
      inferred_fields: [],
      conditional_required_fields: [],
      critical_confirmation_fields: [],
      blocking_issue_ids: [],
      ...completeness,
    },
  };
}

test('one authoritative correction result produces one compact multi-field change summary', async () => {
  const workspaceView = await import('../web/report-workspace-view.js');
  assert.equal(typeof workspaceView.deriveChangeSummary, 'function');

  const before = agent([
    field('work.order', 'KNOWN_VALUE', 'WO-100', 'work-before'),
    field('inspection.findings', 'UNKNOWN', null),
    field('work.performed', 'UNKNOWN', null),
    field('completion.state', 'UNKNOWN', null),
  ]);
  const after = agent([
    field('work.order', 'KNOWN_VALUE', 'WO-100', 'work-before'),
    field('inspection.findings', 'KNOWN_VALUE', 'Loose terminal found', 'finding-after'),
    field('work.performed', 'KNOWN_VALUE', 'Terminal reseated', 'work-after'),
    field('completion.state', 'UNCERTAIN', 'READY', 'completion-after'),
  ], {
    complete_fields: ['work.order', 'inspection.findings', 'work.performed'],
    uncertain_fields: ['completion.state'],
    blocking_issue_ids: ['issue_completion'],
  });

  assert.deepEqual(workspaceView.deriveChangeSummary({ template, before, after }), {
    count: 3,
    summary: 'Updated 3 details',
    field_ids: ['inspection.findings', 'work.performed', 'completion.state'],
    field_names: ['Inspection findings', 'Work performed', 'Completion status'],
    remaining: {
      missing: [],
      review: ['Completion status'],
    },
  });
});

test('change comparison ignores unrelated fields and unchanged selected values', async () => {
  const { deriveChangeSummary } = await import('../web/report-workspace-view.js');
  const before = agent([
    field('work.order', 'KNOWN_VALUE', 'WO-100', 'work-before'),
    field('inspection.findings', 'KNOWN_VALUE', 'Loose terminal', 'finding-before'),
  ]);
  const after = agent([
    field('work.order', 'KNOWN_VALUE', 'WO-100', 'work-before'),
    field('inspection.findings', 'KNOWN_VALUE', 'Burnt terminal', 'finding-after'),
  ]);

  assert.deepEqual(deriveChangeSummary({ template, before, after }).field_ids, ['inspection.findings']);
});

test('workspace projection marks only authoritative changed rows as Updated', async () => {
  const { deriveWorkspaceView } = await import('../web/report-workspace-view.js');
  const current = agent([
    field('work.order', 'KNOWN_VALUE', 'WO-100', 'work-before'),
    field('inspection.findings', 'KNOWN_VALUE', 'Burnt terminal', 'finding-after'),
    field('work.performed', 'UNKNOWN', null),
    field('completion.state', 'UNKNOWN', null),
  ], {
    complete_fields: ['work.order', 'inspection.findings'],
    missing_required_fields: ['work.performed', 'completion.state'],
    blocking_issue_ids: ['issue_work', 'issue_completion'],
  });
  const result = deriveWorkspaceView({
    template,
    session: { session_id: 'session_1', revision: 3, phase: 'RESOLVE' },
    agent_state: current,
    change_summary: {
      count: 1,
      summary: 'Updated 1 detail',
      field_ids: ['inspection.findings'],
      field_names: ['Inspection findings'],
      remaining: { missing: ['Work performed', 'Completion status'], review: [] },
    },
  });
  const rows = result.report_sections.flatMap((section) => section.fields);

  assert.equal(result.latest_change.summary, 'Updated 1 detail');
  assert.equal(rows.find((row) => row.field_id === 'inspection.findings').updated, true);
  assert.equal(rows.find((row) => row.field_id === 'work.order').updated, false);
});

test('completed critical fields do not create a second per-field review count', async () => {
  const { deriveWorkspaceView } = await import('../web/report-workspace-view.js');
  const current = agent([
    field('work.order', 'KNOWN_VALUE', 'WO-100', 'work-order'),
    field('inspection.findings', 'KNOWN_VALUE', 'Loose terminal', 'finding'),
    field('work.performed', 'KNOWN_VALUE', 'Terminal reseated', 'work'),
    field('completion.state', 'KNOWN_VALUE', 'READY', 'completion'),
  ], {
    complete: true,
    complete_fields: ['work.order', 'inspection.findings', 'work.performed', 'completion.state'],
  });

  const result = deriveWorkspaceView({
    template,
    session: { session_id: 'session_1', revision: 4, phase: 'REVIEW' },
    agent_state: current,
  });

  assert.deepEqual(result.report_sections.map((section) => section.status), ['Complete', 'Complete', 'Complete', 'Complete']);
  assert.deepEqual(result.report_sections.map((section) => section.review_priority), [0, 0, 0, 0]);
});

test('field provenance is secondary inside Edit and ordinary values have no Accept action', async () => {
  const client = await fs.readFile('web/template-app.js', 'utf8');
  const renderField = client.slice(client.indexOf('function renderField('), client.indexOf('function renderReportSections('));
  const renderEditor = client.slice(client.indexOf('function renderFieldEditor('), client.indexOf('function renderField('));
  const editorFooter = client.slice(client.indexOf('function appendFieldEditorFooter('), client.indexOf('function renderInlineResolution('));

  assert.doesNotMatch(renderField, /button\('Source'/u);
  assert.doesNotMatch(renderField, /field-source/u);
  assert.match(renderEditor, /AI draft/u);
  assert.match(renderEditor, /Original words/u);
  assert.match(renderEditor, /My edit/u);
  assert.match(renderEditor, /appendFieldEditorFooter\(editor, field\)/u);
  assert.match(editorFooter, /Source details/u);
  assert.doesNotMatch(client, /button\(['"]Accept['"]/u);
});

test('Submit report opens one report-level confirmation before the server confirm command', async () => {
  const [client, html] = await Promise.all([
    fs.readFile('web/template-app.js', 'utf8'),
    fs.readFile('web/index.html', 'utf8'),
  ]);

  assert.match(html, /You confirm that you have reviewed the report and it accurately reflects the completed work\./u);
  assert.match(html, />Back to report</u);
  assert.match(html, />Confirm &amp; submit</u);
  assert.match(client, /function openReportConfirmation/u);
  assert.match(client, /function confirmAndSubmitReport/u);
  assert.match(client, /button\('Submit report', 'primary', openReportConfirmation\)/u);
  assert.doesNotMatch(client, /button\('Submit report', 'primary', submitReport\)/u);
});
