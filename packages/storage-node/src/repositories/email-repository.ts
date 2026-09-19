// Email Repository — Unified Tags System (v2)
// All queries use instr(tags, '|tag|') — zero JOINs

import type {
  EmailRecord,
  SearchQuery,
  PaginationOptions,
  ViewFilter,
} from '@sarvinbox/core';
import {
  addTag,
  removeTag,
  parseTags,
  hasTag,
  tagsToImapFlags,
  bodyContentHash,
  createLogger,
  hasInlineImageRefs,
} from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { prepared } from '../statement-cache';
import { writeThreadKey } from '../thread-keys';

import { BaseRepository, type DatabaseAccessor } from './base-repository';
import { areBodyLengthsReady, bodyLengthSetClauses, rawBodyLengthExpression } from './body-metrics';
import {
  UPSERT_BODY_SQL,
  upsertBodyPatchSql,
  cleanBodyExpression,
  rawBodyExpression,
  cleanBodySnippetColumn,
} from './body-storage';
import {
  inflateInlineImages,
  rawBodyForStorage,
  relocateBodyForInsert,
  writeImageLinks,
} from './inline-image-store';
import {
  threadFolderExclusion,
  threadTagExists,
  THREAD_META_SHARED,
  liveUnreadSum,
  listingExclusion,
  LISTING_EXCLUDED_FOLDERS,
  readModelComplete,
} from './thread-sql';

const log = createLogger('EmailRepo');

// ========== Tag Helpers ==========
// Single source of truth lives in @sarvinbox/core; re-exported here so existing
// `import { buildTags, ... } from './email-repository'` sites keep working.
export {
  buildTags,
  parseTags,
  hasTag,
  addTag,
  removeTag,
  imapFlagsToTags,
  tagsToImapFlags,
  FLAG_TAG_NAMES,
} from '@sarvinbox/core';

/**
 * WHERE fragment selecting the rows whose PRIMARY folder is `?` and that carry a
 * real server UID. Single source of truth shared by the UID-only and the
 * tags-only folder scans so the two row sets can never drift apart.
 * Served by the `idx_emails_folder_uid` (folder_id, uid) index.
 */
export const PRIMARY_FOLDER_WITH_UID_SQL = 'folder_id = ? AND uid IS NOT NULL AND uid > 0';

/**
 * Rows read per keyset page by the folder-wide UID/tag scans, and the yield
 * boundary between pages. Big enough that a normal mailbox folder is a single
 * query, small enough that one page never stalls the event loop.
 */
const FOLDER_SCAN_PAGE_SIZE = 5000;

/** Sent-folder paths across providers (standard IMAP, Outlook/Exchange, Gmail) */
export const SENT_FOLDER_PATHS = ['Sent', 'Sent Items', '[Gmail]/Sent Mail'];

/** Check if a tags string contains a sent-folder tag (case-insensitive path segment match) */
export function hasSentFolderTag(tags: string): boolean {
  const lowered = (tags || '').toLowerCase();
  return SENT_FOLDER_PATHS.some(p => lowered.includes('|' + p.toLowerCase() + '|'));
}

/** SQL condition matching the same sent-folder tags as hasSentFolderTag */
const SENT_FOLDER_TAG_SQL = SENT_FOLDER_PATHS
  .map(p => `instr(lower(tags), '|${p.toLowerCase()}|') > 0`)
  .join(' OR ');

/**
 * Folders whose mail is NOT "all mail": the discard piles (Trash/Spam) and the
 * user's own outgoing/unsent piles (Sent/Drafts), under every name the servers
 * we support publish them as.
 *
 * This IS {@link LISTING_EXCLUDED_FOLDERS}, not a copy of it: "All Email" now has
 * two implementations — the read-model one excludes these folders by ID off
 * `thread_folders`, the legacy one by tag off `emails` — and the folder
 * projection those IDs come from is itself built with LISTING_EXCLUDED_FOLDERS.
 * A second list here would let the two paths disagree about what "all mail"
 * means, and the paginator would then promise pages the list cannot show.
 */
const NON_MAIL_FOLDER_TAGS = LISTING_EXCLUDED_FOLDERS;

/** `AND instr(tags, '|X|') = 0` for each tag — literal paths, no user input. */
const excludeFolderTagsSql = (tags: readonly string[]): string =>
  tags.map((tag) => `AND instr(tags, '|${tag}|') = 0`).join('\n          ');

const EXCLUDE_NON_MAIL_SQL = excludeFolderTagsSql(NON_MAIL_FOLDER_TAGS);

/**
 * The two folder-less views whose membership is a conversation-wide LIVE flag
 * rather than a folder: Starred and Important. Both page and count by THREAD.
 */
type FlagView = 'starred' | 'important';

/**
 * Per-view SQL knobs. Unlike a folder or section listing there is no
 * `folderPath` to key `thread_folders` by, so the read-model path reads the
 * conversation-wide LIVE flags straight off `threads` — exactly the semantics
 * the old per-message query was reaching for (a starred message in Trash does
 * not make the thread starred). Important sorts by priority first, matching the
 * ORDER BY the message-level query used.
 */
const FLAG_VIEWS = {
  starred: {
    tag: 'starred',
    column: 'has_flagged',
    fastOrderBy: 't.last_message_date DESC, t.id DESC',
    legacyOrderBy: 'last_date DESC, tid DESC',
  },
  important: {
    tag: 'important',
    column: 'has_important',
    fastOrderBy: 't.max_priority_score DESC, t.last_message_date DESC, t.id DESC',
    legacyOrderBy: 'max_priority DESC, last_date DESC, tid DESC',
  },
} as const;

/** The read-model page query for a flag view (binds limit, offset). Exported so
 *  the query-plan test asserts the REAL SQL against the real partial index —
 *  without one, every page is a full scan of `threads` plus a sort. */
export const flagViewPageSql = (view: FlagView): string => `
  SELECT t.id FROM threads t
  WHERE t.${FLAG_VIEWS[view].column} = 1
  ORDER BY ${FLAG_VIEWS[view].fastOrderBy}
  LIMIT ? OFFSET ?
`;

/** Legacy (pre-read-model) thread ids for a flag view: GROUP BY conversation
 *  over the LIVE copies only, keeping any conversation with >= 1 tagged
 *  message. Selected columns carry the sort keys so ORDER BY can name them. */
const flagViewLegacySql = (view: FlagView, tail: string): string => `
  SELECT COALESCE(e.thread_id, e.id) AS tid,
         MAX(e.date) AS last_date,
         MAX(COALESCE(e.priority_score, 0)) AS max_priority
  FROM emails e
  WHERE 1 = 1
    ${threadFolderExclusion('e')}
  GROUP BY tid
  HAVING SUM(CASE WHEN instr(e.tags, '|${FLAG_VIEWS[view].tag}|') > 0 THEN 1 ELSE 0 END) > 0
  ${tail}
`;

/**
 * "All Email" membership, at THREAD grain: the conversation lists in at least
 * one folder that isn't a discard/outgoing pile. `thread_folders` already holds
 * exactly that — the rollup writes a row per (folder, thread) only for copies
 * the folder's own listing would show — so the test is an EXISTS over the
 * non-excluded folder ids rather than a re-derivation from tags.
 *
 * The excluded ids are BOUND, not interpolated: they come from the folders
 * table, not from this file's literals.
 */
const allMailExistsSql = (excludedFolderIdCount: number): string => {
  const notExcluded = excludedFolderIdCount > 0
    ? `AND tf.folder_id NOT IN (${new Array(excludedFolderIdCount).fill('?').join(', ')})`
    : '';
  return `EXISTS (
    SELECT 1 FROM thread_folders tf
    WHERE tf.thread_id = t.id ${notExcluded}
  )`;
};

/** The read-model page query for "All Email" (binds the excluded folder ids,
 *  then limit, offset). Exported so the query-plan test asserts the REAL SQL:
 *  without idx_tf_thread the EXISTS scans the whole projection per candidate,
 *  and without the composite date index the ORDER BY builds a temp b-tree over
 *  every conversation in the mailbox. */
export const allMailPageSql = (excludedFolderIdCount: number): string => `
  SELECT t.id FROM threads t
  WHERE ${allMailExistsSql(excludedFolderIdCount)}
  ORDER BY t.last_message_date DESC, t.id DESC
  LIMIT ? OFFSET ?
`;

/** The read-model "of N" for "All Email" — same predicate, no order/window. */
export const allMailCountSql = (excludedFolderIdCount: number): string => `
  SELECT COUNT(*) as count FROM threads t
  WHERE ${allMailExistsSql(excludedFolderIdCount)}
`;

/** Legacy (pre-read-model) thread ids for "All Email": GROUP BY conversation
 *  over the listable copies only. No HAVING — surviving the WHERE is itself the
 *  membership test.
 *
 *  Deliberate, known difference from the read-model path: this orders by the
 *  newest LISTED message, while `threads.last_message_date` is the newest LIVE
 *  non-draft message and so counts the user's own Sent replies. A thread whose
 *  latest message is a reply the user sent therefore sorts higher on the fast
 *  path. Accepted (it is the more useful "latest activity" order, and matches
 *  what webmail does); the cross-path test asserts set equality, not order. */
const allMailLegacySql = (tail: string): string => `
  SELECT COALESCE(e.thread_id, e.id) AS tid,
         MAX(e.date) AS last_date
  FROM emails e
  WHERE 1 = 1
    ${EXCLUDE_NON_MAIL_SQL}
  GROUP BY tid
  ${tail}
`;

/**
 * Snoozed, at THREAD grain: one row per conversation that has mail coming back,
 * ordered by whichever of its messages returns SOONEST.
 *
 * Both halves of the predicate are required and always travel together. A row
 * tagged `|snoozed|` with no `snooze_until` has no time to come back at, so it
 * can never appear in the list — counting it (as the count alone used to) makes
 * the header promise mail the view cannot show.
 *
 * No read-model fast path, deliberately: `threads` carries no snooze column, and
 * adding one would mean a rollup change plus a full re-backfill for a view whose
 * whole population is already covered by the partial index
 * `idx_emails_snooze (snooze_until) WHERE snooze_until IS NOT NULL` — the
 * unindexable instr() is then a residual filter over a handful of rows, not a
 * scan of the mailbox.
 */
const snoozedThreadsSql = (tail: string): string => `
  SELECT COALESCE(e.thread_id, e.id) AS tid,
         MIN(e.snooze_until) AS wake
  FROM emails e
  WHERE instr(e.tags, '|snoozed|') > 0
    AND e.snooze_until IS NOT NULL
  GROUP BY tid
  ${tail}
`;

/** The page query for the Snoozed view (binds limit, offset). Exported so the
 *  query-plan test asserts the REAL SQL against the real partial index. */
export const snoozedThreadsPageSql = (): string =>
  snoozedThreadsSql('ORDER BY wake ASC, tid ASC LIMIT ? OFFSET ?');

/**
 * Put hydrated messages back in the order their THREADS were selected in.
 *
 * Every thread-grained listing picks its page as thread ids in the order the
 * view wants (priority, wake time, date), then hydrates the messages with a
 * single IN (...) query whose ORDER BY can only sort WITHIN a thread — across
 * threads it interleaves, which silently throws the view's ranking away. The
 * sort is stable, so the within-thread order the hydration query established
 * survives untouched.
 */
