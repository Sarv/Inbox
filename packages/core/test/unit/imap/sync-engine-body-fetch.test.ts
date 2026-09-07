import LRUCache from 'lru-cache';
import { describe, it, expect, vi } from 'vitest';


import { IMAPConnectionPool, PoolConnectionParkedError } from '../../../src/imap/connection-pool';
import {
  SyncEngine,
  BODY_FETCH_FAILURE_TTL_MS,
  UNSELECTABLE_FOLDER_TTL_MS,
} from '../../../src/imap/sync-engine';
import { BODY_FETCH_DEFERRED } from '../../../src/utils/deferred-fetch-error';
import { TimeoutError } from '../../../src/utils/timeout';


// Regression tests for the body-fetch POISON-PILL starvation bug.
//
// A body fetch that times out was thrown as our TimeoutError, whose message
// contains "timeout" — so isConnectionError() matched it and the engine treated
// it as a DEAD SOCKET: it re-queued the item at the HEAD of the queue, did NOT
// count it toward the retry cap, and BROKE the entire drain loop. Result: one
// message whose body always times out (large body / pipeline-corrupting server
// response) sat at the queue head forever, poisoned a fresh pooled connection
// every tick, and starved every other pending body — the reported "few mails'
// body never downloads" with app.log showing "0/N bodies fetched, N still
// without body" tick after tick.
//
// The fix: a per-operation timeout is distinct from a dead socket. It is COUNTED
// toward the retry cap, re-queued to the BACK (never the head), the drain keeps
// going, and after MAX_BODY_FETCH_RETRIES the item is settled so the
// caller/scheduler moves on instead of waiting forever.
//
// UPDATED (deliberate behaviour change): that "settled" used to be `resolve(null)`
// — the SAME value the engine uses for a real verdict ("the server has no such
// message"). The prefetch scheduler strikes on verdicts and, after 3, tags the row
// `|nobody|`, excluding it from every backlog query. So a run of timeouts, which
// says nothing about whether the message exists, permanently retired live mail.
// Exhausted timeouts now REJECT with the deferred-fetch signal instead, and every
// caller treats a throw as "ask again later". The tests below assert the
// rejection where they previously asserted a null.

const BODY = { rawBody: 'r', cleanBody: 'c', contentType: 'text/plain', source: 'raw' };

/** Assert a body fetch was DEFERRED (retry later), not answered with a verdict. */
async function expectDeferred(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: BODY_FETCH_DEFERRED });
}

function makeEngine() {
  const storage: any = {};
  const engine = new SyncEngine(storage);
  // Always "connected" so the drain loop runs; connectionPool stays null so the
  // single-connection path is used (concurrency 1 → deterministic).
  vi.spyOn(engine as any, 'isConnected').mockReturnValue(true);
  const fetchBody = vi.fn();
  (engine as any).messageProcessor = { fetchBody };
  // Prove the pipe is healthy by default so timeouts count as message strikes.
  // Individual tests that exercise the zombie-socket path set this back to 0.
  (engine as any).bodyFetchSuccessesSinceReconnect = 1;
  return { engine, fetchBody };
}

