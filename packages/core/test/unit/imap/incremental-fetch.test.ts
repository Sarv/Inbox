import { describe, expect, it, vi } from 'vitest';

import {
  FETCH_TARGET_MS, fetchNewestMessagesWindowed, fetchNewMessagesWindowed, fetchPaceFor, fetchSizeAfterFailure, NEW_MESSAGE_WINDOW,
  newFetchPace, nextFetchSize, PACED_INITIAL_WINDOW, PACED_MIN_WINDOW, type FetchPace,
} from '../../../src/imap/incremental-fetch';
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

// These pin the fix for the bug where an account whose watermark had fallen far
// behind (INBOX at UID 3226 while the server was at uidNext 27709) never showed
// recent mail: the ascending walk could not cross the 24,482-UID gap inside the
// 120s sync timeout, so it was torn down every cycle and restarted from the same
// UID. Newest-first + a cap makes today's mail arrive on the FIRST pass, and
// `scannedDownToUid` is what stops the caller marking the skipped range as done.
describe('fetchNewestMessagesWindowed', () => {
  // The whole point: the newest UIDs must come back from the very first window,
  // not after traversing the entire gap. If this regresses, recent mail is again
  // thousands of messages behind and the user sees a month-old inbox.
  it('walks windows downward so the newest UIDs arrive first', async () => {
    const uids = Array.from({ length: 1200 }, (_, i) => i + 1); // UIDs 1..1200
    const { client, calls } = rangeClient(uids);

    const out = await fetchNewestMessagesWindowed(client, 0, 1201, undefined, { windowSize: 500 });

    expect(calls[0]).toEqual([701, 1200]);          // newest window FIRST
    expect(calls).toEqual([[701, 1200], [201, 700], [1, 200]]);
    expect(out.messages.map((m) => m.uid)).toEqual(uids); // uncapped: still everything
    expect(out.scannedDownToUid).toBe(1);                 // reached the floor
    expect((client as any).getNewMessages).not.toHaveBeenCalled();
  });

  // The cap is what keeps a pass inside the sync timeout on a far-behind folder.
  // It must stop early AND report how far down it got, so the caller knows a hole
  // is left below.
  it('stops at maxMessages and reports the hole it left below', async () => {
    const uids = Array.from({ length: 1200 }, (_, i) => i + 1);
    const { client, calls } = rangeClient(uids);

    const out = await fetchNewestMessagesWindowed(client, 0, 1201, undefined, {
      windowSize: 500,
      maxMessages: 500,
    });

    expect(calls).toEqual([[701, 1200]]);                  // one window, then stop
    expect(out.messages).toHaveLength(500);
    expect(out.messages.at(-1)!.uid).toBe(1200);           // the NEWEST mail
    expect(out.scannedDownToUid).toBe(701);                // > sinceUid+1 => hole below
  });

  // Covering the whole range must be distinguishable from stopping early —
  // it is the only signal that lets the caller safely advance lastSyncUid.
  it('reports sinceUid + 1 when it reached the watermark', async () => {
    const { client } = rangeClient([101, 102, 103]);
    const out = await fetchNewestMessagesWindowed(client, 100, 104, undefined, { windowSize: 500 });
    expect(out.scannedDownToUid).toBe(101); // sinceUid + 1 => no hole
    expect(out.messages.map((m) => m.uid)).toEqual([101, 102, 103]);
  });

  // Same no-regress guarantee as the ascending version: a server echoing the
  // boundary message must not push lastSyncUid backwards.
  it('drops any UID <= sinceUid (boundary echo)', async () => {
    const client = {
      async fetchMessagesByUidRange() { return [msg(100), msg(101), msg(102)]; },
    } as unknown as IIMAPClient;
    const out = await fetchNewestMessagesWindowed(client, 100, 103, undefined, { windowSize: 500 });
    expect(out.messages.map((m) => m.uid)).toEqual([101, 102]);
  });

  // Nothing newer than the watermark must cost a round-trip at all.
  it('does no fetch when the server has nothing newer', async () => {
    const { client, calls } = rangeClient([1, 2, 3]);
    const out = await fetchNewestMessagesWindowed(client, 3, 4);
    expect(calls).toEqual([]);
    expect(out.messages).toEqual([]);
    expect(out.scannedDownToUid).toBe(4); // sinceUid + 1 => nothing left behind
  });

  // Minimal fakes without bounded ranges still work; the unbounded fetch covers
  // the whole range, so it must report no hole.
  it('falls back to getNewMessages and reports no hole', async () => {
    const getNewMessages = vi.fn(async () => [msg(100), msg(101), msg(102)]);
    const client = { getNewMessages } as unknown as IIMAPClient;
    const out = await fetchNewestMessagesWindowed(client, 100, 103);
    expect(out.messages.map((m) => m.uid)).toEqual([101, 102]);
    expect(out.scannedDownToUid).toBe(101);
  });
});

