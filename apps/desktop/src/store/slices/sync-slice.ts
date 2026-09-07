import type { RealtimeEvent } from '@sarvinbox/core';
import pLimit from 'p-limit';

import { clearCategoryBadgeCache } from '../../components/email-list/CategoryBadges';
import { findFolderByType } from '../../config/folder-mapping';
import { buildThreads } from '../../utils/thread-utils';
import { getMaxEmailsPerFolder, getBodyDownloadLimit } from '../helpers';
import type { SyncSlice, SliceCreator } from '../types';

import { buildEmailReplacementPatch, selectLoadedEmailIds } from './emails-slice';

/**
 * Trailing window for coalescing IMAP realtime (IDLE) events.
 *
 * The server emits ONE event per message. A flag reconcile after the app was
 * asleep — or a "mark all read" done on the phone — therefore arrives as a
 * burst of hundreds of events within a second or two. Handling each one
 * individually meant one IPC round trip plus a whole-list `set()` (and so a
 * full buildThreads + list re-render) EACH, which froze the UI for seconds.
 *
 * We buffer instead and do one refresh pass per window. 350ms is long enough
 * to swallow a burst, short enough that a single real change (someone reading
 * a mail on their phone) still lands as "instant" to the eye.
 */
const REALTIME_COALESCE_MS = 350;

/**
 * Ceiling on how long a continuous stream can defer the flush. Without it a
 * steady trickle of events (each resetting the trailing timer) would starve
 * the UI of updates for the whole duration of the burst.
 */
const REALTIME_COALESCE_MAX_MS = 1_000;

/** Parallel `emails:get` round trips while re-reading flag-changed rows. */
const EMAIL_REFRESH_CONCURRENCY = 8;

/**
 * Consecutive sync failures before we tell the user mail isn't flowing. One
 * failure is often a transient blip (a single 60s op timeout on a busy server
 * that the reconnect ladder recovers from), so surfacing on the FIRST would
 * flicker; two-in-a-row means the server genuinely isn't serving this account.
 */
const SYNC_TROUBLE_STREAK = 2;

/**
 * Above this many new arrivals in one window, fetch bodies through the batch
 * IPC (one round trip, main-side parallelism, batched store writes) instead of
 * one `fetchEmailBody` per id. Single arrivals — the common case — keep the
 * per-id path so their richer handling (deleted-on-server cleanup, failure
 * memoisation) is unchanged.
 */
const BODY_BATCH_THRESHOLD = 4;

/** Everything one coalescing window accumulated, in the order flush needs it. */
interface RealtimeBatch {
  /** true once anything at all was queued — flush is a no-op otherwise. */
  queued: boolean;
  /** ACTIVE-account arrivals, keyed by arrival folder ('' = folder unknown). */
  newByFolder: Map<string, Set<string>>;
  /** An arrival was seen on ANY account (drives unified/curated/badges). */
  sawNew: boolean;
  /** An arrival was seen on the ACTIVE account (drives the local pipelines). */
  sawActiveNew: boolean;
  /** ACTIVE-account flag changes — rows to re-read from the DB. */
  flaggedIds: Set<string>;
  /**
   * Folders the SERVER changed flags in (webmail read/unread/star), from the
   * per-email events. Their view query is now stale even though no row came or
   * went: rows may have stopped matching the active quick-filter, the filtered
   * totals moved, and rows beyond the loaded page may have started matching.
   * Re-queried once per window — but only when it could show (see the flush).
   */
  flaggedFolders: Set<string>;
  /**
   * Folders main-process reconciled WITHOUT per-email events — the non-INBOX
   * flag sweep (IDLE watches INBOX only). We don't know which rows moved, so
   * these are always re-queried.
   */
  staleFolders: Set<string>;
  /** A non-active account event was seen (badges + unified only). */
  sawBackground: boolean;
  /** Deletions apply to every account: ids to drop, folders to re-check. */
  deletedIds: Set<string>;
  deletedFolders: Set<string>;
  /** A deletion arrived without a folder → fall back to the virtual merges. */
  deletedWithoutFolder: boolean;
  sawDeleted: boolean;
  /** Any event that can move a folder's unread/total count. */
  needFolders: boolean;
}

const createRealtimeBatch = (): RealtimeBatch => ({
  queued: false,
  newByFolder: new Map(),
  sawNew: false,
  sawActiveNew: false,
  flaggedIds: new Set(),
  flaggedFolders: new Set(),
  staleFolders: new Set(),
  sawBackground: false,
  deletedIds: new Set(),
  deletedFolders: new Set(),
  deletedWithoutFolder: false,
  sawDeleted: false,
  needFolders: false,
});

