/**
 * Notification IPC — the renderer pushes the live notification config (mode,
 * sound, per-account notify flags + labels, and the currently-viewed
 * account/folder) into the main-process notification service, which owns the
 * actual firing. One-way: renderer -> main. The reverse (a notification CLICK ->
 * open the mail) is a webContents.send from the service, handled in the renderer.
 */
import { createLogger } from '@sarvinbox/core';
import { app, ipcMain } from 'electron';

import { readFocusStatus, systemFocusStatusDeps } from '../services/focus-status';
import { setNotificationConfig, showTestNotification } from '../services/notification-service';

const logger = createLogger('notifications');

export function registerNotificationHandlers(): void {
  ipcMain.handle('notifications:setConfig', (_event, config) => {
    try {
      setNotificationConfig(config || {});
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Fire a sample toast on demand — lets the user verify the OS/permission layer
  // and iterate on the notification look without waiting for real mail.
  // Also report macOS Focus / Do Not Disturb. While it's on, the OS accepts the
  // toast silently and shows no banner, which looked like a broken app.
  ipcMain.handle('notifications:test', async () => {
    try {
      const { supported } = showTestNotification();
      const focus = await readFocusStatus(systemFocusStatusDeps(app.getPath('home')));
      logger.info(`[notifications] TEST notification focus=${focus}`);
      return { success: true, supported, focus };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
