import fs from 'node:fs/promises';
import path from 'node:path';

const tunnelOrigin = process.argv[2];
const tunnel = new URL(tunnelOrigin);
if (tunnel.protocol !== 'https:' || tunnel.origin !== tunnelOrigin
  || !/^[a-z0-9-]+\.trycloudflare\.com$/u.test(tunnel.hostname)) {
  throw new Error('A live HTTPS TryCloudflare origin is required.');
}
const config = JSON.parse(await fs.readFile(path.resolve('data/settings/public-demo.json'), 'utf8'));
Object.assign(process.env, {
  HVAC_HOST: '127.0.0.1',
  HVAC_PORT: String(config.port),
  HVAC_PUBLIC_API_HOST: tunnel.hostname,
  HVAC_PUBLIC_FRONTEND_ORIGIN: config.frontendOrigin,
  HVAC_PUBLIC_USER: config.user,
  HVAC_PUBLIC_PASSWORD_HASH: config.passwordHash,
  HVAC_SESSION_SECRET: config.sessionSecret,
  HVAC_OLLAMA_MODEL: config.ollamaModel,
});
const { startServer } = await import('../src/server.js');
await startServer();
