import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeImapServer, type FakeImapServerOptions } from '../../../src/test-support/fake-imap-server';
import { setLogLevel } from '../../../src/utils/logger';

import { OperationQueue } from '../../../src/imap/operation-queue';

// The operation queue is the at-least-once pipeline behind EVERY user action
// (read/unread/star/move/archive/delete/label). A regression here silently loses
// a user's action or applies it twice, so this suite pins the load-bearing
// invariants rather than the implementation details:
//
//   - persist-first: the row exists in SQLite BEFORE the IMAP command is sent,
//     and is deleted only after the server accepted it
//   - batching: N UIDs of the same kind become ONE server command, and a failing
//     batch never swallows the batches behind it
//   - at-least-once + idempotence: a transient failure re-queues WITHOUT burning
//     a retry; a permanent one dead-letters after maxRetries instead of looping
//   - offline: ops queue (never throw) and drain in issue order once connected
//   - concurrency: two drains can't overlap; a mid-sync op defers off the
//     command-serialized primary connection instead of interleaving
//   - flag/move/delete mapping: the right IMAP flags, the destination UID from
//     the server's UID map, \Deleted + EXPUNGE for a hard delete
//
// Everything runs against the shared FakeImapServer, so "one command" claims are
// asserted from its call log instead of a hand-rolled client double.

setLogLevel('error'); // the queue logs an INFO line per op; keep test output readable

// ── errors ────────────────────────────────────────────────────────────────
// Classification (imap-errors) is what decides re-queue vs dead-letter, so use
// messages that really match each branch.

/** Socket-level: isConnectionError → re-queue, no retry burned. */
const connErr = () => new Error('Connection not available');
/** Command-level rejection: no classifier matches → retry ladder → dead-letter. */
const permErr = (msg = 'NO Invalid mailbox name') => new Error(msg);

// ── fake storage ──────────────────────────────────────────────────────────

interface OpRow {
  id: number;
  type: string;
  folderPath: string;
  uid: number;
  data: unknown;
  status: string;
  retryCount: number;
  lastError: string | null;
  attemptedCommand: string | null;
  serverResponse: string | null;
  createdAt: number;
}

interface EmailRow { id: string; folderId: string; uid: number; messageId: string | null }

/**
 * In-memory stand-in for the pending_operations / folders / emails methods the
 * queue touches. Faithful to the SQL that matters:
 *   - savePendingOperation is INSERT OR REPLACE on the (type, folder_path, uid)
 *     UNIQUE index → the old row is dropped and the new one gets a FRESH rowid
 *   - getPendingOperations excludes dead-lettered rows and orders by created_at
 *   - getPendingOperationUidsByFolder only reports pending/executing (a 'failed'
 *     op no longer protects the local optimistic value)
 */
function makeFakeStorage() {
  const ops = new Map<number, OpRow>();
  const folders = new Map<string, { id: string; path: string }>();
  const emails: EmailRow[] = [];
  let seq = 0;
  let createdSeq = 0;

  const uniqueKey = (o: { type: string; folderPath: string; uid: number }) =>
    `${o.type}|${o.folderPath}|${o.uid}`;

  const insertOrReplace = (op: { type: string; folderPath: string; uid: number; data?: unknown; retryCount: number }) => {
    for (const [id, row] of ops) if (uniqueKey(row) === uniqueKey(op)) ops.delete(id);
    const id = ++seq;
    ops.set(id, {
      id,
      type: op.type,
      folderPath: op.folderPath,
      uid: op.uid,
      data: op.data ?? null,
      status: 'pending',
      retryCount: op.retryCount ?? 0,
      lastError: null,
      attemptedCommand: null,
      serverResponse: null,
      createdAt: ++createdSeq,
    });
    return id;
  };

  return {
    ops,
    folders,
    emails,

    // ---- test-side helpers
    addFolder(path: string) {
      folders.set(path, { id: `f-${path}`, path });
      return `f-${path}`;
    },
    addEmail(row: EmailRow) {
      emails.push(row);
      return row;
    },
    /** Rows still on disk, oldest first — "did we really persist / clean up?" */
    rows() {
      return [...ops.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    statuses() {
      return this.rows().map((r) => r.status);
    },

    // ---- IEmailStorage subset
    async savePendingOperation(op: { type: string; folderPath: string; uid: number; data?: unknown; retryCount: number }) {
      return insertOrReplace(op);
    },
    async savePendingOperationsBatch(list: Array<{ type: string; folderPath: string; uid: number; data?: unknown; retryCount: number }>) {
      return list.map((op) => insertOrReplace(op));
    },
    async getPendingOperations() {
      return [...ops.values()]
        .filter((r) => r.status !== 'failed')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => ({ ...r }));
    },
    getPendingOperationUidsByFolder: vi.fn(async (folderPath: string) => [
      ...new Set(
        [...ops.values()]
          .filter((r) => r.folderPath === folderPath && r.uid > 0 && (r.status === 'pending' || r.status === 'executing'))
          .map((r) => r.uid),
      ),
    ]),
    async updatePendingOperationStatus(id: number, status: string) {
      const row = ops.get(id);
      if (row) row.status = status;
    },
    async updatePendingOperationRetry(id: number, retryCount: number) {
      const row = ops.get(id);
      if (row) row.retryCount = retryCount;
    },
    async deletePendingOperation(id: number) {
      ops.delete(id);
    },
    async deletePendingOperationsBatch(ids: number[]) {
      for (const id of ids) ops.delete(id);
    },
    async markPendingOperationFailed(
      id: number,
      lastError: string,
      detail?: { attemptedCommand?: string; serverResponse?: string },
    ) {
      const row = ops.get(id);
      if (!row) return;
      row.status = 'failed';
      row.lastError = lastError;
      row.attemptedCommand = detail?.attemptedCommand ?? null;
      row.serverResponse = detail?.serverResponse ?? null;
    },
    async getFailedOperations() {
      return [...ops.values()].filter((r) => r.status === 'failed').map((r) => ({ ...r }));
    },
    async resetFailedOperation(id: number) {
      const row = ops.get(id);
      if (row) {
        row.status = 'pending';
        row.retryCount = 0;
      }
    },
    async getFolderByPath(path: string) {
      return folders.get(path) ?? null;
    },
    async getEmailByFolderAndUid(folderId: string, uid: number) {
      return emails.find((e) => e.folderId === folderId && e.uid === uid) ?? null;
    },
    updateEmail: vi.fn(async (id: string, updates: { uid?: number }) => {
      const row = emails.find((e) => e.id === id);
      if (row && typeof updates.uid === 'number') row.uid = updates.uid;
    }),
  };
}

type FakeStorage = ReturnType<typeof makeFakeStorage>;

// ── harness ───────────────────────────────────────────────────────────────

/** A mailbox with the special-use folders the move/archive/trash paths resolve. */
async function makeServer(options: FakeImapServerOptions = {}) {
  const server = new FakeImapServer(options);
  await server.connect();
  server.addFolder('INBOX');
  server.addFolder('Trash', { specialUse: '\\Trash' });
  server.addFolder('Junk', { specialUse: '\\Junk' });
  server.addFolder('Archive', { specialUse: '\\Archive' });
  server.addMessages('INBOX', 3); // UIDs 1..3
  server.addMessages('Trash', 5); // so a moved message gets a DIFFERENT dest UID
  return server;
}

interface Harness {
  queue: OperationQueue;
  server: FakeImapServer;
  storage: FakeStorage;
  state: { connected: boolean; syncing: boolean };
}

async function makeHarness(opts: {
  server?: FakeImapServer;
  maxRetries?: number;
  acquireConnection?: () => Promise<{ client: any; release: () => void; poison: () => void } | null>;
} = {}): Promise<Harness> {
  const server = opts.server ?? (await makeServer());
  const storage = makeFakeStorage();
  const state = { connected: true, syncing: false };
  const queue = new OperationQueue(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries });
  queue.initialize({
    client: server as any,
    storage: storage as any,
    isConnected: () => state.connected,
    isSyncing: () => state.syncing,
    ...(opts.acquireConnection ? { acquireConnection: opts.acquireConnection } : {}),
  });
  return { queue, server, storage, state };
}