describe('SyncEngine body-fetch queue — poison-pill robustness', () => {
  it('a timing-out body does NOT starve the other pending bodies', async () => {
    // Breaks if a timeout re-blocks the queue head: good1/good2 would hang.
    const { engine, fetchBody } = makeEngine();
    fetchBody.mockImplementation(async (_c: unknown, _f: string, _u: number, _s: unknown, id: string) => {
      if (id === 'poison') throw new TimeoutError('Body fetch timeout');
      return BODY;
    });

    const poison = (engine as any).fetchBody('poison', 'INBOX', 1);
    const good1 = (engine as any).fetchBody('good1', 'INBOX', 2);
    const good2 = (engine as any).fetchBody('good2', 'INBOX', 3);

    // The healthy messages download even while the poison pill keeps timing out.
    await expect(good1).resolves.toMatchObject({ rawBody: 'r' });
    await expect(good2).resolves.toMatchObject({ rawBody: 'r' });
    // The poison pill settles (deferred) rather than hanging forever.
    await expectDeferred(poison);
  });

  it('caps timeout retries at MAX_BODY_FETCH_RETRIES, then DEFERS (no infinite loop, no verdict)', async () => {
    // Breaks if a timeout is treated as an un-counted connection error again:
    // the item would loop forever (the original bug) and this test would hang.
    // Breaks the OTHER way if the exhausted item resolves null: the scheduler
    // would read that as "no such message" and retire live mail after 3 ticks.
    const { engine, fetchBody } = makeEngine();
    fetchBody.mockRejectedValue(new TimeoutError('Body fetch timeout'));

    await expectDeferred((engine as any).fetchBody('poison', 'INBOX', 1));
    expect(fetchBody).toHaveBeenCalledTimes((engine as any).MAX_BODY_FETCH_RETRIES);
  });

  it('short-circuits a subsequent fetch for a cooling-down email without re-hitting IMAP', async () => {
    // The failure cap must persist: once it trips, re-requesting must not queue
    // another doomed fetch (which would re-open the starvation window) — but the
    // caller must be told "later", not "never".
    const { engine, fetchBody } = makeEngine();
    fetchBody.mockRejectedValue(new TimeoutError('Body fetch timeout'));

    await expectDeferred((engine as any).fetchBody('poison', 'INBOX', 1)); // exhaust retries
    fetchBody.mockClear();

    await expectDeferred((engine as any).fetchBody('poison', 'INBOX', 1));
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('a genuine timeout still succeeds if a later attempt returns a body (transient stall)', async () => {
    // A stall must not be permanent: if the body comes back before the cap, the
    // real body is delivered — timeouts are retried, not dead-lettered on first.
    const { engine, fetchBody } = makeEngine();
    let calls = 0;
    fetchBody.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new TimeoutError('Body fetch timeout');
      return BODY;
    });

    const p = (engine as any).fetchBody('flaky', 'INBOX', 1);
    await expect(p).resolves.toMatchObject({ rawBody: 'r' });
    expect(calls).toBe(3); // two stalls, then success — under the cap
  });
});

describe('SyncEngine body-fetch queue — zombie-socket vs poison-pill health gate', () => {
  it('does NOT accrue a give-up strike for a timeout while the socket is unproven (zombie guard)', async () => {
    // Regression: on a FLAPPING account the old code cleared the failure ledger
    // every reconnect, so poison pills reset to zero forever — but the inverse
    // must also hold: a dead socket where NOTHING has come back must not
    // blacklist good mail. Until a fetch succeeds, timeouts are retried without a
    // strike.
    const { engine, fetchBody } = makeEngine();
    (engine as any).bodyFetchSuccessesSinceReconnect = 0; // nothing has round-tripped yet
    fetchBody.mockImplementation(async () => {
      // Stop the queue so the (otherwise endless) retry loop exits deterministically.
      (engine as any).bodyFetchStopped = true;
      throw new TimeoutError('Body fetch timeout');
    });

    await (engine as any).fetchBody('z', 'INBOX', 1).catch(() => {});
    expect((engine as any).bodyFetchFailures.get('z') ?? 0).toBe(0); // no strike while unproven
  });

  it('starts counting timeouts once a fetch succeeds and proves the socket healthy', async () => {
    // The gate must OPEN on the first success: a good fetch proves the pipe, so a
    // subsequently-hanging message is its own fault and gives up (bounded),
    // instead of churning a connection forever (the reported stuck messages).
    const { engine, fetchBody } = makeEngine();
    (engine as any).bodyFetchSuccessesSinceReconnect = 0; // start unproven
    fetchBody.mockImplementation(async (_c: unknown, _f: string, _u: number, _s: unknown, id: string) => {
      if (id === 'good') return BODY;
      throw new TimeoutError('Body fetch timeout');
    });

    await expect((engine as any).fetchBody('good', 'INBOX', 1)).resolves.toMatchObject({ rawBody: 'r' });
    expect((engine as any).bodyFetchSuccessesSinceReconnect).toBeGreaterThan(0); // health proven

    // Now the poison pill accrues strikes and settles (deferred) rather than looping.
    await expectDeferred((engine as any).fetchBody('poison', 'INBOX', 2));
  });
});

