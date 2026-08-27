// Usage widget: serves rate-limit + context gauges for Claude Code and Codex.
// Data sources:
//   Claude limits  -> Anthropic usage API with ~/.claude/usage-cache.json
//   Claude context -> newest ~/.claude/projects/**/*.jsonl (last assistant usage)
//   Codex limits   -> installed Codex app-server account/rateLimits/read
//   Codex fallback -> newest ~/.codex/sessions/**/*.jsonl (last token_count event)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.CCMETER_HOME || os.homedir();
const CLAUDE_CACHE = path.join(HOME, '.claude', 'usage-cache.json');
const CLAUDE_LOCK = CLAUDE_CACHE + '.lock';
const CLAUDE_CREDS = path.join(HOME, '.claude', '.credentials.json');
const USAGE_API = process.env.CCMETER_USAGE_API || 'https://api.anthropic.com/api/oauth/usage';
// The usage endpoint's limit is UNDOCUMENTED. The only measurement we have is a
// 429 carrying Retry-After 3433s, i.e. an hourly bucket, ceiling unknown. 90s
// here meant ~960 calls/day and locked the account out for 18 hours. 10 minutes
// is 6 calls/hour, far below any plausible ceiling, and costs nothing: these
// windows are 5 hours and 7 days long.
const REFRESH_TTL_MS = 600_000;
const MANUAL_REFRESH_COOLDOWN_MS = 60_000;
// Backoff state outlives the process on purpose: restarting the widget while
// locked out must not hand it a fresh licence to hammer the endpoint.
const BACKOFF_FILE = path.join(HOME, '.claude', '.ccmeter-refresh.json');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(APP_ROOT, 'public');
let APP_VERSION = 'unknown';
try {
  APP_VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || APP_VERSION;
} catch { /* a missing package manifest must not prevent the meter from starting */ }
const PORT = Number(process.env.PORT || 7373);
const CORS_ORIGIN = process.env.CCMETER_CORS_ORIGIN || '';
const DEFAULT_PANEL_PORT = Number(process.env.CCMETER_PANEL_PORT || 7374);

let panelServer = null;
let panelState = {
  enabled: false,
  listening: false,
  port: DEFAULT_PANEL_PORT,
  token: '',
  error: null,
  lastSeen: null,
  lastAddress: null,
};

// Scanning ~50k session files is slow, so the newest-file lookup is cached.
const SCAN_TTL_MS = 30_000;
const scanCache = new Map();

// Current Codex versions expose the account-wide snapshot through the local
// app-server protocol. Cache it so UI polling does not launch a process or hit
// the account endpoint on every request.
const CODEX_LIVE_TTL_MS = 300_000;
const CODEX_LIVE_RETRY_MS = 60_000;
const CODEX_LIVE_MAX_STALE_MS = 900_000;
const CODEX_LIVE_TIMEOUT_MS = 10_000;
const CODEX_LIVE_ENABLED = process.env.CCMETER_CODEX_LIVE !== '0';
const codexLiveCache = { snapshot: null, at: 0, error: null, errorAt: 0, pending: null };

function findExecutable(name) {
  // npm installs both a POSIX shim without an extension and a Windows .cmd
  // launcher. The extensionless shim is not executable by CreateProcess.
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
    const cleanFolder = folder.replace(/^"|"$/g, '');
    if (!cleanFolder) continue;
    for (const extension of extensions) {
      const candidate = path.join(cleanFolder, name + extension);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function codexLaunch() {
  if (!CODEX_LIVE_ENABLED) return null;
  const override = process.env.CCMETER_CODEX_COMMAND || '';
  let command = override || findExecutable('codex');
  if (!command) return null;

  let prefixArgs = [];
  if (override && process.env.CCMETER_CODEX_COMMAND_ARGS) {
    try {
      const parsed = JSON.parse(process.env.CCMETER_CODEX_COMMAND_ARGS);
      if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === 'string')) prefixArgs = parsed;
    } catch { /* invalid test override, launch without prefix args */ }
  }

  // npm's Windows launcher adds an avoidable cmd.exe and Node wrapper. Use the
  // native binary when the standard global npm layout is available.
  if (!override && process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const triple = process.arch === 'arm64'
      ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const npmRoot = path.dirname(command);
    const candidates = [
      path.join(npmRoot, 'node_modules', '@openai', 'codex', 'node_modules',
        '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(npmRoot, 'node_modules', '@openai', 'codex', 'vendor',
        triple, 'bin', 'codex.exe'),
    ];
    const native = candidates.find((candidate) => fs.existsSync(candidate));
    if (native) command = native;
  }

  return {
    command,
    args: [...prefixArgs, 'app-server', '--stdio'],
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
  };
}

