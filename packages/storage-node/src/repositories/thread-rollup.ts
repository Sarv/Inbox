// Read-model derivation & maintenance — the write-side of the fan-out-on-write
// design in docs/READ_MODEL_PLAN.md.
//
// Every list-mutating repository method funnels the affected thread ids through
// rebuildThread(s) so `threads` (denormalized flags) + `thread_folders` (the
// per-(folder,thread) materialized index) + `thread_categories` stay in sync,
// letting list reads be flat indexed scans instead of GROUP BY + correlated
// EXISTS. The derivation is deterministic from a thread's `emails` rows, so a
// rebuild is idempotent and safe to run any number of times (backfill, self-heal).
//
// Semantics are kept byte-for-byte compatible with the legacy query helpers in
// thread-sql.ts so the new path can never disagree with the old one during the
// fallback window:
//   - "LIVE" (flag scope) excludes Trash/Spam/Junk/Deleted copies (and |deleted|),
//     matching THREAD_STATE_EXCLUDED_FOLDERS / threadTagExists.
//   - Per-folder rows use the folder-local listing scope (the getExcludeSpecialFolders
//     set), matching getByFolder / the section inner query's per-email WHERE.
//   - `last_message_date` is Unix SECONDS, copied verbatim from emails.date (the
//     source column) — no unit conversion, so no drift against the legacy path.

import { createLogger } from '@sarvinbox/core';
import type Database from 'better-sqlite3';


import { THREAD_STATE_EXCLUDED_FOLDERS, isShadowedInFolder } from './thread-sql';

const logger = createLogger('thread-rollup');

/** Flag tokens carried inside the pipe-delimited `emails.tags` column. */
const TAG_READ = 'read';
const TAG_STARRED = 'starred';
const TAG_IMPORTANT = 'important';
const TAG_DRAFT = 'draft';
const TAG_DELETED = 'deleted';
/** Folder-path tokens that mark an unsent draft (draft tag + a Drafts folder). */
const DRAFTS_FOLDER_PATHS = ['Drafts', '[Gmail]/Drafts'];

/** Copies in these folders don't count toward conversation-wide LIVE state. */
const LIVE_EXCLUDED = new Set<string>(THREAD_STATE_EXCLUDED_FOLDERS);

/** Row shape read from `emails` for derivation. */
export interface RollupEmailRow {
  id: string;
  message_id: string;
  tags: string;
  date: number;            // unix seconds
  has_attachments: number; // 0 | 1
  priority_score: number | null;
  from_name: string | null;
  from_address: string;
  subject: string | null;
  updated_at: number;      // unix seconds
}

/** Per-(folder,thread) projection — one materialized `thread_folders` row. */
export interface ThreadFolderRollup {
  folderId: string;
  lastMessageDate: number;
  maxPriorityScore: number;
  hasUnread: boolean;
  hasImportant: boolean;
  hasImportantUnread: boolean;
  hasFlagged: boolean;
  hasAttachment: boolean;
  hasDraft: boolean;
  hasCategory: boolean;
}

/** The fully-derived state of ONE conversation. */
export interface ThreadRollup {
  threadId: string;
  hasEmails: boolean;         // false => the thread has no rows; caller clears read-model
  subject: string;
  firstMessageId: string;
  lastMessageId: string;
  lastMessageDate: number;    // unix seconds, LIVE non-draft (fallback: any)
  liveMessageCount: number;
  firstSender: string | null;
  lastSender: string | null;
  maxPriorityScore: number;
  hasUnread: boolean;
  hasImportant: boolean;
  hasImportantUnread: boolean;
  hasFlagged: boolean;
  hasAttachment: boolean;
  hasDraft: boolean;
  categories: string[];       // => has_category = categories.length > 0
  folders: ThreadFolderRollup[];
  stateVersion: number;       // FNV-1a over (id, updated_at, flags) of all rows
}

/** Cached lookups shared across a rebuild batch (avoids re-querying per thread). */
export interface RollupContext {
  /** folder path -> folder id (only folders that exist locally are mappable). */
  folderPaths: Map<string, string>;
  /** every defined AI category slug (enabled or not — a disabled-but-tagged
   *  category still renders a badge, so it counts as "labelled"). */
  categorySlugs: Set<string>;
}

/** Split a pipe-delimited tags string into its token set. */
function tokenize(tags: string): Set<string> {
  const out = new Set<string>();
  for (const t of tags.split('|')) if (t) out.add(t);
  return out;
}

const senderOf = (r: RollupEmailRow): string | null => r.from_name || r.from_address || null;

