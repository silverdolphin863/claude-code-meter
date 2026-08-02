const { contextBridge, ipcRenderer } = require('electron');

// The page is also served to a plain browser and to the ESP32 panel, so it must
// work without this bridge. It feature-detects `window.widget`.
contextBridge.exposeInMainWorld('widget', {
  close: () => ipcRenderer.send('widget:close'),
  pin: (pinned) => ipcRenderer.send('widget:pin', pinned),
  autosize: (height) => ipcRenderer.send('widget:autosize', height),
  setMode: (mode) => ipcRenderer.send('widget:mode', mode),
  compactWidth: (width) => ipcRenderer.send('widget:compact-width', width),
  compactResize: (width) => ipcRenderer.send('widget:compact-resize', width),
  setAutohide: (on) => ipcRenderer.send('widget:autohide', on),
  setPrefs: (prefs) => ipcRenderer.send('widget:prefs', prefs),
  openSettings: () => ipcRenderer.send('widget:open-settings'),
  setTrayTooltip: (text) => ipcRenderer.send('widget:tray-tooltip', text),
  reauthClaude: () => ipcRenderer.invoke('widget:reauth-claude'),
  compactMin: (width) => ipcRenderer.send('widget:compact-min', width),
  onState: (cb) => ipcRenderer.on('widget:set-state', (_e, s) => cb(s)),
});
