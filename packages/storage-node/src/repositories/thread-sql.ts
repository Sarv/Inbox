// Shared SQL fragments for thread-level (whole-conversation) metadata.
// Used by BOTH EmailRepository (list views) and SearchRepository (search
// results) so the two can never disagree about a thread's message count,
// participants, or starred/important state. The outer query must expose the
// base table as `emails` — every fragment correlates on `emails.thread_id`.

import {
  CONVERSATION_EXCLUDED_FOLDERS,
  DRAFT_MARKER_TAG,
  SENT_FOLDER_TAGS,
  STANDARD_DRAFT_FOLDERS,
  conversationFoldersOf,
  createLogger,
  type ConversationFolders,
} from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { prepared } from '../statement-cache';

import { EMAIL_TAGS_TABLE } from './tag-membership';

const log = createLogger('ThreadSql');

/**
 * Folders whose copies don't count toward thread-level state (deleted/junk).
 * Core's `CONVERSATION_EXCLUDED_FOLDERS` — the conversation-membership
 * predicate's list — so the SQL here and the JS the thread view, the drafter
 * and the split scheduler run can never disagree about a trashed copy.
 */
export const THREAD_STATE_EXCLUDED_FOLDERS: readonly string[] = CONVERSATION_EXCLUDED_FOLDERS;

/** SQLite's message for a database that has no `folders` table at all. */
const NO_FOLDERS_TABLE = /no such table: folders\b/;

/**
 * This database's Drafts and Sent folder paths (core `conversationFoldersOf`,
 * the classifier the thread view uses). Read per call: the folders table is a
 * few dozen rows, and a cached answer would go stale the moment a sync adds
 * the provider's Drafts folder.
 *
 * A database with NO folders table (a bare fixture) has no provider folders:
 * empty roles, and the standard `Drafts`/`Sent` names still apply. A table
 * without `name`/`special_use` (a minimal fixture) is classified from what it
 * has, its paths. Any OTHER failure THROWS — a failed read, or rows with no
 * path to classify. An unreadable folders table and an empty one are the same
 * value and opposite facts: read as "no provider Drafts folder", it would make
 * an `INBOX.Drafts` draft a conversation MEMBER — counted in "(N)", picked as
 * the first email the AI splits, handed to the reply drafter, invisible to the
 * live-draft gate that must stop an auto-draft. Failing loudly makes every
 * caller fail closed instead.
 */
export function conversationFoldersIn(db: Database.Database): ConversationFolders {
  let rows: Array<Record<string, unknown>>;
  try {
    // `*`, not a column list: the classifier uses whatever of path / name /
    // special_use the table has.
    rows = prepared(db, 'SELECT * FROM folders').all() as typeof rows;
  } catch (error) {
    if (NO_FOLDERS_TABLE.test(String((error as Error)?.message ?? error))) return conversationFoldersOf([]);
    log.warn('conversationFoldersIn: folders table unreadable; refusing to guess the Drafts/Sent folders', error);
    throw error;
  }
  if (rows.length > 0 && typeof rows[0].path !== 'string') {
    const error = new Error('conversationFoldersIn: folders rows carry no path');
    log.warn('conversationFoldersIn: folders table unreadable; refusing to guess the Drafts/Sent folders', error);
    throw error;
  }
  return conversationFoldersOf(rows.map((row) => ({
    path: row.path as string,
    name: typeof row.name === 'string' ? row.name : undefined,
    specialUse: typeof row.special_use === 'string' ? row.special_use : null,
  })));
}

/**
 * A folder path as an SQL string LITERAL, quote-doubled.
 *
 * Literal rather than bound: the fragments below are spliced into eight list
 * and search statements whose `?` parameters are positional, and a bound
 * parameter here would shift every one of them. A folder name is server data,
 * so the quoting is the whole defence — a `'` in a name must end up as `''`,
 * never as the end of the string. NUL never reaches here
 * (core's folder-role builders drop such paths); it is refused outright anyway,
 * because SQLite stops reading a statement at one.
 */
export function sqlStringLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('sqlStringLiteral: NUL in value');
  return `'${value.replace(/'/g, "''")}'`;
}

/** `instr(<alias>.tags, '|<name>|')` with the name safely quoted. */
const tagInstr = (alias: string, name: string): string => `instr(${alias}.tags, ${sqlStringLiteral(`|${name}|`)})`;

