import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, 'dist', 'netlify');

function apiOrigin(value) {
  const input = String(value || '');
  let url;
  try { url = new URL(input); } catch { throw new Error('NETLIFY_API_ORIGIN must be a public HTTPS origin.'); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (input !== input.trim() || /\s/u.test(input) || url.protocol !== 'https:' ||
      !hostname.includes('.') || net.isIP(hostname) || hostname === 'localhost' ||
      hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('NETLIFY_API_ORIGIN must be a public HTTPS origin without a path, credentials, query, or fragment.');
  }
  return url.origin;
}

try {
  await fs.rm(output, { recursive: true, force: true });
  const origin = apiOrigin(process.env.NETLIFY_API_ORIGIN);
  await fs.cp(path.join(root, 'web'), output, { recursive: true });
  await fs.writeFile(path.join(output, '_redirects'), [
    `/api/*  ${origin}/api/:splat  200`,
    `/session-bootstrap  ${origin}/session-bootstrap  200`,
    `/report-download/*  ${origin}/report-download/:splat  200`,
    '',
  ].join('\n'));
  console.log(`Netlify frontend built in ${path.relative(root, output)}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
