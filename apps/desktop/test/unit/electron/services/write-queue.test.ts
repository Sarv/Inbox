import { describe, expect, it } from 'vitest';

import { createWriteQueue } from '../../../../electron/services/write-queue';

/**
 * The serialize-writes mutex behind every core-DB-backed store (credential
 * vault, oauth tokens, imap-account). Two invariants matter:
 *   - operations NEVER interleave (a read-modify-write can't be clobbered), and
 *   - a REJECTED op does not wedge the queue — the next one still runs.
 */

const defer = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createWriteQueue', () => {
  it('runs enqueued ops ONE at a time — no interleaving', async () => {
    const queue = createWriteQueue();
    const events: string[] = [];
    const makeOp = (name: string) => async () => {
      events.push(`${name}:start`);
      await tick();
      await tick();
      events.push(`${name}:end`);
    };

    await Promise.all([
      queue.enqueue(makeOp('a')),
      queue.enqueue(makeOp('b')),
      queue.enqueue(makeOp('c')),
    ]);

    expect(events).toEqual([
      'a:start', 'a:end',
      'b:start', 'b:end',
      'c:start', 'c:end',
    ]);
  });

  it('preserves FIFO order even when a later op is much faster', async () => {
    const queue = createWriteQueue();
    const order: number[] = [];
    const slow = queue.enqueue(async () => { await tick(); order.push(1); });
    const fast = queue.enqueue(async () => { order.push(2); });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  it('does not start the second op until the first has settled', async () => {
    const queue = createWriteQueue();
    const gate = defer();
    let secondStarted = false;

    const first = queue.enqueue(() => gate.promise);
    const second = queue.enqueue(async () => { secondStarted = true; });

    await tick();
    expect(secondStarted).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });

  it('a FAILING op rejects its own promise but does not stall the queue', async () => {
    const queue = createWriteQueue();
    const ran: string[] = [];

    const failing = queue.enqueue(async () => { ran.push('boom'); throw new Error('write failed'); });
    const after = queue.enqueue(async () => { ran.push('after'); });

    await expect(failing).rejects.toThrow('write failed');
    await expect(after).resolves.toBeUndefined();
    expect(ran).toEqual(['boom', 'after']);
  });

  it('a SYNCHRONOUSLY-throwing op also leaves the queue usable', async () => {
    const queue = createWriteQueue();
    const failing = queue.enqueue((() => { throw new Error('sync boom'); }) as () => Promise<void>);
    await expect(failing).rejects.toThrow('sync boom');
    let ran = false;
    await queue.enqueue(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('LAST write wins for a read-modify-write on shared state', async () => {
    const queue = createWriteQueue();
    let store = 'initial';
    const rmw = (next: string) => async () => {
      const current = store;       // read
      await tick();                // a window in which an interleaved write would clobber
      store = `${current}->${next}`; // write
    };
    await Promise.all([queue.enqueue(rmw('a')), queue.enqueue(rmw('b'))]);
    // Serialised: b observed a's write, so nothing was lost.
    expect(store).toBe('initial->a->b');
  });

  it('each queue instance is independent (separate mutexes)', async () => {
    const q1 = createWriteQueue();
    const q2 = createWriteQueue();
    const gate = defer();
    const blocked = q1.enqueue(() => gate.promise);
    let otherRan = false;
    const other = q2.enqueue(async () => { otherRan = true; });
    await other;
    expect(otherRan).toBe(true);
    gate.resolve();
    await blocked;
  });
});