/** Folder paths that can be spliced as literals: non-empty, NUL-free, deduplicated. */
function quotablePaths(...lists: ReadonlyArray<readonly string[]>): string[] {
  // A path that could not be quoted (NUL) is skipped rather than failing the
  // whole list query; core's folder-role builders never produce one.
  return [...new Set(lists.flat().filter((path) => !!path && !path.includes('\0')))];
}

/**
 * Per-row SQL: true when the row on `alias` is a DRAFT — the SQL twin of core's
 * `isDraftRow`, clause for clause:
 *
 *   1. a Sent copy — the standard `Sent`, `[Gmail]/Sent Mail`, `Sent Items`,
 *      or one of `folders.sentPaths` (this account's classified Sent folders,
 *      `INBOX.Sent`, iCloud's `Sent Messages`) — is never a draft, even with a
 *      stale `|draft|` tag;
 *   2. the local `|draft|` marker, or
 *   3. one of `folders.draftPaths` (this account's classified Drafts folders), or
 *   4. the standard `Drafts` / `[Gmail]/Drafts` names, means draft.
 *
 * Trash does not un-draft a row: a discarded draft is still not a message.
 */
export function draftRowSql(alias: string, folders?: ConversationFolders | null): string {
  const sent = quotablePaths(SENT_FOLDER_TAGS, folders?.sentPaths ?? []);
  const notSent = sent.map((folder) => `${tagInstr(alias, folder)} = 0`).join(' AND ');
  const markers = [DRAFT_MARKER_TAG, ...quotablePaths(folders?.draftPaths ?? [], STANDARD_DRAFT_FOLDERS)];
  const isDraft = markers.map((name) => `${tagInstr(alias, name)} > 0`).join(' OR ');
  return `(${notSent} AND (${isDraft}))`;
}

/**
 * {@link draftRowSql} with the account's OWN Drafts/Sent folders, read from
 * `db` — for main's raw draft deletes (discard, post-send cleanup, the junk
 * sweep). The bare tag markers those used to match take a Sent copy that kept
 * a stale `|draft|` tag for a draft, and deleting it loses the reader's own
 * reply and hands its Sent-folder UID to the Drafts-folder expunge. Throws when
 * the folders table is unreadable ({@link conversationFoldersIn}): a caller that
 * deletes must then delete nothing rather than guess.
 */
export function accountDraftRowSql(db: Database.Database, alias: string): string {
  return draftRowSql(alias, conversationFoldersIn(db));
}

/**
 * SQL fragment (leading `AND`) excluding DRAFT rows ({@link draftRowSql}) —
 * our local `|draft|` mirrors, IMAP-synced drafts retagged with just their
 * Drafts folder path, and the account's provider-specific Drafts folders. A
 * draft is never a real conversation message, so the list row's "(N)" must not
 * count it.
 *
 * Since the membership predicate moved to core, a SENT copy that kept a stale
 * `|draft|` tag is NOT excluded (it is a message the user sent), and a
 * provider-path draft (`INBOX.Drafts`) IS — pass `folders` to catch the
 * provider paths of both.
 */
export function draftExclusion(alias: string, folders?: ConversationFolders | null): string {
  return `AND NOT ${draftRowSql(alias, folders)}`;
}

/**
 * Per-row SQL: true when the message on column `col` is a LIVE unread message —
 * unread AND not sitting in Trash/Spam/Junk (or flagged \Deleted). Used by the
 * Unread/Read section queries so a thread whose ONLY unread copy is in Spam/Trash
 * (a spam reply, a trashed message) is NOT shown as unread in the inbox — which
 * matched Gmail's own behavior and was inflating the "All Inboxes" badge.
 */
export function liveUnreadSum(col = 'tags'): string {
  const excl = [...THREAD_STATE_EXCLUDED_FOLDERS.map((f) => `|${f}|`), '|deleted|']
    .map((t) => `instr(${col}, '${t}') = 0`)
    .join(' AND ');
  return `SUM(CASE WHEN instr(${col}, '|read|') = 0 AND ${excl} THEN 1 ELSE 0 END)`;
}

/**
 * SQL fragment excluding Trash/Spam/Junk copies for the given table alias
 * (e.g. `emails`, `tmc`). Produces `AND instr(<alias>.tags, '|Trash|') = 0 ...`.
 * The single source for this exclusion — used by every thread-scoped subquery
 * and by getByThread — so they share one definition of "trashed/junked".
 */
