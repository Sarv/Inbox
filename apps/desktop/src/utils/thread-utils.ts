import type { EmailRecord, ViewFilter } from '@sarvinbox/core';

import type { InboxSection, SectionFilter } from '../config/inbox-types';
import { SECTION_FILTER_LABELS } from '../config/inbox-types';

export interface EmailThread {
  threadId: string;
  emails: EmailRecord[];
  latestEmail: EmailRecord;
  oldestEmail: EmailRecord;
  /** Email whose AI categories the thread row should show. This is the latest
   *  NON-DRAFT message — a draft reply is often the newest email in the thread
   *  but carries no category, which would otherwise blank the row's badge. */
  badgeEmailId: string;
  hasUnread: boolean;
  unreadCount: number;
  messageCount: number;
  draftCount: number;
  firstUnreadEmail: EmailRecord | null;
  isImportant: boolean;
  isStarred: boolean;
  /** Thread has an unsent draft (own loaded copy OR the threadHasDraft
   *  aggregate — the draft lives in [Gmail]/Drafts, outside the inbox query). */
  hasDraft: boolean;
  isPriority: boolean;
  importanceScore: number;
  /**
   * Max agent priorityScore (0-100) across the thread's emails — computed
   * locally by BehaviorIntelligence from the user's own behavior signals,
   * no LLM involved. Drives Smart Prioritize ranking and the score badge.
   */
  agentPriorityScore: number;
  senderDisplay: string; // Pre-computed sender display: "First .. Last" or just "First"
}

/**
 * Combined tags across every loaded email in a thread. Concatenating the
 * pipe-delimited strings keeps `includes('|name|')` checks working, so a label
 * (or flag) present on ANY message surfaces at the thread row — not only when
 * it happens to sit on the latest email.
 */
export function threadTagsString(thread: EmailThread): string {
  return thread.emails.map((e) => e.tags || '').join('');
}

/**
 * Robust "is this an unsent draft?" — the single source of truth for every
 * draft check (transcript filter, list count, discard).
 *
 * A draft is any message currently living in a Drafts folder. We detect that
 * three ways so no provider slips through:
 *   1. the local mirror marker `|draft|` (rows we wrote ourselves), and
 *   2. membership in a real Drafts folder path (pass `draftFolderPaths` from
 *      the store's folder list so provider-specific paths like `INBOX.Drafts`
 *      are covered — this is what catches IMAP-synced drafts that come back
 *      tagged only with their folder, e.g. `|Drafts|`, and NOT `|draft|`), and
 *   3. the provider-standard `|Drafts|` / `|[Gmail]/Drafts|` fallbacks.
 *
 * A message that has been sent, trashed, or junked is never a live draft, even
 * if it kept a stale `|draft|` tag (a sent copy tagged `|Sent|draft|`, or a
 * discarded draft moved to `|Trash|`).
 */
export function isDraftEmail(email: EmailRecord, draftFolderPaths?: Set<string>): boolean {
  const tags = email.tags || '';
  if (
    tags.includes('|Sent|') ||
    tags.includes('|Trash|') ||
    tags.includes('|[Gmail]/Trash|') || // Gmail's trash path (doesn't contain '|Trash|')
    tags.includes('|Deleted Items|') ||
    tags.includes('|deleted|') || // \Deleted flag — marked for expunge, not a live draft
    tags.includes('|Junk|') ||
    tags.includes('|Junk Email|') ||
    tags.includes('|Spam|') ||
    tags.includes('|[Gmail]/Spam|')
  ) {
    return false;
  }
  if (tags.includes('|draft|')) return true;
  if (draftFolderPaths) {
    for (const path of draftFolderPaths) {
      if (path && tags.includes(`|${path}|`)) return true;
    }
  }
  return tags.includes('|Drafts|') || tags.includes('|[Gmail]/Drafts|');
}

export function isDraft(email: EmailRecord): boolean {
  return isDraftEmail(email);
}

export function hasImportanceFlag(email: EmailRecord): boolean {
  // Check tags for |important| or fall back to derived isImportant
  if (email.tags) return email.tags.includes('|important|');
  return email.isImportant === true;
}

/**
 * Smart Prioritize = RANKING, not section membership. When on, list views
 * order threads by agent priority score (higher first, date as tiebreak).
 * It deliberately does NOT add threads to the Important section — that
 * section is fed by the |important| tag (server flag, manual mark, or AI
 * categorization), and double-feeding it made the two features look
 * redundant.
 */
export function isSmartPrioritizeEnabled(): boolean {
  try {
    const raw = localStorage.getItem('sarvinbox-agent-config');
    if (!raw) return false;
    const cfg = JSON.parse(raw);
    return cfg?.enabled === true && cfg?.autoPrioritize === true;
  } catch {
    return false;
  }
}