/**
 * True when this copy counts toward conversation-wide flag state. Matches the
 * legacy `threadTagExists` / `threadFolderExclusion` scope: excludes only the
 * Trash/Spam/Junk/Deleted-Items *folders*. It deliberately does NOT exclude the
 * bare `|deleted|` tag — legacy's starred/important EXISTS predicates ignore it,
 * and only the unread computation (`liveUnreadSum`) additionally drops `|deleted|`
 * (applied at the hasUnread site below). Getting this wrong hid starred mail that
 * carried a `|deleted|` tag (an un-expunged \Deleted copy).
 */
function isFolderLive(tokens: Set<string>): boolean {
  for (const f of LIVE_EXCLUDED) if (tokens.has(f)) return false;
  return true;
}

/** True when this copy is a genuine UNSENT draft (draft tag + a Drafts folder). */
function isUnsentDraft(tokens: Set<string>): boolean {
  return tokens.has(TAG_DRAFT) && DRAFTS_FOLDER_PATHS.some((p) => tokens.has(p));
}

/** 32-bit FNV-1a hash of a string (no allocations beyond the input). */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derive a thread's full rollup from its email rows. Pure — no I/O — so it's
 * directly unit-testable with synthetic rows. Rows may arrive in any order.
 */
export function deriveRollup(threadId: string, rows: RollupEmailRow[], ctx: RollupContext): ThreadRollup {
  if (rows.length === 0) {
    return {
      threadId, hasEmails: false, subject: '', firstMessageId: '', lastMessageId: '',
      lastMessageDate: 0, liveMessageCount: 0, firstSender: null, lastSender: null,
      maxPriorityScore: 0, hasUnread: false, hasImportant: false, hasImportantUnread: false,
      hasFlagged: false, hasAttachment: false, hasDraft: false, categories: [],
      folders: [], stateVersion: 0,
    };
  }

  // Conversation-wide LIVE flags + per-folder accumulation in one pass.
  let hasUnread = false, hasImportant = false, hasImportantUnread = false;
  let hasFlagged = false, hasAttachment = false, hasDraft = false;
  let liveMessageCount = 0;
  let liveNonDraftLastDate = -1;
  const categories = new Set<string>();
  // path -> accumulated folder-local state
  const folderAcc = new Map<string, { lastDate: number; maxPriority: number }>();
  // sender bookkeeping over LIVE copies
  let firstSender: string | null = null, lastSender: string | null = null;
  let firstDate = Infinity, lastDate = -Infinity;

  // Stable hash inputs + subject/message-id extremes over ALL rows (any scope).
  const hashParts: string[] = [];
  let oldest: RollupEmailRow = rows[0];
  let newest: RollupEmailRow = rows[0];

  for (const r of rows) {
    const tokens = tokenize(r.tags);
    const read = tokens.has(TAG_READ);
    const starred = tokens.has(TAG_STARRED);
    const important = tokens.has(TAG_IMPORTANT);
    const draft = isUnsentDraft(tokens);
    const attachment = r.has_attachments === 1;
    const deleted = tokens.has(TAG_DELETED);
    const live = isFolderLive(tokens);

    // stateVersion input: id + updated_at + a compact flag mask.
    const mask =
      (read ? 1 : 0) | (starred ? 2 : 0) | (important ? 4 : 0) |
      (draft ? 8 : 0) | (attachment ? 16 : 0) | (live ? 32 : 0);
    hashParts.push(`${r.id}:${r.updated_at}:${mask}`);

    if (r.date < oldest.date) oldest = r;
    if (r.date > newest.date) newest = r;

    if (live) {
      // Unread mirrors liveUnreadSum, which ALSO drops |deleted|; the other flags
      // mirror threadTagExists, which does not.
      if (!read && !deleted) hasUnread = true;
      if (important) hasImportant = true;
      if (important && !read) hasImportantUnread = true;
      if (starred) hasFlagged = true;
      if (attachment) hasAttachment = true;
      for (const slug of ctx.categorySlugs) if (tokens.has(slug)) categories.add(slug);
      if (!draft) {
        liveMessageCount++;
        if (r.date > liveNonDraftLastDate) liveNonDraftLastDate = r.date;
      }
      if (r.date < firstDate) { firstDate = r.date; firstSender = senderOf(r); }
      if (r.date > lastDate) { lastDate = r.date; lastSender = senderOf(r); }
    }
    if (draft) hasDraft = true;

    // Per-folder projection: for each folder this copy belongs to, if the copy is
    // "listable in that folder" (not shadowed by another special folder), fold in
    // its date + priority. Only folders that exist locally are mappable.
    for (const token of tokens) {
      if (!ctx.folderPaths.has(token)) continue;           // not a known folder path
      if (isShadowedInFolder(tokens, token)) continue;     // hidden by another special folder
      const acc = folderAcc.get(token) ?? { lastDate: -1, maxPriority: 0 };
      if (r.date > acc.lastDate) acc.lastDate = r.date;
      const p = r.priority_score ?? 0;
      if (p > acc.maxPriority) acc.maxPriority = p;
      folderAcc.set(token, acc);
    }
  }

  const maxPriorityScore = Math.max(0, ...rows.map((r) => r.priority_score ?? 0));

  const folders: ThreadFolderRollup[] = [];
  for (const [path, acc] of folderAcc) {
    folders.push({
      folderId: ctx.folderPaths.get(path)!,
      lastMessageDate: acc.lastDate,
      maxPriorityScore: acc.maxPriority,
      // Flags are conversation-wide LIVE (same on every folder row) — this is what
      // the sectioned-inbox predicates test; folder-local date/priority order it.
      hasUnread, hasImportant, hasImportantUnread, hasFlagged, hasAttachment, hasDraft,
      hasCategory: categories.size > 0,
    });
  }

  hashParts.sort();

  return {
    threadId,
    hasEmails: true,
    subject: newest.subject ?? '',
    firstMessageId: oldest.message_id,
    lastMessageId: newest.message_id,
    lastMessageDate: liveNonDraftLastDate >= 0 ? liveNonDraftLastDate : newest.date,
    liveMessageCount,
    firstSender,
    lastSender,
    maxPriorityScore,
    hasUnread, hasImportant, hasImportantUnread, hasFlagged, hasAttachment, hasDraft,
    categories: [...categories],
    folders,
    stateVersion: fnv1a32(hashParts.join('\n')),
  };
}

