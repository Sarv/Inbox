// Deep-import the SUBPATH, never the '@sarvinbox/core' barrel: the barrel pulls
// in imapflow/mailparser/nodemailer, which blow up the renderer at runtime with
// "Dynamic require of 'stream' is not supported". folder-mapping is pure (no
// imports at all), so the renderer shares the one implementation. Alias is
// declared in vite.config.ts, vitest.config.ts and tsconfig.json.
import { classifyFolder } from '@sarvinbox/core/folder-mapping';

import { addTag, removeTag, hasTag } from '../../utils/tags';
import { buildThreads } from '../../utils/thread-utils';
import { requestConfirm } from '../confirm-service';
import type { EmailActionsSlice, SliceCreator } from '../types';

/**
 * At or above this many messages, a destructive bulk action prompts for
 * confirmation first — so an accidental select-all can't silently move/delete a
 * whole folder. An intentional user just clicks through.
 */
const BULK_CONFIRM_THRESHOLD = 20;

const BULK_ACTION_VERB: Record<string, string> = {
  delete: 'delete',
  spam: 'mark as spam',
  archive: 'archive',
  notspam: 'move to Inbox',
};

/**
 * The single source of truth for "does deleting here mean a permanent expunge?"
 * Decide by the EMAIL's own location (tags) FIRST, then the current folder
 * view — opening a Trash message from an Inbox view leaves selectedFolderId on
 * Inbox, so a folder-only check would wrongly treat it as a recoverable move
 * (the old "immortal draft" bug). Every delete path — single and bulk — must
 * use this so their permanent-vs-move decision (and the guard below) agree.
 * Pass `emailTags = undefined` for bulk actions, which are scoped to the
 * current folder view.
 */
function isInTrashContext(
  emailTags: string | undefined,
  folders: Array<{ id: string; path: string; specialUse?: string | null }>,
  selectedFolderId: string | null,
): boolean {
  const tags = emailTags || '';
  // Does any folder-membership tag classify as Trash? Check every real folder's
  // path against the tags (exact classification), not a substring — a label named
  // "Trash Pandas" must NOT count as the Trash folder.
  if (tags) {
    for (const f of folders) {
      if (classifyFolder(f) === 'trash' && tags.includes('|' + f.path + '|')) return true;
    }
  }
  if (!selectedFolderId) return false;
  const folder = folders.find(f => f.id === selectedFolderId);
  if (!folder) return false;
  // Exact classification (special-use → known path → exact last-segment name),
  // never `path.includes('trash')` which mis-classifies custom folders.
  return classifyFolder(folder) === 'trash';
}