/**
 * Make `method` reject for its first `times` invocations, then behave normally.
 * Returns an attempt counter — a rejected call never reaches the server's own
 * call log, so this is how "we stopped retrying" is asserted.
 */
function failFirst(target: any, method: string, error: Error, times = Number.POSITIVE_INFINITY): () => number {
  const original = target[method].bind(target);
  let seen = 0;
  target[method] = async (...args: unknown[]) => {
    if (seen++ < times) throw error;
    return original(...args);
  };
  return () => seen;
}

/** Apply the change on the server and THEN reject — a lost ACK, the classic
 *  double-apply trap: the server has it, we don't know that. */
function applyThenFail(target: any, method: string, error: Error, times = 1): void {
  const original = target[method].bind(target);
  let seen = 0;
  target[method] = async (...args: unknown[]) => {
    const result = await original(...args);
    if (seen++ < times) throw error;
    return result;
  };
}

/** Suspend `method` until the returned release() is called. */
function gate(target: any, method: string): () => void {
  const original = target[method].bind(target);
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  target[method] = async (...args: unknown[]) => {
    await opened;
    return original(...args);
  };
  return () => release();
}

// ══════════════════════════════════════════════════════════════════════════

describe('OperationQueue — flag ops map to the right IMAP flags', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });

  it('markAsRead adds \\Seen (one SELECT + one STORE)', async () => {
    expect(await h.queue.markAsRead('INBOX', 1)).toBe('success');
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
    expect(h.server.callCount('addFlags')).toBe(1);
    expect(h.server.callCount('removeFlags')).toBe(0);
  });

  it('markAsUnread removes \\Seen', async () => {
    h.server.setFlagsOnServer('INBOX', 1, ['\\Seen']);
    expect(await h.queue.markAsUnread('INBOX', 1)).toBe('success');
    expect(h.server.flagsOf('INBOX', 1)).toEqual([]);
  });

  it('star / unstar map to \\Flagged and never touch \\Seen', async () => {
    h.server.setFlagsOnServer('INBOX', 2, ['\\Seen']);
    await h.queue.star('INBOX', 2);
    expect(h.server.flagsOf('INBOX', 2)).toEqual(['\\Flagged', '\\Seen']);
    await h.queue.unstar('INBOX', 2);
    expect(h.server.flagsOf('INBOX', 2)).toEqual(['\\Seen']);
  });

  it('a bulk mark-read of many UIDs is ONE STORE command, not one per message', async () => {
    const uids = [1, 2, 3];
    expect(await h.queue.bulkMarkAsRead('INBOX', uids)).toBe('success');
    expect(h.server.callCount('addFlags')).toBe(1);   // batched
    expect(h.server.callCount('selectFolder')).toBe(1);
    for (const uid of uids) expect(h.server.flagsOf('INBOX', uid)).toEqual(['\\Seen']);
  });

  it('a bulk op with no UIDs short-circuits: no persistence, no server round trip', async () => {
    expect(await h.queue.bulkMarkAsRead('INBOX', [])).toBe('success');
    expect(h.storage.rows()).toHaveLength(0);
    expect(h.server.callCount('addFlags')).toBe(0);
  });

  it('an unknown operation type throws instead of silently succeeding', async () => {
    await expect((h.queue as any).executeBatchedOperation('nonsense', 'INBOX', [1], null))
      .rejects.toThrow(/Unknown operation type/);
  });

  it('the flag fast-path refuses a non-flag op rather than quietly doing nothing', async () => {
    await expect((h.queue as any).runFlagOp(h.server, 'move', 'INBOX', [1]))
      .rejects.toThrow(/not a flag op/);
    expect(h.server.callCount('moveMessages')).toBe(0);
  });

  it('refuses to run before initialize() — no silent drop of the action', async () => {
    const bare = new OperationQueue();
    await expect(bare.markAsRead('INBOX', 1)).rejects.toThrow(/not initialized/);
    await expect(bare.bulkMarkAsRead('INBOX', [1])).rejects.toThrow(/not initialized/);
  });
});

describe('OperationQueue — persist-first', () => {
  it('the row is on disk BEFORE the IMAP command is issued, and gone after it succeeds', async () => {
    const h = await makeHarness();
    const seenDuringCommand: Array<{ status: string; type: string }> = [];
    const original = h.server.addFlags.bind(h.server);
    (h.server as any).addFlags = async (...args: unknown[]) => {
      seenDuringCommand.push(...h.storage.rows().map((r) => ({ status: r.status, type: r.type })));
      return (original as any)(...args);
    };

    await h.queue.markAsRead('INBOX', 1);

    // Durable, and flagged as in-flight, at the moment we hit the wire.
    expect(seenDuringCommand).toEqual([{ status: 'executing', type: 'markRead' }]);
    // Cleaned up only after the server accepted it.
    expect(h.storage.rows()).toHaveLength(0);
  });

  it('a permanent failure keeps the op as a dead-letter row (never dropped) and rethrows', async () => {
    const h = await makeHarness();
    const err = Object.assign(permErr('NO [CANNOT] invalid mailbox'), {
      executedCommand: 'UID STORE 1 +FLAGS (\\Seen)',
      responseStatus: 'NO',
      responseText: '[CANNOT] invalid mailbox',
    });
    failFirst(h.server, 'addFlags', err);

    await expect(h.queue.markAsRead('INBOX', 1)).rejects.toThrow(/invalid mailbox/);

    const [row] = h.storage.rows();
    expect(row.status).toBe('failed');
    // The Outbox shows the command we sent AND the server's reply — both captured.
    expect(row.attemptedCommand).toBe('UID STORE 1 +FLAGS (\\Seen)');
    expect(row.serverResponse).toBe('NO [CANNOT] invalid mailbox');
    expect(h.queue.isEmpty).toBe(true); // dead-lettered, not spinning in memory
  });

  it('a bulk permanent failure dead-letters EVERY op in the batch', async () => {
    const h = await makeHarness();
    failFirst(h.server, 'addFlags', permErr());
    await expect(h.queue.bulkMarkAsRead('INBOX', [1, 2, 3])).rejects.toThrow();
    expect(h.storage.statuses()).toEqual(['failed', 'failed', 'failed']);
  });
});