// Returns the `count` most recently modified matching files, newest first.
function newestFiles(dir, ext, count) {
  const key = dir + '|' + count;
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.value;
  const found = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        found.push({ path: p, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dir);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const value = found.slice(0, count);
  scanCache.set(key, { at: Date.now(), value });
  return value;
}


function tail(file, bytes = 1_000_000) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Extracts one balanced JSON object starting at the '{' on or after startIdx.
function objectAt(str, startIdx) {
  const open = str.indexOf('{', startIdx);
  if (open < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(str.slice(open, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function labelFor(limit) {
  if (limit.kind === 'session') return '5-hour';
  if (limit.kind === 'weekly_all') return 'Weekly, all models';
  if (limit.kind === 'weekly_scoped') {
    return 'Weekly, ' + (limit.scope?.model?.display_name || 'scoped');
  }
  return limit.kind;
}

// Refresh the standard Claude Code cache directly. A status-line script may
// also write this file, so use the same lock protocol to avoid races.
let refreshing = false;
let lastRefreshError = null;
// The usage endpoint rate-limits HARD (observed: 429 with Retry-After 3433s).
// Retrying on the plain TTL while locked out kept us permanently 429'd and the
// cache went 18h stale. Never call again before this timestamp.
let nextAllowedAt = 0;
let failures = 0;
let lastRefreshAttemptAt = 0;
let authRequired = false;
let blockedCredentialsMtimeMs = 0;
let blockedCacheMtimeMs = 0;
// How long the widget may sit on "Login expired" before it re-probes anyway.
let authBlockedAt = 0;
const AUTH_RECHECK_MS = 15 * 60_000;

function credentialsMtime() {
  try { return fs.statSync(CLAUDE_CREDS).mtimeMs; } catch { return 0; }
}

function cacheMtime() {
  try { return fs.statSync(CLAUDE_CACHE).mtimeMs; } catch { return 0; }
}

// A window whose reset time has passed carries a percentage from the window
// before it, so it gets dropped rather than shown as if it were current. That
// leaves a hole in the display until the next refresh, and on the normal 10
// minute cadence the gauge can be missing for most of that. Treat a visibly
// reset window as a reason to refresh sooner, with a floor so a server clock
// skew cannot turn this into a poll loop.
const EXPIRED_WINDOW_REFRESH_MS = 120_000;

function cacheHasExpiredWindow() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_CACHE, 'utf8'));
    const now = Date.now();
    return (raw.limits || []).some((limit) => limit.resets_at &&
      new Date(limit.resets_at).getTime() <= now);
  } catch {
    return false;
  }
}

function hasNewReadableCache() {
  if (cacheMtime() <= blockedCacheMtimeMs) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_CACHE, 'utf8'));
    return Boolean(parsed && typeof parsed === 'object');
  } catch { return false; }
}

