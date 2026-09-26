import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRetriever } from '../../src/v2/retrieval.js';
import { createUploadStore, ingestDocument } from '../../src/v2/upload.js';

const REGISTRY = {
  schema_version: 'scope-registry.v1',
  knowledge_version: '2026-09-24',
  scopes: {
    GLOBAL: { kind: 'global', children: ['ORGANIZATION'], display: 'Global' },
    ORGANIZATION: { kind: 'organization', children: ['SBS', 'HVAC'], display: 'Organization' },
    SBS: { kind: 'organization', children: ['SBS_BUS', 'SBS_RAIL'], display: 'SBS' },
    SBS_BUS: { kind: 'domain', parent: 'SBS', display: 'SBS / Bus', upload_allowed: true },
    SBS_RAIL: { kind: 'domain', parent: 'SBS', display: 'SBS / Rail', upload_allowed: true },
    HVAC: { kind: 'domain', parent: 'ORGANIZATION', display: 'HVAC', upload_allowed: false },
  },
  isolation: {
    SBS_BUS: { allowed: ['GLOBAL', 'ORGANIZATION', 'SBS', 'SBS_BUS', 'USER_UPLOADED:SBS_BUS'], forbidden: ['HVAC', 'SBS_RAIL', 'USER_UPLOADED:SBS_RAIL', 'USER_UPLOADED:HVAC'] },
    SBS_RAIL: { allowed: ['GLOBAL', 'ORGANIZATION', 'SBS', 'SBS_RAIL', 'USER_UPLOADED:SBS_RAIL'], forbidden: ['HVAC', 'SBS_BUS', 'USER_UPLOADED:SBS_BUS', 'USER_UPLOADED:HVAC'] },
    HVAC: { allowed: ['GLOBAL', 'ORGANIZATION', 'HVAC'], forbidden: ['SBS_BUS', 'SBS_RAIL', 'USER_UPLOADED:SBS_BUS', 'USER_UPLOADED:SBS_RAIL'] },
  },
  knowledge_files: {
    SBS_BUS: ['sbs-bus-terms.v1.json', 'sbs-bus-parts.v1.json', 'sbs-bus-assets.v1.json', 'sbs-bus-units.v1.json', 'sbs-bus-report-modules.v1.json'],
    SBS_RAIL: ['sbs-rail-terms.v1.json', 'sbs-rail-parts.v1.json', 'sbs-rail-assets.v1.json', 'sbs-rail-units.v1.json', 'sbs-rail-report-modules.v1.json'],
    HVAC: ['hvac-terms.v1.json', 'hvac-parts.v1.json', 'report-modules.v1.json'],
  },
  context_ids: { 'SBS/BUS': 'SBS_BUS', 'SBS/RAIL': 'SBS_RAIL', HVAC: 'HVAC' },
};

const KNOWLEDGE_BODY = {
  'sbs-bus-terms.v1.json': [
    { id: 'bus-fan-belt', description: 'Fan belt tension must be checked on bus engines.', terms: ['fan belt', 'tension'] },
    { id: 'bus-brake', description: 'Brake pressure measured in kPa for bus pneumatics.', terms: ['brake', 'kPa'] },
  ],
  'sbs-bus-parts.v1.json': [
    { id: 'bus-alternator', description: 'Alternator belt replacement for bus engines.', terms: ['alternator'] },
    { id: 'bus-bearing-1', description: 'Bearing inspection procedure step one.', terms: ['bearing'] },
    { id: 'bus-bearing-2', description: 'Bearing inspection procedure step two.', terms: ['bearing'] },
    { id: 'bus-bearing-3', description: 'Bearing inspection procedure step three.', terms: ['bearing'] },
    { id: 'bus-bearing-4', description: 'Bearing inspection procedure step four.', terms: ['bearing'] },
    { id: 'bus-bearing-5', description: 'Bearing inspection procedure step five.', terms: ['bearing'] },
  ],
  'sbs-bus-assets.v1.json': [{ id: 'bus-sg3050z', description: 'Bus SG3050Z fleet identifier.', terms: ['SG3050Z'] }],
  'sbs-bus-units.v1.json': [{ id: 'bus-kpa-unit', description: 'Pressure unit kPa used across bus maintenance.', terms: ['kPa'] }],
  'sbs-bus-report-modules.v1.json': { fixed_sections: [{ id: 'bus-report-section', description: 'Bus maintenance report section.' }] },
  'sbs-rail-terms.v1.json': [{ id: 'rail-point-machine', description: 'Point machine MCEM91 operation.', terms: ['point machine', 'MCEM91'] }],
  'sbs-rail-parts.v1.json': [{ id: 'rail-door-motor', description: 'Door motor ZX-47 replacement procedure.', terms: ['door motor', 'ZX-47'] }],
  'sbs-rail-assets.v1.json': [{ id: 'rail-c751a', description: 'C751A train set asset.', terms: ['C751A'] }],
  'sbs-rail-units.v1.json': [{ id: 'rail-kv', description: 'Traction supply at 1500 V DC.', terms: ['1500 V'] }],
  'sbs-rail-report-modules.v1.json': { fixed_sections: [{ id: 'rail-report-section', description: 'Rail maintenance report section.' }] },
  'hvac-terms.v1.json': [{ id: 'hvac-chiller', description: 'Chiller refrigerant charge check.', terms: ['chiller', 'refrigerant'] }],
  'hvac-parts.v1.json': [{ id: 'hvac-compressor', description: 'Compressor for rooftop AHU units.', terms: ['compressor', 'AHU'] }],
  'report-modules.v1.json': { fixed_sections: [{ id: 'hvac-report-section', description: 'HVAC service report section.' }] },
};

