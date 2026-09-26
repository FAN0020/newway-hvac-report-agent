import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRetriever } from '../../src/v2/retrieval.js';
import { loadScopeRegistry } from '../../src/v2/scope.js';

const CROSS_DOMAIN_BLOCKED = 'CROSS_DOMAIN_BLOCKED';

// Inline registry fixture (mirrors data/knowledge/v2/scope-registry.v1.json).
// GLOBAL/ORGANIZATION/SBS are hierarchical scopes whose knowledge_files lists
// are EMPTY arrays — they are not leak sources and must never produce
// CROSS_DOMAIN_BLOCKED warnings.
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
    GLOBAL: [],
    ORGANIZATION: [],
    SBS: [],
    SBS_BUS: ['sbs-bus-assets.v1.json'],
    SBS_RAIL: ['sbs-rail-terms.v1.json'],
    HVAC: ['hvac-terms.v1.json'],
  },
  context_ids: { 'SBS/BUS': 'SBS_BUS', 'SBS/RAIL': 'SBS_RAIL', HVAC: 'HVAC' },
};

// Knowledge payloads written into the per-test temp directory. The
// term_refrigerant record deliberately keeps "制冷剂" ONLY in `canonical`
// (aliases and description carry no standalone 制冷剂 token), so the only way
// the query hits is if serializeKnowledgeRecord indexes the canonical field.
const KNOWLEDGE_BODY = {
  'hvac-terms.v1.json': [
    {
      id: 'term_refrigerant',
      kind: 'term',
      canonical: '制冷剂',
      aliases: ['冷媒', '雪种', 'refrigerant'],
      correction_rules: [
        { id: 'corr_asr_1', source: '制冷记', target: '制冷剂', match_basis: 'CONTROLLED_ASR_CONFUSION', reason: '近音 ASR 误识别' },
        { id: 'corr_asr_2', source: '学种', target: '雪种', match_basis: 'CONTROLLED_ASR_CONFUSION', reason: '口语误识别' },
      ],
      risk: 'REFRIGERANT',
      description: '充注量必须有本次服务证据，新加坡口语常说雪种。',
    },
  ],
  'sbs-bus-assets.v1.json': [
    {
      id: 'asset_man_a95',
      kind: 'asset',
      asset_type: 'bus_model',
      canonical: 'MAN A95',
      aliases: ['A95', 'MAN A95 Double Decker'],
      attributes: {
        body_type: 'double-deck',
        engine: 'D 2066 LUH',
        gearbox: 'ZF EcoLife',
        euro_class: 'Euro VI',
      },
      description: 'MAN A95 双层巴士车型。',
    },
  ],
  'sbs-rail-terms.v1.json': [
    { id: 'rail_point_machine', kind: 'term', canonical: '道岔转辙机', aliases: ['MCEM91'], description: 'Rail point machine operation.' },
  ],
};

let scenarioCounter = 0;

/**
 * Writes the knowledge files referenced by `knowledgeFiles` into a fresh temp
 * directory and returns the retriever inputs. The temp dir is removed by
 * node:test's t.after hook (self-cleaning; no dependency on parallel workers).
 */
async function makeContext(t, knowledgeFiles = REGISTRY.knowledge_files) {
  scenarioCounter += 1;
  const root = path.resolve('.tmp-tests', `v2-retrieval-regression-${process.pid}-${scenarioCounter}`);
  const knowledgeRoot = path.join(root, 'knowledge');
  await fs.mkdir(knowledgeRoot, { recursive: true });
  const referenced = new Set(Object.values(knowledgeFiles).flat());
  for (const [name, body] of Object.entries(KNOWLEDGE_BODY)) {
    if (!referenced.has(name)) continue;
    const payload = Array.isArray(body)
      ? { schema_version: 'test.v1', knowledge_version: '2026-09-24', records: body }
      : { schema_version: 'test.v1', knowledge_version: '2026-09-24', ...body };
    await fs.writeFile(path.join(knowledgeRoot, name), `${JSON.stringify(payload, null, 2)}\n`);
  }
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { registry: { ...REGISTRY, knowledge_files: knowledgeFiles }, knowledgeRoot };
}

test('serialize regression: canonical main term is retrievable (HVAC 制冷剂 hits canonical record)', async (t) => {
  const { registry, knowledgeRoot } = await makeContext(t);
  const retriever = createRetriever({ registry, knowledgeRoot });

  const out = await retriever({ contextId: 'HVAC', query: '制冷剂', topK: 10 });
  const hit = out.results.find((r) => r.chunk_id.includes('term_refrigerant'));
  assert.ok(hit, `expected canonical 制冷剂 to hit term_refrigerant, got: ${out.results.map((r) => r.chunk_id).join(', ') || 'no results'}`);
  assert.ok(hit.text.includes('制冷剂'));
  assert.ok(out.results.every((r) => r.scope_id === 'HVAC'));
});

