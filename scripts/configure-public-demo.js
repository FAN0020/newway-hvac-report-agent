import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const frontendOrigin = process.argv[2];
const siteId = process.argv[3];
const model = process.argv[4] || 'qwen3:4b-instruct';
if (!frontendOrigin || !siteId) {
  throw new Error('Usage: node scripts/configure-public-demo.js <https://site.netlify.app> <site-id> [ollama-model]');
}
const frontend = new URL(frontendOrigin);
if (frontend.protocol !== 'https:' || frontend.origin !== frontendOrigin || frontend.pathname !== '/' || frontend.search || frontend.hash) {
  throw new Error('The frontend must be an exact HTTPS origin.');
}
if (!/^[a-f0-9-]{36}$/i.test(siteId)) throw new Error('A Netlify project ID is required.');
const directory = path.resolve('data', 'settings');
const configFile = path.join(directory, 'public-demo.json');
const credentialsFile = path.join(directory, 'public-demo-operator.txt');
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
try {
  await fs.stat(configFile);
  throw new Error('Public demo is already configured. Existing credentials were preserved.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const password = crypto.randomBytes(18).toString('base64url');
const salt = crypto.randomBytes(16);
const config = {
  frontendOrigin,
  siteId,
  port: 4311,
  user: 'operator',
  passwordHash: `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`,
  sessionSecret: crypto.randomBytes(32).toString('base64url'),
  ollamaModel: model,
};
await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
await fs.writeFile(credentialsFile, `URL: ${frontendOrigin}\nUsername: ${config.user}\nPassword: ${password}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Public demo configuration created at ${configFile}. Operator credentials saved locally at ${credentialsFile}.`);
