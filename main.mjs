import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PORT, configurePanelServer, getPanelServerStatus, getPanelUsage } from './server.mjs';
import { HardwareDisplayController } from './hardware-display.mjs';
import { constrainCompactBounds } from './window-geometry.mjs';
import { checkForUpdates } from './updater.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HARDWARE_BRIDGE = app.isPackaged
  ? path.join(process.resourcesPath, 'hardware-display-bridge.ps1')
  : path.join(DIR, 'scripts', 'hardware-display-bridge.ps1');
let publishHardwareState = () => {};
const hardwareDisplay = new HardwareDisplayController({
  bridgePath: HARDWARE_BRIDGE,
  loadUsage: getPanelUsage,
  onChange: () => publishHardwareState(),
});

// Pin the app name BEFORE resolving userData. Otherwise the dev run uses the
// package `name` and the packaged build uses `productName`, so they read two
// different settings files and preferences appear to vanish after packaging.
app.setName('CC Meter');

// A GUI app cannot assume anyone is reading stdout. If whatever consumed the
// pipe goes away, the next console.log throws EPIPE, and an unhandled throw in
// the main process puts a JavaScript-error dialog on the user's screen. Losing
// a log line is never worth that.
for (const stream of [process.stdout, process.stderr]) {
  stream.on?.('error', () => {});
}
const STATE = path.join(app.getPath('userData'), 'window-state.json');

const COMPACT_HEIGHT = 29;
const COMPACT_WIDTH = 1100;
const COMPACT_MIN = 560;
const PEEK = 3;          // pixels left on screen while hidden, the hover target
const SLIDE_MS = 140;

function findExecutable(name) {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
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

function spawnDetached(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (error) {
      resolve({ ok: false, error: String(error.code || error.message || 'launch failed') });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('spawn', () => {
      child.unref();
      finish({ ok: true });
    });
    child.once('error', (error) => {
      finish({ ok: false, error: String(error.code || error.message || 'launch failed') });
    });
  });
}

async function launchClaudeLogin() {
  const claude = findExecutable('claude');
  if (!claude) return { ok: false, error: 'Claude CLI not found' };

  if (process.platform !== 'win32') {
    return spawnDetached(claude, ['auth', 'login', '--claudeai']);
  }

  // Windows Terminal is an App Execution Alias: a zero-byte APPEXECLINK
  // reparse point under WindowsApps. Node's fs reports ENOENT for it even
  // though it is on PATH and spawns perfectly, so looking for the file said
  // "Windows Terminal not found" on machines that plainly have it. Try to
  // launch instead of trying to find, and fall through to shells that are
  // always present. A visible window is the point here: the login is
  // interactive and the user has to complete it.
  const attempts = [
    ['wt', ['new-tab', '--title', 'CC Meter - Claude Login',
            claude, 'auth', 'login', '--claudeai']],
    ['powershell.exe', ['-NoExit', '-Command', `& '${claude}' auth login --claudeai`]],
    ['cmd.exe', ['/k', claude, 'auth', 'login', '--claudeai']],
  ];

  let lastError = 'could not open a terminal';
  for (const [command, args] of attempts) {
    const result = await spawnDetached(command, args);
    if (result.ok) return result;
    lastError = result.error || lastError;
  }
  return { ok: false, error: lastError };
}

ipcMain.handle('widget:reauth-claude', launchClaudeLogin);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}

let state = loadState();
// Capture runs must stay fully on-screen. This is in-memory only, so automated
// screenshots never change the user's saved auto-hide preference.
if (process.env.WIDGET_CAPTURE) state = { ...state, autohide: false };
let tray = null;
let mainWindow = null;
let quitting = false;

function persist(patch) {
  state = { ...state, ...patch };
  try { fs.writeFileSync(STATE, JSON.stringify(state)); } catch { /* best effort */ }
}

function normalizePanelConfig(value) {
  const candidate = value && typeof value === 'object' ? value : {};
  const requestedPort = Number(candidate.port);
  return {
    enabled: Boolean(candidate.enabled),
    displayOnly: Boolean(candidate.displayOnly),
    transport: candidate.transport === 'wifi' ? 'wifi' : 'usb',
    serialPort: typeof candidate.serialPort === 'string' && /^(auto|COM\d+)$/i.test(candidate.serialPort)
      ? candidate.serialPort
      : 'auto',
    port: Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535
      ? requestedPort
      : 7374,
    token: typeof candidate.token === 'string' && candidate.token.length >= 16
      ? candidate.token
      : crypto.randomBytes(18).toString('base64url'),
  };
}