try {
  const saved = JSON.parse(fs.readFileSync(BACKOFF_FILE, 'utf8'));
  const savedError = String(saved.error || '');
  const backoffMtimeMs = fs.statSync(BACKOFF_FILE).mtimeMs;
  // Migrate the old behavior that treated 401 like a transient outage. Auth
  // failures wait for credentials to change instead of sleeping for an hour.
  if (saved.authRequired || savedError === 'auth_required' || savedError.includes('api 401')) {
    const savedCredentialsMtimeMs = Number(saved.credentialsMtimeMs) || 0;
    const savedCacheMtimeMs = Number(saved.cacheMtimeMs) || 0;
    const recoveredAfterLegacyFailure = !savedCredentialsMtimeMs && !savedCacheMtimeMs
      && Math.max(credentialsMtime(), cacheMtime()) > backoffMtimeMs;
    if (!recoveredAfterLegacyFailure) {
      authRequired = true;
      // Continue the re-probe clock from when the lockout was written, so a
      // restart neither resets it nor probes on every poll.
      authBlockedAt = backoffMtimeMs || Date.now();
      blockedCredentialsMtimeMs = savedCredentialsMtimeMs || credentialsMtime();
      blockedCacheMtimeMs = savedCacheMtimeMs || cacheMtime();
      lastRefreshError = 'auth_required';
    }
  } else if (Number(saved.nextAllowedAt) > Date.now()) {
    nextAllowedAt = Number(saved.nextAllowedAt);
    failures = Number(saved.failures) || 1;
    lastRefreshError = savedError || 'rate limited';
  }
} catch { /* no prior lockout */ }

function saveBackoff() {
  try {
    fs.writeFileSync(BACKOFF_FILE, JSON.stringify({
      nextAllowedAt, failures, error: lastRefreshError,
      authRequired, credentialsMtimeMs: blockedCredentialsMtimeMs,
      cacheMtimeMs: blockedCacheMtimeMs,
    }));
  } catch { /* best effort */ }
}

function markAuthRequired() {
  authRequired = true;
  authBlockedAt = Date.now();
  blockedCredentialsMtimeMs = credentialsMtime();
  blockedCacheMtimeMs = cacheMtime();
  lastRefreshError = 'auth_required';
  nextAllowedAt = 0;
  failures = 0;
  saveBackoff();
}

function clearRefreshFailure() {
  authRequired = false;
  authBlockedAt = 0;
  blockedCredentialsMtimeMs = 0;
  blockedCacheMtimeMs = 0;
  lastRefreshError = null;
  nextAllowedAt = 0;
  failures = 0;
  saveBackoff();
}

async function refreshClaudeUsage(force = false) {
  if (refreshing) return 'busy';
  if (authRequired) {
    const credentialsChanged = credentialsMtime() > blockedCredentialsMtimeMs;
    const cacheChanged = hasNewReadableCache();
    // Waiting for the credentials file to change is the right default, since
    // retrying a token the server just rejected only burns a rate limit. But
    // it is not sufficient: a re-login can leave the mtime equal (same-second
    // rewrite, or the CLI refreshing in place), and then the widget claims
    // "Login expired" forever while `claude auth status` says logged in.
    // So re-probe on a slow timer as a floor. NOT `>=` on the mtime: when the
    // file is unchanged the two are equal, so that would retry every poll.
    const overdue = Date.now() - authBlockedAt >= AUTH_RECHECK_MS;
    if (!credentialsChanged && !cacheChanged && !overdue) return 'auth';
    clearRefreshFailure();
    lastRefreshAttemptAt = 0;
  }
  if (Date.now() < nextAllowedAt) return 'blocked';
  if (force && Date.now() - lastRefreshAttemptAt < MANUAL_REFRESH_COOLDOWN_MS) return 'cooldown';

  let age = Infinity;
  try { age = Date.now() - fs.statSync(CLAUDE_CACHE).mtimeMs; } catch { /* no cache yet */ }
  const minAge = cacheHasExpiredWindow() ? EXPIRED_WINDOW_REFRESH_MS : REFRESH_TTL_MS;
  if (!force && age < minAge) return 'cached';
  lastRefreshAttemptAt = Date.now();

  let token;
  try {
    token = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8'))?.claudeAiOauth?.accessToken;
  } catch { markAuthRequired(); return 'auth'; }
  if (!token) { markAuthRequired(); return 'auth'; }

  // Exclusive create, with stale-lock recovery for interrupted refreshes.
  try {
    fs.writeFileSync(CLAUDE_LOCK, String(Date.now()), { flag: 'wx' });
  } catch {
    try {
      if (Date.now() - fs.statSync(CLAUDE_LOCK).mtimeMs < 30_000) return 'busy'; // someone else is fetching
      fs.unlinkSync(CLAUDE_LOCK);
      fs.writeFileSync(CLAUDE_LOCK, String(Date.now()), { flag: 'wx' });
    } catch { return 'busy'; }
  }

  refreshing = true;
  let outcome = 'failed';
  try {
    const res = await fetch(USAGE_API, {
      headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }
    if (res.status === 401 || res.status === 403) {
      markAuthRequired();
      outcome = 'auth';
    } else if (!res.ok || parsed?.error) {
      lastRefreshError = 'api ' + res.status;
      // Obey Retry-After when the server states one, else back off
      // exponentially from 5 minutes up to an hour.
      const ra = Number(res.headers.get('retry-after'));
      failures += 1;
      const backoff = Number.isFinite(ra) && ra > 0
        ? (ra + 5) * 1000
        : Math.min(60 * 60_000, 5 * 60_000 * 2 ** (failures - 1));
      nextAllowedAt = Date.now() + backoff;
      lastRefreshError += ' (retrying in ' + Math.round(backoff / 60_000) + 'm)';
      saveBackoff();
      outcome = 'blocked';
    } else if (parsed) {
      fs.writeFileSync(CLAUDE_CACHE, text);
      clearRefreshFailure();
      outcome = 'updated';
    } else {
      throw new Error('invalid usage response');
    }
  } catch (e) {
    lastRefreshError = String(e.name || e.message || e);
    failures += 1;
    nextAllowedAt = Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** (failures - 1));
    saveBackoff();
    outcome = 'failed';
  } finally {
    refreshing = false;
    try { fs.unlinkSync(CLAUDE_LOCK); } catch { /* already gone */ }
  }
  return outcome;
}