const orderByThreadRank = (records: EmailRecord[], threadIds: string[]): EmailRecord[] => {
  const rank = new Map(threadIds.map((id, index) => [id, index]));
  const rankOf = (record: EmailRecord): number =>
    rank.get(record.threadId || record.id) ?? Number.MAX_SAFE_INTEGER;
  return [...records].sort((a, b) => rankOf(a) - rankOf(b));
};

// ========== Thread-Level Tag Predicates ==========
// One shared semantics for "thread is starred/important": ANY email in
// the thread has the tag, with Trash/Spam copies excluded. Used by both
// THREAD_META (list-view star icon) and the section queries so the two
// can never disagree. instr() (not LIKE) so a folder literally named
// "Starred" doesn't match the |starred| flag tag case-insensitively.

/** Columns callers may sort emails by — anything else falls back to date */
const EMAIL_SORT_COLUMNS = new Set([
  'date', 'received_date', 'subject', 'from_address',
  'importance_score', 'priority_score', 'created_at', 'updated_at',
]);

const THREAD_HAS_STARRED = threadTagExists('ts1', `instr(ts1.tags, '|starred|') > 0`);
const THREAD_HAS_IMPORTANT = threadTagExists('ti1', `instr(ti1.tags, '|important|') > 0`);
const THREAD_HAS_IMPORTANT_UNREAD = threadTagExists(
  'tiu1', `instr(tiu1.tags, '|important|') > 0 AND instr(tiu1.tags, '|read|') = 0`
);

/** Thread metadata subqueries appended to SELECT * for list views */
const THREAD_META = `
  ${THREAD_META_SHARED},
  -- True if ANY email in the thread has the |starred| tag, regardless of which folder it lives in.
  -- Lets the list-view star icon and the Starred section both reflect the thread's real state when
  -- the user is viewing INBOX (Gmail puts starred emails in the separate [Gmail]/Starred folder
  -- with no |INBOX| tag — without this, the loaded INBOX subset reports isStarred=false even
  -- though the thread truly has a starred message).
  ${threadTagExists('e5', `instr(e5.tags, '|starred|') > 0`)} as thread_is_starred,
  ${threadTagExists('e6', `instr(e6.tags, '|important|') > 0`)} as thread_is_important,
  -- True if ANY email in the thread is a genuine UNSENT draft — i.e. tagged
  -- |draft| AND living in a Drafts folder. Requiring Drafts membership matters:
  -- a sent message can retain a stale |draft| tag (|Sent|draft|), and a deleted
  -- draft moves to Trash (|draft|Trash|); neither is an unsent draft, so the
  -- "Draft" badge must not count them.
  ${threadTagExists('e7', `instr(e7.tags, '|draft|') > 0 AND (instr(e7.tags, '|Drafts|') > 0 OR instr(e7.tags, '|[Gmail]/Drafts|') > 0)`)} as thread_has_draft
`;

/**
 * Repository for email operations — tags-based, zero JOINs
 */
export class EmailRepository extends BaseRepository {
  constructor(getDb: DatabaseAccessor) {
    super(getDb);
  }

  /** Log a query method call with its parameters — TRACE. Fires on EVERY repo
   *  query, so it's dropped even in debug mode; set the log level to 'trace' to
   *  see it. The `levelEnabled` guard inside `trace` skips the string build's
   *  cost (the param join below only runs when trace is actually on). */
  private logQuery(method: string, params: Record<string, any> = {}): void {
    if (!log.isLevelEnabled('trace')) return;
    const paramStr = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    log.trace(`${method}(${paramStr})`);
  }

  /**
   * Column set for LIST views. Every real column EXCEPT the two heavy body
   * columns: `clean_body` is replaced by a bounded SNIPPET (a list row renders
   * only ~100 chars of preview) and `raw_body` by a `has_body` presence flag (so
   * the renderer can gate body-prefetch without materialising the full MIME).
   *
   * This is the list-query weight fix: the list views used `SELECT *`, pulling
   * BOTH full bodies into JS for every row on every page load. Detail / thread /
   * open use `SELECT *` (getById / getByThreadId) and are unaffected — and
   * `emails:fetchBody` is DB-first, so opening a snippet row loads its full body
   * from the DB cheaply (no IMAP). Built once from the LIVE schema so it stays
   * correct across migrations.
   */
  private _listSelect: string | null = null;
  /** Which has_body form `_listSelect` was built with, so the cache re-builds
   *  once the backfill completes mid-session instead of pinning the slow form
   *  until the next launch. */
  private _listSelectLengthsReady = false;
  private listSelect(): string {
    const lengthsReady = areBodyLengthsReady(this.db);
    if (this._listSelect && this._listSelectLengthsReady === lengthsReady) return this._listSelect;
    this._listSelectLengthsReady = lengthsReady;
    const cols = (this.db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => n !== 'clean_body' && n !== 'raw_body');
    this._listSelect =
      // Double-quote every column: some (e.g. `references`) are SQLite reserved
      // words and break the SELECT unquoted. Quoting is harmless for normal names
      // and the output column name stays the bare identifier, so row.references etc.
      // still resolve in rowToRecord.
      cols.map((c) => `"${c}"`).join(', ') +
      // Read through `email_bodies`; the inline column is NULL on a relocated row,
      // and a NULL preview here is not a visible error — every list row just
      // renders a blank second line.
      // Qualified with `emails` (every list query is `FROM emails`, unaliased) so
      // the correlated lookup can never resolve its `id` against a table someone
      // joins in later — that would silently return another row's body.
      `, ${cleanBodySnippetColumn('emails', 256)}` +
      // `has_body` used to be `LENGTH(raw_body) > 0`, which reads the WHOLE value:
      // SQLite's length-without-reading shortcut applies to BLOBs, not TEXT, so
      // every list row paid a walk of its overflow chain just to answer a yes/no.
      // `raw_body_len` answers it from an integer. The legacy form stays as the
      // fallback until this DB's backfill has proven no NULL remains — a NULL read
      // as 0 would tell the renderer a downloaded body is missing and re-trigger
      // prefetch for it forever.
      `, (${rawBodyLengthExpression('', lengthsReady)} > 0) AS has_body`;
    return this._listSelect;
  }

  /**
   * Insert a single email.
   *
   * Thin async wrapper over `insertSync` — kept for the many `await`ing callers.
   * Anything running INSIDE a `db.transaction()` callback must call `insertSync`
   * directly: better-sqlite3 transactions are synchronous, so an un-awaited
   * promise there turns a constraint failure into an unhandled rejection, the
   * transaction commits anyway, and the caller is told the mail was stored when
   * that row is missing (sync then advances its UID watermark past it).
   */
  async insert(email: EmailRecord): Promise<void> {
    this.insertSync(email);
  }

  /** Synchronous insert — safe inside a `db.transaction()` callback. */
  insertSync(email: EmailRecord): void {
    const db = this.db;
    // The header row, the body row and the thread key are ONE unit of work.
    // Without the transaction a crash between them leaves a row whose
    // `clean_body_len` says it has a body (the lengths are computed from the
    // bound parameters) while `email_bodies` has nothing — so the row is AI
    // eligible, reads as empty, and nothing ever repairs it. better-sqlite3
    // transactions nest as SAVEPOINTs, so this is safe inside the batch
    // transactions sync already wraps around thousands of these.
    this.insertUnitOfWork(db)(email);
  }

  /** Memoized per database handle: `db.transaction()` compiles its own SQL. */
  private _insertUnitOfWork: {
    db: Database.Database;
    run: (email: EmailRecord) => void;
  } | null = null;

  private insertUnitOfWork(db: Database.Database): (email: EmailRecord) => void {
    if (this._insertUnitOfWork?.db === db) return this._insertUnitOfWork.run;
    const run = db.transaction((email: EmailRecord) => this.insertRows(db, email));
    this._insertUnitOfWork = { db, run };
    return run;
  }

  private insertRows(db: Database.Database, email: EmailRecord): void {
    // Inline images out of the body and into the blob table BEFORE anything is
    // written, because `raw_body_len` below is computed from the bound parameter
    // and has to describe what actually gets stored. mailparser hands us
    // `parsed.html` with every `cid:` part already expanded to a base64 `data:`
    // URI, and that is 94.6% of all body bytes on the measured mailbox — so this
    // is where the multi-gigabyte growth is stopped, at the moment of first
    // write. The edges go in after the header row exists (FK). See
    // `inline-image-store.ts`.
    const { rawBody, hashes: imageHashes } = relocateBodyForInsert(db, email.rawBody);

    // Compiled ONCE per database handle, not once per row: a first sync inserts
    // tens of thousands of rows and `db.prepare()` re-parses the SQL on every
    // call — visible as `sqlite3RunParser` in a CPU profile of the main thread.
    const stmt = prepared(db, `
      INSERT INTO emails (
        id, message_id, thread_id, folder_id, uid, tags,
        subject, from_address, from_name, to_address, to_names,
        cc_address, cc_names, bcc_address, bcc_names, reply_to,
        date, received_date,
        clean_body, raw_body, clean_body_len, raw_body_len, content_type, content_hash,
        in_reply_to, "references",
        priority,
        has_attachments, attachment_count, attachment_names, attachment_sizes,
        calendar_ics, calendar_added,
        importance_score, importance_source,
        ai_processed_at, ai_confidence, ai_reasoning,
        snooze_until, snooze_original_tags,
        has_embedding, embedding_last_generated,
        auth_status,
        spam_score, spam_reasons, origin_ip
      ) VALUES (
        @id, @messageId, @threadId, @folderId, @uid, @tags,
        @subject, @fromAddress, @fromName, @toAddress, @toNames,
        @ccAddress, @ccNames, @bccAddress, @bccNames, @replyTo,
        @date, @receivedDate,
        -- The bodies go to email_bodies, not here. Two copies of a body is
        -- exactly the write amplification this replaces, and a stale inline copy
        -- would be indistinguishable from a current one. Empty string rather than
        -- NULL: it is the same zero bytes on disk, but it keeps the COALESCE in
        -- body-storage.ts total, so a body-less row reads back as '' exactly as
        -- it did before the move and no LIKE / length() predicate goes
        -- three-valued behind a caller's back.
        '', '',
        -- Computed in SQL, never in JS: SQLite's one-argument TRIM() strips
        -- U+0020 only while JS .trim() strips all whitespace, and LENGTH()
        -- counts characters while JS .length counts UTF-16 units. Deriving it
        -- here is the only way the stored integer cannot disagree with the
        -- LENGTH(TRIM(...)) expression it replaces. See body-metrics.ts.
        LENGTH(TRIM(@cleanBody)), LENGTH(TRIM(@rawBody)),
        @contentType, @contentHash,
        @inReplyTo, @references,
        @priority,
        @hasAttachments, @attachmentCount, @attachmentNames, @attachmentSizes,
        @calendarIcs, @calendarAdded,
        @importanceScore, @importanceSource,
        @aiProcessedAt, @aiConfidence, @aiReasoning,
        @snoozeUntil, @snoozeOriginalTags,
        @hasEmbedding, @embeddingLastGenerated,
        @authStatus,
        @spamScore, @spamReasons, @originIp
      )
    `);

    stmt.run({
      id: email.id,
      messageId: email.messageId,
      threadId: email.threadId,
      folderId: email.folderId,
      uid: email.uid,
      tags: email.tags || '||',
      subject: email.subject,
      fromAddress: email.fromAddress,
      fromName: email.fromName,
      toAddress: email.toAddress,
      toNames: email.toNames,
      ccAddress: email.ccAddress,
      ccNames: email.ccNames,
      bccAddress: email.bccAddress,
      bccNames: email.bccNames,
      replyTo: email.replyTo,
      date: email.date,
      receivedDate: email.receivedDate,
      cleanBody: email.cleanBody,
      rawBody,
      contentType: email.contentType,
      contentHash: email.contentHash,
      inReplyTo: email.inReplyTo,
      references: email.references,
      priority: email.priority,
      hasAttachments: email.hasAttachments ? 1 : 0,
      attachmentCount: email.attachmentCount,
      attachmentNames: email.attachmentNames,
      attachmentSizes: email.attachmentSizes ?? null,
      calendarIcs: email.calendarIcs ?? null,
      calendarAdded: email.calendarAdded ? 1 : 0,
      importanceScore: email.importanceScore || 0,
      importanceSource: email.importanceSource || 'none',
      aiProcessedAt: email.aiProcessedAt || null,
      aiConfidence: email.aiConfidence || 0,
      aiReasoning: email.aiReasoning || null,
      snoozeUntil: email.snoozeUntil || null,
      snoozeOriginalTags: email.snoozeOriginalTags || null,
      hasEmbedding: email.hasEmbedding ? 1 : 0,
      embeddingLastGenerated: email.embeddingLastGenerated,
      authStatus: email.authStatus ?? null,
      spamScore: email.spamScore ?? null,
      spamReasons: email.spamReasons ?? null,
      originIp: email.originIp ?? null,
    });

    // The body itself, in the side table. Must follow the `emails` insert: the
    // foreign key points that way, and the FTS trigger on this table reads the
    // header columns back out of `emails`.
    prepared(db, UPSERT_BODY_SQL).run({
      id: email.id,
      cleanBody: email.cleanBody ?? null,
      rawBody: rawBody ?? null,
    });

    // Now that the header row exists, the edges can point at it. Written even
    // when the list is empty: an insert cannot have stale edges, but going
    // through the same helper as every other site is what keeps the "edges are
    // rebuilt from the body" invariant one rule instead of two.
    writeImageLinks(db, email.id, imageHashes);

    // Written here, never derived at read time: the thread resolver's subject
    // fallback SEEKS on this key. A missing key row silently drops the email out
    // of that lookup, so its replies start new threads instead of joining it.
    writeThreadKey(db, email);
  }

