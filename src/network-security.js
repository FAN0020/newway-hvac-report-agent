import crypto from 'node:crypto';
import net from 'node:net';

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const ALLOWED_BIND_HOSTS = new Set([...LOOPBACK_BIND_HOSTS, '0.0.0.0']);
const MIN_DEMO_TOKEN_LENGTH = 16;

function configurationError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_SERVER_CONFIGURATION' });
}

function parsePort(value) {
  if (value === undefined || value === '') return 4310;
  if (!/^\d+$/.test(String(value))) throw configurationError('HVAC_PORT must be an integer from 1 to 65535.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw configurationError('HVAC_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function isStrongToken(token) {
  return typeof token === 'string'
    && token.length >= MIN_DEMO_TOKEN_LENGTH
    && token.length <= 256
    && !/\s/.test(token)
    && /[A-Za-z]/.test(token)
    && /\d|[^A-Za-z]/.test(token);
}

function parseAllowedHosts(value) {
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).map((item) => {
    if (!/^[a-z0-9.-]+$/.test(item) || item.startsWith('.') || item.endsWith('.') || item.includes('..')) {
      throw configurationError('HVAC_ALLOWED_HOSTS contains an invalid hostname.');
    }
    return item;
  });
}

export function resolveServerConfig(env = process.env, { randomBytes = crypto.randomBytes } = {}) {
  const host = String(env.HVAC_HOST || '127.0.0.1').trim().toLowerCase();
  if (!ALLOWED_BIND_HOSTS.has(host)) {
    throw configurationError('HVAC_HOST must be 127.0.0.1, ::1, localhost, or 0.0.0.0.');
  }
  const port = parsePort(env.HVAC_PORT);
  const lanMode = host === '0.0.0.0';
  const suppliedToken = String(env.HVAC_DEMO_TOKEN || '');
  if (lanMode && !isStrongToken(suppliedToken)) {
    throw configurationError(`LAN demo mode requires HVAC_DEMO_TOKEN with at least ${MIN_DEMO_TOKEN_LENGTH} non-whitespace characters, including a letter and a number or symbol.`);
  }
  if (!lanMode && suppliedToken && !isStrongToken(suppliedToken)) {
    throw configurationError(`HVAC_DEMO_TOKEN, when provided, must have at least ${MIN_DEMO_TOKEN_LENGTH} non-whitespace characters, including a letter and a number or symbol.`);
  }
  const token = suppliedToken || randomBytes(24).toString('base64url');
  return Object.freeze({
    host,
    port,
    lanMode,
    token,
    allowedHostnames: Object.freeze(parseAllowedHosts(env.HVAC_ALLOWED_HOSTS)),
  });
}

function splitHostHeader(value, expectedPort) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || /[\s,/@\\]/.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  const explicitPort = parsed.port ? Number(parsed.port) : 80;
  if (explicitPort !== expectedPort) return null;
  return { hostname: parsed.hostname.toLowerCase(), host: parsed.host.toLowerCase() };
}

function isPrivateIpv4(hostname) {
  if (net.isIP(hostname) !== 4) return false;
  const octets = hostname.split('.').map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254)
    || octets[0] === 127;
}

function isPrivateIpv6(hostname) {
  if (net.isIP(hostname) !== 6) return false;
  const normalized = hostname.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

export function validateRequestHost(hostHeader, config) {
  const parsed = splitHostHeader(hostHeader, config.port);
  if (!parsed) return { ok: false };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const configured = config.allowedHostnames.includes(hostname);
  const permitted = config.lanMode
    ? configured || hostname === 'localhost' || isPrivateIpv4(hostname) || isPrivateIpv6(hostname)
    : configured || LOOPBACK_BIND_HOSTS.has(hostname);
  return permitted ? { ok: true, canonicalHost: parsed.host } : { ok: false };
}

function constantTimeTokenMatch(provided, expected) {
  const providedHash = crypto.createHash('sha256').update(String(provided)).digest();
  const expectedHash = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

export function validateRequestContext({ headers = {} }, config) {
  const hostCheck = validateRequestHost(headers.host, config);
  if (!hostCheck.ok) return { ok: false, status: 403, code: 'REQUEST_DENIED' };

  const origin = headers.origin;
  if (origin) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      return { ok: false, status: 403, code: 'REQUEST_DENIED' };
    }
    if (parsedOrigin.protocol !== 'http:' || parsedOrigin.origin.toLowerCase() !== `http://${hostCheck.canonicalHost}`) {
      return { ok: false, status: 403, code: 'REQUEST_DENIED' };
    }
  }
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return { ok: false, status: 403, code: 'REQUEST_DENIED' };
  }

  return { ok: true };
}

export function authorizeApiRequest({ headers = {} } = {}, config) {
  const context = validateRequestContext({ headers }, config);
  if (!context.ok) return context;

  const match = /^Bearer ([^\s]+)$/.exec(String(headers.authorization || ''));
  if (!match || !constantTimeTokenMatch(match[1], config.token)) {
    return { ok: false, status: 401, code: 'AUTHENTICATION_REQUIRED' };
  }
  return { ok: true };
}

export function isLoopbackRemoteAddress(address) {
  const normalized = String(address || '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

export function canBootstrapLocalSession({ headers = {}, socket = {} } = {}, config) {
  if (config.lanMode || !headers.origin || !isLoopbackRemoteAddress(socket.remoteAddress)) return false;
  return validateRequestContext({ headers }, config).ok;
}

export function securityHeaders({ api = false } = {}) {
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
  };
  if (!api) {
    headers['content-security-policy'] = "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'";
  }
  return headers;
}

export function startupMessages(config) {
  if (config.lanMode) {
    return [
      `Newway HVAC MVP listening on http://0.0.0.0:${config.port}`,
      'LAN DEMO ONLY: trusted Wi-Fi only; this is not a public-internet or production deployment.',
      `Open http://<this-computer-LAN-IP>:${config.port} and enter the shared temporary token.`,
      'The token is intentionally not printed. Press Ctrl-C to stop the demo server.',
    ];
  }
  return [
    `Newway HVAC MVP listening on http://${config.host}:${config.port}`,
    'Local-only mode. The browser obtains an ephemeral session only from the loopback interface.',
  ];
}

export const networkSecurityConstants = Object.freeze({ MIN_DEMO_TOKEN_LENGTH });