export function threadFolderExclusion(alias: string): string {
  return THREAD_STATE_EXCLUDED_FOLDERS
    .map(f => `AND instr(${alias}.tags, '|${f}|') = 0`)
    .join(' ');
}

/**
 * Special folders that HIDE a copy from every OTHER folder's listing. When
 * listing (or counting for) folder F, a copy is a member only if it carries F
 * and none of these — so a Sent copy of a reply doesn't leak into INBOX, and a
 * message that also sits in Trash/Junk is not an INBOX message any more.
 *
 * The single source for this scope: the per-folder list queries
 * (getExcludeSpecialFolders), the read-model's per-folder rows (thread-rollup)
 * and the sidebar badge (folder-repository unread_count) all derive from it, so
 * a folder's badge can never count a thread its own filtered list won't show.
 */
export const LISTING_EXCLUDED_FOLDERS: readonly string[] = [
  // Built from core's conversation-membership lists — the deleted/junk
  // folders, the Sent names and the standard Drafts names — so a name added to
  // one of them reaches the listing scope and the sidebar badge too, instead
  // of the two lists silently diverging. (Bound in this order by
  // unreadByTagParams; every consumer reads this one array.)
  ...CONVERSATION_EXCLUDED_FOLDERS,
  ...SENT_FOLDER_TAGS,
  ...STANDARD_DRAFT_FOLDERS,
];

/**
 * SQL fragment applying {@link LISTING_EXCLUDED_FOLDERS} to column `col` for a
 * listing of `currentFolderPath` (which is itself never excluded — Trash lists
 * Trash). Produces `AND instr(tags, '|Trash|') = 0 ...`.
 */
export function listingExclusion(currentFolderPath?: string, col = 'tags'): string {
  return LISTING_EXCLUDED_FOLDERS
    .filter((f) => f !== currentFolderPath)
    .map((f) => `AND instr(${col}, '|${f}|') = 0`)
    .join(' ');
}

/**
 * JS twin of {@link listingExclusion} for code that already has a row's tag
 * tokens in hand: true when the copy is hidden from `folderPath`'s listing by
 * ANOTHER special folder it also belongs to.
 */
export function isShadowedInFolder(tokens: ReadonlySet<string> | readonly string[], folderPath: string): boolean {
  const has = tokens instanceof Set
    ? (t: string) => (tokens as ReadonlySet<string>).has(t)
    : (t: string) => (tokens as readonly string[]).includes(t);
  for (const special of LISTING_EXCLUDED_FOLDERS) {
    if (special !== folderPath && has(special)) return true;
  }
  return false;
}

/**
 * Per-row SQL: true when the copy on `col` is an UNREAD message that LISTS in
 * `folderPath` — not read, not flagged \Deleted, and not shadowed by another
 * special folder. This is the sidebar badge's definition of "unread in F"; it
 * deliberately matches what F's Unread quick-filter can show (liveUnreadSum's
 * read/deleted rule + the folder's listing scope), so badge and list agree.
 */
export function unreadInFolderPredicate(folderPath: string, col = 'tags'): string {
  return `${unreadCandidatePredicate(col)} ${listingExclusion(folderPath, col)}`;
}

/**
 * Tags that disqualify a copy from counting as unread, ANYWHERE. The one list
 * both forms below are built from, so the per-folder predicate and the grouped
 * count cannot drift apart.
 */
export const NOT_UNREAD_TAGS: readonly string[] = ['read', 'deleted'];

/**
 * The folder-INDEPENDENT half of {@link unreadInFolderPredicate}: the copy is
 * neither read nor flagged \Deleted, tested against a `tags` STRING.
 */
export function unreadCandidatePredicate(col = 'tags'): string {
  return NOT_UNREAD_TAGS.map((tag) => `instr(${col}, '|${tag}|') = 0`).join(' AND ');
}