// ── Pacing ───────────────────────────────────────────────────────────────────
//
// The incident (2026-11-12, imap.sarv.com): an INBOX about 490 messages behind
// showed no new mail for days. The server was answering roughly one header a
// second, so the 500-UID window could never finish; each pass timed out, kept
// nothing and retried the same window. These pin the replacement: fetch sizes
// follow the server's speed, a pass stops on a time budget, and whatever
// arrived before a failure is kept.

/**
 * A server that takes `msPerMessage` per header on a clock the test owns, and
 * cannot complete a FETCH longer than `failAfterMs` (the connection is cut and
 * nothing from that command is delivered).
 */
function slowServer(existingUids: number[], msPerMessage: number, failAfterMs = Infinity) {
  let clock = 0;
  const calls: Array<[number, number]> = [];
  const client = {
    async fetchMessagesByUidRange(lo: number, hi: number): Promise<IMAPMessage[]> {
      calls.push([lo, hi]);
      const found = existingUids.filter((u) => u >= lo && u <= hi);
      const cost = found.length * msPerMessage;
      if (cost > failAfterMs) { clock += failAfterMs; throw new Error('IMAP FETCH timed out (no data for 30s)'); }
      clock += cost;
      return found.map(msg);
    },
    getNewMessages: vi.fn(async () => { throw new Error('unbounded fetch must not be used'); }),
  } as unknown as IIMAPClient;
  return { client, calls, now: () => clock, advance: (ms: number) => { clock += ms; } };
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
const spans = (calls: Array<[number, number]>) => calls.map(([lo, hi]) => hi - lo + 1);

describe('fetch pacing', () => {
  // The sizing rule itself. If it stops shrinking for a slow reading the helper
  // goes back to asking a slow server for windows it cannot finish.
  it.each([
    [64, 1_000, 256],              // fast: grow, but by at most 4x per step
    [256, 500, 500],               // ...and never past the ceiling
    [64, FETCH_TARGET_MS, 64],     // on target: hold
    [64, 20_000, 32],              // twice as slow as the target: halve
    [64, 64_000, 16],              // very slow: shrink by at most 4x per step
    [10, 300_000, 8],              // ...and never below the floor
    [100, 0, 400],                 // an empty window answered instantly must not divide by zero
  ])('after a fetch of %i took %ims the next size is %i', (size, elapsed, expected) => {
    expect(nextFetchSize(size, elapsed, { min: 8, max: 500 })).toBe(expected);
  });

  it('quarters the size after a failure and stops at the floor', () => {
    expect(fetchSizeAfterFailure(500, 8)).toBe(125);
    expect(fetchSizeAfterFailure(20, 8)).toBe(8);
    expect(fetchSizeAfterFailure(8, 8)).toBe(8);
  });

  it('keeps one pace per key, so one folder never shrinks another', () => {
    const paces = new Map<string, FetchPace>();
    const inbox = fetchPaceFor(paces, 'INBOX');
    inbox.size = 8;
    expect(fetchPaceFor(paces, 'INBOX')).toBe(inbox);
    expect(fetchPaceFor(paces, 'Sent').size).toBe(PACED_INITIAL_WINDOW);
    expect(fetchPaceFor(paces, 'Drain', 100).size).toBe(100);
  });
});

describe('fetchNewestMessagesWindowed — paced for a slow server', () => {
  const NEW = range(1001, 1490);                       // 490 messages above the watermark

  // THE regression. One header a second: a fixed 500-UID window needs 490s and
  // the connection is cut long before. Unpaced, the pass throws with nothing.
  it('unpaced, a server too slow for the fixed window yields nothing at all', async () => {
    const server = slowServer(NEW, 1_000, 300_000);
    await expect(fetchNewestMessagesWindowed(server.client, 1000, 1491)).rejects.toThrow('timed out');
  });

  // The fix, first pass: the newest mail arrives inside the time budget. If
  // this returns nothing or throws, today's mail is invisible again.
  it('paced, the first pass returns the newest messages within its budget', async () => {
    const server = slowServer(NEW, 1_000, 300_000);
    const pace = newFetchPace();
    const out = await fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, { pace, budgetMs: 45_000, now: server.now });

    expect(spans(server.calls)).toEqual([PACED_INITIAL_WINDOW]);   // one window, then the budget is spent
    expect(out.messages.map((m) => m.uid)).toEqual(range(1427, 1490));
    expect(out.scannedDownToUid).toBe(1427);                        // a hole remains: do not advance the watermark
    expect(pace.size).toBe(16);                                     // 64s for 64 headers: ask for far less next time
  });

  // Later passes use the learned size, so each takes several small fetches that
  // all complete instead of one that cannot.
  it('paced, later passes use the learned size and each window completes', async () => {
    const server = slowServer(NEW, 1_000, 300_000);
    const pace = newFetchPace();
    const options = { pace, budgetMs: 45_000, now: server.now };
    await fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, options);
    server.calls.length = 0;

    const second = await fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, options);
    expect(spans(server.calls)).toEqual([16, 10, 10, 10]);          // 16s, then ~10s each, until 45s is spent
    expect(second.messages.map((m) => m.uid)).toEqual(range(1445, 1490));
    expect(Math.max(...spans(server.calls))).toBeLessThan(PACED_INITIAL_WINDOW);
  });

  // Partial/interrupted run: the connection dies on a later window. The mail
  // from the windows that completed must survive; throwing here is exactly how
  // a slow server became "no new mail".
  it('keeps what earlier windows fetched when a later window fails, and reports the hole', async () => {
    const server = slowServer(NEW, 1);
    const real = server.client.fetchMessagesByUidRange!.bind(server.client);
    let call = 0;
    (server.client as { fetchMessagesByUidRange: unknown }).fetchMessagesByUidRange = async (lo: number, hi: number) => {
      if (++call === 2) throw new Error('Connection not available');
      return real(lo, hi);
    };
    const pace = newFetchPace();
    const out = await fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, { pace, now: server.now });

    expect(out.messages.map((m) => m.uid)).toEqual(range(1427, 1490));
    expect(out.scannedDownToUid).toBe(1427);
    expect(pace.size).toBe(64);                                     // the failed window was 256: a quarter of it
  });

  // Transient failure with nothing fetched yet: an honest error (the caller
  // reports the sync as failed), but the next pass must ask for less — retrying
  // the identical window is the loop this fix removes.
  it('throws when the very first window fails, then asks for a quarter as much', async () => {
    const server = slowServer(NEW, 1_000, 30_000);                  // cut after 30s: 64 headers cannot finish
    const pace = newFetchPace();
    const options = { pace, budgetMs: 45_000, now: server.now };
    await expect(fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, options)).rejects.toThrow('timed out');
    expect(pace.size).toBe(16);

    const retry = await fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, options);
    expect(retry.messages.length).toBeGreaterThan(0);
    expect(retry.messages.at(-1)!.uid).toBe(1490);                  // the newest message is in the retry
  });

  // A server that stays broken keeps failing honestly and the size stops at the
  // floor: a permanent failure must not turn into an ever-smaller busy loop or
  // a silent "nothing new".
  it('keeps failing honestly at the floor while the server cannot serve even the smallest window', async () => {
    const server = slowServer(NEW, 1_000, 1_000);                   // cut after 1s: not even 2 headers
    const pace = newFetchPace();
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, { pace, now: server.now })).rejects.toThrow('timed out');
    }
    expect(pace.size).toBe(PACED_MIN_WINDOW);
  });

  // Idempotent re-run: the same pass twice returns the same mail and leaves the
  // same pace; nothing is skipped or double-counted by running it again.
  it('returns the same newest mail when the same pass is simply run again', async () => {
    const server = slowServer(NEW, 1);
    const pace = newFetchPace();
    const first = await fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, { pace, maxMessages: 100, now: server.now });
    const again = await fetchNewestMessagesWindowed(server.client, 1000, 1491, undefined, { pace: newFetchPace(), maxMessages: 100, now: server.now });
    expect(again.messages.map((m) => m.uid)).toEqual(first.messages.map((m) => m.uid));
    expect(again.scannedDownToUid).toBe(first.scannedDownToUid);
  });

  // The healthy case must not get slower: a fast server is back at the full
  // window within two fetches, and a small gap is still one round-trip.
  it('grows to the full window on a fast server and covers a small gap in one fetch', async () => {
    const big = slowServer(range(1, 3000), 1);
    await fetchNewestMessagesWindowed(big.client, 0, 3001, undefined, { pace: newFetchPace(), now: big.now });
    expect(spans(big.calls).slice(0, 4)).toEqual([64, 256, 500, 500]);

    const small = slowServer(range(101, 103), 1);
    const out = await fetchNewestMessagesWindowed(small.client, 100, 104, undefined, { pace: newFetchPace(), now: small.now });
    expect(small.calls).toEqual([[101, 103]]);
    expect(out.scannedDownToUid).toBe(101);                         // reached the watermark: it may advance
  });

  it('never paces past the caller’s windowSize', async () => {
    const server = slowServer(range(1, 1000), 1);
    await fetchNewestMessagesWindowed(server.client, 0, 1001, undefined, { pace: newFetchPace(), windowSize: 100, now: server.now });
    expect(Math.max(...spans(server.calls))).toBe(100);
  });
});