function claudeSection() {
  // Installed = an OAuth login exists (the API needs it) or a usage cache does.
  const installed = fs.existsSync(CLAUDE_CREDS) || fs.existsSync(CLAUDE_CACHE);
  const out = {
    id: 'claude', name: 'Claude Code', installed, limits: [], stale_ms: null,
    error: null, auth_required: authRequired,
  };
  if (!installed) { out.error = 'Claude Code not detected'; return out; }
  try {
    const st = fs.statSync(CLAUDE_CACHE);
    out.stale_ms = Date.now() - st.mtimeMs;
    const raw = JSON.parse(fs.readFileSync(CLAUDE_CACHE, 'utf8'));
    for (const l of raw.limits || []) {
      // Drop windows that have already reset. Their percent is a leftover from
      // the previous window, and pace divides by elapsed time, so a reset time
      // in the past yields a confident, wrong number (this is exactly how a
      // stale cache once showed "25% 0.3x" for a window that ended 18h ago).
      // The Codex path already filters these; Claude's did not.
      if (l.resets_at && new Date(l.resets_at).getTime() <= Date.now()) continue;
      out.limits.push({
        label: labelFor(l),
        percent: l.percent,
        resets_at: l.resets_at,
        // Pace needs the window length; Claude does not state it, but `session`
        // is the 5-hour window and every `weekly_*` kind is the 7-day one.
        window_hours: l.kind === 'session' ? 5 : 168,
        severity: l.severity || 'normal',
        active: Boolean(l.is_active),
      });
    }
  } catch (e) {
    out.error = 'usage-cache.json unreadable: ' + e.code;
  }
  if (authRequired) out.refresh_error = 'auth_required';
  else if (lastRefreshError && out.stale_ms >= REFRESH_TTL_MS) out.refresh_error = lastRefreshError;
  // When the API has us locked out, the UI needs the release time, not just the
  // error string: a refresh click during the lockout is refused on purpose (one
  // call into a live 429 window restarts it), and refusing without saying when
  // it becomes worth clicking again reads as a broken button.
  if (nextAllowedAt > Date.now()) out.refresh_blocked_until = nextAllowedAt;
  return out;
}

