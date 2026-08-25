import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { constrainCompactBounds } from './window-geometry.mjs';
import { HardwareDisplayController, encodeHardwareUsage, parseHardwareMessage, usageContentKey } from './hardware-display.mjs';

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

assert.deepEqual(parseHardwareMessage('{"type":"ack"}'), { type: 'ack' });
assert.equal(parseHardwareMessage('not json'), null);
assert.equal(encodeHardwareUsage({ schema: 1 }), '{"type":"usage","data":{"schema":1}}');
{
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const writes = [];
  const controller = new HardwareDisplayController({
    bridgePath: 'unused-in-unit-test',
    loadUsage: async (manual) => {
      calls.push(manual);
      if (calls.length === 1) await firstBlocked;
      return { schema: 1, manual };
    },
  });
  controller.child = { stdin: { writable: true, write: (line) => writes.push(line) } };
  const periodic = controller.sendUsage(false);
  await Promise.resolve();
  await controller.sendUsage(true);
  releaseFirst();
  await periodic;
  assert.deepEqual(calls, [false, true], 'a tap during a periodic send must be replayed as manual');
  assert.equal(writes.length, 2, 'both the periodic payload and queued manual payload must reach USB');
}
const NEWLINE = String.fromCharCode(10);
{
  // The board answers an unparseable payload with {"type":"error"}. That reply
  // used to be parsed and then dropped, so a corrupted transfer was
  // indistinguishable from an unplugged cable: the panel stayed blank and the
  // app reported nothing at all. The reply proves the device is talking.
  const writes = [];
  const states = [];
  const controller = new HardwareDisplayController({
    bridgePath: 'unused-in-unit-test',
    loadUsage: async () => ({ schema: 1 }),
    onChange: (state) => states.push(state),
  });
  controller.child = { stdin: { writable: true, write: (line) => writes.push(line) } };

  controller.consumeStdout('{"type":"error","error":"invalid_usage"}' + NEWLINE);
  const afterReject = states.at(-1);
  assert.equal(afterReject.deviceSeen, true, 'an error reply proves the display is present');
  assert.match(afterReject.error, /rejected/i, 'a rejected update must be surfaced, not swallowed');

  // It must resend rather than leave the panel blank until the next poll.
  await new Promise((resolve) => setTimeout(resolve, 2400));
  assert.equal(writes.length, 1, 'a rejected update must be resent');

  // A later ack clears the error and restores the retry budget.
  controller.consumeStdout('{"type":"ack"}' + NEWLINE);
  assert.equal(controller.rejectRetries, 0, 'an ack must reset the retry budget');
  assert.equal(states.at(-1).error, null, 'an ack must clear the rejection notice');
  controller.stop();
}
{
  // The panel used to be written every 30 seconds regardless of whether anything
  // had changed, which left it up to half a minute behind the widget. It now
  // checks at the widget's cadence and writes only when the panel would actually
  // draw something different. Timestamps and the cache age must not count as a
  // change, or every check would write and nothing would be saved.
  const writes = [];
  let current = { server_time_ms: 1, generated_at: 'a', sections: [
    { id: 'claude', name: 'Claude Code', stale_ms: 10, limits: [{ label: 'Weekly, all models', percent: 91, reset_label: 'in 2h' }] },
  ] };
  const controller = new HardwareDisplayController({
    bridgePath: 'unused-in-unit-test',
    loadUsage: async () => current,
  });
  controller.child = { stdin: { writable: true, write: (line) => writes.push(line) } };

  await controller.sendUsage(false);
  assert.equal(writes.length, 1, 'the first payload must always be written');

  await controller.sendUsage(false);
  assert.equal(writes.length, 1, 'an unchanged payload must not be written again');

  current = { ...current, server_time_ms: 2, generated_at: 'b',
    sections: [{ ...current.sections[0], stale_ms: 999,
      limits: [{ ...current.sections[0].limits[0], reset_label: 'in 1h' }] }] };
  await controller.sendUsage(false);
  assert.equal(writes.length, 1, 'clock stamps, cache age and the reset label must not count as a change');

  current = { ...current, sections: [{ ...current.sections[0],
    limits: [{ ...current.sections[0].limits[0], percent: 92 }] }] };
  await controller.sendUsage(false);
  assert.equal(writes.length, 2, 'a changed percentage must reach the panel');

  await controller.sendUsage(true);
  assert.equal(writes.length, 3, 'a refresh tap must always be answered, even with unchanged data');

  // A rejected payload never arrived, so it must not be suppressed as a duplicate.
  controller.retryAfterReject();
  assert.equal(controller.lastKey, null, 'a rejection must clear the delivered-content marker');
  controller.stop();
}
assert.equal(
  usageContentKey({ server_time_ms: 1, x: 5 }),
  usageContentKey({ server_time_ms: 2, x: 5 }),
  'the content key must ignore volatile fields',
);
const serverSource = await fs.readFile(new URL('./server.mjs', import.meta.url), 'utf8');
// A window whose reset time has passed is dropped rather than shown with the
// previous window's percentage. On the plain 10 minute cadence that left the
// gauge missing for most of that window, which reads as "no data" on both the
// widget and the hardware panel. A visibly reset window must shorten the wait.
assert.match(serverSource, /cacheHasExpiredWindow\(\) \? EXPIRED_WINDOW_REFRESH_MS : REFRESH_TTL_MS/,
  'a reset window must refresh sooner than the normal cadence');