describe('SyncEngine body-fetch queue — connection-cap park (drain-storm guard)', () => {
  // Regression: once the connect-timeout classification started PARKING the pool,
  // the drain still pulled every queued item, had each refused at acquire() with a
  // PoolConnectionParkedError, and fell through to the GENERIC catch — which
  // counted it as a retry (attempt N/5) AND rejected the listener, while logging
  // one WARN + one "Pool: not opening" per item. On a first-sync backlog that was
  // 100+ synchronous log writes per second (the "logs stuck / slow startup"
  // symptom) plus good mail losing its retry budget to a back-off that isn't its
  // fault. The drain must instead pause the whole queue for the park window.

  function makeEngineWithPool(remainingParkValues: number[]) {
    const { engine, fetchBody } = makeEngine();
    let call = 0;
    const withConnection = vi.fn(async () => { throw new PoolConnectionParkedError(90_000); });
    const remainingParkMs = vi.fn(() => remainingParkValues[Math.min(call++, remainingParkValues.length - 1)]);
    (engine as any).connectionPool = { isInitialized: () => true, remainingParkMs, withConnection };
    return { engine, fetchBody, withConnection, remainingParkMs };
  }

  it('a mid-batch park re-queues the item WITHOUT a strike and never rejects it', async () => {
    // Gate open at entry (drain proceeds), then the connect parks mid-batch.
    const { engine } = makeEngineWithPool([0, 90_000]);
    const reject = vi.fn();
    const resolve = vi.fn();
    const item = { emailId: 'a', folderPath: 'INBOX', uid: 1, listeners: [{ resolve, reject }], onStart: [] };
    (engine as any).bodyFetchQueue = [item];
    (engine as any).bodyFetchQueueIndex = new Map([['a', item]]);

    await (engine as any).processBodyFetchQueue();

    // A park is a back-off, not a failure: no strike, no reject/resolve — the item
    // is simply re-queued to retry after the window.
    expect((engine as any).bodyFetchFailures.get('a') ?? 0).toBe(0);
    expect(reject).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect((engine as any).bodyFetchQueue.map((i: any) => i.emailId)).toEqual(['a']);

    // Cleanup: cancel the scheduled resume so it can't fire into another test.
    clearTimeout((engine as any).bodyFetchResumeTimer);
  });

  it('skips the drain entirely while parked at entry — no per-item acquire, no flood', async () => {
    // The flood guard: while the gate is closed, the drain must NOT pull items and
    // refuse them one by one — it returns immediately, leaving the queue intact.
    const { engine, withConnection } = makeEngineWithPool([5_000]);
    const item = { emailId: 'a', folderPath: 'INBOX', uid: 1, listeners: [], onStart: [] };
    (engine as any).bodyFetchQueue = [item];
    (engine as any).bodyFetchQueueIndex = new Map([['a', item]]);

    await (engine as any).processBodyFetchQueue();

    expect(withConnection).not.toHaveBeenCalled(); // never even attempted a fetch
    expect((engine as any).bodyFetchQueue).toHaveLength(1); // item untouched
  });
});

