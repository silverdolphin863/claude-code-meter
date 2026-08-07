import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(docsDirectory, 'lcd-preview.png');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-lcd-text');

async function capturePreview() {
  const window = new BrowserWindow({
    width: 480,
    height: 480,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#14131a',
    webPreferences: { backgroundThrottling: false },
  });

  await window.loadFile(path.join(docsDirectory, 'lcd-preview.html'));
  await window.webContents.executeJavaScript('document.fonts.ready');
  const preview = await window.webContents.capturePage({ x: 0, y: 0, width: 480, height: 480 });
  fs.writeFileSync(outputPath, preview.toPNG());
  console.log(`Wrote ${outputPath} (${preview.getSize().width}x${preview.getSize().height})`);
  app.quit();
}

app.whenReady().then(capturePreview).catch((error) => {
  console.error(error);
  app.exit(1);
});