/**
 * Unread-thread counts for MANY folders in ONE query: rows of `{ tag, c }`
 * mapping a folder path to its distinct unread threads. Binds `folderPaths`,
 * then {@link NOT_UNREAD_TAGS}, then {@link LISTING_EXCLUDED_FOLDERS} — see
 * {@link unreadByTagParams}. A folder with nothing unread yields NO row, so
 * callers must default a missing tag to 0.
 *
 * The same rule as {@link unreadInFolderPredicate}, asked for every folder at
 * once: "not shadowed by ANOTHER special folder" becomes `x.tag <> t.tag`,
 * which is that builder's `.filter(f => f !== currentFolderPath)` evaluated per
 * GROUP instead of per statement.
 *
 * EVERY disqualifying test is a membership test on `email_tags`, and THAT is
 * the performance story here — not the join, and not the covering index. An
 * `emails` row carries `clean_body`/`raw_body` inline (~88 KB each on a real
 * store), so opening one is expensive. Testing read/\Deleted against
 * `emails.tags` forces that read for EVERY member of the folder before the row
 * can be rejected; testing them here rejects it from a small WITHOUT ROWID
 * index first, so only the genuinely-unread rows are ever fetched — ~4k row
 * lookups instead of ~81k. Measured over all 22 folders of a 2.46 GB /
 * 27,785-email mailbox: 1,637 ms as one statement per folder, 77 ms grouped
 * but reading `emails.tags`, 7 ms as written. All three agree exactly with the
 * hand-rolled JS full-table tally this replaced (83 ms warm, 415 ms cold).
 */
export function unreadByTagSql(folderCount: number): string {
  const tags = new Array(folderCount).fill('?').join(', ');
  const notUnread = NOT_UNREAD_TAGS.map(() => '?').join(', ');
  const excluded = LISTING_EXCLUDED_FOLDERS.map(() => '?').join(', ');
  return `SELECT t.tag AS tag, COUNT(DISTINCT e.thread_id) AS c
            FROM ${EMAIL_TAGS_TABLE} t
            JOIN emails e ON e.id = t.email_id
           WHERE t.tag IN (${tags})
             AND e.thread_id IS NOT NULL
             AND NOT EXISTS (
                   SELECT 1 FROM ${EMAIL_TAGS_TABLE} x
                    WHERE x.email_id = t.email_id
                      AND (x.tag IN (${notUnread})
                           OR (x.tag <> t.tag AND x.tag IN (${excluded}))))
           GROUP BY t.tag`;
}

/** Bound parameters for {@link unreadByTagSql}, in the order its `?`s appear. */
export function unreadByTagParams(folderPaths: readonly string[]): string[] {
  return [...folderPaths, ...NOT_UNREAD_TAGS, ...LISTING_EXCLUDED_FOLDERS];
}

/**
 * Correlated EXISTS — true when ANY non-trash email in the current row's
 * thread matches `cond`.
 *
 * Join on thread_id directly — NOT COALESCE(thread_id, id). emails.thread_id
 * is NOT NULL (schema-enforced), so the COALESCE was a no-op that made the
 * join expression non-sargable: it defeated idx_emails_thread_id and turned
 * each correlated EXISTS into a FULL TABLE SCAN, multiplied across every thread
 * group in the section query. On an 11K-email mailbox that measured ~31s per
 * section query (synchronous better-sqlite3 -> main-process beachball on every
 * sync's section reload). Plain `=` uses the index: ~31s -> ~0.03s.
 */
export function threadTagExists(alias: string, cond: string): string {
  return `EXISTS(SELECT 1 FROM emails ${alias} WHERE ${alias}.thread_id = emails.thread_id AND ${cond} ${threadFolderExclusion(alias)})`;
}

/**
 * The list row's "(N)": the number of CONVERSATION MEMBERS — the SQL twin of
 * core's `conversationMembers(rows, folders).length`, which the thread view,
 * the AI view and the drafter all use, so the count agrees with what the thread
 * opens with (a parity test in `conversation-count-parity.test.ts` holds the two
 * together on a real database).
 *
 * Three tiers, first non-zero wins:
 *
 *   1. live members — neither a draft ({@link draftRowSql}) nor a Trash/Spam/Junk
 *      copy;
 *   2. every non-draft row — the all-junk conversation (reading the Junk folder),
 *      mirroring the membership predicate's own fallback;
 *   3. every row — a thread that is nothing but drafts. DISPLAY-ONLY: it has no
 *      members, but a Drafts-folder row must not read "(0)". The one place the
 *      count and `conversationMembers` deliberately differ.
 *
 * DELIBERATE CHANGE (AI-view redesign): this used the old tag-only draft rule,
 * which (a) dropped the user's own Sent copies that kept a stale `|draft|` tag,
 * and (b) counted a provider-path draft (`|INBOX.Drafts|`) as a message. Both
 * now follow the membership predicate: a `|Sent|draft|` copy (and one in the
 * account's own Sent folder, `|INBOX.Sent|draft|`) counts, an `INBOX.Drafts`
 * draft does not. `folders` comes from {@link conversationFoldersIn}; the
 * statement text changes only when the account's Drafts or Sent folders do.
 */
