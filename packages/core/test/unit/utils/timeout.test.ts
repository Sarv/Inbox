import { describe, it, expect, vi, afterEach } from 'vitest';

import { TimeoutError, isTimeoutError, withTimeout, withStartGatedTimeout } from '../../../src/utils/timeout';

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
