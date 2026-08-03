import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { constrainCompactBounds } from './window-geometry.mjs';

const workArea = { x: 100, y: 40, width: 1920, height: 1040 };
assert.deepEqual(
  constrainCompactBounds({ x: -600, y: 300, width: 1100, height: 29 }, workArea),
  { x: 100, y: 40, width: 1100, height: 29 },
);
assert.deepEqual(
  constrainCompactBounds({ x: 1800, y: -100, width: 1100, height: 29 }, workArea),
  { x: 920, y: 40, width: 1100, height: 29 },
);
assert.deepEqual(
  constrainCompactBounds({ x: 400, y: 80, width: 2000, height: 29 }, workArea),
  { x: 120, y: 40, width: 1900, height: 29 },
);
console.log('compact geometry: PASS');

// v1.0.6 shipped a package whose asar was missing updater.mjs, because
// build.files is a whitelist and the new module was never added to it. The app
// crashed on launch with ERR_MODULE_NOT_FOUND, and only in the packaged build,
// so every dev run looked fine. Walk main.mjs's local imports and assert each
// one would actually be packaged.
{
  const pkg = JSON.parse(await fs.readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const patterns = pkg.build.files.filter((p) => !p.startsWith('!'));
  const packaged = (file) => patterns.some((p) => {
    if (p === file) return true;
    const m = /^\*(\.[a-z]+)$/.exec(p); // "*.mjs" style top-level glob
    return Boolean(m) && file.endsWith(m[1]) && !file.includes('/');
  });

  const seen = new Set();
  const queue = ['main.mjs'];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = await fs.readFile(new URL('./' + file, import.meta.url), 'utf8');
    for (const m of src.matchAll(/^import[^'"]*['"](\.[^'"]+)['"]/gm)) {
      const dep = m[1].replace(/^\.\//, '');
      assert.ok(packaged(dep), `${dep} is imported by ${file} but build.files would not package it`);
      queue.push(dep);
    }
  }
  assert.ok(seen.has('updater.mjs'), 'expected updater.mjs in the import graph');
  console.log(`packaged imports (${seen.size} modules): PASS`);
}

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
const staleAt = now - 98 * 3600000;
await fs.writeFile(path.join(codex, 'session.jsonl'), JSON.stringify({
  timestamp: new Date(staleAt).toISOString(),
  payload: { rate_limits: {
    primary: { used_percent: 35, window_minutes: 300, resets_at: Math.floor((staleAt + 5 * 3600000) / 1000) },
    secondary: { used_percent: 97, window_minutes: 10080, resets_at: Math.floor((now - 24 * 3600000) / 1000) },
  } },
}) + '\n');
const liveCodexReset = Math.floor((now + 7 * 86400000) / 1000);
const fakeCodex = path.join(root, 'fake-codex.mjs');
await fs.writeFile(fakeCodex, `
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    console.log(JSON.stringify({ id: 1, result: {} }));
  } else if (message.id === 2 && message.method === 'account/rateLimits/read') {
    console.log(JSON.stringify({ id: 2, result: {
      rateLimits: {
        limitId: 'codex', limitName: null, planType: 'pro',
        primary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: ${liveCodexReset} },
        secondary: null,
      },
      rateLimitsByLimitId: {},
    } }));
  }
});
`);
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
    CCMETER_CODEX_COMMAND: process.execPath,
    CCMETER_CODEX_COMMAND_ARGS: JSON.stringify([fakeCodex]),
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let fallbackChild = null;
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
  assert.equal(codexSection.source, 'live');
  assert.deepEqual(codexSection.limits.map((limit) => limit.percent), [6]);
  assert.deepEqual(codexSection.limits.map((limit) => limit.window_hours), [168]);
  assert.equal(codexSection.limits[0].resets_at, new Date(liveCodexReset * 1000).toISOString());
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

  const fallbackPort = port + 2000;
  fallbackChild = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      CCMETER_HOME: root,
      CCMETER_USAGE_API: `http://127.0.0.1:${mockPort}/usage`,
      CCMETER_CODEX_LIVE: '0',
      PORT: String(fallbackPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fallbackResponse;
  const fallbackDeadline = Date.now() + 5000;
  while (!fallbackResponse && Date.now() < fallbackDeadline) {
    try { fallbackResponse = await fetch(`http://127.0.0.1:${fallbackPort}/usage.json`); }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert(fallbackResponse, 'fallback server did not start');
  const fallbackCodex = (await fallbackResponse.json()).sections
    .find((section) => section.id === 'codex');
  assert.equal(fallbackCodex.source, 'session-log');
  assert.deepEqual(fallbackCodex.limits, []);
  assert.equal(fallbackCodex.error, 'no current rate_limits in recent sessions');
  console.log('clean-install fixture: PASS');
} finally {
  child.kill();
  fallbackChild?.kill();
  await new Promise((resolve) => mockUsageApi.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
