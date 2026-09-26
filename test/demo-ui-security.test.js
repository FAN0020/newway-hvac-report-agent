import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { resources } from '../web/i18n.js';

test('demo UI asks for a temporary token and provides a non-submitting example filler', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
  ]);
  for (const id of ['auth-gate', 'auth-token', 'auth-submit', 'auth-status', 'network-mode', 'network-warning', 'fill-demo']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(client, new RegExp(id));
  }
  assert.match(html, /Demo mode · not production/);
  assert.match(html, /will not submit, generate, or confirm a report/);
  const fillHandler = client.slice(client.indexOf("el['fill-demo'].addEventListener"), client.indexOf("el['auth-submit'].addEventListener"));
  assert.match(fillHandler, /manual-transcript.*demoNarration/s);
  assert.doesNotMatch(fillHandler, /api\(|fetch\(|\.click\(/);
});

test('every API request uses one Authorization wrapper and 401 clears only session-scoped storage', async () => {
  const client = await fs.readFile('web/app.js', 'utf8');
  assert.match(client, /headers\.set\('authorization', `Bearer \$\{sessionToken\}`\)/);
  assert.match(client, /response\.status === 401/);
  assert.match(client, /sessionStorage\.setItem/);
  assert.match(client, /sessionStorage\.removeItem/);
  assert.doesNotMatch(client, /localStorage/);
  assert.doesNotMatch(client, /[?&](?:token|access_token)=/);
  assert.equal((client.match(/fetch\('\/api\//g) || []).length, 0);
});

test('server protects all API paths before dispatch and keeps local bootstrap outside LAN mode', async () => {
  const server = await fs.readFile('src/server.js', 'utf8');
  const apiBranch = server.slice(server.indexOf("if (url.pathname.startsWith('/api/'))"), server.indexOf("} else if (request.method === 'POST' && url.pathname === '/session-bootstrap')"));
  assert.match(apiBranch, /authorizeApiRequest\(request, config\)/);
  assert.match(apiBranch, /handleApi\(request, response, url, traceId, config\)/);
  assert.match(server, /canBootstrapLocalSession\(request, config\)/);
  assert.doesNotMatch(server, /access-control-allow-origin/i);
});

test('LAN token is not embedded in HTML or a startup log template', async () => {
  const [html, server, launcher] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('src/server.js', 'utf8'),
    fs.readFile('scripts/start-demo.js', 'utf8'),
  ]);
  assert.doesNotMatch(html, /HVAC_DEMO_TOKEN|authorization:\s*Bearer/i);
  assert.doesNotMatch(server, /console\.log\([^\n]*config\.token/);
  assert.doesNotMatch(launcher, /console\.log\([^\n]*(?:token|HVAC_DEMO_TOKEN)/i);
});

test('guided walkthrough is wired: localized 7-step flow with sample data per SBS scope', async () => {
  const [html, client] = await Promise.all([
    fs.readFile('web/index.html', 'utf8'),
    fs.readFile('web/app.js', 'utf8'),
  ]);
  // Button + guide bar exist in the page.
  for (const id of ['v2-walkthrough-start', 'v2-walkthrough', 'v2-wt-progress', 'v2-wt-step', 'v2-wt-title', 'v2-wt-desc', 'v2-wt-skip', 'v2-wt-next']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(client, new RegExp(id));
  }
  // Every step resolves through both locale catalogs.
  for (const key of ['scope', 'upload', 'retrieval', 'statement', 'facts', 'report', 'done']) {
    assert.equal(typeof resources.en.walkthrough[key].title, 'string');
    assert.equal(typeof resources['zh-CN'].walkthrough[key].title, 'string');
    assert.match(client, new RegExp(`walkthrough\\.${key}\\.title`));
  }
  // Sample data helpers exist and are scope-aware.
  assert.match(client, /function v2WtSampleDoc\(\)/);
  assert.match(client, /function v2WtQuery\(\)/);
  assert.match(client, /SBS-Rail-Door-Bulletin\.txt/);
  assert.match(client, /SBS-Bus-Door-Service-Note\.txt/);
  // Walkthrough and the demo player are mutually exclusive.
  assert.match(client, /if \(v2Wt\.active\) v2WtStop\(\)/);
  // Scope changes under an active walkthrough restart or stop it.
  assert.match(client, /v2Wt\.active/);
  assert.match(client, /v2WtRestart/);
});