export function threadMessageCountSql(folders?: ConversationFolders | null): string {
  const notDraft = (alias: string): string => draftExclusion(alias, folders);
  return `COALESCE(
    NULLIF((SELECT COUNT(*) FROM emails tmc WHERE tmc.thread_id = emails.thread_id ${threadFolderExclusion('tmc')} ${notDraft('tmc')}), 0),
    NULLIF((SELECT COUNT(*) FROM emails tmd WHERE tmd.thread_id = emails.thread_id ${notDraft('tmd')}), 0),
    (SELECT COUNT(*) FROM emails tmcAll WHERE tmcAll.thread_id = emails.thread_id)
  )`;
}

/** Oldest sender name across the conversation (Trash/Spam/Junk excluded). */
export const THREAD_FIRST_SENDER_SQL = `(SELECT COALESCE(tfs.from_name, tfs.from_address) FROM emails tfs WHERE tfs.thread_id = emails.thread_id ${threadFolderExclusion('tfs')} ORDER BY tfs.date ASC LIMIT 1)`;

/** Newest sender name across the conversation (Trash/Spam/Junk excluded). */
export const THREAD_LAST_SENDER_SQL = `(SELECT COALESCE(tls.from_name, tls.from_address) FROM emails tls WHERE tls.thread_id = emails.thread_id ${threadFolderExclusion('tls')} ORDER BY tls.date DESC LIMIT 1)`;

/**
 * Thread metadata subqueries shared by list AND search SELECTs. EmailRepository
 * appends its extra tag aggregates (starred/important/draft) after these.
 *
 * A function of the account's Drafts and Sent folders (see
 * {@link threadMessageCountSql}); callers build it per query from
 * {@link conversationFoldersIn} on their own database.
 */
export function threadMetaSharedSql(folders?: ConversationFolders | null): string {
  return `
  ${threadMessageCountSql(folders)} as thread_message_count,
  ${THREAD_FIRST_SENDER_SQL} as thread_first_sender,
  ${THREAD_LAST_SENDER_SQL} as thread_last_sender
`;
}

/**
 * `unread_count` for one folder, taken from the MATERIALIZED read model.
 *
 * This is the same `thread_folders` projection the unread-filtered list scans
 * (`tf.has_unread = 1`), so a badge computed from it cannot disagree with the
 * list it labels — the disagreement being the whole class of bug this replaces:
 * `folders.unread_count` is a stored scalar that several local paths adjust by
 * hand, and one missed decrement left INBOX badged 7 over an empty list.
 *
 * Cheap enough to run on every read-model drain: `idx_tf_unread` is a PARTIAL
 * index over exactly the `has_unread = 1` rows, so this counts index entries for
 * the unread threads only — not a scan of the folder, let alone of `emails`.
 */
const readModelUnreadCountSql = (folderIdExpression: string): string =>
  `SELECT COUNT(*) AS c FROM thread_folders WHERE folder_id = ${folderIdExpression} AND has_unread = 1`;

/** Bound form: one folder id as a parameter, so the statement text is constant
 *  across folders and stays in the prepared-statement cache. */
export const READ_MODEL_UNREAD_COUNT_SQL = readModelUnreadCountSql('?');

/** Correlated form, for `UPDATE folders SET unread_count = (...)` — same count,
 *  same definition, one statement for any number of folders. */
export const READ_MODEL_UNREAD_COUNT_CORRELATED_SQL = readModelUnreadCountSql('folders.id');

/**
 * True when `thread_folders` is a complete, authoritative projection of
 * `emails` — the one gate for "may I read the materialized model instead of
 * deriving from rows". False while the one-time backfill is still running (the
 * projection is partial, so counting from it would UNDER-report) and false under
 * the `SARVINBOX_READMODEL_READS=0` kill-switch.
 *
 * Shared by the list reads and the badge recount deliberately: if the two ever
 * disagreed about which source is authoritative, the badge and the list would go
 * back to being computed from different tables.
 */
export function readModelComplete(db: Database.Database): boolean {
  if (process.env.SARVINBOX_READMODEL_READS === '0') return false; // kill-switch: force legacy
  const row = db.prepare("SELECT value FROM read_model_state WHERE key = 'status'").get() as
    { value: string } | undefined;
  return row?.value === 'complete';
}
