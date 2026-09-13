import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

/**
 * A FETCH that carries `source: true` downloads a whole message, so how long it
 * takes is a property of the message, not of the server's health. It used to be
 * raced against the same flat 60s budget as every other command — which made any
 * message too big to transfer in a minute permanently un-fetchable: the download
 * was killed at 60s, the socket recycled as "wedged", the item re-queued, and
 * the next attempt restarted from byte zero and died at exactly the same point.
 *
 * These tests pin the two halves of the replacement: a transfer that keeps
 * delivering bytes is left alone, a socket that has gone silent still fails
 * fast, and every OTHER command keeps the flat budget it needs.
 */

interface Internals {
  client: unknown;
  connectionState: string;
  currentFolder: string | null;
}

/** A client wired to a fake socket whose byte counter the test drives. */
function makeClient(fetchAll: () => Promise<unknown[]>, counter: { bytes: number }) {
  const client = new ImapFlowClient();
  const close = vi.fn();
  (client as unknown as Internals).client = {
    usable: true,
      mailbox: { path: 'INBOX' },
    stats: () => ({ sent: 0, received: counter.bytes }),
    fetchAll,
    close,
  };
  (client as unknown as Internals).connectionState = 'selected';
  (client as unknown as Internals).currentFolder = 'INBOX';
  return { client, close };
}

/** Track settlement without leaving an unhandled rejection behind. */
function watch(promise: Promise<unknown>) {
  const state = { settled: false, rejected: false };
  void promise.then(
    () => { state.settled = true; },
    () => { state.settled = true; state.rejected = true; },
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ImapFlowClient — body FETCH is bounded by a stall, not by the clock', () => {
  // THE regression. A 90-second download that never goes quiet must complete.
  // If this fails, large mail is un-fetchable again and the retry loop that
  // burns one pool connection per attempt comes back with it.
  it('lets a body fetch that keeps receiving bytes run well past 60s', async () => {
    const counter = { bytes: 0 };
    let finish!: (messages: unknown[]) => void;
    const fetching = new Promise<unknown[]>((resolve) => { finish = resolve; });
    const { client, close } = makeClient(() => fetching, counter);

    const result = client.fetchMessagesByUID([1], { fetchBody: true });
    const state = watch(result);

    for (let elapsed = 0; elapsed < 90_000; elapsed += 5_000) {
      counter.bytes += 64 * 1024; // a chunk arrived since the last tick
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(state.settled).toBe(false);

    finish([]);
    await expect(result).resolves.toEqual([]);
    // The socket was healthy throughout — it must not have been recycled.
    expect(close).not.toHaveBeenCalled();
  });

  // The other half: "slow" must not become an excuse to hang. A socket with
  // nothing arriving is a wedge and still has to fail at the stall window.
  it('fails a body fetch whose socket goes silent, at 30s rather than 60s', async () => {
    const counter = { bytes: 4096 }; // arrived early, then nothing
    const { client, close } = makeClient(() => new Promise(() => { /* never */ }), counter);

    const result = client.fetchMessagesByUID([1], { fetchBody: true });
    const state = watch(result);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.rejected).toBe(true);
    // A wedged command stays in flight on the socket, so the connection is
    // recycled — dropping this guard brings back the timeout cascade.
    expect(close).toHaveBeenCalled();
    await expect(result).rejects.toBeDefined();
  });

  // A transfer that trickles forever is still a failure, just a patient one —
  // without the ceiling a byte a minute would hold a pool connection for good.
  it('gives up on a body fetch still running after the 5-minute ceiling', async () => {
    const counter = { bytes: 0 };
    const { client } = makeClient(() => new Promise(() => { /* never */ }), counter);

    const result = client.fetchMessagesByUID([1], { fetchBody: true });
    const state = watch(result);

    // Keep it just alive enough to never trip the stall window.
    for (let elapsed = 0; elapsed < 295_000; elapsed += 5_000) {
      counter.bytes += 1;
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(state.settled).toBe(false);

    counter.bytes += 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.rejected).toBe(true);
    await expect(result).rejects.toBeDefined();
  });

  // Regression in the other direction: only the streaming fetch was meant to
  // change. Every other command is fixed-size work whose flat budget is what
  // detects a wedge quickly — loosening it globally would let a dead socket sit.
  it('still holds a metadata fetch to the flat 60s budget', async () => {
    const counter = { bytes: 0 };
    const { client, close } = makeClient(() => new Promise(() => { /* never */ }), counter);

    const result = client.fetchMessagesByUID([1]); // no fetchBody — envelopes only
    const state = watch(result);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.rejected).toBe(true);
    expect(close).toHaveBeenCalled();
    await expect(result).rejects.toBeDefined();
  });
});
