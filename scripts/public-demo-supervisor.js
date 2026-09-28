import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'data/settings/public-demo.json'), 'utf8'));
const cloudflared = '/opt/homebrew/bin/cloudflared';
const netlify = '/opt/homebrew/bin/netlify';
const node = process.execPath;
const baseEnv = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
  NETLIFY_SITE_ID: config.siteId };
let stopped = false;
let tunnel;
let api;
let activeOrigin = '';

function log(message) { console.log(`[public-demo] ${new Date().toISOString()} ${message}`); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function exitOf(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: -1, error }));
  });
}

async function run(command, args, env = baseEnv) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 32_000) output = output.slice(-32_000);
    });
  }
  const result = await exitOf(child);
  if (result.code !== 0) throw new Error(`${path.basename(command)} exited ${result.code}: ${output.slice(-1200)}`);
  return output;
}

async function backendReady(hostname) {
  for (let attempt = 0; attempt < 60 && !stopped; attempt += 1) {
    const status = await new Promise((resolve) => {
      const request = http.get({ hostname: '127.0.0.1', port: config.port, path: '/api/health',
        headers: { host: hostname }, timeout: 2000 }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve(0));
    });
    if (status === 401) return;
    await delay(500);
  }
  throw new Error('API did not become ready on its loopback port.');
}

async function deploy(origin) {
  const current = await run(netlify, ['env:get', 'NETLIFY_API_ORIGIN', '--context', 'production']);
  if (current.trim() !== origin) {
    await run(netlify, ['env:set', 'NETLIFY_API_ORIGIN', origin]);
  }
  await run('/opt/homebrew/bin/npm', ['run', 'build:netlify'], { ...baseEnv, NETLIFY_API_ORIGIN: origin });
  const deployed = await run(netlify, ['deploy', '--prod', '--dir', 'dist/netlify', '--no-build', '--json',
    '--site', config.siteId, '--message', `Public demo backend ${origin}`]);
  const result = JSON.parse(deployed.slice(deployed.indexOf('{')));
  if (result.url !== config.frontendOrigin) throw new Error('Netlify deployed to an unexpected frontend URL.');
  log(`Netlify production deploy ready at ${result.url} using ${origin}.`);
}

async function superviseOnce() {
  const address = `http://127.0.0.1:${config.port}`;
  tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', address],
    { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const tunnelExited = exitOf(tunnel);
  let announced = false;
  let outputBuffer = '';
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cloudflare did not assign a tunnel URL.')), 45_000);
    const onText = (chunk) => {
      outputBuffer = `${outputBuffer}${chunk.toString('utf8')}`.slice(-4096);
      const match = outputBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u);
      if (match && !announced) {
        announced = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    tunnel.stdout.on('data', onText);
    tunnel.stderr.on('data', onText);
    tunnel.once('error', reject);
    tunnel.once('exit', () => reject(new Error('Cloudflare tunnel exited before assigning a URL.')));
  });
  activeOrigin = origin;
  log(`Tunnel connected at ${origin}.`);
  api = spawn(node, [path.join(root, 'scripts/start-public-api.js'), origin],
    { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const apiExited = exitOf(api);
  api.stdout.on('data', (chunk) => process.stdout.write(chunk));
  api.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await backendReady(new URL(origin).hostname);
  log('API ready; updating Netlify production deployment.');
  for (let attempt = 0; !stopped; attempt += 1) {
    if (tunnel.exitCode !== null || tunnel.signalCode !== null || api.exitCode !== null || api.signalCode !== null) {
      throw new Error('Tunnel or API exited before deployment completed.');
    }
    try { await deploy(origin); break; }
    catch (error) {
      log(`Deploy attempt ${attempt + 1} failed: ${error.message}`);
      await delay(Math.min(30_000 * 2 ** attempt, 300_000));
    }
  }
  await Promise.race([tunnelExited, apiExited]);
  log(`Service exited while using ${activeOrigin}; restarting tunnel and API.`);
}

function stop() {
  stopped = true;
  api?.kill('SIGTERM');
  tunnel?.kill('SIGTERM');
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
while (!stopped) {
  try { await superviseOnce(); }
  catch (error) { log(error.message); }
  api?.kill('SIGTERM');
  tunnel?.kill('SIGTERM');
  if (!stopped) await delay(5000);
}