describe('OperationQueue — offline behaviour', () => {
  it('queues instead of throwing when disconnected, and touches no connection', async () => {
    const h = await makeHarness();
    h.state.connected = false;

    expect(await h.queue.markAsRead('INBOX', 1)).toBe('queued');
    expect(await h.queue.bulkStar('INBOX', [2, 3])).toBe('queued');

    expect(h.queue.length).toBe(3);
    expect(h.server.callCount('addFlags')).toBe(0);
    expect(h.storage.statuses()).toEqual(['pending', 'pending', 'pending']);
  });

  it('a connection that drops MID-command re-queues the op instead of failing it', async () => {
    const h = await makeHarness();
    failFirst(h.server, 'addFlags', connErr(), 1);

    expect(await h.queue.markAsRead('INBOX', 1)).toBe('queued'); // not 'failed', not a throw

    expect(h.queue.length).toBe(1);
    expect(h.storage.statuses()).toEqual(['pending']);
  });

  it('a bulk op that hits a dropped connection re-queues EVERY UID', async () => {
    const h = await makeHarness();
    failFirst(h.server, 'addFlags', connErr(), 1);

    expect(await h.queue.bulkMarkAsRead('INBOX', [1, 2, 3])).toBe('queued');

    expect(h.queue.length).toBe(3);
    expect(h.storage.statuses()).toEqual(['pending', 'pending', 'pending']);
    expect(await h.queue.processQueue()).toEqual({ success: 3, failed: 0 }); // nothing lost
  });

  it('drains queued ops once connected, batching each kind into ONE command', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.bulkMarkAsRead('INBOX', [1, 2]);
    await h.queue.star('INBOX', 3);

    h.state.connected = true;
    expect(await h.queue.processQueue()).toEqual({ success: 3, failed: 0 });

    expect(h.server.callCount('addFlags')).toBe(2); // one \Seen STORE + one \Flagged STORE
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
    expect(h.server.flagsOf('INBOX', 3)).toEqual(['\\Flagged']);
    expect(h.queue.isEmpty).toBe(true);
    expect(h.storage.rows()).toHaveLength(0); // durable rows cleared on success
  });

  it('drains in the order the ops were issued (read then unread ends UNREAD)', async () => {
    const h = await makeHarness();
    h.server.setFlagsOnServer('INBOX', 1, []);
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    await h.queue.markAsUnread('INBOX', 1);

    h.state.connected = true;
    await h.queue.processQueue();

    expect(h.server.calls.indexOf('addFlags')).toBeLessThan(h.server.calls.indexOf('removeFlags'));
    expect(h.server.flagsOf('INBOX', 1)).toEqual([]); // last action wins
  });

  it('re-queuing the SAME op while offline dedupes to one row and one command', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    await h.queue.markAsRead('INBOX', 1);

    expect(h.queue.length).toBe(1);
    expect(h.storage.rows()).toHaveLength(1); // INSERT OR REPLACE on (type, folder, uid)

    h.state.connected = true;
    await h.queue.processQueue();
    expect(h.server.callCount('addFlags')).toBe(1);
  });

  // The user's LAST action must win. addToMemoryQueue dedupes by
  // (type, folder, uid); writing the replacement back into the OLD SLOT meant a
  // re-issued action kept its original position, so offline
  // read → unread → read drained as [markRead, markUnread] and the message ended
  // UNREAD — the opposite of what was asked. The replacement now moves to the tail.
  it('applies the user\'s LAST action when one is re-issued (read → unread → read)', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    await h.queue.markAsUnread('INBOX', 1);
    await h.queue.markAsRead('INBOX', 1); // the user's LAST action

    h.state.connected = true;
    await h.queue.processQueue();

    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
  });

  it('a queued op whose message vanished server-side does not kill the drain', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.bulkMarkAsRead('INBOX', [1, 2]);
    h.state.connected = true;
    h.server.expungeOnServer('INBOX', 2); // another client deleted it meanwhile

    expect(await h.queue.processQueue()).toEqual({ success: 2, failed: 0 });
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']); // survivor still applied
    expect(h.storage.rows()).toHaveLength(0);
  });

  it('a batch that fails does NOT swallow the batches behind it', async () => {
    const h = await makeHarness({ maxRetries: 3 });
    h.server.setFlagsOnServer('INBOX', 3, ['\\Seen']);
    h.state.connected = false;
    await h.queue.bulkMarkAsRead('INBOX', [1, 2]); // batch 1 — will fail
    await h.queue.markAsUnread('INBOX', 3);        // batch 2 — must still run
    h.state.connected = true;
    failFirst(h.server, 'addFlags', permErr());

    expect(await h.queue.processQueue()).toEqual({ success: 1, failed: 2 });

    expect(h.server.flagsOf('INBOX', 3)).toEqual([]);   // batch 2 applied
    expect(h.queue.length).toBe(2);                      // batch 1 kept for retry
    expect(h.storage.rows().map((r) => [r.uid, r.retryCount])).toEqual([[1, 1], [2, 1]]);
  });

  it('a folder that no longer exists fails that batch only, and the drain continues', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('Ghost', 9);   // folder deleted server-side
    await h.queue.markAsRead('INBOX', 1);
    h.state.connected = true;

    expect(await h.queue.processQueue()).toEqual({ success: 1, failed: 1 });
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
  });

  it('a bookkeeping hiccup in SQLite during a drain still lands the action on the server', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    h.state.connected = true;
    // Every status/retry write fails (e.g. the row was already cleaned up, or a
    // transient DB error). The IMAP side must still go through.
    (h.storage as any).updatePendingOperationStatus = async () => { throw new Error('db locked'); };
    (h.storage as any).updatePendingOperationRetry = async () => { throw new Error('db locked'); };

    expect(await h.queue.processQueue()).toEqual({ success: 1, failed: 0 });
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
  });

  it('a drain whose bookkeeping AND command both fail still dead-letters without throwing', async () => {
    const h = await makeHarness({ maxRetries: 1 });
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    h.state.connected = true;
    failFirst(h.server, 'addFlags', permErr());
    (h.storage as any).updatePendingOperationStatus = async () => { throw new Error('db locked'); };
    (h.storage as any).markPendingOperationFailed = async () => { throw new Error('db locked'); };

    expect(await h.queue.processQueue()).toEqual({ success: 0, failed: 1 });
    expect(h.queue.isEmpty).toBe(true); // gave up cleanly instead of spinning
  });

  it('processQueue is a no-op while disconnected — the ops stay queued, not failed', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);

    expect(await h.queue.processQueue()).toEqual({ success: 0, failed: 0 });
    expect(h.queue.length).toBe(1);
    expect(h.storage.statuses()).toEqual(['pending']);
  });

  it('processQueue on an empty queue is a no-op', async () => {
    const h = await makeHarness();
    expect(await h.queue.processQueue()).toEqual({ success: 0, failed: 0 });
  });
});

