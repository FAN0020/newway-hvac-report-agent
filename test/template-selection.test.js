import assert from 'node:assert/strict';
import test from 'node:test';

import { listPredefinedTemplates } from '../web/template-catalog.js';
import {
  recentTechnicianTemplates,
  selectTechnicianTemplates,
  technicianTemplateProjection,
} from '../web/template-selection.js';

test('technician projection exposes only human-facing catalog metadata', () => {
  const template = listPredefinedTemplates().find((item) => item.templateId === 'rail-track-inspection-maintenance');
  const projected = technicianTemplateProjection(template);

  assert.deepEqual(Object.keys(projected).sort(), [
    'category', 'description', 'displayName', 'organizationLabel', 'reportFamily', 'searchAliases', 'templateId',
  ]);
  assert.equal(projected.displayName, 'Rail Track Inspection / Maintenance');
  assert.equal(projected.organizationLabel, 'SBS Transit');
  assert.equal(projected.category, 'Rail');
  assert.equal(projected.reportFamily, 'Track inspection');
  assert.equal('templateVersion' in projected, false);
  assert.equal('provenance' in projected, false);
  assert.equal('schema' in projected, false);
  assert.equal('contextCorpus' in projected, false);
});

test('technician catalog contains published allowed templates only', () => {
  const templates = listPredefinedTemplates();
  templates.push({ ...templates[0], templateId: 'draft', status: 'DRAFT' });
  templates.push({ ...templates[0], templateId: 'manager-only', presentation: { ...templates[0].presentation, technicianVisible: false } });

  const selected = selectTechnicianTemplates(templates);
  assert.equal(selected.length, 8);
  assert.equal(selected.some((item) => item.templateId === 'draft'), false);
  assert.equal(selected.some((item) => item.templateId === 'manager-only'), false);
});

test('predefined templates explicitly bind report-history identity fields', () => {
  for (const template of listPredefinedTemplates()) {
    assert.equal(typeof template.historySummary, 'object', template.templateId);
    assert.equal(Array.isArray(template.historySummary.workOrderFields), true, template.templateId);
    assert.equal(Array.isArray(template.historySummary.assetFields), true, template.templateId);
    assert.equal(Array.isArray(template.historySummary.serviceDateFields), true, template.templateId);
    assert.equal(Array.isArray(template.historySummary.technicianFields), true, template.templateId);
  }
  const bus = listPredefinedTemplates().find((item) => item.domain === 'SBS_BUS');
  assert.deepEqual(bus.historySummary, {
    workOrderFields: ['work.work_order_id'],
    assetFields: ['asset.internal_fleet_no', 'asset.registration_no', 'asset.bus_model'],
    serviceDateFields: ['work.date_time'],
    technicianFields: ['technician.name'],
  });
});

test('search matches display name, organization, domain, family, description, and aliases', () => {
  const templates = listPredefinedTemplates();
  assert.equal(selectTechnicianTemplates(templates, { query: 'Newway' }).length, 1);
  assert.equal(selectTechnicianTemplates(templates, { query: 'SBS Transit' }).length, 7);
  assert.equal(selectTechnicianTemplates(templates, { query: 'SBS_RAIL' }).length, 4);
  assert.equal(selectTechnicianTemplates(templates, { query: 'Track inspection' }).length, 1);
  assert.equal(selectTechnicianTemplates(templates, { query: 'reported bus defect' }).length, 1);
  assert.equal(selectTechnicianTemplates(templates, { query: 'third rail' })[0].templateId, 'conductor-third-rail-preventive-inspection');
});

test('category filters are optional and combine with search', () => {
  const templates = listPredefinedTemplates();
  assert.equal(selectTechnicianTemplates(templates, { category: 'All' }).length, 8);
  assert.equal(selectTechnicianTemplates(templates, { category: 'Bus' }).length, 3);
  assert.equal(selectTechnicianTemplates(templates, { category: 'Rail' }).length, 4);
  assert.equal(selectTechnicianTemplates(templates, { category: 'HVAC' }).length, 1);
  assert.deepEqual(selectTechnicianTemplates(templates, { category: 'Rail', query: 'handover' }).map((item) => item.templateId), [
    'rail-track-inspection-maintenance',
    'rail-maintenance-completion-handover',
  ]);
});

test('recent templates reflect actual unique session history and never fabricate entries', () => {
  const templates = listPredefinedTemplates();
  assert.deepEqual(recentTechnicianTemplates(templates, []), []);
  assert.deepEqual(recentTechnicianTemplates(templates, ['missing-template']), []);
  assert.deepEqual(recentTechnicianTemplates(templates, [
    'rail-track-inspection-maintenance',
    'bus-preventive-maintenance-inspection',
    'rail-track-inspection-maintenance',
  ]).map((item) => item.templateId), [
    'rail-track-inspection-maintenance',
    'bus-preventive-maintenance-inspection',
  ]);
});

test('catalog selection stays deterministic at 100 templates', () => {
  const source = listPredefinedTemplates()[0];
  const templates = Array.from({ length: 100 }, (_, index) => ({
    ...source,
    templateId: `scaled-${String(index + 1).padStart(3, '0')}`,
    name: `Scaled maintenance report ${String(index + 1).padStart(3, '0')}`,
    presentation: {
      ...source.presentation,
      displayName: `Scaled maintenance report ${String(index + 1).padStart(3, '0')}`,
      searchAliases: [`scale-${index + 1}`],
    },
  }));

  assert.equal(selectTechnicianTemplates(templates).length, 100);
  assert.deepEqual(selectTechnicianTemplates(templates, { query: 'scale-99' }).map((item) => item.templateId), ['scaled-099']);
});