  /**
   * Update an email
   */
  async update(id: string, updates: Partial<EmailRecord>): Promise<void> {
    // A row's server UID is scoped to its PRIMARY folder. When an update repoints
    // the primary folder (folder_id changes) but doesn't supply the destination
    // folder's UID, the old UID is meaningless there — and leaving it makes the
    // destination folder's deletion reconcile treat the stale UID as a server-side
    // deletion and destroy the row. That is the "restored mail vanishes from Inbox"
    // bug: a Trash->Inbox move kept the Trash UID, INBOX's next reconcile diffed it
    // against INBOX's server UIDs, found it absent, and deleted the row (only rows
    // re-synced first survived — "4 restored, 1 shows"). Clear the UID so the
    // destination's next sync stamps the correct one via linkEmail (which sets it
    // only when that folder is the row's primary). Mirrors the repoint in
    // unlinkOrDeleteFromFolder, which also nulls the UID on a primary change.
    const patch: Partial<EmailRecord> = { ...updates };
    if (updates.folderId !== undefined && updates.uid === undefined) {
      const cur = this.db
        .prepare('SELECT folder_id FROM emails WHERE id = ?')
        .get(id) as { folder_id?: string } | undefined;
      if (cur && cur.folder_id !== updates.folderId) {
        (patch as { uid?: number | null }).uid = null;
      }
    }
    // The bodies live in `email_bodies` (migration 73), so take them out of the
    // `emails` patch before the generic builder can write them there. What lands
    // inline is the empty sentinel, unconditionally: the value goes to the side
    // table, and two copies of a body is exactly the write amplification that
    // move removed.
    const { cleanBody, rawBody, ...headerPatch } = patch;
    const { setClauses, params } = this.buildUpdateClauses(headerPatch, {
      boolFields: ['hasAttachments', 'hasEmbedding', 'calendarAdded'],
    });
    if (cleanBody !== undefined) {
      setClauses.push("clean_body = ''");
      params.cleanBody = cleanBody;
    }
    if (rawBody !== undefined) {
      setClauses.push("raw_body = ''");
      params.rawBody = rawBody;
    }

    // Keep the length columns in step with any body write. This is the ONLY
    // update path that writes a body (the body prefetch/reheal both land here via
    // MessageProcessor.fetchBody -> storage.updateEmail), so a stale length can
    // only arise from a body written outside the repository — which would break
    // AI eligibility silently, since a wrong length means the row is judged to
    // have no body and quietly leaves the pipeline.
    //
    // These clauses are also what BINDS `@cleanBody`/`@rawBody`: better-sqlite3
    // rejects a named parameter the statement never mentions, so the conditions
    // here and above must stay identical (both test `!== undefined`).
    setClauses.push(...bodyLengthSetClauses(patch));

    // A body write is also the moment this row's content hash becomes knowable.
    // Ingest can only stamp the no-body marker (headers-first sync has no body
    // yet), so WITHOUT this the column stayed body-blind for the entire mailbox
    // — every "same hash means same content" reader was comparing subjects.
    // Hashed from the patch's body as FETCHED, before the inline-image
    // relocation below rewrites the raw part: the fetched form is what stays
    // identical across re-fetches, while the rewritten form depends on which
    // blobs the image store already had.
    //
    // Recomputed only when the patch actually carries body TEXT. An empty body
    // patch (a reheal that came back with nothing) leaves the existing value
    // alone rather than costing an extra read for the identity the no-body
    // marker is keyed on — and a row that already has a real hash must not be
    // downgraded to a marker by a failed fetch.
    const bodyHash = bodyContentHash(patch);
    if (bodyHash) {
      setClauses.push('content_hash = @contentHash');
      params.contentHash = bodyHash;
    }

    if (setClauses.length === 0) return;

    params.id = id;
    const updateSql = `
      UPDATE emails
      SET ${setClauses.join(', ')}
      WHERE id = @id
    `;

    // A body patch is TWO writes — the side row gets the value, the inline column
    // gets emptied — and they have to land together. Split across transactions, a
    // crash between them leaves a row whose inline body is gone and whose side
    // row was never written: `clean_body_len` says the body exists, so the reheal
    // scheduler never queues it, and it renders empty forever.
    const bodyUpsertSql = upsertBodyPatchSql(patch);
    if (!bodyUpsertSql) {
      prepared(this.db, updateSql).run(params);
    } else {
      const bodyParams: Record<string, unknown> = { id };
      if (cleanBody !== undefined) bodyParams.cleanBody = cleanBody;
      if (rawBody !== undefined) bodyParams.rawBody = rawBody;
      const db = this.db;
      db.transaction(() => {
        // Relocate inside the transaction, and bind the SAME rewritten string to
        // both statements: `raw_body_len` on the header row is computed from
        // `@rawBody`, so binding the original there and the ref form to the side
        // table would leave a length column that disagrees with the body it
        // describes — the exact stale-length failure the comment above warns
        // about, where a wrong length silently drops the email out of the AI
        // pipeline. The edges are rewritten here too, so a body that stopped
        // using an image stops pinning it.
        if (rawBody !== undefined) {
          const stored = rawBodyForStorage(db, id, rawBody);
          bodyParams.rawBody = stored;
          params.rawBody = stored;
        }

        // Body row FIRST, header second, and the order is a correctness detail
        // rather than taste: the FTS trigger on `emails` re-indexes a changed
        // `clean_body` only while no side row exists. Emptying the inline column
        // before the side row lands would satisfy that guard, re-tokenize the
        // email with an EMPTY body, and only then let the body trigger fix it —
        // two full tokenizations of the same body per fetched message, on the
        // path that runs for every message in the mailbox.
        prepared(db, bodyUpsertSql).run(bodyParams);
        prepared(db, updateSql).run(params);
      })();
    }

    // Keep the resolver's lookup key in step with `subject`/`date`. The
    // incomplete-envelope repair pass (getIncomplete -> update) rewrites both on
    // rows that were stored without them, and a stale key there is invisible:
    // the email stays findable only under its OLD key, so the resolver finds
    // nothing and the thread silently splits. Re-read from the row (rather than
    // trusting the patch) so a partial patch can never write a mismatched pair.
    if (patch.subject !== undefined || patch.date !== undefined) {
      const row = this.db
        .prepare('SELECT id, subject, date FROM emails WHERE id = ?')
        .get(id) as { id: string; subject: string | null; date: number } | undefined;
      if (row) writeThreadKey(this.db, row);
    }
  }

  /**
   * Get email by ID
   */
  async get(id: string): Promise<EmailRecord | null> {
    const row = this.db
      .prepare(`SELECT ${this.emailSelect()} FROM emails WHERE id = ?`)
      .get(id) as any;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Get email by Message-ID header
   */
  async getByMessageId(messageId: string): Promise<EmailRecord | null> {
    const row = this.db
      .prepare(`SELECT ${this.emailSelect()} FROM emails WHERE message_id = ?`)
      .get(messageId) as any;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Batch existence lookup — one query for many Message-IDs instead of a SELECT
   * per message (kills the sync N+1). Chunked to stay under SQLite's bound-
   * parameter limit.
   */
  async getByMessageIds(messageIds: string[]): Promise<EmailRecord[]> {
    if (messageIds.length === 0) return [];
    const results: EmailRecord[] = [];
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT ${this.emailSelect()} FROM emails WHERE message_id IN (${placeholders})`)
        .all(...chunk) as any[];
      for (const row of rows) results.push(this.rowToRecord(row));
    }
    return results;
  }

  /**
   * Batch fetch by primary id — one chunked `WHERE id IN (...)` query instead
   * of a SELECT per id (kills the N+1 when hydrating a set of ids). Chunked to
   * stay under SQLite's bound-parameter limit. Order is not guaranteed.
   */
  async getByIds(ids: string[]): Promise<EmailRecord[]> {
    if (ids.length === 0) return [];
    const results: EmailRecord[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT ${this.emailSelect()} FROM emails WHERE id IN (${placeholders})`)
        .all(...chunk) as any[];
      for (const row of rows) results.push(this.rowToRecord(row));
    }
    return results;
  }

