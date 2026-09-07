import { describe, expect, it, vi } from 'vitest';

import { fetchNewMessagesWindowed, NEW_MESSAGE_WINDOW } from '../../../src/imap/incremental-fetch';
import type { FetchOptions, IIMAPClient, IMAPMessage } from '../../../src/types/imap';

// These pin the ONE thing that made new mail stop arriving on a LARGE/slow
// account: the incremental fetch used to issue an unbounded `lastUid+1:*` that
// blew the 60s op timeout every cycle. The helper MUST page in bounded UID
// windows, never `:*`, never skip, never regress lastSyncUid. Each test names the
// regression it guards.

const msg = (uid: number): IMAPMessage => ({ uid } as unknown as IMAPMessage);

/** Minimal client that serves a set of existing UIDs via bounded ranges only. */
function rangeClient(existingUids: number[]) {
  const calls: Array<[number, number]> = [];
  const client = {
    async fetchMessagesByUidRange(lo: number, hi: number, _opts?: FetchOptions): Promise<IMAPMessage[]> {
      calls.push([lo, hi]);
      return existingUids.filter((u) => u >= lo && u <= hi).map(msg);
    },
    // Present but MUST NOT be called when bounded ranges are available — its
    // unbounded `:*` is the very thing we're avoiding.
    getNewMessages: vi.fn(async () => { throw new Error('getNewMessages (unbounded) must not be used when ranges work'); }),
  } as unknown as IIMAPClient & { getNewMessages: ReturnType<typeof vi.fn> };
  return { client, calls };
}

describe('fetchNewMessagesWindowed', () => {
  // If it ever issues one big span again, a LARGE mailbox times out at 60s and
  // new mail silently stops. Assert it pages in fixed-size bounded windows.
  it('pages the range in bounded windows and never issues an unbounded fetch', async () => {
    const uids = Array.from({ length: 1200 }, (_, i) => i + 1); // UIDs 1..1200
    const { client, calls } = rangeClient(uids);

    const out = await fetchNewMessagesWindowed(client, 0, 1201 /* uidNext */, undefined, { windowSize: 500 });

    expect(calls).toEqual([[1, 500], [501, 1000], [1001, 1200]]); // bounded, contiguous, capped at hiEnd
    expect(out.map((m) => m.uid)).toEqual(uids);                  // every message, none skipped
    expect((client as any).getNewMessages).not.toHaveBeenCalled();
  });

  // Defaulting the window keeps the common "handful of new" case a single
  // round-trip while still bounding the worst case.
  it('defaults to NEW_MESSAGE_WINDOW when no windowSize is given', async () => {
    // Highest existing UID is 1500, so the first (and here only) window spans the
    // full default width from the low bound — proving the default is applied.
    const uids = Array.from({ length: 1500 }, (_, i) => i + 1);
    const { client, calls } = rangeClient(uids);
    await fetchNewMessagesWindowed(client, 0, 1501);
    expect(calls[0]).toEqual([1, NEW_MESSAGE_WINDOW]); // first window sized to the default
  });

  // A regressed lastSyncUid causes a permanent redundant refetch loop. Some
  // servers echo the boundary message for an out-of-range low bound; it must be
  // dropped so only strictly-newer UIDs come back.
  it('drops any UID <= sinceUid (boundary echo) so lastSyncUid can never regress', async () => {
    const client = {
      async fetchMessagesByUidRange() { return [msg(100), msg(101), msg(102)]; },
    } as unknown as IIMAPClient;
    const out = await fetchNewMessagesWindowed(client, 100, 103, undefined, { windowSize: 500 });
    expect(out.map((m) => m.uid)).toEqual([101, 102]); // 100 (== sinceUid) filtered out
  });

  // No new mail must be a cheap no-op — not a fetch, and never a `:*`.
  it('returns [] without fetching when nothing is newer than sinceUid', async () => {
    const spy = vi.fn(async () => [] as IMAPMessage[]);
    const client = { fetchMessagesByUidRange: spy } as unknown as IIMAPClient;
    const out = await fetchNewMessagesWindowed(client, 500, 501 /* uidNext: highest existing is 500 */);
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  // A huge backlog must not become one unbounded call in time/memory: cap the
  // per-cycle haul (oldest first) so lastSyncUid advances and the next cycle
  // continues the drain — no message is skipped, work is just spread out.
  it('honours maxMessages: stops early after the cap, draining oldest-first', async () => {
    const uids = Array.from({ length: 5000 }, (_, i) => i + 1);
    const { client, calls } = rangeClient(uids);

    const out = await fetchNewMessagesWindowed(client, 0, 5001, undefined, { windowSize: 500, maxMessages: 1200 });

    expect(out.length).toBeGreaterThanOrEqual(1200);   // at least the cap
    expect(out.length).toBeLessThan(5000);             // but NOT the whole backlog
    expect(out[0].uid).toBe(1);                        // oldest-first (no skip)
    expect(calls.length).toBeLessThan(10);             // stopped paging early
  });

  // Windows may come back out of order across a flaky link; the result must be
  // ascending so callers' `maxUid`/`reverse()` assumptions hold.
  it('returns messages sorted ascending by UID', async () => {
    const client = {
      async fetchMessagesByUidRange(lo: number, hi: number) {
        // deliberately return within-window out of order
        return [3, 1, 2].filter((u) => u >= lo && u <= hi).map(msg);
      },
    } as unknown as IIMAPClient;
    const out = await fetchNewMessagesWindowed(client, 0, 4, undefined, { windowSize: 500 });
    expect(out.map((m) => m.uid)).toEqual([1, 2, 3]);
  });

  // A minimal client/fake without bounded-range support must still work — fall
  // back to getNewMessages, but keep the no-regress filter.
  it('falls back to getNewMessages when the client cannot do bounded ranges', async () => {
    const getNewMessages = vi.fn(async () => [msg(100), msg(101), msg(102)]);
    const client = { getNewMessages } as unknown as IIMAPClient;
    const out = await fetchNewMessagesWindowed(client, 100, 103);
    expect(getNewMessages).toHaveBeenCalledWith(100, undefined);
    expect(out.map((m) => m.uid)).toEqual([101, 102]); // boundary echo still filtered
  });
});