function requestCodexLiveSnapshot() {
  const launch = codexLaunch();
  if (!launch) return Promise.reject(new Error('Codex CLI not found'));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        shell: launch.shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('Codex app-server timed out')), CODEX_LIVE_TIMEOUT_MS);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* process already closed */ }
      const killTimer = setTimeout(() => {
        try { if (!child.killed) child.kill(); } catch { /* already gone */ }
      }, 500);
      killTimer.unref?.();
      if (error) reject(error);
      else resolve(result);
    }

    function send(message) {
      if (!settled) child.stdin.write(JSON.stringify(message) + '\n');
    }

    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (!settled) finish(new Error(`Codex app-server exited before replying (${code})`));
    });
    child.stdin.once('error', (error) => finish(error));
    // Consume diagnostics so a noisy CLI cannot fill the stderr pipe and
    // block the protocol response. Error details are intentionally not shown
    // because they may contain local paths or account metadata.
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 1_048_576) {
        finish(new Error('Codex app-server response exceeded 1 MB'));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }

        if (message.id === 1) {
          if (message.error) return finish(new Error('Codex app-server initialization failed'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: null });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error('Codex rate-limit request failed'));
          const result = message.result || {};
          const aggregate = result.rateLimits || result.rateLimitsByLimitId?.codex;
          if (!aggregate) return finish(new Error('Codex returned no account rate limits'));
          finish(null, result);
        }
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'cc-meter', version: APP_VERSION } },
    });
  });
}

function cachedCodexLive(now = Date.now()) {
  if (!codexLiveCache.snapshot || now - codexLiveCache.at >= CODEX_LIVE_MAX_STALE_MS) return null;
  return { snapshot: codexLiveCache.snapshot, at: codexLiveCache.at };
}

async function liveCodexSnapshot(force = false) {
  if (!CODEX_LIVE_ENABLED) return null;
  const now = Date.now();
  const age = now - codexLiveCache.at;
  const freshEnough = codexLiveCache.snapshot && age < CODEX_LIVE_TTL_MS;
  if (freshEnough && (!force || age < MANUAL_REFRESH_COOLDOWN_MS)) {
    return { snapshot: codexLiveCache.snapshot, at: codexLiveCache.at };
  }
  if (codexLiveCache.error && now - codexLiveCache.errorAt < CODEX_LIVE_RETRY_MS) {
    return cachedCodexLive(now);
  }
  if (codexLiveCache.pending) return codexLiveCache.pending;

  codexLiveCache.pending = requestCodexLiveSnapshot()
    .then((snapshot) => {
      codexLiveCache.snapshot = snapshot;
      codexLiveCache.at = Date.now();
      codexLiveCache.error = null;
      codexLiveCache.errorAt = 0;
      return { snapshot, at: codexLiveCache.at };
    })
    .catch((error) => {
      codexLiveCache.error = error.message || 'Codex live query failed';
      codexLiveCache.errorAt = Date.now();
      return cachedCodexLive(codexLiveCache.errorAt);
    })
    .finally(() => { codexLiveCache.pending = null; });
  return codexLiveCache.pending;
}

