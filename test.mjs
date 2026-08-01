import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccmeter-clean-install-'));
const claude = path.join(root, '.claude');
const codex = path.join(root, '.codex', 'sessions', 'fixture');
await fs.mkdir(codex, { recursive: true });
await fs.mkdir(claude, { recursive: true });
const now = Date.now();
await fs.writeFile(path.join(claude, 'usage-cache.json'), JSON.stringify({
  limits: [{ kind: 'session', percent: 12, resets_at: new Date(now + 3600000).toISOString(), severity: 'normal', is_active: true }],
}));
await fs.writeFile(path.join(codex, 'session.jsonl'), JSON.stringify({
  timestamp: new Date().toISOString(),
  payload: { rate_limits: {
    primary: { used_percent: 23, window_minutes: 300, resets_at: Math.floor((now + 3600000) / 1000) },
    secondary: { used_percent: 41, window_minutes: 10080, resets_at: Math.floor((now + 86400000) / 1000) },
  } },
}) + '\n');
const port = 17373 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, CCMETER_HOME: root, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
try {
  const deadline = Date.now() + 5000;
  let response;
  while (!response && Date.now() < deadline) {
    try { response = await fetch(`http://127.0.0.1:${port}/usage.json`); }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert(response, `server did not start: ${output}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.json();
  const claudeSection = body.sections.find((section) => section.id === 'claude');
  const codexSection = body.sections.find((section) => section.id === 'codex');
  assert.equal(claudeSection.installed, true);
  assert.equal(claudeSection.limits[0].percent, 12);
  assert.equal(codexSection.installed, true);
  assert.deepEqual(codexSection.limits.map((limit) => limit.percent), [23, 41]);
  const manual = await fetch(`http://127.0.0.1:${port}/usage.json?refresh=1`);
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).sections.find((section) => section.id === 'claude').limits[0].percent, 12);
  console.log('clean-install fixture: PASS');
} finally {
  child.kill();
  await fs.rm(root, { recursive: true, force: true });
}