/**
 * Display order for thread lists: date (newest first) by default; with
 * Smart Prioritize on, agent score first, date as tiebreak. Returns a new
 * sorted array — callers pass the buildThreads output.
 */
export function sortThreadsForDisplay(threads: EmailThread[]): EmailThread[] {
  const smart = isSmartPrioritizeEnabled();
  return [...threads].sort((a, b) => {
    if (smart) {
      const diff = (b.agentPriorityScore || 0) - (a.agentPriorityScore || 0);
      if (diff !== 0) return diff;
    }
    return b.latestEmail.date - a.latestEmail.date;
  });
}

export function hasStarredFlag(email: EmailRecord): boolean {
  // Check tags for |starred| or fall back to derived isStarred
  if (email.tags) return email.tags.includes('|starred|');
  return email.isStarred === true;
}

export function isRead(email: EmailRecord): boolean {
  if (email.tags) return email.tags.includes('|read|');
  return (email.flags || []).includes('\\Seen');
}

// Folder tags whose copies must NOT count toward a thread's "unread" (and thus
// bold) state. Keep in sync with THREAD_STATE_EXCLUDED_FOLDERS + liveUnreadSum in
// packages/storage-node/src/repositories/thread-sql.ts — this is what makes the
// client's bold definition match the DB folder-unread badge, the unread filter,
// and the Unread section: a thread whose ONLY unread copy sits in Trash/Spam/
// Junk (or is \Deleted) is NOT shown unread, exactly like the server counts.
const UNREAD_EXCLUDED_FOLDER_TAGS = [
  '|Trash|', '|Spam|', '|[Gmail]/Trash|', '|[Gmail]/Spam|',
  '|Junk|', '|Junk Email|', '|Deleted Items|', '|deleted|',
];

/** True when this message counts as LIVE unread for the row's bold state —
 *  unread, not a draft, and not sitting in a Trash/Spam/Junk/deleted copy. */
export function isUnreadCountable(email: EmailRecord): boolean {
  if (isRead(email) || isDraft(email)) return false;
  const tags = email.tags || '';
  return !UNREAD_EXCLUDED_FOLDER_TAGS.some((t) => tags.includes(t));
}

/**
 * Does a thread still satisfy the active quick-filter (the "Filtered: Unread"
 * chip and friends)? The client-side mirror of `viewFilterFlagSql` in
 * packages/storage-node/src/repositories/email-repository.ts, evaluated at the
 * same THREAD grain the DB query uses.
 *
 * Section buckets are snapshots of a server query, so after an OPTIMISTIC
 * read/star change a row can stop matching the filter it was fetched under.
 * Nothing re-queries the DB until the view reloads, so the list has to
 * re-evaluate the filter itself — otherwise a mail you just marked read keeps
 * sitting in an "Unread"-filtered list (it merely re-buckets into "Everything
 * else", which matches everything).
 *
 * `categorySlugs` (the enabled AI categories, from `getCachedCategorySlugs()`)
 * is only consulted for `noCategory`; an EMPTY list means "defs not loaded yet"
 * → keep the thread, since guessing would hide mail that does match.
 */
export function threadMatchesViewFilter(
  thread: EmailThread,
  filter?: ViewFilter | null,
  categorySlugs: string[] = [],
): boolean {
  if (!filter) return true;
  if (filter.isUnread === true && !thread.hasUnread) return false;
  if (filter.isUnread === false && thread.hasUnread) return false;
  if (filter.isFlagged && !thread.isStarred) return false;
  if (filter.hasAttachments && !thread.emails.some((e) => e.hasAttachments)) return false;
  if (filter.noCategory && categorySlugs.length > 0) {
    const tags = threadTagsString(thread);
    if (categorySlugs.some((slug) => tags.includes(`|${slug}|`))) return false;
  }
  return true;
}

/**
 * Should a thread STAY on screen under the active quick-filter?
 *
 * `threadMatchesViewFilter` plus the one exemption every list needs: the thread
 * you have OPEN. Opening a mail auto-marks it read, so under "Filtered: Unread"
 * a bare filter check would yank the row out from under the cursor (taking the
 * selection with it) the instant you clicked it. It goes on the next load, like
 * every other row that stopped matching.
 *
 * Shared by all three list paths — DB sections, client-side sections, and the
 * flat list — so they can't drift apart on when a row disappears.
 */
export function threadStaysVisible(
  thread: EmailThread,
  filter: ViewFilter | null | undefined,
  categorySlugs: string[],
  selectedEmailId?: string | null,
): boolean {
  return (
    threadMatchesViewFilter(thread, filter, categorySlugs) ||
    (!!selectedEmailId && thread.emails.some((e) => e.id === selectedEmailId))
  );
}