function resetSeconds(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number > 1_000_000_000_000 ? Math.floor(number / 1000) : Math.floor(number);
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function codexWindowLabel(minutes) {
  return minutes === 300 ? '5-hour'
    : minutes === 10080 ? 'Weekly'
      : Math.round(minutes / 60) + '-hour';
}

function normalizedCodexWindow(window) {
  if (!window) return null;
  const percent = Number(window.usedPercent ?? window.used_percent);
  const minutes = Number(window.windowDurationMins ?? window.window_minutes);
  const resets = resetSeconds(window.resetsAt ?? window.resets_at);
  if (!Number.isFinite(percent) || !minutes || !resets || resets * 1000 <= Date.now()) return null;
  return {
    label: codexWindowLabel(minutes),
    percent: Math.round(percent),
    resets_at: new Date(resets * 1000).toISOString(),
    window_hours: minutes / 60,
    severity: 'normal',
    active: false,
  };
}

function codexSectionFromLive(live) {
  const result = live.snapshot;
  const limits = result.rateLimits || result.rateLimitsByLimitId?.codex;
  const out = {
    id: 'codex', name: 'Codex', installed: true, limits: [],
    stale_ms: Math.max(0, Date.now() - live.at), error: null, source: 'live',
  };
  for (const window of [limits.primary, limits.secondary]) {
    const normalized = normalizedCodexWindow(window);
    if (normalized) out.limits.push(normalized);
  }
  if (!out.limits.length) out.error = 'no active Codex rate-limit window';
  out.plan = limits.planType ?? limits.plan_type ?? null;
  out.limit_name = limits.limitName ?? limits.limit_name ?? null;
  return out;
}

function codexSectionFromLogs() {
  const installed = fs.existsSync(CODEX_SESSIONS);
  const out = {
    id: 'codex', name: 'Codex', installed, limits: [],
    stale_ms: null, error: null, source: 'session-log',
  };
  if (!installed) { out.error = 'Codex not detected'; return out; }
  const files = newestFiles(CODEX_SESSIONS, '.jsonl', 8);
  if (!files.length) {
    out.error = 'no codex sessions found';
    return out;
  }

  // Several Codex sessions run concurrently and a freshly started one logs a
  // ZEROED rate_limits block with a current timestamp, so neither newest-file
  // nor newest-event is trustworthy on its own. Usage only climbs within a
  // window, so merge every recent block and take the max per reset window.
  const cands = [];
  for (const f of files) {
    let lines;
    try { lines = tail(f.path).split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (!o?.payload?.rate_limits) continue;
      cands.push({ at: Date.parse(o.timestamp || '') || 0, rl: o.payload.rate_limits, info: o.payload.info });
      break;
    }
  }
  if (!cands.length) {
    out.error = 'no rate_limits in recent sessions';
    return out;
  }
  cands.sort((a, b) => b.at - a.at);
  out.stale_ms = Date.now() - cands[0].at;

  // Individual sessions occasionally emit a bogus zeroed block carrying a reset
  // date 7 days out, so recency alone picks the wrong value. Concurrent sessions
  // all report the same account-wide pool, so trust the CONSENSUS reset window
  // (most reporters wins, newest breaks ties) and take the max within it.
  const flat = [];
  for (const c of cands) {
    for (const key of ['primary', 'secondary']) {
      const w = c.rl[key];
      if (!w || typeof w.used_percent !== 'number' || !w.window_minutes) continue;
      const resets = resetSeconds(w.resets_at);
      // A historical percentage is not a current limit. This is the exact
      // failure that made a 98-hour-old Kongou snapshot look active.
      if (!resets || resets * 1000 <= Date.now()) continue;
      flat.push({ mins: w.window_minutes, resets_at: resets, pct: w.used_percent, at: c.at });
    }
  }
  if (!flat.length) {
    out.error = 'no current rate_limits in recent sessions';
    return out;
  }

  const windows = new Map(); // window_minutes -> winning group
  for (const mins of new Set(flat.map((e) => e.mins))) {
    const groups = new Map(); // resets_at -> {count, pct, at}
    for (const e of flat.filter((x) => x.mins === mins)) {
      const g = groups.get(e.resets_at) || { count: 0, pct: 0, at: 0 };
      g.count++;
      g.pct = Math.max(g.pct, e.pct);
      g.at = Math.max(g.at, e.at);
      groups.set(e.resets_at, g);
    }
    const [resets_at, g] = [...groups].sort(
      (a, b) => b[1].count - a[1].count || b[1].at - a[1].at,
    )[0];
    windows.set(mins, { used_percent: g.pct, resets_at, reporters: g.count });
  }

  for (const [mins, w] of [...windows].sort((a, b) => a[0] - b[0])) {
    out.limits.push({
      label: codexWindowLabel(mins),
      percent: Math.round(w.used_percent),
      resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
      window_hours: mins / 60,
      severity: 'normal',
      active: false, // Codex has one shared pool, so no window is "the active" one
    });
  }

  out.plan = cands.find((c) => c.rl.plan_type)?.rl.plan_type || null;
  out.limit_name = cands.find((c) => c.rl.limit_name)?.rl.limit_name || null;

  return out;
}

async function codexSection(forceLive = false) {
  // Never block the response on a cold live query. Spawning the Codex
  // app-server takes seconds, and because this payload carries BOTH tools, an
  // await here left the whole widget blank on startup, Claude included, for as
  // long as Codex took to answer. Warm polls are ~3ms; only the first one was
  // slow, which is exactly when the widget looks broken.
  //
  // So: a manual refresh still waits (the user asked, and the button shows a
  // wait cursor), and a warm cache is used as before. A cold cache starts the
  // query in the background and answers from the session logs right now; the
  // live numbers land on the next poll a few seconds later.
  //
  // Waiting here was tried for the hardware panel and made its first update
  // arrive 23 seconds after connecting, because a cold Codex app-server can
  // take that long. Reporting no Codex windows until the live answer lands is
  // both faster and honest, and the panel picks the real numbers up on its next
  // check a few seconds later.
  const canWait = forceLive || codexLiveCache.snapshot;
  const live = canWait ? await liveCodexSnapshot(forceLive) : null;
  if (!canWait) {
    liveCodexSnapshot(false); // fire and forget, it caches itself
    // While that first query is in flight, report no windows rather than the
    // log-derived ones. A missing gauge for one second is honest; a gauge for a
    // window the plan does not have is not, and the logs still describe a
    // 5-hour Codex window that a Pro account no longer reports.
    if (codexLaunch() && !codexLiveCache.error) {
      return {
        id: 'codex', name: 'Codex', installed: true, limits: [],
        stale_ms: null, error: null, source: 'pending',
      };
    }
  }
  if (live) return codexSectionFromLive(live);

  const fallback = codexSectionFromLogs();
  if (!fallback.installed && codexLaunch()) fallback.installed = true;
  if (!fallback.limits.length && codexLiveCache.error) fallback.error = 'live Codex usage unavailable';
  return fallback;
}

async function payload(forceCodex = false) {
  return {
    generated_at: new Date().toISOString(),
    sections: [claudeSection(), await codexSection(forceCodex)],
  };
}

async function refreshedPayload() {
  // Claude and Codex are independent sources. Waiting for them in sequence can
  // take almost the LCD's full 20-second animation timeout, after which a valid
  // answer looks like no answer. Run both refreshes together and tell the panel
  // whether Claude was updated or deliberately refused for safety.
  const [status, codex] = await Promise.all([
    refreshClaudeUsage(true),
    codexSection(true),
  ]);
  const manualRefresh = { status: status || 'failed' };
  if (status === 'cooldown') manualRefresh.retry_at = lastRefreshAttemptAt + MANUAL_REFRESH_COOLDOWN_MS;
  else if (status === 'blocked' && nextAllowedAt > Date.now()) manualRefresh.retry_at = nextAllowedAt;
  return {
    generated_at: new Date().toISOString(),
    manual_refresh: manualRefresh,
    sections: [claudeSection(), codex],
  };
}

function safeTokenEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function getPanelServerStatus() {
  return {
    enabled: panelState.enabled,
    listening: panelState.listening,
    port: panelState.port,
    error: panelState.error,
    lastSeen: panelState.lastSeen,
    lastAddress: panelState.lastAddress,
  };
}

function panelResetLabel(resetIso) {
  if (!resetIso) return '';
  const date = new Date(resetIso);
  if (!Number.isFinite(date.getTime())) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return `TODAY ${hours}:${minutes}`;
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return `${days[date.getDay()]} ${hours}:${minutes}`;
}

function panelPayload(data) {
  return {
    schema: 1,
    server_time_ms: Date.now(),
    ...data,
    sections: data.sections.map((section) => ({
      ...section,
      limits: section.limits.map((limit) => ({
        ...limit,
        resets_at_ms: Number.isFinite(Date.parse(limit.resets_at))
          ? Date.parse(limit.resets_at)
          : null,
        reset_label: panelResetLabel(limit.resets_at),
      })),
    })),
  };
}

async function getPanelUsage(manual = false) {
  if (manual) return panelPayload(await refreshedPayload());
  refreshClaudeUsage();
  return panelPayload(await payload(false));
}

async function handlePanelRequest(req, res) {
  const url = new URL(req.url, 'http://panel.local');
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET', Connection: 'close' });
    return res.end('method not allowed');
  }
  if (url.pathname !== '/panel/v1/usage') {
    res.writeHead(404, { Connection: 'close' });
    return res.end('not found');
  }

  const authorization = String(req.headers.authorization || '');
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!safeTokenEqual(panelState.token, supplied)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  panelState.lastSeen = new Date().toISOString();
  panelState.lastAddress = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '') || null;
  const manual = url.searchParams.get('refresh') === '1';

  try {
    const body = JSON.stringify(await getPanelUsage(manual));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Connection: 'close',
      'X-CCMeter-Schema': '1',
    });
    return res.end(body);
  } catch {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    return res.end(JSON.stringify({ error: 'usage unavailable' }));
  }
}