  /**
   * Live engagement counts for a sender, computed straight from the mailbox so
   * they are always self-consistent — `read` and `deleted` are subsets of
   * `received`, so a ratio can never exceed 100%. Preferred over the running
   * sender_stats delta counters, which drift (read_count can overshoot).
   */
  async getSenderEngagement(email: string): Promise<{ received: number; read: number; deleted: number }> {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS received,
        SUM(CASE WHEN instr(tags, '|read|') > 0 THEN 1 ELSE 0 END) AS read,
        SUM(CASE WHEN instr(tags, '|Trash|') > 0 THEN 1 ELSE 0 END) AS deleted
      FROM emails
      WHERE LOWER(from_address) = ?
    `).get(email.toLowerCase().trim()) as { received: number; read: number; deleted: number } | undefined;
    return { received: row?.received || 0, read: row?.read || 0, deleted: row?.deleted || 0 };
  }

  /**
   * Get email by folder and UID
   */
  async getByFolderAndUid(folderId: string, uid: number): Promise<EmailRecord | null> {
    const row = this.db
      .prepare(`SELECT ${this.emailSelect()} FROM emails WHERE folder_id = ? AND uid = ?`)
      .get(folderId, uid) as any;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Batched (id, uid) resolve for a set of UIDs in one folder — the QRESYNC VANISHED
   * reconcile can hand thousands of UIDs, so this is one `IN (...)` query per chunk
   * (the caller keeps `uids.length` well under SQLite's 999-variable limit) rather
   * than a point lookup each. Selects only id/uid (no full row hydrate needed).
   */
  async getIdsByFolderAndUids(folderId: string, uids: number[]): Promise<Array<{ id: string; uid: number }>> {
    if (uids.length === 0) return [];
    const placeholders = uids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT id, uid FROM emails WHERE folder_id = ? AND uid IN (${placeholders})`)
      .all(folderId, ...uids) as Array<{ id: string; uid: number }>;
  }

  /**
   * Read a projection of EVERY row whose primary folder is `folderId`, in
   * keyset (not OFFSET) pages ordered by `uid`, yielding the event loop between
   * pages.
   *
   * Why keyset: `LIMIT ? OFFSET ?` makes page k re-walk k*pageSize qualifying
   * rows, so a full folder sweep is quadratic. `uid > lastUid` is a seek into
   * `idx_emails_folder_uid`, so every page costs the same. `(folder_id, uid)` is
   * unique (IMAP UIDs are unique within a mailbox), so the cursor can never skip
   * a row.
   *
   * Why not `stmt.iterate()` + yield: better-sqlite3 marks the connection busy
   * for the lifetime of an open iterator, so awaiting mid-iteration would make
   * any concurrent query throw "database connection is busy".
   *
   * `columns` is interpolated into the SQL — callers must pass a hardcoded
   * column list, never user input.
   */
  private async scanFolderByUid<T extends { uid: number }>(
    label: string,
    columns: string,
    folderId: string,
  ): Promise<T[]> {
    const stmt = this.db.prepare(`
      SELECT ${columns}
      FROM emails
      WHERE ${PRIMARY_FOLDER_WITH_UID_SQL} AND uid > ?
      ORDER BY uid ASC
      LIMIT ?
    `);

    const rows: T[] = [];
    let cursor = 0;
    for (;;) {
      const page = this.timed(
        label,
        () => stmt.all(folderId, cursor, FOLDER_SCAN_PAGE_SIZE) as T[],
        { folderId, cursor },
      );
      rows.push(...page);
      if (page.length < FOLDER_SCAN_PAGE_SIZE) break;
      cursor = page[page.length - 1].uid;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return rows;
  }

  /**
   * Lightweight `{id, uid}` for every email whose PRIMARY folder is `folderId`.
   * Used by non-CONDSTORE deletion detection to diff the whole folder's local
   * UIDs against the server's UID set.
   */
  async getUidsInFolder(folderId: string): Promise<Array<{ id: string; uid: number }>> {
    return this.scanFolderByUid<{ id: string; uid: number }>(
      'getUidsInFolder',
      'id, uid',
      folderId,
    );
  }

  /**
   * Lightweight `{id, uid, tags}` for every email whose PRIMARY folder is
   * `folderId` — the cheap counterpart to `getByFolder` for IMAP flag
   * reconciliation, which only ever reads those three fields.
   *
   * `getByFolder` is the wrong tool for that job: it adds ~6 correlated
   * THREAD_META subqueries per row, materialises `clean_body` + `raw_body` into
   * JS strings, filters with a non-sargable `instr(tags, ...)` full-table scan,
   * and paginates with OFFSET. This runs an index range scan over
   * `idx_emails_folder_uid` and reads three small columns — all of which sit
   * ahead of the body columns in the row, so SQLite never touches the body
   * overflow pages.
   */
  async getTagsInFolder(folderId: string): Promise<Array<{ id: string; uid: number; tags: string }>> {
    return this.scanFolderByUid<{ id: string; uid: number; tags: string }>(
      'getTagsInFolder',
      'id, uid, tags',
      folderId,
    );
  }

  /**
   * Count every email carrying `folderPath` as a folder-membership tag — the same
   * `instr(tags, '|path|')` membership the folder view renders, so it includes
   * cross-folder messages whose PRIMARY folder is elsewhere. The addition reconcile
   * uses this to tell a genuinely-absent server message from one that merely lives
   * primarily in another folder (already tag-linked and visible here).
   */
  countByFolderTag(folderPath: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM emails WHERE instr(tags, '|' || ? || '|') > 0`)
      .get(folderPath) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Rows FILED in this folder — primary `folder_id`, one row per message.
   * Indexed (idx_emails_folder_id), unlike the `instr(tags, …)` tag count which
   * cannot use an index; and unlike that count it never counts a message twice
   * under two names for the same mailbox.
   */
  countByPrimaryFolder(folderId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM emails WHERE folder_id = ?')
      .get(folderId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Tag-members of `folderPath` whose PRIMARY folder is another folder. See
   * IEmailStorage.getFolderMembersOutsideUidSpace.
   */
  getMembersOutsideUidSpace(
    folderId: string,
    folderPath: string,
  ): Array<{ id: string; messageId: string; folderId: string; uid: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT id, message_id, folder_id, uid FROM emails
         WHERE instr(tags, '|' || ? || '|') > 0 AND folder_id != ?`,
      )
      .all(folderPath, folderId) as Array<{ id: string; message_id: string; folder_id: string; uid: number | null }>;
    return rows.map((r) => ({ id: r.id, messageId: r.message_id, folderId: r.folder_id, uid: r.uid }));
  }

  /**
   * The LOWEST server UID among emails whose PRIMARY folder is `folderId`
   * (`null` when the folder holds no UID-bearing mail yet). The historical
   * backfill uses this as its starting floor — it pages older mail DOWNWARD from
   * the oldest UID we already have. Cheap: a MIN over the `(folder_id, uid)`
   * index, no row materialisation.
   */
  async getMinUidInFolder(folderId: string): Promise<number | null> {
    const row = this.db
      .prepare(`SELECT MIN(uid) AS minUid FROM emails WHERE ${PRIMARY_FOLDER_WITH_UID_SQL}`)
      .get(folderId) as { minUid: number | null } | undefined;
    return row?.minUid ?? null;
  }

  /**
   * Emails stored with an incomplete envelope — blank sender/subject or a
   * synthesized "<missing-...>" Message-ID (an empty ENVELOPE at ingest, e.g.
   * a partial/interrupted fetch). Used by the repair pass to re-fetch and
   * correct them, since incremental sync skips UIDs already in the DB.
   */
  async getIncomplete(limit: number): Promise<EmailRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${this.emailSelect()} FROM emails
         WHERE from_address IS NULL OR from_address = ''
            OR to_address IS NULL OR to_address = ''
            OR subject IS NULL OR subject = ''
            OR message_id LIKE '<missing-%'
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * Delete email by ID
   */
  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM emails WHERE id = ?').run(id);
  }

  /**
   * Delete multiple emails
   */
  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM emails WHERE id = ?');
    const deleteChunk = this.db.transaction((chunk: string[]) => {
      for (const id of chunk) stmt.run(id);
    });
    // Chunk + yield so a select-all permanent delete on a big mailbox doesn't
    // hold the synchronous main-process event loop in one long transaction.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      deleteChunk(ids.slice(i, i + CHUNK_SIZE));
      if (i + CHUNK_SIZE < ids.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  /**
   * Hard-delete emails that belong to this folder and NOTHING else.
   *
   * A message can carry several folder tags (Gmail labels, a reply in both Inbox
   * and Sent). This used to `DELETE WHERE instr(tags, '|path|') > 0`, which
   * destroyed every one of those rows outright — the message vanished from the
   * OTHER folders too, with no server event to bring it back. Rows with another
   * folder tag are left entirely alone here; dropping just this folder's
   * membership is `FolderRepository.invalidateFolderMembership`, which is what
   * `SqliteStorage.deleteEmailsByFolder` calls.
   *
   * Returns the number of rows actually deleted.
   */
  async deleteByFolder(folderId: string): Promise<number> {
    // Get folder path for tag matching
    const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
    if (!folder) return 0;

    // `tags` is `|a|b|c|`, so a row that belongs ONLY to this folder has exactly
    // this path between the delimiters and nothing else — modulo the non-folder
    // tags (read/starred/AI categories), which is why membership is compared
    // against the folders table rather than by counting tags.
    const candidates = this.db
      .prepare(`SELECT id, tags FROM emails WHERE instr(tags, '|' || ? || '|') > 0`)
      .all(folder.path) as Array<{ id: string; tags: string }>;
    if (candidates.length === 0) return 0;

    const folderPaths = new Set(
      (this.db.prepare('SELECT path FROM folders').all() as Array<{ path: string }>).map((f) => f.path),
    );
    const orphanIds = candidates
      .filter(({ tags }) => parseTags(tags || '||')
        .filter((tag) => folderPaths.has(tag))
        .every((tag) => tag === folder.path))
      .map(({ id }) => id);
    if (orphanIds.length === 0) return 0;

    const stmt = this.db.prepare('DELETE FROM emails WHERE id = ?');
    const deleteChunk = this.db.transaction((chunk: string[]) => {
      for (const id of chunk) stmt.run(id);
    });
    const CHUNK_SIZE = 500;
    for (let i = 0; i < orphanIds.length; i += CHUNK_SIZE) {
      deleteChunk(orphanIds.slice(i, i + CHUNK_SIZE));
      if (i + CHUNK_SIZE < orphanIds.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return orphanIds.length;
  }

  // ========== Query Methods — Zero JOINs ==========

  /**
   * Build the SQL for an active view filter (unread/starred/attachment) plus an
   * optional AI-category tag, ANDed onto a per-email list query. Shared by the
   * folder list and the unified All-Inboxes list so both honor an active filter.
   */
  private viewFilterSql(filter?: ViewFilter, categoryTag?: string): { sql: string; params: any[] } {
    const parts: string[] = [];
    const params: any[] = [];
    if (filter?.isUnread === true) parts.push("AND instr(tags, '|read|') = 0");
    else if (filter?.isUnread === false) parts.push("AND instr(tags, '|read|') > 0");
    if (filter?.isFlagged) parts.push("AND instr(tags, '|starred|') > 0");
    if (filter?.hasAttachments) parts.push('AND has_attachments = 1');
    if (categoryTag) { parts.push('AND instr(tags, ?) > 0'); params.push(`|${categoryTag}|`); }
    // "Unlabelled": exclude every enabled AI category (same slugs the chips use),
    // so only mail carrying none of them remains.
    if (filter?.noCategory) {
      // Exclude EVERY defined category slug (see search() — disabled-but-tagged
      // categories still render a badge, so they count as "labelled").
      const slugs = (this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[]).map((r) => r.slug);
      for (const slug of slugs) { parts.push("AND instr(tags, '|' || ? || '|') = 0"); params.push(slug); }
    }
    return { sql: parts.join(' '), params };
  }

  /**
   * Get emails by folder (via tags)
   */
  async getByFolder(folderId: string, options: PaginationOptions & { categoryTag?: string; collapseThreads?: boolean }): Promise<EmailRecord[]> {
    // Whitelist sort inputs — they're interpolated into the SQL
    let sortCol = this.camelToSnake(options.sortBy || 'date');
    if (!EMAIL_SORT_COLUMNS.has(sortCol)) sortCol = 'date';
    const sortDir = (options.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Get folder path for tag matching
    const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
    this.logQuery('getByFolder', { folderId, folderPath: folder?.path, limit: options.limit, offset: options.offset, sortBy: sortCol, sortOrder: sortDir });
    if (!folder) return [];

    // Read-model fast path: pull the folder's threads from the indexed
    // thread_folders projection (O(log n) keyset over the covering index)
    // instead of an unindexed instr(tags) full-table scan — the fix for the
    // per-folder scan storms on large mailboxes. Only when the CALLER opted into
    // thread-collapsed pages (the interactive view; bulk per-message callers
    // must not get cross-folder hydrated rows), the read-model is ready, AND the
    // query maps cleanly onto it: default date-descending order (the index's
    // order) and no per-category-slug filter (thread_folders has no per-slug
    // column). Anything else falls through to the legacy scan.
    if (options.collapseThreads && this.readModelReadsEnabled() && !options.categoryTag && sortCol === 'date' && sortDir === 'DESC') {
      return this.listFolderFast(folderId, { limit: options.limit, offset: options.offset, viewFilter: options.filter });
    }

    const excludeSpecial = this.getExcludeSpecialFolders(folder.path);
    const { sql: filterSql, params: filterParams } = this.viewFilterSql(options.filter, options.categoryTag);
    const rows = this.timed('getByFolder', () => this.db
      .prepare(`
        SELECT ${this.listSelect()}, ${THREAD_META}
        FROM emails
        WHERE instr(tags, '|' || ? || '|') > 0
        ${excludeSpecial}
        ${filterSql}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT ? OFFSET ?
      `)
      .all(folder.path, ...filterParams, options.limit, options.offset) as any[],
      { folder: folder.path, filter: options.filter },
    );

    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * How many messages `getByFolder` would return for this folder under the same
   * view filter / category — the "of N" for a per-message folder listing.
   *
   * Shares `getByFolder`'s WHERE (folder tag + special-folder exclusions + the
   * view filter), so the count and the list can't disagree. Message-level, like
   * the list it heads — it does NOT collapse threads.
   */
  async countByFolder(folderId: string, options: { filter?: ViewFilter; categoryTag?: string } = {}): Promise<number> {
    const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
    if (!folder) return 0;
    const excludeSpecial = this.getExcludeSpecialFolders(folder.path);
    const { sql: filterSql, params: filterParams } = this.viewFilterSql(options.filter, options.categoryTag);
    const result = this.timed('countByFolder', () => this.db
      .prepare(`
        SELECT COUNT(*) as count
        FROM emails
        WHERE instr(tags, '|' || ? || '|') > 0
        ${excludeSpecial}
        ${filterSql}
      `)
      .get(folder.path, ...filterParams) as { count: number },
      { folder: folder.path, filter: options.filter },
    );
    return result?.count ?? 0;
  }

  /**
   * "All Email" (Trash/Spam/Drafts/Sent excluded) — paged by CONVERSATION.
   *
   * The list renders one row per conversation, so the page window has to be
   * conversations too: a message-grained LIMIT 100 collapsed to however many
   * rows those 100 messages happened to belong to, and split a thread across
   * the page boundary. See {@link getStarred} — same bug, same shape.
   */
  async getAll(options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    this.logQuery('getAll', { limit, offset });
    return this.listAllMailThreads(limit, offset);
  }

  /**
   * Get starred emails (excluding Trash/Spam) — paged by CONVERSATION.
   *
   * The list renders one row per conversation, so the page window has to be
   * conversations too: a message-grained LIMIT 50 collapsed to 15 visible rows
   * and split a thread across the page boundary.
   */
  async getStarred(options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    this.logQuery('getStarred', { limit, offset });
    return this.listFlagViewThreads('starred', limit, offset);
  }

  /**
   * Get important emails (excluding Trash/Spam) — paged by CONVERSATION, see
   * {@link getStarred}.
   */
  async getImportant(options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    this.logQuery('getImportant', { limit, offset });
    return this.listFlagViewThreads('important', limit, offset);
  }

  /**
   * The Snoozed view — paged by CONVERSATION, soonest back first.
   *
   * The list renders one row per conversation, so the window and the "of N"
   * have to be conversations too; see {@link getStarred} for the same bug in
   * the other folder-less views.
   *
   * Unlike those, this hydrates only the SNOOZED messages of the page's
   * conversations rather than every message they hold: the view exists to show
   * what is coming back and when, so mail that already arrived is not part of
   * it. It also keeps the guarantee every caller relies on — each returned row
   * carries a `snoozeUntil`, which is what makes a snooze record out of it.
   */
  async getSnoozed(options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    this.logQuery('getSnoozed', { limit, offset });

    const tids = this.timed('listSnoozed', () => this.db
      .prepare(snoozedThreadsPageSql())
      .all(limit, offset) as { tid: string }[], { limit, offset });
    if (tids.length === 0) return [];

    const threadIds = tids.map((t) => t.tid);
    const placeholders = threadIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`
        SELECT ${this.listSelect()}, ${THREAD_META} FROM emails
        WHERE instr(tags, '|snoozed|') > 0
          AND snooze_until IS NOT NULL
          AND COALESCE(thread_id, id) IN (${placeholders})
        ORDER BY snooze_until ASC
      `)
      .all(...threadIds) as any[];

    return orderByThreadRank(rows.map(row => this.rowToRecord(row)), threadIds);
  }

  /**
   * Get due snoozed emails (snooze_until <= now)
   */
  async getDueSnoozed(): Promise<EmailRecord[]> {
    const now = this.now();
    const rows = this.db
      .prepare(`
        SELECT ${this.emailSelect()} FROM emails
        WHERE instr(tags, '|snoozed|') > 0
          AND snooze_until IS NOT NULL
          AND snooze_until <= ?
      `)
      .all(now) as any[];

    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Get emails by thread
   */
  async getByThread(threadId: string): Promise<EmailRecord[]> {
    this.logQuery('getByThread', { threadId });
    // Exclude Trash/Spam/Junk copies — a message the user deleted (moved to
    // Trash) must not reappear in the conversation. Without this, a trashed
    // draft kept getting reattached to its thread by subject+participants and
    // showing up again after every delete (matches Gmail: trashing a message
    // removes it from the conversation view).
    const excludeTrash = threadFolderExclusion('emails');
    let rows = this.db
      .prepare(`SELECT ${this.emailSelect()} FROM emails WHERE thread_id = ? ${excludeTrash} ORDER BY date ASC`)
      .all(threadId) as any[];

    // If the exclusion empties the thread, the WHOLE conversation lives in
    // Trash/Spam/Junk (e.g. the user is viewing the Junk folder). The exclusion
    // is only meant to hide trashed/spam copies from an otherwise-normal
    // conversation — it shouldn't make an all-junk thread un-openable (it would
    // collapse to a single message). Fall back to the unfiltered thread.
    if (rows.length === 0) {
      rows = this.db
        .prepare(`SELECT ${this.emailSelect()} FROM emails WHERE thread_id = ? ORDER BY date ASC`)
        .all(threadId) as any[];
    }

    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Get emails by AI category tag (e.g., 'important', 'needs_response')
   */
  async getByCategory(
    categorySlug: string,
    options: { limit?: number; offset?: number; folderId?: string; filter?: ViewFilter } = {}
  ): Promise<EmailRecord[]> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    this.logQuery('getByCategory', { categorySlug, limit, offset, folderId: options.folderId });

    // An active view filter (unread/starred/attachment) is literal SQL with no
    // bound params, so category tabs honor it without disturbing param order.
    const { sql: filterSql } = this.viewFilterSql(options.filter);

    let sql: string;
    const params: any[] = [categorySlug];

    if (options.folderId) {
      const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(options.folderId) as any;
      if (!folder) return [];
      sql = `
        SELECT ${this.emailSelect()} FROM emails
        WHERE instr(tags, '|' || ? || '|') > 0
          AND instr(tags, '|' || ? || '|') > 0
          ${filterSql}
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `;
      params.push(folder.path, limit, offset);
    } else {
      sql = `
        SELECT ${this.emailSelect()} FROM emails
        WHERE instr(tags, '|' || ? || '|') > 0
          ${filterSql}
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Get uncategorized emails (AI processed but no category tags)
   */
  async getUncategorized(
    categorySlugs: string[],
    options: { limit?: number; offset?: number; folderId?: string } = {}
  ): Promise<EmailRecord[]> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    this.logQuery('getUncategorized', { excludeSlugs: categorySlugs.length, limit, offset, folderId: options.folderId });

    // Build conditions to exclude all known categories
    const excludeConditions = categorySlugs
      .map(() => `AND instr(tags, '|' || ? || '|') = 0`)
      .join('\n        ');

    const params: any[] = [...categorySlugs];

    let folderCondition = '';
    if (options.folderId) {
      const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(options.folderId) as any;
      if (!folder) return [];
      folderCondition = `AND instr(tags, '|' || ? || '|') > 0`;
      params.push(folder.path);
    }

    params.push(limit, offset);

    const rows = this.db.prepare(`
      SELECT ${this.emailSelect()} FROM emails
      WHERE ai_processed_at IS NOT NULL
        AND instr(tags, '|spam|') = 0
        ${excludeConditions}
        ${folderCondition}
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `).all(...params) as any[];

    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Search emails with filters
   */
  async search(query: SearchQuery): Promise<EmailRecord[]> {
    this.logQuery('search', { folderPath: query.folderPath, scope: query.scope, aiCategory: query.aiCategory, from: query.from, to: query.to, subject: query.subject, isUnread: query.isUnread, isFlagged: query.isFlagged, hasAttachments: query.hasAttachments, limit: query.limit });
    let sql = `SELECT ${this.listSelect()}, ${THREAD_META} FROM emails WHERE 1=1`;
    const params: any[] = [];

    // Folder scoping: specific folder or "all" (excludes special folders)
    if (query.folderPath) {
      sql += ` AND instr(tags, '|' || ? || '|') > 0`;
      params.push(query.folderPath);
      // Exclude emails that are also in Trash/Spam (unless searching IN Trash/Spam)
      const excludeSpecial = this.getExcludeSpecialFolders(query.folderPath);
      sql += ` ${excludeSpecial}`;
    } else if (query.scope === 'all' || (!query.folderPath && !query.folderIds?.length)) {
      // "All Email" scope: the same exclusions the All Email list uses, so a
      // search across everything covers exactly what that list shows.
      sql += `
          ${EXCLUDE_NON_MAIL_SQL}`;
    }

    // Legacy folderIds support
    if (query.folderIds && query.folderIds.length > 0) {
      for (const folderId of query.folderIds) {
        const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
        if (folder) {
          sql += ` AND instr(tags, '|' || ? || '|') > 0`;
          params.push(folder.path);
        }
      }
    }

    // AI category filter
    if (query.aiCategory) {
      sql += ` AND instr(tags, '|' || ? || '|') > 0`;
      params.push(query.aiCategory);
    }

    // "Unlabelled" filter — mail carrying NONE of the enabled AI categories.
    // Excludes every enabled category slug (same slugs the category chips use),
    // so a mail with any category drops out.
    if (query.noCategory) {
      // Exclude EVERY defined category slug (not just is_enabled=1) — a mail can
      // carry a tag for a category that's since been disabled, and it still shows
      // a badge (badges read all slugs), so it must count as "labelled".
      const slugs = (this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[]).map((r) => r.slug);
      for (const slug of slugs) {
        sql += ` AND instr(tags, '|' || ? || '|') = 0`;
        params.push(slug);
      }
    }

    if (query.threadIds && query.threadIds.length > 0) {
      sql += ` AND thread_id IN (${query.threadIds.map(() => '?').join(',')})`;
      params.push(...query.threadIds);
    }

    if (query.from) {
      sql += ` AND from_address LIKE ? ESCAPE '\\'`;
      params.push(this.likeContains(query.from));
    }

    if (query.to) {
      sql += ` AND to_address LIKE ? ESCAPE '\\'`;
      params.push(this.likeContains(query.to));
    }

    if (query.subject) {
      sql += ` AND subject LIKE ? ESCAPE '\\'`;
      params.push(this.likeContains(query.subject));
    }

    if (query.hasAttachments !== undefined) {
      sql += ` AND has_attachments = ?`;
      params.push(query.hasAttachments ? 1 : 0);
    }

    if (query.isUnread !== undefined) {
      sql += query.isUnread
        ? ` AND instr(tags, '|read|') = 0`
        : ` AND instr(tags, '|read|') > 0`;
    }

    if (query.isFlagged !== undefined) {
      sql += query.isFlagged
        ? ` AND instr(tags, '|starred|') > 0`
        : ` AND instr(tags, '|starred|') = 0`;
    }

    if (query.dateFrom) {
      sql += ` AND date >= ?`;
      params.push(query.dateFrom);
    }

    if (query.dateTo) {
      sql += ` AND date <= ?`;
      params.push(query.dateTo);
    }

    // Text search (subject + body)
    if (query.query?.trim()) {
      sql += ` AND (subject LIKE ? ESCAPE '\\' OR ${cleanBodyExpression()} LIKE ? ESCAPE '\\'`
        + ` OR ${rawBodyExpression()} LIKE ? ESCAPE '\\')`;
      const q = this.likeContains(query.query.trim());
      params.push(q, q, q);
    }

    // Whitelist sort inputs — they're interpolated into the SQL
    let sortCol = this.camelToSnake(query.sortBy || 'date');
    if (!EMAIL_SORT_COLUMNS.has(sortCol)) sortCol = 'date';
    const sortDir = (query.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortCol} ${sortDir}`;

    if (query.limit) {
      sql += ` LIMIT ?`;
      params.push(query.limit);
    }

    if (query.offset) {
      sql += ` OFFSET ?`;
      params.push(query.offset);
    }

    const rows = this.timed('search', () => this.db.prepare(sql).all(...params) as any[],
      { folder: query.folderPath, scope: query.scope });
    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Full text search using LIKE
   */
  async fullTextSearch(query: string, options?: SearchQuery): Promise<EmailRecord[]> {
    this.logQuery('fullTextSearch', { query, limit: options?.limit, folderIds: options?.folderIds?.length });
    const searchTerm = this.likeContains(query);

    let sql = `
      SELECT ${this.emailSelect()} FROM emails
      WHERE (
        subject LIKE ? ESCAPE '\\' OR
        from_address LIKE ? ESCAPE '\\' OR
        from_name LIKE ? ESCAPE '\\' OR
        to_address LIKE ? ESCAPE '\\' OR
        ${cleanBodyExpression()} LIKE ? ESCAPE '\\'
      )
    `;

    const params: any[] = [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm];

    if (options?.folderIds && options.folderIds.length > 0) {
      for (const folderId of options.folderIds) {
        const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
        if (folder) {
          sql += ` AND instr(tags, '|' || ? || '|') > 0`;
          params.push(folder.path);
        }
      }
    }

    sql += ` ORDER BY date DESC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    } else {
      sql += ` LIMIT 100`;
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Get recently synced emails
   */
  async getRecent(options: { sinceTimestamp: number; limit?: number }): Promise<EmailRecord[]> {
    const limit = options.limit || 50;
    this.logQuery('getRecent', { sinceTimestamp: options.sinceTimestamp, limit });

    const rows = this.db
      .prepare(`
        SELECT ${this.emailSelect()} FROM emails
        WHERE received_date >= ? OR date >= ?
        ORDER BY received_date DESC
        LIMIT ?
      `)
      .all(options.sinceTimestamp, options.sinceTimestamp, limit) as any[];

    return rows.map(row => this.rowToRecord(row));
  }

  // ========== Count Methods ==========

  /**
   * How many CONVERSATIONS the "All Email" list holds — the "of N" that heads
   * it, in the same unit {@link getAll} pages by, so the denominator can never
   * promise a page the list doesn't have (or hide one it does).
   */
  async getAllCount(): Promise<number> {
    return this.countAllMailThreads();
  }

  /** The "of N" heading the Important view — CONVERSATIONS, the same unit
   *  {@link getImportant} pages by, so the denominator can never promise pages
   *  the list cannot show. */
  async getImportantCount(): Promise<number> {
    return this.countFlagViewThreads('important');
  }

  /** The "of N" heading the Starred view — CONVERSATIONS, see
   *  {@link getImportantCount}. */
  async getStarredCount(): Promise<number> {
    return this.countFlagViewThreads('starred');
  }

  async getUnreadImportantCount(): Promise<number> {
    const result = this.db
      .prepare(`
        SELECT COUNT(*) as count FROM emails
        WHERE instr(tags, '|important|') > 0
          AND instr(tags, '|read|') = 0
      `)
      .get() as { count: number };
    return result.count;
  }

  /** The "of N" heading the Snoozed view, and the sidebar's snoozed badge —
   *  CONVERSATIONS, the unit {@link getSnoozed} pages by, under exactly the same
   *  predicate. It used to count the TAG alone: a row tagged `|snoozed|` with no
   *  `snooze_until` was counted but could never be listed, so the badge and the
   *  header both promised mail that did not exist. */
  async getSnoozedCount(): Promise<number> {
    const row = this.timed('countSnoozed', () => this.db
      .prepare(`SELECT COUNT(*) as count FROM (${snoozedThreadsSql('')})`)
      .get() as { count: number });
    return row.count;
  }

  /**
   * Mark all sent folder emails as read
   */
  async markSentAsRead(): Promise<number> {
    // Find emails with sent folder tags that aren't read
    const unreadSent = this.db
      .prepare(`
        SELECT id, tags FROM emails
        WHERE (${SENT_FOLDER_TAG_SQL})
          AND instr(tags, '|read|') = 0
      `)
      .all() as { id: string; tags: string }[];

    if (unreadSent.length === 0) return 0;

    const updateStmt = this.db.prepare('UPDATE emails SET tags = ? WHERE id = ?');
    let updated = 0;

    for (const email of unreadSent) {
      const newTags = addTag(email.tags, 'read');
      updateStmt.run(newTags, email.id);
      updated++;
    }

    return updated;
  }

  // ========== Section Queries (per-section independent pagination) ==========

  /** Build SQL to exclude special folders, optionally keeping the current folder visible */
  private getExcludeSpecialFolders(currentFolderPath?: string): string {
    return listingExclusion(currentFolderPath);
  }

  /** SQL fragment to scope to a folder path (if provided) */
  private folderScope(folderPath?: string): { sql: string; params: any[] } {
    if (!folderPath) return { sql: '', params: [] };
    return { sql: `AND instr(tags, '|' || ? || '|') > 0`, params: [folderPath] };
  }

  /**
   * Helper: fetch emails by thread-based pagination using HAVING for thread-level filtering.
   * Uses HAVING instead of WHERE so section membership is determined by the entire thread,
   * not individual emails. This prevents threads from appearing in multiple sections.
   */
  private getSectionByThreads(havingClause: string, options: { limit: number; offset: number; folderPath?: string; orderBy?: string; viewFilter?: ViewFilter }): EmailRecord[] {
    const folder = this.folderScope(options.folderPath);
    const excludeSpecial = this.getExcludeSpecialFolders(options.folderPath);
    // A quick-filter (unread/read/starred/attachment/unlabelled) is a THREAD-level
    // condition ANDed into the section's HAVING — NOT a per-email WHERE. Applied
    // per-email it would keep a thread that merely CONTAINS one matching mail (e.g.
    // one uncategorized reply) and the outer query would then still show the whole
    // thread, including its labelled mail. Thread-level (e.g. "no email in the
    // thread is categorized") matches how the sections themselves are defined.
    const vf = this.viewFilterThreadHaving(options.viewFilter);
    const orderBy = options.orderBy || 'MAX(date) DESC';
    const rows = this.timed('getSectionByThreads', () => this.db
      .prepare(`
        SELECT ${this.listSelect()}, ${THREAD_META} FROM emails
        WHERE COALESCE(thread_id, id) IN (
          SELECT COALESCE(thread_id, id) as tid FROM emails
          WHERE 1=1
            ${excludeSpecial}
            ${folder.sql}
          GROUP BY tid
          HAVING ${havingClause}
            ${vf.sql}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?
        )
        ORDER BY date DESC
      `)
      .all(...folder.params, ...vf.params, options.limit, options.offset) as any[],
      { folder: options.folderPath, having: havingClause.slice(0, 40) },
    );
    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Thread-level HAVING conditions for a quick-filter, ANDed into a section's
   * own HAVING. Every condition is whole-conversation (matches THREAD_HAS_STARRED
   * / liveUnreadSum semantics) so a filtered section shows the same threads the
   * sections themselves would. Returns '' + [] when no filter is active.
   * - isUnread true/false  -> thread has any live-unread mail / thread all-read
   * - isFlagged            -> thread has a starred mail
   * - hasAttachments       -> thread has a mail with an attachment
   * - noCategory           -> thread has NO categorized mail (true "unlabelled")
   */
  private viewFilterThreadHaving(filter?: ViewFilter): { sql: string; params: any[] } {
    if (!filter) return { sql: '', params: [] };
    const parts: string[] = [];
    const params: any[] = [];
    if (filter.isUnread === true) parts.push(`${liveUnreadSum()} > 0`);
    else if (filter.isUnread === false) parts.push(`${liveUnreadSum()} = 0`);
    if (filter.isFlagged) parts.push(THREAD_HAS_STARRED);
    if (filter.hasAttachments) parts.push(threadTagExists('vha', 'vha.has_attachments = 1'));
    if (filter.noCategory) {
      // A thread is "unlabelled" only if NONE of its mail carries ANY defined AI
      // category slug (disabled-but-tagged categories still render a badge, so
      // they count as labelled — same rule as search()/viewFilterSql).
      const slugs = (this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[]).map((r) => r.slug);
      if (slugs.length > 0) {
        const cond = slugs.map(() => "instr(vcat.tags, '|' || ? || '|') > 0").join(' OR ');
        parts.push(`NOT ${threadTagExists('vcat', `(${cond})`)}`);
        params.push(...slugs);
      }
    }
    if (parts.length === 0) return { sql: '', params: [] };
    return { sql: 'AND ' + parts.join(' AND '), params };
  }

  /**
   * Get important AND unread emails (section query) — threads with at least one important+unread email
   */
  async getImportantUnread(options: { limit: number; offset: number; folderPath?: string }): Promise<EmailRecord[]> {
    this.logQuery('getImportantUnread', { limit: options.limit, offset: options.offset, folderPath: options.folderPath });
    return this.getSectionByThreads(
      THREAD_HAS_IMPORTANT_UNREAD,
      { ...options, orderBy: 'MAX(COALESCE(priority_score, 0)) DESC, MAX(date) DESC' }
    );
  }

  /**
   * Get starred threads that are NOT already in important+unread section
   */
  async getStarredNotImportantUnread(options: { limit: number; offset: number; folderPath?: string }): Promise<EmailRecord[]> {
    this.logQuery('getStarredNotImportantUnread', { limit: options.limit, offset: options.offset, folderPath: options.folderPath });
    return this.getSectionByThreads(
      `${THREAD_HAS_STARRED} AND NOT ${THREAD_HAS_IMPORTANT_UNREAD}`,
      options
    );
  }

  /**
   * Get everything else — threads with NO important+unread email AND NO starred email
   */
  async getEverythingElse(options: { limit: number; offset: number; folderPath?: string }): Promise<EmailRecord[]> {
    this.logQuery('getEverythingElse', { limit: options.limit, offset: options.offset, folderPath: options.folderPath });
    return this.getSectionByThreads(
      `NOT ${THREAD_HAS_IMPORTANT_UNREAD} AND NOT ${THREAD_HAS_STARRED}`,
      options
    );
  }

  /**
   * Get unread threads (for unread_first inbox) — threads with at least one unread email
   */
  async getUnreadSection(options: { limit: number; offset: number; folderPath?: string }): Promise<EmailRecord[]> {
    this.logQuery('getUnreadSection', { limit: options.limit, offset: options.offset, folderPath: options.folderPath });
    return this.getSectionByThreads(
      `${liveUnreadSum()} > 0`,
      options
    );
  }

  /**
   * Get important threads (for important_first inbox) — threads with at least one important email
   */
  async getImportantSection(options: { limit: number; offset: number; folderPath?: string }): Promise<EmailRecord[]> {
    this.logQuery('getImportantSection', { limit: options.limit, offset: options.offset, folderPath: options.folderPath });
    return this.getSectionByThreads(
      THREAD_HAS_IMPORTANT,
      { ...options, orderBy: 'MAX(COALESCE(priority_score, 0)) DESC, MAX(date) DESC' }
    );
  }

  /**
   * Get threads with NO important email (for important_first everything_else)
   */
  async getNotImportantSection(options: { limit: number; offset: number; folderPath?: string }): Promise<EmailRecord[]> {
    this.logQuery('getNotImportantSection', { limit: options.limit, offset: options.offset, folderPath: options.folderPath });
    return this.getSectionByThreads(
      `NOT ${THREAD_HAS_IMPORTANT}`,
      options
    );
  }

  /**
   * Get threads where ALL emails are read (for unread_first everything_else)
   */
  async getReadSection(options: { limit: number; offset: number; folderPath?: string }): Promise<EmailRecord[]> {
    this.logQuery('getReadSection', { limit: options.limit, offset: options.offset, folderPath: options.folderPath });
    return this.getSectionByThreads(
      `${liveUnreadSum()} = 0`,
      options
    );
  }

  // ========== Read-model cutover (docs/READ_MODEL_PLAN.md) ==========
  // When the backfill is complete, section reads are served from thread_folders
  // (a flat indexed scan) instead of the legacy GROUP BY + correlated EXISTS.
  // ON by default once status='complete'. KILL-SWITCH: SARVINBOX_READMODEL_READS=0
  // forces the legacy path (instant rollback, no redeploy) — any other value /
  // unset means default-on-when-ready. Gated on 'complete' so it never serves a
  // half-built model.

  /** Section filter -> a boolean predicate over thread_folders (tf.) columns.
   *  Mirrors the legacy HAVING clauses one-for-one. Static (no params). */
  private static readonly SECTION_FLAG_SQL: Record<string, string> = {
    important_unread: 'AND tf.has_important_unread = 1',
    starred: 'AND tf.has_flagged = 1 AND tf.has_important_unread = 0',
    everything_else: 'AND tf.has_important_unread = 0 AND tf.has_flagged = 0',
    important: 'AND tf.has_important = 1',
    unread: 'AND tf.has_unread = 1',
    not_important: 'AND tf.has_important = 0',
    read: 'AND tf.has_unread = 0',
  };
  /** Sections the legacy path orders by priority-then-date (vs date-only). */
  private static readonly PRIORITY_SECTIONS = new Set(['important_unread', 'important']);

  /** True when reads should use the materialized read-model. Default ON once the
   *  backfill is complete; SARVINBOX_READMODEL_READS=0 is the kill-switch. */
  readModelReadsEnabled(): boolean {
    return readModelComplete(this.db);
  }

  /** Resolve a folder path to its id (the read-model is folder-id keyed). */
  folderIdForPath(folderPath?: string): string | null {
    if (!folderPath) return null;
    const row = this.db.prepare('SELECT id FROM folders WHERE path = ?').get(folderPath) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** A quick-filter -> boolean predicate over thread_folders (tf.) columns. */
  private viewFilterFlagSql(filter?: ViewFilter): string {
    if (!filter) return '';
    const parts: string[] = [];
    if (filter.isUnread === true) parts.push('AND tf.has_unread = 1');
    else if (filter.isUnread === false) parts.push('AND tf.has_unread = 0');
    if (filter.isFlagged) parts.push('AND tf.has_flagged = 1');
    if (filter.hasAttachments) parts.push('AND tf.has_attachment = 1');
    if (filter.noCategory) parts.push('AND tf.has_category = 0');
    return parts.join(' ');
  }

  /** Hydrate a page of thread ids into list rows — the SAME shape/order the
   *  legacy outer query returns (all emails of those threads, newest-first, with
   *  THREAD_META), so the renderer/client threading is unchanged. */
  private hydrateThreads(threadIds: string[], preserveThreadOrder = false): EmailRecord[] {
    if (threadIds.length === 0) return [];
    const placeholders = threadIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT ${this.listSelect()}, ${THREAD_META} FROM emails
      WHERE COALESCE(thread_id, id) IN (${placeholders})
      ORDER BY date DESC
    `).all(...threadIds) as any[];
    const records = rows.map((row) => this.rowToRecord(row));
    if (!preserveThreadOrder) return records;
    return orderByThreadRank(records, threadIds);
  }

  /** Read-model section listing: pick the page's thread ids from thread_folders
   *  (flat indexed scan) then hydrate. Assumes readModelReadsEnabled() +
   *  folderIdForPath() were checked by the caller. */
  async listSectionFast(filter: string, folderId: string, options: { limit: number; offset: number; viewFilter?: ViewFilter }): Promise<EmailRecord[]> {
    const sectionSql = EmailRepository.SECTION_FLAG_SQL[filter];
    if (sectionSql === undefined) return [];
    const vfSql = this.viewFilterFlagSql(options.viewFilter);
    const orderBy = EmailRepository.PRIORITY_SECTIONS.has(filter)
      ? 'tf.max_priority_score DESC, tf.last_message_date DESC, tf.thread_id DESC'
      : 'tf.last_message_date DESC, tf.thread_id DESC';
    const tids = this.timed('listSectionFast', () => this.db.prepare(`
      SELECT tf.thread_id FROM thread_folders tf
      WHERE tf.folder_id = ? ${sectionSql} ${vfSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(folderId, options.limit, options.offset) as { thread_id: string }[],
      { filter, folderId });
    return this.hydrateThreads(tids.map((t) => t.thread_id));
  }

  /** Read-model section count: a flat COUNT over thread_folders. */
  countSectionFast(filter: string, folderId: string, viewFilter?: ViewFilter): number {
    const sectionSql = EmailRepository.SECTION_FLAG_SQL[filter];
    if (sectionSql === undefined) return 0;
    const vfSql = this.viewFilterFlagSql(viewFilter);
    const row = this.timed('countSectionFast', () => this.db.prepare(`
      SELECT COUNT(*) as count FROM thread_folders tf
      WHERE tf.folder_id = ? ${sectionSql} ${vfSql}
    `).get(folderId) as { count: number },
      { filter, folderId });
    return row.count;
  }

  /** Read-model folder listing: every thread in a folder, newest-first, via the
   *  indexed thread_folders projection (the plain-folder analogue of
   *  listSectionFast — no section flag predicate). Replaces getByFolder's
   *  unindexed instr(tags) full-table scan. Caller guarantees
   *  readModelReadsEnabled() + a date-descending sort (the covering index's
   *  order). Thread-grained pagination — LIMIT/OFFSET count threads, then
   *  hydrateThreads expands each to its messages (same shape as the section
   *  path, so a thread never splits across a page boundary). */
  async listFolderFast(folderId: string, options: { limit: number; offset: number; viewFilter?: ViewFilter }): Promise<EmailRecord[]> {
    const vfSql = this.viewFilterFlagSql(options.viewFilter);
    const tids = this.timed('listFolderFast', () => this.db.prepare(`
      SELECT tf.thread_id FROM thread_folders tf
      WHERE tf.folder_id = ? ${vfSql}
      ORDER BY tf.last_message_date DESC, tf.thread_id DESC
      LIMIT ? OFFSET ?
    `).all(folderId, options.limit, options.offset) as { thread_id: string }[],
      { folderId });
    return this.hydrateThreads(tids.map((t) => t.thread_id));
  }

  /** Read-model folder count: a flat COUNT over thread_folders for the folder
   *  (thread-grained — the pagination unit listFolderFast uses, so it's the
   *  correct "of N" denominator for a folder view). */
  countFolderFast(folderId: string, viewFilter?: ViewFilter): number {
    const vfSql = this.viewFilterFlagSql(viewFilter);
    const row = this.timed('countFolderFast', () => this.db.prepare(`
      SELECT COUNT(*) as count FROM thread_folders tf
      WHERE tf.folder_id = ? ${vfSql}
    `).get(folderId) as { count: number },
      { folderId });
    return row.count;
  }

  /**
   * The folder-LESS flag views (Starred, Important). Unlike a folder or section
   * listing there is no `folderPath` to key `thread_folders` by, so these read
   * the conversation-wide LIVE flags straight off `threads` — which is exactly
   * the semantics the old per-message query was reaching for (a starred message
   * in Trash doesn't make the thread starred).
   *
   * `tag` drives the legacy fallback's HAVING; `column` the read-model scan.
   * Important sorts by priority first, matching the old message-level ORDER BY.
   */
  /** One page of a flag view, THREAD-grained: pick the page's conversations,
   *  then hydrate each to all of its messages (the same shape the section and
   *  folder fast paths return, so a thread never straddles a page boundary). */
  private listFlagViewThreads(view: FlagView, limit: number, offset: number): EmailRecord[] {
    if (this.readModelReadsEnabled()) {
      const tids = this.timed(`listFlagView:${view}`, () => this.db
        .prepare(flagViewPageSql(view))
        .all(limit, offset) as { id: string }[], { view });
      return this.hydrateThreads(tids.map((t) => t.id), true);
    }

    const rows = this.timed(`listFlagViewLegacy:${view}`, () => this.db
      .prepare(flagViewLegacySql(view, `ORDER BY ${FLAG_VIEWS[view].legacyOrderBy} LIMIT ? OFFSET ?`))
      .all(limit, offset) as { tid: string }[], { view });
    return this.hydrateThreads(rows.map((r) => r.tid), true);
  }

  /** How many CONVERSATIONS a flag view holds — the pagination unit
   *  {@link listFlagViewThreads} uses, so list and "of N" agree. */
  private countFlagViewThreads(view: FlagView): number {
    if (this.readModelReadsEnabled()) {
      const row = this.timed(`countFlagView:${view}`, () => this.db
        .prepare(`SELECT COUNT(*) as count FROM threads t WHERE t.${FLAG_VIEWS[view].column} = 1`)
        .get() as { count: number }, { view });
      return row.count;
    }

    const row = this.timed(`countFlagViewLegacy:${view}`, () => this.db
      .prepare(`SELECT COUNT(*) as count FROM (${flagViewLegacySql(view, '')})`)
      .get() as { count: number }, { view });
    return row.count;
  }

  /** Ids of the folders "All Email" hides (Trash/Spam/Drafts/Sent, under every
   *  name the servers publish them as) — resolved in ONE indexed lookup, not
   *  twelve, and only for the folders this mailbox actually has. */
  private listingExcludedFolderIds(): string[] {
    const placeholders = LISTING_EXCLUDED_FOLDERS.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT id FROM folders WHERE path IN (${placeholders})`)
      .all(...LISTING_EXCLUDED_FOLDERS) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** One page of "All Email", THREAD-grained: pick the page's conversations,
   *  then hydrate each to all of its messages — the same shape the folder,
   *  section and flag-view fast paths return, so a thread never straddles a
   *  page boundary. */
  private listAllMailThreads(limit: number, offset: number): EmailRecord[] {
    if (this.readModelReadsEnabled()) {
      const excluded = this.listingExcludedFolderIds();
      const tids = this.timed('listAllMail', () => this.db
        .prepare(allMailPageSql(excluded.length))
        .all(...excluded, limit, offset) as { id: string }[], { excluded: excluded.length });
      return this.hydrateThreads(tids.map((t) => t.id), true);
    }

    const rows = this.timed('listAllMailLegacy', () => this.db
      .prepare(allMailLegacySql('ORDER BY last_date DESC, tid DESC LIMIT ? OFFSET ?'))
      .all(limit, offset) as { tid: string }[]);
    return this.hydrateThreads(rows.map((r) => r.tid), true);
  }

  /** How many CONVERSATIONS "All Email" holds — the pagination unit
   *  {@link listAllMailThreads} uses, so list and "of N" agree. */
  private countAllMailThreads(): number {
    if (this.readModelReadsEnabled()) {
      const excluded = this.listingExcludedFolderIds();
      const row = this.timed('countAllMail', () => this.db
        .prepare(allMailCountSql(excluded.length))
        .get(...excluded) as { count: number }, { excluded: excluded.length });
      return row.count;
    }

    const row = this.timed('countAllMailLegacy', () => this.db
      .prepare(`SELECT COUNT(*) as count FROM (${allMailLegacySql('')})`)
      .get() as { count: number });
    return row.count;
  }

  /**
   * Count distinct threads matching a section filter (thread-level via HAVING)
   */
  async getSectionCount(filter: string, folderPath?: string, viewFilter?: ViewFilter): Promise<number> {
    this.logQuery('getSectionCount', { filter, folderPath });
    // Read-model fast path (flat COUNT over thread_folders) when enabled + ready.
    if (this.readModelReadsEnabled()) {
      const folderId = this.folderIdForPath(folderPath);
      if (folderId) return this.countSectionFast(filter, folderId, viewFilter);
    }
    const folder = this.folderScope(folderPath);
    const vf = this.viewFilterThreadHaving(viewFilter);
    let havingClause: string;

    switch (filter) {
      case 'important_unread':
        havingClause = THREAD_HAS_IMPORTANT_UNREAD;
        break;
      case 'starred':
        havingClause = `${THREAD_HAS_STARRED} AND NOT ${THREAD_HAS_IMPORTANT_UNREAD}`;
        break;
      case 'everything_else':
        havingClause = `NOT ${THREAD_HAS_IMPORTANT_UNREAD} AND NOT ${THREAD_HAS_STARRED}`;
        break;
      case 'important':
        havingClause = THREAD_HAS_IMPORTANT;
        break;
      case 'unread':
        havingClause = `${liveUnreadSum()} > 0`;
        break;
      case 'not_important':
        havingClause = `NOT ${THREAD_HAS_IMPORTANT}`;
        break;
      case 'read':
        havingClause = `${liveUnreadSum()} = 0`;
        break;
      default:
        return 0;
    }

    const result = this.timed('getSectionCount', () => this.db
      .prepare(`
        SELECT COUNT(*) as count FROM (
          SELECT COALESCE(thread_id, id) as tid FROM emails
          WHERE 1=1
            ${this.getExcludeSpecialFolders(folderPath)}
            ${folder.sql}
          GROUP BY tid
          HAVING ${havingClause}
            ${vf.sql}
        )
      `)
      .get(...folder.params, ...vf.params) as { count: number },
      { filter, folder: folderPath },
    );
    return result.count;
  }

  // ========== Tag Manipulation ==========

  /**
   * Add a tag to an email
   */
  async addTag(emailId: string, tag: string): Promise<void> {
    const email = this.db.prepare('SELECT tags FROM emails WHERE id = ?').get(emailId) as any;
    if (!email) return;
    const newTags = addTag(email.tags, tag);
    if (newTags !== email.tags) {
      this.db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run(newTags, emailId);
    }
  }

  /**
   * Remove a tag from an email
   */
  async removeTag(emailId: string, tag: string): Promise<void> {
    const email = this.db.prepare('SELECT tags FROM emails WHERE id = ?').get(emailId) as any;
    if (!email) return;
    const newTags = removeTag(email.tags, tag);
    if (newTags !== email.tags) {
      this.db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run(newTags, emailId);
    }
  }

  /**
   * Replace all tags on an email
   */
  async setTags(emailId: string, tags: string): Promise<void> {
    this.db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run(tags, emailId);
  }

  /**
   * Convert database row to EmailRecord
   */
  rowToRecord(row: any): EmailRecord {
    const tags = row.tags || '||';
    const tagList = parseTags(tags);

    const record: EmailRecord = {
      id: row.id,
      messageId: row.message_id,
      threadId: row.thread_id,
      folderId: row.folder_id,
      uid: row.uid,
      tags: tags,
      subject: row.subject,
      fromAddress: row.from_address,
      fromName: row.from_name,
      toAddress: row.to_address,
      toNames: row.to_names,
      ccAddress: row.cc_address,
      ccNames: row.cc_names,
      bccAddress: row.bcc_address,
      bccNames: row.bcc_names,
      replyTo: row.reply_to,
      date: row.date,
      receivedDate: row.received_date,
      cleanBody: row.clean_body,
      // Images come back here, at the single choke point every read passes
      // through, so no consumer can be given a body full of `sarv-inline:` refs
      // it does not understand. Guarded by an `indexOf` (see
      // `hasInlineImageRefs`), so a plain-text body, a list row with no
      // `raw_body` at all, and every mail written before this change cost one
      // substring search and nothing more.
      //
      // Inflating universally rather than only on the render path is the
      // deliberate first cut: over-inflating costs memory and a base64 encode,
      // which is exactly what the pre-change code already paid on every read, so
      // this is never worse than today; under-inflating would put a broken image
      // in front of the user. Giving the ref form to the readers that cannot use
      // image bytes anyway (the AI pipeline, the reheal scanner, the phishing
      // check, contact mining) is a follow-up optimization, listed in
      // `inline-image-store.ts`, and it can be made per-caller safely once the
      // storage side is proven.
      rawBody: typeof row.raw_body === 'string' && hasInlineImageRefs(row.raw_body)
        ? inflateInlineImages(this.db, row.raw_body)
        : row.raw_body,
      // LIST queries return a `has_body` flag (raw_body is excluded for weight, so
      // `rawBody` is undefined on a list row). Full queries (SELECT *) have no
      // has_body column → derive presence from raw_body. Lets the renderer tell
      // "body is in the DB, open will load it" from "body genuinely missing".
      hasBody: row.has_body != null
        ? row.has_body === 1
        : (row.raw_body != null && row.raw_body !== ''),
      contentType: row.content_type,
      contentHash: row.content_hash,
      inReplyTo: row.in_reply_to,
      references: row.references,
      priority: row.priority,
      hasAttachments: row.has_attachments === 1,
      attachmentCount: row.attachment_count,
      attachmentNames: row.attachment_names,
      attachmentSizes: row.attachment_sizes ?? null,
      calendarIcs: row.calendar_ics ?? null,
      calendarAdded: row.calendar_added === 1,
      hasEmbedding: row.has_embedding === 1,
      embeddingLastGenerated: row.embedding_last_generated,
      createdAt: row.created_at,
      updatedAt: row.updated_at,

      // Importance
      importanceScore: row.importance_score,
      importanceSource: row.importance_source,
      authStatus: row.auth_status,

      // Spam filter (header stage) + origin IP for the reputation stage
      spamScore: row.spam_score ?? null,
      spamReasons: row.spam_reasons ?? null,
      originIp: row.origin_ip ?? null,

      // AI metadata
      aiProcessedAt: row.ai_processed_at,
      aiConfidence: row.ai_confidence,
      aiReasoning: row.ai_reasoning,

      // Agent priority score
      priorityScore: row.priority_score || undefined,

      // Snooze
      snoozeUntil: row.snooze_until,
      snoozeOriginalTags: row.snooze_original_tags,

      // Computed from tags for backward compatibility
      flags: tagsToImapFlags(tagList),
      labels: tagList.filter(t => !['read', 'starred', 'answered', 'draft', 'deleted'].includes(t)),
      isImportant: hasTag(tags, 'important'),
      isStarred: hasTag(tags, 'starred'),
    };

    // Include thread metadata if available (from subqueries)
    if (row.thread_message_count !== undefined && row.thread_message_count !== null) {
      record.threadMessageCount = row.thread_message_count;
    }
    if (row.thread_first_sender) {
      record.threadFirstSender = row.thread_first_sender;
    }
    if (row.thread_last_sender) {
      record.threadLastSender = row.thread_last_sender;
    }
    // Thread-wide starred / important flags. SQLite returns 0/1 for
    // EXISTS — coerce to boolean. We use these in buildThreads to
    // override the loaded-subset computation when the thread has
    // starred/important emails in folders not in the current view.
    if (row.thread_is_starred !== undefined && row.thread_is_starred !== null) {
      (record as any).threadIsStarred = !!row.thread_is_starred;
    }
    if (row.thread_is_important !== undefined && row.thread_is_important !== null) {
      (record as any).threadIsImportant = !!row.thread_is_important;
    }
    if (row.thread_has_draft !== undefined && row.thread_has_draft !== null) {
      (record as any).threadHasDraft = !!row.thread_has_draft;
    }

    return record;
  }
}
