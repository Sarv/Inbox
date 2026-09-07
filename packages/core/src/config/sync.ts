/**
 * Sync scope configuration — the SINGLE source of truth for how far back a
 * mailbox is synced with PRIORITY.
 *
 * The app is built to handle very large mailboxes (lakh+). On connect we sync +
 * categorise the RECENT window immediately (fast first paint, live triage), and
 * the background historical backfill downloads EVERYTHING older so full-mailbox
 * search still works — just not gated on it. Live new mail (IDLE) is always
 * processed ahead of backfill.
 *
 * To widen/narrow the priority window, change SYNC_RECENT_WINDOW_DAYS HERE only.
 */

/** Priority sync window, in days. Mail newer than this is downloaded and
 *  categorised immediately on connect; older mail is fetched by the background
 *  backfill. 30 = covers active conversations without a huge initial load. */
export const SYNC_RECENT_WINDOW_DAYS = 30;

/** The priority window as a Unix-SECONDS cutoff: messages with `date >=` this
 *  are "recent". Pass `nowSeconds` for testability; defaults to now. */
export function recentWindowCutoffSeconds(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  return nowSeconds - SYNC_RECENT_WINDOW_DAYS * 24 * 60 * 60;
}

/** The priority window cutoff as a `Date`, for IMAP `SEARCH SINCE`. */
export function recentWindowCutoffDate(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Date {
  return new Date(recentWindowCutoffSeconds(nowSeconds) * 1000);
}

/**
 * Mailbox size (server EXISTS) above which whole-mailbox enumeration — the
 * `UID SEARCH ALL` / `FETCH 1:*` used for flag reconcile + deletion detection —
 * is replaced by a WINDOWED reconcile (only the recent window is enumerated).
 *
 * Below this, the proven whole-mailbox path is cheap and stays as-is. Above it,
 * that enumeration returns partial UID lists / times out on large mailboxes, so
 * we reconcile flags for the recent window only and defer the full whole-folder
 * deletion sweep to the background backfill. Single place to tune.
 */
export const LARGE_MAILBOX_THRESHOLD = 5000;

/**
 * Per-sweep cap for the stale-flag verification that runs on windowed (large)
 * mailboxes — see `selectStaleFlagCandidates`.
 *
 * Sized to exactly ONE bounded `fetchFlagsOnly` batch (the client batches at 500),
 * so the whole safety net costs a single extra IMAP command per folder per
 * interval. That matters: the reason old mail lost its flag reconcile in the first
 * place was a whole-mailbox re-read that timed out and poisoned the connection, so
 * the repair must never become the next version of that.
 *
 * A backlog larger than this drains across sweeps via the newest-first rotation.
 */
export const STALE_FLAG_VERIFY_MAX = 500;

/**
 * Historical backfill — after the recent window is synced, the background
 * scheduler downloads ALL older mail so full-mailbox search works, paging
 * DOWNWARD by UID one bounded chunk per tick.
 *
 * The span is a UID WIDTH, not a message count: each chunk fetches the UID range
 * `[boundary - SPAN, boundary - 1]` and advances the boundary by SPAN regardless
 * of how many messages that range actually held. Paging by UID width (never by
 * message count) is what guarantees the backfill terminates across the UID GAPS
 * that deletions leave — a count-based cursor would stall forever in a gap.
 * Bounded so a single chunk stays light (some servers reject an unbounded
 * `FETCH 1:*` but serve bounded ranges fine — see fetchFlagsOnly).
 */
export const BACKFILL_UID_SPAN = 500;