/**
 * Single source of truth for refreshing the visible view after new
 * emails land in the DB. Used by:
 *   • syncSingleFolder (manual sync, periodic poll)
 *   • handleRealtimeEvent ('new' event via IDLE)
 *   • any future caller that adds rows to the DB out-of-band
 *
 * The five view shapes need different refresh strategies. Without this
 * dispatch, sectioned INBOX (Important / Starred / Everything else)
 * stays stale even after mergeNewEmails fires — because that view
 * reads from `sectionData`, not the flat `emails` array.
 *
 * All paths are smooth in-place merges (diff-and-prepend); no clear,
 * no flicker, scroll position + selected email + compose drawer stay
 * put.
 */
async function refreshVisibleViewForFolder(
  get: () => any,
  folderPath: string,
): Promise<void> {
  try {
    const state = get();
    const eventFolder = (state.folders || []).find((f: any) => f.path === folderPath);
    const isCurrentFolder =
      state.selectedFolderId && eventFolder && state.selectedFolderId === eventFolder.id;

    if (state.viewingAICategory && isCurrentFolder) {
      // AI-categorized view (Needs Response, Reminders, etc.).
      console.log(`[Store] refreshView: re-fetching AI category (${state.viewingAICategory}) after ${folderPath} sync`);
      await state.loadAICategoryEmails?.(state.viewingAICategory);
    } else if (
      isCurrentFolder &&
      folderPath === 'INBOX' &&
      state.inboxType !== 'default' &&
      state.inboxSections.length > 0
    ) {
      // SECTIONED INBOX. Visible data lives in `sectionData`, not
      // `emails` — a plain mergeNewEmails would update the wrong
      // store slot and look like a no-op to the user.
      console.log(`[Store] refreshView: reloading sections for ${folderPath}`);
      await state.loadAllSections?.(folderPath);
    } else if (isCurrentFolder) {
      // Flat folder view — diff against `emails` and prepend new rows.
      await state.mergeNewEmails(state.selectedFolderId!);
    } else if (state.selectedVirtualFolder === 'virtual-all') {
      await state.mergeNewEmailsVirtualAll?.();
    } else if (state.selectedVirtualFolder === 'virtual-starred') {
      await state.mergeNewEmailsVirtualStarred?.();
    }
    // Other cases (different real folder, curated AI/snoozed/search
    // view not matching the folder): leave the list alone, only the
    // sidebar badge updates via loadFolders elsewhere.
  } catch (err) {
    console.warn(`[Store] refreshVisibleViewForFolder failed for ${folderPath}:`, err);
  }
}

// ---- Realtime (IDLE) event coalescer -----------------------------------------
// Transient plumbing, not UI state — nothing renders off it, and a `set()` per
// event is precisely what we're eliminating. Module scope matches the other
// cross-call guards in this store (`sectionLoadSeq`, `bgSyncRunning`).
let batch = createRealtimeBatch();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let windowStartedAt = 0;
let flushing = false;

type StoreGet = () => any;
type StoreSet = (patch: any) => void;

function scheduleFlush(set: StoreSet, get: StoreGet): void {
  if (flushTimer) clearTimeout(flushTimer);
  // Trailing debounce, clamped so a continuous stream still paints ~1/s.
  const elapsed = Date.now() - windowStartedAt;
  const delay = Math.max(0, Math.min(REALTIME_COALESCE_MS, REALTIME_COALESCE_MAX_MS - elapsed));
  flushTimer = setTimeout(() => { void flushRealtimeBatch(set, get); }, delay);
}

/** Re-read the given rows and swap them in with a SINGLE store write. */
async function refreshChangedEmails(set: StoreSet, get: StoreGet, ids: Set<string>): Promise<number> {
  // Only rows the renderer actually holds can change what's on screen —
  // re-reading the rest is pure IPC waste (the merge would no-op anyway).
  const loaded = selectLoadedEmailIds(get());
  const targets = [...ids].filter((id) => loaded.has(id));
  if (targets.length === 0) return 0;

  const limit = pLimit(EMAIL_REFRESH_CONCURRENCY);
  const rows = await Promise.all(
    targets.map((id) => limit(async () => {
      try {
        const result = await window.electronAPI.emails.get(id);
        return result.success && result.data ? (result.data as any) : null;
      } catch {
        return null; // one unreadable row must not sink the batch
      }
    })),
  );

  const fresh = new Map<string, any>();
  for (const row of rows) if (row?.id) fresh.set(row.id, row);
  // Re-read state AFTER the awaits — the user may have navigated meanwhile.
  const patch = buildEmailReplacementPatch(get(), fresh);
  if (patch) set(patch as any);
  return fresh.size;
}