assert.match(serverSource, /EXPIRED_WINDOW_REFRESH_MS = 120_000/,
  'the shortened refresh must keep a floor so clock skew cannot cause a poll loop');
// The session-log fallback is derived from older Codex formats and can describe
// windows the current plan no longer has: a Pro account reports a single weekly
// window, while old logs still carry a 5-hour one. The widget re-polls every ten
// seconds and corrects itself, but the panel is fed once on connect and then
// every thirty seconds, so a wrong row sticks on the glass. It must wait for live data.
assert.match(serverSource, /source: 'pending'/,
  'a cold Codex cache must report no windows rather than log-derived ones the plan may not have');
assert.doesNotMatch(serverSource, /payload\(manual, true\)/,
  'the panel must not block on a cold Codex query: it delayed the first panel update by 23 seconds');
const bridgeSource = await fs.readFile(new URL('./scripts/hardware-display-bridge.ps1', import.meta.url), 'utf8');
assert.match(bridgeSource, /WriteChunkSize = 16/, 'USB bridge must pace serial writes in small chunks');
assert.match(bridgeSource, /Thread\.Sleep\(WritePauseMs\)/, 'USB bridge must pause between serial chunks');
const firmwareMainSource = await fs.readFile(new URL('./firmware/esp32-4848s040/src/main.cpp', import.meta.url), 'utf8');
assert.match(firmwareMainSource, /Serial\.setRxBufferSize\(kSerialRxBufferBytes\)/,
  'firmware must enlarge its UART receive buffer before starting serial');
assert.match(firmwareMainSource, /x >= kUiRefreshTouchLeft && x < kUiRefreshTouchRight/,
  'refresh touch handling must use the same shared geometry as the drawn icon');
assert.match(firmwareMainSource, /x >= kUiSettingsTouchLeft && x <= kUiSettingsTouchRight[\s\S]*configPortal\.begin/,
  'the top-right settings target must open the optional Wi-Fi setup portal');