/** Resolve an email row (for its tags) by id across every live state slice. */
function resolveRowById(get: any, id: string): { tags?: string } | undefined {
  const s = get();
  const inLists = s.emails.find((x: any) => x.id === id)
    || s.threadEmails.find((x: any) => x.id === id)
    || s.searchResults.find((x: any) => x.id === id);
  if (inLists) return inLists;
  const sd = s.sectionData || {};
  for (const key of Object.keys(sd)) {
    const hit = sd[key]?.emails?.find((x: any) => x.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Build the confirmation prompt for a destructive action. Permanent
 * (irreversible) deletes always warn; large bulk actions warn with the count so
 * the user sees the blast radius before it happens. Shared by the single and
 * bulk delete paths so an "open mail → delete" and a "select-all → delete"
 * behave identically for the same danger.
 */
function destructiveConfirmOptions(action: string, count: number, permanent: boolean) {
  if (permanent) {
    return {
      title: 'Permanently delete',
      message: `Permanently delete ${count} message${count === 1 ? '' : 's'}? This can't be undone.`,
      confirmLabel: 'Delete forever',
      destructive: true,
    };
  }
  const verb = BULK_ACTION_VERB[action] ?? action;
  return {
    title: 'Confirm bulk action',
    message: `You're about to ${verb} ${count} messages. Continue?`,
    confirmLabel: `Yes, ${verb} ${count}`,
    destructive: action === 'delete' || action === 'spam',
  };
}

/** Remove email(s) from sectionData and rebuild threads for affected sections */
function removeEmailsFromSectionData(
  sectionData: Record<string, { emails: any[]; threads: any[]; offset: number; hasMore: boolean; total: number; loading: boolean }>,
  emailIds: Set<string>,
): Record<string, { emails: any[]; threads: any[]; offset: number; hasMore: boolean; total: number; loading: boolean }> | null {
  let changed = false;
  const updated = { ...sectionData };
  for (const [sectionId, sd] of Object.entries(updated)) {
    const newEmails = sd.emails.filter((e: any) => !emailIds.has(e.id));
    if (newEmails.length !== sd.emails.length) {
      updated[sectionId] = { ...sd, emails: newEmails, threads: buildThreads(newEmails), total: sd.total - (sd.emails.length - newEmails.length) };
      changed = true;
    }
  }
  return changed ? updated : null;
}

/**
 * Compute the next email to highlight/select after removing an email from the list.
 * Uses the same index (so the email below slides up), or the last if at end.
 */
function computeNextId(emails: any[], removedIndex: number): string | null {
  if (emails.length === 0 || removedIndex < 0) return null;
  const safeIndex = Math.min(removedIndex, emails.length - 1);
  return safeIndex >= 0 ? emails[safeIndex].id : null;
}

/**
 * Get the visible email pool (what the user actually sees in the list).
 * When searching, this is searchResults; otherwise it's the emails array.
 * This ensures next-email navigation after delete/archive stays within the
 * user's current filtered view.
 */
function getVisiblePool(state: any): any[] {
  if (state.searchQuery) return state.searchResults;
  return state.emails;
}

/**
 * Compute the next email ID from the visible pool after removing an email.
 */
function computeNextIdFromPool(state: any, emailId: string): string | null {
  const pool = getVisiblePool(state);
  const currentIndex = pool.findIndex((e: any) => e.id === emailId);
  const filtered = pool.filter((e: any) => e.id !== emailId);
  return computeNextId(filtered, currentIndex);
}

/**
 * Patch an email's tags in a flat list and recompute the thread-wide
 * aggregate (threadIsStarred/threadIsImportant) across the thread's loaded
 * emails. buildThreads prefers these SQL aggregates over tags, so an
 * optimistic tag change that leaves the stale aggregate behind is invisible.
 * Returns null when the email isn't in the list.
 */
function patchTagsWithThreadAggregate(
  list: any[],
  emailId: string,
  newTags: string,
  aggField: 'threadIsStarred' | 'threadIsImportant',
  tag: 'starred' | 'important',
): any[] | null {
  const idx = list.findIndex((e: any) => e.id === emailId);
  if (idx === -1) return null;
  const threadId = list[idx].threadId;
  const inThread = (e: any) => e.id === emailId || (threadId && e.threadId === threadId);
  const agg = list.some((e: any) =>
    inThread(e) && ((e.id === emailId ? newTags : e.tags) || '').includes(`|${tag}|`)
  );
  return list.map((e: any) => {
    if (e.id === emailId) return { ...e, tags: newTags, [aggField]: agg };
    if (inThread(e)) return { ...e, [aggField]: agg };
    return e;
  });
}

/**
 * Toggle the starred state across a WHOLE thread. The star icon reflects
 * the thread aggregate (threadIsStarred), and Gmail keeps the star on the
 * [Gmail]/Starred copy — a different record than the one in INBOX. So:
 *  - starring: add |starred| to the clicked email, set aggregate true.
 *  - unstarring: remove |starred| from EVERY copy in the thread (else a
 *    sibling copy keeps it and the aggregate re-lights), set aggregate false.
 * Returns a new list, or null if nothing changed.
 */
function setStarAcrossThread(
  list: any[],
  emailId: string,
  starred: boolean,
): any[] | null {
  const idx = list.findIndex((e: any) => e.id === emailId);
  if (idx === -1) return null;
  const threadId = list[idx].threadId;
  const inThread = (e: any) => e.id === emailId || (threadId && e.threadId === threadId);
  return list.map((e: any) => {
    if (starred) {
      // Only the clicked email gets the tag; whole thread reflects aggregate.
      if (e.id === emailId) return { ...e, tags: addTag(e.tags, 'starred'), threadIsStarred: true };
      if (inThread(e)) return { ...e, threadIsStarred: true };
      return e;
    }
    // Unstar: strip the tag from every copy in the thread.
    if (inThread(e)) return { ...e, tags: removeTag(e.tags, 'starred'), threadIsStarred: false };
    return e;
  });
}

/** Thread-aware star toggle across sectionData buckets (rebuilds threads). */
function setStarInSectionData(
  sectionData: Record<string, { emails: any[]; threads: any[]; offset: number; hasMore: boolean; total: number; loading: boolean }>,
  emailId: string,
  starred: boolean,
  sections: Array<{ id: string; filter: string }>,
): typeof sectionData | null {
  let changed = false;
  const updated = { ...sectionData };

  // 1) Flip the star tag wherever the email currently lives.
  let threadId: string | undefined;
  for (const [sectionId, sd] of Object.entries(updated)) {
    const rec = sd.emails.find((e: any) => e.id === emailId);
    if (!rec) continue;
    threadId = rec.threadId;
    const newEmails = setStarAcrossThread(sd.emails, emailId, starred);
    if (newEmails) {
      updated[sectionId] = { ...sd, emails: newEmails, threads: buildThreads(newEmails) };
      changed = true;
    }
  }

  // 2) Re-bucket the thread: starring moves it from "everything else" into the
  // "Starred" section; unstarring moves it back. (Important+unread threads live
  // in their own section and aren't moved by star changes.) Without this, a
  // newly-starred mail stays in Everything else until a reload.
  const targetFilter = starred ? 'starred' : 'everything_else';
  const sourceFilter = starred ? 'everything_else' : 'starred';
  const targetId = sections.find((s) => s.filter === targetFilter)?.id;
  const sourceId = sections.find((s) => s.filter === sourceFilter)?.id;
  if (threadId && targetId && sourceId && updated[sourceId] && updated[targetId]) {
    const src = updated[sourceId];
    const moving = src.emails.filter((e: any) => e.threadId === threadId);
    if (moving.length > 0) {
      const remaining = src.emails.filter((e: any) => e.threadId !== threadId);
      const tgt = updated[targetId];
      const tgtEmails = [...tgt.emails, ...moving];
      updated[sourceId] = { ...src, emails: remaining, threads: buildThreads(remaining), total: Math.max(0, src.total - 1) };
      updated[targetId] = { ...tgt, emails: tgtEmails, threads: buildThreads(tgtEmails), total: tgt.total + 1 };
      changed = true;
    }
  }

  return changed ? updated : null;
}

/** Update an email's tags in sectionData and rebuild threads for affected sections.
 * Pass aggField/aggTag for star/important so thread aggregates are recomputed too. */
function updateEmailInSectionData(
  sectionData: Record<string, { emails: any[]; threads: any[]; offset: number; hasMore: boolean; total: number; loading: boolean }>,
  emailId: string,
  newTags: string,
  aggField?: 'threadIsStarred' | 'threadIsImportant',
  aggTag?: 'starred' | 'important',
): Record<string, { emails: any[]; threads: any[]; offset: number; hasMore: boolean; total: number; loading: boolean }> | null {
  let changed = false;
  const updated = { ...sectionData };
  for (const [sectionId, sd] of Object.entries(updated)) {
    const idx = sd.emails.findIndex((e: any) => e.id === emailId);
    if (idx !== -1) {
      let newEmails: any[];
      if (aggField && aggTag) {
        newEmails = patchTagsWithThreadAggregate(sd.emails, emailId, newTags, aggField, aggTag)!;
      } else {
        newEmails = [...sd.emails];
        newEmails[idx] = { ...newEmails[idx], tags: newTags };
      }
      updated[sectionId] = { ...sd, emails: newEmails, threads: buildThreads(newEmails) };
      changed = true;
    }
  }
  return changed ? updated : null;
}

/** Map a tag flip across ONE array in a single pass. Returns the SAME reference
 *  when nothing changed, so callers can skip the corresponding `set()` key. */
function mapTagAcrossList(list: any[], idSet: Set<string>, apply: (t: string) => string): any[] {
  let changed = false;
  const out = list.map((e: any) => {
    if (!idSet.has(e.id)) return e;
    const cur = e.tags || '||';
    const nt = apply(cur);
    if (nt === cur) return e;
    changed = true;
    return { ...e, tags: nt };
  });
  return changed ? out : list;
}

/** Bulk tag flip across every sectionData section (one pass each), rebuilding
 *  that section's threads once. Returns null when nothing changed. */
function bulkUpdateTagsInSectionData(
  sectionData: Record<string, { emails: any[]; threads: any[]; offset: number; hasMore: boolean; total: number; loading: boolean }>,
  idSet: Set<string>,
  apply: (t: string) => string,
): typeof sectionData | null {
  let changed = false;
  const updated = { ...sectionData };
  for (const [sectionId, sd] of Object.entries(updated)) {
    const mapped = mapTagAcrossList(sd.emails, idSet, apply);
    if (mapped !== sd.emails) {
      updated[sectionId] = { ...sd, emails: mapped, threads: buildThreads(mapped) };
      changed = true;
    }
  }
  return changed ? updated : null;
}

/** Refresh backend-derived counts ONCE after a mail mutation (folders, category
 *  badges, and — for read-state changes — the per-account unread bells). The
 *  single source every action calls instead of hand-rolling the trio. */
function refreshMailCounts(get: any, opts: { unreadSummary?: boolean } = {}): void {
  get().loadFolders();
  get().refreshCategoryCounts();
  if (opts.unreadSummary) get().refreshUnreadSummary();
}

/**
 * THE shared optimistic "flip the read tag on a set of emails" primitive. It
 * applies the change across every state slice + sectionData in ONE `set()` and
 * returns whether anything actually changed. Single-email `markAsRead` and
 * `bulkMarkRead` BOTH route through this — the ONLY things that differ per
 * action are the id list and which background IPC persists it (a per-account
 * `markRead` for one row vs. one `bulkAction` for many). This is what makes a
 * "select all → mark read" one batched state update + one render instead of N.
 */
function applyOptimisticRead(get: any, set: any, ids: string[], read: boolean): boolean {
  const idSet = new Set(ids);
  const { emails, threadEmails, searchResults, sectionData } = get();
  const apply = (t: string) => (read ? addTag(t, 'read') : removeTag(t, 'read'));
  const updates: any = {};
  const ne = mapTagAcrossList(emails, idSet, apply); if (ne !== emails) updates.emails = ne;
  const nte = mapTagAcrossList(threadEmails, idSet, apply); if (nte !== threadEmails) updates.threadEmails = nte;
  const nse = mapTagAcrossList(searchResults, idSet, apply); if (nse !== searchResults) updates.searchResults = nse;
  const nsd = bulkUpdateTagsInSectionData(sectionData, idSet, apply); if (nsd) updates.sectionData = nsd;
  if (!read) updates.manuallyMarkedUnreadId = ids.length === 1 ? ids[0] : null;
  if (Object.keys(updates).length === 0) return false;
  set(updates);
  return true;
}

/**
 * Group email ids by their OWNING account (unified "All Inboxes" rows carry an
 * `accountId`), so a bulk action can be dispatched to each account's own DB and
 * IMAP engine. The `undefined` key means "the active account". MUST be resolved
 * BEFORE any optimistic state mutation — removal-style actions (delete/archive)
 * clear the rows from state, after which the account can no longer be resolved.
 *
 * Without this, bulk actions ran only against the active account's DB, so on a
 * multi-account unified view any row owned by another account was silently
 * skipped — e.g. "mark all read" never clearing another account's unread mail.
 */
function groupIdsByAccount(get: any, emailIds: string[]): Map<string | undefined, string[]> {
  const byAccount = new Map<string | undefined, string[]>();
  for (const id of emailIds) {
    const acct = get()._accountIdFor(id);
    const list = byAccount.get(acct) ?? [];
    list.push(id);
    byAccount.set(acct, list);
  }
  return byAccount;
}

/** Fire ONE bulkAction IPC per owning account (each routes to that account's
 *  storage + engine). Errors are per-group and non-fatal. */
async function dispatchBulkByAccount(grouped: Map<string | undefined, string[]>, action: string, allowPermanent = false): Promise<void> {
  await Promise.all(
    [...grouped.entries()].map(([acct, ids]) =>
      window.electronAPI.emails.bulkAction(ids, action, acct, allowPermanent).catch((err) => {
        console.warn('[Store] bulkAction failed for account', acct ?? '(active)', err);
      }),
    ),
  );
}

/**
 * Shared optimistic core for user Move/Copy to an arbitrary folder (single &
 * bulk). MOVE removes the rows from every view (they left this folder) and
 * reverts on a hard IPC failure; COPY leaves them in place. One IPC call — the
 * single-vs-bulk endpoint is chosen by count. Kept module-level so both the
 * toolbar (one id) and bulk-bar (many) go through identical logic.
 */
async function applyFolderPlacement(
  get: () => any,
  set: (patch: any) => void,
  ids: string[],
  destFolderId: string,
  mode: 'move' | 'copy',
): Promise<void> {
  if (ids.length === 0 || !destFolderId) return;
  const api = window.electronAPI.emails as any;
  const accountId = get()._accountIdFor(ids[0]);

  if (mode === 'copy') {
    // Copy keeps the originals visible — no optimistic removal. Persist, then
    // refresh so the destination folder's counts update.
    try {
      const res = ids.length === 1
        ? await api.copyToFolder(ids[0], destFolderId, accountId)
        : await api.bulkCopyToFolder(ids, destFolderId, accountId);
      if (!res?.success) { console.error('[Store] copyToFolder failed:', res?.error); return; }
      get().loadFolders();
    } catch (error) {
      console.error('[Store] Failed to copy to folder:', error);
    }
    return;
  }

  // MOVE — optimistically drop the rows from every view; snapshot for revert.
  const idSet = new Set(ids);
  const { emails, searchResults, threadEmails, sectionData } = get();
  const snapshot = {
    emails, searchResults, threadEmails, sectionData,
    selectedEmailId: get().selectedEmailId, highlightedEmailId: get().highlightedEmailId,
  };
  const wasSelected = idSet.has(get().selectedEmailId);
  const wasHighlighted = idSet.has(get().highlightedEmailId);
  const anchor = get().selectedEmailId || get().highlightedEmailId;
  const rawNext = (wasSelected || wasHighlighted) && anchor ? computeNextIdFromPool(get(), anchor) : null;
  // The computed next row might itself be in the moved set — don't land on a ghost.
  const nextId = rawNext && !idSet.has(rawNext) ? rawNext : null;

  const updates: any = {
    emails: emails.filter((e: any) => !idSet.has(e.id)),
    selectedEmailId: wasSelected ? nextId : get().selectedEmailId,
    highlightedEmailId: (wasSelected || wasHighlighted) ? nextId : get().highlightedEmailId,
    manuallyMarkedUnreadId: null,
  };
  if (searchResults.some((e: any) => idSet.has(e.id))) updates.searchResults = searchResults.filter((e: any) => !idSet.has(e.id));
  if (threadEmails.some((e: any) => idSet.has(e.id))) updates.threadEmails = threadEmails.filter((e: any) => !idSet.has(e.id));
  const updatedSD = removeEmailsFromSectionData(sectionData, idSet);
  if (updatedSD) updates.sectionData = updatedSD;
  set(updates);

  try {
    const res = ids.length === 1
      ? await api.moveToFolder(ids[0], destFolderId, accountId)
      : await api.bulkMoveToFolder(ids, destFolderId, accountId);
    if (!res?.success) {
      // Permanent failure (folder/email not found) — the handler didn't touch the
      // DB, so undo the optimistic removal instead of stranding a ghost.
      console.error('[Store] moveToFolder failed, reverting:', res?.error);
      set(snapshot);
      return;
    }
    get().loadFolders();
    get().refreshCategoryCounts();
  } catch (error) {
    console.error('[Store] Failed to move to folder, reverting:', error);
    set(snapshot);
  }
}

export const createEmailActionsSlice: SliceCreator<EmailActionsSlice> = (set, get) => ({
  // Resolve the owning account for an email id from current state — so actions
  // on unified "All Inboxes" rows (which can belong to a non-active account)
  // route to the right DB/engine. undefined for normal single-account views.
  _accountIdFor: (id: string): string | undefined => {
    const s = get();
    const e = s.emails.find((x) => x.id === id)
      || s.threadEmails.find((x) => x.id === id)
      || s.searchResults.find((x) => x.id === id);
    return e?.accountId ?? s.viewAccountId ?? undefined;
  },

  pendingDeletes: [],
  markAsRead: async (emailId, read) => {
    const { emails, threadEmails, searchResults } = get();
    const inState = emails.some((e) => e.id === emailId)
      || threadEmails.some((e) => e.id === emailId)
      || searchResults.some((e) => e.id === emailId);

    // Not in the loaded list (e.g. opened from search/notification) — no state
    // to flip, just persist via the per-account IPC.
    if (!inState) {
      try {
        await window.electronAPI.emails.markRead(emailId, read, get()._accountIdFor(emailId));
      } catch (error) {
        console.error('[Store] markAsRead API error:', error);
      }
      return;
    }

    // The row's owning account (unified "All Inboxes" rows can belong to a
    // non-active account) — kept for the single-row IPC below.
    const rowAccountId = get()._accountIdFor(emailId);

    // Optimistic flip via the SHARED primitive (same code bulkMarkRead uses).
    // Returns false when already in the target state → nothing to do.
    if (!applyOptimisticRead(get, set, [emailId], read)) return;

    setTimeout(async () => {
      try {
        const result = await window.electronAPI.emails.markRead(emailId, read, rowAccountId);
        if (result.success) {
          refreshMailCounts(get, { unreadSummary: true });
        } else {
          console.warn('[Store] markAsRead API failed, reverting:', result.error);
          applyOptimisticRead(get, set, [emailId], !read); // revert
        }
      } catch (error) {
        console.error('[Store] markAsRead network error, reverting:', error);
        applyOptimisticRead(get, set, [emailId], !read); // revert
      }
    }, 0);
  },

  bulkMarkRead: (emailIds, read) => {
    if (emailIds.length === 0) return;
    // Group by owning account BEFORE the optimistic flip so each account's rows
    // route to their own DB/engine (unified "All Inboxes" mixes accounts).
    const grouped = groupIdsByAccount(get, emailIds);
    // ONE batched state update across every slice (no per-email loop, no N
    // re-renders), then one bulk IPC PER account, counts refreshed ONCE.
    if (!applyOptimisticRead(get, set, emailIds, read)) return;
    (async () => {
      await dispatchBulkByAccount(grouped, read ? 'markRead' : 'markUnread');
      refreshMailCounts(get, { unreadSummary: true });
    })();
  },

  bulkMarkStarred: (emailIds, starred) => {
    if (emailIds.length === 0) return;
    const grouped = groupIdsByAccount(get, emailIds); // route per owning account
    const { emails, threadEmails, searchResults, sectionData, inboxSections } = get();
    // Reuse the existing star helpers (thread-aggregate aware) folded across the
    // selection, in ONE set() — then one fire-and-forget bulk IPC + counts once.
    const foldStar = (list: any[]) => emailIds.reduce((acc, id) => setStarAcrossThread(acc, id, starred) || acc, list);
    const updates: any = {};
    const ne = foldStar(emails); if (ne !== emails) updates.emails = ne;
    const nte = foldStar(threadEmails); if (nte !== threadEmails) updates.threadEmails = nte;
    const nse = foldStar(searchResults); if (nse !== searchResults) updates.searchResults = nse;
    let sd = sectionData;
    for (const id of emailIds) { const u = setStarInSectionData(sd, id, starred, inboxSections); if (u) sd = u; }
    if (sd !== sectionData) updates.sectionData = sd;
    if (Object.keys(updates).length === 0) return;
    set(updates);
    (async () => {
      await dispatchBulkByAccount(grouped, starred ? 'star' : 'unstar');
      refreshMailCounts(get, {});
    })();
  },

  markAsStarred: async (emailId, starred) => {
    console.log('[Store] markAsStarred called:', emailId, 'starred:', starred);
    const { emails, threadEmails, searchResults, folders } = get();

    const emailIndex = emails.findIndex((e) => e.id === emailId);
    const threadIndex = threadEmails.findIndex((e) => e.id === emailId);
    const searchIndex = searchResults.findIndex((e) => e.id === emailId);

    let originalTags = '||';
    if (emailIndex !== -1) {
      originalTags = emails[emailIndex].tags || '||';
    } else if (threadIndex !== -1) {
      originalTags = threadEmails[threadIndex].tags || '||';
    } else if (searchIndex !== -1) {
      originalTags = searchResults[searchIndex].tags || '||';
    } else {
      console.log('[Store] markAsStarred: email not in local state, calling API directly');
      try {
        await window.electronAPI.emails.markStarred(emailId, starred, get()._accountIdFor(emailId));
        get().loadFolders();
      } catch (error) {
        console.error('[Store] markAsStarred API error:', error);
      }
      return;
    }

    // The star icon reflects the THREAD aggregate (threadIsStarred), not
    // just this email — Gmail keeps the star on the [Gmail]/Starred copy, a
    // DIFFERENT record than the INBOX one the user clicks. Toggle against
    // what the user actually sees; otherwise unstar silently no-ops because
    // the clicked email isn't itself the starred copy (the reported bug).
    const rec = emailIndex !== -1 ? emails[emailIndex]
      : threadIndex !== -1 ? threadEmails[threadIndex]
        : searchResults[searchIndex];
    const threadId = rec?.threadId;
    const inThread = (e: any) => !!threadId && e.threadId === threadId;
    const copyStarred = (e: any) => (e.id === emailId || inThread(e)) && hasTag(e.tags, 'starred');
    const effectivelyStarred = hasTag(originalTags, 'starred')
      || (rec as any)?.threadIsStarred === true
      || emails.some(copyStarred) || threadEmails.some(copyStarred) || searchResults.some(copyStarred);
    if (effectivelyStarred === starred) {
      console.log('[Store] markAsStarred: thread already in target state, skipping');
      return;
    }

    // IMAP targets: starring → the clicked email; unstarring → every loaded
    // copy in the thread carrying the star, plus the clicked email (on Gmail
    // unflagging its UID clears the star globally). Each goes through the
    // main-process operation queue (persisted + retried).
    const targetIds = new Set<string>([emailId]);
    if (!starred) {
      for (const list of [emails, threadEmails, searchResults]) {
        for (const e of list) if (copyStarred(e)) targetIds.add(e.id);
      }
    }
    console.log('[Store] markAsStarred: thread', threadId, starred ? 'star' : 'unstar', '→ imap targets', Array.from(targetIds));

    // Snapshot for an exact revert if the IMAP op(s) fail.
    const snapshot = { emails, threadEmails, searchResults, folders, sectionData: get().sectionData };

    const updates: any = {};
    const newEmails = setStarAcrossThread(emails, emailId, starred);
    if (newEmails) updates.emails = newEmails;
    const newThreadEmails = setStarAcrossThread(threadEmails, emailId, starred);
    if (newThreadEmails) updates.threadEmails = newThreadEmails;
    const newSearchResults = setStarAcrossThread(searchResults, emailId, starred);
    if (newSearchResults) updates.searchResults = newSearchResults;

    const starredFolderIndex = folders.findIndex(f =>
      f.path.toLowerCase().includes('starred') || f.path.includes('[Gmail]/Starred')
    );
    if (starredFolderIndex !== -1) {
      const newFolders = [...folders];
      const currentTotal = newFolders[starredFolderIndex].totalCount || 0;
      newFolders[starredFolderIndex] = {
        ...newFolders[starredFolderIndex],
        totalCount: starred ? currentTotal + 1 : Math.max(0, currentTotal - 1)
      };
      updates.folders = newFolders;
    }

    const updatedSectionData = setStarInSectionData(get().sectionData, emailId, starred, get().inboxSections);
    if (updatedSectionData) updates.sectionData = updatedSectionData;

    set(updates);
    console.log('[Store] markAsStarred: UI updated IMMEDIATELY (before API call)');

    setTimeout(async () => {
      try {
        // Queue the flag change for every target through IMAP.
        const results = await Promise.all(
          Array.from(targetIds).map(id => window.electronAPI.emails.markStarred(id, starred, get()._accountIdFor(id))),
        );
        if (results.some(r => !r.success)) {
          console.warn('[Store] markAsStarred: an IMAP op failed, reverting');
          set(snapshot);
        }
      } catch (error) {
        console.error('[Store] markAsStarred network error, reverting:', error);
        set(snapshot);
      }
    }, 0);
  },

  markImportant: async (emailId, important) => {
    console.log('[Store] markImportant called:', emailId, 'important:', important);
    const { emails, threadEmails, searchResults } = get();

    const emailIndex = emails.findIndex((e) => e.id === emailId);
    const threadIndex = threadEmails.findIndex((e) => e.id === emailId);
    const searchIndex = searchResults.findIndex((e) => e.id === emailId);

    let originalTags = '||';
    if (emailIndex !== -1) {
      originalTags = emails[emailIndex].tags || '||';
    } else if (threadIndex !== -1) {
      originalTags = threadEmails[threadIndex].tags || '||';
    } else if (searchIndex !== -1) {
      originalTags = searchResults[searchIndex].tags || '||';
    } else {
      try {
        await window.electronAPI.emails.markImportant(emailId, important);
      } catch (error) {
        console.error('[Store] markImportant API error:', error);
      }
      return;
    }

    const wasImportant = hasTag(originalTags, 'important');
    if (wasImportant === important) return;

    const newTags = important ? addTag(originalTags, 'important') : removeTag(originalTags, 'important');

    const updates: any = {};

    const newEmails = patchTagsWithThreadAggregate(emails, emailId, newTags, 'threadIsImportant', 'important');
    if (newEmails) updates.emails = newEmails;

    const newThreadEmails = patchTagsWithThreadAggregate(threadEmails, emailId, newTags, 'threadIsImportant', 'important');
    if (newThreadEmails) updates.threadEmails = newThreadEmails;

    const newSearchResults = patchTagsWithThreadAggregate(searchResults, emailId, newTags, 'threadIsImportant', 'important');
    if (newSearchResults) updates.searchResults = newSearchResults;

    // Also update sectionData so section UI reflects the change
    const updatedSectionData = updateEmailInSectionData(get().sectionData, emailId, newTags, 'threadIsImportant', 'important');
    if (updatedSectionData) updates.sectionData = updatedSectionData;

    set(updates);

    setTimeout(async () => {
      try {
        const result = await window.electronAPI.emails.markImportant(emailId, important);
        if (result.success) {
          // 'important' is one of the AI categories → refresh its badge count.
          get().refreshCategoryCounts();
        } else {
          console.warn('[Store] markImportant API failed, reverting:', result.error);
          const state = get();
          const revertUpdates: any = {};

          const revertedEmails = patchTagsWithThreadAggregate(state.emails, emailId, originalTags, 'threadIsImportant', 'important');
          if (revertedEmails) revertUpdates.emails = revertedEmails;

          const revertedThreads = patchTagsWithThreadAggregate(state.threadEmails, emailId, originalTags, 'threadIsImportant', 'important');
          if (revertedThreads) revertUpdates.threadEmails = revertedThreads;

          const revertedSearch = patchTagsWithThreadAggregate(state.searchResults, emailId, originalTags, 'threadIsImportant', 'important');
          if (revertedSearch) revertUpdates.searchResults = revertedSearch;

          const revertedSD = updateEmailInSectionData(state.sectionData, emailId, originalTags, 'threadIsImportant', 'important');
          if (revertedSD) revertUpdates.sectionData = revertedSD;

          set(revertUpdates);
        }
      } catch (error) {
        console.error('[Store] markImportant network error:', error);
      }
    }, 0);
  },

  // Per-MESSAGE star, for the chat/bubble view where each bubble is one email.
  // (markAsStarred is thread-aggregate — right for the list row, but in a
  // per-bubble UI it no-ops when a sibling is already starred and unstars the
  // whole thread. This stars exactly the clicked message and recomputes the
  // thread aggregate from the loaded copies so the list icon stays correct.)
  markMessageStarred: async (emailId, starred) => {
    const { emails, threadEmails, searchResults } = get();
    const emailIndex = emails.findIndex((e) => e.id === emailId);
    const threadIndex = threadEmails.findIndex((e) => e.id === emailId);
    const searchIndex = searchResults.findIndex((e) => e.id === emailId);

    let originalTags = '||';
    if (emailIndex !== -1) originalTags = emails[emailIndex].tags || '||';
    else if (threadIndex !== -1) originalTags = threadEmails[threadIndex].tags || '||';
    else if (searchIndex !== -1) originalTags = searchResults[searchIndex].tags || '||';
    else {
      try { await window.electronAPI.emails.markStarred(emailId, starred, get()._accountIdFor(emailId)); get().loadFolders(); }
      catch (error) { console.error('[Store] markMessageStarred API error:', error); }
      return;
    }

    if (hasTag(originalTags, 'starred') === starred) return;
    const newTags = starred ? addTag(originalTags, 'starred') : removeTag(originalTags, 'starred');

    const updates: any = {};
    const newEmails = patchTagsWithThreadAggregate(emails, emailId, newTags, 'threadIsStarred', 'starred');
    if (newEmails) updates.emails = newEmails;
    const newThreadEmails = patchTagsWithThreadAggregate(threadEmails, emailId, newTags, 'threadIsStarred', 'starred');
    if (newThreadEmails) updates.threadEmails = newThreadEmails;
    const newSearchResults = patchTagsWithThreadAggregate(searchResults, emailId, newTags, 'threadIsStarred', 'starred');
    if (newSearchResults) updates.searchResults = newSearchResults;
    const updatedSectionData = updateEmailInSectionData(get().sectionData, emailId, newTags, 'threadIsStarred', 'starred');
    if (updatedSectionData) updates.sectionData = updatedSectionData;

    set(updates);

    setTimeout(async () => {
      try {
        const result = await window.electronAPI.emails.markStarred(emailId, starred, get()._accountIdFor(emailId));
        if (!result.success) {
          console.warn('[Store] markMessageStarred API failed, reverting:', result.error);
          const state = get();
          const revertUpdates: any = {};
          const re = patchTagsWithThreadAggregate(state.emails, emailId, originalTags, 'threadIsStarred', 'starred');
          if (re) revertUpdates.emails = re;
          const rt = patchTagsWithThreadAggregate(state.threadEmails, emailId, originalTags, 'threadIsStarred', 'starred');
          if (rt) revertUpdates.threadEmails = rt;
          const rs = patchTagsWithThreadAggregate(state.searchResults, emailId, originalTags, 'threadIsStarred', 'starred');
          if (rs) revertUpdates.searchResults = rs;
          const rsd = updateEmailInSectionData(state.sectionData, emailId, originalTags, 'threadIsStarred', 'starred');
          if (rsd) revertUpdates.sectionData = rsd;
          set(revertUpdates);
        }
      } catch (error) {
        console.error('[Store] markMessageStarred network error:', error);
      }
    }, 0);
  },

  snoozeEmail: async (emailId, snoozeUntil) => {
    console.log('[Store] snoozeEmail called:', emailId, 'until:', snoozeUntil);
    const { emails, selectedEmailId } = get();

    const emailIndex = emails.findIndex((e) => e.id === emailId);

    const newEmails = emails.filter((e) => e.id !== emailId);

    let nextEmailId: string | null = selectedEmailId;
    if (selectedEmailId === emailId && newEmails.length > 0) {
      if (emailIndex < newEmails.length) {
        nextEmailId = newEmails[emailIndex].id;
      } else if (emailIndex > 0) {
        nextEmailId = newEmails[emailIndex - 1].id;
      } else {
        nextEmailId = null;
      }
    } else if (selectedEmailId === emailId) {
      nextEmailId = null;
    }

    const snoozeUpdates: any = {
      emails: newEmails,
      selectedEmailId: nextEmailId,
      threadEmails: nextEmailId ? get().threadEmails : [],
    };

    // Also remove from sectionData so the sectioned inbox updates immediately
    // (removeEmailsFromSectionData rebuilds threads and decrements totals)
    const updatedSnoozeSD = removeEmailsFromSectionData(get().sectionData, new Set([emailId]));
    if (updatedSnoozeSD) snoozeUpdates.sectionData = updatedSnoozeSD;

    set(snoozeUpdates);

    if (nextEmailId && nextEmailId !== selectedEmailId) {
      const nextEmail = newEmails.find((e) => e.id === nextEmailId);
      if (nextEmail?.threadId) {
        get().loadThread(nextEmail.threadId);
      }
    }

    console.log('[Store] snoozeEmail: UI updated IMMEDIATELY');

    try {
      const result = await window.electronAPI.snooze.set(emailId, snoozeUntil);
      if (!result.success) {
        console.warn('[Store] snoozeEmail API failed:', result.error);
      }
      get().loadFolders();
    } catch (error) {
      console.error('[Store] snoozeEmail error:', error);
    }
  },

  unsnoozeEmail: async (emailId) => {
    console.log('[Store] unsnoozeEmail called:', emailId);
    const { emails, threadEmails, searchResults } = get();

    const emailIndex = emails.findIndex((e) => e.id === emailId);
    const threadIndex = threadEmails.findIndex((e) => e.id === emailId);
    const searchIndex = searchResults.findIndex((e) => e.id === emailId);

    // Helper to remove |snoozed| tag from tags string
    const removeSnoozedTag = (tags: string): string => {
      const tagList = (tags || '||').split('|').filter(t => t.length > 0 && t !== 'snoozed');
      return tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||';
    };

    const updates: any = {};

    if (emailIndex !== -1) {
      const newEmails = [...emails];
      newEmails[emailIndex] = { ...newEmails[emailIndex], tags: removeSnoozedTag(newEmails[emailIndex].tags) };
      updates.emails = newEmails;
    }

    if (threadIndex !== -1) {
      const newThreadEmails = [...threadEmails];
      newThreadEmails[threadIndex] = { ...newThreadEmails[threadIndex], tags: removeSnoozedTag(newThreadEmails[threadIndex].tags) };
      updates.threadEmails = newThreadEmails;
    }

    if (searchIndex !== -1) {
      const newSearchResults = [...searchResults];
      newSearchResults[searchIndex] = { ...newSearchResults[searchIndex], tags: removeSnoozedTag(newSearchResults[searchIndex].tags) };
      updates.searchResults = newSearchResults;
    }

    set(updates);
    console.log('[Store] unsnoozeEmail: UI updated IMMEDIATELY');

    try {
      const result = await window.electronAPI.snooze.remove(emailId);
      if (!result.success) {
        console.warn('[Store] unsnoozeEmail API failed:', result.error);
      }
    } catch (error) {
      console.error('[Store] unsnoozeEmail error:', error);
    }
  },

  deleteEmail: async (emailId) => {
    try {
      const emails = get().emails;
      const { searchResults, threadEmails, sectionData } = get();
      const wasSelected = get().selectedEmailId === emailId;
      const wasHighlighted = get().highlightedEmailId === emailId;

      // Save the email snapshot for undo
      const emailSnapshot = emails.find((e) => e.id === emailId);

      // Resolve permanent-vs-move up front via the SHARED helper so this
      // (open-mail) path and the bulk path agree, then guard the irreversible
      // case with the SAME confirm before touching any state. Move-to-trash is
      // recoverable (5s undo below), so only a permanent purge prompts.
      const { folders, selectedFolderId } = get();
      const inTrash = isInTrashContext(emailSnapshot?.tags, folders, selectedFolderId);
      if (inTrash) {
        const ok = await requestConfirm(destructiveConfirmOptions('delete', 1, true));
        if (!ok) return;
      }

      const newEmails = emails.filter((e) => e.id !== emailId);

      // If the deleted message belongs to the OPEN thread and siblings remain
      // (e.g. deleting one bubble in the chat view), keep the thread open by
      // pointing at a sibling instead of jumping to a different thread.
      const remainingSiblings = threadEmails.filter((e) => e.id !== emailId);
      const stayInThread = threadEmails.some((e) => e.id === emailId) && remainingSiblings.length > 0;
      const nextId = (wasSelected || wasHighlighted)
        ? (stayInThread ? remainingSiblings[remainingSiblings.length - 1].id : computeNextIdFromPool(get(), emailId))
        : null;

      const updates: any = {
        emails: newEmails,
        selectedEmailId: wasSelected ? nextId : get().selectedEmailId,
        highlightedEmailId: (wasHighlighted || wasSelected) ? nextId : get().highlightedEmailId,
        manuallyMarkedUnreadId: null,
      };

      // Also remove from searchResults, threadEmails, and sectionData so UI updates immediately
      if (searchResults.some(e => e.id === emailId)) {
        updates.searchResults = searchResults.filter(e => e.id !== emailId);
      }
      if (threadEmails.some(e => e.id === emailId)) {
        updates.threadEmails = threadEmails.filter(e => e.id !== emailId);
      }
      const updatedSD = removeEmailsFromSectionData(sectionData, new Set([emailId]));
      if (updatedSD) updates.sectionData = updatedSD;

      // Set up pending delete with 5s timer (stacked — each manages its own timeout)
      const timeoutId = window.setTimeout(() => {
        get().commitDelete(emailId);
      }, 5000);

      if (emailSnapshot) {
        const newEntry: import('../types').PendingDelete = {
          emailId,
          email: emailSnapshot,
          folderId: selectedFolderId,
          timeoutId,
          inTrash,
        };
        updates.pendingDeletes = [...get().pendingDeletes, newEntry];
      }

      set(updates);

      // Only re-load a thread when we actually jumped to a DIFFERENT one. When
      // staying in the open thread (sibling remains), the sibling is already
      // rendered in threadEmails — reloading would flicker.
      if (wasSelected && nextId && !stayInThread) {
        const nextEmail = newEmails.find((e) => e.id === nextId)
          || get().searchResults.find((e) => e.id === nextId);
        if (nextEmail?.threadId) {
          get().loadThread(nextEmail.threadId);
        }
      }

      // If no snapshot (couldn't find email), execute immediately
      if (!emailSnapshot) {
        clearTimeout(timeoutId);
        const result = inTrash
          ? await window.electronAPI.emails.delete(emailId, get()._accountIdFor(emailId))
          : await window.electronAPI.emails.moveToTrash(emailId, get()._accountIdFor(emailId));
        if (!result.success) {
          console.warn(`[Store] deleteEmail failed:`, result.error);
        }
        get().loadFolders();
      }
    } catch (error) {
      console.error('[Store] Failed to delete email:', error);
    }
  },

  archiveEmail: async (emailId) => {
    try {
      const emails = get().emails;
      const wasSelected = get().selectedEmailId === emailId;
      const wasHighlighted = get().highlightedEmailId === emailId;

      const newEmails = emails.filter((e) => e.id !== emailId);

      // Auto-advance to next email within the visible pool (search results, filtered view, etc.)
      const nextId = (wasSelected || wasHighlighted) ? computeNextIdFromPool(get(), emailId) : null;

      const updates: any = {
        emails: newEmails,
        selectedEmailId: wasSelected ? nextId : get().selectedEmailId,
        highlightedEmailId: (wasHighlighted || wasSelected) ? nextId : get().highlightedEmailId,
        manuallyMarkedUnreadId: null,
      };

      const { searchResults, threadEmails, sectionData: archiveSD } = get();
      const archiveSnapshot = { emails, searchResults, threadEmails, sectionData: archiveSD, selectedEmailId: get().selectedEmailId, highlightedEmailId: get().highlightedEmailId };
      if (searchResults.some(e => e.id === emailId)) {
        updates.searchResults = searchResults.filter(e => e.id !== emailId);
      }
      if (threadEmails.some(e => e.id === emailId)) {
        updates.threadEmails = threadEmails.filter(e => e.id !== emailId);
      }
      const updatedArchiveSD = removeEmailsFromSectionData(archiveSD, new Set([emailId]));
      if (updatedArchiveSD) updates.sectionData = updatedArchiveSD;

      set(updates);

      if (wasSelected && nextId) {
        const nextEmail = newEmails.find((e) => e.id === nextId)
          || get().searchResults.find((e) => e.id === nextId);
        if (nextEmail?.threadId) {
          get().loadThread(nextEmail.threadId);
        }
      }

      const result = await window.electronAPI.emails.archive(emailId, get()._accountIdFor(emailId));
      if (!result.success) {
        // Permanent failure (folder/email not found) — the handler didn't touch
        // the DB, so undo the optimistic removal instead of leaving a ghost.
        console.error('[Store] archiveEmail failed, reverting:', result.error);
        set(archiveSnapshot);
        return;
      }

      get().loadFolders();
      // Email left the inbox → refresh unread-per-category badges.
      get().refreshCategoryCounts();
    } catch (error) {
      console.error('[Store] Failed to archive email:', error);
    }
  },

  // ── User Move / Copy to an arbitrary folder ────────────────────────────────
  // MOVE optimistically removes the message(s) from the current view (they've
  // left this folder); COPY leaves them in place (they now live in both). Both
  // persist server-side via the operation queue, so an offline action replays on
  // reconnect. `ids` covers single (toolbar) and bulk (selection) callers.
  moveEmailToFolder: async (emailId, destFolderId) => { await applyFolderPlacement(get, set, [emailId], destFolderId, 'move'); },
  copyEmailToFolder: async (emailId, destFolderId) => { await applyFolderPlacement(get, set, [emailId], destFolderId, 'copy'); },
  bulkMoveToFolder: async (emailIds, destFolderId) => { await applyFolderPlacement(get, set, emailIds, destFolderId, 'move'); },
  bulkCopyToFolder: async (emailIds, destFolderId) => { await applyFolderPlacement(get, set, emailIds, destFolderId, 'copy'); },

  moveFromSpam: async (emailId) => {
    try {
      const emails = get().emails;
      const wasSelected = get().selectedEmailId === emailId;
      const wasHighlighted = get().highlightedEmailId === emailId;

      const newEmails = emails.filter((e) => e.id !== emailId);

      // Auto-advance to next email within the visible pool (search results, filtered view, etc.)
      const nextId = (wasSelected || wasHighlighted) ? computeNextIdFromPool(get(), emailId) : null;

      const updates: any = {
        emails: newEmails,
        selectedEmailId: wasSelected ? nextId : get().selectedEmailId,
        highlightedEmailId: (wasHighlighted || wasSelected) ? nextId : get().highlightedEmailId,
        manuallyMarkedUnreadId: null,
      };

      const { searchResults, threadEmails, sectionData: fromSpamSD } = get();
      const fromSpamSnapshot = { emails, searchResults, threadEmails, sectionData: fromSpamSD, selectedEmailId: get().selectedEmailId, highlightedEmailId: get().highlightedEmailId };
      if (searchResults.some(e => e.id === emailId)) {
        updates.searchResults = searchResults.filter(e => e.id !== emailId);
      }
      if (threadEmails.some(e => e.id === emailId)) {
        updates.threadEmails = threadEmails.filter(e => e.id !== emailId);
      }
      const updatedFromSpamSD = removeEmailsFromSectionData(fromSpamSD, new Set([emailId]));
      if (updatedFromSpamSD) updates.sectionData = updatedFromSpamSD;

      set(updates);

      if (wasSelected && nextId) {
        const nextEmail = newEmails.find((e) => e.id === nextId)
          || get().searchResults.find((e) => e.id === nextId);
        if (nextEmail?.threadId) {
          get().loadThread(nextEmail.threadId);
        }
      }

      const result = await window.electronAPI.emails.moveFromSpam(emailId, get()._accountIdFor(emailId));
      if (!result.success) {
        console.error('[Store] moveFromSpam failed, reverting:', result.error);
        set(fromSpamSnapshot);
        return;
      }

      get().loadFolders();
      // Email returned to the inbox → refresh unread-per-category badges.
      get().refreshCategoryCounts();
    } catch (error) {
      console.error('[Store] Failed to move email from spam:', error);
    }
  },

  moveToSpam: async (emailId) => {
    try {
      const emails = get().emails;
      const wasSelected = get().selectedEmailId === emailId;
      const wasHighlighted = get().highlightedEmailId === emailId;

      const newEmails = emails.filter((e) => e.id !== emailId);

      // Auto-advance to next email within the visible pool (search results, filtered view, etc.)
      const nextId = (wasSelected || wasHighlighted) ? computeNextIdFromPool(get(), emailId) : null;

      const updates: any = {
        emails: newEmails,
        selectedEmailId: wasSelected ? nextId : get().selectedEmailId,
        highlightedEmailId: (wasHighlighted || wasSelected) ? nextId : get().highlightedEmailId,
        manuallyMarkedUnreadId: null,
      };

      const { searchResults, threadEmails, sectionData: spamSD } = get();
      const toSpamSnapshot = { emails, searchResults, threadEmails, sectionData: spamSD, selectedEmailId: get().selectedEmailId, highlightedEmailId: get().highlightedEmailId };
      if (searchResults.some(e => e.id === emailId)) {
        updates.searchResults = searchResults.filter(e => e.id !== emailId);
      }
      if (threadEmails.some(e => e.id === emailId)) {
        updates.threadEmails = threadEmails.filter(e => e.id !== emailId);
      }
      const updatedSpamSD = removeEmailsFromSectionData(spamSD, new Set([emailId]));
      if (updatedSpamSD) updates.sectionData = updatedSpamSD;

      set(updates);

      if (wasSelected && nextId) {
        const nextEmail = newEmails.find((e) => e.id === nextId)
          || get().searchResults.find((e) => e.id === nextId);
        if (nextEmail?.threadId) {
          get().loadThread(nextEmail.threadId);
        }
      }

      const result = await window.electronAPI.emails.moveToSpam(emailId, get()._accountIdFor(emailId));
      if (!result.success) {
        console.error('[Store] moveToSpam failed, reverting:', result.error);
        set(toSpamSnapshot);
        return;
      }

      get().loadFolders();
      // Email left the inbox (now spam) → refresh unread-per-category badges.
      get().refreshCategoryCounts();
    } catch (error) {
      console.error('[Store] Failed to move email to spam:', error);
    }
  },

  bulkRemoveEmails: async (emailIds, action) => {
    if (emailIds.length === 0) return;

    // Determine permanent-delete vs move BEFORE mutating anything, so we can
    // guard first. `delete` is an irreversible expunge ONLY for mail that truly
    // lives in Trash; elsewhere it's a recoverable move to Trash.
    const { folders: guardFolders, selectedFolderId: guardFolderId } = get();
    // Decide from each selected row's OWN tags, not just the current view: a
    // search / unified "All Inboxes" / section view can surface Trash-resident
    // rows while the view itself is not Trash. The old view-only check let those
    // be expunged with NO "Delete forever" confirm (silent unrecoverable loss).
    const viewIsTrash = isInTrashContext(undefined, guardFolders, guardFolderId);
    const anyRowInTrash = action === 'delete' && emailIds.some((id) => {
      const row = resolveRowById(get, id);
      return row ? isInTrashContext(row.tags, guardFolders, guardFolderId) : false;
    });
    const permanent = action === 'delete' && (viewIsTrash || anyRowInTrash);

    // Guardrail: irreversible or large destructive bulk actions confirm first, so
    // an accidental select-all can't silently nuke a whole folder. A permanent
    // delete ALWAYS confirms. `notspam` is benign recovery and is never gated.
    const needsConfirm = permanent || (emailIds.length >= BULK_CONFIRM_THRESHOLD && action !== 'notspam');
    if (needsConfirm) {
      const ok = await requestConfirm(destructiveConfirmOptions(action, emailIds.length, permanent));
      if (!ok) return;
    }

    const idSet = new Set(emailIds);
    // Group by owning account NOW, while the rows are still in state — the
    // removal below clears them, after which the account can't be resolved.
    const grouped = groupIdsByAccount(get, emailIds);
    // Re-read state AFTER the (possibly awaited) confirm — it may have changed.
    const { emails, searchResults, threadEmails, selectedEmailId, sectionData: bulkSD } = get();

    // 1. Instantly remove all from UI state in one batch
    const newEmails = emails.filter(e => !idSet.has(e.id));
    const updates: any = {
      emails: newEmails,
      searchResults: searchResults.filter(e => !idSet.has(e.id)),
      threadEmails: threadEmails.filter(e => !idSet.has(e.id)),
      manuallyMarkedUnreadId: null,
    };

    // Also remove from sectionData for section-based views
    const updatedBulkSD = removeEmailsFromSectionData(bulkSD, idSet);
    if (updatedBulkSD) updates.sectionData = updatedBulkSD;

    // Auto-advance if selected/highlighted email is being removed
    if (selectedEmailId && idSet.has(selectedEmailId)) {
      updates.selectedEmailId = null;
    }
    const highlightedEmailId = get().highlightedEmailId;
    if (highlightedEmailId && idSet.has(highlightedEmailId)) {
      updates.highlightedEmailId = null;
    }

    set(updates);

    // 2. Single bulk backend call — fire-and-forget. `allowPermanent` gates the
    // server-side EXPUNGE: the main process permanently deletes ONLY when this
    // renderer confirmed it (permanent === true). Without the flag it moves to
    // Trash, so a Trash row we failed to detect can never be silently expunged.
    (async () => {
      await dispatchBulkByAccount(grouped, action, permanent);
      get().loadFolders();
      // Emails left the inbox → refresh unread-per-category badges.
      get().refreshCategoryCounts();
      // Category view: the optimistic splice above removed the deleted rows but
      // never pulled the following page, so deleting the whole visible page left
      // an empty list AND hid the footer paginator (it renders only with rows) —
      // unrecoverable. Reload the current page from the DB so the next page's rows
      // slide up; invalidate the total first so the "of N" refetches, and clamp a
      // now-past-the-end page back to the first page.
      const cat = get().viewingAICategory;
      if (cat) {
        set({ emailsTotal: 0 });
        await get().goToEmailPage(get().emailsPage);
        if (get().emails.length === 0 && get().emailsPage > 0) {
          await get().goToEmailPage(0);
        }
      }
    })();
  },

  undoDelete: (emailId?: string) => {
    const { pendingDeletes } = get();
    if (pendingDeletes.length === 0) return;

    // If no emailId specified, undo the most recent (last in array)
    const targetId = emailId || pendingDeletes[pendingDeletes.length - 1].emailId;
    const pending = pendingDeletes.find(p => p.emailId === targetId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);

    // Restore email to the emails array at its original position
    const { emails, searchQuery, searchResults } = get();
    const restoredEmails = [...emails, pending.email].sort((a, b) => b.date - a.date);

    const restoreUpdates: any = {
      pendingDeletes: pendingDeletes.filter(p => p.emailId !== targetId),
      emails: restoredEmails,
    };

    // deleteEmail also removed it from searchResults — restore there if a search is active
    if (searchQuery && !searchResults.some(e => e.id === pending.emailId)) {
      restoreUpdates.searchResults = [...searchResults, pending.email].sort((a, b) => b.date - a.date);
    }

    set(restoreUpdates);

    // Sectioned inbox renders from sectionData — reload sections so the row
    // reappears (the email is still in the DB; the delete was never committed)
    if (Object.keys(get().sectionData).length > 0) {
      const { selectedFolderId, folders } = get();
      const folderPath = selectedFolderId ? folders.find(f => f.id === selectedFolderId)?.path : undefined;
      get().loadAllSections(folderPath).catch(() => {});
    }

    // Re-open the restored email
    get().selectEmail(pending.emailId);

    console.log('[Store] undoDelete: restored email', pending.emailId);
  },

  commitDelete: async (emailId: string) => {
    const { pendingDeletes } = get();
    const pending = pendingDeletes.find(p => p.emailId === emailId);
    if (!pending) return;

    set({ pendingDeletes: pendingDeletes.filter(p => p.emailId !== emailId) });

    const result = pending.inTrash
      ? await window.electronAPI.emails.delete(emailId, get()._accountIdFor(emailId))
      : await window.electronAPI.emails.moveToTrash(emailId, get()._accountIdFor(emailId));
    if (!result.success) {
      console.warn(`[Store] commitDelete ${pending.inTrash ? 'permanent delete' : 'move to trash'} failed:`, result.error);
    }
    get().loadFolders();
    // DB row removed/trashed → refresh unread-per-category badges.
    get().refreshCategoryCounts();
  },

  clearSelectedEmail: () => {
    set({ selectedEmailId: null, threadEmails: [], manuallyMarkedUnreadId: null });
  },

  // Remove a discarded draft from EVERY loaded view (flat list, search results,
  // open thread, and the AI-categorized section data) so it disappears
  // immediately from whatever view is showing — a plain list refresh misses
  // section/category views. Reuses the same section-data rebuild as delete.
  removeDraftFromViews: (emailId: string) => {
    const { emails, searchResults, threadEmails, sectionData } = get();
    const updatedSD = removeEmailsFromSectionData(sectionData, new Set([emailId]));
    set({
      emails: emails.filter((e) => e.id !== emailId),
      searchResults: searchResults.filter((e) => e.id !== emailId),
      threadEmails: threadEmails.filter((e) => e.id !== emailId),
      ...(updatedSD ? { sectionData: updatedSD } : {}),
    });
  },

  // Optimistic draft discard: remove the draft from every view NOW (instant UX),
  // fire the delete on the server/DB in the background, and put the draft back if
  // the delete fails. Keyed by the draft's unique message-id. This is the draft
  // instance of the app-wide "act instantly, reconcile in the background" model.
  discardDraft: async (messageId: string, threadId?: string, accountId?: string) => {
    const isDraftRow = (e: any) => {
      const t = e?.tags || '';
      return t.includes('|draft|') || t.includes('|Drafts|') || t.includes('|[Gmail]/Drafts|');
    };
    // Snapshot every view BEFORE removal so a failed server delete can restore
    // them all (not just the flat list).
    const before = {
      emails: get().emails,
      searchResults: get().searchResults,
      threadEmails: get().threadEmails,
      sectionData: get().sectionData,
    };
    const single =
      before.emails.find((e) => (e as any).messageId === messageId) ||
      before.threadEmails.find((e) => (e as any).messageId === messageId) ||
      before.searchResults.find((e) => (e as any).messageId === messageId);
    const acct = accountId ?? (single as any)?.accountId ?? get().viewAccountId ?? undefined;

    // Discard clears the WHOLE thread's drafts (matches the thread-wide DB/IMAP
    // delete) — so accumulated/racing dupes all vanish at once, not one per click.
    // Scan every view (incl. searchResults) so nothing is left behind.
    const removedIds = new Set<string>();
    if (threadId) {
      for (const e of [...before.emails, ...before.threadEmails, ...before.searchResults]) {
        if ((e as any).threadId === threadId && isDraftRow(e)) removedIds.add(e.id);
      }
    }
    if (single) removedIds.add(single.id);

    (window.electronAPI as any).drafts?.debug?.('store.discardDraft', {
      messageId, threadId, passedAccountId: accountId, resolvedAcct: acct,
      snapshotFound: !!single, removedCount: removedIds.size,
    });

    // Optimistic: drop every removed row from all views at once.
    if (removedIds.size > 0) {
      const sd = removeEmailsFromSectionData(before.sectionData, removedIds);
      set({
        emails: before.emails.filter((e) => !removedIds.has(e.id)),
        searchResults: before.searchResults.filter((e) => !removedIds.has(e.id)),
        threadEmails: before.threadEmails.filter((e) => !removedIds.has(e.id)),
        ...(sd ? { sectionData: sd } : {}),
      });
    }

    try {
      const res: any = await window.electronAPI.drafts.delete({ messageId, threadId, accountId: acct });
      if (res && res.success === false) throw new Error(res.error || 'draft delete failed');
    } catch (err) {
      console.error('[Drafts] discard failed — restoring draft(s)', err);
      // Rollback: re-insert the removed rows into each view they came from
      // (preserving any rows that arrived meanwhile), and restore section data.
      if (removedIds.size > 0) {
        const restore = (cur: any[], orig: any[]) => {
          const curIds = new Set(cur.map((e) => e.id));
          const back = orig.filter((e) => removedIds.has(e.id) && !curIds.has(e.id));
          return back.length ? [...back, ...cur] : cur;
        };
        set({
          emails: restore(get().emails, before.emails),
          searchResults: restore(get().searchResults, before.searchResults),
          threadEmails: restore(get().threadEmails, before.threadEmails),
          sectionData: before.sectionData,
        });
      }
    }
  },
});