describe('OperationQueue — at-least-once and idempotence', () => {
  it('a transient failure re-queues WITHOUT burning a retry, and the next drain applies it', async () => {
    const h = await makeHarness({ maxRetries: 3 });
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    h.state.connected = true;
    failFirst(h.server, 'addFlags', connErr(), 1);

    expect(await h.queue.processQueue()).toEqual({ success: 0, failed: 1 });
    expect(h.queue.length).toBe(1);
    expect(h.storage.rows()[0].retryCount).toBe(0); // transient ≠ a burned attempt
    expect(h.storage.rows()[0].status).toBe('pending');

    expect(await h.queue.processQueue()).toEqual({ success: 1, failed: 0 });
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
  });

  it('a retry after a LOST ACK does not double-apply (the change is idempotent)', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    h.state.connected = true;
    applyThenFail(h.server, 'addFlags', connErr(), 1); // server got it; we never heard back

    await h.queue.processQueue(); // re-queued
    await h.queue.processQueue(); // applied again

    expect(h.server.callCount('addFlags')).toBe(2);            // at-least-once, as designed
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);  // …but the state is unchanged
    expect(h.storage.rows()).toHaveLength(0);                  // and the row is cleaned up once
  });

  it('a rate-limit / quota rejection is transient too — never a burned retry', async () => {
    for (const error of [new Error('Request is throttled. try again later'), new Error('Too many simultaneous connections')]) {
      const h = await makeHarness();
      h.state.connected = false;
      await h.queue.markAsRead('INBOX', 1);
      h.state.connected = true;
      failFirst(h.server, 'addFlags', error, 1);

      await h.queue.processQueue();
      expect(h.storage.rows()[0].retryCount).toBe(0);
      expect(h.storage.rows()[0].status).toBe('pending');
    }
  });

  it('a permanent failure stops after maxRetries and dead-letters — it never loops forever', async () => {
    const h = await makeHarness({ maxRetries: 2 });
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    h.state.connected = true;
    const attempts = failFirst(h.server, 'addFlags', permErr('NO [AUTHENTICATIONFAILED] invalid credentials'));

    expect(await h.queue.processQueue()).toEqual({ success: 0, failed: 1 }); // attempt 1
    expect(h.storage.rows()[0].retryCount).toBe(1);
    expect(await h.queue.processQueue()).toEqual({ success: 0, failed: 1 }); // attempt 2 → cap
    expect(attempts()).toBe(2);

    expect(h.queue.isEmpty).toBe(true);
    expect(h.storage.rows()[0].status).toBe('failed');
    // Further drains do NOT re-attempt it — no infinite retry storm.
    expect(await h.queue.processQueue()).toEqual({ success: 0, failed: 0 });
    expect(attempts()).toBe(2);
  });

  it('retryFailed() re-arms every dead-letter, and the next drain lands it', async () => {
    const h = await makeHarness();
    failFirst(h.server, 'addFlags', permErr(), 1);
    await expect(h.queue.markAsRead('INBOX', 1)).rejects.toThrow();
    expect(h.storage.rows()[0].status).toBe('failed');

    expect(await h.queue.retryFailed()).toBe(1);
    expect(h.storage.rows()[0].status).toBe('pending');
    expect(h.queue.length).toBe(1);

    expect(await h.queue.processQueue()).toEqual({ success: 1, failed: 0 });
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
  });

  it('retryFailedOne re-arms just that op, and reports false for an unknown id', async () => {
    const h = await makeHarness();
    failFirst(h.server, 'addFlags', permErr(), 2);
    await expect(h.queue.markAsRead('INBOX', 1)).rejects.toThrow();
    await expect(h.queue.star('INBOX', 2)).rejects.toThrow();
    const [first] = h.storage.rows();

    expect(await h.queue.retryFailedOne(first.id)).toBe(true);
    expect(await h.queue.retryFailedOne(9999)).toBe(false);

    expect(h.queue.length).toBe(1);
    expect(h.storage.rows().map((r) => r.status)).toEqual(['pending', 'failed']);
  });
});

describe('OperationQueue — crash recovery (loadFromStorage)', () => {
  it('reloads persisted ops and resets a crashed executing row back to pending', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    await h.queue.star('INBOX', 2);
    // Simulate a crash mid-flight + a fresh process: one row was left 'executing'.
    const [first] = h.storage.rows();
    first.status = 'executing';
    const fresh = new OperationQueue();
    fresh.initialize({
      client: h.server as any,
      storage: h.storage as any,
      isConnected: () => true,
      isSyncing: () => false,
    });

    await fresh.loadFromStorage();

    expect(fresh.length).toBe(2);
    expect(h.storage.statuses()).toEqual(['pending', 'pending']);
    expect(await fresh.processQueue()).toEqual({ success: 2, failed: 0 });
  });

  it('a storage failure during load is swallowed — startup never dies on the queue', async () => {
    const h = await makeHarness();
    (h.storage as any).getPendingOperations = async () => { throw new Error('db locked'); };
    await expect(h.queue.loadFromStorage()).resolves.toBeUndefined();
    expect(h.queue.isEmpty).toBe(true);
  });
});

describe('OperationQueue — concurrency', () => {
  it('never runs two drains at once (the second call is a no-op while one is in flight)', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.bulkMarkAsRead('INBOX', [1, 2]);
    h.state.connected = true;
    const open = gate(h.server, 'addFlags');

    const first = h.queue.processQueue();
    expect(await h.queue.processQueue()).toEqual({ success: 0, failed: 0 }); // refused, not re-run
    open();

    expect(await first).toEqual({ success: 2, failed: 0 });
    expect(h.server.callCount('addFlags')).toBe(1); // exactly one STORE, never doubled
  });

  it('a mid-sync action defers off the command-serialized primary instead of interleaving', async () => {
    const h = await makeHarness();
    h.state.syncing = true;

    expect(await h.queue.markAsRead('INBOX', 1)).toBe('queued');
    expect(h.server.callCount('addFlags')).toBe(0); // nothing sent while the sync holds the link
    expect(h.storage.statuses()).toEqual(['pending']);

    h.state.syncing = false;
    expect(await h.queue.processQueue()).toEqual({ success: 1, failed: 0 });
    expect(h.server.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
  });

  it('a drain still runs while isSyncing() is true — a stuck sync flag cannot strand the queue', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    h.state.connected = true;
    h.state.syncing = true;

    expect(await h.queue.processQueue()).toEqual({ success: 1, failed: 0 });
  });
});

describe('OperationQueue — leased (pool) connection for flag ops', () => {
  it('runs the flag op on the LEASED connection and releases it — even mid-sync', async () => {
    const pool = await makeServer();
    const release = vi.fn();
    const poison = vi.fn();
    const h = await makeHarness({ acquireConnection: async () => ({ client: pool as any, release, poison }) });
    h.state.syncing = true; // the primary is busy; the lease is the whole point

    expect(await h.queue.markAsRead('INBOX', 1)).toBe('success');

    expect(pool.flagsOf('INBOX', 1)).toEqual(['\\Seen']);
    expect(h.server.callCount('addFlags')).toBe(0); // primary untouched
    expect(release).toHaveBeenCalledTimes(1);
    expect(poison).not.toHaveBeenCalled();
    expect(h.storage.rows()).toHaveLength(0);
  });

  it('reuses the already-selected mailbox on the lease: no redundant SELECT round trip', async () => {
    const pool = await makeServer();
    const h = await makeHarness({
      acquireConnection: async () => ({ client: pool as any, release: () => {}, poison: () => {} }),
    });

    await h.queue.markAsRead('INBOX', 1);
    await h.queue.star('INBOX', 2);

    expect(pool.callCount('selectFolder')).toBe(1); // ensureFolderSelected fast path
    expect(pool.callCount('addFlags')).toBe(2);
  });

  it('falls back to selectFolder on a lease without the ensureFolderSelected fast path', async () => {
    const pool = await makeServer();
    (pool as any).ensureFolderSelected = undefined;
    const h = await makeHarness({
      acquireConnection: async () => ({ client: pool as any, release: () => {}, poison: () => {} }),
    });

    await h.queue.markAsRead('INBOX', 1);
    await h.queue.star('INBOX', 1);

    expect(pool.callCount('selectFolder')).toBe(2);
    expect(pool.flagsOf('INBOX', 1)).toEqual(['\\Flagged', '\\Seen']);
  });

  it('poisons the lease and re-queues on a connection error (never reuses a mid-flight socket)', async () => {
    const pool = await makeServer();
    const release = vi.fn();
    const poison = vi.fn();
    failFirst(pool, 'addFlags', connErr());
    const h = await makeHarness({ acquireConnection: async () => ({ client: pool as any, release, poison }) });

    expect(await h.queue.markAsRead('INBOX', 1)).toBe('queued');

    expect(poison).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(h.queue.length).toBe(1);
    expect(h.storage.statuses()).toEqual(['pending']);
  });

  it('poisons the lease and dead-letters on a permanent error', async () => {
    const pool = await makeServer();
    const poison = vi.fn();
    failFirst(pool, 'addFlags', permErr());
    const h = await makeHarness({
      acquireConnection: async () => ({ client: pool as any, release: () => {}, poison }),
    });

    await expect(h.queue.markAsRead('INBOX', 1)).rejects.toThrow();
    expect(poison).toHaveBeenCalledTimes(1);
    expect(h.storage.rows()[0].status).toBe('failed');
  });

  it('falls through to the primary when the pool has nothing to lend (or the lease throws)', async () => {
    for (const acquireConnection of [async () => null, async () => { throw new Error('pool exhausted'); }]) {
      const h = await makeHarness({ acquireConnection: acquireConnection as any });
      expect(await h.queue.markAsRead('INBOX', 1)).toBe('success');
      expect(h.server.callCount('addFlags')).toBe(1); // primary did the work
    }
  });

  it('maps every flag op correctly on the lease, not just mark-read', async () => {
    const pool = await makeServer();
    pool.setFlagsOnServer('INBOX', 1, ['\\Seen', '\\Flagged']);
    const h = await makeHarness({
      acquireConnection: async () => ({ client: pool as any, release: () => {}, poison: () => {} }),
    });

    await h.queue.markAsUnread('INBOX', 1);
    await h.queue.unstar('INBOX', 1);

    expect(pool.flagsOf('INBOX', 1)).toEqual([]);
    expect(pool.callCount('removeFlags')).toBe(2);
  });

  it('does NOT lease for non-flag ops — moves/deletes stay on the primary', async () => {
    const pool = await makeServer();
    const acquire = vi.fn(async () => ({ client: pool as any, release: () => {}, poison: () => {} }));
    const h = await makeHarness({ acquireConnection: acquire });

    await h.queue.moveToTrash('INBOX', 1);

    expect(acquire).not.toHaveBeenCalled();
    expect(h.server.callCount('moveMessages')).toBe(1);
  });
});

