// Pure parser and cache reader for Google Antigravity / Gemini quota snapshots.
// Primary live source: `agy -p "/usage" --output-format json` (`command.data.groups[]`).
// Also supports Antigravity CLI `/statusline` (`quota["gemini-5h"]`, `quota["gemini-weekly"]`),
// generic `groups[].buckets[]`, and native CC Meter `limits[]` cache files.
import fs from 'node:fs';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeGeminiPlan(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (/ultra/i.test(text)) return 'Ultra';
  if (/pro/i.test(text)) return 'Pro';
  if (/free/i.test(text)) return 'Free';
  if (/enterprise/i.test(text)) return 'Enterprise';
  return text.slice(0, 24);
}

function parseResetIso(entry, now) {
  const raw = entry?.resets_at ?? entry?.resetsAt ?? entry?.reset_time ?? entry?.resetTime;
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  } else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  const untilMs = Number(entry?.timeUntilResetMs ?? entry?.time_until_reset_ms);
  if (Number.isFinite(untilMs) && untilMs > 0) {
    return new Date(now + untilMs).toISOString();
  }
  const secs = Number(entry?.reset_in_seconds ?? entry?.resetInSeconds);
  if (Number.isFinite(secs) && secs > 0) {
    return new Date(now + secs * 1000).toISOString();
  }
  return null;
}

function parseUsedPercent(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const used = entry.used_percent ?? entry.usedPercent ?? entry.percent;
  if (typeof used === 'number' && Number.isFinite(used)) {
    return Math.round(clamp(used, 0, 100));
  }
  const remFraction = entry.remaining_fraction ?? entry.remainingFraction;
  if (typeof remFraction === 'number' && Number.isFinite(remFraction)) {
    const frac = remFraction > 1 && remFraction <= 100 ? remFraction / 100 : remFraction;
    return Math.round(clamp((1 - clamp(frac, 0, 1)) * 100, 0, 100));
  }
  const remPercent = entry.remaining_percent ?? entry.remainingPercent;
  if (typeof remPercent === 'number' && Number.isFinite(remPercent)) {
    return Math.round(clamp(100 - clamp(remPercent, 0, 100), 0, 100));
  }
  return null;
}

function inferWindowSpec(entry, fallbackKey = '') {
  const explicitHours = Number(entry?.window_hours ?? entry?.windowHours);
  if (Number.isFinite(explicitHours) && explicitHours > 0) {
    if (explicitHours <= 6) return { key: '5h', label: '5-hour', window_hours: explicitHours };
    if (explicitHours >= 144 && explicitHours <= 192) {
      return { key: 'weekly', label: 'Weekly', window_hours: explicitHours };
    }
    return {
      key: `h-${explicitHours}`,
      label: entry?.label || `${explicitHours}-hour`,
      window_hours: explicitHours,
    };
  }
  const hint = [
    entry?.window,
    entry?.kind,
    entry?.bucketId,
    entry?.bucket_id,
    entry?.id,
    entry?.name,
    entry?.label,
    entry?.displayName,
    entry?.display_name,
    fallbackKey,
  ].filter(Boolean).join(' ');

  if (/\b(5[\s-]*h|5[\s-]*hour|five[\s-]*hour|session)\b|gemini[\s_-]*5h/i.test(hint)) {
    return { key: '5h', label: '5-hour', window_hours: 5 };
  }
  if (/\b(7[\s-]*d|7[\s-]*day|weekly|week)\b|gemini[\s_-]*(weekly|7d)/i.test(hint)) {
    return { key: 'weekly', label: 'Weekly', window_hours: 168 };
  }
  return null;
}

function addCandidate(byKey, spec, entry, now) {
  if (!spec) return;
  const percent = parseUsedPercent(entry);
  if (percent === null) return;
  const resetsAt = parseResetIso(entry, now);
  if (resetsAt && Date.parse(resetsAt) <= now) return;

  const existing = byKey.get(spec.key);
  if (!existing || percent > existing.percent) {
    byKey.set(spec.key, {
      label: spec.label,
      percent,
      resets_at: resetsAt,
      window_hours: spec.window_hours,
      severity: 'normal',
      active: spec.key === '5h',
    });
  }
}

function extractPlan(raw) {
  const candidates = [
    raw?.plan,
    raw?.plan_type,
    raw?.planType,
    raw?.tier,
    raw?.command?.data?.plan,
    raw?.command?.data?.tier,
    raw?.subscription?.plan,
    raw?.subscription?.tier,
    raw?.response?.plan,
    raw?.response?.tier,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeGeminiPlan(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function extractUpdatedAtMs(raw) {
  const stamp = raw?.updated_at ?? raw?.updatedAt ?? raw?.generated_at ?? raw?.generatedAt ?? raw?.timestamp;
  if (typeof stamp === 'string') {
    const ms = Date.parse(stamp);
    if (Number.isFinite(ms)) return ms;
  } else if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0) {
    return stamp > 1e12 ? stamp : stamp * 1000;
  }
  return null;
}

export function parseGeminiQuotaPayload(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;

  const byKey = new Map();

  // 1. Native CC Meter limits array
  if (Array.isArray(raw.limits)) {
    for (const item of raw.limits) {
      const spec = inferWindowSpec(item);
      if (spec) addCandidate(byKey, spec, item, now);
    }
  }

  // 2. Official Antigravity CLI /statusline `quota` map
  const quotaMap = raw.quota && typeof raw.quota === 'object' ? raw.quota : null;
  if (quotaMap) {
    for (const [key, value] of Object.entries(quotaMap)) {
      if (!value || typeof value !== 'object') continue;
      if (/^(3p|claude|gpt|external)/i.test(key)) continue;
      const spec = inferWindowSpec(value, key);
      addCandidate(byKey, spec, value, now);
    }
  }

  // 3. Official `agy -p "/usage" --output-format json` (`command.data.groups[]`)
  //    and generic `response.groups[]` / `groups[]`
  const groups = Array.isArray(raw.command?.data?.groups)
    ? raw.command.data.groups
    : Array.isArray(raw.response?.groups)
      ? raw.response.groups
      : Array.isArray(raw.groups)
        ? raw.groups
        : null;
  if (groups) {
    const geminiGroups = groups.filter((group) => {
      const text = `${group?.id || ''} ${group?.displayName || ''} ${group?.name || ''}`;
      return /gemini/i.test(text) && !/(claude|gpt|3p|external)/i.test(text);
    });
    for (const group of geminiGroups) {
      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      for (const bucket of buckets) {
        const spec = inferWindowSpec(bucket);
        addCandidate(byKey, spec, bucket, now);
      }
    }
  }

  const order = { '5h': 0, weekly: 1 };
  const limits = [...byKey.entries()]
    .sort((a, b) => (order[a[0]] ?? 99) - (order[b[0]] ?? 99) || a[1].window_hours - b[1].window_hours)
    .map(([, limit]) => limit);

  return {
    plan: extractPlan(raw),
    limits,
    updatedAtMs: extractUpdatedAtMs(raw),
  };
}

export function readGeminiCache(cachePath, now = Date.now()) {
  try {
    const stat = fs.statSync(cachePath);
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const parsed = parseGeminiQuotaPayload(raw, now);
    if (!parsed) return null;
    const referenceMs = parsed.updatedAtMs && parsed.updatedAtMs <= now ? parsed.updatedAtMs : stat.mtimeMs;
    return {
      ...parsed,
      stale_ms: Math.max(0, now - referenceMs),
    };
  } catch {
    return null;
  }
}
