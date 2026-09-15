/**
 * Miscellaneous IPC Handlers
 *
 * Handles: signatures, importance processing, sender stats, snooze, spammers.
 */

import { calculateImportanceScore, type SenderContext, createLogger } from '@sarvinbox/core';
import type { SenderStats } from '@sarvinbox/storage-node';
import { ipcMain } from 'electron';

import { requireStorage, getMainWindow } from '../shared';
const logger = createLogger('misc-handlers');

/**
 * Convert SenderStats to SenderContext
 */
function senderStatsToContext(stats: SenderStats): SenderContext {
  return {
    email: stats.email,
    domain: stats.domain,
    receivedCount: stats.receivedCount,
    sentToCount: stats.sentToCount,
    repliedCount: stats.repliedCount,
    isVip: stats.isVip,
    isBlocked: stats.isBlocked,
    authPassCount: stats.authPassCount,
    authFailCount: stats.authFailCount,
  };
}

export function registerMiscHandlers(): void {
  // ========== Signature Patterns ==========

  ipcMain.handle('signatures:list', async (_event, options?: { limit?: number; offset?: number }) => {
    try {
      const storage = requireStorage();
      const patterns = await storage.getSignaturePatterns(options);
      return { success: true, data: patterns };
    } catch (error) {
      logger.error('List signatures error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('signatures:getByEmail', async (_event, email: string) => {
    try {
      const storage = requireStorage();
      const pattern = await storage.getSignaturePatternByEmail(email);
      return { success: true, data: pattern };
    } catch (error) {
      logger.error('Get signature by email error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('signatures:getBySelector', async (_event, selector: string) => {
    try {
      const storage = requireStorage();
      const pattern = await storage.getSignaturePatternBySelector(selector);
      return { success: true, data: pattern };
    } catch (error) {
      logger.error('Get signature by selector error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('signatures:save', async (_event, pattern: { email: string; htmlSelector: string; sampleHtml?: string; emailId?: string; confidence: 'high' | 'medium' | 'low' }) => {
    try {
      const storage = requireStorage();
      await storage.saveSignaturePattern(pattern);
      return { success: true };
    } catch (error) {
      logger.error('Save signature error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('signatures:delete', async (_event, id: string) => {
    try {
      const storage = requireStorage();
      await storage.deleteSignaturePattern(id);
      return { success: true };
    } catch (error) {
      logger.error('Delete signature error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('signatures:clear', async () => {
    try {
      const storage = requireStorage();
      await storage.clearSignaturePatterns();
      return { success: true };
    } catch (error) {
      logger.error('Clear signatures error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Email Importance Processing ==========

  ipcMain.handle('processor:processEmails', async (_event, options: { limit?: number; emailIds?: string[] } = {}) => {
    try {
      const storage = requireStorage();
      const limit = options.limit || 50;

      let emailsToProcess: any[];
      if (options.emailIds && options.emailIds.length > 0) {
        emailsToProcess = [];
        for (const id of options.emailIds) {
          const email = await storage.getEmail(id);
          if (email) emailsToProcess.push(email);
        }
      } else {
        emailsToProcess = await storage.getEmailsNeedingProcessing(limit);
      }

      if (emailsToProcess.length === 0) {
        return { success: true, data: { processed: 0 } };
      }

      const BATCH_SIZE = 10;
      let totalProcessed = 0;
      const myMessageIds = new Set<string>();

      for (let i = 0; i < emailsToProcess.length; i += BATCH_SIZE) {
        const batch = emailsToProcess.slice(i, i + BATCH_SIZE);

        for (const email of batch) {
          try {
            const senderEmail = email.fromAddress?.toLowerCase();
            let senderContext: SenderContext | null = null;

            if (senderEmail) {
              const stats = await storage.getSenderStats(senderEmail);
              if (stats) {
                senderContext = senderStatsToContext(stats);
              }
            }

            const result = calculateImportanceScore(
              email,
              senderContext,
              '',
              '',
              myMessageIds,
              email.cleanBody || ''
            );

            await storage.updateEmailImportance(email.id, result.score, 'rule');

            if (result.authStatus) {
              await storage.updateEmailAuthStatus(email.id, JSON.stringify(result.authStatus));
            }

            // The rule score is STORED (source 'rule') but must never write the
            // `important` tag: that tag drives the "Important" chip and section,
            // and the AI is its sole author. A keyword/header heuristic promoting
            // mail on its own is how "Important" chips appeared on today's mail
            // while the AI was down.

            if (senderEmail) {
              const authPassed = result.authStatus.overall === 'pass';
              const authFailed = result.authStatus.overall === 'fail';
              await storage.upsertSenderStats({
                email: senderEmail,
                receivedCount: 1,
                authPass: authPassed ? true : (authFailed ? false : undefined),
              });
            }

            totalProcessed++;
          } catch (err) {
            // Continue processing
          }
        }
      }

      return { success: true, data: { processed: totalProcessed } };
    } catch (error) {
      logger.error('Process emails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('processor:processEmail', async (_event, emailId: string, userEmail: string, userDomain: string) => {
    try {
      const storage = requireStorage();
      const email = await storage.getEmail(emailId);

      if (!email) {
        return { success: false, error: 'Email not found' };
      }

      const senderEmail = email.fromAddress?.toLowerCase();
      let senderContext: SenderContext | null = null;

      if (senderEmail) {
        const stats = await storage.getSenderStats(senderEmail);
        if (stats) {
          senderContext = senderStatsToContext(stats);
        }
      }

      const myMessageIds = new Set<string>();
      const result = calculateImportanceScore(
        email,
        senderContext,
        userEmail,
        userDomain,
        myMessageIds,
        email.cleanBody || ''
      );

      await storage.updateEmailImportance(email.id, result.score, 'rule');

      if (result.authStatus) {
        await storage.updateEmailAuthStatus(email.id, JSON.stringify(result.authStatus));
      }

      return { success: true, data: result };
    } catch (error) {
      logger.error('Process single email error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Sender Stats ==========

  ipcMain.handle('sender:getStats', async (_event, email: string) => {
    try {
      const storage = requireStorage();
      const stats = await storage.getSenderStats(email);
      if (stats) {
        // Override the running delta counters with live mailbox counts so the
        // engagement metrics are always accurate (read/deleted are subsets of
        // received → no "105% read"). Fall back to stored values only when the
        // sender has no messages left in the mailbox.
        const eng = await storage.getSenderEngagement(email);
        if (eng.received > 0) {
          stats.receivedCount = eng.received;
          stats.readCount = eng.read;
          stats.deletedCount = eng.deleted;
        }
      }
      return { success: true, data: stats };
    } catch (error) {
      logger.error('Get sender stats error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('sender:setVip', async (_event, email: string, isVip: boolean) => {
    try {
      const storage = requireStorage();
      await storage.setSenderVip(email, isVip);
      return { success: true };
    } catch (error) {
      logger.error('Set VIP error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('sender:setBlocked', async (_event, email: string, isBlocked: boolean) => {
    try {
      const storage = requireStorage();
      await storage.setSenderBlocked(email, isBlocked);
      return { success: true };
    } catch (error) {
      logger.error('Set blocked error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('sender:listVip', async () => {
    try {
      const storage = requireStorage();
      const vips = await storage.getVipSenders();
      return { success: true, data: vips };
    } catch (error) {
      logger.error('List VIP error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('sender:listBlocked', async () => {
    try {
      const storage = requireStorage();
      const blocked = await storage.getBlockedSenders();
      return { success: true, data: blocked };
    } catch (error) {
      logger.error('List blocked error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Snooze Operations ==========

  ipcMain.handle('snooze:set', async (_event, emailId: string, snoozeUntil: number) => {
    try {
      const storage = requireStorage();
      const result = await storage.snoozeEmail(emailId, snoozeUntil);
      return { success: true, data: result };
    } catch (error) {
      logger.error('Snooze email error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('snooze:remove', async (_event, emailId: string) => {
    try {
      const storage = requireStorage();
      await storage.unsnoozeEmail(emailId, false);
      return { success: true };
    } catch (error) {
      logger.error('Remove snooze error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // `limit`/`offset` count CONVERSATIONS, the unit the Snoozed view renders and
  // `snooze:count` counts. Omitting them takes the storage default, which is a
  // cap, not "everything" -- the renderer passes its own explicit one.
  ipcMain.handle('snooze:list', async (_event, options?: { limit?: number; offset?: number }) => {
    try {
      const storage = requireStorage();
      const snoozed = await storage.getSnoozedEmails(options ?? {});
      return { success: true, data: snoozed };
    } catch (error) {
      logger.error('List snoozed error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // The listing the Snoozed VIEW uses: full emails, one page of conversations,
  // in one round trip. `snooze:list` stays for callers that want the snooze
  // records themselves (wake-up bookkeeping), not rows to render.
  ipcMain.handle('snooze:listEmails', async (_event, options?: { limit?: number; offset?: number }) => {
    try {
      const storage = requireStorage();
      const emails = await storage.getSnoozedEmailRecords(options ?? {});
      return { success: true, data: emails };
    } catch (error) {
      logger.error('List snoozed emails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('snooze:get', async (_event, emailId: string) => {
    try {
      const storage = requireStorage();
      const snooze = await storage.getSnoozeRecord(emailId);
      return { success: true, data: snooze };
    } catch (error) {
      logger.error('Get snooze info error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('snooze:count', async () => {
    try {
      const storage = requireStorage();
      const count = await storage.getSnoozedCount();
      return { success: true, data: count };
    } catch (error) {
      logger.error('Get snooze count error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('snooze:checkDue', async () => {
    try {
      const storage = requireStorage();
      const mainWindow = getMainWindow();
      const dueSnoozed = await storage.getDueSnoozedEmails();

      if (dueSnoozed.length === 0) {
        return { success: true, data: { count: 0 } };
      }

      for (const snoozed of dueSnoozed) {
        await storage.unsnoozeEmail(snoozed.emailId, true);
      }

      if (mainWindow) {
        mainWindow.webContents.send('snooze:wakeup', {
          count: dueSnoozed.length,
          emailIds: dueSnoozed.map(s => s.emailId),
        });
      }

      return { success: true, data: { count: dueSnoozed.length } };
    } catch (error) {
      logger.error('Check due snooze error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Spammers Management ==========

  ipcMain.handle('spammers:add', async (_event, spammer: { email: string; name?: string; reason?: string }) => {
    try {
      const storage = requireStorage();
      await storage.addSpammer(spammer);
      return { success: true };
    } catch (error) {
      logger.error('Add spammer error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('spammers:remove', async (_event, email: string) => {
    try {
      const storage = requireStorage();
      await storage.removeSpammer(email);
      return { success: true };
    } catch (error) {
      logger.error('Remove spammer error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('spammers:isSpammer', async (_event, email: string) => {
    try {
      const storage = requireStorage();
      const isSpammer = await storage.isSpammer(email);
      return { success: true, data: isSpammer };
    } catch (error) {
      logger.error('Check spammer error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('spammers:list', async (_event, options?: { limit?: number; offset?: number; search?: string }) => {
    try {
      const storage = requireStorage();
      // getSpammers returns a bare SpammerRecord[]; the renderer (and the
      // preload type) expect { spammers, total }. Wrap it so the shape matches
      // — otherwise result.data.spammers is undefined and SpamTab crashes on
      // spammers.length, blanking the Settings page.
      const spammers = await storage.getSpammers(options);
      // Count honors the same search filter so paginated totals are correct.
      const total = await storage.getSpammerCount(options?.search);
      return { success: true, data: { spammers, total } };
    } catch (error) {
      logger.error('List spammers error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('spammers:count', async () => {
    try {
      const storage = requireStorage();
      const count = await storage.getSpammerCount();
      return { success: true, data: count };
    } catch (error) {
      logger.error('Get spammers count error:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}
