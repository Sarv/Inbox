/**
 * Filter IPC Handlers
 *
 * CRUD for user-defined inbox filter rules (filters:*). Rules are evaluated at
 * ingest in the core message-processor; these handlers just manage the records.
 */

import { collectFilterActions, computeFilterActionResult, type EmailRecord, type FilterCondition, type FilterRule, type FilterRuleInput } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { emailsMatchingRule, scanEmailsForFilter } from '../services/filter-matching';
import { requireStorage, getSyncEngine } from '../shared';

/**
 * Count how many existing emails an (unsaved) rule would match — used for the
 * live "N matching emails" preview when the user ticks "apply to existing".
 */
function countRuleMatches(input: { matchType: 'all' | 'any'; conditions: FilterCondition[] }): number {
  return emailsMatchingRule(requireStorage(), input).length;
}

/**
 * Apply one rule to already-stored emails (the "apply to existing" option).
 * Mirrors the ingest projection (local tags/folder via computeFilterActionResult)
 * and, when connected, also enqueues the matching IMAP operations so the change
 * reaches the server. Returns how many emails were affected.
 */
async function applyRuleToExistingEmails(rule: FilterRule): Promise<number> {
  const storage = requireStorage();
  const syncEngine = getSyncEngine();
  const folders = await storage.getFolders();
  const rows = scanEmailsForFilter(storage);

  const connected = syncEngine?.isConnected?.() ?? false;
  let affected = 0;

  for (const email of rows) {
    const actions = collectFilterActions(email as EmailRecord, [rule]);
    if (actions.length === 0) continue;

    const { tags, folderId, changed } = computeFilterActionResult(email, actions, folders as any);
    if (changed) {
      await storage.updateEmail(email.id, { tags, folderId });
    }

    // Best-effort server propagation via the operation queue.
    if (connected && syncEngine && email.uid) {
      const srcPath = folders.find((f: any) => f.id === email.folderId)?.path;
      if (srcPath) {
        for (const action of actions) {
          try {
            switch (action.type) {
              case 'markRead': syncEngine.markAsRead(srcPath, email.uid).catch(() => {}); break;
              case 'star': syncEngine.star(srcPath, email.uid).catch(() => {}); break;
              case 'archive': syncEngine.archive(srcPath, email.uid).catch(() => {}); break;
              case 'moveToSpam': syncEngine.moveToSpam(srcPath, email.uid).catch(() => {}); break;
              case 'delete': syncEngine.moveToTrash(srcPath, email.uid).catch(() => {}); break;
              case 'moveToFolder': if (action.value) syncEngine.move(srcPath, email.uid, action.value).catch(() => {}); break;
              // applyLabel has no simple IMAP equivalent here — local tag only.
            }
          } catch { /* non-fatal */ }
        }
      }
    }
    affected++;
  }

  return affected;
}

export function registerFilterHandlers(): void {
  ipcMain.handle('filters:list', async () => {
    try {
      const storage = requireStorage();
      return { success: true, data: await storage.getFilterRules() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('filters:create', async (_event, input: FilterRuleInput) => {
    try {
      const storage = requireStorage();
      return { success: true, data: await storage.createFilterRule(input) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('filters:update', async (_event, id: string, updates: Partial<FilterRuleInput>) => {
    try {
      const storage = requireStorage();
      const rule = await storage.updateFilterRule(id, updates);
      if (!rule) return { success: false, error: 'Filter rule not found' };
      return { success: true, data: rule };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('filters:delete', async (_event, id: string) => {
    try {
      const storage = requireStorage();
      await storage.deleteFilterRule(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('filters:reorder', async (_event, orderedIds: string[]) => {
    try {
      const storage = requireStorage();
      await storage.reorderFilterRules(orderedIds);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('filters:countMatches', async (_event, rule: { matchType: 'all' | 'any'; conditions: FilterCondition[] }) => {
    try {
      return { success: true, data: { count: countRuleMatches(rule) } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('filters:applyToExisting', async (_event, id: string) => {
    try {
      const storage = requireStorage();
      const rule = (await storage.getFilterRules()).find((r) => r.id === id);
      if (!rule) return { success: false, error: 'Filter not found' };
      const count = await applyRuleToExistingEmails(rule);
      return { success: true, data: { count } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
