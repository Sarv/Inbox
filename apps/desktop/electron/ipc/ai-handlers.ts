/**
 * AI Box IPC Handlers
 *
 * Handles AI categorization, thread summaries, and AI search operations.
 */

import {
  conversationSenders,
  createLogger,
  type FirstSplitClearAllResult,
  type FirstSplitClearCounts,
  type FirstSplitGetResult,
  type FirstSplitSaveRequest,
} from '@sarvinbox/core';
import { processingBreakdown, type SQLiteStorage } from '@sarvinbox/storage-node';
import { ipcMain } from 'electron';

import { openAccountStorages, requireAccountStorage, requireNamedOrActiveStorage } from '../services/account-target';
import { readRegistryAccounts } from '../services/accounts-registry';
import { getAutoBacklogCap, setAutoBacklogCap } from '../services/ai-backlog-cap';
import { getAllAiSecrets, setAiSecret, deleteAiSecret, isSecureStorageAvailable } from '../services/ai-secret-store';
import { setAIProviderConfigured, setBackgroundSplitEnabled } from '../services/conversation-extraction-scheduler';
import { clearPipelineAIConfig } from '../services/pipeline-ai-config-store';
import { onCategoryDefinitionUpserted } from '../services/unified-pipeline-service';
import { requireStorage } from '../shared';
const logger = createLogger('ai-handlers');

/**
 * Every initialized account's storage (active first, deduped). Category badges
 * and the category list are shown in the unified "All Inboxes" view, so they
 * must resolve categories across ALL accounts — not just the active one.
 */
function allAccountStorages(): any[] {
  return openAccountStorages().map((entry) => entry.storage);
}

// ========== First-email split cache (ai:firstSplit:*) ==========
// Account-scoped, STRICTLY: every handler resolves its storage through
// requireAccountStorage, which throws rather than falling back to the active
// account. The cache is keyed by thread id, and the same thread id exists in
// every account's database — a fallback would serve one account's split for
// another's thread, or write it into the wrong database.

/**
 * Main's answer to `ai:firstSplit:get`: the stored row, the thread's CURRENT
 * key (its first conversation member and that email's stored-body
 * fingerprint) with the member and distinct-sender counts, and — with
 * `withSource` — the first member's full record and the senders' roster.
 *
 * Read in one synchronous block (no await), so the key, the counts and the
 * source are one snapshot: no other IPC can land a body write between them,
 * and the record a run splits is exactly the one the key describes.
 */
export function readFirstSplit(storage: SQLiteStorage, threadId: string, withSource: boolean): FirstSplitGetResult {
  const key = storage.firstMemberKeySync(threadId);
  const members = storage.getConversationMemberRowsSync(threadId);
  // Core's one distinct-sender answer, over MEMBERS only (see conversationSenders).
  const roster = conversationSenders(members);
  const result: FirstSplitGetResult = {
    row: storage.getFirstSplitSync(threadId),
    current: key ? { ...key, memberCount: members.length, distinctSenders: roster.length } : null,
  };
  if (withSource) {
    result.source = key ? storage.getRepositories().email.getByIdsSync([key.firstEmailId])[0] ?? null : null;
    result.roster = roster;
  }
  return result;
}

/**
 * How Clear Cache names a failed storage that belongs to no account id (the
 * pre-account default slot). The user reads it in "Could not clear …".
 */
export const UNNAMED_MAILBOX_LABEL = 'this mailbox';

/**
 * Clear the cache in EVERY configured account — the registry's list, not only
 * the runtimes open this session (runtimes open lazily: the active account,
 * the unified view, background sync), plus any other open storage.
 *
 * Each account resolves through the strict resolver inside its own try/catch:
 * one that cannot be resolved or cleared (closed, locked, mid-maintenance) is
 * reported in `failedAccounts` — never counted as 0 cleared, which would tell
 * the user the cache is empty when it is not. The registry is read with the
 * THROWING reader: when it cannot be read this throws, and the caller reports
 * a failure rather than a partial success that looks complete.
 */
