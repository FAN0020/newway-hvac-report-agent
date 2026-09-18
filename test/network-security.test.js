import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeApiRequest,
  canBootstrapLocalSession,
  isLoopbackRemoteAddress,
  resolveServerConfig,
  securityHeaders,
  startupMessages,
  validateRequestHost,
} from '../src/network-security.js';

const strongToken = 'Demo-Token-2026-Strong';

test('loopback configuration starts without an operator-supplied token', () => {
  const config = resolveServerConfig({}, { randomBytes: () => Buffer.alloc(24, 7) });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4310);
  assert.equal(config.lanMode, false);
  assert.ok(config.token.length >= 16);
});

test('LAN configuration fails closed without a strong token', () => {
  assert.throws(() => resolveServerConfig({ HVAC_HOST: '0.0.0.0' }), /requires HVAC_DEMO_TOKEN/);
  assert.throws(() => resolveServerConfig({ HVAC_HOST: '0.0.0.0', HVAC_DEMO_TOKEN: 'weak' }), /requires HVAC_DEMO_TOKEN/);
  assert.throws(() => resolveServerConfig({ HVAC_HOST: '0.0.0.0', HVAC_DEMO_TOKEN: 'onlylettersareweaktoken' }), /requires HVAC_DEMO_TOKEN/);
  const config = resolveServerConfig({ HVAC_HOST: '0.0.0.0', HVAC_DEMO_TOKEN: strongToken, HVAC_PORT: '4310' });
  assert.equal(config.lanMode, true);
  assert.equal(config.token, strongToken);
});

test('invalid bind hosts, ports, and allowed-host entries are rejected', () => {
  assert.throws(() => resolveServerConfig({ HVAC_HOST: '192.168.1.5' }), /HVAC_HOST/);
  assert.throws(() => resolveServerConfig({ HVAC_PORT: '0' }), /HVAC_PORT/);
  assert.throws(() => resolveServerConfig({ HVAC_PORT: '4310x' }), /HVAC_PORT/);
  assert.throws(() => resolveServerConfig({ HVAC_ALLOWED_HOSTS: 'good.local,evil/path' }), /HVAC_ALLOWED_HOSTS/);
});

test('API authorization accepts the correct bearer token and rejects missing or wrong tokens uniformly', () => {
  const config = resolveServerConfig({ HVAC_HOST: '0.0.0.0', HVAC_DEMO_TOKEN: strongToken });
  const baseHeaders = { host: '192.168.1.50:4310', origin: 'http://192.168.1.50:4310', 'sec-fetch-site': 'same-origin' };
  assert.deepEqual(authorizeApiRequest({ headers: { ...baseHeaders, authorization: `Bearer ${strongToken}` } }, config), { ok: true });
  assert.deepEqual(authorizeApiRequest({ headers: baseHeaders }, config), { ok: false, status: 401, code: 'AUTHENTICATION_REQUIRED' });
  assert.deepEqual(authorizeApiRequest({ headers: { ...baseHeaders, authorization: 'Bearer definitely-wrong' } }, config), { ok: false, status: 401, code: 'AUTHENTICATION_REQUIRED' });
});

test('same-origin browser and origin-less authenticated CLI requests pass; cross-origin requests fail', () => {
  const config = resolveServerConfig({ HVAC_HOST: '0.0.0.0', HVAC_DEMO_TOKEN: strongToken });
  const authorization = `Bearer ${strongToken}`;
  assert.equal(authorizeApiRequest({ headers: { host: '10.0.0.20:4310', origin: 'http://10.0.0.20:4310', authorization } }, config).ok, true);
  assert.equal(authorizeApiRequest({ headers: { host: '10.0.0.20:4310', authorization } }, config).ok, true);
  assert.deepEqual(authorizeApiRequest({ headers: { host: '10.0.0.20:4310', origin: 'http://attacker.test:4310', authorization } }, config), { ok: false, status: 403, code: 'REQUEST_DENIED' });
  assert.deepEqual(authorizeApiRequest({ headers: { host: '10.0.0.20:4310', authorization, 'sec-fetch-site': 'cross-site' } }, config), { ok: false, status: 403, code: 'REQUEST_DENIED' });
});

test('Host validation permits private LAN addresses and explicit names, but rejects public, malformed, or wrong-port hosts', () => {
  const config = resolveServerConfig({
    HVAC_HOST: '0.0.0.0', HVAC_DEMO_TOKEN: strongToken, HVAC_ALLOWED_HOSTS: 'demo-mac.local',
  });
  assert.equal(validateRequestHost('192.168.0.8:4310', config).ok, true);
  assert.equal(validateRequestHost('demo-mac.local:4310', config).ok, true);
  assert.equal(validateRequestHost('8.8.8.8:4310', config).ok, false);
  assert.equal(validateRequestHost('demo-mac.local:9999', config).ok, false);
  assert.equal(validateRequestHost('demo-mac.local:4310,evil.test', config).ok, false);
});

test('loopback Host and remote-address boundaries are explicit', () => {
  const config = resolveServerConfig({}, { randomBytes: () => Buffer.alloc(24, 9) });
  assert.equal(validateRequestHost('127.0.0.1:4310', config).ok, true);
  assert.equal(validateRequestHost('localhost:4310', config).ok, true);
  assert.equal(validateRequestHost('192.168.1.2:4310', config).ok, false);
  assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('192.168.1.2'), false);
});

test('local session bootstrap trusts the socket address, never forwarded headers, and is disabled in LAN mode', () => {
  const local = resolveServerConfig({}, { randomBytes: () => Buffer.alloc(24, 5) });
  const localRequest = {
    headers: { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  assert.equal(canBootstrapLocalSession(localRequest, local), true);
  assert.equal(canBootstrapLocalSession({
    ...localRequest,
    headers: { ...localRequest.headers, 'x-forwarded-for': '127.0.0.1' },
    socket: { remoteAddress: '192.168.1.90' },
  }, local), false);
  assert.equal(canBootstrapLocalSession({ ...localRequest, headers: { host: '127.0.0.1:4310' } }, local), false);
  const lan = resolveServerConfig({ HVAC_HOST: '0.0.0.0', HVAC_DEMO_TOKEN: strongToken });
  assert.equal(canBootstrapLocalSession(localRequest, lan), false);
});

test('static and API security headers are restrictive and do not enable CORS', () => {
  const staticHeaders = securityHeaders();
  const apiHeaders = securityHeaders({ api: true });
  assert.match(staticHeaders['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(staticHeaders['x-content-type-options'], 'nosniff');
  assert.equal(staticHeaders['referrer-policy'], 'no-referrer');
  assert.equal(staticHeaders['x-frame-options'], 'DENY');
  assert.equal(apiHeaders['cache-control'], 'no-store');
  assert.equal(Object.hasOwn(staticHeaders, 'access-control-allow-origin'), false);
  assert.equal(Object.hasOwn(apiHeaders, 'access-control-allow-origin'), false);
});

test('startup messages disclose mode and risk but never disclose the token', () => {
  const config = resolveServerConfig({ HVAC_HOST: '0.0.0.0', HVAC_DEMO_TOKEN: strongToken });
  const output = startupMessages(config).join('\n');
  assert.match(output, /trusted Wi-Fi only/);
  assert.match(output, /not a public-internet or production deployment/);
  assert.doesNotMatch(output, new RegExp(strongToken));
});
