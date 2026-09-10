import type { EmailRecord } from '@sarvinbox/core';

import { clearCategoryBadgeCache } from '../../components/email-list/CategoryBadges';
import type { InboxSection } from '../../config/inbox-types';
import { buildThreads } from '../../utils/thread-utils';
import { isRetryableBodyFetchError, looksGoneFromServer, withFailedBody } from '../body-fetch-failures';
import { getEmailsPerPage, getPageSizeForView, ALL_MAIL_PAGE_SIZE, SECTION_FULL_PAGE_SIZE, fetchAICategoryTotal, computeSectionFetchLimit, sectionDataUnchanged } from '../helpers';
import type { EmailsSlice, SliceCreator } from '../types';

// Monotonic sequence for loadAllSections. Concurrent reloads of the SAME
// folder are routine (a new-mail event, a background single-folder sync, a
// reconnect/focus refresh can all fire loadAllSections at once). Without this,
// an OLDER in-flight reload — whose query ran before a new email was committed
// — can resolve AFTER the fresh one and overwrite sectionData with the
// pre-arrival set, so a just-arrived email vanishes until the folder is
// re-selected (the counter, a separate persisted value, stays correct). Each
// call captures the seq at entry and bails before writing if a newer one began.
let sectionLoadSeq = 0;

// Monotonic sequence for loadThread — same "last-to-resolve wins" hazard as
// sectionLoadSeq above, but on the navigation hot path. Arrowing quickly
// through mail (Left/Right) fires many concurrent loadThread calls; they
// await getThread and resolve out of order, so without this the LAST one to
// RESOLVE set threadEmails, not the last one SELECTED — leaving the detail
// pane showing a thread the user already navigated past, and flipping
// loadingThread on/off from stale loads. That mismatched (selectedEmailId,
// threadEmails) pair re-drives the whole useEmailDetail effect cascade
// (auto-read timers, body fetches, AI extraction), which is the freeze.
// Each call captures the seq at entry and bails before writing if a newer one began.
let threadLoadSeq = 0;

// Tier B overlap guard — module-level so a slow cycle can't be re-entered by the
// interval (transient, not UI state).
let bgSyncRunning = false;

// Hard cap on rawSourceCache entries. Each entry is the FULL RFC822 source of
// an email — headers + body + inline base64 attachments — so a single entry can
// be several MB. It's only a "Show Original opens instantly" optimization, and
// users rarely view the raw source of many mails in one session, so a small
// most-recent window is plenty. Without a cap the map retained every viewed
// source for the life of the session (unbounded memory growth); evicted entries
// are cheap to re-fetch on demand. Eviction is FIFO on insertion order (a
// Record preserves it for string keys); safe because prefetchRawSource no-ops
// on an already-cached id, so entries are never re-inserted / reordered.
const MAX_RAW_SOURCE_CACHE = 15;

/** Map section filter + inbox context to the DB filter string */
function getDbFilter(section: InboxSection, inboxType: string): string {
  // For priority_first, the named filters map 1:1
  if (inboxType === 'priority_first') {
    return section.filter; // 'important_unread', 'starred', 'everything_else'
  }
  // For important_first, "everything_else" means "not important"
  if (inboxType === 'important_first') {
    if (section.filter === 'everything_else') return 'not_important';
    return section.filter; // 'important'
  }
  // For unread_first, "everything_else" means "read"
  if (inboxType === 'unread_first') {
    if (section.filter === 'everything_else') return 'read';
    return section.filter; // 'unread'
  }
  return section.filter;
}

const LOAD_MORE_SIZE = 25;

/**
 * Merge fresh emails into the existing list without flicker.
 * - New emails get prepended (sorted by date desc)
 * - Existing emails get their fields updated in-place
 * - Removed emails get dropped
 * Returns the merged array, only creating a new reference if something changed.
 */
function mergeEmailLists(existing: any[], fresh: any[]): any[] {
  const freshMap = new Map<string, any>();
  for (const e of fresh) freshMap.set(e.id, e);

  let changed = false;

  // Update existing emails and check for removals
  const updated: any[] = [];
  for (const e of existing) {
    const freshVersion = freshMap.get(e.id);
    if (freshVersion) {
      // Check if anything meaningful changed (incl. thread aggregates —
      // buildThreads prefers them over tags)
      if (e.tags !== freshVersion.tags || e.date !== freshVersion.date || e.subject !== freshVersion.subject
        || (e as any).threadIsStarred !== (freshVersion as any).threadIsStarred
        || (e as any).threadIsImportant !== (freshVersion as any).threadIsImportant) {
        updated.push(freshVersion);
        changed = true;
      } else {
        updated.push(e); // keep same reference
      }
      freshMap.delete(e.id);
    } else {
      // Email no longer in fresh results — removed
      changed = true;
    }
  }

  // Prepend genuinely new emails
  const newEmails = Array.from(freshMap.values());
  if (newEmails.length > 0) {
    changed = true;
  }

  if (!changed) return existing;

  const merged = [...newEmails, ...updated];
  merged.sort((a: any, b: any) => (b.date || 0) - (a.date || 0));
  return merged;
}

/**
 * Merge fetched body fields into any sectionData bucket that contains the
 * email(s). The sectioned inbox renders from sectionData (not `emails`), so
 * body/flag updates must patch it here or freshly-downloaded bodies never show
 * in the list. Returns a new sectionData object if anything changed, else null.
 */
function mergeBodyIntoSectionData(
  sectionData: Record<string, any> | undefined,
  updates: Map<string, any>,
): Record<string, any> | null {
  if (!sectionData) return null;
  let next: Record<string, any> | null = null;
  for (const [sectionId, sd] of Object.entries(sectionData)) {
    const bucket = sd as any;
    if (!bucket?.emails) continue;
    let changed = false;
    const nextEmails = bucket.emails.map((e: any) => {
      const u = updates.get(e.id);
      if (!u) return e;
      changed = true;
      return { ...e, rawBody: u.rawBody, cleanBody: u.cleanBody, contentType: u.contentType };
    });
    if (changed) {
      if (!next) next = { ...sectionData };
      next[sectionId] = { ...bucket, emails: nextEmails, threads: buildThreads(nextEmails) };
    }
  }
  return next;
}

/**
 * Every email id currently held in renderer memory — the flat `emails` array,
 * every `sectionData` bucket, and `searchResults`. Used to answer "would
 * refreshing this row change anything the user can see?" without a DB round
 * trip: a re-read of a row we don't hold is pure waste
 * (buildEmailReplacementPatch would return null for it anyway). Pure; safe to
 * call per batch, not per row.
 *
 * `searchResults` counts because a search — and the flat-search variant of the
 * Unread quick-filter — renders from it and NOTHING else. Leaving it out meant
 * a mail read in webmail kept its unread styling (and its place in an
 * `is:unread` search) until the whole view was reloaded by hand.
 */
export function selectLoadedEmailIds(state: {
  emails: any[];
  sectionData?: Record<string, any>;
  searchResults?: any[];
}): Set<string> {
  const ids = new Set<string>();
  for (const email of state.emails || []) ids.add(email.id);
  for (const bucket of Object.values(state.sectionData || {})) {
    for (const email of (bucket as any)?.emails || []) ids.add(email.id);
  }
  for (const email of state.searchResults || []) ids.add(email.id);
  return ids;
}

/**
 * Build the state patch that swaps in freshly-read rows wherever the renderer
 * already holds them: the flat `emails` array, `searchResults`, and every
 * `sectionData` bucket (the sectioned inbox renders from `threads`, so those
 * are rebuilt for the touched buckets only). Never ADDS a row — a row we don't hold is left alone,
 * which is also what keeps optimistically-deleted rows from being resurrected.
 *
 * Pure, so it can fold N rows into ONE `set()`. Shared by `loadEmail` (one row)
 * and the realtime flag-change batch flush in sync-slice (up to hundreds).
 * Returns null when nothing on screen referenced any of the rows.
 */
export function buildEmailReplacementPatch(
  state: { emails: any[]; sectionData?: Record<string, any>; searchResults?: any[] },
  fresh: Map<string, any>,
): { emails?: any[]; sectionData?: Record<string, any>; searchResults?: any[] } | null {
  if (fresh.size === 0) return null;

  const patch: { emails?: any[]; sectionData?: Record<string, any>; searchResults?: any[] } = {};

  if ((state.emails || []).some((e: any) => fresh.has(e.id))) {
    patch.emails = state.emails.map((e: any) => fresh.get(e.id) ?? e);
  }

  // A search view (and the flat-search Unread filter) renders from
  // `searchResults` only, so a row swapped in `emails` alone is invisible
  // there — the row kept its stale read/starred state on screen.
  if ((state.searchResults || []).some((e: any) => fresh.has(e.id))) {
    patch.searchResults = state.searchResults!.map((e: any) => fresh.get(e.id) ?? e);
  }

  const sectionData = state.sectionData;
  if (sectionData) {
    let nextSectionData: Record<string, any> | null = null;
    for (const [sectionId, sd] of Object.entries(sectionData)) {
      const bucket = sd as any;
      if (!bucket?.emails) continue;
      let changed = false;
      const nextEmails = bucket.emails.map((e: any) => {
        const f = fresh.get(e.id);
        if (!f) return e;
        changed = true;
        return f;
      });
      if (!changed) continue;
      if (!nextSectionData) nextSectionData = { ...sectionData };
      nextSectionData[sectionId] = { ...bucket, emails: nextEmails, threads: buildThreads(nextEmails) };
    }
    if (nextSectionData) patch.sectionData = nextSectionData;
  }

  return patch.emails || patch.sectionData || patch.searchResults ? patch : null;
}

/** Merge all section emails into a flat deduplicated array for the `emails` state */
function flattenSectionEmails(sectionData: Record<string, { emails: any[] }>): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const sd of Object.values(sectionData)) {
    for (const email of sd.emails) {
      if (!seen.has(email.id)) {
        seen.add(email.id);
        result.push(email);
      }
    }
  }
  return result;
}