const normalPanel = normalizePanelConfig(state.panel);
if (JSON.stringify(normalPanel) !== JSON.stringify(state.panel || {})) {
  persist({ panel: normalPanel });
}

function lanIPv4Addresses() {
  const rows = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (/loopback|vethernet|virtualbox|vmware|tailscale/i.test(name)) continue;
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || address.address.startsWith('169.254.')) continue;
      rows.push({ name, address: address.address });
    }
  }
  rows.sort((a, b) => {
    const rank = (name) => /wi-?fi|wlan/i.test(name) ? 0 : /ethernet/i.test(name) ? 1 : 2;
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  });
  return [...new Set(rows.map((row) => row.address))];
}

function hardwareDisplayState() {
  const config = normalizePanelConfig(state.panel);
  const endpoints = lanIPv4Addresses().map((address) => `http://${address}:${config.port}`);
  return {
    config,
    endpoints,
    status: config.transport === 'usb' ? hardwareDisplay.status() : getPanelServerStatus(),
  };
}

async function configureHardwareDisplay() {
  const config = normalizePanelConfig(state.panel);
  await configurePanelServer({
    ...config,
    enabled: config.enabled && config.transport === 'wifi' && !process.env.WIDGET_CAPTURE,
  });
  await hardwareDisplay.configure({
    ...config,
    enabled: config.enabled && config.transport === 'usb' && !process.env.WIDGET_CAPTURE,
  });
  return hardwareDisplayState();
}

const workAreaFor = (win) => screen.getDisplayNearestPoint(win.getBounds()).workArea;

// Centred against the top edge of the work area, like a screen-top wedge.
// An explicit width wins, then a width the user dragged to, then the default.
function compactBounds(win, desiredWidth) {
  const area = workAreaFor(win);
  const want = desiredWidth || state.compactWidth || COMPACT_WIDTH;
  const maxWidth = Math.max(1, area.width - 20);
  const width = Math.min(Math.max(want, COMPACT_MIN), maxWidth);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y,
    width,
    height: COMPACT_HEIGHT,
  };
}

