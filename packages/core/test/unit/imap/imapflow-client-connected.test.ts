import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

/**
 * `isConnected()` must agree with the SOCKET, not just with our own state field.
 *
 * A wedged FETCH is recycled by close()ing the ImapFlow client (see `op()`), and
 * until ImapFlow's 'close' event lands, `connectionState` still reads
 * 'authenticated'. Everything that gates on isConnected() then works against a
 * dead client:
 *
 *   [IDLE] backgroundSync re-armed IDLE (socket alive) … → none
 *   Realtime: Failed to start IDLE: IMAPError: Connection not available
 *   Realtime: Failed to start monitoring (rt#2)
 *
 * That repeated every ~2 minutes for the whole session — IDLE *and* its polling
 * fallback both failing — so the account received no live mail at all while the
 * UI showed it as connected.
 *
 * These reach into the instance deliberately: the state pair being asserted
 * (our field vs the client's `usable`) is exactly what got out of sync, and
 * reproducing it through a real connection would need a server that wedges.
 */

type Internals = { connectionState: string; client: { usable?: boolean } | null };

const clientWith = (connectionState: string, usable?: boolean): ImapFlowClient => {
  const c = new ImapFlowClient();
  const internals = c as unknown as Internals;
  internals.connectionState = connectionState;
  internals.client = usable === undefined ? null : { usable };
  return c;
};

describe('ImapFlowClient.isConnected', () => {
  it('is false once the underlying socket is unusable, even while our state says authenticated', () => {
    expect(clientWith('authenticated', false).isConnected()).toBe(false);
    expect(clientWith('selected', false).isConnected()).toBe(false);
  });

  it('is true when both our state and the socket agree', () => {
    expect(clientWith('authenticated', true).isConnected()).toBe(true);
    expect(clientWith('selected', true).isConnected()).toBe(true);
  });

  // A client that doesn't report usability (or a test double) must not be
  // treated as dead — that would stop every sync path on such a client.
  it('trusts our state when the client does not report usability', () => {
    expect(clientWith('authenticated').isConnected()).toBe(true);
  });

  it('stays false for every non-connected state regardless of the socket', () => {
    for (const state of ['disconnected', 'connecting', 'error']) {
      expect(clientWith(state, true).isConnected()).toBe(false);
      expect(clientWith(state, false).isConnected()).toBe(false);
    }
  });

  it('reports not-connected on a brand-new client', () => {
    expect(new ImapFlowClient().isConnected()).toBe(false);
  });
});

describe('ImapFlowClient.fetchFlagsOnly — survives a mid-loop connection loss', () => {
  type FlagsInternals = {
    connectionState: string;
    currentFolder: string | null;
    client: {
      usable?: boolean;
      fetchAll: (...args: unknown[]) => Promise<Array<{ uid: number; flags?: string[] }>>;
    } | null;
  };
  // >500 UIDs => 2 batches (BATCH = 500), so the second iteration exercises the
  // per-batch connection guard.
  const uids600 = Array.from({ length: 600 }, (_, i) => i + 1);

  it('aborts with ONE clean connection error when the socket goes null mid-loop', async () => {
    // Regression: after a STATUS-wedge recycle `this.client` becomes null, and
    // every remaining batch hit `this.client!.fetchAll` — the cryptic "Cannot read
    // properties of null (reading 'fetchAll')" logged 18× in a single session.
    // Now the loop stops at the dead batch and throws a single NOT_CONNECTED the
    // caller re-queues, rather than null-derefing (and mislogging) per batch.
    const c = new ImapFlowClient();
    const internals = c as unknown as FlagsInternals;
    internals.connectionState = 'selected';
    internals.currentFolder = 'INBOX';
    let calls = 0;
    internals.client = {
      usable: true,
      mailbox: { path: 'INBOX' },
      fetchAll: async () => { calls += 1; internals.client = null; return []; },
    };
    await expect(c.fetchFlagsOnly(uids600)).rejects.toThrow(/not connected/i);
    expect(calls).toBe(1); // the second batch never issued a command — aborted at the guard
  });

  it('isolates a per-batch SERVER error: skips it and keeps the flags that landed', async () => {
    // A "Command failed" on one UID range must NOT abort the whole read — the
    // batches that land still reconcile their slice (better than all-or-nothing).
    // Only a CONNECTION error aborts; a server error is per-batch.
    const c = new ImapFlowClient();
    const internals = c as unknown as FlagsInternals;
    internals.connectionState = 'selected';
    internals.currentFolder = 'INBOX';
    let calls = 0;
    internals.client = {
      usable: true,
      mailbox: { path: 'INBOX' },
      fetchAll: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Command failed'); // NOT a connection error
        return [{ uid: 501, flags: ['\\Seen'] }];
      },
    };
    const out = await c.fetchFlagsOnly(uids600);
    expect(calls).toBe(2);                                   // both batches attempted
    expect(out).toEqual([{ uid: 501, flags: ['\\Seen'] }]);  // only the batch that landed
  });

  it('fires the onBatch heartbeat once per SUCCESSFUL batch', async () => {
    // A whole-mailbox flag re-read (26k UIDs => 52 batches) runs on ONE pooled
    // connection and out-lasts the pool's 120s stuck-eviction. The per-batch
    // onBatch is what lets the caller refresh the connection's acquiredAt so it
    // isn't reclaimed mid-read (poisoned socket -> reconnect storm -> mail stops).
    // It must fire exactly once for each batch that actually completed.
    const c = new ImapFlowClient();
    const internals = c as unknown as FlagsInternals;
    internals.connectionState = 'selected';
    internals.currentFolder = 'INBOX';
    internals.client = { usable: true, mailbox: { path: 'INBOX' }, fetchAll: async () => [] };
    const onBatch = vi.fn();

    await c.fetchFlagsOnly(uids600, onBatch); // 600 uids => 2 batches

    expect(onBatch).toHaveBeenCalledTimes(2);
  });

  it('does NOT heartbeat for a batch aborted at the connection guard', async () => {
    // If the socket dies mid-loop the remaining batches never run, so their
    // heartbeats must not fire — a heartbeat for work that never happened would
    // keep a dead connection alive in the pool.
    const c = new ImapFlowClient();
    const internals = c as unknown as FlagsInternals;
    internals.connectionState = 'selected';
    internals.currentFolder = 'INBOX';
    internals.client = {
      usable: true,
      mailbox: { path: 'INBOX' },
      fetchAll: async () => { internals.client = null; return []; },
    };
    const onBatch = vi.fn();

    await expect(c.fetchFlagsOnly(uids600, onBatch)).rejects.toThrow(/not connected/i);
    expect(onBatch).toHaveBeenCalledTimes(1); // only the first batch completed
  });
});