// ---------------------------------------------------------------------------
// I/O layer
// ---------------------------------------------------------------------------

/** Build the shared lookup context once per rebuild batch. */
export function buildRollupContext(db: Database.Database): RollupContext {
  const folderPaths = new Map<string, string>();
  for (const f of db.prepare('SELECT id, path FROM folders').all() as { id: string; path: string }[]) {
    folderPaths.set(f.path, f.id);
  }
  const categorySlugs = new Set<string>();
  for (const c of db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[]) {
    categorySlugs.add(c.slug);
  }
  return { folderPaths, categorySlugs };
}

/** Read a thread's email rows and derive its rollup (no writes). */
export function computeThreadRollup(db: Database.Database, threadId: string, ctx?: RollupContext): ThreadRollup {
  const context = ctx ?? buildRollupContext(db);
  const rows = db.prepare(
    `SELECT id, message_id, tags, date, has_attachments, priority_score,
            from_name, from_address, subject, updated_at
       FROM emails WHERE thread_id = ?`,
  ).all(threadId) as RollupEmailRow[];
  return deriveRollup(threadId, rows, context);
}

/**
 * BEGIN IMMEDIATE — acquire the RESERVED lock up front so the sync writer never
 * deadlocks against a reader that opened a DEFERRED txn first. Nested calls run
 * as savepoints (better-sqlite3 ignores the mode when already in a txn), so this
 * composes with a caller that already wrapped a batch.
 */
export function withImmediateTxn<T>(db: Database.Database, fn: () => T): T {
  let result: T;
  const tx = db.transaction(() => { result = fn(); });
  tx.immediate();
  return result!;
}