test('serialize regression: attribute values are retrievable (euro_class / engine)', async (t) => {
  const { registry, knowledgeRoot } = await makeContext(t);
  const retriever = createRetriever({ registry, knowledgeRoot });

  const byEuro = await retriever({ contextId: 'SBS/BUS', query: 'Euro VI', topK: 10 });
  const euroHit = byEuro.results.find((r) => r.chunk_id.includes('asset_man_a95'));
  assert.ok(euroHit, `expected attribute euro_class "Euro VI" to hit asset_man_a95, got: ${byEuro.results.map((r) => r.chunk_id).join(', ') || 'no results'}`);
  assert.ok(euroHit.text.includes('euro_class: Euro VI'));

  const byEngine = await retriever({ contextId: 'SBS/BUS', query: 'D 2066', topK: 10 });
  const engineHit = byEngine.results.find((r) => r.chunk_id.includes('asset_man_a95'));
  assert.ok(engineHit, `expected attribute engine "D 2066" to hit asset_man_a95, got: ${byEngine.results.map((r) => r.chunk_id).join(', ') || 'no results'}`);
  assert.ok(engineHit.text.includes('engine: D 2066'));

  assert.ok(byEuro.results.every((r) => r.scope_id === 'SBS_BUS'));
  assert.ok(byEngine.results.every((r) => r.scope_id === 'SBS_BUS'));
});

test('warning regression: empty-list scopes produce no CROSS_DOMAIN_BLOCKED warnings', async (t) => {
  // SBS_RAIL and HVAC are NOT allowed for SBS/BUS but their file lists are
  // empty here — they are not leak sources, so zero warnings are expected.
  const knowledgeFiles = {
    GLOBAL: [],
    ORGANIZATION: [],
    SBS: [],
    SBS_BUS: ['sbs-bus-assets.v1.json'],
    SBS_RAIL: [],
    HVAC: [],
  };
  const { registry, knowledgeRoot } = await makeContext(t, knowledgeFiles);
  const retriever = createRetriever({ registry, knowledgeRoot });

  const out = await retriever({ contextId: 'SBS/BUS', query: 'A95' });
  assert.deepEqual(out.warnings, [], `empty-list scopes must not emit warnings, got: ${JSON.stringify(out.warnings)}`);
  assert.ok(out.results.some((r) => r.scope_id === 'SBS_BUS' && r.source === 'knowledge'));
});

test('warning regression: exactly one CROSS_DOMAIN_BLOCKED from a real cross-domain source', async (t) => {
  // Full fixture: GLOBAL/ORGANIZATION/SBS empty + SBS_BUS (allowed) with files
  // and SBS_RAIL/HVAC (real cross-domain sources) with files. A SBS/BUS query
  // must surface exactly one CROSS_DOMAIN_BLOCKED (deduplicated), with no
  // extra warnings coming from the empty hierarchical scopes.
  const { registry, knowledgeRoot } = await makeContext(t);
  const retriever = createRetriever({ registry, knowledgeRoot });

  const blocked = await retriever({ contextId: 'SBS/BUS', query: 'MCEM91 道岔转辙机', topK: 10 });
  assert.deepEqual(blocked.results, [], 'cross-domain rail knowledge must stay blocked (0 results)');
  assert.deepEqual(blocked.warnings, [CROSS_DOMAIN_BLOCKED], `expected exactly one CROSS_DOMAIN_BLOCKED, got: ${JSON.stringify(blocked.warnings)}`);

  const mixed = await retriever({ contextId: 'SBS/BUS', query: 'A95 Euro VI', topK: 10 });
  assert.ok(mixed.results.some((r) => r.scope_id === 'SBS_BUS'), 'same-domain SBS_BUS knowledge must still hit');
  assert.ok(mixed.results.every((r) => r.scope_id === 'SBS_BUS'));
  assert.deepEqual(mixed.warnings, [CROSS_DOMAIN_BLOCKED], `expected exactly one CROSS_DOMAIN_BLOCKED, got: ${JSON.stringify(mixed.warnings)}`);
});

test('existing behavior: real knowledge root still blocks cross-domain and hits same-domain (A95)', async () => {
  // Default knowledgeRoot points at the real data/knowledge directory and the
  // real scope-registry.v1.json: SBS/BUS must keep hitting sbs knowledge while
  // HVAC-only content stays hard-blocked.
  const registry = await loadScopeRegistry();
  const retriever = createRetriever({ registry });

  const sameDomain = await retriever({ contextId: 'SBS/BUS', query: 'A95', topK: 10 });
  assert.ok(sameDomain.results.length >= 1, 'A95 must hit sbs knowledge in SBS/BUS');
  assert.ok(sameDomain.results.every((r) => r.scope_id === 'SBS_BUS' && r.source === 'knowledge'));

  const crossDomain = await retriever({ contextId: 'SBS/BUS', query: '雪种 制冷剂', topK: 10 });
  assert.deepEqual(crossDomain.results, [], 'HVAC-only terms must stay blocked in SBS/BUS (0 results)');
  assert.ok(crossDomain.warnings.includes(CROSS_DOMAIN_BLOCKED));
});

test('exact Rail asset identifier outranks a nearby stock family', async () => {
  const registry = await loadScopeRegistry();
  const retriever = createRetriever({ registry });
  const out = await retriever({
    contextId: 'SBS/RAIL',
    query: 'Alstom Metropolis C751A Car 3 passenger door control module',
    topK: 5,
  });
  assert.ok(out.results.length > 0);
  assert.match(out.results[0].text, /C751A/iu);
  assert.doesNotMatch(out.results[0].text, /C851E/iu);
});

test('RAIL retrieval cannot return POWER_GRID-only knowledge', async () => {
  const registry = await loadScopeRegistry();
  const retriever = createRetriever({ registry });
  const out = await retriever({
    contextId: 'SBS/RAIL',
    query: 'insulating oil dielectric breakdown voltage transformer',
    topK: 10,
  });
  assert.ok(out.results.every((item) => item.scope_id !== 'POWER_GRID'));
  assert.ok(out.results.every((item) => item.scope_id === 'SBS_RAIL'));
  assert.ok(out.warnings.includes(CROSS_DOMAIN_BLOCKED));
});
