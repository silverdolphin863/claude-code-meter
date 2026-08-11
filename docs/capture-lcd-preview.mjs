import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDirectory = path.dirname(fileURLToPath(import.meta.url));
const previewPath = path.join(docsDirectory, 'lcd-preview.html');
const captures = [
  { state: 'usb', entryPath: previewPath, query: { state: 'usb' }, outputPath: path.join(docsDirectory, 'lcd-preview.png') },
  { state: 'auth', entryPath: path.join(docsDirectory, 'lcd-preview-auth.html'), outputPath: path.join(docsDirectory, 'lcd-preview-auth.png') },
  { state: 'config', entryPath: path.join(docsDirectory, 'lcd-preview-config.html'), outputPath: path.join(docsDirectory, 'lcd-preview-config.png') },
];

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

  for (const capture of captures) {
    await window.loadFile(capture.entryPath, capture.query ? { query: capture.query } : undefined);
    const geometry = await window.webContents.executeJavaScript(`(async () => {
      const frame = document.querySelector('iframe');
      if (frame && frame.contentDocument?.readyState !== 'complete') {
        await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      }
      const previewDocument = frame?.contentDocument || document;
      await previewDocument.fonts.ready;
      const rect = (selector) => {
        const { left, right, top, bottom, width, height } = previewDocument.querySelector(selector).getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      return {
        state: previewDocument.querySelector('.lcd').dataset.state,
        freshness: rect('.freshness'),
        dot: rect('.status-dot'),
        status: rect('.transport'),
        statusClientWidth: previewDocument.querySelector('.transport').clientWidth,
        statusScrollWidth: previewDocument.querySelector('.transport').scrollWidth,
        refresh: rect('[aria-label="Refresh"]'),
        settings: rect('[aria-label="Settings"]'),
        mainDisplay: getComputedStyle(previewDocument.querySelector('main')).display,
        setupDisplay: getComputedStyle(previewDocument.querySelector('.setup-panel')).display
      };
    })()`);
    const ordered = [geometry.freshness, geometry.dot, geometry.status, geometry.refresh, geometry.settings];
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index - 1].right > ordered[index].left) {
        throw new Error(`Header collision in ${capture.state}: item ${index} overlaps item ${index + 1}`);
      }
    }
    if (geometry.state !== capture.state || geometry.status.width !== 24 ||
        geometry.statusScrollWidth > geometry.statusClientWidth) {
      throw new Error(`Header state or fixed status width is wrong for ${capture.state}`);
    }
    const configVisible = geometry.setupDisplay !== 'none' && geometry.mainDisplay === 'none';
    const meterVisible = geometry.mainDisplay !== 'none' && geometry.setupDisplay === 'none';
    if ((capture.state === 'config' && !configVisible) || (capture.state !== 'config' && !meterVisible)) {
      throw new Error(`Setup and meter frames overlap in ${capture.state}`);
    }
    const preview = await window.webContents.capturePage({ x: 0, y: 0, width: 480, height: 480 });
    fs.writeFileSync(capture.outputPath, preview.toPNG());
    console.log(`Wrote ${capture.outputPath} (${preview.getSize().width}x${preview.getSize().height})`);
    if (capture.state === 'config') {
      const returnState = await window.webContents.executeJavaScript(`(() => {
        const frame = document.querySelector('iframe');
        const previewDocument = frame?.contentDocument || document;
        previewDocument.querySelector('[aria-label="Settings"]').click();
        return {
          state: previewDocument.querySelector('.lcd').dataset.state,
          mainDisplay: getComputedStyle(previewDocument.querySelector('main')).display,
          setupDisplay: getComputedStyle(previewDocument.querySelector('.setup-panel')).display,
        };
      })()`);
      if (returnState.state !== 'usb' || returnState.mainDisplay === 'none' || returnState.setupDisplay !== 'none') {
        throw new Error('The preview gear does not return to a clean meter frame');
      }
    }
    if (capture.state === 'usb') {
      const refreshAnimation = await window.webContents.executeJavaScript(`(() => {
        const previewDocument = document;
        const refresh = previewDocument.querySelector('[aria-label="Refresh"]');
        refresh.click();
        return {
          active: refresh.classList.contains('refreshing'),
          name: getComputedStyle(refresh.querySelector('svg')).animationName,
        };
      })()`);
      if (!refreshAnimation.active || refreshAnimation.name === 'none') {
        throw new Error('The preview refresh control does not start its rotation animation');
      }
    }
  }
  app.quit();
}

app.whenReady().then(capturePreview).catch((error) => {
  console.error(error);
  app.exit(1);
});
