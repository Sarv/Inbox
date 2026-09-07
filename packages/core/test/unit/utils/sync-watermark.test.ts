import { describe, expect, it } from 'vitest';

import { isWatermarkImpossible } from '../../../src/utils/sync-watermark';

/**
 * The forward-sync watermark decides whether a folder ever looks for new mail
 * again. Every case below is about one of two failure modes, and they pull in
 * opposite directions:
 *
 *  - Too trusting → a poisoned watermark wedges the folder and mail silently
 *    stops arriving, forever, with no error anywhere. (Lived: nine days.)
 *  - Too suspicious → a healthy folder is declared broken and full-re-syncs its
 *    whole history on every single pass.
 *
 * So the boundary conditions here are the whole point of the module.
 */

describe('isWatermarkImpossible', () => {
  describe('healthy watermarks are left alone', () => {
    it('fully caught up (lastSyncUid === uidNext - 1) is NOT impossible', () => {
      // The single most common steady state in the app. Flagging it would mean a
      // full re-sync of every folder on every sync.
      expect(isWatermarkImpossible({ lastSyncUid: 4999, uidNext: 5000 })).toBe(false);
    });

    it('legitimately behind the server is NOT impossible', () => {
      // Exactly what "there is new mail to fetch" looks like — the healthiest
      // possible state, and the one the incremental sync exists to act on.
      expect(isWatermarkImpossible({ lastSyncUid: 100, uidNext: 5000 })).toBe(false);
    });

    it('lastSyncUid === uidNext is tolerated, NOT flagged', () => {
      // A server that reports UIDNEXT as its highest ASSIGNED uid rather than one
      // past it is non-conformant but real. Flagging it would be a permanent
      // resync loop: the repair forces a full sync, whose new watermark lands on
      // this same value, which is flagged again on the very next pass. One message
      // of latency is the cheaper wrong answer. If this ever flips to `>=`, that
      // loop comes back.
      expect(isWatermarkImpossible({ lastSyncUid: 5000, uidNext: 5000 })).toBe(false);
    });
  });

  describe('impossible watermarks are caught', () => {
    it('a watermark ABOVE uidNext is impossible', () => {
      // UIDNEXT is what the server will assign next, so nothing at or above it has
      // ever existed in this mailbox. This is the wedge.
      expect(isWatermarkImpossible({ lastSyncUid: 5001, uidNext: 5000 })).toBe(true);
    });

    it('catches the observed live case (59804 vs a ~23.5k-message INBOX)', () => {
      // The real numbers from the Gmail INBOX that reported "No new messages" on
      // 258 consecutive syncs across nine days while the server grew by 144.
      expect(isWatermarkImpossible({ lastSyncUid: 59804, uidNext: 23563 })).toBe(true);
    });

    it('catches an off-by-one over the line', () => {
      // Guards the exact boundary from the other side: one above uidNext is the
      // smallest genuinely impossible value, and it must not be tolerated the way
      // `=== uidNext` is.
      expect(isWatermarkImpossible({ lastSyncUid: 5001, uidNext: 5000 })).toBe(true);
      expect(isWatermarkImpossible({ lastSyncUid: 5000, uidNext: 5000 })).toBe(false);
    });
  });

  describe('unknown values never trigger the repair', () => {
    // Every case here would, if mishandled, throw away a good watermark and force
    // a full re-sync of the folder on the strength of a number we do not have.
    it('a never-synced folder (no watermark) is not impossible', () => {
      expect(isWatermarkImpossible({ lastSyncUid: null, uidNext: 5000 })).toBe(false);
      expect(isWatermarkImpossible({ lastSyncUid: undefined, uidNext: 5000 })).toBe(false);
      expect(isWatermarkImpossible({ lastSyncUid: 0, uidNext: 5000 })).toBe(false);
    });

    it('a server that did not report uidNext is not impossible', () => {
      expect(isWatermarkImpossible({ lastSyncUid: 5001, uidNext: null })).toBe(false);
      expect(isWatermarkImpossible({ lastSyncUid: 5001, uidNext: undefined })).toBe(false);
      expect(isWatermarkImpossible({ lastSyncUid: 5001, uidNext: 0 })).toBe(false);
    });

    it('non-finite values are not impossible', () => {
      // NaN comparisons are always false, so `>` would silently answer "healthy"
      // anyway — but Infinity would answer "impossible" and wipe the watermark.
      expect(isWatermarkImpossible({ lastSyncUid: NaN, uidNext: 5000 })).toBe(false);
      expect(isWatermarkImpossible({ lastSyncUid: 5001, uidNext: NaN })).toBe(false);
      expect(isWatermarkImpossible({ lastSyncUid: Infinity, uidNext: 5000 })).toBe(false);
    });

    it('both sides unknown is not impossible', () => {
      expect(isWatermarkImpossible({})).toBe(false);
    });
  });
});