/** Drop every deleted row from the flat list, the sections and the banner queue. */
function applyDeletions(set: StoreSet, get: StoreGet, deletedIds: Set<string>): void {
  const state = get();

  const nextEmails = state.emails.filter((e: any) => !deletedIds.has(e.id));
  const emailsChanged = nextEmails.length !== state.emails.length;

  const currentSectionData = state.sectionData || {};
  let nextSectionData: typeof currentSectionData | null = null;
  for (const [sectionId, sd] of Object.entries(currentSectionData)) {
    const bucket = sd as any;
    if (!bucket?.emails) continue;
    const filtered = bucket.emails.filter((e: any) => !deletedIds.has(e.id));
    const removed = bucket.emails.length - filtered.length;
    if (removed === 0) continue;
    if (!nextSectionData) nextSectionData = { ...currentSectionData };
    // Sectioned views render from `threads`; the shape's count key is `total`.
    (nextSectionData as any)[sectionId] = {
      ...bucket,
      emails: filtered,
      threads: buildThreads(filtered),
      total: Math.max(0, (bucket.total || 0) - removed),
    };
  }

  // Drop deleted messages from the "new message" banner queue so its count
  // can't outlive the messages it referred to.
  const pending = state.pendingThreadEmailIds;
  const nextPending = pending.filter((id: string) => !deletedIds.has(id));

  // The Unread filter's flat-search variant (and any active search) renders from
  // `searchResults`, NOT `emails`/`sectionData` — so a deleted row lingers in that
  // view until a full reload rebuilds searchResults. Drop it here too, mirroring
  // the user-initiated deleteEmail path (email-actions-slice.ts), and decrement
  // searchTotal so the "1–N of N" header stays correct.
  const searchResults = state.searchResults;
  const nextSearchResults = searchResults.filter((e: any) => !deletedIds.has(e.id));
  const searchRemoved = searchResults.length - nextSearchResults.length;

  if (!emailsChanged && !nextSectionData && searchRemoved === 0 && nextPending.length === pending.length) return;
  const patch: any = {};
  if (emailsChanged) patch.emails = nextEmails;
  if (nextSectionData) patch.sectionData = nextSectionData;
  if (searchRemoved > 0) {
    patch.searchResults = nextSearchResults;
    patch.searchTotal = Math.max(0, (state.searchTotal || 0) - searchRemoved);
  }
  if (nextPending.length !== pending.length) patch.pendingThreadEmailIds = nextPending;
  set(patch);
}

/**
 * Apply one window's worth of events. Every expensive call in here runs AT
 * MOST ONCE per window (or once per affected folder), where the old
 * per-event handler ran them once per message.
 */