describe('OperationQueue — moves, archive and delete', () => {
  it('moveToTrash resolves the \\Trash folder and writes back the destination UID', async () => {
    const h = await makeHarness();
    h.storage.addFolder('Trash');
    h.storage.addEmail({ id: 'e1', folderId: 'f-Trash', uid: 1, messageId: '<a@x>' });

    expect(await h.queue.moveToTrash('INBOX', 1)).toBe('success');

    expect(h.server.uidsIn('INBOX')).toEqual([2, 3]);
    expect(h.server.uidsIn('Trash')).toEqual([1, 2, 3, 4, 5, 6]); // landed as UID 6
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { uid: 6 });
    expect(h.storage.emails[0].uid).toBe(6); // local row now matches its folder
  });

  it('caches the special folder: a second trash move issues no second LIST', async () => {
    const h = await makeHarness();
    await h.queue.moveToTrash('INBOX', 1);
    await h.queue.moveToTrash('INBOX', 2);
    expect(h.server.callCount('listFolders')).toBe(1);

    h.queue.clear(); // clear() drops the cache too
    await h.queue.moveToTrash('INBOX', 3);
    expect(h.server.callCount('listFolders')).toBe(2);
  });

  it('moveToSpam and archive resolve \\Junk and \\Archive respectively', async () => {
    const h = await makeHarness();
    await h.queue.moveToSpam('INBOX', 1);
    await h.queue.archive('INBOX', 2);
    expect(h.server.uidsIn('Junk')).toEqual([1]);
    expect(h.server.uidsIn('Archive')).toEqual([1]);
    expect(h.server.uidsIn('INBOX')).toEqual([3]);
  });

  it('a missing special folder dead-letters the op instead of losing the mail', async () => {
    const server = new FakeImapServer();
    await server.connect();
    server.addFolder('INBOX');
    server.addMessages('INBOX', 1);
    const h = await makeHarness({ server });

    await expect(h.queue.moveToTrash('INBOX', 1)).rejects.toThrow(/trash folder not found/);
    expect(h.storage.rows()[0].status).toBe('failed');
    expect(h.server.uidsIn('INBOX')).toEqual([1]); // still there, nothing silently dropped
  });

  it('bulkMove sends ONE move command for all UIDs to the given destination', async () => {
    const h = await makeHarness();
    expect(await h.queue.bulkMove('INBOX', [1, 2, 3], 'Archive')).toBe('success');
    expect(h.server.callCount('moveMessages')).toBe(1);
    expect(h.server.uidsIn('Archive')).toEqual([1, 2, 3]);
    expect(h.server.messageCount('INBOX')).toBe(0);
  });

  // Copy is NOT move: the message must stay in the source AND appear in the dest.
  // If a regression turned this into a move (or dropped the source), the user
  // would lose the original — the exact data-loss this guards.
  it('copy adds the message to the destination and LEAVES the source in place', async () => {
    const h = await makeHarness();
    expect(await h.queue.copy('INBOX', 1, 'Archive')).toBe('success');
    expect(h.server.callCount('copyMessages')).toBe(1);
    expect(h.server.callCount('moveMessages')).toBe(0); // must never move on a copy
    expect(h.server.uidsIn('Archive').length).toBe(1);  // a copy landed in the dest
    expect(h.server.messageCount('INBOX')).toBe(3);     // …and the original stayed
  });

  it('bulkCopy sends ONE copy command for all UIDs and keeps every original', async () => {
    const h = await makeHarness();
    expect(await h.queue.bulkCopy('INBOX', [1, 2, 3], 'Archive')).toBe('success');
    expect(h.server.callCount('copyMessages')).toBe(1);
    expect(h.server.callCount('moveMessages')).toBe(0);
    expect(h.server.uidsIn('Archive').length).toBe(3);
    expect(h.server.messageCount('INBOX')).toBe(3);     // originals all retained
  });

  it('an offline copy queues and replays on reconnect (persist-first)', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.copy('INBOX', 1, 'Archive');
    expect(h.server.callCount('copyMessages')).toBe(0); // nothing hit the server yet
    h.state.connected = true;
    expect(await h.queue.processQueue()).toEqual({ success: 1, failed: 0 });
    expect(h.server.callCount('copyMessages')).toBe(1);
    expect(h.server.messageCount('INBOX')).toBe(3);     // still not a move
  });

  it('moves to DIFFERENT destinations are not merged into one batch', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.move('INBOX', 1, 'Archive');
    await h.queue.move('INBOX', 2, 'Junk');
    h.state.connected = true;

    expect(await h.queue.processQueue()).toEqual({ success: 2, failed: 0 });
    expect(h.server.callCount('moveMessages')).toBe(2);
    expect(h.server.uidsIn('Archive')).toEqual([1]);
    expect(h.server.uidsIn('Junk')).toEqual([1]);
  });

  it('bulk unread / unstar each collapse into one \\Seen / \\Flagged removal', async () => {
    const h = await makeHarness();
    h.server.setFlagsOnServer('INBOX', 1, ['\\Seen', '\\Flagged']);
    h.server.setFlagsOnServer('INBOX', 2, ['\\Seen', '\\Flagged']);

    expect(await h.queue.bulkMarkAsUnread('INBOX', [1, 2])).toBe('success');
    expect(await h.queue.bulkUnstar('INBOX', [1, 2])).toBe('success');

    expect(h.server.callCount('removeFlags')).toBe(2);
    expect(h.server.flagsOf('INBOX', 1)).toEqual([]);
    expect(h.server.flagsOf('INBOX', 2)).toEqual([]);
  });

  it('bulk trash / spam / archive each issue ONE move to the right special folder', async () => {
    const h = await makeHarness();
    h.server.addMessages('INBOX', 3); // UIDs 4..6

    expect(await h.queue.bulkMoveToTrash('INBOX', [1, 2])).toBe('success');
    expect(await h.queue.bulkMoveToSpam('INBOX', [3, 4])).toBe('success');
    expect(await h.queue.bulkArchive('INBOX', [5, 6])).toBe('success');

    expect(h.server.callCount('moveMessages')).toBe(3);
    expect(h.server.messageCount('Trash')).toBe(7); // the 5 that were there + 2
    expect(h.server.messageCount('Junk')).toBe(2);
    expect(h.server.messageCount('Archive')).toBe(2);
    expect(h.server.messageCount('INBOX')).toBe(0);
  });

  it('a large bulk stays a single STORE (the log truncates, the command does not)', async () => {
    const h = await makeHarness();
    const uids = h.server.addMessages('INBOX', 25);

    expect(await h.queue.bulkMarkAsRead('INBOX', uids)).toBe('success');

    expect(h.server.callCount('addFlags')).toBe(1);
    for (const uid of uids) expect(h.server.flagsOf('INBOX', uid)).toEqual(['\\Seen']);
  });

  it('finds a special folder nested inside a parent (e.g. [Gmail]/Trash)', async () => {
    const h = await makeHarness();
    h.server.addFolder('[Gmail]/Trash');
    (h.server as any).listFolders = async () => [
      { path: 'INBOX', children: [] },
      { path: '[Gmail]', children: [{ path: '[Gmail]/Trash', specialUse: '\\Trash' }] },
    ];

    expect(await h.queue.moveToTrash('INBOX', 1)).toBe('success');
    expect(h.server.messageCount('[Gmail]/Trash')).toBe(1);
  });

  it('delete uses \\Deleted then EXPUNGE, in that order', async () => {
    const h = await makeHarness();
    expect(await h.queue.delete('INBOX', 2)).toBe('success');

    expect(h.server.calls.indexOf('deleteMessages')).toBeLessThan(h.server.calls.indexOf('expunge'));
    expect(h.server.callCount('deleteMessages')).toBe(1);
    expect(h.server.callCount('expunge')).toBe(1);
    expect(h.server.uidsIn('INBOX')).toEqual([1, 3]);
  });

  it('bulkDelete expunges every UID with a single \\Deleted STORE', async () => {
    const h = await makeHarness();
    expect(await h.queue.bulkDelete('INBOX', [1, 2, 3])).toBe('success');
    expect(h.server.callCount('deleteMessages')).toBe(1);
    expect(h.server.messageCount('INBOX')).toBe(0);
  });
});

