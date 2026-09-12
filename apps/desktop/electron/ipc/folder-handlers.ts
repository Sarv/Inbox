/**
 * Folder IPC Handlers
 *
 * Handles folder listing and folder-related operations.
 */

import { createLogger, describeDuplicateRoles, withFiledCounts } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { requireStorage, getSyncEngine } from '../shared';
const logger = createLogger('folder-handlers');

/**
 * Last duplicate-role report, so the line prints when the answer CHANGES rather
 * than on every list (the renderer lists folders after every sync).
 */
let lastDuplicateRoleSummary: string | null = null;

/**
 * Say which mailbox each duplicated role resolves to, with the sync state it
 * was decided from. This is the list the sidebar collapses to one folder per
 * role, so a wrong choice here IS what the user sees — an empty Sent under a
 * count borrowed from its twin. Reported from the same data and the same
 * function the renderer uses, so the log cannot disagree with the screen.
 */
function reportDuplicateRoles(folders: Parameters<typeof describeDuplicateRoles>[0]): void {
  const summary = describeDuplicateRoles(folders);
  if (!summary || summary === lastDuplicateRoleSummary) return;
  lastDuplicateRoleSummary = summary;
  logger.info(`Folders sharing a role — ${summary}`);
}

export function registerFolderHandlers(): void {
  /**
   * List all folders
   */
  ipcMain.handle('folders:list', async () => {
    try {
      const storage = requireStorage();
      // Attach the FILED count (primary folder_id) for any role the server
      // published under two names, so the renderer resolves the role to the
      // folder the mail is really in — the same input, from the same helper,
      // the sync engine decides with. The stored `total_count` cannot do it: a
      // message in two folders is one row carrying both tags, so an aliased
      // Sent reads as full under both names. Measured only for contested roles.
      const folders = await withFiledCounts(storage, await storage.getFolders());
      reportDuplicateRoles(folders);
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
