/**
 * Which OLD local rows are worth re-reading flags for on a large mailbox.
 *
 * THE GAP THIS CLOSES. Above `LARGE_MAILBOX_THRESHOLD` the flag reconcile is
 * windowed to the recent `SYNC_RECENT_WINDOW_DAYS`, because the whole-mailbox
 * `FETCH 1:*` / `UID SEARCH ALL` it replaced timed out and wedged the connection.
 * Correct, but it left everything older than the window with NO flag reconcile at
 * all — the code deferred it to "the background backfill's full reconcile", which
 * on a big Gmail folder never completed either. So a message read or unstarred in
 * webmail months ago stayed bold in the app forever, inflating the folder badge
 * with mail the user had already dealt with. Observed live: an INBOX badge of 5
 * whose five rows were from May, July and August — none of them actually unread.
 *
 * The fix is not to widen the window (that reintroduces the wedge) but to notice
 * that the rows whose staleness is VISIBLE are a tiny, locally-enumerable set: the
 * ones we render as unread or starred. We already hold their UIDs, so their flags
 * can be re-read with one bounded `fetchFlagsOnly` batch whose size depends on the
 * user's unread count, not on the size of the mailbox.
 *
 * KNOWN, DELIBERATE LIMITATION: this only corrects rows that claim a
 * distinguishing state locally (unread or starred). The mirror image — a message
 * we show as read that the server has unread, or one starred only on the server —
 * is NOT covered, because enumerating those candidates means enumerating the
 * entire back catalogue, which is the unbounded sweep this whole design exists to
 * avoid. That direction shows the user LESS than reality rather than a wrong count,
 * and it is still repaired by the recent window and by CONDSTORE deltas.
 */

import { parseTags } from './tags';

/** The `{id, uid, tags}` shape every storage impl already returns per folder. */
export interface LocalFlagRow {
  uid: number | null;
  tags: string | null;
}

export interface StaleFlagSelectionInput {
  /** Local rows whose PRIMARY folder is the one being synced. */
  rows: readonly LocalFlagRow[];
  /** UIDs whose server flags this pass already knows (window + CONDSTORE delta). */
  knownUids: ReadonlySet<number>;
  /** UIDs with an un-synced local flag change — the server's view is stale, not ours. */
  pendingUids: ReadonlySet<number>;
  /** UIDs already re-read this session; drives the rotation. */
  alreadyChecked: ReadonlySet<number>;
  /** Hard cap on UIDs per sweep — one bounded FLAGS batch. */
  max: number;
}

export interface StaleFlagSelection {
  /** UIDs to re-read, newest first. Empty when there is nothing to verify. */
  uids: number[];
  /** Candidates that did not fit under `max`; they drain on later sweeps. */
  remaining: number;
  /**
   * True when every candidate had already been checked this session, so the
   * rotation restarted from the newest. The caller must clear its checked-set.
   */
  wrapped: boolean;
}

/**
 * A row is worth verifying only if it claims something the user can SEE and that
 * the server could have since changed.
 *
 * Snoozed rows are excluded on purpose: Phase 1 deliberately preserves their local
 * read state, so re-reading their flags can never change anything — they would sit
 * at the front of a newest-first rotation forever, spending the budget and
 * starving the rows that can actually be corrected.
 */
function claimsVisibleState(tags: string | null): boolean {
  const parsed = parseTags(tags || '||');
  if (parsed.includes('snoozed')) return false;
  return !parsed.includes('read') || parsed.includes('starred');
}

/**
 * Pick the next bounded batch of old local rows to re-read flags for.
 *
 * Newest first: a stale unread from last month is both likelier to be wrong and
 * more visible than one from three years ago. The rotation (via `alreadyChecked`)
 * is what stops a user with a large genuinely-unread backlog from re-verifying the
 * same newest `max` on every sweep while the rest never gets a turn — without it
 * the sweep looks busy and converges on nothing.
 */
export function selectStaleFlagCandidates({
  rows,
  knownUids,
  pendingUids,
  alreadyChecked,
  max,
}: StaleFlagSelectionInput): StaleFlagSelection {
  if (max <= 0) return { uids: [], remaining: 0, wrapped: false };

  const candidates: number[] = [];
  for (const row of rows) {
    const uid = row.uid;
    if (typeof uid !== 'number' || !Number.isFinite(uid) || uid <= 0) continue;
    if (knownUids.has(uid) || pendingUids.has(uid)) continue;
    if (!claimsVisibleState(row.tags)) continue;
    candidates.push(uid);
  }
  if (candidates.length === 0) return { uids: [], remaining: 0, wrapped: false };

  candidates.sort((a, b) => b - a);
  const untried = candidates.filter((uid) => !alreadyChecked.has(uid));
  const wrapped = untried.length === 0;
  const pool = wrapped ? candidates : untried;
  const uids = pool.slice(0, max);
  return { uids, remaining: pool.length - uids.length, wrapped };
}