async function flushRealtimeBatch(set: StoreSet, get: StoreGet): Promise<void> {
  flushTimer = null;
  if (flushing) {
    // A previous flush is still awaiting IPC — retry after the next window
    // rather than interleaving two passes over the same state.
    flushTimer = setTimeout(() => { void flushRealtimeBatch(set, get); }, REALTIME_COALESCE_MS);
    return;
  }

  const pending = batch;
  batch = createRealtimeBatch();
  windowStartedAt = 0;
  if (!pending.queued) return;

  flushing = true;
  const startedAt = Date.now();
  try {
    // Deletions win over anything else queued for the same message in this
    // window — never re-read or body-fetch a row we're about to remove.
    for (const id of pending.deletedIds) pending.flaggedIds.delete(id);
    for (const ids of pending.newByFolder.values()) {
      for (const id of pending.deletedIds) ids.delete(id);
    }

    if (pending.sawNew || pending.sawDeleted) clearCategoryBadgeCache();

    // 1. Deleted rows disappear immediately — one store write for the lot.
    if (pending.deletedIds.size > 0) applyDeletions(set, get, pending.deletedIds);

    // 2. Cross-account surfaces (unified list + per-account badges). These
    //    are what keep NON-active accounts live, so they are deliberately
    //    outside the active-account branch — but they are view-gated and
    //    run once per window, not once per message.
    const virtualFolder = get().selectedVirtualFolder;
    // A server-driven flag change is a CONTENT change on every count surface a
    // new arrival touches: the account badges, the curated tabs (an unstar in
    // webmail must leave the Starred tab) and the AI-category chips. It used to
    // move none of them — "I mark 21 mails read on webmail and the counters
    // don't budge" — because only `sawNew`/`sawBackground` opened these gates.
    const sawActiveFlags = pending.flaggedIds.size > 0;
    const touchesBadges = pending.sawNew || pending.sawBackground || sawActiveFlags;
    if (touchesBadges) {
      if (virtualFolder === 'virtual-unified') void get().refreshVirtualFolder('unified');
      void get().refreshUnreadSummary();
    }
    if (pending.sawNew || sawActiveFlags) {
      // Curated tabs must pick up matching new mail from any account — and drop
      // mail whose flags stopped matching them.
      if (virtualFolder === 'virtual-starred') void get().refreshVirtualFolder('starred');
      else if (virtualFolder === 'virtual-important') void get().refreshVirtualFolder('important');
      if (get().viewingAICategory) set({ aiCategoryCountsLastUpdate: Date.now() });
    }

    // 3. Flag changes: N DB reads, ONE re-render (was N of each). Runs BEFORE
    //    the view refresh so its result can decide whether the view's query has
    //    to be re-run at all.
    const refreshedCount = await refreshChangedEmails(set, get, pending.flaggedIds);

    // 4. One visible-view refresh per affected folder (arrivals ∪ deletions ∪
    //    server flag changes), instead of one per message. Deletions can also
    //    free a slot at the page boundary, which this backfills.
    //
    //    Flag changes are in here because the visible list is a SERVER QUERY,
    //    not a client-side filter: under "Filtered: Unread" the rows that just
    //    became read are hidden at render, but only re-running the query moves
    //    the section totals with them and pulls up the still-unread rows that
    //    were sitting past the loaded page. Re-query only when the change could
    //    actually show: rows we hold changed, or a quick-filter is narrowing the
    //    view (where a change beyond the page still moves its counts).
    const foldersToRefresh = new Set<string>();
    for (const folderPath of pending.newByFolder.keys()) if (folderPath) foldersToRefresh.add(folderPath);
    for (const folderPath of pending.deletedFolders) foldersToRefresh.add(folderPath);
    for (const folderPath of pending.staleFolders) foldersToRefresh.add(folderPath);
    if (refreshedCount > 0 || get().activeInboxFilter) {
      for (const folderPath of pending.flaggedFolders) foldersToRefresh.add(folderPath);
    }
    await Promise.all([...foldersToRefresh].map((folderPath) => refreshVisibleViewForFolder(get, folderPath)));

    if (pending.deletedWithoutFolder) {
      if (virtualFolder === 'virtual-all') await get().mergeNewEmailsVirtualAll?.();
      else if (virtualFolder === 'virtual-starred') await get().mergeNewEmailsVirtualStarred?.();
    }

    // 5. Bodies for the new arrivals — after the view refresh, because the
    //    sectioned rebuild reads the still-body-less row and would clobber a
    //    body fetch that resolved first.
    const arrivedIds = [...pending.newByFolder.values()].flatMap((ids) => [...ids]);
    if (arrivedIds.length >= BODY_BATCH_THRESHOLD) {
      void get().fetchBodiesForVisibleEmails(arrivedIds);
    } else {
      for (const emailId of arrivedIds) void get().fetchEmailBody(emailId);
    }

    // 6. "New message" banner for the open thread (cheap early-out when no
    //    thread is open, which is why it stays per-id).
    for (const emailId of arrivedIds) void get().noteNewEmailForOpenThread(emailId);

    // 7. Sidebar counts — at most one reload per window.
    if (pending.needFolders) await get().loadFolders();

    if (pending.sawActiveNew) {
      get().processRecentEmailsForSignatures().catch(() => {});
      get().autoExtractRecentConversations().catch(() => {});
    }

    // One aggregate line per window replaces the old per-event logging
    // (which included a JSON.stringify of every event on the hot path).
    console.log(
      `[Store] realtime flush: new=${arrivedIds.length} flags=${pending.flaggedIds.size}`
      + ` (${refreshedCount} visible) deleted=${pending.deletedIds.size}`
      + ` folders=[${[...foldersToRefresh].join(',')}] in ${Date.now() - startedAt}ms`,
    );
  } catch (error) {
    console.error('[Store] realtime flush failed:', error);
  } finally {
    flushing = false;
    // Events that landed while we were flushing get their own window.
    if (batch.queued && !flushTimer) scheduleFlush(set, get);
  }
}

