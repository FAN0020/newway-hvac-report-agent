import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREDEFINED_TEMPLATE_IDS,
  listPredefinedTemplates,
  templateFor,
  mapFactsForTemplate,
} from '../web/template-catalog.js';
import { createReportSession, evaluateCompleteness, mapFactsToStructuredState } from '../web/report-runtime.js';

const EXPECTED = new Map([
  ['hvac-service-report', 'HVAC Service Report'],
  ['bus-preventive-maintenance-inspection', 'Bus Preventive Maintenance / Inspection'],
  ['bus-defect-rectification-corrective-maintenance', 'Bus Defect Rectification / Corrective Maintenance'],
  ['bus-passenger-door-safety-equipment-inspection', 'Bus Passenger Door / Safety Equipment Inspection'],
  ['rail-track-inspection-maintenance', 'Rail Track Inspection / Maintenance'],
  ['plain-rail-preventive-inspection', 'Plain Rail Preventive Inspection'],
  ['conductor-third-rail-preventive-inspection', 'Conductor / Third-Rail Preventive Inspection'],
  ['rail-maintenance-completion-handover', 'Rail Maintenance Completion / Handover'],
]);

test('catalog registers HVAC and every required SBS prototype through one immutable contract', () => {
  const templates = listPredefinedTemplates();
  assert.deepEqual(new Set(PREDEFINED_TEMPLATE_IDS), new Set(EXPECTED.keys()));
  assert.equal(templates.length, EXPECTED.size);
  for (const item of templates) {
    assert.equal(item.name, EXPECTED.get(item.templateId));
    assert.ok(item.templateVersion);
    assert.ok(item.schema.id && item.schema.version);
    assert.ok(item.contextCorpus.id && item.contextCorpus.version);
    assert.ok(item.rendererMapping.id && item.rendererMapping.version);
    assert.ok(item.sourceArtifact.filename && /^[a-f0-9]{64}$/u.test(item.sourceArtifact.sha256));
    assert.ok(['user-supplied prototype', 'research-derived prototype'].includes(item.provenance.classification));
    assert.equal(item.provenance.official, false);
    assert.ok(item.schema.fields.length > 4);
  }
});

test('prototype schemas carry explicit review and rendering policies', () => {
  for (const item of listPredefinedTemplates()) {
    const orders = item.schema.fields.map((field) => field.displayOrder);
    assert.equal(new Set(orders).size, orders.length, `${item.templateId} display order must be unique`);
    for (const field of item.schema.fields) {
      assert.ok(field.id && field.label && field.section && field.type);
      assert.equal(typeof field.required, 'boolean');
      assert.ok(field.inferencePolicy);
      assert.ok(field.renderer);
      if (field.allowedStatuses) {
        assert.ok(field.allowedStatuses.includes('NOT_CHECKED'));
        assert.equal(field.defaultValue, undefined);
      }
    }
  }
});

test('every template/version owns an isolated context corpus', () => {
  const contexts = listPredefinedTemplates().map((item) => `${item.contextCorpus.id}@${item.contextCorpus.version}`);
  assert.equal(new Set(contexts).size, contexts.length);
  assert.notEqual(templateFor('bus-passenger-door-safety-equipment-inspection').contextCorpus.id,
    templateFor('rail-track-inspection-maintenance').contextCorpus.id);
  assert.notEqual(templateFor('plain-rail-preventive-inspection').contextCorpus.id,
    templateFor('conductor-third-rail-preventive-inspection').contextCorpus.id);
});

test('ReportSession binds exact template, schema, renderer and context versions', () => {
  const item = templateFor('bus-passenger-door-safety-equipment-inspection');
  const session = createReportSession({ id: 'door-session', templateId: item.templateId });
  assert.deepEqual(session.templateBinding, {
    templateId: item.templateId,
    templateVersion: item.templateVersion,
    schemaId: item.schema.id,
    schemaVersion: item.schema.version,
    contextCorpusId: item.contextCorpus.id,
    contextVersion: item.contextCorpus.version,
    rendererId: item.rendererMapping.id,
    rendererVersion: item.rendererMapping.version,
  });
  assert.equal(session.view, 'workspace');
});

test('silence never produces OK, Normal, Passed, work, or completion facts', () => {
  for (const id of PREDEFINED_TEMPLATE_IDS) {
    const mapped = mapFactsForTemplate(id, []);
    assert.deepEqual(mapped.facts, []);
    assert.deepEqual(mapped.unsupportedFacts, []);
  }
});

test('template adapters preserve negation and reject cross-template checklist fields', () => {
  const result = mapFactsForTemplate('bus-passenger-door-safety-equipment-inspection', [
    { field: 'work.description', value: 'Rear door did not close', source_refs: ['transcript:1'] },
    { field: 'check.track_geometry.status', value: 'OK', source_refs: ['transcript:1'] },
  ]);
  assert.equal(result.facts[0].value, 'Rear door did not close');
  assert.equal(result.unsupportedFacts[0].field, 'check.track_geometry.status');
});

test('missingness and Resolve updates are schema-specific and do not accept unsupported autofill', () => {
  let session = createReportSession({ id: 'rail-session', templateId: 'rail-track-inspection-maintenance' });
  session = mapFactsToStructuredState(session, [
    { field: 'asset.line', value: 'DTL', source_refs: ['transcript:1'] },
    { field: 'check.track_geometry.status', value: 'OK', source_refs: ['knowledge:wrong'] },
    { field: 'bus.registration_no', value: 'SG0000X', source_refs: ['transcript:1'] },
  ]);
  const completeness = evaluateCompleteness(session);
  assert.equal(session.fieldStates['check.track_geometry.status'].status, 'NEEDS_CONFIRMATION');
  assert.ok(session.unsupportedFacts.some((fact) => fact.field === 'bus.registration_no'));
  assert.equal(completeness.complete, false);
  assert.ok(completeness.missingFields.length > 0);
});
