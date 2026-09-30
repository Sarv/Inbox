/**
 * IPC for the remote-image trust sources the renderer caches: the explicit
 * "always load images from…" allowlist, and the people the user has emailed
 * (correspondents: part of "From trusted senders").
 *
 * Every channel takes an optional `accountId`. The reading pane can show a
 * message of an account that is not the active one (the unified "All Inboxes"
 * view), and "Load images" on it must be remembered in THAT account's database
 * — a sender address exists in every mailbox, so the lenient resolver's
 * fall-back-to-active would silently file account B's choice under account A.
 * A named account is therefore resolved strictly (an unknown one is an error
 * the renderer sees and retries); no id means the active account, as before.
 */
import { createLogger } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { requireNamedOrActiveStorage } from '../services/account-target';
import { resolveAccountIdentity } from '../services/accounts-registry';

const logger = createLogger('image-trust-handlers');

const fail = (error: unknown) => ({ success: false as const, error: (error as Error)?.message ?? String(error) });

export function registerImageTrustHandlers(): void {
  ipcMain.handle('images:allowSender', async (_event, address: string, accountId?: string) => {
    try {
      await (await requireNamedOrActiveStorage(accountId)).allowSenderImages(address);
      return { success: true };
    } catch (error) {
      logger.warn(`images:allowSender failed for account ${accountId ?? '(active)'}: ${(error as Error)?.message ?? error}`);
      return fail(error);
    }
  });

  ipcMain.handle('images:getAllowedSenders', async (_event, accountId?: string) => {
    try {
      return { success: true, data: await (await requireNamedOrActiveStorage(accountId)).getImageAllowedSenders() };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('images:disallowSender', async (_event, address: string, accountId?: string) => {
    try {
      await (await requireNamedOrActiveStorage(accountId)).disallowSenderImages(address);
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  // The trusted senders' correspondents: every address this account has sent
  // mail to. Read once per account into the renderer's cache.
  //
  // Never the user's OWN addresses (every account's, aliases included), which
  // land here from a note to self or a reply-all that copied another of them.
  // Every forger knows the victim's address, so trusting it would let a
  // "From: you@…" load its tracking pixels.
  ipcMain.handle('images:getEmailedAddresses', async (_event, accountId?: string) => {
    try {
      const storage = await requireNamedOrActiveStorage(accountId);
      const own = new Set(resolveAccountIdentity(storage).aliases.map((address) => address.trim().toLowerCase()));
      const emailed = await storage.getEmailedAddresses();
      return { success: true, data: emailed.filter((address) => !own.has(address)) };
    } catch (error) {
      return fail(error);
    }
  });
}