describe('SyncEngine.initializePool — shared back-off wiring', () => {
  it('forwards the pool connect-gate hooks to the reconnect ladder too', async () => {
    // Regression: the primary reconnect ladder was the last connect path that
    // ignored the shared cap back-off. initializePool must hand the SAME
    // connectGate/onConnectError it gives the pool to the ConnectionManager, or
    // the primary keeps hammering a saturated cap while the pool waits (the
    // "stuck reconnecting" deadlock). The wiring is synchronous, before any pool
    // I/O, so we assert it without opening a socket.
    const engine = new SyncEngine({} as any);
    const spy = vi.spyOn((engine as any).connectionManager, 'setConnectBackoffHooks');
    // Don't let the real pool dial out — its init is irrelevant to this assertion.
    vi.spyOn(IMAPConnectionPool.prototype, 'initialize').mockResolvedValue(undefined as any);
    const connectGate = () => 123;
    const onConnectError = vi.fn();

    await engine.initializePool({ host: 'imap.gmail.com' } as any, { connectGate, onConnectError });

    expect(spy).toHaveBeenCalledWith(connectGate, onConnectError);
  });
});

describe('SyncEngine.requeueBodyFetch — head vs back placement', () => {
  it('re-queues a timed-out item to the BACK so it cannot block the queue head', () => {
    const { engine } = makeEngine();
    const A = { emailId: 'A', folderPath: 'INBOX', uid: 1, listeners: [], onStart: [] };
    const B = { emailId: 'B', folderPath: 'INBOX', uid: 2, listeners: [], onStart: [] };
    (engine as any).bodyFetchQueue = [A];
    (engine as any).bodyFetchQueueIndex = new Map([['A', A]]);

    (engine as any).requeueBodyFetch(B, true); // toBack

    expect((engine as any).bodyFetchQueue.map((i: any) => i.emailId)).toEqual(['A', 'B']);
  });

  it('re-queues a normal retry to the HEAD (user-initiated priority default)', () => {
    const { engine } = makeEngine();
    const A = { emailId: 'A', folderPath: 'INBOX', uid: 1, listeners: [], onStart: [] };
    const B = { emailId: 'B', folderPath: 'INBOX', uid: 2, listeners: [], onStart: [] };
    (engine as any).bodyFetchQueue = [A];
    (engine as any).bodyFetchQueueIndex = new Map([['A', A]]);

    (engine as any).requeueBodyFetch(B); // default → head

    expect((engine as any).bodyFetchQueue.map((i: any) => i.emailId)).toEqual(['B', 'A']);
  });
});

/**
 * The dequeue signal. Callers batch body fetches, so a deadline started at
 * enqueue really measures how deep the queue is: on a slow server the tail of
 * every batch expires before its FETCH is issued, the caller cancels work the
 * engine was about to do, and the prefetch scheduler re-asks for the same rows
 * next tick — the backlog stops draining. `onStart` is what lets a caller time
 * the FETCH instead of the wait (see `fetchBodyQueued`).
 */
