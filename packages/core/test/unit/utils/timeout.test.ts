import { describe, it, expect, vi, afterEach } from 'vitest';

import { TimeoutError, isTimeoutError, withTimeout, withStallTimeout, withStartGatedTimeout } from '../../../src/utils/timeout';

// withTimeout is the single wrapper around every IMAP connect / NOOP / fetch /
// reconnect. Two things must hold or the mail engine misbehaves in ways that are
// very hard to see: (1) a timeout must be DISTINGUISHABLE from a server NO/BAD,
// because the connection pool poisons the socket only on a timeout; (2) the timer
// must ALWAYS be cleared — the hand-rolled copies this replaced leaked a timer
// per call, which on the hot NOOP path keeps the event loop alive and delays exit.

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout — happy path', () => {
  it('resolves with the promise value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'nope')).resolves.toBe('ok');
  });

  // The timer must be gone the moment the race is won, not when it would fire.
  it('CLEARS its timer after the promise resolves (no leaked pending timer)', async () => {
    vi.useFakeTimers();
    let release: (v: string) => void = () => {};
    const inner = new Promise<string>((resolve) => {
      release = resolve;
    });

    const raced = withTimeout(inner, 60_000, 'should not fire');
    expect(vi.getTimerCount()).toBe(1); // armed while in flight

    release('done');
    await expect(raced).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0); // cleared, so nothing holds the loop open
  });

  it('CLEARS its timer after the promise rejects too', async () => {
    vi.useFakeTimers();
    const inner = Promise.reject(new Error('server said NO'));

    await expect(withTimeout(inner, 60_000, 'should not fire')).rejects.toThrow('server said NO');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withTimeout — losing the race', () => {
  it('rejects with a TimeoutError carrying the caller-supplied message', async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => {}); // never settles

    const raced = withTimeout(pending, 5_000, 'IMAP connect timed out after 5s');
    const assertion = expect(raced).rejects.toThrow('IMAP connect timed out after 5s');
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('rejects with an error the pool can recognise as a timeout', async () => {
    vi.useFakeTimers();
    const raced = withTimeout(new Promise<never>(() => {}), 100, 'boom');

    const captured = raced.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    const err = await captured;

    expect(err).toBeInstanceOf(TimeoutError);
    expect(isTimeoutError(err)).toBe(true);
    expect((err as TimeoutError).name).toBe('TimeoutError');
  });

  // One tick early must NOT reject: an off-by-one here would abort healthy
  // commands right at the boundary.
  it('does not fire before the deadline', async () => {
    vi.useFakeTimers();
    let release: (v: string) => void = () => {};
    const inner = new Promise<string>((resolve) => {
      release = resolve;
    });
    const raced = withTimeout(inner, 1_000, 'too slow');

    await vi.advanceTimersByTimeAsync(999);
    release('just in time');
    await expect(raced).resolves.toBe('just in time');
  });
});

