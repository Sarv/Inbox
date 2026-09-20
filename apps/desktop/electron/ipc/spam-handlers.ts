/**
 * IPC for the spam filter's reputation stage: its policy (off / local DNSBL /
 * Sarv service) and its progress, for Settings and the Security page.
 */
import { createLogger } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import {
  getSpamReputationPolicy,
  getSpamReputationState,
  kickSpamReputation,
  setSpamReputationPolicy,
} from '../services/spam-reputation-service';

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
}
