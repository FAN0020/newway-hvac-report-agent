import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.access(path.join(root, 'data/settings/public-demo.json'));
const label = 'com.newway.hvac-public-demo';
const agents = path.join(os.homedir(), 'Library/LaunchAgents');
const plist = path.join(agents, `${label}.plist`);
const logs = path.join(root, 'data/logs');
await fs.mkdir(agents, { recursive: true });
await fs.mkdir(logs, { recursive: true, mode: 0o700 });
const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const values = [
  '/usr/bin/caffeinate', '-i', process.execPath,
  path.join(root, 'scripts/public-demo-supervisor.js'),
].map((value) => `<string>${escapeXml(value)}</string>`).join('');
const log = escapeXml(path.join(logs, 'public-demo.log'));
const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${values}</array>
<key>WorkingDirectory</key><string>${escapeXml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
await fs.writeFile(plist, contents, { mode: 0o600 });
const target = `gui/${process.getuid()}`;
try { execFileSync('/bin/launchctl', ['bootout', target, plist], { stdio: 'ignore' }); } catch {}
execFileSync('/bin/launchctl', ['bootstrap', target, plist], { stdio: 'inherit' });
execFileSync('/bin/launchctl', ['enable', `${target}/${label}`], { stdio: 'inherit' });
console.log(`Installed ${label}. Logs: ${path.join(logs, 'public-demo.log')}`);