export async function clearFirstSplitsInEveryAccount(): Promise<FirstSplitClearAllResult> {
  const accounts = readRegistryAccounts();
  const seen = new Set<unknown>();
  let cleared = 0;
  let splits = 0;
  const failedAccounts: string[] = [];
  const fail = (accountId: string, error: unknown): void => {
    failedAccounts.push(accountId);
    logger.warn(`firstSplit:clearAll failed for account ${accountId}: ${(error as Error)?.message ?? error}`);
  };
  const add = (counts: FirstSplitClearCounts): void => {
    cleared += counts.removed;
    splits += counts.splits;
  };
  for (const { id } of accounts) {
    try {
      const storage = await requireAccountStorage(id);
      if (seen.has(storage)) continue;
      seen.add(storage);
      add(storage.clearAllFirstSplits());
    } catch (error) {
      fail(id, error);
    }
  }
  // Anything open that the registry did not name (the pre-account default slot).
  for (const { accountId, storage } of openAccountStorages()) {
    if (seen.has(storage)) continue;
    seen.add(storage);
    try {
      add(storage.clearAllFirstSplits());
    } catch (error) {
      fail(accountId ?? UNNAMED_MAILBOX_LABEL, error);
    }
  }
  return { cleared, splits, failedAccounts };
}