async function stopPanelServer() {
  const active = panelServer;
  panelServer = null;
  panelState.listening = false;
  if (!active) return;
  active.closeAllConnections?.();
  await new Promise((resolve) => active.close(() => resolve()));
}

async function configurePanelServer(options = {}) {
  const enabled = Boolean(options.enabled);
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  const requestedPort = Number(options.port || DEFAULT_PANEL_PORT);
  const port = Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535
    ? requestedPort
    : DEFAULT_PANEL_PORT;

  if (enabled && panelServer && panelState.listening &&
      panelState.port === port && panelState.token === token) {
    return getPanelServerStatus();
  }

  await stopPanelServer();
  panelState = {
    enabled,
    listening: false,
    port,
    token,
    error: null,
    lastSeen: null,
    lastAddress: null,
  };
  if (!enabled) return getPanelServerStatus();
  if (token.length < 16 || token.length > 256) {
    panelState.error = 'invalid panel access key';
    return getPanelServerStatus();
  }

  const instance = http.createServer((req, res) => {
    handlePanelRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { Connection: 'close' });
      res.end();
    });
  });
  const started = await new Promise((resolve) => {
    const onError = (error) => resolve({ ok: false, error });
    instance.once('error', onError);
    instance.listen(port, '0.0.0.0', () => {
      instance.off('error', onError);
      resolve({ ok: true });
    });
  });
  if (!started.ok) {
    panelState.error = String(started.error?.code || started.error?.message || 'could not listen');
    try { instance.close(); } catch { /* nothing to close */ }
    return getPanelServerStatus();
  }

  panelServer = instance;
  panelState.listening = true;
  instance.on('error', (error) => {
    panelState.error = String(error.code || error.message || 'panel server error');
    panelState.listening = false;
  });
  console.log('hardware display endpoint on port ' + port);
  return getPanelServerStatus();
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/usage.json') {
    const manual = new URL(req.url, 'http://127.0.0.1').searchParams.get('refresh') === '1';
    let body;
    try {
      if (manual) body = JSON.stringify(await refreshedPayload());
      else {
        // Normal polls answer from the cache immediately. A manual refresh waits
        // for the one allowed API attempt, so the button reflects its result.
        refreshClaudeUsage();
        body = JSON.stringify(await payload(false));
      }
    }
    catch (e) { res.writeHead(500); return res.end(String(e)); }
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    };
    if (CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    res.writeHead(200, headers);
    return res.end(body);
  }

  const file = path.join(PUBLIC, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// The Electron shell imports this module to self-host. If a standalone
// `npm run serve` already owns the port, reuse it instead of crashing.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log('port ' + PORT + ' already serving, reusing it');
  else throw e;
});
// Loopback by default: this endpoint reports how heavily you use your AI
// subscriptions, which is nobody else's business on a shared network. Node
// binds every interface when no host is given, so it must be explicit.
// Set CCMETER_HOST=0.0.0.0 to expose it deliberately, e.g. to drive a panel
// on another device.
const HOST = process.env.CCMETER_HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log('usage widget on http://localhost:' + PORT);
  // Start the Codex query while the window is still opening, so the live
  // numbers are usually cached by the time the first poll arrives.
  liveCodexSnapshot(false);
});

if (process.env.CCMETER_PANEL_TOKEN) {
  configurePanelServer({
    enabled: true,
    token: process.env.CCMETER_PANEL_TOKEN,
    port: DEFAULT_PANEL_PORT,
  }).catch(() => {});
}

export { PORT, configurePanelServer, getPanelServerStatus, getPanelUsage };