export const createSyncSlice: SliceCreator<SyncSlice> = (set, get) => ({
  syncing: false,
  syncStatus: null,
  syncingFolders: new Map<string, number>(),
  idleActive: false,
  idleFolder: null,
  syncTrouble: false,
  syncFailStreak: 0,
  lastSyncOkAt: null,

  setSyncStatus: (status) => set({ syncStatus: status }),

  // Sync-health signal. A single failure can be a transient blip (a 60s timeout
  // on a busy server), so we only raise the user-facing "trouble" flag after
  // SYNC_TROUBLE_STREAK consecutive failures — never on the first one — matching
  // the connection dot's existing anti-flicker philosophy. ANY success clears it.
  noteSyncOk: () => set({ syncTrouble: false, syncFailStreak: 0, lastSyncOkAt: Date.now() }),
  noteSyncFailure: (_error) => set((state) => {
    const syncFailStreak = state.syncFailStreak + 1;
    return { syncFailStreak, syncTrouble: syncFailStreak >= SYNC_TROUBLE_STREAK };
  }),
  clearSyncTrouble: () => set({ syncTrouble: false, syncFailStreak: 0 }),

  syncEmails: async (options) => {
    if (get().syncing || get().syncingFolders.size > 0) {
      console.log('[Store] syncEmails: Already syncing, skipping');
      return;
    }

    // Log the resolved request shape, not the raw `options` param —
    // four of the five callers invoke syncEmails() with no args, so
    // logging `options` directly always prints "undefined" and tells
    // nobody anything useful. The default empty object normalizes
    // the log so it always reads as a real object.
    console.log('[Store] syncEmails: Starting sync', options ?? {});

    // Stop IDLE during sync
    if (get().idleActive) {
      await get().stopIdle();
    }

    set({ syncing: true });
    try {
      // Build default folder list: INBOX first, then Sent, then Starred.
      // Resolution is provider-agnostic — works for Gmail, Outlook/Exchange,
      // iCloud, Fastmail, Yahoo, generic IMAP — via RFC 6154 SPECIAL-USE with
      // path/name fallbacks. See config/folder-mapping.ts.
      const allFolders = get().folders;
      const foldersToSync: string[] = ['INBOX'];

      const sentFolder = findFolderByType(allFolders as any, 'sent');
      if (sentFolder && !foldersToSync.includes(sentFolder.path)) {
        foldersToSync.push(sentFolder.path);
      }

      const starredFolder = findFolderByType(allFolders as any, 'starred');
      if (starredFolder && !foldersToSync.includes(starredFolder.path)) {
        foldersToSync.push(starredFolder.path);
      }

      // Also include current folder if not already listed
      const currentFolder = get().selectedFolderId;
      const folder = allFolders.find(f => f.id === currentFolder);
      if (folder && !foldersToSync.includes(folder.path)) {
        foldersToSync.push(folder.path);
      }

      const maxMessages = getMaxEmailsPerFolder();
      const result = await window.electronAPI.imap.sync({
        fullSync: false,
        maxMessages,
        folders: options?.folders || foldersToSync,
        skipRecentMinutes: options?.skipRecentMinutes,
        skipUnchanged: false,
      });
      console.log('[Store] syncEmails: Sync result', result.success ? 'success' : result.error);

      if (result.success) {
        get().noteSyncOk();
        get().loadQuota?.(); // refresh mailbox usage (best-effort, low frequency)
        // Reload folders and current view
        await get().loadFolders();
        await get()._reloadCurrentView();

        // Process recent emails for signature detection (async, don't wait)
        get().processRecentEmailsForSignatures().catch(() => {});

        // Download bodies for latest emails in background (latest first, respects setting)
        const bodyLimit = getBodyDownloadLimit();
        window.electronAPI.emails.downloadBodies(bodyLimit).catch(() => {});

        // Start auto AI categorization timer (30s interval, handles body-not-yet-downloaded retries)
        get().startAutoAICategorization();
      } else if (typeof result.error === 'string' && result.error.toLowerCase().includes('already in progress')) {
        // Another sync is genuinely running (e.g. the background
        // realtime poller). Not an error — just a no-op. Don't spam
        // the console with a scary "Sync failed" line; the existing
        // sync will deliver its own results when it completes.
        console.log('[Store] syncEmails: skipped — another sync is already running');
        // A no-op skip is neither success nor failure — leave the streak untouched.
      } else {
        console.error('[Store] syncEmails: Sync failed:', result.error);
        get().noteSyncFailure(result.error);
      }

      // Always start IDLE for real-time updates (even if sync had issues)
      await get().startIdle('INBOX');
    } catch (error) {
      console.error('[Store] syncEmails: Error:', error);
      get().noteSyncFailure(error);
      // Don't rethrow — sync failures should not crash the UI
    } finally {
      set({ syncing: false });
    }
  },

  ensureConnectionAndSync: async () => {
    // Skip if already syncing or no saved config
    if (get().syncing || get().syncingFolders.size > 0) return;
    if (!get().imapConfig) return;

    try {
      const result = await window.electronAPI.imap.ensureConnection();
      if (!result.success) {
        console.warn('[Store] ensureConnection failed:', result.error);
        return;
      }

      const { connected, reconnected } = result.data!;

      if (reconnected) {
        console.log('[Store] Reconnected after idle — syncing for new emails');
        get().setConnectionStatus('connected');
        // Full sync after reconnect to catch up
        await get().syncEmails();
      } else if (connected) {
        // Already connected — do a quick INBOX-only sync for new emails.
        // syncSingleFolder internally refreshes the current view if it
        // contains INBOX (sectioned, flat, virtual-all, or
        // AI-categorized — all four routings live there now). No
        // need for a separate _reloadCurrentView call.
        console.log('[Store] Connection alive — quick sync for new emails');
        await get().syncSingleFolder('INBOX');
      } else {
        // Not connected and couldn't reconnect — try full reconnect from UI
        console.warn('[Store] Could not ensure connection, attempting full reconnect');
        await get().reconnect();
      }
    } catch (error) {
      console.error('[Store] ensureConnectionAndSync error:', error);
    }
  },

  syncSingleFolder: async (folderPath) => {
    // Only allow one sync operation at a time — avoids connection pool exhaustion
    if (get().syncing || get().syncingFolders.size > 0) {
      console.log(`[Store] syncSingleFolder: Skipping ${folderPath} — another sync in progress`);
      return;
    }

    console.log(`[Store] syncSingleFolder: Starting sync for ${folderPath}`);

    const newSyncingFolders = new Map(get().syncingFolders);
    newSyncingFolders.set(folderPath, Date.now());
    set({ syncingFolders: newSyncingFolders });

    try {
      const maxMessages = getMaxEmailsPerFolder();
      const result = await window.electronAPI.imap.sync({
        fullSync: false,
        maxMessages,
        folders: [folderPath],
        skipRecentMinutes: 0,
        skipUnchanged: false,
      });

      console.log(`[Store] syncSingleFolder: ${folderPath} sync result:`, result.success ? 'success' : result.error);

      if (result.success) {
        get().noteSyncOk();
        await get().loadFolders();
        await refreshVisibleViewForFolder(get, folderPath);
      } else if (!(typeof result.error === 'string' && result.error.toLowerCase().includes('already in progress'))) {
        // A genuine failure (not the benign "another sync running" no-op).
        get().noteSyncFailure(result.error);
      }
    } catch (error) {
      console.error(`[Store] syncSingleFolder: Failed to sync ${folderPath}:`, error);
      get().noteSyncFailure(error);
    } finally {
      const currentSyncingFolders = get().syncingFolders;
      const updatedSyncingFolders = new Map(currentSyncingFolders);
      updatedSyncingFolders.delete(folderPath);
      set({ syncingFolders: updatedSyncingFolders });
      console.log(`[Store] syncSingleFolder: ${folderPath} sync complete`);
    }
  },

  mergeNewEmails: async (folderId) => {
    try {
      const { emails } = get();
      const existingIds = new Set(emails.map(e => e.id));
      // Rows in the 5s delete-undo window still exist in the DB; don't re-add
      // them as "new" (ghost reappearance until folder switch).
      const pendingDeleteIds = new Set(get().pendingDeletes.map((p) => p.emailId));

      const result = await window.electronAPI.emails.list(folderId, 100, 0);

      if (result.success && result.data) {
        const fetchedEmails = result.data as any[];
        const freshMap = new Map<string, any>(fetchedEmails.map(e => [e.id, e]));
        const newEmails = fetchedEmails.filter((e: any) => !existingIds.has(e.id) && !pendingDeleteIds.has(e.id));

        // Also refresh existing emails whose flags/tags/subject changed
        // server-side (read/unread, starred, etc.). Previously this
        // merge only ADDED new rows — flag changes from
        // syncFlags-updated DB rows never made it back into the
        // in-memory list, so reading an email in Gmail web kept it
        // shown as unread in Sarv Inbox until folder switch.
        let updatedCount = 0;
        const refreshed = emails.map((e: any) => {
          const f = freshMap.get(e.id);
          if (!f) return e;
          if (e.tags !== f.tags || e.date !== f.date || e.subject !== f.subject
            || e.threadIsStarred !== f.threadIsStarred || e.threadIsImportant !== f.threadIsImportant) {
            updatedCount++;
            return f;
          }
          return e;
        });

        // Drop rows that no longer exist on the first server page IF
        // they're within the first 100 emails of our local list. This
        // catches server-side deletions that the realtime 'deleted'
        // path missed (older deletes that happened while disconnected).
        // We only check the top of the list to stay safe — anything past
        // page 1 might just have scrolled off the recent window.
        const topSize = Math.min(refreshed.length, 100);
        const topIds = refreshed.slice(0, topSize).map((e: any) => e.id);
        const trimmedTop = refreshed
          .slice(0, topSize)
          .filter((e: any) => freshMap.has(e.id));
        const trimmedTail = refreshed.slice(topSize);
        const deletedCount = topIds.length - trimmedTop.length;
        const afterDelete = [...trimmedTop, ...trimmedTail];

        const noWork = newEmails.length === 0 && updatedCount === 0 && deletedCount === 0;
        if (noWork) return;

        const merged = [...newEmails, ...afterDelete].sort((a, b) => (b.date || 0) - (a.date || 0));
        console.log(`[Store] mergeNewEmails: +${newEmails.length} new, ~${updatedCount} updated, -${deletedCount} removed`);
        set({ emails: merged });
      }
    } catch (error) {
      console.error('[Store] mergeNewEmails failed:', error);
    }
  },

  // Smooth merge for virtual-all view: same diff-and-prepend
  // strategy as mergeNewEmails but reading from getAll() so the
  // virtual list picks up new arrivals from any folder without
  // dropping/clearing the existing list (= no flicker).
  mergeNewEmailsVirtualAll: async () => {
    try {
      const { emails } = get();
      const existingIds = new Set(emails.map(e => e.id));
      const result = await window.electronAPI.emails.getAll(100, 0);
      if (result.success && result.data) {
        const fetched = result.data as any[];
        const newOnes = fetched.filter((e: any) => !existingIds.has(e.id));
        if (newOnes.length > 0) {
          console.log(`[Store] mergeNewEmailsVirtualAll: ${newOnes.length} new`);
          const merged = [...newOnes, ...emails].sort((a, b) => (b.date || 0) - (a.date || 0));
          set({ emails: merged });
        }
      }
    } catch (error) {
      console.error('[Store] mergeNewEmailsVirtualAll failed:', error);
    }
  },

  // Same as above but for the virtual-starred view.
  mergeNewEmailsVirtualStarred: async () => {
    try {
      const { emails } = get();
      const existingIds = new Set(emails.map(e => e.id));
      const result = await window.electronAPI.emails.getStarred(100, 0);
      if (result.success && result.data) {
        const fetched = result.data as any[];
        const newOnes = fetched.filter((e: any) => !existingIds.has(e.id));
        if (newOnes.length > 0) {
          console.log(`[Store] mergeNewEmailsVirtualStarred: ${newOnes.length} new`);
          const merged = [...newOnes, ...emails].sort((a, b) => (b.date || 0) - (a.date || 0));
          set({ emails: merged });
        }
      }
    } catch (error) {
      console.error('[Store] mergeNewEmailsVirtualStarred failed:', error);
    }
  },

  startIdle: async (folderPath) => {
    try {
      // Remove any existing listener first to prevent accumulation
      window.electronAPI.imap.removeRealtimeEventListener();

      console.log('[Store] Setting up IDLE event listener for folder:', folderPath);
      // No logging in this callback: it fires once per message, so a flag
      // reconcile would emit hundreds of console writes on the UI thread.
      // The coalescer logs one aggregate line per flush instead.
      window.electronAPI.imap.onRealtimeEvent((event: RealtimeEvent) => {
        get().handleRealtimeEvent(event);
      });

      // Live sidebar counts during a background download (backfill/gap-drain
      // insert mail with no per-email IDLE event). Re-subscribed cleanly.
      window.electronAPI.imap.removeFoldersUpdatedListener();
      window.electronAPI.imap.onFoldersUpdated((info) => {
        get().handleFoldersUpdated(info?.accountId, info?.folderPath);
      });

      const result = await window.electronAPI.imap.startIdle(folderPath);
      if (result.success && result.data) {
        set({ idleActive: true, idleFolder: folderPath });
      }
    } catch (error) {
      console.error('[Store] Failed to start IDLE:', error);
    }
  },

  stopIdle: async () => {
    try {
      window.electronAPI.imap.removeRealtimeEventListener();
      window.electronAPI.imap.removeFoldersUpdatedListener();
      await window.electronAPI.imap.stopIdle();
      set({ idleActive: false, idleFolder: null });
    } catch (error) {
      console.error('[Store] Failed to stop IDLE:', error);
    }
  },

  /**
   * IDLE event intake. This runs once PER MESSAGE, so it must stay O(1) and
   * side-effect free: it only records what changed and (re)arms the flush
   * timer. All the expensive work — IPC reads, view refreshes, `set()` — is
   * done once per coalescing window in flushRealtimeBatch.
   *
   * Nothing is dropped: every id lands in the batch and is applied at most
   * REALTIME_COALESCE_MAX_MS later.
   */
  handleRealtimeEvent: (event) => {
    // IDLE-for-all: events are tagged with their account. An event with no
    // accountId (or matching the active one) is the ACTIVE account.
    const isActiveEvent = !event.accountId || event.accountId === get().activeAccountId;

    switch (event.type) {
      case 'new': {
        // CRITICAL: never trigger folder navigation here. The user stays put.
        batch.sawNew = true;
        if (isActiveEvent) {
          batch.sawActiveNew = true;
          batch.needFolders = true;
          // Key by arrival folder ('' when unknown) so the flush can do ONE
          // view refresh per folder instead of one per message.
          const key = event.folderPath || '';
          const ids = batch.newByFolder.get(key) ?? new Set<string>();
          if (event.emailId) ids.add(event.emailId);
          batch.newByFolder.set(key, ids);
        } else {
          batch.sawBackground = true;
        }
        break;
      }

      case 'flagsChanged': {
        if (isActiveEvent) {
          // Backend already turned IMAP flags into tags; the flush re-reads
          // the affected rows in one pass.
          if (event.emailId) batch.flaggedIds.add(event.emailId);
          // …and the view's own query is now stale (filtered rows + totals).
          if (event.folderPath) batch.flaggedFolders.add(event.folderPath);
          // A server-driven read/unread change alters folder unread counts.
          batch.needFolders = true;
        } else {
          // Background account (e.g. read on another device): badges + the
          // unified view only, never the active view.
          batch.sawBackground = true;
        }
        break;
      }

      case 'deleted': {
        batch.sawDeleted = true;
        batch.needFolders = true;
        if (event.emailId) batch.deletedIds.add(event.emailId);
        if (event.folderPath) batch.deletedFolders.add(event.folderPath);
        else batch.deletedWithoutFolder = true;
        break;
      }

      default:
        return; // unknown event type — don't arm a flush for nothing
    }

    if (!batch.queued) {
      batch.queued = true;
      windowStartedAt = Date.now();
    }
    scheduleFlush(set, get);
  },

  /**
   * Coalesced "folder counts changed" signal from the main-process background
   * schedulers (backfill / gap-drain), which insert mail WITHOUT per-email IDLE
   * events — so the sidebar unread badge updates live during a download instead
   * of sitting stale until the next user-driven reload. Reuses the IDLE flush
   * window so a busy download triggers at most one `loadFolders()` per window.
   */
  handleFoldersUpdated: (accountId, folderPath) => {
    // The sidebar folder badges are the ACTIVE account's; background accounts
    // surface their unread via a separate aggregate, so ignore their signals here.
    const isActiveEvent = !accountId || accountId === get().activeAccountId;
    if (!isActiveEvent) return;
    batch.needFolders = true;
    // A named folder means main just reconciled THAT folder's flags against the
    // server (the non-INBOX sweep — no IDLE, so no per-email events). Its open
    // list holds pre-reconcile rows, so re-run its query too, not just the badge.
    if (folderPath) batch.staleFolders.add(folderPath);
    if (!batch.queued) {
      batch.queued = true;
      windowStartedAt = Date.now();
    }
    scheduleFlush(set, get);
  },
});