describe('SyncEngine body-fetch queue — onStart dequeue signal', () => {
  it('fires when the item leaves the queue, not when it is enqueued', async () => {
    const { engine, fetchBody } = makeEngine();
    const order: string[] = [];
    let release: (() => void) | null = null;
    fetchBody.mockImplementation(async (_c: unknown, _f: string, _u: number, _s: unknown, id: string) => {
      order.push(`fetch:${id}`);
      if (id === 'first') await new Promise<void>((resolve) => { release = resolve; });
      return BODY;
    });

    const first = (engine as any).fetchBody('first', 'INBOX', 1, {
      onStart: () => order.push('start:first'),
    });
    // Queued BEHIND `first` (concurrency is 1 here) — its signal must not fire
    // while it is only waiting. That wait is exactly what used to be counted
    // against its fetch deadline.
    const second = (engine as any).fetchBody('second', 'INBOX', 2, {
      onStart: () => order.push('start:second'),
    });

    await vi.waitFor(() => expect(order).toContain('fetch:first'));
    expect(order).not.toContain('start:second');

    release!();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:first', 'fetch:first', 'start:second', 'fetch:second']);
  });

  it('signals every caller coalesced onto the same queued item', async () => {
    const { engine, fetchBody } = makeEngine();
    const started: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchBody.mockImplementation(async () => { await gate; return BODY; });

    // `blocker` occupies the single-connection drain so `dup` is still QUEUED
    // when the second request for it arrives and coalesces onto it.
    const blocker = (engine as any).fetchBody('blocker', 'INBOX', 9);
    const a = (engine as any).fetchBody('dup', 'INBOX', 1, { onStart: () => started.push('a') });
    const b = (engine as any).fetchBody('dup', 'INBOX', 1, { onStart: () => started.push('b') });

    release!();
    await Promise.all([blocker, a, b]);
    // Both callers time their own deadline; a coalesced one that never hears
    // "started" keeps the long queue deadline on a fetch already in flight.
    expect(started.sort()).toEqual(['a', 'b']);
  });

  it('signals ONCE per item — an engine retry must not extend a caller deadline', async () => {
    const { engine, fetchBody } = makeEngine();
    let starts = 0;
    // Times out twice (each is a re-queue + re-dequeue), then succeeds.
    let attempts = 0;
    fetchBody.mockImplementation(async () => {
      attempts += 1;
      if (attempts <= 2) throw new TimeoutError('Body fetch timeout');
      return BODY;
    });

    await expect(
      (engine as any).fetchBody('retry', 'INBOX', 1, { onStart: () => { starts += 1; } }),
    ).resolves.toMatchObject({ rawBody: 'r' });

    expect(attempts).toBe(3);
    expect(starts).toBe(1);
  });

  it('keeps draining when a caller callback throws', async () => {
    // A caller's own bookkeeping must never take the drain down with it —
    // that would strand every body queued behind it.
    const { engine, fetchBody } = makeEngine();
    fetchBody.mockResolvedValue(BODY);

    const bad = (engine as any).fetchBody('bad', 'INBOX', 1, {
      onStart: () => { throw new Error('caller exploded'); },
    });
    const good = (engine as any).fetchBody('good', 'INBOX', 2);

    await expect(bad).resolves.toMatchObject({ rawBody: 'r' });
    await expect(good).resolves.toMatchObject({ rawBody: 'r' });
  });

  it('still works for callers that pass no callback at all', async () => {
    const { engine, fetchBody } = makeEngine();
    fetchBody.mockResolvedValue(BODY);
    await expect((engine as any).fetchBody('plain', 'INBOX', 1)).resolves.toMatchObject({ rawBody: 'r' });
  });
});

