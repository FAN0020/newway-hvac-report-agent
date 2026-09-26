import assert from 'node:assert/strict';
import test from 'node:test';

import { retrieveTemplateContext } from '../src/templates/context.js';

test('retrieval is bound to the selected template context version', () => {
  const door = retrieveTemplateContext({ templateId: 'bus-passenger-door-safety-equipment-inspection', query: 'door safety' });
  assert.equal(door.contextCorpusId, 'bus-passenger-door-safety-equipment-inspection-context');
  assert.ok(door.results.every((item) => item.templateId === 'bus-passenger-door-safety-equipment-inspection'));
  assert.ok(door.results.every((item) => item.provenance === 'official external context source'));
  assert.equal(door.mayAssertJobFacts, false);
});

test('rail conductor context cannot leak plain-rail, rail-track, or bus context', () => {
  const result = retrieveTemplateContext({ templateId: 'conductor-third-rail-preventive-inspection', query: 'rail maintenance' });
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((item) => item.contextCorpusId === 'conductor-third-rail-preventive-inspection-context'));
  assert.ok(result.results.every((item) => !item.contextCorpusId.includes('plain-rail') && !item.contextCorpusId.includes('bus-')));
});

test('unknown templates and mismatched requested context are rejected', () => {
  assert.throws(() => retrieveTemplateContext({ templateId: 'no-such-template', query: 'anything' }), /Unknown template/);
  assert.throws(() => retrieveTemplateContext({
    templateId: 'rail-track-inspection-maintenance',
    contextCorpusId: 'plain-rail-preventive-inspection-context',
    query: 'track',
  }), /context binding mismatch/iu);
});
