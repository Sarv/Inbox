/**
 * Notification IPC — the renderer pushes the live notification config (mode,
 * sound, per-account notify flags + labels, and the currently-viewed
 * account/folder) into the main-process notification service, which owns the
 * actual firing. One-way: renderer -> main. The reverse (a notification CLICK ->
 * open the mail) is a webContents.send from the service, handled in the renderer.
 */
import { ipcMain } from 'electron';

import { setNotificationConfig, showTestNotification } from '../services/notification-service';

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
  ipcMain.handle('notifications:test', () => {
    try {
      const { supported } = showTestNotification();
      return { success: true, supported };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
