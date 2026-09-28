import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/build-netlify.js', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netlify-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'web'));
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><title>ServiceScribe</title>');
  fs.writeFileSync(path.join(root, 'web', 'app.js'), 'export const ready = true;');
  return root;
}

function build(root, apiOrigin) {
  const env = { ...process.env };
  delete env.NETLIFY_API_ORIGIN;
  if (apiOrigin !== undefined) env.NETLIFY_API_ORIGIN = apiOrigin;
  return spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
}

test('Netlify build refuses to publish a frontend without an API origin', (t) => {
  const root = fixture(t);
  const result = build(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NETLIFY_API_ORIGIN/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'netlify', 'index.html')), false);
});

test('Netlify build publishes only browser assets and proxies all backend routes', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'private.json'), '{"secret":true}');
  const result = build(root, 'https://api.example.com');
  assert.equal(result.status, 0, result.stderr);
  const output = path.join(root, 'dist', 'netlify');
  assert.equal(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), '<!doctype html><title>ServiceScribe</title>');
  assert.equal(fs.readFileSync(path.join(output, 'app.js'), 'utf8'), 'export const ready = true;');
  assert.equal(fs.existsSync(path.join(output, 'data', 'private.json')), false);
  assert.equal(fs.readFileSync(path.join(output, '_redirects'), 'utf8'), [
    '/api/*  https://api.example.com/api/:splat  200',
    '/session-bootstrap  https://api.example.com/session-bootstrap  200',
    '/report-download/*  https://api.example.com/report-download/:splat  200',
    '',
  ].join('\n'));
});

test('Netlify build rejects insecure or path-bearing API origins', (t) => {
  const root = fixture(t);
  for (const origin of ['http://api.example.com', 'https://localhost', 'https://api.example.com/path', 'https://user:pass@api.example.com']) {
    const result = build(root, origin);
    assert.notEqual(result.status, 0, origin);
    assert.equal(fs.existsSync(path.join(root, 'dist', 'netlify', 'index.html')), false);
  }
});
