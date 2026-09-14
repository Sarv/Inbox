import { describe, it, expect } from 'vitest';

import { createMutex } from '../../../src/utils/mutex';

/**
 * `createMutex` is the serializer behind the IMAP mailbox lock. What it
 * guarantees is not "one at a time eventually" but "one at a time, in order,
 * even when a section throws" — a mutex that drops sections after a rejection
 * silently skips the flag reconcile or deletion sweep that was queued behind
 * the one that failed, which is exactly the class of bug it exists to stop.
 */

/** Resolve after `n` microtask turns — enough for an interleaving to show. */
const microticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe('createMutex', () => {
  // Regression: sections must not interleave. If they do, a SELECT lands inside
  // another caller's select-then-fetch and that fetch reads the wrong mailbox.
  it('never runs two sections concurrently', async () => {
    const mutex = createMutex();
    let running = 0;
    let maxConcurrent = 0;

    const section = async (): Promise<void> => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await microticks(3);
      running--;
    };

    await Promise.all([1, 2, 3, 4, 5].map(() => mutex.runExclusive(section)));

    expect(maxConcurrent).toBe(1);
  });

  // Regression: FIFO. An opportunistic re-select that barges ahead of an older
  // queued section would still reorder the work it was meant to wait for.
  it('runs sections in the order they were queued', async () => {
    const mutex = createMutex();
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map((n) =>
        mutex.runExclusive(async () => {
          // Later sections deliberately do LESS work, so completion order can
          // only be FIFO if the queue — not the work — decides it.
          await microticks(4 - n);
          order.push(n);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3]);
  });

  // Regression: a failed section must not wedge the queue. A transient IMAP
  // error (connection blip, timeout) in one reconcile would otherwise stop
  // EVERY later mailbox operation on that connection for the session's life.
  it('keeps running later sections after one rejects', async () => {
    const mutex = createMutex();
    const ran: string[] = [];

    const failing = mutex.runExclusive(async () => {
      ran.push('first');
      throw new Error('connection blip');
    });
    const after = mutex.runExclusive(async () => {
      ran.push('second');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('connection blip');
    await expect(after).resolves.toBe('ok');
    expect(ran).toEqual(['first', 'second']);
  });

  // Regression: the rejection belongs to the caller that queued it, and to
  // nobody else. Leaking it onto a neighbour would fail unrelated work; losing
  // it entirely would report a failed sweep as a successful one.
  it('rejects only the caller whose own section failed', async () => {
    const mutex = createMutex();

    const ok1 = mutex.runExclusive(async () => 'a');
    const bad = mutex.runExclusive(async () => {
      throw new Error('boom');
    });
    const ok2 = mutex.runExclusive(async () => 'b');

    await expect(ok1).resolves.toBe('a');
    await expect(bad).rejects.toThrow('boom');
    await expect(ok2).resolves.toBe('b');
  });

  // A synchronous throw from `fn` is the same failure as a rejected promise —
  // it must not escape past the chain and leave the tail permanently broken.
  it('survives a section that throws synchronously', async () => {
    const mutex = createMutex();

    const bad = mutex.runExclusive((() => {
      throw new Error('sync boom');
    }) as () => Promise<never>);

    await expect(bad).rejects.toThrow('sync boom');
    await expect(mutex.runExclusive(async () => 'still works')).resolves.toBe('still works');
  });

  it('hands back the section value', async () => {
    const mutex = createMutex();
    await expect(mutex.runExclusive(async () => 42)).resolves.toBe(42);
  });

  // `pending` is what diagnostics read to tell "the lock is busy" from "the lock
  // is wedged"; it must fall back to zero on the failure path too.
  it('counts queued sections and drains to zero, including after a rejection', async () => {
    const mutex = createMutex();
    expect(mutex.pending).toBe(0);

    const first = mutex.runExclusive(async () => {
      await microticks(2);
    });
    const second = mutex.runExclusive(async () => {
      throw new Error('nope');
    });
    expect(mutex.pending).toBe(2);

    await first;
    await expect(second).rejects.toThrow('nope');
    expect(mutex.pending).toBe(0);
  });

  // Idempotent re-run: a mutex that has already drained behaves like a fresh
  // one. Sync passes re-enter these sections constantly.
  it('serializes a second wave exactly like the first', async () => {
    const mutex = createMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.runExclusive(async () => { order.push('a'); }),
      mutex.runExclusive(async () => { order.push('b'); }),
    ]);
    await Promise.all([
      mutex.runExclusive(async () => { order.push('c'); }),
      mutex.runExclusive(async () => { order.push('d'); }),
    ]);

    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });
});
