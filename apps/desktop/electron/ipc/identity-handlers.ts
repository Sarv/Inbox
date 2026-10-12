/**
 * IPC for sender identity: BIMI logo / verified mark, domain favicon, and the
 * contact's confirmed photo — what the avatar and the blue tick are drawn from.
 * Reads are synchronous against the core-DB cache; a miss queues a background
 * lookup and the renderer is told by `identity:updated` when it lands.
 */
import { createLogger } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { getDomainIdentityStore } from '../services/domain-identity-store';
import {
  getSenderIdentityPolicy,
  getSenderIdentityService,
  lookupDomain,
  setSenderIdentityPolicy,
} from '../services/sender-identity-service';
import { getStorage } from '../shared';

const logger = createLogger('identity-handlers');

const fail = (error: unknown) => ({ success: false as const, error: (error as Error)?.message ?? String(error) });

export function registerIdentityHandlers(): void {
  ipcMain.handle('identity:getSender', async (_event, address: string) => {
    try {
      let contactPhoto: string | null = null;
      try {
        const storage = getStorage() as unknown as {
          getContactByEmail?: (email: string) => Promise<{ avatarUrl?: string | null; avatarStatus?: string | null } | null>;
        } | null;
        const contact = await storage?.getContactByEmail?.(address);
        if (contact?.avatarStatus === 'confirmed' && contact.avatarUrl) contactPhoto = contact.avatarUrl;
      } catch {
        // No contact directory (no account yet) — the photo is simply unknown.
      }
      return { success: true, data: getSenderIdentityService().getForAddress(address, contactPhoto) };
    } catch (error) {
      logger.error('identity:getSender failed:', error);
      return fail(error);
    }
  });

  ipcMain.handle('identity:getPolicy', async () => {
    try { return { success: true, data: getSenderIdentityPolicy() }; } catch (error) { return fail(error); }
  });

  ipcMain.handle('identity:setPolicy', async (_event, policy: unknown) => {
    try { return { success: true, data: setSenderIdentityPolicy(policy) }; } catch (error) { return fail(error); }
  });

  ipcMain.handle('identity:list', async (_event, limit?: number) => {
    try { return { success: true, data: getDomainIdentityStore().list(typeof limit === 'number' ? limit : 200) }; } catch (error) { return fail(error); }
  });

  // The Security page's "Refresh". The domain comes from the renderer, so it
  // is held to the same rule as a sender's domain (never an IP literal or a
  // host with a port), and the lookups are only the ones the reader's settings
  // allow. "Favicons off" means no favicon fetch, even on request.
  ipcMain.handle('identity:refresh', async (_event, raw: unknown) => {
    try {
      const domain = lookupDomain(raw);
      if (!domain) return fail(new Error('Not a domain that can be looked up'));
      await getSenderIdentityService().refreshAllowed(domain);
      return { success: true, data: getDomainIdentityStore().get(domain) };
    } catch (error) {
      logger.error('identity:refresh failed:', error);
      return fail(error);
    }
  });

  ipcMain.handle('identity:forget', async (_event, domain: string) => {
    try { getDomainIdentityStore().forget(domain); return { success: true }; } catch (error) { return fail(error); }
  });
}
