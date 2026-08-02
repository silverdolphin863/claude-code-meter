import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(DOCS, 'showcase.png');

app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function captureShowcase() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { backgroundThrottling: false },
  });

  await win.loadFile(path.join(DOCS, 'showcase.html'));
  await win.webContents.executeJavaScript(`Promise.all([
    document.fonts.ready,
    ...Array.from(document.images, (img) => img.complete
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', reject, { once: true });
        }))
  ])`);

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 720 });
  fs.writeFileSync(OUTPUT, image.toPNG());
  console.log(`Wrote ${OUTPUT} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
}

app.whenReady().then(captureShowcase).catch((error) => {
  console.error(error);
  app.exit(1);
});