function createWindow() {
  const f = state.full;
  const win = new BrowserWindow({
    width: f?.width ?? 340,
    height: f?.height ?? 400,
    x: f?.x,
    y: f?.y,
    minWidth: 260,
    minHeight: 26,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // The OS resize border is all-or-nothing: enabling it puts an ns-resize
    // cursor on the top and bottom edges, which is nonsense here. Height is
    // content-derived in full mode and fixed in compact mode, so vertical
    // resizing has nothing to do. Width is resized through our own edge
    // handles instead (widget:compact-resize / widget:full-resize), which
    // gives an ew-resize cursor only where it means something.
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true, // lives in the tray, not the taskbar
    title: 'CC Meter',
    webPreferences: { preload: path.join(DIR, 'preload.cjs') },
  });
  let widgetVisible = true;

  win.setAlwaysOnTop(true, 'floating');

  if (f) {
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const b = win.getBounds();
    if (b.x + b.width < area.x || b.x > area.x + area.width ||
        b.y + b.height < area.y || b.y > area.y + area.height) {
      win.center();
    }
  }

  // Every setBounds we issue fires 'resized', which would otherwise be recorded
  // as user geometry and poison the saved state with programmatic sizes.
  let programmatic = 0;
  const setBounds = (b) => {
    programmatic++;
    win.setBounds(b);
    setTimeout(() => { programmatic = Math.max(0, programmatic - 1); }, 600);
  };

  const isFullGeometry = (b) => b && b.height > COMPACT_HEIGHT + 20;

  let t = null;
  const remember = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (win.isDestroyed() || programmatic) return;
      const b = win.getBounds();
      if (state.mode === 'compact') {
        if (b.width >= COMPACT_MIN) persist({ compactWidth: b.width });
      } else if (isFullGeometry(b)) {
        persist({ full: b });
      }
    }, 400);
  };
  const snapCompactToWorkArea = () => {
    if (win.isDestroyed() || state.mode !== 'compact' || programmatic) return;
    const current = win.getBounds();
    const next = constrainCompactBounds(current, workAreaFor(win), 20, Math.max(COMPACT_MIN, runtimeMin));
    if (next.x !== current.x || next.y !== current.y || next.width !== current.width) {
      setBounds(next);
    }
  };
  const handleMove = () => {
    snapCompactToWorkArea();
    remember();
  };
  win.on('move', handleMove);
  win.on('moved', handleMove);
  win.on('resized', remember);

  // Closing hides to the tray. Quitting is an explicit tray action.
  win.on('close', (e) => {
    if (!win.isDestroyed() && state.mode !== 'compact') {
      const b = win.getBounds();
      if (isFullGeometry(b)) persist({ full: b });
    }
    if (!quitting) { e.preventDefault(); concealWidget(); }
  });

  // ---- auto-hide: slide the strip above the screen edge until hovered ----
  let slideTimer = null;
  let hideTimer = null;
  let shown = true;
  let panelOpen = false;      // settings popover expands the strip window
  let runtimeMin = COMPACT_MIN; // content-derived floor reported by the page

  const restY = () => workAreaFor(win).y;
  const hiddenY = () => workAreaFor(win).y - COMPACT_HEIGHT + PEEK;

  function slideTo(targetY, done) {
    clearInterval(slideTimer);
    // Snapshot geometry ONCE. Re-reading bounds each frame lets DPI rounding
    // accumulate, which grew the strip a few pixels taller on every slide.
    const base = win.getBounds();
    const startY = base.y;
    const startAt = Date.now();
    if (startY === targetY) { if (done) done(); return; }
    slideTimer = setInterval(() => {
      if (win.isDestroyed()) return clearInterval(slideTimer);
      const k = Math.min(1, (Date.now() - startAt) / SLIDE_MS);
      const y = Math.round(startY + (targetY - startY) * k);
      setBounds({ x: base.x, width: base.width, height: COMPACT_HEIGHT, y });
      if (k >= 1) { clearInterval(slideTimer); if (done) done(); }
    }, 12);
  }

  function reveal() {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (shown) return;
    shown = true;
    slideTo(restY());
  }

  function conceal(delay = 450) {
    if (hideTimer || !shown || panelOpen) return; // hidden, scheduled, or settings open
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!state.autohide || state.mode !== 'compact' || win.isDestroyed() || panelOpen) return;
      shown = false;
      slideTo(hiddenY());
    }, delay);
  }

  // The renderer cannot be trusted to report hover here: while hidden only a few
  // pixels of the page are on screen, and hit-testing a transparent frameless
  // window is unreliable. Poll the real cursor position from the shell instead.
  let watchTimer = null;

  function inTriggerZone() {
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const area = workAreaFor(win);
    const inX = p.x >= b.x - 8 && p.x <= b.x + b.width + 8;
    const bottom = shown ? area.y + COMPACT_HEIGHT + 8 : area.y + PEEK + 3;
    const inY = p.y >= area.y - 2 && p.y <= bottom;
    return inX && inY;
  }

  function startWatch() {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
      if (win.isDestroyed()) return stopWatch();
      if (!state.autohide || state.mode !== 'compact' || !win.isVisible() || panelOpen) return;
      if (inTriggerZone()) reveal(); else conceal();
    }, 100);
  }

  function stopWatch() {
    clearInterval(watchTimer);
    watchTimer = null;
  }

  function applyAutohide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    clearInterval(slideTimer);
    if (state.autohide && state.mode === 'compact') {
      startWatch();
      shown = true;
      conceal(900);
    } else {
      stopWatch();
      shown = true;
      const b = win.getBounds();
      setBounds({ x: b.x, width: b.width, height: COMPACT_HEIGHT, y: restY() });
    }
  }

  const pushState = () => {
    if (win.isDestroyed()) return;
    const payload = {
      mode: state.mode === 'compact' ? 'compact' : 'full',
      autohide: Boolean(state.autohide),
      prefs: state.prefs || null,
      panel: hardwareDisplayState(),
    };
    win.webContents.send('widget:set-state', payload);
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('widget:set-state', payload);
    }
    buildTrayMenu();
  };
  publishHardwareState = pushState;

  function setMode(mode) {
    if (win.isDestroyed()) return;
    clearTimeout(hideTimer);
    clearInterval(slideTimer);
    shown = true;
    if (mode === 'compact') {
      const b = win.getBounds();
      persist({ mode: 'compact', ...(isFullGeometry(b) ? { full: b } : {}) });
      setBounds(compactBounds(win));
      if (state.autohide) { startWatch(); conceal(1200); }
    } else {
      stopWatch();
      persist({ mode: 'full' });
      const cur = win.getBounds();
      const b = isFullGeometry(state.full) ? state.full : { width: 340, height: 400 };
      setBounds({
        x: b.x ?? cur.x, y: b.y ?? cur.y,
        width: b.width ?? 340, height: b.height ?? 400,
      });
    }
    pushState();
  }

  function setAutohide(on) {
    persist({ autohide: Boolean(on) });
    applyAutohide();
    pushState();
  }

  // ---- tray ----
  function trayImage() {
    // Read through fs (which IS asar-aware) and build the image from the buffer.
    // nativeImage.createFromPath cannot reliably read a path inside app.asar,
    // which is why the packaged tray icon came up blank.
    for (const name of ['tray-32.png', 'tray-24.png', 'tray-16.png', 'icon.png']) {
      try {
        const p = path.join(DIR, 'assets', name);
        if (!fs.existsSync(p)) continue;
        const img = nativeImage.createFromBuffer(fs.readFileSync(p));
        if (!img.isEmpty()) return img;
      } catch { /* try the next candidate */ }
    }
    return nativeImage.createEmpty();
  }

  // A tray click must present the WHOLE widget. With auto-hide on, merely
  // calling show() leaves it parked off screen showing a 3px sliver, which
  // looks broken. So also slide it into view and hold it there briefly.
  const STICKY_MS = 3500;
  function concealWidget() {
    if (win.isDestroyed()) return;
    widgetVisible = false;
    if (state.mode === 'full') {
      // Keep the expanded window mounted. Native hide/show recreates the
      // transparent compositor surface on some Windows desktops and flashes.
      win.setIgnoreMouseEvents(true);
      win.setOpacity(0);
    } else {
      win.hide();
    }
    buildTrayMenu();
  }

  function presentWidget() {
    if (win.isDestroyed()) return;
    // Do not activate the large transparent panel when it comes from the tray.
    // Activating it makes Windows repaint the full expanded window, which is
    // visible as a flash on some desktops.
    if (!win.isVisible()) win.showInactive();
    win.setIgnoreMouseEvents(false);
    win.setOpacity(1);
    widgetVisible = true;
    if (state.autohide && state.mode === 'compact') {
      startWatch();
      reveal();
      conceal(STICKY_MS); // the watch's shorter conceal is a no-op while this is pending
    }
    buildTrayMenu();
  }

  function trayToggle() {
    if (win.isDestroyed()) return;
    const parked = state.autohide && state.mode === 'compact' && !shown;
    if (!widgetVisible || parked) presentWidget();
    else concealWidget();
    buildTrayMenu();
  }

  ipcMain.on('widget:tray-tooltip', (_e, text) => {
    if (!tray || typeof text !== 'string') return;
    tray.setToolTip(text.slice(0, 128));
  });

  function buildTrayMenu() {
    if (!tray) return;
    const parked = state.autohide && state.mode === 'compact' && !shown;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: widgetVisible && !parked ? 'Hide widget' : 'Show widget',
        click: trayToggle },
      { type: 'separator' },
      { label: 'Compact strip', type: 'radio',
        checked: state.mode === 'compact', click: () => setMode('compact') },
      { label: 'Full panel', type: 'radio',
        checked: state.mode !== 'compact', click: () => setMode('full') },
      { type: 'separator' },
      { label: 'Claude Code meter', type: 'checkbox',
        checked: (state.prefs?.claude ?? 'auto') !== 'off',
        click: (m) => { persist({ prefs: { ...state.prefs, claude: m.checked ? 'auto' : 'off' } }); pushState(); } },
      { label: 'Codex meter', type: 'checkbox',
        checked: (state.prefs?.codex ?? 'auto') !== 'off',
        click: (m) => { persist({ prefs: { ...state.prefs, codex: m.checked ? 'auto' : 'off' } }); pushState(); } },
      { type: 'separator' },
      { label: 'ESP32 hardware display', type: 'checkbox',
        checked: Boolean(state.panel?.enabled),
        click: async (m) => {
          persist({ panel: normalizePanelConfig({ ...state.panel, enabled: m.checked }) });
          await configureHardwareDisplay();
          if (m.checked && state.panel?.displayOnly) concealWidget();
          else if (!m.checked) presentWidget();
          pushState();
        } },
      { label: 'Hide desktop widget when hardware display is enabled', type: 'checkbox',
        enabled: Boolean(state.panel?.enabled),
        checked: Boolean(state.panel?.displayOnly),
        click: async (m) => {
          persist({ panel: normalizePanelConfig({ ...state.panel, displayOnly: m.checked }) });
          if (m.checked) concealWidget(); else presentWidget();
          pushState();
        } },
      { type: 'separator' },
      { label: 'Auto-hide (slide away until hovered)', type: 'checkbox',
        enabled: state.mode === 'compact',
        checked: Boolean(state.autohide), click: (m) => setAutohide(m.checked) },
      { label: 'Always on top', type: 'checkbox',
        checked: win.isAlwaysOnTop(),
        click: (m) => win.setAlwaysOnTop(m.checked, 'floating') },
      { type: 'separator' },
      { label: 'Settings...', click: () => openSettings() },
      // The ONLY entry point to the updater. Nothing checks on launch, on
      // focus, or on a timer, by design: see updater.mjs.
      { label: 'Check for updates...', click: () => checkForUpdates() },
      { label: 'Quit CC Meter', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  const trayImg = trayImage();
  console.log('TRAY ' + JSON.stringify({ empty: trayImg.isEmpty(), size: trayImg.getSize() }));
  tray = new Tray(trayImg);
  tray.setToolTip('CC Meter');
  let trayClickTimer = null;
  tray.on('click', () => {
    clearTimeout(trayClickTimer);
    trayClickTimer = setTimeout(() => {
      trayClickTimer = null;
      trayToggle();
    }, 220);
  });
  tray.on('double-click', () => {
    clearTimeout(trayClickTimer);
    trayClickTimer = null;
    presentWidget();
  });
  win.trayToggle = trayToggle; // test seam: exercises the real tray click path
  buildTrayMenu();
  win.on('show', buildTrayMenu);
  win.on('hide', buildTrayMenu);

  win.webContents.on('did-finish-load', () => {
    if (state.mode === 'compact') setBounds(compactBounds(win));
    pushState();
    if (state.panel?.enabled && state.panel?.displayOnly && !process.env.WIDGET_CAPTURE) {
      concealWidget();
      return;
    }
    if (state.mode === 'compact' && state.autohide) { startWatch(); conceal(1500); }
  });

  win.on('closed', stopWatch);

  ipcMain.on('widget:close', concealWidget);
  ipcMain.on('widget:pin', (_e, pinned) => {
    win.setAlwaysOnTop(Boolean(pinned), 'floating');
    buildTrayMenu();
  });
  ipcMain.on('widget:mode', (_e, mode) => setMode(mode));
  ipcMain.on('widget:autohide', (_e, on) => setAutohide(on));
  ipcMain.on('widget:prefs', (_e, prefs) => {
    // pushState, not just buildTrayMenu: the strip renders from these prefs
    // (meter visibility, reset-time chip) and must repaint on the same click.
    if (prefs && typeof prefs === 'object') { persist({ prefs }); pushState(); }
  });
  ipcMain.handle('widget:get-panel-status', () => hardwareDisplayState());
  ipcMain.handle('widget:set-panel', async (_e, patch) => {
    const current = normalizePanelConfig(state.panel);
    const safePatch = patch && typeof patch === 'object' ? patch : {};
    const next = normalizePanelConfig({
      ...current,
      ...(typeof safePatch.enabled === 'boolean' ? { enabled: safePatch.enabled } : {}),
      ...(typeof safePatch.displayOnly === 'boolean' ? { displayOnly: safePatch.displayOnly } : {}),
      ...(safePatch.transport === 'usb' || safePatch.transport === 'wifi'
        ? { transport: safePatch.transport }
        : {}),
      ...(typeof safePatch.serialPort === 'string' ? { serialPort: safePatch.serialPort } : {}),
      ...(Number.isInteger(Number(safePatch.port)) ? { port: Number(safePatch.port) } : {}),
    });
    persist({ panel: next });
    await configureHardwareDisplay();
    if (next.enabled && next.displayOnly) concealWidget();
    else if (!next.enabled || (current.displayOnly && !next.displayOnly)) presentWidget();
    pushState();
    return hardwareDisplayState();
  });
  ipcMain.handle('widget:rotate-panel-token', async () => {
    persist({ panel: normalizePanelConfig({
      ...state.panel,
      token: crypto.randomBytes(18).toString('base64url'),
    }) });
    await configureHardwareDisplay();
    pushState();
    return hardwareDisplayState();
  });

  // Explicit drag-resize from the strip's edge handles.
  ipcMain.on('widget:compact-resize', (_e, width) => {
    if (win.isDestroyed() || state.mode !== 'compact') return;
    const area = workAreaFor(win);
    const maxWidth = Math.max(1, area.width - 20);
    const w = Math.min(Math.max(Number(width) || 0, runtimeMin), maxWidth);
    persist({ compactWidth: w });
    const cur = win.getBounds();
    // Keep the current height: while the settings panel is open the window is
    // taller than the strip, and this resize must not slam it back to 30px.
    setBounds(constrainCompactBounds(
      { ...compactBounds(win, w), y: cur.y, height: cur.height },
      area,
      20,
      Math.max(COMPACT_MIN, runtimeMin),
    ));
  });

  // Horizontal drag-resize for the full panel. Unlike the centred strip, this
  // window is free-floating, so the left edge moves x while the right edge does
  // not. The window is not OS-resizable, so this is the only path in and it has
  // to persist the result itself: 'resized' never fires for it.
  ipcMain.on('widget:full-resize', (_e, left, width) => {
    if (win.isDestroyed() || state.mode === 'compact') return;
    const area = workAreaFor(win);
    const cur = win.getBounds();
    const w = Math.min(Math.max(Number(width) || 0, 260), area.width);
    // Clamp x so a drag cannot push the panel off the side of the display.
    const x = Math.min(Math.max(Math.round(Number(left) ?? cur.x), area.x),
                       area.x + area.width - w);
    const next = { x, y: cur.y, width: w, height: cur.height };
    setBounds(next);
    persist({ full: next });
  });

  // The page reports the narrowest width at which no gauge label clips.
  ipcMain.on('widget:compact-min', (_e, width) => {
    const w = Number(width) || 0;
    if (w < 300 || w > 2400) return;
    runtimeMin = Math.max(COMPACT_MIN, w);
    if (state.mode === 'compact' && !win.isDestroyed() && win.getBounds().width < runtimeMin) {
      setBounds(constrainCompactBounds(
        { ...compactBounds(win, runtimeMin), y: win.getBounds().y },
        workAreaFor(win),
        20,
        runtimeMin,
      ));
    }
  });

  // Settings live in their own dialog window near the tray/strip, never inside
  // the 30px strip itself. Auto-hide pauses while the dialog is open.
  let settingsWin = null;
  // Gear click toggles: second click closes the dialog again.
  function toggleSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.close(); return; }
    openSettings();
  }

  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    panelOpen = true;
    const area = workAreaFor(win);
    settingsWin = new BrowserWindow({
      width: 340,
      height: Math.min(720, area.height - 60),
      x: Math.round(area.x + area.width - 360),
      y: area.y + 40,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: 'CC Meter Settings',
      webPreferences: { preload: path.join(DIR, 'preload.cjs') },
    });
    settingsWin.loadURL(`http://localhost:${PORT}/settings.html`);
    settingsWin.webContents.on('did-finish-load', () => {
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send('widget:set-state', {
          mode: state.mode === 'compact' ? 'compact' : 'full',
          autohide: Boolean(state.autohide),
          prefs: state.prefs || null,
          panel: hardwareDisplayState(),
        });
      }
    });
    settingsWin.on('closed', () => {
      settingsWin = null;
      panelOpen = false;
      if (state.autohide && state.mode === 'compact') conceal(900);
    });
  }
  ipcMain.on('widget:open-settings', toggleSettings);

  // Full mode shrink-wraps its content, every time the content changes, not
  // just on first run: the user can no longer drag the height, so the window
  // has to track it. Compact height is fixed.
  ipcMain.on('widget:autosize', (_e, height) => {
    if (state.mode === 'compact' || win.isDestroyed()) return;
    const h = Math.max(160, Math.min(900, Number(height) || 0));
    const cur = win.getBounds();
    if (!h || Math.abs(cur.height - h) <= 2) return; // ignore sub-pixel churn
    const next = { ...cur, height: h };
    setBounds(next);
    persist({ full: next });
  });

  return win;
}

