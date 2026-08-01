import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccmeter-clean-install-'));
const claude = path.join(root, '.claude');
const codex = path.join(root, '.codex', 'sessions', 'fixture');
await fs.mkdir(codex, { recursive: true });
await fs.mkdir(claude, { recursive: true });
const now = Date.now();
const credentials = path.join(claude, '.credentials.json');
await fs.writeFile(credentials, JSON.stringify({
  claudeAiOauth: { accessToken: 'expired-test-token' },
}));
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
const mockPort = 19373 + Math.floor(Math.random() * 1000);
let mockAuthorized = false;
let mockRequests = 0;
const mockUsageApi = http.createServer((_req, res) => {
  mockRequests++;
  if (!mockAuthorized) {
    res.setHeader('Content-Type', 'text/plain');
    res.writeHead(401);
    res.end('unauthorized');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({
    limits: [{
      kind: 'session', percent: 34,
      resets_at: new Date(now + 3600000).toISOString(),
      severity: 'normal', is_active: true,
    }],
  }));
});
await new Promise((resolve) => mockUsageApi.listen(mockPort, '127.0.0.1', resolve));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    CCMETER_HOME: root,
    CCMETER_USAGE_API: `http://127.0.0.1:${mockPort}/usage`,
    PORT: String(port),
  },
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
  const expired = (await manual.json()).sections.find((section) => section.id === 'claude');
  assert.equal(expired.limits[0].percent, 12);
  assert.equal(expired.auth_required, true);
  assert.equal(mockRequests, 1);

  await fetch(`http://127.0.0.1:${port}/usage.json?refresh=1`);
  assert.equal(mockRequests, 1, 'auth state must not retry an unchanged expired token');

  await fs.writeFile(path.join(claude, 'usage-cache.json'), '{broken');
  const brokenCacheChangedAt = new Date(Date.now() + 1000);
  await fs.utimes(path.join(claude, 'usage-cache.json'), brokenCacheChangedAt, brokenCacheChangedAt);
  const brokenCacheResponse = await fetch(`http://127.0.0.1:${port}/usage.json`);
  const brokenCache = (await brokenCacheResponse.json()).sections
    .find((section) => section.id === 'claude');
  assert.equal(brokenCache.auth_required, true);
  assert.equal(mockRequests, 1, 'a corrupt cache must not clear auth state');

  await fs.writeFile(path.join(claude, 'usage-cache.json'), JSON.stringify({
    limits: [{
      kind: 'session', percent: 18,
      resets_at: new Date(now + 3600000).toISOString(),
      severity: 'normal', is_active: true,
    }],
  }));
  const cacheChangedAt = new Date(Date.now() + 2000);
  await fs.utimes(path.join(claude, 'usage-cache.json'), cacheChangedAt, cacheChangedAt);
  const externalRecoveryResponse = await fetch(`http://127.0.0.1:${port}/usage.json`);
  const externalRecovery = (await externalRecoveryResponse.json()).sections
    .find((section) => section.id === 'claude');
  assert.equal(externalRecovery.auth_required, false);
  assert.equal(externalRecovery.limits[0].percent, 18);
  assert.equal(mockRequests, 1, 'a fresh external cache must clear auth without another API call');

  const secondFailureResponse = await fetch(`http://127.0.0.1:${port}/usage.json?refresh=1`);
  const secondFailure = (await secondFailureResponse.json()).sections
    .find((section) => section.id === 'claude');
  assert.equal(secondFailure.auth_required, true);
  assert.equal(mockRequests, 2);

  mockAuthorized = true;
  await fs.writeFile(credentials, JSON.stringify({
    claudeAiOauth: { accessToken: 'renewed-test-token' },
  }));
  const changedAt = new Date(Date.now() + 3000);
  await fs.utimes(credentials, changedAt, changedAt);
  const recoveredResponse = await fetch(`http://127.0.0.1:${port}/usage.json?refresh=1`);
  const recovered = (await recoveredResponse.json()).sections.find((section) => section.id === 'claude');
  assert.equal(recovered.auth_required, false);
  assert.equal(recovered.limits[0].percent, 34);
  assert.equal(mockRequests, 3);
  await fetch(`http://127.0.0.1:${port}/usage.json?refresh=1`);
  assert.equal(mockRequests, 3, 'successful manual refreshes must keep the click cooldown');
  console.log('clean-install fixture: PASS');
} finally {
  child.kill();
  await new Promise((resolve) => mockUsageApi.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
