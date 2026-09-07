// Shared SQL fragments for thread-level (whole-conversation) metadata.
// Used by BOTH EmailRepository (list views) and SearchRepository (search
// results) so the two can never disagree about a thread's message count,
// participants, or starred/important state. The outer query must expose the
// base table as `emails` — every fragment correlates on `emails.thread_id`.

/** Folders whose copies don't count toward thread-level state (deleted/junk). */
export const THREAD_STATE_EXCLUDED_FOLDERS = [
  'Trash', 'Spam', '[Gmail]/Trash', '[Gmail]/Spam', 'Junk', 'Junk Email', 'Deleted Items',
];

/**
 * SQL fragment excluding DRAFT copies from a thread's message count — both our
 * local `|draft|` mirrors and IMAP-synced drafts retagged with just their Drafts
 * folder path. A draft is never a real conversation message, so the list row's
 * "(N)" must not count it (otherwise a reply-with-draft shows an inflated count).
 */
export function draftExclusion(alias: string): string {
  return `AND instr(${alias}.tags, '|draft|') = 0 AND instr(${alias}.tags, '|Drafts|') = 0 AND instr(${alias}.tags, '|[Gmail]/Drafts|') = 0`;
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
  'Trash', 'Spam', 'Drafts', 'Sent',
  '[Gmail]/Trash', '[Gmail]/Spam', '[Gmail]/Drafts', '[Gmail]/Sent Mail',
  'Junk', 'Junk Email', 'Deleted Items', 'Sent Items',
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
  return `instr(${col}, '|read|') = 0 AND instr(${col}, '|deleted|') = 0 ${listingExclusion(folderPath, col)}`;
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
 * Whole-conversation message count EXCLUDING Trash/Spam/Junk, so the list
 * row's "(N)" reflects the real conversation size AND matches what getByThread
 * shows when the thread is opened. Falls back to the unfiltered count when the
 * exclusion empties the thread (an all-junk conversation, e.g. viewing the Junk
 * folder) — mirroring getByThread's own fallback so all-junk threads still
 * report their real size instead of collapsing to 0.
 */
export const THREAD_MESSAGE_COUNT_SQL = `COALESCE(
    NULLIF((SELECT COUNT(*) FROM emails tmc WHERE tmc.thread_id = emails.thread_id ${threadFolderExclusion('tmc')} ${draftExclusion('tmc')}), 0),
    (SELECT COUNT(*) FROM emails tmcAll WHERE tmcAll.thread_id = emails.thread_id)
  )`;

/** Oldest sender name across the conversation (Trash/Spam/Junk excluded). */
export const THREAD_FIRST_SENDER_SQL = `(SELECT COALESCE(tfs.from_name, tfs.from_address) FROM emails tfs WHERE tfs.thread_id = emails.thread_id ${threadFolderExclusion('tfs')} ORDER BY tfs.date ASC LIMIT 1)`;

/** Newest sender name across the conversation (Trash/Spam/Junk excluded). */
export const THREAD_LAST_SENDER_SQL = `(SELECT COALESCE(tls.from_name, tls.from_address) FROM emails tls WHERE tls.thread_id = emails.thread_id ${threadFolderExclusion('tls')} ORDER BY tls.date DESC LIMIT 1)`;

/**
 * Thread metadata subqueries shared by list AND search SELECTs. EmailRepository
 * appends its extra tag aggregates (starred/important/draft) after these.
 */
export const THREAD_META_SHARED = `
  ${THREAD_MESSAGE_COUNT_SQL} as thread_message_count,
  ${THREAD_FIRST_SENDER_SQL} as thread_first_sender,
  ${THREAD_LAST_SENDER_SQL} as thread_last_sender
`;