/**
 * The FLAT list's render-time pass of {@link threadStaysVisible}.
 *
 * With no filter active it returns the input array UNCHANGED — same reference,
 * so it can sit in a `useMemo` on the hot render path without manufacturing a
 * new array (and a re-render of every row) on every keystroke elsewhere.
 */
export function visibleThreadsUnderFilter(
  threads: EmailThread[],
  filter: ViewFilter | null | undefined,
  categorySlugs: string[],
  selectedEmailId?: string | null,
): EmailThread[] {
  if (!filter) return threads;
  return threads.filter((t) => threadStaysVisible(t, filter, categorySlugs, selectedEmailId));
}

/**
 * Keep a paginator total honest while rows are dropped at render.
 *
 * Every list total in the app comes from a COUNT the server ran when the page
 * was fetched, so it still includes rows the render-time filter re-check has
 * just taken off screen — "30 of 30" above 9 visible rows, which is what the
 * user sees the instant 21 mails are read in webmail (or here). Subtracting the
 * drop keeps the two agreeing until the next reload's real count takes over.
 *
 * Used by the flat paginator and by each DB-backed section's total, so the two
 * can never drift apart.
 */
export function adjustTotalForFilteredOut(total: number | null | undefined, droppedCount: number): number {
  return Math.max(0, (total || 0) - Math.max(0, droppedCount));
}

function getThreadImportanceScore(emails: EmailRecord[]): number {
  return Math.max(...emails.map(e => e.importanceScore ?? 0));
}

export function buildThreads(emails: EmailRecord[]): EmailThread[] {
  const threadMap = new Map<string, EmailRecord[]>();

  for (const email of emails) {
    const realThreadId = email.threadId || email.id;
    // Unified "All Inboxes" rows carry accountId — group by account + thread so
    // the SAME message dual-delivered to two accounts stays as TWO rows (each
    // with its own account color), instead of collapsing into one (both copies
    // share a Message-ID → same threadId). Normal views (no accountId) group
    // purely by thread, unchanged.
    const groupKey = email.accountId ? `${email.accountId}::${realThreadId}` : realThreadId;
    if (!threadMap.has(groupKey)) {
      threadMap.set(groupKey, []);
    }
    threadMap.get(groupKey)!.push(email);
  }

  const threadList: EmailThread[] = [];
  for (const [groupKey, threadEmails] of threadMap) {
    const sortedAsc = [...threadEmails].sort((a, b) => a.date - b.date);
    // Row identity = the group key: the real threadId for normal views, and
    // account+thread for the unified view. This keeps dual-delivered copies as
    // DISTINCT rows for selection / hover / React keys / DOM anchors. It's UI-only
    // — loading a conversation always uses each email's OWN threadId, never this —
    // so a composite id here is safe.
    const threadId = groupKey;
    const oldestEmail = sortedAsc[0];
    const latestEmail = sortedAsc[sortedAsc.length - 1];
    // The row's category badge follows the latest NON-DRAFT message: a draft
    // reply is frequently the newest email but has no category, so using
    // latestEmail.id would blank the badge even when the conversation IS
    // categorized. Falls back to latestEmail when the thread is only a draft.
    const nonDraftAsc = sortedAsc.filter((e: EmailRecord) => !isDraft(e));
    const badgeEmailId = (nonDraftAsc.length > 0 ? nonDraftAsc[nonDraftAsc.length - 1] : latestEmail).id;
    // A draft is the user's OWN message — it must never count as "unread mail",
    // or a thread with an AI-drafted reply shows bold/unread forever (clicking
    // can't clear it because the real message is already read).
    const unreadEmails = sortedAsc.filter((e: EmailRecord) => isUnreadCountable(e));
    const firstUnreadEmail = unreadEmails.length > 0 ? unreadEmails[0] : null;
    const draftCount = sortedAsc.filter((e: EmailRecord) => isDraft(e)).length;
    // Show the real conversation size (Gmail-style): the whole-thread count
    // from the DB aggregate (Trash/Spam excluded, matching getByThread), so a
    // multi-message thread still shows "(N)" even when only one of its messages
    // is loaded in the current filtered view. Falls back to the loaded count
    // when the aggregate is absent. Note: this deliberately does NOT sum to the
    // footer's "X of Y emails" — that counts emails loaded in THIS view, a
    // different metric (Gmail's list works the same way).
    const messageCount = oldestEmail.threadMessageCount ?? threadEmails.length;
    // Prefer thread-wide DB aggregates (threadIsStarred/threadIsImportant)
    // when present — they reflect the thread's state across ALL folders,
    // not just the loaded subset. Without this, a thread whose starred
    // email lives in [Gmail]/Starred would report isStarred=false in
    // INBOX view (the starred email isn't loaded), and the row's star
    // icon and the Starred section filter would disagree.
    const threadStarredFromDb = (oldestEmail as any).threadIsStarred;
    const threadImportantFromDb = (oldestEmail as any).threadIsImportant;
    const isImportant = typeof threadImportantFromDb === 'boolean'
      ? threadImportantFromDb
      : sortedAsc.some(e => hasImportanceFlag(e));
    const isStarred = typeof threadStarredFromDb === 'boolean'
      ? threadStarredFromDb
      : sortedAsc.some(e => hasStarredFlag(e));
    // Computed from the LOADED rows (via isUnreadCountable) — NOT a DB aggregate.
    // This is deliberate: optimistic mark-read/unread flips the |read| tag on the
    // in-memory rows and rebuilds threads, so bold must re-derive from those rows
    // to update instantly. A cached thread aggregate would ignore the optimistic
    // flip and leave the row bold. isUnreadCountable applies the SAME predicate
    // the DB badge/filter use (no |read|, not draft/deleted, not Trash/Spam/Junk),
    // so bold and the counts share one definition while staying optimistic-safe.
    const hasUnread = unreadEmails.length > 0;
    const isPriority = isImportant || isStarred || hasUnread;
    // Draft badge: a loaded copy is tagged |draft|, OR the DB thread
    // aggregate says the thread has a draft (the draft sits in
    // [Gmail]/Drafts, outside the inbox query, so draftCount alone is 0).
    const hasDraft = draftCount > 0 || sortedAsc.some(e => (e as any).threadHasDraft === true);
    const importanceScore = getThreadImportanceScore(sortedAsc);
    const agentPriorityScore = Math.max(
      0,
      ...sortedAsc.map(e => (e as EmailRecord & { priorityScore?: number }).priorityScore ?? 0)
    );

    // Compute sender display using full-thread sender info from DB subqueries
    // (Trash/Spam excluded), matching the whole-thread messageCount above.
    // Use first names only when showing "A .. B" to save space in the list.
    const firstSenderFull = oldestEmail.threadFirstSender || oldestEmail.fromName || oldestEmail.fromAddress || '';
    const lastSenderFull = oldestEmail.threadLastSender || latestEmail.fromName || latestEmail.fromAddress || '';
    const toFirstName = (name: string) => name.split(/\s+/)[0] || name;
    let senderDisplay: string;
    if (messageCount <= 1 || firstSenderFull === lastSenderFull) {
      senderDisplay = firstSenderFull;
    } else {
      senderDisplay = `${toFirstName(firstSenderFull)} .. ${toFirstName(lastSenderFull)}`;
    }

    threadList.push({
      threadId,
      emails: sortedAsc,
      latestEmail,
      oldestEmail,
      badgeEmailId,
      hasUnread,
      unreadCount: unreadEmails.length,
      messageCount,
      draftCount,
      firstUnreadEmail,
      isImportant,
      isStarred,
      hasDraft,
      isPriority,
      importanceScore,
      agentPriorityScore,
      senderDisplay,
    });
  }

  // Single ordering point for every consumer (flat lists, section buckets,
  // AI box): date order, or score-first when Smart Prioritize is on.
  return sortThreadsForDisplay(threadList);
}

