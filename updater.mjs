// User-initiated update checking. Nothing here runs on its own.
//
// RULE, deliberate and non-negotiable: the user must never receive an update,
// or even an "update available" notice, without having clicked "Check for
// updates" themselves. That means:
//   - autoDownload = false, so finding an update never starts a download
//   - autoInstallOnAppQuit = false, so nothing is staged behind their back
//   - no check on launch, on focus, or on a timer. checkForUpdates() is called
//     from exactly one place: the tray menu item.
// Re-enabling any of those is a regression, not an improvement.

import { app, dialog, shell } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = false;

const RELEASES_URL = 'https://github.com/silverdolphin863/claude-code-meter/releases/latest';

let busy = false;

// Dev runs have no update metadata, so electron-updater throws a confusing
// error. Say so plainly instead.
function isPackaged() {
  return app.isPackaged;
}

export function canCheck() {
  return isPackaged() && !busy;
}

export async function checkForUpdates() {
  if (busy) return;
  busy = true;
  // Deliberately unparented: a dialog parented to the main window is anchored
  // to it, and in compact mode that window is a 30px strip glued to the top
  // screen edge, so the dialog appeared jammed against the top. Unparented
  // message boxes centre on the screen. Modality is not worth that.
  const show = (options) => dialog.showMessageBox(options);

  try {
    if (!isPackaged()) {
      await show({
        type: 'info',
        title: 'CC Meter',
        message: 'Update checking is only available in the installed app.',
        detail: 'This is a development run, which has no release metadata to compare against.',
        buttons: ['OK'],
      });
      return;
    }

    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version;
    // updateInfo always comes back; "is there an update" is the version compare.
    if (!version || version === app.getVersion()) {
      await show({
        type: 'info',
        title: 'CC Meter',
        message: `CC Meter ${app.getVersion()} is up to date.`,
        buttons: ['OK'],
      });
      return;
    }

    const notes = typeof result.updateInfo.releaseNotes === 'string'
      ? result.updateInfo.releaseNotes.replace(/<[^>]+>/g, '').trim().slice(0, 600)
      : '';
    const choice = await show({
      type: 'info',
      title: 'CC Meter',
      message: `Version ${version} is available. You have ${app.getVersion()}.`,
      detail: notes || 'Download it now? The app will restart to finish installing.',
      buttons: ['Download', 'View release page', 'Not now'],
      defaultId: 0,
      cancelId: 2,
    });

    if (choice.response === 1) { shell.openExternal(RELEASES_URL); return; }
    if (choice.response !== 0) return;

    await autoUpdater.downloadUpdate();
    const done = await show({
      type: 'info',
      title: 'CC Meter',
      message: `CC Meter ${version} is ready to install.`,
      detail: 'The app will close, install the update, and reopen.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    // "Later" must leave nothing staged: autoInstallOnAppQuit is off, so
    // quitting normally will NOT install it. The next check downloads again.
    if (done.response === 0) setImmediate(() => autoUpdater.quitAndInstall());
  } catch (err) {
    await show({
      type: 'error',
      title: 'CC Meter',
      message: 'Could not check for updates.',
      detail: String(err?.message || err),
      buttons: ['OK'],
    });
  } finally {
    busy = false;
  }
}
