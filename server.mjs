// Usage widget: serves rate-limit + context gauges for Claude Code and Codex.
// Data sources (all local, no network):
//   Claude limits  -> ~/.claude/usage-cache.json
//   Claude context -> newest ~/.claude/projects/**/*.jsonl (last assistant usage)
//   Codex both     -> newest ~/.codex/sessions/**/*.jsonl (last token_count event)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT || 7373);
const CORS_ORIGIN = process.env.CCMETER_CORS_ORIGIN || '';

// Scanning ~50k session files is slow, so the newest-file lookup is cached.
const SCAN_TTL_MS = 30_000;
const scanCache = new Map();

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

function credentialsMtime() {
  try { return fs.statSync(CLAUDE_CREDS).mtimeMs; } catch { return 0; }
}

function cacheMtime() {
  try { return fs.statSync(CLAUDE_CACHE).mtimeMs; } catch { return 0; }
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
  blockedCredentialsMtimeMs = credentialsMtime();
  blockedCacheMtimeMs = cacheMtime();
  lastRefreshError = 'auth_required';
  nextAllowedAt = 0;
  failures = 0;
  saveBackoff();
}

function clearRefreshFailure() {
  authRequired = false;
  blockedCredentialsMtimeMs = 0;
  blockedCacheMtimeMs = 0;
  lastRefreshError = null;
  nextAllowedAt = 0;
  failures = 0;
  saveBackoff();
}

async function refreshClaudeUsage(force = false) {
  if (refreshing) return;
  if (authRequired) {
    const credentialsChanged = credentialsMtime() > blockedCredentialsMtimeMs;
    const cacheChanged = hasNewReadableCache();
    if (!credentialsChanged && !cacheChanged) return;
    clearRefreshFailure();
    lastRefreshAttemptAt = 0;
  }
  if (Date.now() < nextAllowedAt) return;
  if (force && Date.now() - lastRefreshAttemptAt < MANUAL_REFRESH_COOLDOWN_MS) return;

  let age = Infinity;
  try { age = Date.now() - fs.statSync(CLAUDE_CACHE).mtimeMs; } catch { /* no cache yet */ }
  if (!force && age < REFRESH_TTL_MS) return;
  lastRefreshAttemptAt = Date.now();

  let token;
  try {
    token = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8'))?.claudeAiOauth?.accessToken;
  } catch { markAuthRequired(); return; }
  if (!token) { markAuthRequired(); return; }

  // Exclusive create, with stale-lock recovery for interrupted refreshes.
  try {
    fs.writeFileSync(CLAUDE_LOCK, String(Date.now()), { flag: 'wx' });
  } catch {
    try {
      if (Date.now() - fs.statSync(CLAUDE_LOCK).mtimeMs < 30_000) return; // someone else is fetching
      fs.unlinkSync(CLAUDE_LOCK);
      fs.writeFileSync(CLAUDE_LOCK, String(Date.now()), { flag: 'wx' });
    } catch { return; }
  }

  refreshing = true;
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
      return;
    }
    if (!res.ok || parsed?.error) {
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
    } else if (parsed) {
      fs.writeFileSync(CLAUDE_CACHE, text);
      clearRefreshFailure();
    } else {
      throw new Error('invalid usage response');
    }
  } catch (e) {
    lastRefreshError = String(e.name || e.message || e);
    failures += 1;
    nextAllowedAt = Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** (failures - 1));
    saveBackoff();
  } finally {
    refreshing = false;
    try { fs.unlinkSync(CLAUDE_LOCK); } catch { /* already gone */ }
  }
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
  return out;
}

function codexSection() {
  const installed = fs.existsSync(CODEX_SESSIONS);
  const out = { id: 'codex', name: 'Codex', installed, limits: [], stale_ms: null, error: null };
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
      flat.push({ mins: w.window_minutes, resets_at: w.resets_at || 0, pct: w.used_percent, at: c.at });
    }
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
      label: mins === 300 ? '5-hour' : mins === 10080 ? 'Weekly' : Math.round(mins / 60) + '-hour',
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

function payload() {
  return {
    generated_at: new Date().toISOString(),
    sections: [claudeSection(), codexSection()],
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/usage.json') {
    const manual = new URL(req.url, 'http://127.0.0.1').searchParams.get('refresh') === '1';
    if (manual) await refreshClaudeUsage(true);
    // Normal polls answer from the cache immediately. A manual refresh waits
    // for the one allowed API attempt, so the button reflects its result.
    else refreshClaudeUsage();
    let body;
    try { body = JSON.stringify(payload()); }
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
server.listen(PORT, () => console.log('usage widget on http://localhost:' + PORT));

export { PORT };
