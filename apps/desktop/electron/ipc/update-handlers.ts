/**
 * Auto-update IPC handlers.
 *
 * A thin pass-through to `services/update-service`. Every handler returns the
 * full {@link UpdateState} so the renderer can render from the reply alone and
 * never has to keep a second, divergent copy of the update status.
 */

import { ipcMain } from 'electron';

import {
  checkForUpdates,
  dismissUpdateDialog,
  downloadUpdate,
  getUpdateState,
  installUpdateAndRestart,
  remindAboutUpdateLater,
  setAutoUpdateEnabled,
  skipCurrentVersion,
} from '../services/update-service';

export function registerUpdateHandlers(): void {
  /** Current state, for a renderer that just mounted or reloaded. */
  ipcMain.handle('updater:state', () => ({ success: true, data: getUpdateState() }));

  /**
   * "Check for Updates" from the menu. Always reports back — including
   * "you're up to date" — because a menu item that does nothing visible reads
   * as broken.
   */
  ipcMain.handle('updater:check', async () => ({
    success: true,
    data: await checkForUpdates('manual'),
  }));

  /**
   * "Download and install" — the user asking for the bytes, which only happens
   * with automatic updates off. Fails when nothing is waiting, so the renderer
   * can say so rather than spinning on a download that was never started.
   */
  ipcMain.handle('updater:download', () => {
    const started = downloadUpdate();
    return started
      ? { success: true, data: getUpdateState() }
      : { success: false, error: 'No update is waiting to be downloaded.' };
  });

  /** The "Install updates automatically" toggle in Settings -> Advanced. */
  ipcMain.handle('updater:setAutoUpdate', (_event, enabled: boolean) => ({
    success: true,
    data: setAutoUpdateEnabled(enabled === true),
  }));

  /**
   * "Restart now". Resolves only if the install could not start; on success the
   * app is already on its way down.
   */
  ipcMain.handle('updater:install', () => {
    const started = installUpdateAndRestart();
    return started
      ? { success: true }
      : { success: false, error: 'No update is ready to install yet.' };
  });

  ipcMain.handle('updater:skip', () => ({ success: true, data: skipCurrentVersion() }));

  ipcMain.handle('updater:remindLater', () => ({
    success: true,
    data: remindAboutUpdateLater(),
  }));

  ipcMain.handle('updater:dismiss', () => ({ success: true, data: dismissUpdateDialog() }));
}