// Section assignment (stateless, for AI Box and similar views)
export interface SectionData {
  section: InboxSection;
  threads: EmailThread[];
  label: string;
  // Per-section pagination (DB-backed sections only)
  total?: number;
  hasMore?: boolean;
  loading?: boolean;
  /** 0-based current page for Gmail-style per-section pagination. */
  page?: number;
}

export function assignThreadsToSections(
  threads: EmailThread[],
  sections: InboxSection[],
  matchesFn: (thread: EmailThread, filter: SectionFilter) => boolean,
): SectionData[] {
  const result: SectionData[] = [];
  const usedThreadIds = new Set<string>();

  for (const section of sections) {
    if (section.filter === 'none') continue;

    let sectionThreads: EmailThread[];
    if (section.filter === 'everything_else') {
      sectionThreads = threads.filter(t => !usedThreadIds.has(t.threadId));
    } else {
      sectionThreads = threads.filter(t =>
        !usedThreadIds.has(t.threadId) && matchesFn(t, section.filter)
      );
    }

    // Explicit date sort guarantees newest-first within each section
    sectionThreads.sort((a, b) => b.latestEmail.date - a.latestEmail.date);

    if (section.maxItems > 0) {
      sectionThreads = sectionThreads.slice(0, section.maxItems);
    }

    if (section.hideWhenEmpty && sectionThreads.length === 0) continue;

    sectionThreads.forEach(t => usedThreadIds.add(t.threadId));
    result.push({
      section,
      threads: sectionThreads,
      label: SECTION_FILTER_LABELS[section.filter],
    });
  }

  return result;
}