assert.match(firmwareMainSource, /if \(configPortal\.active\(\)\) \{\s*configPortal\.stop\(\);\s*if \(deviceConfig\.configured\(\)\) beginWifi\(\);/,
  'a second settings tap must close setup even when optional Wi-Fi was never configured');
assert.doesNotMatch(firmwareMainSource, /if \(configPortal\.active\(\)\) configPortal\.stop\(\);\s*applyUsageSnapshot\(nextSnapshot, true\);/,
  'routine USB payloads must not close setup and partially paint meter rows over it');
assert.match(firmwareMainSource, /serialRefreshPending = true;[\s\S]*refreshDynamicNow\(\)/,
  'a serial refresh tap must display immediate feedback while waiting for the host');
assert.match(firmwareMainSource, /else if \(completedSerialRefresh\) requestDynamicRender\(\);/,
  'refresh feedback must clear even when the returned percentages are unchanged');
assert.match(firmwareMainSource, /serviceSerialRefreshTimeout\(\);/,
  'refresh feedback must clear if the host never answers');
assert.match(firmwareMainSource, /if \(due\(nextRenderAt, millis\(\)\)\) refreshDynamicNow\(\);/,
  'the one-minute timer must use the partial dynamic repaint path');
assert.match(firmwareMainSource, /if \(fullRenderPending\) \{\s*drawNow\(\);/,
  'structural changes must still request a complete render');
assert.match(firmwareMainSource, /if \(layoutChanged \|\| currentUiState\(\) != previousUiState\) requestFullRender\(\);\s*else if \(visibleDataChanged\) requestSnapshotRender\(\);/,
  'ordinary usage changes must use partial rendering when the card layout is unchanged');
const firmwareUiSource = await fs.readFile(new URL('./firmware/esp32-4848s040/src/ui.cpp', import.meta.url), 'utf8');
const firmwareUiHeaderSource = await fs.readFile(new URL('./firmware/esp32-4848s040/src/ui.h', import.meta.url), 'utf8');
const touchBottom = Number(/kUiHeaderTouchBottom = (\d+)/.exec(firmwareUiHeaderSource)?.[1]);
const touchLeft = Number(/kUiRefreshTouchLeft = (\d+)/.exec(firmwareUiHeaderSource)?.[1]);
assert.ok(touchBottom >= 60 && touchLeft <= 370,
  'the physical refresh target must be substantially larger than its visible glyph');
assert.match(firmwareUiSource, /drawRefreshIcon\(kUiRefreshIconCenterX/,
  'refresh rendering must use the shared touch-aligned icon position');
assert.match(firmwareUiSource, /millis\(\) \/ kUiRefreshAnimationFrameMs[\s\S]*phaseDegrees[\s\S]*fillArc\([^;]+phaseDegrees[\s\S]*fillRotatedTriangle/,
  'the active LCD refresh arrows must rotate as one glyph');
assert.doesNotMatch(firmwareUiSource, /kOrbit[XY]|fillCircle\(centerX \+ kOrbit/,
  'the active LCD refresh icon must not use a separate orbiting dot');
assert.match(firmwareUiHeaderSource, /kUiRefreshAnimationFrameMs = 100;/,
  'the LCD refresh animation must use the preview-matched frame interval');
assert.match(firmwareMainSource, /nextRefreshAnimationAt = millis\(\) \+ kUiRefreshAnimationFrameMs;[\s\S]*serviceRefreshAnimation\(\);/,
  'refresh animation frames must be scheduled while the host request is pending');
assert.match(firmwareMainSource, /void serviceRefreshAnimation\(\)[\s\S]*uiRefreshHeader/,
  'refresh animation must publish only the LCD header region');
const headerLabelBlock = /const char\* headerStateLabel\(UiState state\) \{([\s\S]*?)\n\}/.exec(firmwareUiSource)?.[1];
assert.ok(headerLabelBlock, 'firmware must define compact labels specifically for the LCD header');
const headerLabels = [...headerLabelBlock.matchAll(/return "([A-Z.]*)";/g)].map((match) => match[1]);
assert.ok(headerLabels.length >= 9 && headerLabels.every((label) => label.length <= 4),
  'every LCD header status must fit within the four-character status slot');
assert.match(firmwareUiSource, /kHeaderStatusMaxWidth = 24;/,
  'firmware must enforce the fixed-width LCD header status slot');
assert.match(firmwareUiSource, /smoothTextWidth\(kSmoothFont11, rawStatus\) <= kHeaderStatusMaxWidth[\s\S]*\? rawStatus[\s\S]*: "ERR";/,
  'an oversized future LCD header label must fall back before it can overlap freshness');
assert.match(firmwareUiSource, /display->flush\(\);/,
  'firmware must publish the LCD framebuffer only after composing a complete frame');
assert.match(firmwareUiSource, /void refreshLimitTime[\s\S]*displayFlushRect\(/,
  'minute-driven LCD changes must flush only the small regions that changed');
assert.match(firmwareUiSource, /void refreshLimitRow[\s\S]*drawLimitBar[\s\S]*displayFlushRect\(/,
  'partial snapshot updates must redraw usage bars without publishing the full screen');
assert.match(firmwareUiSource, /void uiRefreshSnapshot[\s\S]*refreshUiRegions\([^;]+true\);/,
  'new usage values must use the row-level snapshot repaint path');
const firmwareDisplaySource = await fs.readFile(new URL('./firmware/esp32-4848s040/src/display.cpp', import.meta.url), 'utf8');
assert.match(firmwareDisplaySource, /false \/\* auto_flush \*\//,
  'firmware RGB drawing must be batched to prevent periodic full-screen flashes');
assert.match(firmwareDisplaySource, /void displayFlushRect[\s\S]*Cache_WriteBack_Addr/,
  'partial LCD updates must write back only cache-aligned changed rows');
assert.match(firmwareDisplaySource,
  /x = static_cast<int16_t>\(map\(touch\.points\[0\]\.x, 480, 0, 0, gfx->width\(\) - 1\)\);/,
  'physical LCD left and right must map to visual left and right');
assert.match(firmwareDisplaySource,
  /y = static_cast<int16_t>\(map\(touch\.points\[0\]\.y, 480, 0, 0, gfx->height\(\) - 1\)\);/,
  'physical LCD top and bottom must map to visual top and bottom');
console.log('hardware display protocol: PASS');

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
  const bridge = pkg.build.extraResources?.find((item) => item.to === 'hardware-display-bridge.ps1');
  assert.equal(bridge?.from, 'scripts/hardware-display-bridge.ps1', 'USB bridge must be copied outside app.asar');
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
  limits: [
    { kind: 'session', percent: 12, resets_at: new Date(now + 3600000).toISOString(), severity: 'normal', is_active: true },
    // Already reset. Its percent belongs to the previous window and pace would
    // divide by a negative remaining time, so it must never reach the UI.
    { kind: 'weekly_all', percent: 91, resets_at: new Date(now - 3600000).toISOString(), severity: 'normal', is_active: false },
  ],
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
// Ports come from the OS, not from Math.random over a fixed range: a random
// pick landed on a port something else was already listening on and failed the
// whole suite with EADDRINUSE. Binding to port 0 asks the kernel for a port
// that is actually free right now.
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address().port;
      probe.close(() => resolve(assigned));
    });
  });
}
const port = await freePort();
const mockPort = await freePort();
const panelPort = await freePort();
const panelToken = 'test-panel-token-0123456789';
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
    CCMETER_PANEL_PORT: String(panelPort),
    CCMETER_PANEL_TOKEN: panelToken,
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
  assert.equal(claudeSection.limits.length, 1, 'an already-reset Claude window must be dropped, not shown with stale numbers');
  assert.equal(codexSection.installed, true);

  let panelUnauthorized;
  const panelDeadline = Date.now() + 5000;
  while (!panelUnauthorized && Date.now() < panelDeadline) {
    try { panelUnauthorized = await fetch(`http://127.0.0.1:${panelPort}/panel/v1/usage`); }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert(panelUnauthorized, 'hardware display endpoint did not start');
  assert.equal(panelUnauthorized.status, 401);
  const wrongPanelKey = await fetch(`http://127.0.0.1:${panelPort}/panel/v1/usage`, {
    headers: { Authorization: 'Bearer definitely-the-wrong-key' },
  });
  assert.equal(wrongPanelKey.status, 401);
  const unicodePanelKey = await fetch(`http://127.0.0.1:${panelPort}/panel/v1/usage`, {
    headers: { Authorization: `Bearer ${'é'.repeat(panelToken.length)}` },
  });
  assert.equal(unicodePanelKey.status, 401, 'equal character counts with different byte lengths must not throw');
  const panelResponse = await fetch(`http://127.0.0.1:${panelPort}/panel/v1/usage`, {
    headers: { Authorization: `Bearer ${panelToken}` },
  });
  assert.equal(panelResponse.status, 200);
  assert.equal(panelResponse.headers.get('access-control-allow-origin'), null);
  const panelBody = await panelResponse.json();
  assert.equal(panelBody.schema, 1);
  assert.equal(typeof panelBody.server_time_ms, 'number');
  assert.equal(typeof panelBody.sections[0].limits[0].resets_at_ms, 'number');
  assert.equal(typeof panelBody.sections[0].limits[0].reset_label, 'string');
  assert.match(panelBody.sections[0].limits[0].reset_label,
    /^(?:TODAY|SUN|MON|TUE|WED|THU|FRI|SAT) \d{2}:\d{2}$/,
    'LCD reset target must use the approved compact day and time format');
  const panelRoot = await fetch(`http://127.0.0.1:${panelPort}/`, {
    headers: { Authorization: `Bearer ${panelToken}` },
  });
  assert.equal(panelRoot.status, 404, 'the LAN listener must expose only the hardware usage endpoint');
  // The first poll must NOT wait for the live Codex query: a cold app-server
  // spawn took long enough that the whole widget, Claude included, sat blank
  // until it answered. So the opening response may legitimately come from the
  // session logs. The live numbers must then arrive on a following poll.
  let liveCodex = codexSection.source === 'live' ? codexSection : null;
  const liveDeadline = Date.now() + 5000;
  while (!liveCodex && Date.now() < liveDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const next = await (await fetch(`http://127.0.0.1:${port}/usage.json`)).json();
    const section = next.sections.find((s) => s.id === 'codex');
    if (section.source === 'live') liveCodex = section;
  }
  assert(liveCodex, 'live Codex snapshot never replaced the session-log fallback');
  assert.deepEqual(liveCodex.limits.map((limit) => limit.percent), [6]);
  assert.deepEqual(liveCodex.limits.map((limit) => limit.window_hours), [168]);
  assert.equal(liveCodex.limits[0].resets_at, new Date(liveCodexReset * 1000).toISOString());
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

  // Asking the OS, like the other three ports: the old port + 2000 guess
  // landed on busy ports and failed the suite with a server that never bound.
  const fallbackPort = await freePort();
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