// Regression suite for the VERDICT-vs-DEFERRED split (the mass `|nobody|` bug).
//
// Evidence from app.log: 332 distinct emails were retired as un-fetchable while
// the log contained ZERO "no message found for UID" lines — i.e. NONE of them
// had actually been answered by the server. 505 went in a single day, right
// after one transient `NO SELECT INBOX`, because the folder-level blacklist made
// every message in the mailbox resolve null. The three laundering points below
// must reject; and both blacklists must expire on their own, because the only
// thing that used to clear them was a forced reconnect.
describe('SyncEngine body-fetch queue — deferred conditions never look like a verdict', () => {
  it('an unselectable folder DEFERS the message instead of answering for it', async () => {
    // Breaks if the folder blacklist resolves null again: every message in a
    // momentarily-unopenable INBOX collects strikes and gets tagged `|nobody|`.
    const { engine, fetchBody } = makeEngine();
    (engine as any).unselectableFolders.set('INBOX', true);

    await expectDeferred((engine as any).fetchBody('a', 'INBOX', 1));
    expect(fetchBody).not.toHaveBeenCalled(); // still short-circuited (no churn)
  });

  it('a SELECT failure defers EVERY item queued on that folder, not just the current one', async () => {
    // The blast radius is the point: this is the path that retired 505 emails in
    // a day. All of them must be told "later", and none may carry the raw server
    // text (which some servers word as "mailbox not found" — the renderer reads
    // that as gone-from-server).
    const { engine, fetchBody } = makeEngine();
    const selectError = Object.assign(new Error('Command failed: NO SELECT completed'), {
      code: 'SELECT_FOLDER_ERROR',
    });
    fetchBody.mockRejectedValue(selectError);

    const first = (engine as any).fetchBody('a', 'INBOX', 1);
    const second = (engine as any).fetchBody('b', 'INBOX', 2);
    const other = (engine as any).fetchBody('c', 'Archive', 3);

    await expectDeferred(first);
    await expectDeferred(second);
    await expectDeferred(other.catch((e: Error) => { throw e; })); // Archive fails on its own
    expect((engine as any).unselectableFolders.has('INBOX')).toBe(true);
  });

  // Both blacklists below are TTL'd. The TTL is checked in two parts, because
  // lru-cache reads the clock straight from `performance.now()` — which vitest's
  // fake timers do not drive — so a 10-minute expiry can't be advanced in a test:
  //   1. the SHIPPED cache really carries the documented TTL, and
  //   2. the code path really re-opens once an entry expires (same cache class,
  //      same call, a TTL small enough to elapse for real).
  const TINY_TTL_MS = 20;
  const elapse = () => new Promise((r) => { setTimeout(r, TINY_TTL_MS * 3); });

  it('gives both blacklists a TTL, so neither can outlive the condition that set it', () => {
    // Breaks if either goes back to a plain Set/untimed cache: one `NO SELECT`
    // then sidelines a whole mailbox, and a bad hour retires an email, until the
    // next forced reconnect or app restart.
    const { engine } = makeEngine();
    expect((engine as any).unselectableFolders.ttl).toBe(UNSELECTABLE_FOLDER_TTL_MS);
    expect((engine as any).bodyFetchFailures.ttl).toBe(BODY_FETCH_FAILURE_TTL_MS);
    expect(UNSELECTABLE_FOLDER_TTL_MS).toBe(10 * 60_000);
    expect(BODY_FETCH_FAILURE_TTL_MS).toBe(15 * 60_000);
  });

  it('re-opens a folder once its blacklist entry expires', async () => {
    const { engine, fetchBody } = makeEngine();
    fetchBody.mockResolvedValue(BODY);
    (engine as any).unselectableFolders = new LRUCache<string, true>({ max: 10, ttl: TINY_TTL_MS });
    (engine as any).unselectableFolders.set('INBOX', true);

    await expectDeferred((engine as any).fetchBody('a', 'INBOX', 1)); // still sidelined
    await elapse();

    await expect((engine as any).fetchBody('a', 'INBOX', 1)).resolves.toMatchObject({ rawBody: 'r' });
  });

  it('retries an email once its failure ledger entry expires (cool-down, not a life sentence)', async () => {
    const { engine, fetchBody } = makeEngine();
    fetchBody.mockResolvedValue(BODY);
    (engine as any).bodyFetchFailures = new LRUCache<string, number>({ max: 10, ttl: TINY_TTL_MS });
    (engine as any).bodyFetchFailures.set('a', 5); // at the retry cap

    await expectDeferred((engine as any).fetchBody('a', 'INBOX', 1)); // cooling down
    await elapse();

    await expect((engine as any).fetchBody('a', 'INBOX', 1)).resolves.toMatchObject({ rawBody: 'r' });
  });

  it('an auth pause is still its own error, not a deferred fetch', async () => {
    // The UI needs the auth banner: laundering this into "retry later" would spin
    // silently forever on bad credentials.
    const { engine } = makeEngine();
    (engine as any).authPaused = true;
    await expect((engine as any).fetchBody('a', 'INBOX', 1)).rejects.toMatchObject({ code: 'AUTH_PAUSED' });
  });
});
