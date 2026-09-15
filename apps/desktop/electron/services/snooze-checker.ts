/**
 * Snooze Checker Service
 *
 * Periodically checks for snoozed emails that are due
 * and unsnoozes them, notifying the renderer.
 */

import { createLogger } from '@sarvinbox/core';

import { getStorage, getStorageFor, getAllAccountIds, getMainWindow } from '../shared';
const logger = createLogger('snooze-checker');

let snoozeCheckInterval: NodeJS.Timeout | null = null;

/**
 * Wake all due snoozed emails for a single account's storage.
 * Returns the emailIds that were unsnoozed (empty if none/on error).
 */
async function wakeDueSnoozedForStorage(
  storage: NonNullable<ReturnType<typeof getStorage>>,
): Promise<string[]> {
  try {
    const dueSnoozed = await storage.getDueSnoozedEmails();
    if (dueSnoozed.length === 0) return [];

    for (const snoozed of dueSnoozed) {
      await storage.unsnoozeEmail(snoozed.emailId, true); // Mark as unread
    }
    return dueSnoozed.map(s => s.emailId);
  } catch (error) {
    logger.error('[Snooze] Error checking due snoozed emails:', error);
    return [];
  }
}

/**
 * Check for due snoozed emails across ALL accounts and unsnooze them.
 *
 * Fans out over every initialized account's storage (not just the active one),
 * so a mail snoozed in a background account still un-snoozes at its due time
 * instead of being stranded/hidden forever. Falls back to the active-account
 * storage during the pre-account default-slot window (before any real account
 * runtime is registered).
 */
async function checkDueSnoozedEmails(): Promise<number> {
  const accountIds = getAllAccountIds();
  const storages =
    accountIds.length > 0
      ? accountIds.map(id => getStorageFor(id)).filter((s): s is NonNullable<typeof s> => !!s)
      : [getStorage()].filter((s): s is NonNullable<typeof s> => !!s);

  if (storages.length === 0) {
    // No storage initialized yet, skip silently
    return 0;
  }

  const wokenPerAccount = await Promise.all(storages.map(wakeDueSnoozedForStorage));
  const emailIds = wokenPerAccount.flat();
  if (emailIds.length === 0) return 0;

  // Notify renderer of unsnoozed emails (aggregated across accounts).
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send('snooze:wakeup', {
      count: emailIds.length,
      emailIds,
    });
  }

  logger.info(`[Snooze] Unsnoozed ${emailIds.length} emails across ${storages.length} account(s)`);
  return emailIds.length;
}

/**
 * Start snooze checker interval
 */
export function startSnoozeChecker(): void {
  if (snoozeCheckInterval) return;

  // Check every minute
  snoozeCheckInterval = setInterval(() => {
    checkDueSnoozedEmails().catch(() => {});
  }, 60 * 1000);

  // Also check immediately on start
  checkDueSnoozedEmails().catch(() => {});
}

/**
 * Stop snooze checker interval
 */
export function stopSnoozeChecker(): void {
  if (snoozeCheckInterval) {
    clearInterval(snoozeCheckInterval);
    snoozeCheckInterval = null;
  }
}