/** Prepared writers bound to one connection, reused across a rebuild batch. */
function makeWriter(db: Database.Database) {
  const upsertThread = db.prepare(`
    INSERT INTO threads (
      id, subject, first_message_id, last_message_id, last_message_date, message_count,
      has_unread, has_flagged, has_important, has_important_unread, has_attachment,
      has_draft, has_category, max_priority_score, first_sender, last_sender,
      live_message_count, state_version
    ) VALUES (
      @id, @subject, @firstMessageId, @lastMessageId, @lastMessageDate, @liveMessageCount,
      @hasUnread, @hasFlagged, @hasImportant, @hasImportantUnread, @hasAttachment,
      @hasDraft, @hasCategory, @maxPriorityScore, @firstSender, @lastSender,
      @liveMessageCount, @stateVersion
    )
    ON CONFLICT(id) DO UPDATE SET
      -- Own only the read-model columns; subject/message-ids/message_count/
      -- participants stay owned by the thread-building path to avoid two writers
      -- fighting over the same column.
      has_unread = excluded.has_unread,
      has_flagged = excluded.has_flagged,
      has_important = excluded.has_important,
      has_important_unread = excluded.has_important_unread,
      has_attachment = excluded.has_attachment,
      has_draft = excluded.has_draft,
      has_category = excluded.has_category,
      max_priority_score = excluded.max_priority_score,
      first_sender = excluded.first_sender,
      last_sender = excluded.last_sender,
      live_message_count = excluded.live_message_count,
      state_version = excluded.state_version
  `);
  const clearFolders = db.prepare('DELETE FROM thread_folders WHERE thread_id = ?');
  const clearCategories = db.prepare('DELETE FROM thread_categories WHERE thread_id = ?');
  const insertFolder = db.prepare(`
    INSERT INTO thread_folders (
      folder_id, thread_id, last_message_date, max_priority_score,
      has_unread, has_important, has_important_unread, has_flagged,
      has_attachment, has_draft, has_category
    ) VALUES (
      @folderId, @threadId, @lastMessageDate, @maxPriorityScore,
      @hasUnread, @hasImportant, @hasImportantUnread, @hasFlagged,
      @hasAttachment, @hasDraft, @hasCategory
    )
  `);
  const insertCategory = db.prepare('INSERT INTO thread_categories (thread_id, slug) VALUES (?, ?)');

  const b = (v: boolean) => (v ? 1 : 0);

  return (r: ThreadRollup): void => {
    // A thread with no rows left (all deleted) — clear its read-model presence.
    clearFolders.run(r.threadId);
    clearCategories.run(r.threadId);
    if (!r.hasEmails) return;

    upsertThread.run({
      id: r.threadId,
      subject: r.subject,
      firstMessageId: r.firstMessageId,
      lastMessageId: r.lastMessageId,
      lastMessageDate: r.lastMessageDate,
      liveMessageCount: r.liveMessageCount,
      hasUnread: b(r.hasUnread),
      hasFlagged: b(r.hasFlagged),
      hasImportant: b(r.hasImportant),
      hasImportantUnread: b(r.hasImportantUnread),
      hasAttachment: b(r.hasAttachment),
      hasDraft: b(r.hasDraft),
      hasCategory: b(r.categories.length > 0),
      maxPriorityScore: r.maxPriorityScore,
      firstSender: r.firstSender,
      lastSender: r.lastSender,
      stateVersion: r.stateVersion,
    });

    for (const f of r.folders) {
      insertFolder.run({
        folderId: f.folderId,
        threadId: r.threadId,
        lastMessageDate: f.lastMessageDate,
        maxPriorityScore: f.maxPriorityScore,
        hasUnread: b(f.hasUnread),
        hasImportant: b(f.hasImportant),
        hasImportantUnread: b(f.hasImportantUnread),
        hasFlagged: b(f.hasFlagged),
        hasAttachment: b(f.hasAttachment),
        hasDraft: b(f.hasDraft),
        hasCategory: b(f.hasCategory),
      });
    }
    for (const slug of r.categories) insertCategory.run(r.threadId, slug);
  };
}

/** Recompute & persist ONE thread's read-model rows. Idempotent. */
export function rebuildThread(db: Database.Database, threadId: string, ctx?: RollupContext): void {
  const context = ctx ?? buildRollupContext(db);
  const write = makeWriter(db);
  withImmediateTxn(db, () => write(computeThreadRollup(db, threadId, context)));
}

/** Recompute & persist many threads in ONE transaction (batch ingest / backfill). */
export function rebuildThreads(db: Database.Database, threadIds: Iterable<string>, ctx?: RollupContext): number {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return 0;
  const context = ctx ?? buildRollupContext(db);
  const write = makeWriter(db);
  withImmediateTxn(db, () => {
    for (const id of ids) write(computeThreadRollup(db, id, context));
  });
  return ids.length;
}

/**
 * Cheap drift check for lazy self-healing: recompute the thread's stateVersion +
 * live count and compare to what's stored. Returns true when they match (no
 * rebuild needed). A mismatch means a write path skipped the rollup — the caller
 * enqueues an async rebuild and serves the stored data in the meantime.
 */
export function verifyThread(db: Database.Database, threadId: string, ctx?: RollupContext): boolean {
  const stored = db.prepare(
    'SELECT state_version, live_message_count FROM threads WHERE id = ?',
  ).get(threadId) as { state_version: number; live_message_count: number } | undefined;
  const fresh = computeThreadRollup(db, threadId, ctx);
  if (!stored) return !fresh.hasEmails; // no thread row is correct only if there are no emails
  return stored.state_version === fresh.stateVersion
    && stored.live_message_count === fresh.liveMessageCount;
}

export { logger as threadRollupLogger };
