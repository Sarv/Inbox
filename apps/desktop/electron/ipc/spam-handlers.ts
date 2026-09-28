/**
 * IPC for the spam filter's reputation stage: the background pass's progress
 * for the Security page, the Spam tab's list, and the user's own verdicts.
 *
 * There is no policy channel. What is asked, and of whom, is the `reputation`
 * section of the settings blob (Security > Blocklists), which main reads from
 * the core DB mirror and hears about through `appSettings:set` — see
 * reputation-service.ts.
 */
import { SUSPICIOUS_THRESHOLD, createLogger, type SpamUserVerdict } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { resolveAccountTarget } from '../services/account-target';
import { reportSenderVerdict } from '../services/reputation-service';
import { getSpamReputationState, kickSpamReputation } from '../services/spam-reputation-service';
import { applyUserSpamVerdict, trustSender, type VerdictDeps } from '../services/spam-verdict-actions';

const logger = createLogger('spam-handlers');
const fail = (error: unknown) => ({ success: false as const, error: (error as Error)?.message ?? String(error) });

/** What a verdict needs for one account: its storage, its server queue, the report hook. */
async function verdictDepsFor(accountId?: string): Promise<VerdictDeps> {
  const { storage, syncEngine } = await resolveAccountTarget(accountId);
  const queue = (syncEngine as unknown as { operationQueue?: VerdictDeps['queue'] } | null)?.operationQueue ?? null;
  return { storage, queue, report: (r) => reportSenderVerdict(r) };
}

export function registerSpamHandlers(): void {
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
      const deps = await verdictDepsFor(accountId);
      const outcome = await applyUserSpamVerdict(deps, emailId, verdict);
      return outcome.success ? { success: true, data: { moved: outcome.moved } } : { success: false, error: outcome.error };
    } catch (error) {
      logger.error('spam:setUserVerdict failed:', error);
      return fail(error);
    }
  });

  // "Trust this sender": their authenticated mail bypasses the filter from now on.
  ipcMain.handle('spam:trustSender', async (_event, address: string, accountId?: string) => {
    try {
      const { storage } = await resolveAccountTarget(accountId);
      await trustSender(storage, address);
      return { success: true };
    } catch (error) {
      logger.error('spam:trustSender failed:', error);
      return fail(error);
    }
  });

  // The Security page's list, and its remove.
  ipcMain.handle('spam:listTrustedSenders', async (_event, accountId?: string) => {
    try {
      const { storage } = await resolveAccountTarget(accountId);
      return { success: true, data: await storage.getTrustedSenders() };
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle('spam:untrustSender', async (_event, address: string, accountId?: string) => {
    try {
      const { storage } = await resolveAccountTarget(accountId);
      await storage.untrustSender(address);
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });
}
