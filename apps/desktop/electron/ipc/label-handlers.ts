/**
 * Label IPC Handlers
 *
 * CRUD for user-defined labels (labels:*) plus emails:setLabel, which toggles a
 * label's name as a tag on an email (the same tag mechanism folders/flags use).
 * Local-only, like AI-category tags — no IMAP keyword sync.
 */

import { createLogger, type LabelInput } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { requireStorage, getCurrentAccountId, getSyncEngine } from '../shared';
import { ensureAccountRuntime } from '../services/accounts-runtime';

const logger = createLogger('label-handlers');

// Labels live in each account's own DB. Resolve the target account's storage so
// the unified "All Inboxes" view can list/create labels for the account a
// message actually belongs to, not just the active one.
async function labelStorageFor(accountId?: string) {
  if (accountId && accountId !== getCurrentAccountId()) {
    const rt = await ensureAccountRuntime(accountId);
    if (rt?.storage) return rt.storage;
  }
  return requireStorage();
}

// The sync engine for the label's account — used to mirror an opt-in label to
// the server. Active account uses the live engine; a foreign account uses its
// runtime's engine (which may not be connected — caller handles that).
async function labelEngineFor(accountId?: string) {
  if (accountId && accountId !== getCurrentAccountId()) {
    const rt = await ensureAccountRuntime(accountId);
    return rt?.syncEngine ?? null;
  }
  return getSyncEngine();
}

export function registerLabelHandlers(): void {
  ipcMain.handle('labels:list', async (_event, accountId?: string) => {
    try {
      const storage = await labelStorageFor(accountId);
      return { success: true, data: await storage.getLabels() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('labels:create', async (_event, input: LabelInput, accountId?: string) => {
    try {
      const storage = await labelStorageFor(accountId);
      const name = (input?.name || '').trim();
      if (!name) return { success: false, error: 'Label name is required' };
      // Opt-in: also CREATE the label as a folder on the mail server so it shows
      // in the provider's webmail. Best-effort — if the account isn't connected
      // or the server rejects it, the label is still created locally.
      let syncedToServer = false;
      if (input?.syncToServer) {
        try {
          const engine = await labelEngineFor(accountId);
          if (engine?.isConnected?.()) {
            syncedToServer = await engine.createServerLabel(name);
          } else {
            logger.warn(`[labels] syncToServer requested for "${name}" but the account isn't connected — created local-only`);
          }
        } catch (e) {
          logger.warn(`[labels] server CREATE for "${name}" failed — created local-only: ${(e as Error).message}`);
        }
      }
      return { success: true, data: await storage.createLabel({ name, color: input.color }, syncedToServer) };
    } catch (error) {
      // UNIQUE(name) violation surfaces here.
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('labels:update', async (_event, id: string, updates: Partial<LabelInput>) => {
    try {
      const storage = requireStorage();
      const label = await storage.updateLabel(id, updates);
      if (!label) return { success: false, error: 'Label not found' };
      return { success: true, data: label };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('labels:delete', async (_event, id: string) => {
    try {
      const storage = requireStorage();
      await storage.deleteLabel(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Toggle a label (by name) on an email — adds/removes the label name as a tag.
   */
  ipcMain.handle('emails:setLabel', async (_event, emailId: string, label: string, on: boolean, accountId?: string) => {
    try {
      // Route to the email's own account (unified "All Inboxes" rows can belong
      // to a non-active account) so the tag is written to the right DB.
      const storage = accountId && accountId !== getCurrentAccountId()
        ? ((await ensureAccountRuntime(accountId))?.storage ?? requireStorage())
        : requireStorage();
      const email = await storage.getEmail(emailId);
      if (!email) return { success: false, error: 'Email not found' };

      const name = (label || '').trim();
      if (!name) return { success: false, error: 'Label is required' };

      const tags = email.tags || '||';
      const has = tags.includes('|' + name + '|');
      if (on && !has) {
        const tagList = tags.split('|').filter((t: string) => t.length > 0);
        tagList.push(name);
        await storage.updateEmail(emailId, { tags: '|' + tagList.join('|') + '|' });
      } else if (!on && has) {
        const tagList = tags.split('|').filter((t: string) => t.length > 0 && t !== name);
        await storage.updateEmail(emailId, { tags: tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||' });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