// One widget at a time. Duplicate instances fight over the port and leave stray
// windows around. Capture runs bypass this so verification can still launch.
if (!process.env.WIDGET_CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  await configureHardwareDisplay();
  const win = createWindow();
  mainWindow = win;
  if (process.env.WIDGET_CAPTURE) {
    win.webContents.once('did-finish-load', async () => {
      if (process.env.WIDGET_MODE) {
        state.mode = process.env.WIDGET_MODE; // in memory only, do not persist a test run
        win.webContents.send('widget:set-state', {
          mode: process.env.WIDGET_MODE, autohide: Boolean(state.autohide),
        });
        if (process.env.WIDGET_MODE === 'compact') win.setBounds(compactBounds(win));
      }
      await new Promise((r) => setTimeout(r, 2000));
      if (process.env.WIDGET_SNAP_TEST && state.mode === 'compact') {
        const b = win.getBounds();
        // Bypass the wrapper deliberately: this simulates the native drag event.
        win.setPosition(b.x - b.width - 40, b.y + COMPACT_HEIGHT + 120);
        await new Promise((r) => setTimeout(r, 300));
        const snapBounds = win.getBounds();
        console.log('SNAP_TEST ' + JSON.stringify(snapBounds));
        fs.writeFileSync(`${process.env.WIDGET_CAPTURE}.bounds.json`, JSON.stringify(snapBounds));
      }
      if (process.env.WIDGET_EVAL) {
        const res = await win.webContents.executeJavaScript(process.env.WIDGET_EVAL);
        console.log('EVAL ' + JSON.stringify(res));
        await new Promise((r) => setTimeout(r, Number(process.env.WIDGET_WAIT || 1500)));
      }
      if (process.env.WIDGET_TRAY) {
        console.log('BEFORE_TRAY ' + JSON.stringify(win.getBounds()));
        win.trayToggle();
        await new Promise((r) => setTimeout(r, 900));
        console.log('AFTER_TRAY ' + JSON.stringify(win.getBounds()));
      }
      console.log('BOUNDS ' + JSON.stringify(win.getBounds()));
      const wins = BrowserWindow.getAllWindows();
      console.log('WINDOWS ' + JSON.stringify(wins.map((w) => ({ t: w.getTitle(), b: w.getBounds() }))));
      const extra = wins.find((w) => w !== win);
      if (extra) {
        const eimg = await extra.webContents.capturePage();
        fs.writeFileSync(process.env.WIDGET_CAPTURE.replace('.png', '-extra.png'), eimg.toPNG());
        // Corner alpha is the only honest test of a rounded transparent window.
        const { width } = eimg.getSize();
        const bmp = eimg.toBitmap(); // BGRA, row-major
        const at = (x, y) => bmp[(y * width + x) * 4 + 3];
        console.log('CORNER_ALPHA ' + JSON.stringify({
          topLeft: at(1, 1), topRight: at(width - 2, 1), centre: at(Math.floor(width / 2), 20),
        }));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.WIDGET_CAPTURE, img.toPNG());
      quitting = true;
      app.exit(0);
    });
  }
  // Load only after the capture listener is attached. Attaching it after
  // loadURL introduced a race where a fast local page finished first and left
  // automated visual checks waiting forever.
  win.loadURL(`http://localhost:${PORT}/`);
});

app.on('before-quit', () => {
  quitting = true;
  hardwareDisplay.stop();
});
// The window hides to the tray instead of closing, so do not quit with it.
app.on('window-all-closed', () => { if (quitting) app.quit(); });