describe('OperationQueue — destination UID remap after a move', () => {
  it('falls back to a Message-ID SEARCH when the server returns no UIDPLUS map', async () => {
    const h = await makeHarness();
    h.storage.addFolder('Trash');
    h.storage.addEmail({ id: 'e1', folderId: 'f-Trash', uid: 1, messageId: '<a@x>' });
    const move = h.server.moveMessages.bind(h.server);
    (h.server as any).moveMessages = async (uids: number[], dest: string) => {
      await move(uids, dest);
      return new Map<number, number>(); // no UIDPLUS
    };
    (h.server as any).search = async () => [42];

    await h.queue.moveToTrash('INBOX', 1);

    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { uid: 42 });
  });

  it('does not rewrite the UID when the search already agrees with the local row', async () => {
    const h = await makeHarness();
    h.storage.addFolder('Trash');
    h.storage.addEmail({ id: 'e1', folderId: 'f-Trash', uid: 7, messageId: '<a@x>' });
    (h.server as any).moveMessages = async () => new Map<number, number>();
    (h.server as any).search = async () => [7];

    await h.queue.moveToTrash('INBOX', 1);
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('is idempotent: re-running the same move does not rewrite an already-remapped row', async () => {
    const h = await makeHarness();
    h.storage.addFolder('Archive');
    h.storage.addEmail({ id: 'e1', folderId: 'f-Archive', uid: 1, messageId: '<a@x>' });

    await h.queue.move('INBOX', 1, 'Archive');
    expect(h.storage.updateEmail).toHaveBeenCalledTimes(0); // dest UID 1 == source UID 1 → no write

    h.storage.emails[0].uid = 1;
    await h.queue.move('INBOX', 2, 'Archive'); // UID 2 → dest UID 2, no row carries source UID 2
    expect(h.storage.updateEmail).toHaveBeenCalledTimes(0);
  });

  it('leaves the UIDs stale (to self-heal on the next sync) if the link drops right after the move', async () => {
    const h = await makeHarness();
    h.storage.addFolder('Trash');
    h.storage.addEmail({ id: 'e1', folderId: 'f-Trash', uid: 1, messageId: '<a@x>' });
    const move = h.server.moveMessages.bind(h.server);
    (h.server as any).moveMessages = async (uids: number[], dest: string) => {
      await move(uids, dest);
      h.state.connected = false; // socket died between the MOVE and the writeback
      return new Map<number, number>();
    };

    expect(await h.queue.moveToTrash('INBOX', 1)).toBe('success'); // the move DID happen
    expect(h.server.callCount('search')).toBe(0);                  // no doomed SEARCH attempt
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('skips the SEARCH fallback for a row with no Message-ID to match on', async () => {
    const h = await makeHarness();
    h.storage.addFolder('Trash');
    h.storage.addEmail({ id: 'e1', folderId: 'f-Trash', uid: 1, messageId: null });
    (h.server as any).moveMessages = async () => new Map<number, number>();

    expect(await h.queue.moveToTrash('INBOX', 1)).toBe('success');
    expect(h.server.callCount('search')).toBe(0);
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('an unknown destination folder never fails the move that already succeeded', async () => {
    const h = await makeHarness(); // storage knows no folders at all
    expect(await h.queue.moveToTrash('INBOX', 1)).toBe('success');
    expect(h.server.uidsIn('INBOX')).toEqual([2, 3]);
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('a storage error during the UID writeback never rolls back the move', async () => {
    const h = await makeHarness();
    h.storage.addFolder('Trash');
    (h.storage as any).getFolderByPath = async () => { throw new Error('db locked'); };

    expect(await h.queue.moveToTrash('INBOX', 1)).toBe('success');
    expect(h.storage.rows()).toHaveLength(0);
  });
});

describe('OperationQueue — pending-UID guard for flag reconciliation', () => {
  it('unions the in-memory queue with the durable rows, scoped to the folder', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    await h.queue.star('Archive', 5);

    expect([...(await h.queue.getPendingUids('INBOX'))]).toEqual([1]);
    expect([...(await h.queue.getPendingUids('Archive'))]).toEqual([5]);
    expect([...(await h.queue.getPendingUids('Junk'))]).toEqual([]);
  });

  it('still guards mid-drain, when the in-memory queue has been emptied for the batch', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    h.state.connected = true;

    let midDrain: number[] = [];
    const original = h.server.addFlags.bind(h.server);
    (h.server as any).addFlags = async (...args: unknown[]) => {
      midDrain = [...(await h.queue.getPendingUids('INBOX'))]; // queue is empty here
      return (original as any)(...args);
    };
    await h.queue.processQueue();

    expect(midDrain).toEqual([1]); // the durable backstop covered the window
  });

  it('a dead-lettered op stops guarding (its optimistic value never reached the server)', async () => {
    const h = await makeHarness();
    failFirst(h.server, 'addFlags', permErr(), 1);
    await expect(h.queue.markAsRead('INBOX', 1)).rejects.toThrow();
    expect([...(await h.queue.getPendingUids('INBOX'))]).toEqual([]);
  });

  it('survives a failing backstop query by falling back to the in-memory set', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    h.storage.getPendingOperationUidsByFolder.mockRejectedValueOnce(new Error('db locked'));

    expect([...(await h.queue.getPendingUids('INBOX'))]).toEqual([1]);
  });
});

describe('OperationQueue — category / user labels', () => {
  it('mirrors ALL of an email\'s categories in a single queued op (Gmail: copy = add label)', async () => {
    const server = await makeServer({ gmailLabels: true });
    const h = await makeHarness({ server });

    expect(await h.queue.applyCategoryLabels('INBOX', 1, {
      categories: [{ slug: 'finance', name: 'Finance' }, { slug: 'travel', name: 'Travel' }],
      host: 'imap.gmail.com',
      mode: 'copy',
    })).toBe('success');

    expect(h.storage.rows()).toHaveLength(0);              // one op, cleanly retired
    expect(server.callCount('copyMessages')).toBe(2);      // one COPY per label
    expect(server.messageCount('Sarv Inbox/Finance')).toBe(1);
    expect(server.messageCount('Sarv Inbox/Travel')).toBe(1);
    expect(server.messageCount('INBOX')).toBe(3);          // Gmail: no duplicate, stays in INBOX
  });

  // Each queued op must apply ITS OWN payload. groupIntoBatches keyed on
  // `type|folderPath|destPath??label??''` — the category payload was NOT part of
  // the key — and the batch then executed with `batch.ops[0].data`. Two messages
  // tagged with DIFFERENT categories collapsed into one batch, both got the
  // first's category, the second was never applied (its mailbox never created),
  // and BOTH rows were deleted as "success": silent wrong label plus data loss.
  it('applies each op\'s own category when a drain carries several', async () => {
    const server = await makeServer({ gmailLabels: true });
    const h = await makeHarness({ server });
    h.state.connected = false;
    await h.queue.applyCategoryLabels('INBOX', 1, { categories: [{ slug: 'finance', name: 'Finance' }], host: 'imap.gmail.com', mode: 'copy' });
    await h.queue.applyCategoryLabels('INBOX', 2, { categories: [{ slug: 'travel', name: 'Travel' }], host: 'imap.gmail.com', mode: 'copy' });
    h.state.connected = true;

    expect(await h.queue.processQueue()).toEqual({ success: 2, failed: 0 });

    expect(server.messageCount('Sarv Inbox/Finance')).toBe(1);
    expect(server.messageCount('Sarv Inbox/Travel')).toBe(1);
  });

  // Ops that DO share a payload must still batch into one command — the fix must
  // not cost the batching it was built for.
  it('still batches ops that share the same category payload', async () => {
    const server = await makeServer({ gmailLabels: true });
    const h = await makeHarness({ server });
    const cats = { categories: [{ slug: 'finance', name: 'Finance' }], host: 'imap.gmail.com', mode: 'copy' as const };
    h.state.connected = false;
    await h.queue.applyCategoryLabels('INBOX', 1, cats);
    await h.queue.applyCategoryLabels('INBOX', 2, cats);
    h.state.connected = true;

    await h.queue.processQueue();

    expect(server.callCount('copyMessages')).toBe(1);   // one COPY for both UIDs
    expect(server.messageCount('Sarv Inbox/Finance')).toBe(2);
  });

  it('removeCategoryLabels strips the Gmail label in place (no delete)', async () => {
    const server = await makeServer({ gmailLabels: true });
    const h = await makeHarness({ server });
    const cats = { categories: [{ slug: 'finance', name: 'Finance' }], host: 'imap.gmail.com', mode: 'copy' as const };

    await h.queue.applyCategoryLabels('INBOX', 1, cats);
    expect(await h.queue.removeCategoryLabels('INBOX', 1, cats)).toBe('success');

    expect(server.callCount('removeGmailLabels')).toBe(1);
    expect(server.messageCount('INBOX')).toBe(3); // the message itself is untouched
  });

  it('applies the category as an in-place keyword on a keyword-capable server', async () => {
    const h = await makeHarness(); // FakeImapServer supports keywords by default
    expect(await h.queue.applyCategoryLabels('INBOX', 1, {
      categories: [{ slug: 'needs_response', name: 'Needs Response' }],
      host: 'imap.test.local',
      mode: 'copy',
    })).toBe('success');

    expect(h.server.flagsOf('INBOX', 1)).toEqual(['needs_response']);
    expect(h.server.callCount('copyMessages')).toBe(0); // in place: no copy, no move
    expect(h.server.callCount('moveMessages')).toBe(0);
  });

  it('removeGmailLabels sends ONE STORE -X-GM-LABELS, and no-ops for an empty label list', async () => {
    const server = await makeServer({ gmailLabels: true });
    server.addMessage('INBOX', { labels: ['Sarv Inbox/Stale'] });
    const h = await makeHarness({ server });

    expect(await h.queue.removeGmailLabels('INBOX', 4, ['Sarv Inbox/Stale'])).toBe('success');
    expect(server.callCount('removeGmailLabels')).toBe(1);

    expect(await h.queue.removeGmailLabels('INBOX', 4, [])).toBe('success');
    expect(server.callCount('removeGmailLabels')).toBe(1); // nothing sent for an empty list
  });

  it('removeGmailLabels is a no-op on a client without Gmail-label support', async () => {
    const h = await makeHarness();
    (h.server as any).removeGmailLabels = undefined;
    expect(await h.queue.removeGmailLabels('INBOX', 1, ['Sarv Inbox/Stale'])).toBe('success');
    expect(h.server.callCount('selectFolder')).toBe(0);
  });

  it('setLabel copies the message into the label mailbox', async () => {
    const h = await makeHarness();
    h.server.addFolder('Later');
    expect(await h.queue.setLabel('INBOX', 1, 'Later')).toBe('success');
    expect(h.server.messageCount('Later')).toBe(1);
  });

  it('createServerLabel: created, already-existing (still success), rejected, and blank', async () => {
    const h = await makeHarness();
    expect(await h.queue.createServerLabel('Receipts')).toBe(true);
    expect(await h.queue.createServerLabel('  ')).toBe(false);

    failFirst(h.server, 'createMailbox', new Error('ALREADYEXISTS Mailbox exists'), 1);
    expect(await h.queue.createServerLabel('Receipts')).toBe(true); // already there == success

    failFirst(h.server, 'createMailbox', new Error('NO permission denied'));
    expect(await h.queue.createServerLabel('Nope')).toBe(false);
  });

  it('ensureCategoryLabelsExist provisions each label and keeps going past a failure', async () => {
    const server = await makeServer({ gmailLabels: true });
    const h = await makeHarness({ server });
    const original = server.createMailbox.bind(server);
    (server as any).createMailbox = async (path: string) => {
      if (path === 'Sarv Inbox/Travel') throw new Error('NO permission denied');
      return original(path);
    };

    const n = await h.queue.ensureCategoryLabelsExist(
      [{ slug: 'finance', name: 'Finance' }, { slug: 'travel', name: 'Travel' }, { slug: 'bills', name: 'Bills' }],
      'copy',
    );

    expect(n).toBe(2); // the denied one is skipped, the rest still provisioned
    expect(server.messageCount('Sarv Inbox/Bills')).toBe(0);
  });

  // Breaks: provisioning manufactures a folder per category on a keyword server.
  // On Sarv the webmail already knows these labels — we only flag the mail — so
  // the pass must create nothing and must clear out the folders we used to make.
  it('ensureCategoryLabelsExist creates no folders on Sarv and prunes the ones we left', async () => {
    const server = await makeServer({ keywords: true });
    Object.defineProperty(server, 'host', { get: () => 'imap.sarv.com' });
    server.addFolder('Sarv Inbox');
    server.addFolder('Sarv Inbox/Finance');
    const h = await makeHarness({ server });

    const n = await h.queue.ensureCategoryLabelsExist(
      [{ slug: 'finance', name: 'Finance' }, { slug: 'needs_response', name: 'Needs Response' }],
      'copy',
    );

    expect(n).toBe(2);
    expect(server.callCount('createMailbox')).toBe(0);
    const paths = await server.listMailboxPaths();
    expect(paths.filter((p) => p.startsWith('Sarv Inbox'))).toEqual([]); // the tree is gone
    expect(paths).not.toContain('finance'); // and no flat folder took its place
  });

  // Breaks: a server that refuses the cleanup DELETE makes provisioning report a
  // failure, so the caller retries labels that are already there. The label is
  // what matters; tidying up an old scheme is never allowed to fail it.
  it('counts a label as provisioned even when its migration fails', async () => {
    const server = await makeServer({ keywords: true });
    Object.defineProperty(server, 'host', { get: () => 'sarv.com' });
    server.addFolder('Sarv Inbox/Finance');
    (server as any).getFolderStatus = async () => { throw new Error('NO [SERVERBUG] try later'); };
    const h = await makeHarness({ server });

    const n = await h.queue.ensureCategoryLabelsExist([{ slug: 'finance', name: 'Finance' }], 'copy');

    expect(n).toBe(1);
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance'); // untouched, not destroyed
  });

  it('renameCategoryLabel renames the label mailbox, and is a no-op on a keyword server', async () => {
    const gmail = await makeServer({ gmailLabels: true });
    const gmailHarness = await makeHarness({ server: gmail });
    await gmailHarness.queue.ensureCategoryLabelsExist([{ slug: 'finance', name: 'Finance' }], 'copy');

    expect(await gmailHarness.queue.renameCategoryLabel(
      { slug: 'finance', name: 'Finance' },
      { slug: 'finance', name: 'Money' },
      'copy',
    )).toBe(true);
    expect(await gmail.listMailboxPaths()).toContain('Sarv Inbox/Money');

    const keyword = await makeHarness(); // keywords supported → keyword strategy
    expect(await keyword.queue.renameCategoryLabel(
      { slug: 'finance', name: 'Finance' },
      { slug: 'finance', name: 'Money' },
      'copy',
    )).toBe(false);
  });

  it('removeSarvInboxLabels deletes the whole subtree, deepest first, leaving other folders alone', async () => {
    const server = await makeServer({ gmailLabels: true });
    server.addFolder('Sarv Inbox');
    server.addFolder('Sarv Inbox/Finance');
    server.addFolder('Sarv Inbox/Travel');
    const h = await makeHarness({ server });
    const deleted: string[] = [];
    const original = server.deleteMailbox.bind(server);
    (server as any).deleteMailbox = async (path: string) => { deleted.push(path); return original(path); };

    expect(await h.queue.removeSarvInboxLabels('copy')).toBe(3);

    expect(deleted[deleted.length - 1]).toBe('Sarv Inbox'); // children before the parent
    expect(await server.listMailboxPaths()).toEqual(expect.arrayContaining(['INBOX', 'Trash']));
    expect(await server.listMailboxPaths()).not.toContain('Sarv Inbox/Finance');
  });

  it('removeSarvInboxLabels is a no-op on a keyword server and tolerates a refused DELETE', async () => {
    const keyword = await makeHarness();
    keyword.server.addFolder('Sarv Inbox');
    expect(await keyword.queue.removeSarvInboxLabels('copy')).toBe(0);

    const server = await makeServer({ gmailLabels: true });
    server.addFolder('Sarv Inbox');
    const h = await makeHarness({ server });
    failFirst(server, 'deleteMailbox', new Error('NO mailbox has children'));
    expect(await h.queue.removeSarvInboxLabels('copy')).toBe(0); // counted only what really went
  });

  it('falls back to the op payload\'s host when the client reports none (offline replay)', async () => {
    // A queued label op can drain on a client whose `host` is null; the persisted
    // payload carries the provider so the strategy is still resolved correctly.
    const server = new FakeImapServer({ keywords: false }); // deliberately NOT connected → host === null
    server.addFolder('INBOX');
    server.addMessages('INBOX', 1);
    const h = await makeHarness({ server });

    // `mode` omitted too — the executor defaults it to 'copy'.
    expect(await h.queue.applyCategoryLabels('INBOX', 1, {
      categories: [{ slug: 'finance', name: 'Finance' }],
      host: 'imap.gmail.com',
    } as any)).toBe('success');

    expect(server.messageCount('Sarv Inbox/Finance')).toBe(1);
    expect(server.messageCount('INBOX')).toBe(1); // gmail path: label, not a move
  });

  it('renameCategoryLabel reports false when the server refuses the rename', async () => {
    const server = await makeServer({ gmailLabels: true });
    const h = await makeHarness({ server });
    failFirst(server, 'renameMailbox', new Error('NO cannot rename'));

    expect(await h.queue.renameCategoryLabel(
      { slug: 'finance', name: 'Finance' },
      { slug: 'finance', name: 'Money' },
      'copy',
    )).toBe(false);
  });

  it('removeSarvInboxLabels is a no-op on a client that cannot list or delete mailboxes', async () => {
    const server = await makeServer({ gmailLabels: true });
    server.addFolder('Sarv Inbox');
    const h = await makeHarness({ server });
    (server as any).listMailboxPaths = undefined;

    expect(await h.queue.removeSarvInboxLabels('copy')).toBe(0);
  });

  it('every label helper degrades safely (no throw) before there is a client', async () => {
    const bare = new OperationQueue();
    expect(bare.isGmailCapable()).toBe(false);
    expect(await bare.createServerLabel('Receipts')).toBe(false);
    expect(await bare.ensureCategoryLabelsExist([{ slug: 'finance', name: 'Finance' }], 'copy')).toBe(0);
    expect(await bare.removeSarvInboxLabels('copy')).toBe(0);
    expect(await bare.renameCategoryLabel(
      { slug: 'finance', name: 'Finance' },
      { slug: 'finance', name: 'Money' },
      'copy',
    )).toBe(false);
  });

  it('isGmailCapable reflects the live server capability, not the account name', async () => {
    expect((await makeHarness({ server: await makeServer({ gmailLabels: true }) })).queue.isGmailCapable()).toBe(true);
    expect((await makeHarness()).queue.isGmailCapable()).toBe(false);
  });
});

describe('OperationQueue — bookkeeping', () => {
  it('clear() empties the in-memory queue (the durable rows are the source of truth)', async () => {
    const h = await makeHarness();
    h.state.connected = false;
    await h.queue.markAsRead('INBOX', 1);
    expect(h.queue.isEmpty).toBe(false);

    h.queue.clear();

    expect(h.queue.isEmpty).toBe(true);
    expect(h.queue.length).toBe(0);
    expect(h.storage.rows()).toHaveLength(1); // still recoverable via loadFromStorage
  });
});