describe('fetchNewMessagesWindowed — paced for a slow server', () => {
  const NEW = range(1001, 1490);

  // The IDLE path walks UP from the watermark, so a budgeted pass returns a
  // contiguous prefix the caller advances over: progress every wake-up, where
  // the fixed window gave none.
  it('returns a contiguous prefix within the budget so the watermark can advance over it', async () => {
    const server = slowServer(NEW, 1_000, 300_000);
    const out = await fetchNewMessagesWindowed(server.client, 1000, 1491, undefined, { pace: newFetchPace(), budgetMs: 45_000, now: server.now });
    expect(out.map((m) => m.uid)).toEqual(range(1001, 1064));
  });

  it('keeps the contiguous prefix when a later window fails', async () => {
    const server = slowServer(NEW, 1);
    const real = server.client.fetchMessagesByUidRange!.bind(server.client);
    let call = 0;
    (server.client as { fetchMessagesByUidRange: unknown }).fetchMessagesByUidRange = async (lo: number, hi: number) => {
      if (++call === 3) throw new Error('Connection not available');
      return real(lo, hi);
    };
    const out = await fetchNewMessagesWindowed(server.client, 1000, 1491, undefined, { pace: newFetchPace(), now: server.now });
    expect(out.map((m) => m.uid)).toEqual(range(1001, 1320));       // windows of 64 and 256 arrived; the third failed
  });

  it('throws when nothing was fetched, so the caller does not mistake a failure for "no new mail"', async () => {
    const server = slowServer(NEW, 1_000, 5_000);
    const pace = newFetchPace();
    await expect(fetchNewMessagesWindowed(server.client, 1000, 1491, undefined, { pace, now: server.now })).rejects.toThrow('timed out');
    expect(pace.size).toBe(16);
  });
});
