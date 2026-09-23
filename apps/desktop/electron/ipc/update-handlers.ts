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
  getUpdateState,
  installUpdateAndRestart,
  remindAboutUpdateLater,
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
   * "Install and Relaunch". Resolves only if the install could not start;
   * on success the app is already on its way down.
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
