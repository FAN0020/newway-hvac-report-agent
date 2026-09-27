import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { renderReportHtml, renderReportPdf } from '../src/export/template-pdf.js';
import { templateFor } from '../web/template-catalog.js';

const report = {
  report_id: 'report_pdf_demo', report_version: 1, template_id: 'bus-preventive-maintenance-inspection',
  template_name: 'Bus Preventive Maintenance / Inspection', template_version: '1.0.0',
  structured_state_hash: 'sha256:demo',
  sections: [
    { title: 'Job identity', content: [
      { field_id: 'work.work_order_id', label: 'Work Order No.', state: 'KNOWN_VALUE', value: 'WO-111-1222', unit: null },
      { field_id: 'asset.internal_fleet_no', label: 'Bus / Fleet ID', state: 'KNOWN_VALUE', value: '8300-354-LONG-IDENTIFIER-WRAPS-SAFELY', unit: null },
      { field_id: 'technician.name', label: 'Technician', state: 'KNOWN_VALUE', value: 'Alex Tan', unit: null },
    ] },
    { title: 'Inspection checklist', content: [
      { field_id: 'check.engine_fluids.status', label: 'Engine and fluids', state: 'KNOWN_VALUE', value: 'OK', unit: null },
      { field_id: 'check.brakes.status', label: 'Brakes', state: 'NOT_APPLICABLE', value: 'Not applicable', unit: null },
    ] },
    { title: 'Completion and handover', content: [
      { field_id: 'inspection_findings', label: 'Defects / findings', state: 'KNOWN_VALUE', value: 'A long but grounded finding that must wrap inside the company-style table without clipping or changing its meaning. '.repeat(8), unit: null },
      { field_id: 'parts.part_number', label: 'Parts used', state: 'EXPLICIT_NONE', value: 'None', unit: null },
      { field_id: 'completion.state', label: 'Final condition', state: 'KNOWN_VALUE', value: 'READY', unit: null },
    ] },
  ],
  disclaimer: { text: 'Prototype report generated from confirmed evidence.' },
};

const confirmation = {
  technician_principal_ref: 'principal:demo-technician', confirmed_at: '2026-09-27T10:42:00.000Z',
  confirmation_id: 'confirmation_demo', validation_ref: 'validation_demo', snapshot_hash: 'sha256:snapshot',
};

test('versioned PDF binding renders a template-specific table layout without collapsing semantic states', () => {
  const template = templateFor(report.template_id);
  const html = renderReportHtml({ report, confirmation, template });
  assert.match(html, /Bus Preventive Maintenance \/ Inspection/u);
  assert.match(html, /Prototype template/u);
  assert.match(html, /WO-111-1222/u);
  assert.match(html, /None/u);
  assert.match(html, /Not applicable/u);
  assert.match(html, /data-template-binding="bus-preventive-maintenance-inspection@1\.0\.0"/u);
  assert.match(html, /data-pdf-layout="bus-preventive-maintenance-inspection\.prototype\.v1"/u);
  assert.match(html, /data-template-source-sha256="86c0935105295f40e35827c4b8ded8411119c447f04e8b8189d79ec9f954c3d7"/u);
  assert.match(html, /Area[\s\S]*Item[\s\S]*Status[\s\S]*Finding \/ Measurement[\s\S]*Action \/ Remarks/u);
  assert.match(html, /Bus_General_PM_Prototype\.docx/u);
  assert.doesNotMatch(html, /Unknown[^<]*OK/iu);
});

test('confirmed snapshot report renders to a real PDF when the local renderer is available', async (t) => {
  const template = templateFor(report.template_id);
  const rendered = await renderReportPdf({ report, confirmation, template });
  assert.equal(rendered.mime_type, 'application/pdf');
  assert.match(rendered.filename, /\.pdf$/u);
  assert.equal(rendered.bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(rendered.bytes.length > 5_000);
  const path = new URL('../.tmp-tests/template-pdf-export.pdf', import.meta.url);
  await fs.mkdir(new URL('../.tmp-tests/', import.meta.url), { recursive: true });
  await fs.writeFile(path, rendered.bytes);
  t.after(() => fs.rm(path, { force: true }));
});
