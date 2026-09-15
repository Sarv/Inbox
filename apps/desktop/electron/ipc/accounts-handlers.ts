/**
 * Multi-account IPC.
 *
 * `accounts:setActive` flips the main-process "current account" pointer so all
 * the existing storage/sync/SMTP accessors resolve the chosen account, lazily
 * creating that account's runtime (its own DB) on first use and re-pointing the
 * outbox at it. The renderer then drives connect/sync through the existing IPC.
 *
 * `accounts:unifiedInbox` / `accounts:unreadSummary` fan a READ across accounts
 * for the unified "All Inboxes" view + per-account badges. They read each
 * account's own SQLite DB (no IMAP connection needed) and never mutate anything.
 *
 * DB ownership is deterministic (see ensureAccountRuntime): the persisted PRIMARY
 * account owns the legacy `sarvinbox.db`; every other account gets its own
 * `sarvinbox-<id>.db`. This holds across restarts even when a secondary account
 * is active on launch, so no account can grab the primary's database.
 */
import type { EmailRecord, ViewFilter } from '@sarvinbox/core';
import { createLogger } from '@sarvinbox/core';
import { ipcMain } from 'electron';


import {
  listRegistryAccounts,
  readRegistryAccounts,
  upsertRegistryAccounts,
  removeRegistryAccount,
  getRegistryActiveAccountId,
  setRegistryActiveAccountId,
  getAllAppSettings,
  setAppSetting,
  deleteAppSetting,
  type RegistryAccount,
} from '../services/accounts-registry';
import { ensureAccountRuntime, loadPrimaryAccountId, savePrimaryAccountId, accountInboxUnread, rekeyAccount, deleteAccountData, legacyDbExists, cleanupOrphanedAccountDbs } from '../services/accounts-runtime';
import { rebindOutboxStorage } from '../services/outbox-service';
import { disablePipelineAIIfProviderRemoved } from '../services/unified-pipeline-service';
import { setCurrentAccount, hasAccountRuntime, getCurrentAccountId } from '../shared';

const logger = createLogger('accounts-handlers');

/** Resolve an account's INBOX folder (by canonical path, then name fallback). */
async function findInbox(storage: { getFolders: () => Promise<any[]> }): Promise<any | null> {
  const folders = await storage.getFolders();
  return folders.find((f) => f.path === 'INBOX' || f.name?.toLowerCase() === 'inbox') ?? null;
}

