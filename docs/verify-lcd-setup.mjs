import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const setupPath = path.join(currentDirectory, '..', 'firmware', 'esp32-4848s040', 'release', 'SETUP.html');
const consoleErrors = [];

app.commandLine.appendSwitch('disable-gpu');

async function verifySetupGuide() {
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') consoleErrors.push(details.message);
  });

  async function inspectViewport(width, height) {
    window.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return window.webContents.executeJavaScript(`({
      title: document.title,
      heading: document.querySelector('h1')?.textContent,
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth
    })`);
  }

  await window.loadFile(setupPath);
  const desktop = await inspectViewport(1200, 900);
  const mobile = await inspectViewport(375, 812);
  for (const result of [desktop, mobile]) {
    if (result.title !== 'CC Meter LCD Setup' || result.heading !== 'CC Meter LCD Setup') {
      throw new Error('Setup guide title or heading is missing.');
    }
    if (result.scrollWidth > result.innerWidth || result.bodyScrollWidth > result.innerWidth) {
      throw new Error(`Horizontal overflow at ${result.innerWidth}px.`);
    }
  }
  if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`);
  console.log(JSON.stringify({ desktop, mobile, consoleErrors }));
  window.destroy();
}

app.whenReady()
  .then(verifySetupGuide)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
