import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  allowedScopes,
  assertIsolation,
  loadScopeRegistry,
  resolveContext,
  scopeOfUpload,
  ScopeIsolationError,
} from '../../src/v2/scope.js';

// Inline fixture mirroring the scope-registry.v1 schema produced by the
// scope-registry builder; tests must not depend on that file existing yet.
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

test('resolves the three V2 contexts to their scope descriptors', () => {
  const bus = resolveContext('SBS/BUS', REGISTRY);
  assert.equal(bus.scopeId, 'SBS_BUS');
  assert.equal(bus.display, 'SBS / Bus');
  assert.equal(bus.uploadAllowed, true);

  const rail = resolveContext('SBS/RAIL', REGISTRY);
  assert.equal(rail.scopeId, 'SBS_RAIL');
  assert.equal(rail.display, 'SBS / Rail');
  assert.equal(rail.uploadAllowed, true);

  const hvac = resolveContext('HVAC', REGISTRY);
  assert.equal(hvac.scopeId, 'HVAC');
  assert.equal(hvac.display, 'HVAC');
  assert.equal(hvac.uploadAllowed, false);
});

test('allowedScopes matches the isolation contract for every context, including USER_UPLOADED entries', () => {
  assert.deepEqual(allowedScopes('SBS/BUS', REGISTRY), ['GLOBAL', 'ORGANIZATION', 'SBS', 'SBS_BUS', 'USER_UPLOADED:SBS_BUS']);
  assert.deepEqual(allowedScopes('SBS/RAIL', REGISTRY), ['GLOBAL', 'ORGANIZATION', 'SBS', 'SBS_RAIL', 'USER_UPLOADED:SBS_RAIL']);
  assert.deepEqual(allowedScopes('HVAC', REGISTRY), ['GLOBAL', 'ORGANIZATION', 'HVAC']);
});

test('allowedScopes returns a fresh copy and never mutates the registry', () => {
  const allowed = allowedScopes('HVAC', REGISTRY);
  allowed.push('SBS_BUS');
  assert.deepEqual(allowedScopes('HVAC', REGISTRY), ['GLOBAL', 'ORGANIZATION', 'HVAC']);
  assert.deepEqual(REGISTRY.isolation.HVAC.allowed, ['GLOBAL', 'ORGANIZATION', 'HVAC']);
});

test('assertIsolation throws ScopeIsolationError for HVAC <- SBS_BUS leakage (class 8)', () => {
  assert.throws(
    () => assertIsolation({ contextId: 'HVAC', candidateScopeId: 'SBS_BUS', registry: REGISTRY }),
    (error) => {
      assert.ok(error instanceof ScopeIsolationError);
      assert.equal(error.name, 'ScopeIsolationError');
      assert.equal(error.contextId, 'HVAC');
      assert.equal(error.candidateScopeId, 'SBS_BUS');
      assert.equal(error.category, 'CROSS_DOMAIN_LEAKAGE');
      assert.equal(error.code, 'SCOPE_ISOLATION');
      return true;
    },
  );
});

test('assertIsolation blocks SBS/BUS from HVAC and SBS/RAIL scopes', () => {
  assert.throws(
    () => assertIsolation({ contextId: 'SBS/BUS', candidateScopeId: 'HVAC', registry: REGISTRY }),
    /not allowed/,
  );
  assert.throws(
    () => assertIsolation({ contextId: 'SBS/BUS', candidateScopeId: 'SBS_RAIL', registry: REGISTRY }),
    /not allowed/,
  );
  assert.throws(
    () => assertIsolation({ contextId: 'SBS/BUS', candidateScopeId: 'USER_UPLOADED:SBS_RAIL', registry: REGISTRY }),
    /not allowed/,
  );
  assert.throws(
    () => assertIsolation({ contextId: 'SBS/RAIL', candidateScopeId: 'USER_UPLOADED:SBS_BUS', registry: REGISTRY }),
    /not allowed/,
  );
});

test('assertIsolation accepts inherited ancestors, own scope and own upload scope', () => {
  for (const candidate of ['GLOBAL', 'ORGANIZATION', 'SBS', 'SBS_BUS', 'USER_UPLOADED:SBS_BUS']) {
    assert.equal(assertIsolation({ contextId: 'SBS/BUS', candidateScopeId: candidate, registry: REGISTRY }), true);
  }
  assert.equal(assertIsolation({ contextId: 'HVAC', candidateScopeId: 'GLOBAL', registry: REGISTRY }), true);
});

test('unknown contexts throw instead of degrading silently', () => {
  assert.throws(() => resolveContext('UNKNOWN', REGISTRY), /Unknown V2 context "UNKNOWN"/);
  assert.throws(() => allowedScopes('SBS/BUS/EXTRA', REGISTRY), /Unknown V2 context/);
  assert.throws(() => assertIsolation({ contextId: 'NOPE', candidateScopeId: 'HVAC', registry: REGISTRY }), /Unknown V2 context/);
});

test('scopeOfUpload parses USER_UPLOADED:X and rejects every other form', () => {
  assert.equal(scopeOfUpload('USER_UPLOADED:SBS_BUS'), 'SBS_BUS');
  assert.equal(scopeOfUpload('USER_UPLOADED:SBS_RAIL'), 'SBS_RAIL');
  assert.equal(scopeOfUpload('USER_UPLOADED:HVAC'), 'HVAC');
  assert.throws(() => scopeOfUpload('SBS_BUS'), /Invalid upload scope id/);
  assert.throws(() => scopeOfUpload('USER_UPLOADED:'), /must not be empty/);
  assert.throws(() => scopeOfUpload(''), /Invalid upload scope id/);
  assert.throws(() => scopeOfUpload('user_uploaded:sbs_bus'), /Invalid upload scope id/);
});

test('loadScopeRegistry throws a descriptive error when the file is missing', async () => {
  const missing = path.resolve('.tmp-tests', 'v2-scope', 'does-not-exist.v1.json');
  await assert.rejects(loadScopeRegistry({ registryPath: missing }), /not found/);
});

test('loadScopeRegistry loads and validates a valid registry file', async (t) => {
  const root = path.resolve('.tmp-tests', 'v2-scope');
  const file = path.join(root, 'scope-registry.v1.json');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(REGISTRY, null, 2)}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const loaded = await loadScopeRegistry({ registryPath: file });
  assert.equal(loaded.schema_version, 'scope-registry.v1');
  assert.equal(loaded.context_ids['SBS/BUS'], 'SBS_BUS');
  assert.equal(loaded.scopes.SBS_BUS.display, 'SBS / Bus');
});

test('loadScopeRegistry rejects an unsupported schema version', async (t) => {
  const root = path.resolve('.tmp-tests', 'v2-scope');
  const file = path.join(root, 'bad-schema.v1.json');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ schema_version: 'not-a-scope-registry' }, null, 2)}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(loadScopeRegistry({ registryPath: file }), /unsupported schema_version/);
});