export function registerAccountsHandlers(): void {
  // ===== Durable accounts registry (DB-backed source of truth) =============
  // The account list + active pointer live in an encrypted main-process DB
  // (accounts-registry) so they survive a lost/corrupt renderer localStorage.
  // The renderer HYDRATES from `accounts:list` on startup and MIRRORS every
  // change back via `accounts:save`, keeping the DB complete.

  // Full account list (secrets excluded) — the renderer merges these into its
  // in-memory registry so an account the DB knows about is never lost.
  ipcMain.handle('accounts:list', async () => {
    try {
      return { success: true, data: listRegistryAccounts() };
    } catch (error) {
      logger.error('[Accounts] list failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Mirror the renderer's registry snapshot into the DB (upsert-only — a
  // transiently-empty snapshot can never wipe the durable list). Removal is
  // explicit via accounts:remove.
  ipcMain.handle('accounts:save', async (_event, accounts: RegistryAccount[]) => {
    try {
      upsertRegistryAccounts(accounts ?? []);
      return { success: true };
    } catch (error) {
      logger.error('[Accounts] save failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // The persisted active-account id (used by the renderer to resolve which
  // account to show when localStorage lost its pointer).
  ipcMain.handle('accounts:getActive', async () => {
    try {
      return { success: true, data: getRegistryActiveAccountId() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Lightweight active-pointer persist (NO runtime side effects — unlike
  // accounts:setActive which also spins up the account's runtime). Used by the
  // renderer whenever it changes the active account locally.
  ipcMain.handle('accounts:setActivePointer', async (_event, accountId: string | null) => {
    try {
      setRegistryActiveAccountId(accountId ?? null);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ===== Global app settings (durable mirror of localStorage) =============
  // SYNCHRONOUS boot read: the renderer restores managed settings into
  // localStorage in its earliest bootstrap, BEFORE any module reads them, so
  // every existing synchronous settings reader keeps working. Registered as a
  // sync channel (sendSync) so it resolves inline during that bootstrap.
  ipcMain.on('appSettings:getAllSync', (event) => {
    try {
      event.returnValue = getAllAppSettings();
    } catch (error) {
      logger.error('[Settings] getAllSync failed:', error);
      event.returnValue = {};
    }
  });

  // Async mirror of a localStorage write (fire-and-forget from the renderer).
  ipcMain.handle('appSettings:set', async (_event, key: string, value: string) => {
    try {
      setAppSetting(key, value);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Async mirror of a localStorage.removeItem.
  ipcMain.handle('appSettings:delete', async (_event, key: string) => {
    try {
      deleteAppSetting(key);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // One-time account-id canonicalization: migrate every main-process store
  // keyed by a legacy id (DB file, vault, primary pointer, in-memory runtime)
  // to the canonical `acct-<email>--<host>` id. Renderer-driven + idempotent.
  ipcMain.handle('accounts:rekey', async (_event, oldId: string, newId: string) => {
    try {
      if (!oldId || !newId) return { success: false, error: 'oldId + newId required' };
      await rekeyAccount(oldId, newId);
      return { success: true };
    } catch (error) {
      logger.error('[Accounts] rekey failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Permanently wipe a removed account's local data: its DB (the legacy
  // sarvinbox.db if it was the primary, else its per-id file), in-memory
  // runtime, and vaulted secrets. Caller must have switched the active account
  // away first. Idempotent.
  ipcMain.handle('accounts:remove', async (_event, accountId: string) => {
    try {
      if (!accountId) return { success: false, error: 'No accountId provided' };
      await deleteAccountData(accountId);
      // Drop it from the durable registry too, so it doesn't reappear on the
      // next hydrate/seed.
      removeRegistryAccount(accountId);

      // Now the registry is authoritative (we just dropped this account from it),
      // so sweep EVERY leftover DB that doesn't belong to a still-existing account
      // — this account's data in ANY naming scheme (current hashed, legacy raw
      // `sarvinbox-acct-*.db`, oldest plaintext `acct-*`) PLUS historical orphans
      // from since-removed/rekeyed identities. `keepAccountIds` (the remaining
      // registry) is the safety: a live/background account's DB is NEVER touched.
      // `staleAfterMs: 0` disables the mtime guard — deliberate here, and exactly
      // why the keep-set must be REAL: with no staleness fallback, a registry read
      // that failed and answered `[]` would nuke every remaining mailbox on the
      // spot. `readRegistryAccounts` throws instead, and the sweep itself refuses
      // to act on an empty keep-set. Best-effort.
      try {
        const keepAccountIds = readRegistryAccounts().map((a) => a.id);
        const removed = cleanupOrphanedAccountDbs({ keepAccountIds, staleAfterMs: 0 });
        if (removed.length) logger.info(`[Accounts] removal swept ${removed.length} orphan file(s):`, removed.join(', '));
      } catch (e) {
        logger.warn('[Accounts] orphan sweep after removal SKIPPED (nothing deleted):', (e as Error).message);
      }

      // The removed account may have been the OAuth session powering the AI/LLM
      // (Sarv is both mailbox AND LLM). If so, its token is gone and every
      // categorization would now throw "No OAuth account" forever — disable AI
      // cleanly and surface it instead. Best-effort; no-op for API-key providers
      // or when the provider account is still present.
      try { await disablePipelineAIIfProviderRemoved(); }
      catch (e) { logger.warn('[Accounts] AI provider revalidation after removal failed:', (e as Error).message); }

      return { success: true };
    } catch (error) {
      logger.error('[Accounts] remove failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('accounts:setActive', async (_event, accountId: string) => {
    try {
      if (!accountId) return { success: false, error: 'No accountId provided' };
      if (getCurrentAccountId() === accountId && hasAccountRuntime(accountId)) {
        return { success: true };
      }

      // NOTE: we deliberately do NOT disconnect the previous account's engine on
      // switch. Tearing it down made switching BACK slow (full reconnect →
      // "Connecting…"). Background connections stay alive for instant switching;
      // the sync-handlers active-engine guard keeps a background account's
      // connection events from touching the shared UI status.

      // LEGACY ONLY: adopt the existing sarvinbox.db for the first account that
      // activates AND only when that file already exists. A fresh install has no
      // sarvinbox.db, so no primary is set and every account uses its per-id DB.
      if (!loadPrimaryAccountId() && legacyDbExists()) savePrimaryAccountId(accountId);

      // Flip the pointer, then ensure this account's runtime exists (claims the
      // startup sarvinbox.db for the primary; opens sarvinbox-<id>.db otherwise).
      setCurrentAccount(accountId);
      if (!hasAccountRuntime(accountId)) {
        await ensureAccountRuntime(accountId);
      }

      // Persist the active pointer durably so main can auto-activate this
      // account on the next launch without waiting on the renderer.
      setRegistryActiveAccountId(accountId);

      // Drain/send from the now-active account's outbox.
      rebindOutboxStorage();
      return { success: true };
    } catch (error) {
      logger.error('[Accounts] setActive failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Merged INBOX across the given accounts, tagged with accountId and sorted
  // newest-first. Reads each account's own DB — cheap, connection-free. Uses
  // offset-based over-fetch (fetch offset+limit per account, merge, slice) so no
  // message is ever dropped across the merge boundary; bounded by `limit`.
  ipcMain.handle(
    'accounts:unifiedInbox',
    async (_event, opts: { accountIds: string[]; limit?: number; offset?: number; filter?: ViewFilter; aiCategory?: string }) => {
      try {
        const accountIds = opts?.accountIds ?? [];
        const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
        const offset = Math.max(0, opts?.offset ?? 0);
        // An active view filter (unread/starred/attachment) and/or category tab
        // is applied per account in SQL so All-Inboxes honors where the user is —
        // each result still carries its accountId for the per-account color.
        const filter = opts?.filter;
        const categoryTag = opts?.aiCategory;
        const fetchPerAccount = offset + limit;

        // Parallel + per-account try/catch: one unreadable account never breaks
        // the whole view or stalls the others.
        const perAccount = await Promise.all(
          accountIds.map(async (accountId): Promise<{ emails: EmailRecord[]; total: number }> => {
            try {
              const rt = await ensureAccountRuntime(accountId);
              if (!rt?.storage) return { emails: [], total: 0 };
              const inbox = await findInbox(rt.storage);
              if (!inbox) return { emails: [], total: 0 };
              const [emails, total] = await Promise.all([
                rt.storage.getEmailsByFolder(inbox.id, { limit: fetchPerAccount, offset: 0, filter, categoryTag }),
                // The "of N" for All Inboxes. `merged.length` can't be it: each
                // account is only over-fetched to offset+limit, so the merged
                // array is a page window, not the mailbox. Counted per account
                // under the SAME filter, so the denominator matches the list.
                rt.storage.countEmailsInFolder?.(inbox.id, { filter, categoryTag }) ?? Promise.resolve(0),
              ]);
              return { emails: emails.map((e) => ({ ...e, accountId })), total };
            } catch (e) {
              logger.warn('[Accounts] unifiedInbox: skipping account', accountId, (e as Error).message);
              return { emails: [], total: 0 };
            }
          }),
        );

        const merged = perAccount.flatMap((a) => a.emails).sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
        const total = perAccount.reduce((sum, a) => sum + a.total, 0);
        const page = merged.slice(offset, offset + limit);
        return { success: true, data: { emails: page, total, hasMore: total > 0 ? offset + page.length < total : merged.length > offset + limit } };
      } catch (error) {
        logger.error('[Accounts] unifiedInbox failed:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  // Merged AI-category counts across accounts (INBOX-scoped per account), so the
  // category tabs on All Inboxes show totals that match the unified list rather
  // than only the active account's numbers.
  ipcMain.handle('accounts:unifiedCategoryCounts', async (_event, accountIds: string[], mode: 'unread' | 'total' = 'unread') => {
    try {
      const perAccount = await Promise.all(
        (accountIds ?? []).map(async (accountId): Promise<Record<string, number>> => {
          try {
            const rt = await ensureAccountRuntime(accountId);
            if (!rt?.storage) return {};
            const inbox = await findInbox(rt.storage);
            return rt.storage.getDynamicCategoryCounts(inbox?.id, mode) as Record<string, number>;
          } catch {
            return {};
          }
        }),
      );
      const merged: Record<string, number> = {};
      for (const counts of perAccount) {
        for (const [slug, n] of Object.entries(counts)) merged[slug] = (merged[slug] ?? 0) + (n ?? 0);
      }
      return { success: true, data: merged };
    } catch (error) {
      logger.error('[Accounts] unifiedCategoryCounts failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Full-text/structured search across EVERY opted-in account's INBOX, so a search
  // run from "All Inboxes" respects that view (spans all accounts) instead of only
  // the active one. Each account is searched in its own DB and results are tagged
  // with accountId (for the per-account color) and merged newest-first.
  ipcMain.handle('accounts:unifiedSearch', async (_event, opts: { accountIds: string[]; searchQuery: Record<string, any>; limit?: number; offset?: number }) => {
    try {
      const accountIds = opts?.accountIds ?? [];
      const sq = opts?.searchQuery ?? {};
      const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
      const offset = Math.max(0, opts?.offset ?? 0);
      // Over-fetch offset+limit per account, merge, then slice the page — same
      // pattern as unifiedInbox, so paging never drops a row at the merge boundary.
      const fetchPerAccount = offset + limit;
      const perAccount = await Promise.all(
        accountIds.map(async (accountId): Promise<EmailRecord[]> => {
          try {
            const rt = await ensureAccountRuntime(accountId);
            if (!rt?.storage) return [];
            const inbox = await findInbox(rt.storage);
            const emails = await rt.storage.searchEmails({
              query: sq.textQuery || '',
              folderPath: inbox?.path,
              scope: inbox?.path ? 'folder' : 'all',
              aiCategory: sq.aiCategory,
              noCategory: sq.noCategory,
              from: sq.from, to: sq.to, subject: sq.subject,
              hasAttachments: sq.hasAttachments, isUnread: sq.isUnread, isFlagged: sq.isFlagged,
              dateFrom: sq.dateFrom, dateTo: sq.dateTo, labels: sq.labels, doesntHave: sq.doesntHave,
              sizeMin: sq.sizeMin, sizeMax: sq.sizeMax, cc: sq.cc,
              limit: fetchPerAccount, offset: 0,
              sortBy: sq.textQuery ? 'relevance' : 'date', sortOrder: 'desc',
            });
            return emails.map((e) => ({ ...e, accountId }));
          } catch (e) {
            logger.warn('[Accounts] unifiedSearch: skipping account', accountId, (e as Error).message);
            return [];
          }
        }),
      );
      const merged = perAccount.flat().sort((a, b) => (b.date ?? 0) - (a.date ?? 0)).slice(offset, offset + limit);
      return { success: true, data: merged };
    } catch (error) {
      logger.error('[Accounts] unifiedSearch failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Per-account INBOX unread (distinct-thread count) for the "All Inboxes" badge
  // and account switcher — the SAME unit/scope as the inbox list, so the numbers
  // match what the user sees (see accountInboxUnread). Reads the stored
  // folders.unread_count column (no scan/download); the background INBOX catch-up
  // sync keeps non-active accounts' INBOX thread count fresh.
  ipcMain.handle('accounts:unreadSummary', async (_event, accountIds: string[]) => {
    try {
      const summary = await Promise.all(
        (accountIds ?? []).map(async (accountId) => {
          try {
            const rt = await ensureAccountRuntime(accountId);
            if (!rt?.storage) return { accountId, unread: 0 };
            const folders = await rt.storage.getFolders();
            return { accountId, unread: accountInboxUnread(folders) };
          } catch {
            return { accountId, unread: 0 };
          }
        }),
      );
      return { success: true, data: summary };
    } catch (error) {
      logger.error('[Accounts] unreadSummary failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  logger.info('[IPC] Accounts handlers registered');
}
