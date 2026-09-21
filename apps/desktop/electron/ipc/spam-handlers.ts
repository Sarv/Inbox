/**
 * IPC for the spam filter's reputation stage: its policy (off / local DNSBL /
 * Sarv service) and its progress, for Settings and the Security page.
 */
import { SUSPICIOUS_THRESHOLD, createLogger, type SpamUserVerdict } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { resolveAccountTarget } from '../services/account-target';
import {
  getSpamReputationPolicy,
  getSpamReputationState,
  kickSpamReputation,
  reportSenderVerdict,
  setSpamReputationPolicy,
} from '../services/spam-reputation-service';
import { applyUserSpamVerdict } from '../services/spam-verdict-actions';

const logger = createLogger('spam-handlers');
const fail = (error: unknown) => ({ success: false as const, error: (error as Error)?.message ?? String(error) });

export function registerSpamHandlers(): void {
  ipcMain.handle('spam:getReputationPolicy', async () => {
    try { return { success: true, data: getSpamReputationPolicy() }; } catch (error) { return fail(error); }
  });
  ipcMain.handle('spam:setReputationPolicy', async (_event, policy: unknown) => {
    try {
      const saved = setSpamReputationPolicy(policy);
      kickSpamReputation(); // a newly enabled provider should not wait ten minutes
      return { success: true, data: saved };
    } catch (error) {
      logger.error('spam:setReputationPolicy failed:', error);
      return fail(error);
    }
  });
  ipcMain.handle('spam:getReputationState', async () => {
    try { return { success: true, data: getSpamReputationState() }; } catch (error) { return fail(error); }
  });
  ipcMain.handle('spam:kickReputation', async () => {
    try { kickSpamReputation(); return { success: true, data: getSpamReputationState() }; } catch (error) { return fail(error); }
  });

  // Everything the filter had an opinion on — for the Security page's Spam tab.
  ipcMain.handle('spam:listJudged', async (_event, limit?: number, accountId?: string) => {
    try {
      const { storage } = await resolveAccountTarget(accountId);
      return { success: true, data: storage.getSpamJudgedEmails(typeof limit === 'number' ? limit : 200, SUSPICIOUS_THRESHOLD) };
    } catch (error) {
      return fail(error);
    }
  });

  // The user's word: 'ham' un-files and protects the message from the filter; 'spam' files it.
  ipcMain.handle('spam:setUserVerdict', async (_event, emailId: string, verdict: SpamUserVerdict, accountId?: string) => {
    try {
      if (verdict !== 'spam' && verdict !== 'ham') return { success: false, error: 'verdict must be spam or ham' };
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      const queue = (syncEngine as unknown as { operationQueue?: { moveToSpam(f: string, u: number): Promise<unknown>; move(s: string, u: number, d: string): Promise<unknown> } } | null)?.operationQueue ?? null;
      const outcome = await applyUserSpamVerdict({ storage, queue, report: (r) => reportSenderVerdict(r) }, emailId, verdict);
      return outcome.success ? { success: true, data: { moved: outcome.moved } } : { success: false, error: outcome.error };
    } catch (error) {
      logger.error('spam:setUserVerdict failed:', error);
      return fail(error);
    }
  });
}