export function registerAIHandlers(): void {
  // ── AI provider API keys — safeStorage vault (never renderer localStorage) ──
  ipcMain.handle('aiSecrets:getAll', async () => {
    try {
      return { success: true, data: await getAllAiSecrets(), encrypted: isSecureStorageAvailable() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
  ipcMain.handle('aiSecrets:set', async (_event, providerId: string, apiKey: string) => {
    try {
      if (typeof providerId !== 'string' || !providerId) throw new Error('providerId required');
      await setAiSecret(providerId, typeof apiKey === 'string' ? apiKey : '');
      return { success: true, encrypted: isSecureStorageAvailable() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
  ipcMain.handle('aiSecrets:delete', async (_event, providerId: string) => {
    try {
      await deleteAiSecret(providerId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get emails by AI category (uses dynamic junction table)
   */
  ipcMain.handle(
    'ai:getByCategory',
    async (_event, category: string, limit = 50, offset = 0, folderId?: string) => {
      try {
        const stores = allAccountStorages();
        // Single account (or a folder-scoped view): direct query.
        if (stores.length <= 1 || folderId) {
          const storage = stores[0] ?? requireStorage();
          const emails = await storage.getEmailsByDynamicCategory(category, { limit, offset, folderId });
          return { success: true, data: emails };
        }
        // Unified: pull the category from every account, merge, sort newest-first.
        const all: any[] = [];
        for (const store of stores) {
          try {
            const rows = await store.getEmailsByDynamicCategory(category, { limit: offset + limit, offset: 0, folderId });
            if (Array.isArray(rows)) all.push(...rows);
          } catch { /* skip a failing account */ }
        }
        all.sort((a, b) => (b.date || 0) - (a.date || 0));
        return { success: true, data: all.slice(offset, offset + limit) };
      } catch (error) {
        logger.error('AI getByCategory error:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  /**
   * Get AI category counts (dynamic — returns Record<string, number>)
   */
  ipcMain.handle('ai:getCategoryCounts', async (_event, folderId?: string, mode: 'unread' | 'total' = 'unread') => {
    try {
      const storage = requireStorage();
      const counts = storage.getDynamicCategoryCounts(folderId, mode);
      return { success: true, data: counts };
    } catch (error) {
      logger.error('AI getCategoryCounts error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get all category definitions
   */
  ipcMain.handle('ai:getCategoryDefinitions', async (_event, accountId?: string) => {
    try {
      const storage = await requireNamedOrActiveStorage(accountId);
      const defs = storage.getCategoryDefinitions();
      return { success: true, data: defs };
    } catch (error) {
      logger.error('AI getCategoryDefinitions error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get category assignments for a batch of email IDs
   */
  ipcMain.handle('ai:getEmailCategoriesBatch', async (_event, emailIds: string[], accountId?: string) => {
    try {
      if (accountId) {
        const storage = await requireNamedOrActiveStorage(accountId);
        return { success: true, data: storage.getEmailCategoriesBatch(emailIds) || {} };
      }
      // Query EVERY account and merge — the requested ids come from the unified
      // list and can belong to any account. Each id lives in exactly one
      // account's db, so the first non-empty result for an id wins.
      const merged: Record<string, string[]> = {};
      for (const store of allAccountStorages()) {
        try {
          const r = (store.getEmailCategoriesBatch(emailIds) || {}) as Record<string, string[]>;
          for (const id of Object.keys(r)) {
            if (r[id]?.length && !merged[id]?.length) merged[id] = r[id];
          }
        } catch { /* skip a failing account */ }
      }
      return { success: true, data: merged };
    } catch (error) {
      logger.error('AI getEmailCategoriesBatch error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Upsert a category definition
   */
  ipcMain.handle('ai:upsertCategoryDefinition', async (_event, def: any) => {
    try {
      const storage = requireStorage();
      // Capture the old display name BEFORE the write so we can rename the
      // server label in place if it changed (rather than orphaning it).
      const oldName = storage.getCategoryDefinitions?.()?.find((d: any) => d.slug === def?.slug)?.name;
      storage.upsertCategoryDefinition(def);
      // Rename-in-place if the name changed, else (re)provision the label across
      // all connected accounts. Idempotent; no-op when mirroring is off.
      void onCategoryDefinitionUpserted(oldName, def?.name);
      return { success: true };
    } catch (error) {
      logger.error('AI upsertCategoryDefinition error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Delete a category definition (non-system only)
   */
  ipcMain.handle('ai:deleteCategoryDefinition', async (_event, slug: string) => {
    try {
      const storage = requireStorage();
      const deleted = storage.deleteCategoryDefinition(slug);
      return { success: true, data: { deleted } };
    } catch (error) {
      logger.error('AI deleteCategoryDefinition error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Toggle a category definition enabled/disabled
   */
  ipcMain.handle('ai:toggleCategoryDefinition', async (_event, slug: string, enabled: boolean) => {
    try {
      const storage = requireStorage();
      storage.toggleCategoryDefinition(slug, enabled);
      return { success: true };
    } catch (error) {
      logger.error('AI toggleCategoryDefinition error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get thread summary
   */
  ipcMain.handle('ai:getThreadSummary', async (_event, threadId: string) => {
    try {
      const storage = requireStorage();
      const summary = await storage.getThreadSummary(threadId);
      return { success: true, data: summary };
    } catch (error) {
      logger.error('AI getThreadSummary error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Save thread summary
   */
  ipcMain.handle('ai:saveThreadSummary', async (_event, summary: any) => {
    try {
      const storage = requireStorage();
      await storage.upsertThreadSummary(summary);
      return { success: true };
    } catch (error) {
      logger.error('AI saveThreadSummary error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /** The first-email split cache row + main's current key for a thread, in ONE account. */
  ipcMain.handle(
    'ai:firstSplit:get',
    async (_event, accountId: string, threadId: string, options?: { withSource?: boolean }) => {
      try {
        const storage = await requireAccountStorage(accountId);
        return { success: true, data: readFirstSplit(storage, threadId, !!options?.withSource) };
      } catch (error) {
        logger.warn(`firstSplit:get failed acct=${accountId} thread=${threadId}: ${(error as Error).message}`);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /** Store a run's result in ONE account; main re-checks the key inside the write. */
  ipcMain.handle('ai:firstSplit:save', async (_event, accountId: string, request: FirstSplitSaveRequest) => {
    try {
      const storage = await requireAccountStorage(accountId);
      const result = storage.saveFirstSplit(request);
      if (result.reason === 'invalid') {
        logger.warn(`firstSplit:save refused an invalid payload acct=${accountId} thread=${request?.key?.threadId ?? '?'} status=${request?.status ?? '?'}`);
      }
      return { success: true, data: result };
    } catch (error) {
      logger.warn(`firstSplit:save failed acct=${accountId} thread=${request?.key?.threadId ?? '?'}: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  });

  /** Clear the cache in every account (Settings → Clear Cache). */
  ipcMain.handle('ai:firstSplit:clearAll', async () => {
    try {
      const result = await clearFirstSplitsInEveryAccount();
      logger.info(`firstSplit:clearAll cleared=${result.cleared} splits=${result.splits} failedAccounts=${result.failedAccounts.length}`);
      return { success: true, data: result };
    } catch (error) {
      // Only the registry read can throw here: which accounts exist is unknown,
      // so nothing may be reported as cleared.
      const message = (error as Error)?.message ?? String(error);
      logger.warn(`firstSplit:clearAll could not read the account list: ${message}`);
      return { success: false, error: `Could not read the account list: ${message}` };
    }
  });

  /**
   * Save email AI category
   */
  ipcMain.handle('ai:saveCategory', async (_event, category: any) => {
    try {
      const storage = requireStorage();
      await storage.upsertEmailAICategory(category);
      return { success: true };
    } catch (error) {
      logger.error('AI saveCategory error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Remove AI category for an email
   */
  ipcMain.handle('ai:removeCategory', async (_event, emailId: string) => {
    try {
      const storage = requireStorage();
      await storage.removeEmailAICategory(emailId);
      return { success: true };
    } catch (error) {
      logger.error('AI removeCategory error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get emails without AI category (for batch processing)
   */
  ipcMain.handle('ai:getUnprocessedEmails', async (_event, limit = 100) => {
    try {
      const storage = requireStorage();
      const emails = await storage.getEmailsWithoutAICategory(limit);
      return { success: true, data: emails };
    } catch (error) {
      logger.error('AI getUnprocessedEmails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Batch save AI categories (transactional)
   */
  ipcMain.handle('ai:saveCategoriesBatch', async (_event, categories: any[]) => {
    try {
      const storage = requireStorage();
      const saved = storage.upsertCategoryBatch(categories);
      return { success: true, data: { saved } };
    } catch (error) {
      logger.error('AI saveCategoriesBatch error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get count of unprocessed emails
   */
  ipcMain.handle('ai:getUnprocessedEmailCount', async (_event, limit = 10000, skipRead = true) => {
    try {
      const storage = requireStorage();
      const count = await storage.getUnprocessedEmailCount(limit, skipRead);
      return { success: true, data: count };
    } catch (error) {
      logger.error('AI getUnprocessedEmailCount error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Transparency breakdown — explains why "100% complete" can coexist
   * with thousands of synced emails. Returns the bucket counts the user
   * needs to understand the eligibility pipeline:
   *   - total synced
   *   - bodies downloaded vs missing
   *   - read emails (skipped by policy)
   *   - eligible right now (unread + body + not Spam/Trash + not done)
   *   - already AI-processed
   *   - unread with body / unread no body (telemetry for body prefetch)
   */
  ipcMain.handle('ai:getProcessingBreakdown', async () => {
    try {
      const storage = requireStorage() as any;
      const db = storage.db;
      if (!db?.prepare) return { success: false, error: 'DB not available' };

      // The whole breakdown lives in storage-node beside the eligibility clauses
      // it is built from, so this handler cannot drift from what the worker
      // treats as eligible — and so the counts are testable against a real
      // migrated database instead of only through the IPC surface.
      // Pass the user's "AI Processing Limit" so the agent backlog row counts
      // what the poll can actually REACH, not merely what exists.
      const data = processingBreakdown(db, { recentWindow: getAutoBacklogCap() });
      return { success: true, data };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Push the user's "AI Processing Limit" setting into the main process.
   *
   * The setting lives in the renderer's localStorage, but the BACKGROUND poll
   * runs here — so before this existed, raising the limit changed the manual
   * run's batch size and nothing else, while the background window stayed
   * hardcoded at 500. A user with 252 fully-eligible older emails set it to
   * "All" and watched nothing happen.
   */
  ipcMain.handle('ai:setBacklogCap', async (_event, cap: number) => {
    try {
      return { success: true, data: { cap: setAutoBacklogCap(cap) } };
    } catch (error) {
      logger.error('AI setBacklogCap error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /** The window the background pipeline is currently using. */
  ipcMain.handle('ai:getBacklogCap', async () => {
    try {
      return { success: true, data: { cap: getAutoBacklogCap() } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Set whether AI provider is configured (controls scheduler)
   */
  ipcMain.handle('ai:setProviderConfigured', async (_event, configured: boolean) => {
    setAIProviderConfigured(configured);
    // No provider anymore → forget the persisted pipeline config so a later
    // restart doesn't restore a removed provider and try to use it.
    if (!configured) void clearPipelineAIConfig();
    return { success: true };
  });

  /**
   * Set whether the background first-email split is switched on (conversation
   * mode AND 'Auto Chat Extract'); the nomination scheduler neither scans nor
   * nominates while it is off. Anything but `true` reads as off.
   */
  ipcMain.handle('ai:setBackgroundSplitEnabled', async (_event, enabled: unknown) => {
    setBackgroundSplitEnabled(enabled === true);
    return { success: true };
  });

  // ========== Agent Prompt Templates ==========
  // Let the renderer list, edit, and reset the three editable agent
  // prompts (categorization_system / agent_plan / agent_draft). All
  // prompts are seeded at startup by the pipeline service; these
  // handlers only read/write the `content` column.

  ipcMain.handle('ai:listPromptTemplates', async () => {
    try {
      const storage = requireStorage();
      const repo = (storage as any).getRepositories?.()?.prompts;
      return { success: true, data: repo?.list?.() || [] };
    } catch (error) {
      logger.error('AI listPromptTemplates error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('ai:updatePromptTemplate', async (_event, id: string, content: string) => {
    try {
      if (!id || typeof content !== 'string') {
        return { success: false, error: 'id and content are required' };
      }
      const storage = requireStorage();
      const repo = (storage as any).getRepositories?.()?.prompts;
      const updated = repo?.update?.(id, content) || false;
      return { success: updated };
    } catch (error) {
      logger.error('AI updatePromptTemplate error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('ai:resetPromptTemplate', async (_event, id: string) => {
    try {
      const storage = requireStorage();
      const repo = (storage as any).getRepositories?.()?.prompts;
      const reset = repo?.reset?.(id) || false;
      return { success: reset };
    } catch (error) {
      logger.error('AI resetPromptTemplate error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * AI Search - executes a structured search query
   * All filtering (folder, AI category, operators) done at DB level in a single query
   */
  ipcMain.handle(
    'ai:search',
    async (
      _event,
      searchQuery: {
        from?: string;
        to?: string;
        subject?: string;
        hasAttachments?: boolean;
        isUnread?: boolean;
        isFlagged?: boolean;
        dateFrom?: number;
        dateTo?: number;
        textQuery?: string;
        labels?: string[];
        tags?: string[];
        folderId?: string;
        aiCategory?: string;
        noCategory?: boolean;
        doesntHave?: string;
        sizeMin?: number;
        sizeMax?: number;
        cc?: string;
        limit?: number;
        offset?: number;
      }
    ) => {
      try {
        const storage = requireStorage();
        logger.info('[AI Search] Executing structured query:', searchQuery);

        // Resolve folder path from folderId
        let folderPath: string | undefined;
        if (searchQuery.folderId) {
          const folder = await storage.getFolder(searchQuery.folderId);
          folderPath = folder?.path;
        }

        // Single DB query with all filters combined
        const emails = await storage.searchEmails({
          query: searchQuery.textQuery || '',
          folderPath,
          scope: folderPath ? 'folder' : 'all',
          aiCategory: searchQuery.aiCategory,
          noCategory: searchQuery.noCategory,
          from: searchQuery.from,
          to: searchQuery.to,
          subject: searchQuery.subject,
          hasAttachments: searchQuery.hasAttachments,
          isUnread: searchQuery.isUnread,
          isFlagged: searchQuery.isFlagged,
          dateFrom: searchQuery.dateFrom,
          dateTo: searchQuery.dateTo,
          labels: searchQuery.labels,
          // `tag:` — the only route to a tag an extension applied; dropping it
          // here would silently widen the search back to the whole mailbox.
          tags: searchQuery.tags,
          doesntHave: searchQuery.doesntHave,
          sizeMin: searchQuery.sizeMin,
          sizeMax: searchQuery.sizeMax,
          cc: searchQuery.cc,
          // Paginated: the renderer requests one page (offset = page * pageSize)
          // so a filter matching thousands of mails pages through them all rather
          // than being capped. Defaults keep non-paginated callers working.
          limit: searchQuery.limit ?? 100,
          offset: searchQuery.offset ?? 0,
          sortBy: searchQuery.textQuery ? 'relevance' : 'date',
          sortOrder: 'desc',
        });

        logger.info(`[AI Search] Found ${emails.length} results (folder=${folderPath || 'all'}, aiCategory=${searchQuery.aiCategory || 'none'})`);
        return { success: true, data: emails };
      } catch (error) {
        logger.error('[AI Search] Error:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // True total for the search paginator — COUNT of ALL matches (no limit/offset),
  // so the list shows "1–25 of <all>" over the whole mailbox. Same query shape as
  // ai:search (minus paging/sort).
  ipcMain.handle(
    'ai:searchCount',
    async (_event, searchQuery: Record<string, any>) => {
      try {
        const storage = requireStorage();
        let folderPath: string | undefined;
        if (searchQuery.folderId) {
          const folder = await storage.getFolder(searchQuery.folderId);
          folderPath = folder?.path;
        }
        const total = await (storage as any).searchEmailsCount({
          query: searchQuery.textQuery || '',
          folderPath,
          scope: folderPath ? 'folder' : 'all',
          aiCategory: searchQuery.aiCategory,
          noCategory: searchQuery.noCategory,
          from: searchQuery.from,
          to: searchQuery.to,
          subject: searchQuery.subject,
          hasAttachments: searchQuery.hasAttachments,
          isUnread: searchQuery.isUnread,
          isFlagged: searchQuery.isFlagged,
          dateFrom: searchQuery.dateFrom,
          dateTo: searchQuery.dateTo,
          labels: searchQuery.labels,
          // `tag:` — the only route to a tag an extension applied; dropping it
          // here would silently widen the search back to the whole mailbox.
          tags: searchQuery.tags,
          doesntHave: searchQuery.doesntHave,
          sizeMin: searchQuery.sizeMin,
          sizeMax: searchQuery.sizeMax,
          cc: searchQuery.cc,
        });
        return { success: true, data: total };
      } catch (error) {
        logger.error('[AI Search] Count error:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  /**
   * Search suggestions — FTS5 vocab prefix autocomplete
   */
  ipcMain.handle('search:suggest', async (_event, partial: string) => {
    try {
      const storage = requireStorage();
      const terms = storage.getSearchSuggestions(partial);
      return { success: true, data: terms };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