const METADATA = Object.freeze({ uploader: 'tech-001', source: 'user_upload:tech-001', scenario: 'manual' });

let scenarioCounter = 0;

async function makeContext(t) {
  scenarioCounter += 1;
  const root = path.resolve('.tmp-tests', `v2-retrieval-ctx-${scenarioCounter}`);
  const knowledgeRoot = path.join(root, 'knowledge');
  await fs.mkdir(knowledgeRoot, { recursive: true });
  for (const [name, body] of Object.entries(KNOWLEDGE_BODY)) {
    const payload = Array.isArray(body)
      ? { schema_version: 'test.v1', knowledge_version: '2026-09-24', records: body }
      : { schema_version: 'test.v1', knowledge_version: '2026-09-24', ...body };
    await fs.writeFile(path.join(knowledgeRoot, name), `${JSON.stringify(payload, null, 2)}\n`);
  }
  const store = createUploadStore({ baseDir: path.join(root, 'uploads') });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { registry: REGISTRY, knowledgeRoot, store };
}

test('SBS/BUS retrieval never returns HVAC or SBS/RAIL knowledge (class 8 hard gate)', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });

  const mixed = await retriever({ contextId: 'SBS/BUS', query: 'fan belt chiller compressor' });
  assert.ok(mixed.results.length >= 1);
  assert.ok(mixed.results.every((r) => r.scope_id === 'SBS_BUS' && r.source === 'knowledge'));
  assert.ok(mixed.warnings.includes('CROSS_DOMAIN_BLOCKED'));

  // A query whose only matches live in forbidden scopes yields zero results.
  const railOnly = await retriever({ contextId: 'SBS/BUS', query: 'point machine MCEM91 C751A' });
  assert.deepEqual(railOnly.results, []);
  assert.ok(railOnly.warnings.includes('CROSS_DOMAIN_BLOCKED'));

  const hvacOnly = await retriever({ contextId: 'SBS/BUS', query: 'chiller refrigerant' });
  assert.deepEqual(hvacOnly.results, []);
  assert.ok(hvacOnly.warnings.includes('CROSS_DOMAIN_BLOCKED'));
});

test('SBS/BUS query never returns SBS/RAIL uploads (class 10 hard gate)', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  await ingestDocument({
    scopeId: 'SBS_RAIL',
    filename: 'rail-sop.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Door motor ZX-47 replacement procedure for rail car doors.', 'utf8'),
    metadata: METADATA,
    store,
  });
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });

  const out = await retriever({ contextId: 'SBS/BUS', query: 'door motor ZX-47 replacement' });
  assert.ok(out.results.every((r) => !(r.source === 'upload' && r.scope_id === 'SBS_RAIL')));
  assert.ok(out.results.every((r) => r.scope_id !== 'SBS_RAIL'));
  assert.ok(out.warnings.includes('CROSS_DOMAIN_BLOCKED'));
});

test('HVAC query never returns SBS uploads', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'bus-floor-sop.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Bus floor cleaning safety procedure.', 'utf8'),
    metadata: METADATA,
    store,
  });
  await ingestDocument({
    scopeId: 'SBS_RAIL',
    filename: 'rail-signal.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Signal maintenance isolation procedure.', 'utf8'),
    metadata: METADATA,
    store,
  });
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });

  const out = await retriever({ contextId: 'HVAC', query: 'bus floor cleaning signal maintenance' });
  assert.ok(out.results.every((r) => r.source !== 'upload'));
  assert.ok(out.results.every((r) => r.scope_id === 'HVAC'));
  assert.ok(out.warnings.includes('CROSS_DOMAIN_BLOCKED'));
});

