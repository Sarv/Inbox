/**
 * Folder IPC Handlers
 *
 * Handles folder listing and folder-related operations.
 */

import { ipcMain } from 'electron';
import { requireStorage, getSyncEngine } from '../shared';
import { createLogger } from '@sarvinbox/core';
const logger = createLogger('folder-handlers');

export function registerFolderHandlers(): void {
  /**
   * List all folders
   */
  ipcMain.handle('folders:list', async () => {
    try {
      const storage = requireStorage();
      const folders = await storage.getFolders();
      return { success: true, data: folders };
    } catch (error) {
      logger.error('List folders error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Set a folder's per-folder sync policy: whether it syncs at all (`syncEnabled`)
   * and its body-download mode (`syncMode`: 'full' | 'headers' | null=global).
   * Turning sync OFF also unsubscribes the mailbox on the server (and re-subscribes
   * when turned back on) so the LSUB view stays consistent — best-effort.
   */
  ipcMain.handle('folders:setSyncPolicy', async (_event, folderId: string, policy: { syncEnabled?: boolean; syncMode?: 'full' | 'headers' | null }) => {
    try {
      const storage = requireStorage();
      const folder = await storage.getFolder(folderId);
      if (!folder) return { success: false, error: 'Folder not found' };

      const patch: any = {};
      if (typeof policy.syncEnabled === 'boolean') patch.syncEnabled = policy.syncEnabled;
      if (policy.syncMode !== undefined) patch.syncMode = policy.syncMode;
      // Keep `subscribed` in step with the on/off choice so the sidebar + backfill
      // filters (which already honor `subscribed`) agree with the policy.
      if (typeof policy.syncEnabled === 'boolean') patch.subscribed = policy.syncEnabled;
      await storage.updateFolder(folderId, patch);

      // Mirror the subscription to the server (best-effort; never fails the op).
      if (typeof policy.syncEnabled === 'boolean') {
        const engine = getSyncEngine();
        await engine?.setMailboxSubscribed?.(folder.path, policy.syncEnabled);
      }
      return { success: true };
    } catch (error) {
      logger.error('Set folder sync policy error:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}
