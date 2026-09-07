import { describe, it, expect, vi, afterEach } from 'vitest';

import { isTimeoutError } from '../../../src/utils/timeout';
import {
  fetchBodyQueued,
  BODY_FETCH_QUEUE_WAIT_MS,
  BODY_FETCH_RUN_MS,
  type FetchedBody,
} from '../../../src/imap/fetch-body-queued';

/**
 * The single deadline policy for every batching caller of SyncEngine.fetchBody.
 *
 * What breaks if this file goes red: bodies stop arriving. A caller submits a
 * batch, the engine drains it a few at a time, and if the deadline is measured
 * from ENQUEUE the tail is cancelled before its FETCH is ever issued. The
 * prefetch scheduler then re-seeds the same newest-first rows every tick and the
 * backlog behind them is never attempted — "5/80 fetched, 75 retry later",
 * forever, with thousands of emails stuck at header-only.
 */

afterEach(() => {
  vi.useRealTimers();
});

const BODY: FetchedBody = { rawBody: 'raw', cleanBody: 'clean', contentType: 'text/html', source: 'imap' };

/** Engine stub that queues like the real one: the caller decides when to start. */
const makeEngine = () => {
  const started: Array<() => void> = [];
  let settle: ((body: FetchedBody | null) => void) | null = null;
  let fail: ((err: unknown) => void) | null = null;
  const calls: Array<{ emailId: string; folderPath: string; uid: number }> = [];

  const engine = {
    calls,
    /** Fire the dequeue signal the engine emits when the FETCH really starts. */
    start: () => started.forEach((cb) => cb()),
    resolve: (body: FetchedBody | null) => settle?.(body),
    reject: (err: unknown) => fail?.(err),
    fetchBody: (
      emailId: string,
      folderPath: string,
      uid: number,
      opts?: { onStart?: () => void },
    ): Promise<FetchedBody | null> => {
      calls.push({ emailId, folderPath, uid });
      if (opts?.onStart) started.push(opts.onStart);
      return new Promise<FetchedBody | null>((resolve, reject) => { settle = resolve; fail = reject; });
    },
  };
  return engine;
};

describe('fetchBodyQueued', () => {
  // The regression itself: time spent queued must not consume the fetch budget.
  it('does NOT time out while the item is still waiting its turn in the queue', async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const result = fetchBodyQueued(engine, 'e1', 'INBOX', 7).then((r) => r, (e) => e);

    // Far longer than a fetch is allowed to take, but still only queue time.
    await vi.advanceTimersByTimeAsync(BODY_FETCH_RUN_MS * 2);
    engine.start();
    engine.resolve(BODY);
    await expect(result).resolves.toEqual(BODY);
  });

  // …but a fetch that IS running still gets a tight leash, or one poison-pill
  // message would hold a whole tick.
  it('times out RUN_MS after the engine signals the fetch started', async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const result = fetchBodyQueued(engine, 'e1', 'INBOX', 7).then(() => 'resolved', (e) => e);

    engine.start();
    await vi.advanceTimersByTimeAsync(BODY_FETCH_RUN_MS + 1);
    const outcome = await result;
    expect(isTimeoutError(outcome)).toBe(true);
  });

  // An item nothing ever dequeues (queue wedged, engine parked) must not pin the
  // caller forever — the tick would never finish.
  it('times out after the QUEUE window when the fetch never starts', async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const result = fetchBodyQueued(engine, 'e1', 'INBOX', 7).then(() => 'resolved', (e) => e);

    await vi.advanceTimersByTimeAsync(BODY_FETCH_QUEUE_WAIT_MS + 1);
    expect(isTimeoutError(await result)).toBe(true);
  });

  // The engine can drain synchronously inside fetchBody when its queue is idle,
  // i.e. before the gate exists to receive the signal. Losing that signal would
  // silently leave the long queue deadline on a fetch that is already running.
  it('applies the RUN window even when the engine dequeues SYNCHRONOUSLY', async () => {
    vi.useFakeTimers();
    let settle: ((body: FetchedBody | null) => void) | null = null;
    const engine = {
      fetchBody: (_id: string, _path: string, _uid: number, opts?: { onStart?: () => void }) => {
        opts?.onStart?.();   // dequeued before fetchBodyQueued has its handle
        return new Promise<FetchedBody | null>((resolve) => { settle = resolve; });
      },
    };
    const result = fetchBodyQueued(engine, 'e1', 'INBOX', 7).then(() => 'resolved', (e) => e);

    await vi.advanceTimersByTimeAsync(BODY_FETCH_RUN_MS + 1);
    expect(isTimeoutError(await result)).toBe(true);
    expect(settle).not.toBeNull();
  });

  // A resolved null is the engine's VERDICT (no message for this UID). It must
  // reach the caller as null, not as a timeout — only a verdict may ever mark an
  // email permanently un-fetchable.
  it('passes a null verdict through instead of turning it into a timeout', async () => {
    const engine = makeEngine();
    const result = fetchBodyQueued(engine, 'ghost', 'INBOX', 999);
    engine.start();
    engine.resolve(null);
    await expect(result).resolves.toBeNull();
  });

  it('passes the engine rejection through unchanged', async () => {
    const engine = makeEngine();
    const result = fetchBodyQueued(engine, 'e1', 'INBOX', 7);
    engine.reject(new Error('Connection not available'));
    await expect(result).rejects.toThrow('Connection not available');
  });

  it('forwards the email, folder and uid to the engine untouched', async () => {
    const engine = makeEngine();
    const result = fetchBodyQueued(engine, 'e42', 'Archive/2026', 1234);
    engine.start();
    engine.resolve(BODY);
    await result;
    expect(engine.calls).toEqual([{ emailId: 'e42', folderPath: 'Archive/2026', uid: 1234 }]);
  });

  // Callers with a different tolerance (a user waiting on an open vs. background
  // backlog) must be able to tighten it without hand-rolling a second policy.
  it('accepts per-call overrides for both windows', async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const result = fetchBodyQueued(engine, 'e1', 'INBOX', 7, { queueMs: 500, runMs: 100 })
      .then(() => 'resolved', (e) => e);

    await vi.advanceTimersByTimeAsync(501);
    expect(isTimeoutError(await result)).toBe(true);
  });
});
