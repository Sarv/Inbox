import { describe, expect, it } from 'vitest';

import { selectStaleFlagCandidates } from '../../../src/utils/stale-flags';

/**
 * The selection policy for the only flag reconcile old mail on a large mailbox
 * gets. Two failure modes pull against each other here:
 *
 *  - Too narrow → a message read in webmail months ago stays bold in the app
 *    forever and keeps inflating the folder badge. (Lived: an INBOX badge of 5
 *    whose five rows were all already read on the server.)
 *  - Too broad → the candidate set becomes the whole back catalogue and the sweep
 *    turns back into the unbounded whole-mailbox re-read that timed out, poisoned
 *    the pooled connection and stopped mail arriving in the first place.
 *
 * So what is EXCLUDED matters as much as what is picked, and the rotation is what
 * keeps a large backlog converging instead of just looking busy.
 */

const row = (uid: number | null, tags: string) => ({ uid, tags });
const none = new Set<number>();

const select = (over: Partial<Parameters<typeof selectStaleFlagCandidates>[0]> = {}) =>
  selectStaleFlagCandidates({
    rows: [],
    knownUids: none,
    pendingUids: none,
    alreadyChecked: none,
    max: 500,
    ...over,
  });

describe('selectStaleFlagCandidates', () => {
  describe('what gets verified', () => {
    it('picks a row we render as unread', () => {
      // THE REGRESSION. This is the stale row the user sees: bold in the app,
      // already read on the server, counted in the badge.
      expect(select({ rows: [row(42, '|work|')] }).uids).toEqual([42]);
    });

    it('picks a starred row even though it is read', () => {
      // Starred is its own visible signal — a mail unstarred in webmail must stop
      // showing in the Starred view, independently of read state.
      expect(select({ rows: [row(42, '|read|starred|')] }).uids).toEqual([42]);
    });

    it('KNOWN GAP: does not pick a plain read row', () => {
      // Deliberate, not an oversight. A row we show as read that the server has
      // unread is genuinely wrong, but every old read message is a candidate for
      // that check — which is the unbounded sweep this design exists to avoid.
      // It shows the user LESS than reality rather than a wrong count, and the
      // recent window plus CONDSTORE deltas still cover it.
      expect(select({ rows: [row(42, '|read|')] }).uids).toEqual([]);
    });

    it('skips a snoozed row', () => {
      // Phase 1 deliberately preserves local read state for snoozed mail, so
      // re-reading its flags can never change anything. Left in, it would sit at
      // the head of a newest-first rotation forever and starve rows that CAN be
      // corrected.
      expect(select({ rows: [row(42, '|snoozed|')] }).uids).toEqual([]);
    });

    it('skips UIDs whose server flags this pass already has', () => {
      // Everything in the recent window (and every CONDSTORE delta) is already
      // reconciled. Re-fetching it would spend the whole budget on the mail that
      // was never stale.
      const res = select({ rows: [row(10, '||'), row(20, '||')], knownUids: new Set([20]) });
      expect(res.uids).toEqual([10]);
    });

    it('skips UIDs with an un-synced local flag change', () => {
      // The server has not seen the local change yet, so its flags are the stale
      // side. Verifying here would revert the user's own action.
      const res = select({ rows: [row(10, '||'), row(20, '||')], pendingUids: new Set([20]) });
      expect(res.uids).toEqual([10]);
    });

    it('ignores rows with no usable UID', () => {
      // A tag-linked row carries its PRIMARY folder's uid or none at all; matching
      // a foreign uid against this folder's UID space reads another message's flags.
      const res = select({ rows: [row(null, '||'), row(0, '||'), row(NaN, '||'), row(7, '||')] });
      expect(res.uids).toEqual([7]);
    });
  });

  describe('bounding and ordering', () => {
    it('verifies newest first', () => {
      // A stale unread from last month is both likelier to be wrong and far more
      // visible than one from three years ago.
      const res = select({ rows: [row(5, '||'), row(90, '||'), row(40, '||')] });
      expect(res.uids).toEqual([90, 40, 5]);
    });

    it('caps the batch and reports the leftover', () => {
      // The cap is the whole safety property: one bounded FLAGS batch, never a
      // whole-mailbox re-read. The remainder must be visible, not silently dropped.
      const res = select({ rows: [row(1, '||'), row(2, '||'), row(3, '||')], max: 2 });
      expect(res.uids).toEqual([3, 2]);
      expect(res.remaining).toBe(1);
    });

    it('verifies nothing when the cap is zero or negative', () => {
      // Defensive: a misconfigured cap must disable the sweep, not fetch the lot.
      expect(select({ rows: [row(1, '||')], max: 0 }).uids).toEqual([]);
      expect(select({ rows: [row(1, '||')], max: -5 }).uids).toEqual([]);
    });

    it('returns nothing when the folder has no stale-looking rows', () => {
      // The common steady state — it must cost zero IMAP commands.
      const res = select({ rows: [row(1, '|read|'), row(2, '|read|')] });
      expect(res).toEqual({ uids: [], remaining: 0, wrapped: false });
    });
  });

  describe('rotation through a backlog', () => {
    it('moves on to UIDs it has not checked yet', () => {
      // Without this a user with more genuinely-unread old mail than the cap would
      // have the same newest batch re-verified on every sweep while the rest never
      // got a turn — the sweep would look busy and converge on nothing.
      const rows = [row(1, '||'), row(2, '||'), row(3, '||')];
      const res = select({ rows, alreadyChecked: new Set([3, 2]), max: 2 });
      expect(res.uids).toEqual([1]);
      expect(res.wrapped).toBe(false);
    });

    it('starts a new lap once every candidate has had its turn', () => {
      // A flag flipped in webmail AFTER we checked that message would otherwise be
      // invisible for the rest of the session. `wrapped` tells the caller to clear
      // its checked-set so the rotation restarts from the newest.
      const rows = [row(1, '||'), row(2, '||')];
      const res = select({ rows, alreadyChecked: new Set([1, 2]) });
      expect(res.uids).toEqual([2, 1]);
      expect(res.wrapped).toBe(true);
    });

    it('does not claim a wrap when there was nothing to verify at all', () => {
      // An empty folder is not a completed lap; reporting one would make the caller
      // clear state it never filled.
      expect(select({ rows: [row(1, '|read|')], alreadyChecked: new Set([1]) }).wrapped).toBe(false);
    });
  });
});