export const createEmailsSlice: SliceCreator<EmailsSlice> = (set, get) => ({
  folders: [],
  labels: [],
  selectedFolderId: null,
  loadingFolders: false,

  emails: [],
  selectedEmailId: null,
  highlightedEmailId: null,
  loadingEmails: false,
  loadingMoreEmails: false,
  hasMoreEmails: true,
  emailsOffset: 0,
  // Gmail-style discrete pagination (0-based current page). Each page REPLACES
  // the visible rows (never appends), so the DOM never holds more than one page —
  // no unbounded infinite-scroll list. `emailsTotal` is the "of N" denominator.
  emailsPage: 0,
  emailsTotal: 0,

  threadEmails: [],
  loadingThread: false,
  pendingThreadEmailIds: [],

  selectedVirtualFolder: null,
  viewingSnoozed: false,
  manuallyMarkedUnreadId: null,
  accountUnread: {},
  viewAccountId: null,

  sectionData: {},
  sectionLoading: new Set<string>(),

  loadingBodies: new Set<string>(),
  failedBodies: new Set<string>(),

  rawSourceCache: {},
  rawSourceLoading: new Set<string>(),

  // Fetch the full raw RFC822 source once and cache it, so "Show Original"
  // opens instantly. Called in the background when a mail is opened. No-ops if
  // already cached or in flight; failures are swallowed (the modal falls back
  // to an on-demand fetch / reconstruction).
  prefetchRawSource: async (emailId) => {
    const { rawSourceCache, rawSourceLoading } = get();
    if (!emailId || rawSourceCache[emailId] || rawSourceLoading.has(emailId)) return;

    const nextLoading = new Set(rawSourceLoading);
    nextLoading.add(emailId);
    set({ rawSourceLoading: nextLoading });

    try {
      const result = await window.electronAPI.emails.getRawSource(emailId);
      if (result.success && result.data) {
        set(state => {
          const next: Record<string, string> = { ...state.rawSourceCache, [emailId]: result.data as string };
          const keys = Object.keys(next);
          for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_RAW_SOURCE_CACHE))) {
            delete next[stale];
          }
          return { rawSourceCache: next };
        });
      }
    } catch {
      // Ignore — the modal will retry on demand.
    } finally {
      set(state => {
        const done = new Set(state.rawSourceLoading);
        done.delete(emailId);
        return { rawSourceLoading: done };
      });
    }
  },

  // Single source of truth for "is the current view the sectioned INBOX?"
  // (Important & Unread etc.). Navigation, total-count and load-more all keyed
  // off this same predicate. viewingSection (a section opened full-page as a
  // flat paginated list) is deliberately NOT section-nav — it walks `emails`.
  usesSectionNav: () => {
    const s = get() as any;
    const isInbox = s.folders.find((f: any) => f.id === s.selectedFolderId)?.path === 'INBOX';
    const hasSectionData = Object.keys(s.sectionData || {}).length > 0;
    return isInbox && s.inboxType !== 'default' && !s.selectedVirtualFolder
      && !s.viewingAICategory && !s.searchQuery && !s.viewingSection && hasSectionData;
  },

  getNavigationThreads: () => {
    const state = get() as any; // Slice state covers the subset, but we cast to get full state access through get()

    // Some keys like searchQuery exist on the search-ai-slice, but since `get()` hits the combined store in Zustand:
    const storeState = state;

    const pool = storeState.searchQuery ? storeState.searchResults : storeState.emails;

    const { inboxSections, sectionData } = storeState;
    const useDbSections = get().usesSectionNav();

    if (useDbSections) {
      // Combine all sections in order so arrow keys flow across section boundaries
      const orderedThreads = [];
      const seen = new Set<string>();
      for (const section of inboxSections) {
        if (section.filter === 'none') continue;
        const sd = sectionData[section.id];
        if (!sd?.threads) continue;
        for (const thread of sd.threads) {
          if (!seen.has(thread.threadId)) {
            seen.add(thread.threadId);
            orderedThreads.push(thread);
          }
        }
      }
      return orderedThreads;
    }

    return buildThreads(pool);
  },

  getNavigationTotalCount: () => {
    const state = get() as any;
    const storeState = state;

    // Search Mode
    if (storeState.searchQuery) {
      return storeState.searchResults.length;
    }

    // Snoozed or Virtual Folders
    if (storeState.viewingSnoozed || storeState.selectedVirtualFolder) {
      return storeState.emails.length;
    }

    // AI Category Mode
    if (storeState.viewingAICategory) {
      return storeState.emails.length;
    }

    // Full-page section view: total is the section's COUNT (already in emailsTotal).
    if (storeState.viewingSection) {
      return storeState.emailsTotal || storeState.emails.length;
    }

    const { inboxSections, sectionData } = storeState;
    const useDbSections = get().usesSectionNav();

    // DB Section Mode (e.g. Important & Unread)
    if (useDbSections) {
      const { selectedEmailId, highlightedEmailId } = storeState;
      const activeId = selectedEmailId || highlightedEmailId;

      let activeSectionId: string | null = null;
      if (activeId) {
        for (const section of inboxSections) {
          if (section.filter === 'none') continue;
          const sd = sectionData[section.id];
          if (sd?.threads?.some((t: any) => t.threadId === activeId || t.emails.some((e: any) => e.id === activeId))) {
            activeSectionId = section.id;
            break;
          }
        }
      }

      if (activeSectionId) {
        const sd = sectionData[activeSectionId];
        return sd?.total || sd?.threads?.length || 0;
      }

      let total = 0;
      for (const section of inboxSections) {
        if (section.filter === 'none') continue;
        const sd = sectionData[section.id];
        if (sd && typeof sd.total === 'number') {
          total += sd.total;
        }
      }
      return total > 0 ? total : storeState.emails.length;
    }

    // Standard Folder Mode
    if (storeState.selectedFolderId) {
      const folder = storeState.folders.find((f: any) => f.id === storeState.selectedFolderId);
      if (folder) {
        return folder.totalCount || storeState.emails.length;
      }
    }

    return storeState.emails.length;
  },

  setFolders: (folders) => set({ folders }),

  selectFolder: (folderId) => {
    // Skip reload if already viewing this folder (user clicked same folder again).
    // BUT never skip when drilled into a section (`viewingSection`, e.g. the
    // "Everything else" flat list): the user is on a DIFFERENT layout of the same
    // folder, and clicking the folder again must reset back to the normal (sectioned)
    // view. Without this, clicking INBOX while inside a section drill-in was a no-op.
    const { selectedFolderId, selectedVirtualFolder, viewingSnoozed, viewingAICategory, viewingSection } = get();
    if (selectedFolderId === folderId && !selectedVirtualFolder && !viewingSnoozed && !viewingAICategory && !viewingSection && !get().selectedEmailId) {
      console.log(`[View] Already viewing folder ${folderId}, skipping reload`);
      return;
    }

    clearCategoryBadgeCache();
    const selectedFolder = get().folders.find(f => f.id === folderId);
    console.log(`[View] Selected folder: ${selectedFolder?.path || selectedFolder?.name || folderId} (inboxType=${get().inboxType})`);
    // NOTE: sectionData is intentionally NOT cleared here. It only ever
    // holds INBOX section data and is only rendered in the INBOX sectioned
    // view, so keeping it cached lets a return to INBOX show the previous
    // sections INSTANTLY while loadAllSections swaps fresh data in
    // atomically — instead of wiping to empty, which forced the full
    // "loading" spinner on every folder switch (the 2-3s loader). Stale
    // sections self-correct on the atomic swap; loadAllSections still shows
    // the spinner on a genuine first load (empty sectionData).
    set({ selectedFolderId: folderId, selectedEmailId: null, highlightedEmailId: null, selectedVirtualFolder: null, viewingSnoozed: false, viewingAICategory: null, searchQuery: '', searchResults: [], searchInterpretation: null, activeInboxFilter: null, activeInboxFilterLabel: null, viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE, emails: [], emailsOffset: 0, emailsPage: 0, emailsTotal: 0, hasMoreEmails: false });

    // Step 1: Load emails — sectioned view only applies to INBOX
    const { inboxType, inboxSections } = get();
    const isInbox = selectedFolder?.path === 'INBOX';
    if (isInbox && inboxType !== 'default' && inboxSections.length > 0) {
      // Section-based loading: each section gets its own DB query
      get().loadAllSections(selectedFolder?.path);
    } else {
      get().loadEmails(folderId);
    }

    // Step 2: Trigger background sync to check IMAP for updates (per-folder tracking)
    // Skip if a global sync is already running — it will reload the view when done.
    // Also skip when KNOWN offline: the view already loaded from the local DB
    // above (non-blocking), so the folder opens instantly regardless. Attempting
    // a sync while disconnected just spins the sync indicator and burns a failing
    // ensureConnection round-trip; IDLE + the reconnect handler refresh the view
    // once connectivity returns. ('reconnecting' still proceeds — it's transient.)
    const folder = selectedFolder;
    if (folder && !get().syncing && get().connectionStatus !== 'disconnected') {
      const { syncingFolders } = get();
      if (syncingFolders.has(folder.path)) {
        console.log(`[Store] Skipping sync for ${folder.path} - this folder already syncing`);
      } else {
        console.log(`[Store] Starting background sync for folder: ${folder.path}`);
        // syncSingleFolder now owns the post-sync view-refresh routing
        // (AI-category → loadAICategoryEmails, sectioned INBOX →
        // loadAllSections, flat → mergeNewEmails, virtual-all/starred
        // → their merge helpers). Previously this .then() block had a
        // duplicate of that logic, which meant non-selectFolder
        // callers of syncSingleFolder (ensureConnectionAndSync's
        // periodic poll, etc.) missed the section/AI-category refresh.
        get().syncSingleFolder(folder.path).catch((err) => {
          console.error(`[Store] Sync failed for ${folder.path}:`, err);
        });
      }
    }
  },

  loadFolders: async () => {
    set({ loadingFolders: true });
    try {
      const result = await window.electronAPI.folders.list();
      if (result.success && result.data) {
        set({ folders: result.data });

        const currentSelectedId = get().selectedFolderId;
        const currentVirtual = get().selectedVirtualFolder;
        const currentSnoozed = get().viewingSnoozed;
        const currentAICategory = get().viewingAICategory;
        if (!currentSelectedId && !currentVirtual && !currentSnoozed && !currentAICategory && result.data.length > 0) {
          const inbox = result.data.find(
            (f: any) => f.path === 'INBOX' || f.name.toLowerCase() === 'inbox'
          );
          if (inbox) {
            get().selectFolder(inbox.id);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load folders:', error);
    } finally {
      set({ loadingFolders: false });
    }
  },

  setEmails: (emails) => set({ emails }),

  selectEmail: (emailId) => {
    const currentId = get().selectedEmailId;
    const { selectedFolderId, selectedVirtualFolder, viewingSnoozed, viewingAICategory, searchQuery, folders } = get();
    const folderName = selectedFolderId ? folders.find(f => f.id === selectedFolderId)?.path : null;
    const view = viewingAICategory ? `AI:${viewingAICategory}` : selectedVirtualFolder || (viewingSnoozed ? 'snoozed' : folderName || 'unknown');
    console.log(`[View] selectEmail id=${emailId ? emailId.substring(0, 12) + '...' : 'null'}, view=${view}${searchQuery ? `, search="${searchQuery}"` : ''}, pool=${get().emails.length} emails`);
    const email = get().emails.find((e) => e.id === emailId)
      || get().searchResults.find((e) => e.id === emailId);
    // Stale-thread flash fix: threadEmails still holds the PREVIOUS
    // thread until loadThread resolves, so the detail pane briefly
    // rendered the old thread's subject/content for the new selection.
    // When the selection resolves to a DIFFERENT thread, clear
    // threadEmails synchronously in the same set() as the selection.
    // Same-thread selections (clicking another email in the open
    // thread) keep threadEmails so the pane doesn't blank out; if the
    // email can't be resolved here (not in emails/searchResults — no
    // loadThread either), leave threadEmails alone because the hook's
    // selectedEmail lookup may be falling back to it.
    const loadedThreadId = get().threadEmails[0]?.threadId;
    const clearStaleThread =
      email && get().threadEmails.length > 0 && email.threadId !== loadedThreadId
        ? { threadEmails: [] as EmailRecord[], pendingThreadEmailIds: [] as string[] }
        : {};
    // Route thread-load / body-fetch / actions to the open email's own account
    // (unified view rows can belong to a non-active account). Null for
    // single-account/normal views → the active account.
    const viewAccountId = email?.accountId ?? null;
    if (currentId !== emailId) {
      set({ selectedEmailId: emailId, manuallyMarkedUnreadId: null, failedBodies: new Set(), viewAccountId, ...clearStaleThread });
    } else {
      set({ selectedEmailId: emailId, failedBodies: new Set(), viewAccountId, ...clearStaleThread });
    }
    if (email && email.threadId) {
      get().loadThread(email.threadId);
    }
  },

  loadEmails: async (folderId) => {
    const PAGE_SIZE = getEmailsPerPage();
    console.log(`[View] loadEmails folderId=${folderId}, pageSize=${PAGE_SIZE}`);
    // Only show spinner on first load (no emails yet), not on refresh
    const hasExistingEmails = get().emails.length > 0;
    if (!hasExistingEmails) {
      set({ loadingEmails: true });
    }
    // Bail if the user navigated to another folder/view while this was in flight
    const isStale = () => {
      const s = get();
      return s.selectedFolderId !== folderId || !!s.selectedVirtualFolder || s.viewingSnoozed || !!s.viewingAICategory;
    };
    try {
      const result = await window.electronAPI.emails.list(folderId, PAGE_SIZE);
      if (isStale()) return;
      if (result.success && result.data) {
        const selectedFolder = get().folders.find(f => f.id === folderId);
        const localTotal = selectedFolder?.totalCount || 0;
        const serverTotal = selectedFolder?.serverMessageCount || 0;
        const loadedCount = result.data.length;
        // Flat per-message folder view: the "of N" is the folder's MESSAGE count
        // (server-authoritative), so it matches webmail exactly.
        set({
          emails: result.data,
          emailsPage: 0,
          emailsOffset: PAGE_SIZE,
          emailsTotal: Math.max(localTotal, serverTotal),
          hasMoreEmails: loadedCount >= PAGE_SIZE || localTotal > loadedCount,
        });
      }
    } catch (error) {
      console.error('Failed to load emails:', error);
    } finally {
      set({ loadingEmails: false });
    }
  },

  loadMoreEmails: async () => {
    const { selectedFolderId, emailsOffset, loadingMoreEmails, folders, viewingAICategory, selectedVirtualFolder } = get();
    if (loadingMoreEmails) return;

    const PAGE_SIZE = getEmailsPerPage();

    // Unified "All Inboxes" pagination — over-fetch per account + merge (main),
    // then append only genuinely new rows (dedupe by id across the merge window).
    if (selectedVirtualFolder === 'virtual-unified') {
      set({ loadingMoreEmails: true });
      try {
        const accountIds = get().accounts
          .filter((a) => a.includeInUnified !== false)
          .map((a) => a.id);
        const res = await window.electronAPI.accounts.unifiedInbox({ accountIds, limit: PAGE_SIZE, offset: emailsOffset });
        if (res?.success && res.data && res.data.emails.length > 0) {
          const currentEmails = get().emails;
          const existingIds = new Set(currentEmails.map((e) => e.id));
          const newEmails = (res.data.emails as any[]).filter((e) => !existingIds.has(e.id));
          set({
            emails: [...currentEmails, ...newEmails],
            emailsOffset: emailsOffset + PAGE_SIZE,
            hasMoreEmails: res.data.hasMore,
          });
        } else {
          set({ hasMoreEmails: false });
        }
      } catch (error) {
        console.error('Failed to load more unified emails:', error);
      } finally {
        set({ loadingMoreEmails: false });
      }
      return;
    }

    // AI category pagination — load more within same category + folder
    if (viewingAICategory) {
      set({ loadingMoreEmails: true });
      try {
        const result = await window.electronAPI.ai.getByCategory(
          viewingAICategory, PAGE_SIZE, emailsOffset, selectedFolderId ?? undefined
        );
        if (result.success && result.data && result.data.length > 0) {
          const currentEmails = get().emails;
          const existingIds = new Set(currentEmails.map(e => e.id));
          const newEmails = result.data.filter((e: any) => !existingIds.has(e.id));
          set({
            emails: [...currentEmails, ...newEmails],
            emailsOffset: emailsOffset + PAGE_SIZE,
            hasMoreEmails: result.data.length >= PAGE_SIZE,
          });
        } else {
          set({ hasMoreEmails: false });
        }
      } catch (error) {
        console.error('Failed to load more AI category emails:', error);
      } finally {
        set({ loadingMoreEmails: false });
      }
      return;
    }

    if (!selectedFolderId) return;

    const selectedFolder = folders.find(f => f.id === selectedFolderId);
    const localTotal = selectedFolder?.totalCount || 0;
    const serverTotal = selectedFolder?.serverMessageCount || 0;
    const serverHasMore = serverTotal > localTotal;

    set({ loadingMoreEmails: true });
    try {
      const result = await window.electronAPI.emails.list(selectedFolderId, PAGE_SIZE, emailsOffset);
      if (result.success && result.data && result.data.length > 0) {
        const currentEmails = get().emails;
        const newEmails = result.data.filter(
          (e: any) => !currentEmails.some((ce) => ce.id === e.id)
        );
        if (newEmails.length > 0) {
          set({
            emails: [...currentEmails, ...newEmails],
            emailsOffset: emailsOffset + PAGE_SIZE,
            hasMoreEmails: result.data.length >= PAGE_SIZE || serverHasMore,
          });
          return;
        }
      }

      if (serverHasMore && selectedFolder) {
        // Local page is exhausted but the server holds older mail. Pull ONE
        // bounded chunk of older mail via the background backfill (header-only,
        // a bounded UID window) instead of the old growing, blocking full re-sync
        // (`maxMessages: localTotal + PAGE_SIZE` grew every scroll). The backfill
        // scheduler also runs continuously, so most scrolls are already covered —
        // this just nudges it — and it yields to any in-flight foreground sync.
        console.log(`[Store] loadMoreEmails: local exhausted (${localTotal}), server has ${serverTotal} — nudging backfill for ${selectedFolder.path}`);
        const res = await window.electronAPI.imap.backfillChunk(selectedFolder.path);
        const inserted = res?.success ? (res.data?.inserted ?? 0) : 0;

        if (inserted > 0) {
          await get().loadFolders();
          const newResult = await window.electronAPI.emails.list(selectedFolderId, PAGE_SIZE, emailsOffset);
          if (newResult.success && newResult.data && newResult.data.length > 0) {
            const currentEmails = get().emails;
            const newEmails = newResult.data.filter((e: any) => !currentEmails.some((ce) => ce.id === e.id));
            set({
              emails: [...currentEmails, ...newEmails],
              emailsOffset: emailsOffset + newEmails.length,
              hasMoreEmails: true,
            });
            return;
          }
        }
        // Nothing pageable landed this tick — keep the "load more" affordance only
        // while backfill still has older history to fetch (done=false); once it has
        // reached the bottom we've genuinely run out.
        set({ hasMoreEmails: res?.success ? !(res.data?.done) : false });
      } else {
        set({ hasMoreEmails: false });
      }
    } catch (error) {
      console.error('Failed to load more emails:', error);
    } finally {
      set({ loadingMoreEmails: false });
    }
  },

  /**
   * Gmail-style discrete pagination: jump to `page` (0-based) and REPLACE the
   * visible rows with just that page — never append, so the DOM never holds more
   * than one page. Covers the flat folder, the unified inbox, and an AI-category
   * view. When a page is past what's synced locally (server has more), it nudges
   * the background backfill once (bounded chunk) then re-reads. Sections paginate
   * independently via goToSectionPage (works for every inbox-type config).
   */
  goToEmailPage: async (page) => {
    if (page < 0 || get().loadingMoreEmails) return;
    const { selectedFolderId, folders, viewingAICategory, viewingSection, viewingSectionPageSize, selectedVirtualFolder, accounts } = get();
    // Section full-page view pages by the section's "Show up to"; an AI-category
    // view by the user's emailsPerPage (even on top of All Email); "All Email"
    // by the fixed 100; everything else by the user's emailsPerPage.
    const PAGE_SIZE = viewingSection
      ? (viewingSectionPageSize > 0 ? viewingSectionPageSize : getEmailsPerPage())
      : viewingAICategory
        ? getEmailsPerPage()
        : getPageSizeForView(selectedVirtualFolder);
    const offset = page * PAGE_SIZE;
    set({ loadingMoreEmails: true });
    try {
      // Full-page section view (Gmail: clicking a section's count) — that
      // section's filter as a flat paginated list; total = the section's COUNT.
      if (viewingSection) {
        const folder = folders.find((f) => f.id === selectedFolderId);
        const folderPath = selectedVirtualFolder === 'virtual-all' ? undefined : folder?.path;
        const viewFilter = get().activeInboxFilter ?? undefined;
        // The section COUNT is a full GROUP BY over every thread with the
        // correlated section+filter HAVING — no LIMIT, so it's the heavy half of
        // a page load, and it's INVARIANT across pages of the same section/filter.
        // Fetch it only when we don't have it yet (first open); reuse it while
        // paging so next/prev fires just the (LIMIT-ed) list query, not a second
        // full scan each click — that double query per click was the beachball.
        const cachedTotal = get().emailsTotal;
        const needCount = page === 0 || cachedTotal === 0;
        const [listRes, countRes] = await Promise.all([
          window.electronAPI.emails.listBySection(viewingSection, PAGE_SIZE, offset, folderPath, viewFilter),
          needCount
            ? window.electronAPI.emails.sectionCounts([viewingSection], folderPath, viewFilter)
            : Promise.resolve(null),
        ]);
        const rows = listRes.success && listRes.data ? listRes.data : [];
        const total = needCount
          ? (countRes?.success && countRes.data ? (countRes.data[viewingSection] || 0) : 0)
          : cachedTotal;
        set({ emails: rows, emailsPage: page, emailsOffset: offset + rows.length, emailsTotal: total, hasMoreEmails: offset + rows.length < total });
        return;
      }
      // Unified "All Inboxes" (no exact total → prev/next gated by hasMore).
      if (selectedVirtualFolder === 'virtual-unified') {
        const accountIds = accounts.filter((a) => a.includeInUnified !== false).map((a) => a.id);
        const res = await window.electronAPI.accounts.unifiedInbox({ accountIds, limit: PAGE_SIZE, offset });
        if (res?.success && res.data) {
          set({ emails: res.data.emails, emailsPage: page, emailsOffset: offset + res.data.emails.length, hasMoreEmails: res.data.hasMore, emailsTotal: 0 });
        }
        return;
      }
      // AI category (no exact total). Checked BEFORE the static virtual folders
      // so a category active on top of "All Email" still pages by category, not
      // the whole mailbox. On unified, browse the category across every opted-in
      // account; otherwise the active account/folder — mirrors
      // loadAICategoryEmails so prev/next matches the initial load.
      if (viewingAICategory) {
        // The category total is invariant across pages, so fetch it only on page 0
        // (first open) or when it's been invalidated to 0 (e.g. after a delete) and
        // reuse it while paging — mirrors the section view's needCount pattern, and
        // uses the chip's count source so the "of N" can't disagree with the chip.
        const cachedTotal = get().emailsTotal;
        const needCount = page === 0 || cachedTotal === 0;
        let rows: any[] = [];
        const [, total] = await Promise.all([
          (async () => {
            if (selectedVirtualFolder === 'virtual-unified') {
              const accountIds = accounts.filter((a) => a.includeInUnified !== false).map((a) => a.id);
              const res = await window.electronAPI.accounts.unifiedInbox({ accountIds, limit: PAGE_SIZE, offset, aiCategory: viewingAICategory });
              rows = res?.success && res.data ? res.data.emails : [];
            } else {
              const res = await window.electronAPI.ai.getByCategory(viewingAICategory, PAGE_SIZE, offset, selectedFolderId ?? undefined);
              rows = res.success && res.data ? res.data : [];
            }
          })(),
          needCount
            ? fetchAICategoryTotal({
                category: viewingAICategory,
                selectedFolderId,
                selectedVirtualFolder,
                unifiedAccountIds: accounts.filter((a) => a.includeInUnified !== false).map((a) => a.id),
              })
            : Promise.resolve(cachedTotal),
        ]);
        set({ emails: rows, emailsPage: page, emailsOffset: offset + rows.length, hasMoreEmails: total ? offset + rows.length < total : rows.length >= PAGE_SIZE, emailsTotal: total });
        return;
      }
      // Static virtual folders (All Email / Important / Starred) — flat,
      // cross-folder lists with no exact total. Page by the SAME PAGE_SIZE as
      // every other view; without this branch prev/next silently no-op'd here
      // (they fell through to the flat-folder path, which bails on a null
      // selectedFolderId).
      if (selectedVirtualFolder === 'virtual-all' || selectedVirtualFolder === 'virtual-important' || selectedVirtualFolder === 'virtual-starred') {
        const result = selectedVirtualFolder === 'virtual-important'
          ? await window.electronAPI.emails.getImportant(PAGE_SIZE, offset)
          : selectedVirtualFolder === 'virtual-starred'
            ? await window.electronAPI.emails.getStarred(PAGE_SIZE, offset)
            : await window.electronAPI.emails.getAll(PAGE_SIZE, offset);
        if (result.success && result.data) {
          set({ emails: result.data, emailsPage: page, emailsOffset: offset + result.data.length, hasMoreEmails: result.data.length >= PAGE_SIZE, emailsTotal: 0 });
        }
        return;
      }
      // Flat folder — one row per message, message-level "of N" (matches webmail).
      if (!selectedFolderId) return;
      const folder = folders.find((f) => f.id === selectedFolderId);
      const localTotal = folder?.totalCount || 0;
      const serverTotal = folder?.serverMessageCount || 0;
      const total = Math.max(localTotal, serverTotal);
      let result = await window.electronAPI.emails.list(selectedFolderId, PAGE_SIZE, offset);
      let rows = result.success && result.data ? result.data : [];
      // Page past what's synced locally but the server holds more → nudge the
      // background backfill (bounded, header-only) then re-read this page once.
      if (rows.length < PAGE_SIZE && offset + rows.length < serverTotal && folder) {
        const res = await window.electronAPI.imap.backfillChunk(folder.path);
        if (res?.success && (res.data?.inserted ?? 0) > 0) {
          await get().loadFolders();
          result = await window.electronAPI.emails.list(selectedFolderId, PAGE_SIZE, offset);
          rows = result.success && result.data ? result.data : [];
        }
      }
      set({
        emails: rows,
        emailsPage: page,
        emailsOffset: offset + rows.length,
        emailsTotal: total,
        hasMoreEmails: offset + rows.length < total,
      });
    } catch (error) {
      console.error('goToEmailPage failed:', error);
    } finally {
      set({ loadingMoreEmails: false });
    }
  },

  // Gmail: click a section's "X–Y of Z" count → open that section's filter as a
  // full paginated page (the flat Paginator). Section data stays loaded so
  // closing restores the sectioned inbox instantly.
  openSectionFullPage: async (filter, label) => {
    set({
      viewingSection: filter, viewingSectionLabel: label,
      viewingSectionPageSize: SECTION_FULL_PAGE_SIZE,
      emails: [], emailsPage: 0, emailsTotal: 0, hasMoreEmails: false,
      selectedEmailId: null, highlightedEmailId: null,
    });
    await get().goToEmailPage(0);
  },

  closeSectionFullPage: async () => {
    set({ viewingSection: null, viewingSectionLabel: null, emailsPage: 0, emailsTotal: 0 });
    // Restore the sectioned inbox rows from the still-loaded section data.
    set({ emails: flattenSectionEmails(get().sectionData) });
  },

  // Re-read one row from the DB and swap it into every place the renderer
  // holds it (flat list + sectioned inbox). The merge itself lives in the
  // shared pure helper so the realtime batch flush can fold hundreds of rows
  // into a single set() using exactly the same semantics.
  loadEmail: async (emailId) => {
    try {
      const result = await window.electronAPI.emails.get(emailId);
      if (!result.success || !result.data) return;
      const patch = buildEmailReplacementPatch(get(), new Map([[emailId, result.data as any]]));
      if (patch) set(patch as any);
    } catch (error) {
      console.error('Failed to load email:', error);
    }
  },

  loadThread: async (threadId) => {
    const seq = ++threadLoadSeq;
    set({ loadingThread: true });
    try {
      // Unified view: read the thread from the open email's own account DB.
      const accountId = get().viewAccountId ?? undefined;
      const result = await window.electronAPI.emails.getThread(threadId, accountId);
      // A newer loadThread (or a newer selection) began while we awaited —
      // discard this stale result so it can't overwrite the current thread.
      if (seq !== threadLoadSeq) return;
      if (result.success && result.data) {
        // Belt-and-suspenders (backend getByThread already excludes these):
        // drop trashed/spam copies and empty unsent drafts so a message the
        // user deleted can't reappear in the conversation.
        const raw = result.data as EmailRecord[];
        const cleaned = raw.filter((e) => {
          const tags = e.tags || '';
          if (tags.includes('|Trash|') || tags.includes('|Spam|') || tags.includes('|Junk|')) return false;
          const blankDraft = tags.includes('|draft|') && !(e.cleanBody || '').trim() && !(e.rawBody || '').trim();
          return !blankDraft;
        });
        // If everything was filtered out, the whole thread is Trash/Spam/Junk
        // (e.g. viewing the Junk folder) — show it unfiltered rather than
        // collapsing the conversation to a single message.
        // A fresh thread load includes every message, so any queued "new
        // message" banner for this thread is now consumed — clear it.
        set({
          threadEmails: cleaned.length > 0 ? cleaned : raw,
          ...(get().pendingThreadEmailIds.length > 0 ? { pendingThreadEmailIds: [] } : {}),
        });
      }
    } catch (error) {
      if (seq !== threadLoadSeq) return;
      console.error('Failed to load thread:', error);
    } finally {
      // Only the latest load owns the spinner — a stale load resolving late
      // must not clear it while the current thread is still loading.
      if (seq === threadLoadSeq) set({ loadingThread: false });
    }
  },

  // The open reading pane is snapshotted by loadThread and never live-appends,
  // so a message that arrives via IMAP IDLE into the thread the user is
  // currently reading would silently go unshown until they reopen it. On each
  // 'new' event we resolve the arriving email's thread and, if it matches the
  // open one, queue it for the "new message" banner rather than injecting it
  // into what the user is mid-read on.
  noteNewEmailForOpenThread: async (emailId) => {
    if (!emailId) return;
    const { selectedEmailId, threadEmails, pendingThreadEmailIds } = get();
    const openThreadId = threadEmails[0]?.threadId;
    // No thread open, or already visible / already queued — nothing to do.
    if (!selectedEmailId || !openThreadId) return;
    if (threadEmails.some((e) => e.id === emailId)) return;
    if (pendingThreadEmailIds.includes(emailId)) return;

    try {
      const result = await window.electronAPI.emails.get(emailId);
      if (!result.success || !result.data) return;
      if ((result.data as EmailRecord).threadId !== openThreadId) return;

      // Re-check after the async gap: the user may have navigated to another
      // thread, or the message may have been folded in by a concurrent load.
      const s = get();
      if (s.threadEmails[0]?.threadId !== openThreadId) return;
      if (s.threadEmails.some((e) => e.id === emailId)) return;
      if (s.pendingThreadEmailIds.includes(emailId)) return;
      set({ pendingThreadEmailIds: [...s.pendingThreadEmailIds, emailId] });
    } catch (error) {
      console.error('[Store] noteNewEmailForOpenThread failed:', error);
    }
  },

  // "Show" on the banner: re-fetch the open thread so the queued messages fold
  // in (loadThread clears pendingThreadEmailIds on success).
  showPendingThreadMessages: async () => {
    const openThreadId = get().threadEmails[0]?.threadId;
    if (!openThreadId) {
      set({ pendingThreadEmailIds: [] });
      return;
    }
    await get().loadThread(openThreadId);
  },

  // "Ignore" on the banner: drop the queue without loading. The messages are
  // untouched in the DB and re-appear the next time the thread is opened.
  dismissPendingThreadMessages: () => {
    if (get().pendingThreadEmailIds.length > 0) set({ pendingThreadEmailIds: [] });
  },

  loadAllEmails: async () => {
    console.log(`[View] Selected: All Mail (virtual-all, inboxType=${get().inboxType})`);
    set({
      loadingEmails: true,
      emails: [],
      selectedEmailId: null,
      highlightedEmailId: null,
      selectedVirtualFolder: 'virtual-all',
      viewingSnoozed: false,
      viewingAICategory: null,
      selectedFolderId: null,
      sectionData: {},
      searchQuery: '', searchResults: [], searchInterpretation: null,
      activeInboxFilter: null, activeInboxFilterLabel: null,
      // Leaving a section full-page view — clear it so the paginator doesn't
      // keep the section's page size / branch.
      viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE,
      emailsPage: 0, emailsTotal: 0,
    });

    const { inboxType, inboxSections } = get();
    if (inboxType !== 'default' && inboxSections.length > 0) {
      // Section-based loading for "All Mail" (no folderPath constraint)
      await get().loadAllSections();
      return;
    }

    // Bail if the user navigated away while this was in flight
    const isStale = () => get().selectedVirtualFolder !== 'virtual-all' || !!get().viewingAICategory;
    try {
      const PAGE_SIZE = ALL_MAIL_PAGE_SIZE; // "All Email" always pages 100
      const result = await window.electronAPI.emails.getAll(PAGE_SIZE, 0);
      if (isStale()) return;
      if (result.success && result.data) {
        set({ emails: result.data, loadingEmails: false, emailsPage: 0, emailsOffset: PAGE_SIZE, emailsTotal: 0, hasMoreEmails: result.data.length >= PAGE_SIZE });
      } else {
        console.error('[Store] Failed to load all emails:', result.error);
        set({ loadingEmails: false });
      }
    } catch (error) {
      console.error('[Store] Error loading all emails:', error);
      set({ loadingEmails: false });
    }
  },

  loadImportantEmails: async () => {
    console.log('[View] Selected: Important (virtual-important)');
    set({
      loadingEmails: true,
      emails: [],
      selectedEmailId: null,
      highlightedEmailId: null,
      selectedVirtualFolder: 'virtual-important',
      viewingSnoozed: false,
      viewingAICategory: null,
      selectedFolderId: null,
      searchQuery: '', searchResults: [], searchInterpretation: null,
      viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE,
      emailsPage: 0, emailsTotal: 0,
    });
    const isStale = () => get().selectedVirtualFolder !== 'virtual-important' || !!get().viewingAICategory;
    try {
      const PAGE_SIZE = getEmailsPerPage();
      const result = await window.electronAPI.emails.getImportant(PAGE_SIZE, 0);
      if (isStale()) return;
      if (result.success && result.data) {
        set({ emails: result.data, loadingEmails: false, emailsPage: 0, emailsOffset: PAGE_SIZE, emailsTotal: 0, hasMoreEmails: result.data.length >= PAGE_SIZE });
      } else {
        console.error('[Store] Failed to load important emails:', result.error);
        set({ loadingEmails: false });
      }
    } catch (error) {
      console.error('[Store] Error loading important emails:', error);
      set({ loadingEmails: false });
    }
  },

  loadStarredEmails: async () => {
    console.log('[View] Selected: Starred (virtual-starred)');
    set({
      loadingEmails: true,
      emails: [],
      selectedEmailId: null,
      highlightedEmailId: null,
      selectedVirtualFolder: 'virtual-starred',
      viewingSnoozed: false,
      viewingAICategory: null,
      selectedFolderId: null,
      searchQuery: '', searchResults: [], searchInterpretation: null,
      viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE,
      emailsPage: 0, emailsTotal: 0,
    });
    const isStale = () => get().selectedVirtualFolder !== 'virtual-starred' || !!get().viewingAICategory;
    try {
      const PAGE_SIZE = getEmailsPerPage();
      const result = await window.electronAPI.emails.getStarred(PAGE_SIZE, 0);
      if (isStale()) return;
      if (result.success && result.data) {
        set({ emails: result.data, loadingEmails: false, emailsPage: 0, emailsOffset: PAGE_SIZE, emailsTotal: 0, hasMoreEmails: result.data.length >= PAGE_SIZE });
      } else {
        console.error('[Store] Failed to load starred emails:', result.error);
        set({ loadingEmails: false });
      }
    } catch (error) {
      console.error('[Store] Error loading starred emails:', error);
      set({ loadingEmails: false });
    }
  },

  refreshVirtualFolder: async (type) => {
    // ONE page size per view — the same value the Paginator and goToEmailPage
    // use — so a refresh replaces exactly one page, never a mismatched size that
    // makes next/prev overlap. "All Email" and "All Inboxes" are the fixed-100
    // firehose views.
    const PAGE_SIZE = (type === 'all' || type === 'unified') ? ALL_MAIL_PAGE_SIZE : getEmailsPerPage();
    try {
      let result;
      if (type === 'unified') {
        // Merged INBOX across opted-in accounts. Rows arrive tagged with
        // accountId (for the color dot) and sorted newest-first by the main
        // process. Reads each account's local DB — no network wait.
        const accountIds = get().accounts
          .filter((a) => a.includeInUnified !== false)
          .map((a) => a.id);
        const res = await window.electronAPI.accounts.unifiedInbox({ accountIds, limit: PAGE_SIZE, offset: 0 });
        if (res?.success && res.data) {
          const merged = res.data.emails as any[];
          set({ emails: merged, hasMoreEmails: res.data.hasMore, emailsOffset: PAGE_SIZE, emailsPage: 0, emailsTotal: 0 });
          // Rows synced header-only (e.g. just arrived via IDLE) have no preview
          // snippet. Fetch their bodies — fetchEmailBody routes to each row's OWN
          // account (via the accountId tag), so it works across accounts.
          const missing = merged.filter((e) => !((e.cleanBody as string) || '').trim());
          if (missing.length > 0) {
            // Clear any prior "failed" marks first: a body fetch that failed once
            // (e.g. that account's IMAP wasn't connected yet) would otherwise be
            // skipped forever, leaving the snippet permanently blank. Retrying is
            // safe — fetchEmailBody no-ops once the body is present.
            const failed = new Set(get().failedBodies);
            missing.forEach((e) => failed.delete(e.id));
            set({ failedBodies: failed });
            missing.slice(0, 30).forEach((e) => { void get().fetchEmailBody(e.id); });
          }
        }
        return;
      }
      if (type === 'all') {
        result = await window.electronAPI.emails.getAll(PAGE_SIZE, 0);
      } else if (type === 'starred') {
        result = await window.electronAPI.emails.getStarred(PAGE_SIZE, 0);
      } else if (type === 'important') {
        result = await window.electronAPI.emails.getImportant(PAGE_SIZE, 0);
      } else if (type === 'snoozed') {
        const snoozedResult = await window.electronAPI.snooze.list();
        if (snoozedResult.success && snoozedResult.data) {
          set({ emails: snoozedResult.data as any, hasMoreEmails: false });
        }
        return;
      }
      if (result?.success && result.data) {
        // Merge instead of replace to avoid flicker
        const freshEmails = result.data as any[];
        const currentEmails = get().emails;
        const merged = mergeEmailLists(currentEmails, freshEmails);
        set({ emails: merged, hasMoreEmails: freshEmails.length >= PAGE_SIZE });
      }
    } catch (error) {
      console.error(`[Store] Error refreshing virtual folder ${type}:`, error);
    }
  },

  clearVirtualFolder: () => set({ selectedVirtualFolder: null }),

  selectUnifiedInbox: () => {
    // Switch to the merged "All Inboxes" view. Reset every other view selector
    // so it renders as a flat, cross-account list (refreshView treats any
    // non-'all' virtual folder as flat) and the previous view's mail is cleared.
    set({
      selectedVirtualFolder: 'virtual-unified',
      selectedFolderId: null,
      selectedEmailId: null,
      highlightedEmailId: null,
      viewingSnoozed: false,
      viewingAICategory: null,
      searchQuery: '',
      searchResults: [],
      searchInterpretation: null,
      // Leaving a section full-page view — clear it so the unified paginator
      // uses the unified page size, not the stale section's (the 1–20 that then
      // jumped to 50 when navigating).
      viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE,
      emails: [],
      emailsOffset: 0,
      emailsPage: 0,
      emailsTotal: 0,
      hasMoreEmails: false,
      // Show the spinner during the async merge instead of a flash of "No emails
      // in this folder" (unified is a flat list, so the empty `emails` above
      // would otherwise trip the empty-state until refreshVirtualFolder fills it).
      loadingEmails: true,
    });
    get().refreshVirtualFolder('unified').finally(() => set({ loadingEmails: false }));
  },

  refreshUnreadSummary: async () => {
    try {
      const accountIds = get().accounts.map((a) => a.id);
      if (accountIds.length === 0) return;
      const res = await window.electronAPI.accounts.unreadSummary(accountIds);
      if (res?.success && res.data) {
        const map: Record<string, number> = {};
        for (const { accountId, unread } of res.data) map[accountId] = unread;
        set({ accountUnread: map });
      }
    } catch (error) {
      console.error('[Store] Failed to refresh unread summary:', error);
    }
  },

  runBackgroundSyncCycle: async () => {
    if (bgSyncRunning) return; // don't overlap with a still-running cycle
    const { accounts, activeAccountId } = get();
    // Opted-in, non-active accounts only — the active one drives its own IDLE.
    const targets = accounts.filter((a) => a.id !== activeAccountId && a.backgroundSync !== false);
    if (targets.length === 0) return;

    bgSyncRunning = true;
    console.log('[TierB] cycle start — targets:', targets.map((a) => `${a.email}@${a.imapConfig?.host}`));
    try {
      // Serial: one account at a time to avoid a connection storm (up to 10
      // accounts). Each is isolated so one failure never stops the rest.
      for (const acct of targets) {
        try {
          const res = await window.electronAPI.accounts.backgroundSync({ accountId: acct.id, config: acct.imapConfig });
          console.log('[TierB] backgroundSync result for', acct.email, '@', acct.imapConfig?.host, '→', res);
          if (res?.success && res.data) {
            set({ accountUnread: { ...get().accountUnread, [acct.id]: res.data.unread } });
          }
        } catch (e) {
          console.warn('[TierB] backgroundSync failed for', acct.id, (e as Error)?.message);
        }
      }
      // If the merged view is open, refresh it so newly-synced mail appears.
      if (get().selectedVirtualFolder === 'virtual-unified') {
        await get().refreshVirtualFolder('unified');
      }
      // Recompute every account's unread badge from LOCAL folder counts (no IMAP
      // needed, so it's accurate even when an account's background IMAP sync
      // failed or ran only while now-moved mail was still in the inbox). This
      // clears stale "All Inboxes: N" badges — e.g. mail that arrived unread and
      // was later read or spam-filtered but left the count stuck.
      await get().refreshUnreadSummary();
    } finally {
      bgSyncRunning = false;
    }
  },

  loadSnoozedEmails: async () => {
    console.log('[View] Selected: Snoozed');
    set({ loadingEmails: true, emails: [], selectedEmailId: null, highlightedEmailId: null, viewingSnoozed: true, selectedFolderId: null, selectedVirtualFolder: null, viewingAICategory: null, sectionData: {}, searchQuery: '', searchResults: [], searchInterpretation: null, viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE, emailsPage: 0, emailsTotal: 0 });
    try {
      const result = await window.electronAPI.snooze.list();
      console.log('[Store] Snoozed list result:', result);
      if (result.success && result.data) {
        console.log('[Store] Found', result.data.length, 'snoozed emails');
        const emailPromises = result.data.map(async (snoozed: { emailId: string }) => {
          console.log('[Store] Fetching email:', snoozed.emailId);
          const emailResult = await window.electronAPI.emails.get(snoozed.emailId);
          console.log('[Store] Email result for', snoozed.emailId, ':', emailResult.success, emailResult.data ? 'found' : 'not found');
          return emailResult.success ? emailResult.data : null;
        });
        const now = Math.floor(Date.now() / 1000);
        const emails = (await Promise.all(emailPromises)).filter((e: any) => e && e.snoozeUntil && e.snoozeUntil > now) as any[];
        console.log('[Store] Loaded', emails.length, 'snoozed emails (filtered expired)');
        set({ emails, hasMoreEmails: false });
      }
    } catch (error) {
      console.error('Failed to load snoozed emails:', error);
    } finally {
      set({ loadingEmails: false });
    }
  },

  clearSnoozedView: () => set({ viewingSnoozed: false }),

  // Outbox is a virtual view (the send-queue, not a real folder). Modeled as a
  // selectedVirtualFolder value so every folder/snooze/AI switch auto-clears it
  // via their existing `selectedVirtualFolder: null` resets.
  showOutbox: () => set({
    selectedVirtualFolder: 'virtual-outbox',
    selectedFolderId: null,
    selectedEmailId: null,
    highlightedEmailId: null,
    viewingSnoozed: false,
    viewingAICategory: null,
    searchQuery: '',
    searchResults: [],
    searchInterpretation: null,
    viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE,
  }),

  loadLabels: async () => {
    try {
      const res = await window.electronAPI.labels.list();
      if (res.success && res.data) set({ labels: res.data });
    } catch (err) {
      console.error('[Store] loadLabels failed:', err);
    }
  },

  // Toggle a label on an email: optimistically patch the tag across every view
  // (flat list, thread, search, and sectionData) then persist via IPC.
  setEmailLabel: async (emailId, label, on) => {
    const name = label.trim();
    if (!name) return;
    const patchTags = (t?: string | null): string => {
      const tags = t || '||';
      const has = tags.includes('|' + name + '|');
      if (on && !has) {
        const l = tags.split('|').filter(Boolean);
        l.push(name);
        return '|' + l.join('|') + '|';
      }
      if (!on && has) {
        const l = tags.split('|').filter((x) => x && x !== name);
        return l.length ? '|' + l.join('|') + '|' : '||';
      }
      return tags;
    };
    const st = get();
    const upd = (arr: any[]) => arr.map((e) => (e.id === emailId ? { ...e, tags: patchTags(e.tags) } : e));
    const patch: any = {
      emails: upd(st.emails),
      threadEmails: upd(st.threadEmails),
      searchResults: upd(st.searchResults),
    };
    const sd = st.sectionData || {};
    let nextSd: any = null;
    for (const [sid, b] of Object.entries(sd)) {
      const bucket = b as any;
      if (!bucket?.emails?.some((e: any) => e.id === emailId)) continue;
      if (!nextSd) nextSd = { ...sd };
      const ne = bucket.emails.map((e: any) => (e.id === emailId ? { ...e, tags: patchTags(e.tags) } : e));
      nextSd[sid] = { ...bucket, emails: ne, threads: buildThreads(ne) };
    }
    if (nextSd) patch.sectionData = nextSd;
    set(patch);
    try {
      await window.electronAPI.labels.setOnEmail(emailId, name, on, get()._accountIdFor(emailId));
    } catch (err) {
      console.error('[Store] setEmailLabel failed:', err);
    }
  },

  // Show all emails carrying a label (a tag). Reuses the generic tag query.
  showLabel: (label) => {
    const vf = `label:${label}`;
    set({
      selectedVirtualFolder: vf,
      selectedFolderId: null,
      selectedEmailId: null,
      highlightedEmailId: null,
      viewingSnoozed: false,
      viewingAICategory: null,
      searchQuery: '',
      searchResults: [],
      searchInterpretation: null,
      sectionData: {},
      emails: [],
      loadingEmails: true,
      viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE,
      emailsPage: 0, emailsTotal: 0,
    });
    window.electronAPI.ai
      .getByCategory(label, 500, 0)
      .then((res: any) => {
        if (get().selectedVirtualFolder !== vf) return; // superseded
        set({ emails: res.success && res.data ? res.data : [], loadingEmails: false });
      })
      .catch(() => {
        if (get().selectedVirtualFolder === vf) set({ loadingEmails: false });
      });
  },

  clearSectionData: () => set({ sectionData: {}, sectionLoading: new Set() }),

  loadSectionEmails: async (sectionId, filter, folderPath?) => {
    // Gmail "Show up to" — the home section preview shows the section's maxItems
    // (5/10/25/50; default 25). Clicking the count opens the full paginated page.
    const section = get().inboxSections.find((s) => s.id === sectionId);
    const pageSize = section?.maxItems && section.maxItems > 0 ? section.maxItems : 25;
    console.log(`[View] loadSectionEmails section=${sectionId}, filter=${filter}, folderPath=${folderPath || 'all'}, pageSize=${pageSize}`);

    // Mark section loading
    const newLoading = new Set(get().sectionLoading);
    newLoading.add(sectionId);
    set({ sectionLoading: newLoading });

    try {
      const viewFilter = get().activeInboxFilter ?? undefined;
      const [emailsResult, countsResult] = await Promise.all([
        window.electronAPI.emails.listBySection(filter, pageSize, 0, folderPath, viewFilter),
        window.electronAPI.emails.sectionCounts([filter], folderPath, viewFilter),
      ]);

      const emails = emailsResult.success && emailsResult.data ? emailsResult.data : [];
      const total = countsResult.success && countsResult.data ? (countsResult.data[filter] || 0) : 0;
      const threads = buildThreads(emails);

      const currentSectionData = get().sectionData;
      const newSectionData = {
        ...currentSectionData,
        [sectionId]: {
          emails,
          threads,
          offset: pageSize,
          page: 0,
          hasMore: threads.length >= pageSize && threads.length < total,
          total,
          loading: false,
        },
      };
      set({
        sectionData: newSectionData,
        emails: flattenSectionEmails(newSectionData),
      });
    } catch (error) {
      console.error(`[Store] Failed to load section ${sectionId}:`, error);
    } finally {
      const updatedLoading = new Set(get().sectionLoading);
      updatedLoading.delete(sectionId);
      set({ sectionLoading: updatedLoading });
    }
  },

  loadMoreSectionEmails: async (sectionId, filter, folderPath?) => {
    const currentSection = get().sectionData[sectionId];
    if (!currentSection || currentSection.loading) return;

    // Mark section loading
    const currentSectionData = get().sectionData;
    set({
      sectionData: {
        ...currentSectionData,
        [sectionId]: { ...currentSection, loading: true },
      },
    });

    try {
      // offset is thread-based (current thread count = offset into thread list)
      const result = await window.electronAPI.emails.listBySection(
        filter, LOAD_MORE_SIZE, currentSection.offset, folderPath, get().activeInboxFilter ?? undefined
      );

      if (result.success && result.data && result.data.length > 0) {
        const existingIds = new Set(currentSection.emails.map(e => e.id));
        const newEmails = result.data.filter((e: any) => !existingIds.has(e.id));
        const allEmails = [...currentSection.emails, ...newEmails];
        const threads = buildThreads(allEmails);
        const newOffset = currentSection.offset + LOAD_MORE_SIZE;

        const latestSectionData = get().sectionData;
        const newSectionData = {
          ...latestSectionData,
          [sectionId]: {
            emails: allEmails,
            threads,
            offset: newOffset,
            hasMore: threads.length < currentSection.total,
            total: currentSection.total,
            loading: false,
          },
        };
        set({
          sectionData: newSectionData,
          emails: flattenSectionEmails(newSectionData),
        });
      } else {
        const latestSectionData = get().sectionData;
        const newSectionData = {
          ...latestSectionData,
          [sectionId]: { ...currentSection, hasMore: false, loading: false },
        };
        set({
          sectionData: newSectionData,
          emails: flattenSectionEmails(newSectionData),
        });
      }
    } catch (error) {
      console.error(`[Store] Failed to load more for section ${sectionId}:`, error);
      const latestSectionData = get().sectionData;
      const newSectionData = {
        ...latestSectionData,
        [sectionId]: { ...currentSection, loading: false },
      };
      set({
        sectionData: newSectionData,
        emails: flattenSectionEmails(newSectionData),
      });
    }
  },

  /**
   * Gmail-style discrete pagination for ONE section: jump to `page` (0-based) and
   * REPLACE that section's rows with just that page — never append. Generic per
   * (sectionId, filter), so it works for every inbox-type config (unread /
   * everything, important / starred / everything, custom). `total` is the
   * section's real COUNT (sectionCounts), so "X–Y of Z" and prev/next stay honest.
   */
  goToSectionPage: async (sectionId, filter, page, folderPath?) => {
    const cur = get().sectionData[sectionId];
    if (page < 0 || cur?.loading) return;
    const pageSize = getEmailsPerPage();
    const offset = page * pageSize;
    // Mark loading (preserve current rows so the list doesn't flash empty).
    set({ sectionData: { ...get().sectionData, [sectionId]: { ...(cur || { emails: [], threads: [] }), loading: true } } });
    try {
      const viewFilter = get().activeInboxFilter ?? undefined;
      const [emailsResult, countsResult] = await Promise.all([
        window.electronAPI.emails.listBySection(filter, pageSize, offset, folderPath, viewFilter),
        window.electronAPI.emails.sectionCounts([filter], folderPath, viewFilter),
      ]);
      const emails = emailsResult.success && emailsResult.data ? emailsResult.data : [];
      const total = countsResult.success && countsResult.data ? (countsResult.data[filter] || 0) : (cur?.total || 0);
      const threads = buildThreads(emails);
      const newSectionData = {
        ...get().sectionData,
        [sectionId]: {
          emails,
          threads,
          offset,
          page,
          total,
          loading: false,
          hasMore: offset + threads.length < total,
        },
      };
      set({ sectionData: newSectionData, emails: flattenSectionEmails(newSectionData) });
    } catch (error) {
      console.error(`[Store] goToSectionPage ${sectionId} failed:`, error);
      const latest = get().sectionData;
      set({ sectionData: { ...latest, [sectionId]: { ...(latest[sectionId] || { emails: [], threads: [] }), loading: false } } });
    }
  },

  loadAllSections: async (folderPath?) => {
    const { inboxType, inboxSections } = get();
    if (inboxType === 'default' || inboxSections.length === 0) return;

    // Latest-request-wins: a newer reload of the same view must not be clobbered
    // by an older one that resolves later (see sectionLoadSeq note above).
    const mySeq = ++sectionLoadSeq;

    // Rows in the 5s delete-undo window still exist in the DB — exclude them so
    // a reload doesn't resurrect a row the user just deleted (ghost row).
    const pendingDeleteIds = new Set(get().pendingDeletes.map((p) => p.emailId));

    // Active quick-filter (unread/read/starred/attachment/unlabelled) narrows
    // every section query without leaving the sectioned layout.
    const viewFilter = get().activeInboxFilter ?? undefined;

    // Capture view identity so a stale load can't overwrite a view the user
    // switched to while the section queries were in flight
    const entryFolderId = get().selectedFolderId;
    const entryVirtual = get().selectedVirtualFolder;
    const isStale = () => {
      const s = get();
      return s.selectedFolderId !== entryFolderId || s.selectedVirtualFolder !== entryVirtual
        || s.viewingSnoozed || !!s.viewingAICategory;
    };

    // Only show loading spinner if this is the first load (no existing data)
    const hasExistingData = Object.keys(get().sectionData).length > 0;
    if (!hasExistingData) {
      set({ sectionData: {}, loadingEmails: true });
    }

    const sectionsToLoad = inboxSections.filter(s => s.filter !== 'none');

    const currentSectionData = get().sectionData;

    // Fetch all sections in parallel, then batch into a single set() to avoid flicker
    const results = await Promise.all(
      sectionsToLoad.map(async (section) => {
        const dbFilter = getDbFilter(section, inboxType);
        // If the user has scrolled and paginated this section, we must fetch up to their current offset
        // so that an IMAP sync does not abruptly truncate their view back down to page 1.
        const existingData = currentSectionData[section.id];
        // Home preview size = the section's "Show up to" maxItems (default 25),
        // matching Gmail; if the user has paginated, keep their current offset.
        const previewSize = section.maxItems && section.maxItems > 0 ? section.maxItems : 25;
        // Preserve the user's paginated depth so a background sync doesn't snap
        // the list back to page 1 — but CAP it, so a deeply-paginated section
        // can't make every sync tick re-fetch + re-buildThreads its whole grown
        // set (the "lags every few seconds" beachball). See computeSectionFetchLimit.
        const fetchLimit = computeSectionFetchLimit(existingData?.offset, previewSize);

        try {
          const [emailsResult, countsResult] = await Promise.all([
            window.electronAPI.emails.listBySection(dbFilter, fetchLimit, 0, folderPath, viewFilter),
            window.electronAPI.emails.sectionCounts([dbFilter], folderPath, viewFilter),
          ]);

          const rawEmails = emailsResult.success && emailsResult.data ? emailsResult.data : [];
          const emails = pendingDeleteIds.size > 0
            ? rawEmails.filter((e: any) => !pendingDeleteIds.has(e.id))
            : rawEmails;
          const total = countsResult.success && countsResult.data ? (countsResult.data[dbFilter] || 0) : 0;
          const threads = buildThreads(emails);

          return {
            sectionId: section.id,
            data: {
              emails,
              threads,
              offset: fetchLimit,
              hasMore: threads.length >= fetchLimit && threads.length < total,
              total,
              loading: false
            },
          };
        } catch (error) {
          console.error(`[Store] Failed to load section ${section.id}:`, error);
          return {
            sectionId: section.id,
            data: { emails: [], threads: [], offset: existingData?.offset || 0, hasMore: false, total: 0, loading: false },
          };
        }
      })
    );

    // Single set() call with all section data — no flicker
    const newSectionData: Record<string, any> = {};
    for (const r of results) {
      newSectionData[r.sectionId] = r.data;
    }

    // Bail if the view changed OR a newer loadAllSections started while our
    // queries were in flight — otherwise this (now-stale) snapshot would
    // overwrite the fresher one.
    if (isStale() || mySeq !== sectionLoadSeq) return;

    // No-op guard: a background reload (IMAP sync / IDLE flush / AI-complete)
    // fires every few seconds, but most ticks bring NO change to the visible
    // section rows. Running set() anyway rebuilds every thread object (fresh
    // identities) and re-renders every row — the "lags every few seconds"
    // beachball. Skip the set() when the fetched rows + header counts render
    // identically to what's already shown. sectionDataUnchanged is conservative
    // (id/updatedAt/date/tags/flags/subject/snippet + total/hasMore/loading), so
    // it can only ever FAIL to skip — never skip a render the user needed to see.
    const currentSnapshot = get().sectionData;
    const nextPool = flattenSectionEmails(newSectionData);
    // ...and only while the flat pool still matches those rows. `emails` is
    // DERIVED from sectionData but kept in its own slot, and selectFolder
    // clears it to [] while deliberately KEEPING sectionData cached (see its
    // note). So "the sections render identically" does NOT imply "the pool
    // survived": re-selecting INBOX with a message open left every row on
    // screen unclickable, because selectEmail resolves the clicked id out of
    // `emails`, found nothing, never loaded the thread — and the reading pane
    // sat on "Select an email to read" until the sections happened to change.
    // Skipped while drilled into a section: there `emails` is that section's
    // flat page, not the pool, and must not be overwritten by it.
    const poolMatchesSections =
      !!get().viewingSection || get().emails.length === nextPool.length;
    if (
      Object.keys(currentSnapshot).length > 0
      && sectionDataUnchanged(currentSnapshot, newSectionData)
      && poolMatchesSections
    ) {
      if (import.meta.env.DEV) console.log('[Store] loadAllSections: no visible change — skipped re-render');
      // Clear the first-load spinner if it somehow remained on.
      if (get().loadingEmails) set({ loadingEmails: false });
      return;
    }

    set({
      sectionData: newSectionData,
      emails: nextPool,
      loadingEmails: false,
    });
  },

  _reloadCurrentView: async () => {
    // Clear category badge cache so badges refresh with latest data
    clearCategoryBadgeCache();
    // For AI category / virtual folder / snoozed / search views, sync MUST NOT
    // inject fresh inbox emails into `emails` — those views are curated
    // (Needs Response, Starred, virtual-all, etc.) and mixing in plain
    // INBOX content during a background sync makes the user's filtered list
    // suddenly show "all emails". selectedFolderId can still be set (it's
    // preserved as the return target), so we need to check EVERY override.
    const {
      selectedFolderId,
      viewingAICategory,
      selectedVirtualFolder,
      viewingSnoozed,
      searchQuery,
    } = get();
    if (viewingAICategory || selectedVirtualFolder || viewingSnoozed || searchQuery) {
      // Curated view — leave `emails` alone. Realtime delete/flag events
      // still update rows in place; the user can pull-to-refresh or leave
      // and re-enter the view to see new items.
      return;
    }
    // Sectioned INBOX renders from `sectionData`, NOT the flat `emails` array,
    // so the flat merge below would update the wrong store slot and look like a
    // no-op. Reload sections instead — otherwise a manual refresh / full sync
    // bumps the counter (loadFolders) but leaves the Unread/Everything-else
    // lists stale until a later realtime event happens to reload them.
    const { inboxType, inboxSections, folders } = get();
    if (selectedFolderId && inboxType !== 'default' && inboxSections.length > 0) {
      const sel = folders?.find((f) => f.id === selectedFolderId);
      if (sel?.path === 'INBOX') {
        await get().loadAllSections('INBOX');
        return;
      }
    }
    if (selectedFolderId) {
      try {
        const PAGE_SIZE = 100;
        const result = await window.electronAPI.emails.list(selectedFolderId!, PAGE_SIZE);
        if (result.success && result.data) {
          const fresh = result.data as any[];
          const currentEmails = get().emails;
          const existingIds = new Set(currentEmails.map(e => e.id));
          const freshMap = new Map<string, any>(fresh.map(e => [e.id, e]));

          // Update existing emails in place where fresh has a newer version.
          // Never drop — emails past page 1 stay in the list; deletions come
          // via the explicit 'deleted' realtime event.
          // `changed` is tracked explicitly: the guard below used to compare
          // `updated === currentEmails`, but Array.prototype.map ALWAYS returns a
          // new array, so that check could never be true and the bail-out was
          // unreachable. Every reload therefore replaced the whole `emails`
          // array — a new identity for the list on each sync tick, which
          // rebuilds all threads and re-renders every row even when the server
          // returned byte-identical data.
          let changed = false;
          const updated = currentEmails.map(e => {
            const f = freshMap.get(e.id);
            if (!f) return e;
            if (e.tags !== f.tags || e.date !== f.date || e.subject !== f.subject
              || (e as any).threadIsStarred !== (f as any).threadIsStarred
              || (e as any).threadIsImportant !== (f as any).threadIsImportant) {
              changed = true;
              return f;
            }
            return e;
          });

          // Prepend genuinely new emails, sort by date desc.
          const newOnes = fresh.filter(e => !existingIds.has(e.id));
          if (newOnes.length === 0 && !changed) return;

          const merged = [...newOnes, ...updated].sort((a, b) => (b.date || 0) - (a.date || 0));
          set({ emails: merged });
          // Intentionally do NOT touch emailsOffset or hasMoreEmails — user's
          // scrolled / loaded-more state is preserved.
        }
      } catch (error) {
        console.error('[Store] _reloadCurrentView merge failed:', error);
      }
    }
  },

  fetchEmailBody: async (emailId) => {
    const { loadingBodies, failedBodies, emails, threadEmails, searchResults } = get();

    if (loadingBodies.has(emailId)) {
      console.log('[Store] fetchEmailBody: already loading', emailId);
      return;
    }
    if (failedBodies.has(emailId)) {
      console.log('[Store] fetchEmailBody: previously failed, skipping', emailId);
      return;
    }

    const email = emails.find(e => e.id === emailId)
      || threadEmails.find(e => e.id === emailId)
      || searchResults.find(e => e.id === emailId);

    // A cached body normally means "nothing to do" — but older attachment rows
    // still owe us real filenames + sizes, which only the source parse on fetch
    // can supply. We key off attachmentSizes (null until the new parser has run
    // — the legacy filename could be the bogus truthy "SIZE") so those rows
    // re-fetch once and the chip renders + downloads match the real filename.
    const needsAttachmentMeta = !!email?.hasAttachments && !email?.attachmentSizes;
    if (email?.rawBody && !needsAttachmentMeta) {
      console.log('[Store] fetchEmailBody: body already exists', emailId);
      return;
    }

    console.log('[Store] fetchEmailBody: fetching body for', emailId);

    const newLoadingBodies = new Set(loadingBodies);
    newLoadingBodies.add(emailId);
    set({ loadingBodies: newLoadingBodies });

    try {
      // Route to the email's own account (unified view) so the body is fetched
      // from the right DB/engine, not the active one.
      const accountId = email?.accountId ?? get().viewAccountId ?? undefined;
      const result = await window.electronAPI.emails.fetchBody(emailId, accountId);

      if (result.success && result.data && result.data.rawBody !== undefined) {
        const state = get();
        const updates: any = {};

        const emailIndex = state.emails.findIndex(e => e.id === emailId);
        if (emailIndex !== -1) {
          const newEmails = [...state.emails];
          newEmails[emailIndex] = { ...newEmails[emailIndex], ...result.data };
          updates.emails = newEmails;
        }

        const threadIndex = state.threadEmails.findIndex(e => e.id === emailId);
        if (threadIndex !== -1) {
          const newThreadEmails = [...state.threadEmails];
          newThreadEmails[threadIndex] = { ...newThreadEmails[threadIndex], ...result.data };
          updates.threadEmails = newThreadEmails;
        }

        const searchIndex = state.searchResults.findIndex(e => e.id === emailId);
        if (searchIndex !== -1) {
          const newSearchResults = [...state.searchResults];
          newSearchResults[searchIndex] = { ...newSearchResults[searchIndex], ...result.data };
          updates.searchResults = newSearchResults;
        }

        // Sectioned inbox renders from sectionData — patch it so the fetched
        // body shows in the visible section rows (not just the flat `emails`).
        const nextSectionData = mergeBodyIntoSectionData(state.sectionData, new Map([[emailId, result.data]]));
        if (nextSectionData) updates.sectionData = nextSectionData;

        if (Object.keys(updates).length > 0) {
          set(updates);
          console.log('[Store] fetchEmailBody: updated email with body', emailId);
        }
      } else {
        // A body fetch can fail because the message was deleted OR MOVED on the
        // server, OR for a transient reason (timeout, queue full, connection blip).
        // We must NOT act destructively here. The old code called emails.delete() —
        // a permanent local hard-delete AND a server EXPUNGE — whenever the error
        // text merely contained 'not found' / 'deleted' / 'moved'. A transient
        // error, or a genuine MOVE (the message still exists in another folder),
        // then permanently destroyed live mail. Instead: mark the body as failed
        // (stops the retry loop) and, only if it looks gone, let the GUARDED
        // deletion reconcile confirm and remove it — that path has the empty-list /
        // mass-deletion ratio / unlink-or-delete safety nets this one lacks.
        const retryable = isRetryableBodyFetchError(result.error);
        const looksGone = looksGoneFromServer(result.error);
        if (retryable) {
          console.warn('[Store] fetchEmailBody: no answer yet, will allow retry', emailId, result.error);
        } else {
          console.warn(`[Store] fetchEmailBody: body unavailable (${looksGone ? 'maybe removed on server' : 'transient'}) — marking failed, NOT deleting`, result.error);
        }
        if (!retryable) {
          set({ failedBodies: withFailedBody(get().failedBodies, emailId) });
        }
        // If it genuinely vanished from this folder, the guarded folder sync will
        // reconcile it safely (and emit a per-email deleted event) — never a blind
        // expunge triggered by a single failed body fetch.
        if (looksGone && !retryable) {
          const folderId = get().selectedFolderId;
          const folderPath = folderId ? get().folders.find((f: any) => f.id === folderId)?.path : undefined;
          get().syncEmails(folderPath ? { folders: [folderPath] } : undefined).catch(() => {});
        }
      }
    } catch (error) {
      const errMsg = (error as Error)?.message;
      // Same retryable set as the `{success:false}` path above — a thrown IPC
      // error used to know only about "queue full", so a deferred fetch that
      // surfaced as a throw still parked the email.
      const retryable = isRetryableBodyFetchError(errMsg);
      const isPermanent = looksGoneFromServer(errMsg);
      if (retryable) {
        console.warn('[Store] fetchEmailBody: no answer yet, will allow retry', emailId, errMsg);
      } else if (!isPermanent) {
        console.warn('[Store] fetchEmailBody: transient error, marking as failed to prevent retry loop', error);
      } else {
        console.error('[Store] fetchEmailBody: permanent error, marking as failed', error);
      }
      if (!retryable) {
        set({ failedBodies: withFailedBody(get().failedBodies, emailId) });
      }
    } finally {
      const currentLoadingBodies = get().loadingBodies;
      const updatedLoadingBodies = new Set(currentLoadingBodies);
      updatedLoadingBodies.delete(emailId);
      set({ loadingBodies: updatedLoadingBodies });
    }
  },

  fetchBodiesForVisibleEmails: async (emailIds) => {
    const { loadingBodies, failedBodies, emails, threadEmails, searchResults } = get();

    const emailsNeedingBodies = emailIds.filter(emailId => {
      if (loadingBodies.has(emailId)) return false;
      if (failedBodies.has(emailId)) return false;

      const email = emails.find(e => e.id === emailId)
        || threadEmails.find(e => e.id === emailId)
        || searchResults.find(e => e.id === emailId);

      return !email?.rawBody;
    });

    if (emailsNeedingBodies.length === 0) {
      return;
    }

    console.log(`[Store] fetchBodiesForVisibleEmails: ${emailsNeedingBodies.length} emails need bodies`);

    const newLoadingBodies = new Set(loadingBodies);
    emailsNeedingBodies.forEach(id => newLoadingBodies.add(id));
    set({ loadingBodies: newLoadingBodies });

    const pendingBodyUpdates: Map<string, any> = new Map();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBodyUpdates = () => {
      if (pendingBodyUpdates.size === 0) return;

      const updates = new Map(pendingBodyUpdates);
      pendingBodyUpdates.clear();

      const state = get();
      const result: any = {};

      const loading = new Set(state.loadingBodies);
      updates.forEach((_, id) => loading.delete(id));
      result.loadingBodies = loading;

      if (state.emails.some(e => updates.has(e.id))) {
        result.emails = state.emails.map(e => {
          const updated = updates.get(e.id);
          return updated ? { ...e, rawBody: updated.rawBody, cleanBody: updated.cleanBody, contentType: updated.contentType } : e;
        });
      }

      if (state.threadEmails.some(e => updates.has(e.id))) {
        result.threadEmails = state.threadEmails.map(e => {
          const updated = updates.get(e.id);
          return updated ? { ...e, rawBody: updated.rawBody, cleanBody: updated.cleanBody, contentType: updated.contentType } : e;
        });
      }

      if (state.searchResults.some(e => updates.has(e.id))) {
        result.searchResults = state.searchResults.map(e => {
          const updated = updates.get(e.id);
          return updated ? { ...e, rawBody: updated.rawBody, cleanBody: updated.cleanBody, contentType: updated.contentType } : e;
        });
      }

      // Sectioned inbox renders from sectionData — patch it too, else bodies
      // download to the DB but the visible section rows stay blank.
      const nextSectionData = mergeBodyIntoSectionData(state.sectionData, updates);
      if (nextSectionData) result.sectionData = nextSectionData;

      set(result);
    };

    const updateEmailInState = (updatedEmail: any) => {
      if (!updatedEmail?.id || !updatedEmail?.rawBody) return;

      pendingBodyUpdates.set(updatedEmail.id, updatedEmail);

      if (pendingBodyUpdates.size >= 4) {
        if (flushTimer) clearTimeout(flushTimer);
        flushBodyUpdates();
      } else {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flushBodyUpdates, 500);
      }
    };

    // Per-call unsubscribe — removeAllListeners would kill overlapping calls' listeners
    const unsubscribeBodyFetched = window.electronAPI.emails.onBodyFetched(updateEmailInState);

    try {
      console.log('[Store] Calling electronAPI.emails.fetchBodiesBatch (parallel)...');
      const result = await window.electronAPI.emails.fetchBodiesBatch(emailsNeedingBodies);
      console.log('[Store] fetchBodiesBatch done:', result.success, 'count:', result.data?.length || 0);

      if (!result.success) {
        console.warn('[Store] fetchBodiesForVisibleEmails: batch failed', result.error);
      }
    } catch (error) {
      console.error('[Store] fetchBodiesForVisibleEmails: error', error);
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      flushBodyUpdates();

      unsubscribeBodyFetched();

      const currentLoadingBodies = get().loadingBodies;
      const updatedLoadingBodies = new Set(currentLoadingBodies);
      emailsNeedingBodies.forEach(id => updatedLoadingBodies.delete(id));
      set({ loadingBodies: updatedLoadingBodies });
    }
  },
});
