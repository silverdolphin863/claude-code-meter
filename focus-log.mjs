// Finished focus blocks from the panel, kept locally and optionally sent to a
// webhook the user configures in focus-webhook.json next to the app settings:
//   { "url": "https://example.com/hook", "headers": { "Authorization": "Bearer ..." } }
// Only blocks the panel completed in full are recorded; skip and reset never are.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FOCUS_BLOCK_SECONDS = 25 * 60;
const KEEP_DAYS = 14;
const DUPLICATE_WINDOW_MS = 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const SEND_TIMEOUT_MS = 10 * 1000;

// The panel advances to the break before it reports "done", so a finished
// focus block arrives with the break as its phase.
export function isFinishedFocusBlock(event) {
  return Boolean(event) && event.event === 'done' && (event.phase === 'short' || event.phase === 'long');
}

export function addBlock(blocks, endedAtMs, id = crypto.randomUUID()) {
  const last = blocks.at(-1);
  if (last && endedAtMs - Date.parse(last.endedAt) < DUPLICATE_WINDOW_MS) return { blocks, added: null };
  const cutoff = endedAtMs - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const block = {
    id,
    startedAt: new Date(endedAtMs - FOCUS_BLOCK_SECONDS * 1000).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    seconds: FOCUS_BLOCK_SECONDS,
    sent: false,
  };
  const kept = blocks.filter((b) => Date.parse(b.endedAt) >= cutoff || !b.sent);
  return { blocks: [...kept, block], added: block };
}

export function readWebhook(file) {
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const url = new URL(String(config.url || ''));
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    const headers = {};
    for (const [key, value] of Object.entries(config.headers || {})) {
      if (/^[A-Za-z0-9-]{1,64}$/.test(key) && typeof value === 'string' && value.length <= 512) headers[key] = value;
    }
    return { url: url.toString(), headers };
  } catch {
    return null;
  }
}

export class FocusLog {
  constructor({ dir, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.file = path.join(dir, 'focus-blocks.json');
    this.webhookFile = path.join(dir, 'focus-webhook.json');
    this.fetch = fetchImpl;
    this.now = now;
    this.sending = null;
    this.timer = null;
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.blocks) ? data.blocks : [];
    } catch {
      return [];
    }
  }

  write(blocks) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ blocks }, null, 2));
    fs.renameSync(temp, this.file);
  }

  record(event) {
    if (!isFinishedFocusBlock(event)) return null;
    const { blocks, added } = addBlock(this.read(), this.now());
    if (!added) return null;
    this.write(blocks);
    this.flush().catch(() => {});
    return added;
  }

  start() {
    if (this.timer) return;
    this.flush().catch(() => {});
    this.timer = setInterval(() => this.flush().catch(() => {}), RETRY_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One send at a time; unsent blocks stay queued until the webhook answers 2xx.
  flush() {
    if (!this.sending) this.sending = this.sendPending().finally(() => { this.sending = null; });
    return this.sending;
  }

  async sendPending() {
    const webhook = readWebhook(this.webhookFile);
    if (!webhook || typeof this.fetch !== 'function') return 0;
    let sent = 0;
    for (const block of this.read().filter((b) => !b.sent)) {
      let ok = false;
      try {
        const response = await this.fetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...webhook.headers },
          body: JSON.stringify({
            type: 'focus-block',
            id: block.id,
            startedAt: block.startedAt,
            endedAt: block.endedAt,
            seconds: block.seconds,
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        ok = response.ok;
      } catch {
        ok = false;
      }
      if (!ok) break;
      this.write(this.read().map((b) => (b.id === block.id ? { ...b, sent: true } : b)));
      sent += 1;
    }
    return sent;
  }
}