test('same-domain retrieval returns hits from its own knowledge and uploads', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'bus-manual.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Fan belt replacement procedure for bus engines.', 'utf8'),
    metadata: METADATA,
    store,
  });
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });

  const out = await retriever({ contextId: 'SBS/BUS', query: 'fan belt replacement' });
  assert.ok(out.results.length >= 1);
  assert.ok(out.results.some((r) => r.source === 'knowledge' && r.scope_id === 'SBS_BUS'));
  assert.ok(out.results.some((r) => r.source === 'upload' && r.scope_id === 'SBS_BUS'));
  assert.ok(out.results.every((r) => r.score > 0));
  assert.ok(out.results.every((r) => r.text.length > 0));
});

test('topK limits the number of returned results', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });

  const out = await retriever({ contextId: 'SBS/BUS', query: 'bearing', topK: 2, includeUploads: false });
  assert.equal(out.results.length, 2);
  assert.ok(out.results.every((r) => r.scope_id === 'SBS_BUS'));

  const many = await retriever({ contextId: 'SBS/BUS', query: 'bearing', topK: 10, includeUploads: false });
  assert.equal(many.results.length, 5);
});

test('includeUploads=false excludes upload chunks from results', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'bus-upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Fan belt manual uploaded by the depot team.', 'utf8'),
    metadata: METADATA,
    store,
  });
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });

  const withUploads = await retriever({ contextId: 'SBS/BUS', query: 'fan belt' });
  assert.ok(withUploads.results.some((r) => r.source === 'upload'));
  const withoutUploads = await retriever({ contextId: 'SBS/BUS', query: 'fan belt', includeUploads: false });
  assert.ok(withoutUploads.results.every((r) => r.source !== 'upload'));
});

test('authoritative retrieval can only consult the upload ids bound to its ReportSession', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  const first = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'session-a.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Session Alpha proprietary ZX-47 door procedure.', 'utf8'),
    metadata: { ...METADATA, report_session_id: 'session_alpha' },
    store,
  });
  const second = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'session-b.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Session Beta proprietary ZX-47 door procedure.', 'utf8'),
    metadata: { ...METADATA, report_session_id: 'session_beta' },
    store,
  });
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });

  const out = await retriever({
    contextId: 'SBS/BUS',
    query: 'proprietary ZX-47 door procedure',
    permittedUploadIds: [first.upload_id],
  });

  assert.ok(out.results.some((item) => item.doc_id === first.upload_id));
  assert.ok(out.results.every((item) => item.source !== 'upload' || item.doc_id === first.upload_id));
  assert.ok(out.results.every((item) => item.doc_id !== second.upload_id));
});

test('results carry provenance and doc/chunk identifiers', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });

  const out = await retriever({ contextId: 'SBS/BUS', query: 'fan belt' });
  const knowledge = out.results.find((r) => r.source === 'knowledge');
  assert.ok(knowledge);
  assert.ok(knowledge.doc_id.endsWith('.v1.json'));
  assert.ok(knowledge.chunk_id.startsWith('knowledge:SBS_BUS:'));
  assert.equal(knowledge.provenance.knowledge_version, '2026-09-24');
  assert.ok(knowledge.provenance.file);
});

test('retrieval works without an upload store', async (t) => {
  const { registry, knowledgeRoot } = await makeContext(t);
  const retriever = createRetriever({ registry, knowledgeRoot });
  const out = await retriever({ contextId: 'HVAC', query: 'chiller refrigerant' });
  assert.ok(out.results.some((r) => r.source === 'knowledge' && r.scope_id === 'HVAC'));
  assert.ok(out.results.every((r) => r.scope_id === 'HVAC'));
});

test('missing knowledge files are skipped with a warning instead of failing', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  const registryWithExtra = {
    ...registry,
    knowledge_files: {
      ...registry.knowledge_files,
      SBS_BUS: [...registry.knowledge_files.SBS_BUS, 'sbs-bus-extra.v1.json'],
    },
  };
  const retriever = createRetriever({ registry: registryWithExtra, knowledgeRoot, uploadStore: store });

  const out = await retriever({ contextId: 'SBS/BUS', query: 'fan belt' });
  assert.ok(out.results.length >= 1);
  assert.ok(out.warnings.includes('KNOWLEDGE_FILE_MISSING:sbs-bus-extra.v1.json'));
});

test('unknown context ids throw from retrieve', async (t) => {
  const { registry, knowledgeRoot, store } = await makeContext(t);
  const retriever = createRetriever({ registry, knowledgeRoot, uploadStore: store });
  await assert.rejects(retriever({ contextId: 'UNKNOWN', query: 'x' }), /Unknown V2 context/);
});

test('createRetriever requires a registry', () => {
  assert.throws(() => createRetriever({}), TypeError);
});
