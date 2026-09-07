/**
 * Trusting `FolderRecord.lastSyncUid` — the forward-sync watermark.
 *
 * Incremental sync only ever looks for mail ABOVE this number, and the gate that
 * decides whether to look at all is `uidNext <= lastSyncUid + 1` ("the server has
 * nothing newer than what we hold"). That gate is correct while the watermark is
 * correct, and catastrophic once it isn't: a watermark that has run PAST the
 * server's UIDNEXT makes the gate permanently true, so the folder reports "No new
 * messages" on every sync, forever, while real mail piles up on the server. There
 * is no error, no retry, and nothing in the UI to see — mail just stops arriving.
 *
 * That is not hypothetical. A Gmail INBOX sat at `lastSyncUid = 59804` for nine
 * days, logging "No new messages in INBOX" on all 258 syncs, while the server's
 * EXISTS grew 23418 → 23562. Two folders on the same account held the byte-identical
 * watermark 59804 despite being separate UID spaces, which is what a watermark
 * written from the wrong mailbox's UIDs looks like.
 *
 * Nothing else repairs this. The forward sync won't (it is the thing that's gated),
 * the downward backfill won't (it pages BELOW the oldest local UID), and on a large
 * mailbox the addition reconcile is skipped too. So the watermark has to be checked
 * against the server on the way past, and disbelieved when the server says it is
 * impossible.
 *
 * Pure and side-effect free: the caller owns the storage write and the logging.
 */

/** A modseq/uid we can actually reason about — absent and 0 both mean "unknown". */
function isUsable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export interface WatermarkCheck {
  /** `FolderRecord.lastSyncUid` — the highest UID our forward sync believes it has. */
  lastSyncUid?: number | null;
  /** `UIDNEXT` the server just reported for the SAME folder, from its SELECT. */
  uidNext?: number | null;
}

/**
 * Has the stored watermark run past what the server could possibly have assigned?
 *
 * UIDNEXT is the UID the server will hand to the next message to arrive, so every
 * UID it has EVER assigned in this mailbox is strictly below it (RFC 3501 §2.3.1.1).
 * A watermark at or above UIDNEXT therefore claims we have synced a message the
 * server has never issued — it cannot have come from this mailbox.
 *
 * Deliberately strictly `>`, not `>=`. `lastSyncUid === uidNext - 1` is the normal
 * fully-caught-up state, and a sloppy server that reports `UIDNEXT` equal to its
 * highest assigned UID (rather than one past it) would otherwise be declared broken
 * on every sync — and since the repair forces a full re-sync whose new watermark
 * would land on the same value, that would be an expensive full sync of the whole
 * folder every single time. Tolerating the off-by-one costs at most one message of
 * latency on a non-conformant server; `>=` would cost a permanent resync loop.
 *
 * Unknown values (absent, null, 0) are never "impossible" — a folder that has never
 * synced has no watermark to distrust, and a server that didn't report UIDNEXT gives
 * us nothing to compare against.
 */
export function isWatermarkImpossible({ lastSyncUid, uidNext }: WatermarkCheck): boolean {
  return isUsable(lastSyncUid) && isUsable(uidNext) && lastSyncUid > uidNext;
}
