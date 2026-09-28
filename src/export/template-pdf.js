import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RENDERER_ID = 'template-html-pdf';
const RENDERER_VERSION = '1.0.0';

function escapeHtml(value) {
  return String(value ?? '').replace(/[‐-―]/gu, '-')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function printableValue(item) {
  if (item.state === 'EXPLICIT_NONE') return 'None';
  if (item.state === 'NOT_APPLICABLE') return 'Not applicable';
  if (item.state === 'UNKNOWN') return 'Unknown';
  if (item.value === null || item.value === undefined || item.value === '') return '—';
  const value = typeof item.value === 'object' ? JSON.stringify(item.value) : String(item.value);
  return item.unit ? `${value} ${item.unit}` : value;
}

function safeFilename(value) {
  const normalized = String(value || 'confirmed-report').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `${normalized || 'confirmed-report'}.pdf`;
}

const CHECKLIST_LAYOUTS = Object.freeze({
  'bus-preventive-maintenance-inspection': Object.freeze([{ title: 'Inspection & Maintenance', headers: ['Area', 'Item', 'Status', 'Finding / Measurement', 'Action / Remarks'], slugs: ['engine_fluids', 'brakes', 'tyres', 'electrical', 'passenger_safety', 'post_service'], descriptions: {
    engine_fluids: ['Engine / fluids', 'Oil, filters and fluid condition'], brakes: ['Brakes', 'Brake condition / measurement'], tyres: ['Tyres', 'Pressure / tread condition'], electrical: ['Electrical', 'Lights / horn / alarms'], passenger_safety: ['Passenger safety', 'Doors / exits / accessibility'], post_service: ['Post-service', 'Leaks / noise / warnings'],
  } }]),
  'bus-passenger-door-safety-equipment-inspection': Object.freeze([{ title: 'Inspection', headers: ['Item', 'Status', 'Finding', 'Action'], slugs: ['front_door', 'rear_door', 'door_sensors_interlocks', 'emergency_exits', 'accessibility_equipment', 'warning_alarms'] }]),
  'rail-track-inspection-maintenance': Object.freeze([{ title: 'Inspection', headers: ['System', 'Check', 'Status', 'Measurement / Location', 'Observation / Action'], slugs: ['rail_visual', 'track_geometry', 'fastenings', 'sleepers', 'joints_welds', 'environment'], descriptions: {
    rail_visual: ['Rail', 'Visual condition'], track_geometry: ['Geometry', 'Alignment / level / kink / sagging'], fastenings: ['Fastening', 'Fasteners / clips / bolts'], sleepers: ['Sleepers', 'Sleeper condition'], joints_welds: ['Joints / welds', 'Condition'], environment: ['Environment', 'Drainage / obstruction'],
  } }]),
  'plain-rail-preventive-inspection': Object.freeze([
    { title: 'Safety & Access', headers: ['Check', 'Status', 'Remarks'], slugs: ['qualified_team', 'tools_calibration', 'ppe_toolbox', 'possession_access'] },
    { title: 'Rail Inspection', headers: ['Check', 'Status', 'Location / Measurement', 'Remarks'], slugs: ['general_condition', 'cracks', 'wear', 'joints', 'creep'] },
  ]),
  'conductor-third-rail-preventive-inspection': Object.freeze([
    { title: 'Safety & Access', headers: ['Check', 'Status', 'Remarks'], slugs: ['qualified_team', 'tools_calibration', 'ppe_toolbox', 'possession_access'] },
    { title: 'Inspection', headers: ['Item', 'Status', 'Measurement / Location', 'Observation / Action'], slugs: ['conductor_rail', 'supports_insulators', 'fastenings', 'alignment_clearance', 'expansion_joints', 'arcing_overheating'] },
  ]),
});

const STANDARD_LAYOUTS = Object.freeze({
  'bus-preventive-maintenance-inspection': [['Identity / Context', ['Job identity']], ['Completion', ['Completion and handover']]],
  'bus-defect-rectification-corrective-maintenance': [['Identity / Context', ['Job identity']], ['Defect & Diagnosis', ['Diagnosis']], ['Work & Handover', ['Rectification', 'Completion and handover']]],
  'bus-passenger-door-safety-equipment-inspection': [['Identity / Context', ['Job identity']], ['Reported Work Scope', ['Inspection checklist']], ['Completion', ['Completion and handover']]],
  'rail-track-inspection-maintenance': [['Identity / Context', ['Job identity']], ['Completion', ['Completion and handover']]],
  'plain-rail-preventive-inspection': [['Identity / Context', ['Job identity']], ['Completion', ['Completion and handover']]],
  'conductor-third-rail-preventive-inspection': [['Identity / Context', ['Job identity']], ['Completion', ['Completion and handover']]],
  'rail-maintenance-completion-handover': [['Identity / Context', ['Job identity']], ['Work Summary', ['Maintenance record']], ['Handover', ['Completion and handover']]],
});

function reportFieldMap(report) {
  return new Map((report.sections || []).flatMap((section) => section.content || []).map((item) => [item.field_id, item]));
}

function valuesForDefinition(definition, fields, definitions) {
  const explicitlyPlaced = new Set(definitions.filter((item) => !item.id.endsWith('.*')).map((item) => item.id));
  const repeated = definition.id.endsWith('.*')
    ? [...fields.entries()].filter(([id]) => id !== definition.id
      && id.startsWith(definition.id.slice(0, -1))
      && !explicitlyPlaced.has(id)).map(([, item]) => printableValue(item))
    : [];
  const values = definition.id.endsWith('.*')
    ? repeated.length ? repeated : [printableValue(fields.get(definition.id) || { state: 'UNKNOWN' })]
    : [printableValue(fields.get(definition.id) || { state: 'UNKNOWN' })];
  return values.join('; ');
}

function renderStandardTable(title, definitions, fields, allDefinitions = definitions) {
  if (!definitions.length) return '';
  const rows = definitions.map((definition) => `
      <tr><td class="label">${escapeHtml(definition.label)}</td><td>${escapeHtml(valuesForDefinition(definition, fields, allDefinitions))}</td><td class="required">${definition.required ? 'Yes' : 'Optional'}</td></tr>`).join('');
  return `<section><h2>${escapeHtml(title)}</h2><table class="template-table cols-3"><thead><tr><th>Field</th><th>Value</th><th>Required</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function checklistDefinition(template, slug, role) {
  return template.schema.fields.find((definition) => definition.id === `check.${slug}.${role}`);
}

function checklistValue(fields, slug, role) {
  const item = fields.get(`check.${slug}.${role}`);
  return item ? printableValue(item) : role === 'status' ? 'Unknown' : '';
}

function renderChecklist(group, template, fields) {
  const rows = group.slugs.map((slug) => {
    const status = checklistDefinition(template, slug, 'status');
    if (!status) return '';
    const description = group.descriptions?.[slug] || [status.label];
    const trailing = group.headers.length === 3
      ? [checklistValue(fields, slug, 'status'), [checklistValue(fields, slug, 'observation'), checklistValue(fields, slug, 'action')].filter(Boolean).join(' / ')]
      : group.headers.length === 4
        ? [checklistValue(fields, slug, 'status'), checklistValue(fields, slug, 'observation'), checklistValue(fields, slug, 'action')]
        : [checklistValue(fields, slug, 'status'), checklistValue(fields, slug, 'observation'), checklistValue(fields, slug, 'action')];
    return `<tr>${[...description, ...trailing].map((value, index) => `<td${index < description.length ? ' class="label"' : ''}>${escapeHtml(value)}</td>`).join('')}</tr>`;
  }).join('');
  return `<section><h2>${escapeHtml(group.title)}</h2><table class="template-table cols-${group.headers.length}"><thead><tr>${group.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderTemplateSections(report, template) {
  const fields = reportFieldMap(report);
  const definitions = template.schema?.fields || [];
  const standardGroups = STANDARD_LAYOUTS[template.templateId]
    || [...new Set(definitions.map((definition) => definition.section))].map((section) => [section, [section]]);
  const standard = standardGroups.map(([title, sectionNames]) => renderStandardTable(
    title,
    definitions.filter((definition) => sectionNames.includes(definition.section) && !definition.id.startsWith('check.')),
    fields,
    definitions,
  ));
  const checklists = (CHECKLIST_LAYOUTS[template.templateId] || []).map((group) => renderChecklist(group, template, fields));
  if (!checklists.length) return standard.join('');
  return [standard[0], ...checklists, ...standard.slice(1)].join('');
}

export function renderReportHtml({ report, confirmation, template } = {}) {
  if (!report || !confirmation || !template) throw new TypeError('Report, confirmation, and template are required.');
  const binding = `${template.templateId}@${template.templateVersion}`;
  const pdfLayout = template.rendererMapping?.pdfLayout || `${template.templateId}.generic.v1`;
  const organization = template.presentation?.organizationLabel || 'Field Service';
  const notice = template.provenance?.notice || 'Prototype template.';
  const sections = renderTemplateSections(report, template);
  return `<!doctype html>
<html lang="en" data-template-binding="${escapeHtml(binding)}" data-pdf-layout="${escapeHtml(pdfLayout)}" data-template-source-sha256="${escapeHtml(template.sourceArtifact?.sha256 || '')}" data-renderer-binding="${RENDERER_ID}@${RENDERER_VERSION}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(report.template_name || template.name)}</title>
  <style>
    @page { size: A4; margin: 13mm 12mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #18352e; font: 10.2pt/1.35 Arial, "Noto Sans CJK SC", "PingFang SC", sans-serif; }
    header { border-bottom: 3px solid #0d4436; margin-bottom: 7mm; padding-bottom: 4mm; }
    .eyebrow { color: #e86532; font-size: 8pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
    h1 { font-size: 20pt; line-height: 1.12; margin: 2mm 0 1mm; overflow-wrap: anywhere; }
    .org { color: #49645d; font-size: 10pt; }
    .notice { background: #fff4e9; border-left: 3px solid #e86532; color: #7a481f; margin: 4mm 0 0; padding: 2.5mm 3mm; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 2mm 6mm; margin: 0 0 6mm; }
    .meta div { border-bottom: 1px solid #cfd9d5; padding: 1.5mm 0; overflow-wrap: anywhere; }
    .meta b { color: #60766f; display: block; font-size: 7.5pt; letter-spacing: .05em; text-transform: uppercase; }
    section { break-inside: avoid; margin: 0 0 5mm; }
    h2 { background: #0d4436; color: #fff; font-size: 11pt; margin: 0; padding: 2.3mm 3mm; }
    table { border-collapse: collapse; table-layout: fixed; width: 100%; }
    th, td { border: 1px solid #cfd9d5; padding: 2.4mm 3mm; text-align: left; vertical-align: top; overflow-wrap: anywhere; white-space: pre-wrap; }
    th { background: #e7eee9; color: #294d42; font-size: 8.3pt; }
    td { font-size: 8.8pt; }
    td.label { background: #f6f8f7; color: #48625a; font-weight: 700; }
    td.required { color: #647970; font-size: 7.5pt; width: 16%; }
    .cols-3 th:nth-child(1), .cols-3 td:nth-child(1) { width: 32%; }
    .cols-3 th:nth-child(2), .cols-3 td:nth-child(2) { width: 52%; }
    .cols-3 th:nth-child(3), .cols-3 td:nth-child(3) { width: 16%; }
    .cols-4 th, .cols-4 td { width: 25%; }
    .cols-5 th:nth-child(1), .cols-5 td:nth-child(1) { width: 16%; }
    .cols-5 th:nth-child(2), .cols-5 td:nth-child(2) { width: 24%; }
    .cols-5 th:nth-child(3), .cols-5 td:nth-child(3) { width: 15%; }
    .cols-5 th:nth-child(4), .cols-5 td:nth-child(4), .cols-5 th:nth-child(5), .cols-5 td:nth-child(5) { width: 22.5%; }
    footer { border-top: 1px solid #9fb0aa; color: #536a62; font-size: 8pt; margin-top: 7mm; padding-top: 3mm; }
    .binding { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 7pt; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">${escapeHtml(organization)} · Confirmed ServiceScribe report</div>
    <h1>${escapeHtml(report.template_name || template.name)}</h1>
    <div class="org">${escapeHtml(template.presentation?.reportFamily || '')}</div>
    <div class="notice">${escapeHtml(notice)} ${escapeHtml(report.disclaimer?.text || '')}</div>
  </header>
  <div class="meta">
    <div><b>Report version</b>${escapeHtml(report.report_version ?? 1)}</div>
    <div><b>Template version</b>${escapeHtml(template.templateVersion)}</div>
    <div><b>Confirmed by</b>${escapeHtml(confirmation.technician_name || confirmation.technician_principal_ref)}</div>
    <div><b>Confirmed at</b>${escapeHtml(confirmation.confirmed_at)}</div>
  </div>
  ${sections}
  <footer>
    <div>Generated only from the confirmed structured report snapshot.</div>
    <div class="binding">Template: ${escapeHtml(template.sourceArtifact?.filename || binding)} · Confirmation: ${escapeHtml(confirmation.confirmation_id)} · Snapshot: ${escapeHtml(confirmation.snapshot_hash)}</div>
  </footer>
</body>
</html>`;
}

async function availableBrowser(explicit) {
  const candidates = [
    explicit,
    process.env.REPORT_PDF_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next deterministic local renderer path.
    }
  }
  throw Object.assign(new Error('A local Chrome/Chromium PDF renderer is not available.'), { code: 'PDF_RENDERER_UNAVAILABLE', status: 503 });
}

export async function renderReportPdf({ report, confirmation, template, browserPath } = {}) {
  const html = renderReportHtml({ report, confirmation, template });
  const browser = await availableBrowser(browserPath);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'field-report-pdf-'));
  const htmlPath = path.join(temporary, 'report.html');
  const pdfPath = path.join(temporary, 'report.pdf');
  try {
    await fs.writeFile(htmlPath, html, { mode: 0o600 });
    await execFileAsync(browser, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`, '--print-to-pdf-no-header', pathToFileURL(htmlPath).href,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const bytes = await fs.readFile(pdfPath);
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw Object.assign(new Error('The local renderer did not produce a valid PDF.'), { code: 'INVALID_PDF_EXPORT', status: 500 });
    }
    return Object.freeze({
      bytes,
      filename: safeFilename(report.template_id || template.templateId),
      mime_type: 'application/pdf',
      renderer_id: RENDERER_ID,
      renderer_version: RENDERER_VERSION,
      template_binding: `${template.templateId}@${template.templateVersion}`,
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
