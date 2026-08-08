import { spawn } from 'node:child_process';

const POLL_MS = 30_000;
const RESTART_MS = 5_000;

export function encodeHardwareUsage(data) {
  return JSON.stringify({ type: 'usage', data });
}

export function parseHardwareMessage(line) {
  if (typeof line !== 'string' || line.length === 0 || line.length > 4096) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && typeof value.type === 'string' ? value : null;
  } catch {
    return null;
  }
}

export class HardwareDisplayController {
  constructor({ bridgePath, loadUsage, onChange = () => {} }) {
    this.bridgePath = bridgePath;
    this.loadUsage = loadUsage;
    this.onChange = onChange;
    this.config = { enabled: false, transport: 'usb', serialPort: 'auto' };
    this.child = null;
    this.pollTimer = null;
    this.restartTimer = null;
    this.stdout = '';
    this.sending = false;
    this.sendingManual = false;
    this.pendingManual = false;
    this.state = {
      transport: 'usb',
      connected: false,
      deviceSeen: false,
      serialPort: null,
      firmware: null,
      model: null,
      lastSeen: null,
      lastSent: null,
      error: null,
    };
  }

  status() {
    return { ...this.state };
  }

  emit(patch = {}) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.status());
  }

  async configure(config = {}) {
    const next = {
      enabled: Boolean(config.enabled),
      transport: config.transport === 'wifi' ? 'wifi' : 'usb',
      serialPort: typeof config.serialPort === 'string' && /^(auto|COM\d+)$/i.test(config.serialPort)
        ? config.serialPort
        : 'auto',
    };
    const changed = next.transport !== this.config.transport ||
      next.serialPort.toUpperCase() !== this.config.serialPort.toUpperCase();
    this.config = next;
    if (!next.enabled || next.transport !== 'usb') {
      this.stop();
      this.emit({ transport: next.transport, connected: false, deviceSeen: false, error: null });
      return this.status();
    }
    if (changed) this.stop();
    if (!this.child) this.start();
    return this.status();
  }

  start() {
    if (this.child || !this.config.enabled || this.config.transport !== 'usb') return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stdout = '';
    this.emit({ transport: 'usb', connected: false, deviceSeen: false, error: null });

    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.bridgePath,
      '-PortName', this.config.serialPort,
      '-BaudRate', '115200',
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk) => {
      if (/BRIDGE_ERROR|SERIAL_ERROR/.test(String(chunk))) {
        this.emit({ error: 'USB display disconnected', connected: false });
      }
    });
    child.stdin.on('error', () => {
      this.emit({ error: 'USB display write failed', connected: false });
    });
    child.once('error', () => {
      this.emit({ error: 'Could not start the USB display bridge', connected: false });
    });
    child.once('exit', () => {
      if (this.child === child) this.child = null;
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.emit({ connected: false, deviceSeen: false, serialPort: null });
      if (!child.ccmeterIntentionalStop && this.config.enabled && this.config.transport === 'usb') {
        this.restartTimer = setTimeout(() => this.start(), RESTART_MS);
      }
    });
  }

  consumeStdout(chunk) {
    this.stdout += chunk;
    while (true) {
      const newline = this.stdout.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (line.startsWith('READY ')) {
        const serialPort = line.slice(6).trim();
        this.emit({ connected: true, serialPort, error: null });
        this.sendUsage(false);
        clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => this.sendUsage(false), POLL_MS);
        continue;
      }
      const message = parseHardwareMessage(line);
      if (!message) continue;
      if (message.type === 'hello') {
        this.emit({
          deviceSeen: true,
          lastSeen: new Date().toISOString(),
          firmware: typeof message.firmware === 'string' ? message.firmware.slice(0, 32) : null,
          model: typeof message.model === 'string' ? message.model.slice(0, 48) : null,
        });
      } else if (message.type === 'ack') {
        this.emit({ deviceSeen: true, lastSeen: new Date().toISOString(), error: null });
      } else if (message.type === 'refresh') {
        this.emit({ deviceSeen: true, lastSeen: new Date().toISOString(), error: null });
        this.sendUsage(true);
      }
    }
    if (this.stdout.length > 8192) this.stdout = '';
  }

  async sendUsage(manual) {
    manual = Boolean(manual);
    if (this.sending) {
      // A periodic transfer can overlap the user's tap. Never discard the
      // explicit request: replay it as soon as the current transfer finishes.
      if (manual && !this.sendingManual) this.pendingManual = true;
      return;
    }
    if (!this.child?.stdin?.writable) return;
    this.sending = true;
    this.sendingManual = manual;
    let replayManual = false;
    try {
      const data = await this.loadUsage(manual);
      const line = encodeHardwareUsage(data) + '\n';
      this.child.stdin.write(line);
      this.emit({ lastSent: new Date().toISOString(), error: null });
    } catch {
      this.emit({ error: 'Usage data unavailable' });
    } finally {
      this.sending = false;
      this.sendingManual = false;
      replayManual = this.pendingManual;
      this.pendingManual = false;
    }
    if (replayManual) await this.sendUsage(true);
  }

  stop() {
    clearTimeout(this.restartTimer);
    clearInterval(this.pollTimer);
    this.restartTimer = null;
    this.pollTimer = null;
    this.pendingManual = false;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.ccmeterIntentionalStop = true;
    try { child.stdin.end(); } catch { /* already closed */ }
    const stopTimer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
    }, 1000);
    stopTimer.unref?.();
  }
}