describe('isTimeoutError', () => {
  // The pool must poison a connection ONLY on a timeout; misclassifying a
  // server-level rejection as a timeout would needlessly tear down good sockets.
  it('is true for a real TimeoutError', () => {
    expect(isTimeoutError(new TimeoutError('x'))).toBe(true);
  });

  // Errors cross the IPC / worker boundary and lose their prototype, so the
  // duck-typed `isTimeout` marker must still be honoured.
  it('is true for a structurally-cloned error that kept only the isTimeout marker', () => {
    expect(isTimeoutError({ message: 'x', isTimeout: true })).toBe(true);
  });

  it('is false for ordinary errors and non-errors', () => {
    expect(isTimeoutError(new Error('connection ended'))).toBe(false);
    expect(isTimeoutError({ isTimeout: false })).toBe(false);
    expect(isTimeoutError('timed out')).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

describe('TimeoutError', () => {
  it('is a real Error subclass so `throw`/`instanceof`/stack all behave', () => {
    const err = new TimeoutError('deadline exceeded');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('deadline exceeded');
    expect(err.isTimeout).toBe(true);
  });
});

/**
 * withStartGatedTimeout exists because a plain `withTimeout` around QUEUED work
 * measures the queue, not the work. Submit a batch of body fetches and the tail
 * expires while the head downloads — the caller then cancels fetches the engine
 * was about to run, re-asks for the same rows next round, and the backlog never
 * moves. Each test below pins one property that failure mode depends on.
 */
describe('withStartGatedTimeout', () => {
  const pending = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
    let resolve: (v: T) => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  // If the queue window didn't apply before start(), an item waiting its turn
  // would be killed by the short RUN deadline — the original bug.
  it('waits out the QUEUE window while the work has not started', async () => {
    vi.useFakeTimers();
    const p = pending<string>();
    const gate = withStartGatedTimeout(p.promise, { queueMs: 1000, runMs: 50, message: 'Timeout' });
    const settled = gate.result.then(() => 'resolved', (e) => e);

    // Well past runMs but inside queueMs: still waiting, not timed out.
    await vi.advanceTimersByTimeAsync(400);
    p.resolve('body');
    await expect(settled).resolves.toBe('resolved');
  });

  // The whole point: once the work is really running, the tight clock applies.
  it('switches to the RUN window as soon as start() is signalled', async () => {
    vi.useFakeTimers();
    const p = pending<string>();
    const gate = withStartGatedTimeout(p.promise, { queueMs: 10_000, runMs: 100, message: 'Timeout' });
    const settled = gate.result.then(() => 'resolved', (e) => e);

    gate.start();
    await vi.advanceTimersByTimeAsync(101);
    const outcome = await settled;
    expect(isTimeoutError(outcome)).toBe(true);
    expect((outcome as TimeoutError).message).toBe('Timeout');
  });

  // A callee that internally re-queues and retries would otherwise push the
  // caller's deadline out forever — the budget must stay bounded.
  it('honours only the FIRST start() so a retrying callee cannot extend the deadline', async () => {
    vi.useFakeTimers();
    const p = pending<string>();
    const gate = withStartGatedTimeout(p.promise, { queueMs: 10_000, runMs: 100, message: 'Timeout' });
    const settled = gate.result.then(() => 'resolved', (e) => e);

    gate.start();
    await vi.advanceTimersByTimeAsync(60);
    gate.start();   // a re-queue signalling "starting again" — must NOT reset
    await vi.advanceTimersByTimeAsync(45);
    expect(isTimeoutError(await settled)).toBe(true);
  });

  // Times out on queue wait alone: an item nothing ever dequeues is not a hang.
  it('times out on the QUEUE window when the work never starts', async () => {
    vi.useFakeTimers();
    const gate = withStartGatedTimeout(pending<string>().promise, {
      queueMs: 200, runMs: 5000, message: 'Timeout',
    });
    const settled = gate.result.then(() => 'resolved', (e) => e);
    await vi.advanceTimersByTimeAsync(201);
    expect(isTimeoutError(await settled)).toBe(true);
  });

  // A leaked timer keeps the Node event loop alive; on this hot path it would
  // pin one per body fetch.
  it('CLEARS its timer once settled, and a late start() cannot arm a new one', async () => {
    vi.useFakeTimers();
    const p = pending<string>();
    const gate = withStartGatedTimeout(p.promise, { queueMs: 1000, runMs: 1000, message: 'Timeout' });
    p.resolve('body');
    await expect(gate.result).resolves.toBe('body');
    expect(vi.getTimerCount()).toBe(0);

    gate.start();                       // signal arriving after the race is over
    expect(vi.getTimerCount()).toBe(0); // must not resurrect a timer
  });

  // Rejections must pass through untouched — a server NO/BAD is not a timeout,
  // and the pool only poisons a connection on the latter.
  it('passes an underlying rejection through unchanged', async () => {
    const p = pending<string>();
    const gate = withStartGatedTimeout(p.promise, { queueMs: 1000, runMs: 1000, message: 'Timeout' });
    p.reject(new Error('NO [SERVERBUG]'));
    await expect(gate.result).rejects.toThrow('NO [SERVERBUG]');
  });
});

// withStallTimeout replaced the flat body-fetch budget. The regressions it
// guards are the two halves of the same bug: a message big enough to need more
// than the old 30s could NEVER download — it failed at the same point on every
// retry and was eventually retired as un-fetchable — while a genuinely dead
// socket must still fail just as fast as it used to, or a broken connection sits
// there holding a pooled socket for the full ceiling.
describe('withStallTimeout', () => {
  const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());

  // A slow-but-progressing transfer is the case the flat timeout got wrong: as
  // long as bytes keep arriving it must be allowed to finish, however long it
  // takes. If this fails, large mail silently never downloads.
  it('lets a transfer that keeps making progress run past the stall window', async () => {
    vi.useFakeTimers();
    let bytes = 0;
    let finish: (v: string) => void = () => {};
    const inner = new Promise<string>((resolve) => { finish = resolve; });

    const raced = withStallTimeout(inner, {
      stallMs: 30_000, maxMs: 300_000, progress: () => bytes, message: 'Body fetch timeout',
    });

    // Four stall windows' worth of time, with bytes trickling in throughout.
    for (let tick = 0; tick < 120; tick++) {
      bytes += 1024;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    finish('body');
    await expect(raced).resolves.toBe('body');
  });

  // The other half: no bytes at all is a dead socket and must still fail inside
  // the stall window, not at the (much larger) ceiling.
  it('rejects with a TimeoutError once nothing has arrived for stallMs', async () => {
    vi.useFakeTimers();
    const raced = withStallTimeout(new Promise<never>(() => {}), {
      stallMs: 30_000, maxMs: 300_000, progress: () => 0, message: 'Body fetch timeout',
    });
    const settled = raced.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(29_000);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);

    const err = await settled;
    expect(isTimeoutError(err)).toBe(true);
    expect((err as Error).message).toContain('Body fetch timeout');
  });

  // A transfer that progresses forever must not hold its pooled connection
  // forever — the ceiling is what stops one message starving the queue.
  it('rejects at maxMs even while progress is still being made', async () => {
    vi.useFakeTimers();
    let bytes = 0;
    const raced = withStallTimeout(new Promise<never>(() => {}), {
      stallMs: 30_000, maxMs: 120_000, progress: () => { bytes += 1; return bytes; }, message: 'Body fetch timeout',
    });
    const settled = raced.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(121_000);
    const err = await settled;
    expect(isTimeoutError(err)).toBe(true);
    expect((err as Error).message).toContain('still running after');
  });

  // The pool evicts a connection held longer than STUCK_CONNECTION_TIMEOUT. A
  // download legitimately running past that must keep touching it, or the pool
  // pulls the socket out mid-transfer and the fetch can never complete.
  it('reports progress to onProgress so a long transfer keeps its pooled connection', async () => {
    vi.useFakeTimers();
    let bytes = 0;
    const touch = vi.fn();
    const raced = withStallTimeout(new Promise<string>((resolve) => { setTimeout(() => resolve('body'), 90_000); }), {
      stallMs: 30_000, maxMs: 300_000, progress: () => (bytes += 4096), onProgress: touch, message: 'Body fetch timeout',
    });

    await vi.advanceTimersByTimeAsync(95_000);
    await expect(raced).resolves.toBe('body');
    expect(touch).toHaveBeenCalled();
  });

  // An onProgress that throws is advisory bookkeeping, not the operation — it
  // must never turn a successful download into a failure.
  it('survives an onProgress callback that throws', async () => {
    vi.useFakeTimers();
    let bytes = 0;
    const raced = withStallTimeout(new Promise<string>((resolve) => { setTimeout(() => resolve('body'), 10_000); }), {
      stallMs: 30_000,
      maxMs: 300_000,
      progress: () => (bytes += 1),
      onProgress: () => { throw new Error('pool closed'); },
      message: 'Body fetch timeout',
    });

    await vi.advanceTimersByTimeAsync(11_000);
    await expect(raced).resolves.toBe('body');
  });

  // A client with no counter (or one that throws) must degrade to the old
  // fixed-budget behaviour rather than waiting forever for progress that can
  // never be observed.
  it.each([
    ['an unreadable counter', () => { throw new Error('no client'); }],
    ['a non-finite reading', () => Number.NaN],
  ])('falls back to a plain timeout given %s', async (_label, progress) => {
    vi.useFakeTimers();
    const raced = withStallTimeout(new Promise<never>(() => {}), {
      stallMs: 30_000, maxMs: 300_000, progress: progress as () => number, message: 'Body fetch timeout',
    });
    const settled = raced.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(isTimeoutError(await settled)).toBe(true);
  });

  // Same leak guarantee as withTimeout: the sampling interval keeps the event
  // loop alive, so it must be gone the moment the race settles either way.
  it('CLEARS its sampling interval when the promise settles', async () => {
    vi.useFakeTimers();
    let release: (v: string) => void = () => {};
    const inner = new Promise<string>((resolve) => { release = resolve; });

    const raced = withStallTimeout(inner, {
      stallMs: 30_000, maxMs: 300_000, progress: () => 0, message: 'nope',
    });
    expect(vi.getTimerCount()).toBe(1);

    release('ok');
    await expect(raced).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('CLEARS its sampling interval after it times out', async () => {
    vi.useFakeTimers();
    const raced = withStallTimeout(new Promise<never>(() => {}), {
      stallMs: 5_000, maxMs: 60_000, progress: () => 0, message: 'stalled',
    });
    const settled = raced.catch(() => 'timed out');

    await vi.advanceTimersByTimeAsync(6_000);
    expect(await settled).toBe('timed out');
    expect(vi.getTimerCount()).toBe(0);
  });
});
