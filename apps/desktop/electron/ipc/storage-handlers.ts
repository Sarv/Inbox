/**
 * Storage maintenance IPC — the "Compress database" control in Settings -> Advanced.
 *
 * Two channels: a cheap per-account estimate the settings tab reads on open, and
 * the rebuild itself. Both follow the house `{ success, data?, error }` envelope
 * so the renderer never sees a thrown main-process error, and both surface the
 * refusal messages from `db-compact` verbatim — those explain WHY (syncing, no
 * disk headroom, nothing to reclaim) and the user needs the reason, not a
 * generic failure.
 */
import { ipcMain } from 'electron';

import { createLogger } from '@sarvinbox/core';

import { listRegistryAccounts } from '../services/accounts-registry';
import {
  compactAccountDatabase,
  estimateCompaction,
  type CompactionOutcome,
  type CompactionReport,
} from '../services/db-compact';
import { getAllAccountIds, getCurrentAccountId } from '../shared';

const logger = createLogger('storage-handlers');

export interface AccountStorageUsage extends CompactionReport {
  email: string;
  /** IMAP host, e.g. "imap.gmail.com". */
  host: string;
}

/**
 * Size and reclaimable space for every OPEN account.
 *
 * Only open accounts: the numbers come from pragmas on the live handle, and a
 * closed account has nothing to read them from. That is also the honest set —
 * an account that isn't open can't be compacted either.
 *
 * The host travels with the email because the SAME address can be configured on
 * two different servers (one Gmail, one Sarv). Identified by address alone the
 * two rows are indistinguishable, and the user cannot tell which 10 GB database
 * they are about to spend ten minutes rebuilding.
 */
function collectUsage(): AccountStorageUsage[] {
  const registryById = new Map(listRegistryAccounts().map((account) => [account.id, account]));

  return getAllAccountIds()
    .map((accountId) => {
      const report = estimateCompaction(accountId);
      if (!report) return null;
      const account = registryById.get(accountId);
      return {
        ...report,
        email: account?.email ?? accountId,
        host: typeof account?.imapConfig?.host === 'string' ? account.imapConfig.host : '',
      };
    })
    .filter((usage): usage is AccountStorageUsage => usage !== null);
}

export function registerStorageHandlers(): void {
  ipcMain.handle('storage:usage', async () => {
    try {
      return { success: true, data: collectUsage() };
    } catch (error) {
      logger.error('Storage usage error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Rebuild one account's database. Defaults to the active account so the
   * renderer can fire it without tracking ids.
   */
  ipcMain.handle('storage:compact', async (_event, accountId?: string) => {
    const target = accountId || getCurrentAccountId();
    if (!target) return { success: false, error: 'No account is open.' };

    try {
      const outcome: CompactionOutcome = await compactAccountDatabase(target);
      return { success: true, data: outcome };
    } catch (error) {
      // Refusals (mid-sync, no headroom, nothing to reclaim) land here too and
      // are expected, not faults — log at warn so they don't read as crashes.
      logger.warn(`Compact failed for ${target}:`, error);
      return { success: false, error: (error as Error).message };
    }
  });

  logger.info('[IPC] Storage handlers registered');
}
