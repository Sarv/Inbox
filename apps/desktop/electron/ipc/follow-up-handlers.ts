/**
 * Follow-up reminder IPC handlers (followUps:*), plus the hook the send path
 * calls to record one.
 *
 * Reminders live in each account's own DB. The list spans every account (the
 * Follow-ups view is cross-account, like All Inboxes); a dismiss names
 * the account, falling back to the active one.
 */

import { createLogger, type AccountFollowUp, type FollowUp, type SendEmailOptions } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { followUpStores } from '../services/follow-up-checker';
import { resolveFollowUpDueAt } from '../services/follow-up-schedule';
import { getStorage, getStorageFor } from '../shared';

const logger = createLogger('follow-up-handlers');

type Storage = NonNullable<ReturnType<typeof getStorage>>;

const storageFor = (accountId?: string): Storage | null =>
  accountId ? getStorageFor(accountId) : getStorage();

/** Due first, then soonest due — the same order each account's list uses, merged. */
export const compareFollowUps = (left: FollowUp, right: FollowUp): number =>
  Number(right.status === 'due') - Number(left.status === 'due') || left.dueAt - right.dueAt;

/**
 * Record the reminder a successful send asked for. Never throws: the mail is
 * already sent, and a failed reminder write must not turn that into an error.
 * Idempotent per Message-ID, so an outbox retry of the same send is harmless.
 */
export async function recordFollowUpForSend(
  storage: Pick<Storage, 'createFollowUp'> | null,
  options: Pick<SendEmailOptions, 'followUp' | 'subject' | 'to'>,
  messageId: string,
  fromAddress: string,
  sentAt: number = Math.floor(Date.now() / 1000),
): Promise<FollowUp | null> {
  const dueAt = resolveFollowUpDueAt(options.followUp, sentAt);
  if (dueAt === null || !storage || !messageId) return null;
  try {
    return await storage.createFollowUp({
      messageId,
      subject: options.subject || '',
      recipients: options.to.join(', '),
      fromAddress,
      sentAt,
      dueAt,
    });
  } catch (error) {
    logger.error('[FollowUp] Could not record the reminder for a sent message:', error);
    return null;
  }
}

export function registerFollowUpHandlers(): void {
  ipcMain.handle('followUps:list', async () => {
    try {
      const perAccount = await Promise.all(
        followUpStores<Storage>().map(async ({ accountId, store }) =>
          (await store.listOpenFollowUps()).map((followUp): AccountFollowUp => ({ ...followUp, accountId })),
        ),
      );
      return { success: true, data: perAccount.flat().sort(compareFollowUps) };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('followUps:dismiss', async (_event, id: string, accountId?: string) => {
    try {
      const storage = storageFor(accountId);
      if (!storage) return { success: false, error: 'Account not available' };
      await storage.setFollowUpStatus(id, 'dismissed');
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
