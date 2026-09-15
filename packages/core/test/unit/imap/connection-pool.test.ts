import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { IMAPConnectionPool, PoolConnectionParkedError } from '../../../src/imap/connection-pool';
import { FakeImapServer } from '../../../src/test-support/fake-imap-server';
import type { IIMAPClient } from '../../../src/types/imap';
import { TimeoutError } from '../../../src/utils/timeout';

// The pool is what stands between us and Gmail's ~15-connections-per-account cap,
// so the rules it must never break are: never exceed maxConnections (including
// while connects are IN FLIGHT), never hand out a connection whose command
// pipeline is dirty, and never leak a slot on error/timeout. Every test below
// pins one of those, or the queue/reaper behaviour that keeps the pool usable.

// ImapFlowClient is constructed INSIDE createConnection(), so the pool can only
// be tested by substituting the class. Each `new ImapFlowClient()` produces a
// FakeImapServer built by `makeClient` and recorded in `clients`.
const clients: FakeImapServer[] = [];
let makeClient: () => FakeImapServer = () => new FakeImapServer();

vi.mock('../../../src/imap/imapflow-client', () => ({
  ImapFlowClient: class {
    constructor() {
      const client = makeClient();
      clients.push(client);
      return client as unknown as never;
    }
  },
}));

const CONFIG = { host: 'imap.test.local', port: 993, user: 'me@test.local', password: 'pw', tls: true } as any;

function poolWith(overrides: Partial<{ maxConnections: number; connectionTimeout: number; idleTimeout: number }> = {}) {
  return new IMAPConnectionPool({
    maxConnections: 2,
    connectionTimeout: 1000,
    idleTimeout: 60000,
    ...overrides,
  });
}

/** Drain microtasks + the pool's 100ms acquire-retry sleep a few times. */
async function tick(ms = 100, times = 1) {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  clients.length = 0;
  makeClient = () => new FakeImapServer();
  vi.useFakeTimers();
  for (const level of ['debug', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('IMAPConnectionPool — initialization', () => {
  it('creates exactly one verification connection and reports itself initialized', async () => {
    const pool = poolWith();

    await pool.initialize(CONFIG);

    expect(clients).toHaveLength(1);
    expect(clients[0].callCount('connect')).toBe(1);
    expect(pool.getStats()).toEqual({ total: 1, inUse: 0, available: 1 });
    expect(pool.isInitialized()).toBe(true);
  });

  it('refuses to acquire before initialize()', async () => {
    await expect(poolWith().acquire()).rejects.toThrow('Connection pool not initialized');
  });

  it('propagates a failed initial connect (bad credentials surface to the caller)', async () => {
    makeClient = () => {
      const client = new FakeImapServer();
      client.failNextConnect(new Error('Invalid credentials'));
      return client;
    };

    await expect(poolWith().initialize(CONFIG)).rejects.toThrow('Invalid credentials');
  });

  // Regression (the startup "IMAP connection budget for … exhausted (max 6)" ERROR):
  // the pool is a THROUGHPUT layer on top of the already-connected primary, so a
  // TRANSIENT warm-up failure — the per-account budget momentarily saturated during
  // the cold-start ramp, surfacing as a CONNECTION_ERROR whose message contains
  // "timed out" — must NOT fail the account connect. It used to throw, and the whole
  // imap:connect handler then logged a CONNECTION_ERROR and PARKED a healthy account.
  // The pool must come up EMPTY and open sockets on demand instead.
  it('starts empty (not failed) when the initial connect is a transient budget error', async () => {
    let firstConnect = true;
    makeClient = () => {
      const client = new FakeImapServer();
      if (firstConnect) {
        firstConnect = false;
        client.failNextConnect(
          new Error('IMAP connection budget for imap.gmail.com:me exhausted (max 6) — timed out after 20000ms waiting for a slot'),
        );
      }
      return client;
    };
    const pool = poolWith();

    await expect(pool.initialize(CONFIG)).resolves.toBeUndefined(); // does NOT throw
    expect(pool.isInitialized()).toBe(true);
    expect(pool.getStats()).toEqual({ total: 0, inUse: 0, available: 0 }); // empty — grows on demand

    // acquire() then opens a pooled connection on demand (the retried connect succeeds).
    const handle = await pool.acquire();
    expect(handle.client).toBeTruthy();
    expect(pool.getStats().total).toBe(1);
  });
});

describe('IMAPConnectionPool — capacity', () => {
  it('reuses the idle connection instead of opening a second one', async () => {
    const pool = poolWith();
    await pool.initialize(CONFIG);

    const first = await pool.acquire();
    first.release();
    const second = await pool.acquire();

    expect(second.client).toBe(first.client);
    expect(clients).toHaveLength(1);
  });

  // Regression: acquire() awaits the socket BEFORE pushing the connection, so
  // without reserving the slot up front every concurrent acquire saw the same
  // pre-push length and over-provisioned past the cap.
  it('never exceeds maxConnections even when many acquires race the same in-flight connect', async () => {
    const pool = poolWith({ maxConnections: 3 });
    await pool.initialize(CONFIG);

    const handles = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);

    expect(clients).toHaveLength(3);            // 1 initial + 2 created, never 4+
    expect(pool.getStats()).toEqual({ total: 3, inUse: 3, available: 0 });
    expect(new Set(handles.map((h) => h.client)).size).toBe(3); // no double hand-out
  });

  it('queues an acquire while saturated and hands over the first freed connection', async () => {
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);
    const held = await pool.acquire();

    let waiter: { client: IIMAPClient; release: () => void } | null = null;
    void pool.acquire().then((handle) => { waiter = handle; });

    await tick(100, 3);
    expect(waiter).toBeNull();                  // still waiting — cap respected

    held.release();
    await tick(100, 2);

    expect(waiter).not.toBeNull();
    expect(waiter!.client).toBe(held.client);   // the freed one, not a new socket
    expect(clients).toHaveLength(1);
  });

  it('times out (rather than waiting forever) when nothing is ever released', async () => {
    const pool = poolWith({ maxConnections: 1, connectionTimeout: 500 });
    await pool.initialize(CONFIG);
    await pool.acquire();

    const pending = pool.acquire();
    const assertion = expect(pending).rejects.toThrow('Timeout waiting for available connection');
    await tick(100, 8);
    await assertion;
  });

  // A reservation leaked on failure would permanently shrink the pool below its
  // configured size, which looks like a mysterious "acquire timeout" later on.
  it('releases the reserved slot when a connect fails, so the next acquire still works', async () => {
    const pool = poolWith({ maxConnections: 2 });
    await pool.initialize(CONFIG);
    const held = await pool.acquire();
    makeClient = () => {
      const client = new FakeImapServer();
      client.failNextConnect(new Error('connect ECONNREFUSED'));
      return client;
    };

    await expect(pool.acquire()).rejects.toThrow('connect ECONNREFUSED');

    makeClient = () => new FakeImapServer();
    const second = await pool.acquire();        // capacity was not lost
    expect(second.client).not.toBe(held.client);
    expect(pool.getStats().total).toBe(2);
  });
});

describe('IMAPConnectionPool — poisoning and health', () => {
  // Poisoned = the last op threw/timed out with a command possibly still in
  // flight. Reusing it overlapped commands and scrambled ImapFlow's pipeline
  // until the server dropped the socket, triggering a mass reconnect.
  it('discards a poisoned connection on release and never hands it out again', async () => {
    const pool = poolWith();
    await pool.initialize(CONFIG);

    const handle = await pool.acquire();
    handle.poison();
    handle.release();
    await vi.advanceTimersByTimeAsync(0); // removal completes after the socket closes

    expect(pool.getStats().total).toBe(0);
    expect((handle.client as unknown as FakeImapServer).callCount('disconnect')).toBe(1);

    const next = await pool.acquire();
    expect(next.client).not.toBe(handle.client); // a FRESH socket, not the poisoned one
    expect(clients).toHaveLength(2);
  });

  it('drops a connection that died while checked out', async () => {
    const pool = poolWith();
    await pool.initialize(CONFIG);
    const handle = await pool.acquire();

    await (handle.client as IIMAPClient).disconnect(); // server dropped it mid-op
    handle.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(pool.getStats().total).toBe(0);
  });

  it('withConnection releases the connection on success AND on throw', async () => {
    const pool = poolWith();
    await pool.initialize(CONFIG);

    const value = await pool.withConnection(async (client) => {
      expect(pool.getStats().inUse).toBe(1);
      return client.isConnected();
    });
    expect(value).toBe(true);
    expect(pool.getStats()).toEqual({ total: 1, inUse: 0, available: 1 });

    await expect(pool.withConnection(async () => { throw new Error("NO Mailbox doesn't exist"); }))
      .rejects.toThrow("NO Mailbox doesn't exist");
    expect(pool.getStats()).toEqual({ total: 1, inUse: 0, available: 1 });
  });

  // A server NO/BAD leaves the socket healthy; poisoning there would churn
  // sockets in a tight retry loop. A TIMEOUT is the opposite — the abandoned
  // command is still in flight, so that connection MUST be discarded.
  it('keeps the connection after a command-level rejection but poisons it after a timeout', async () => {
    const pool = poolWith();
    await pool.initialize(CONFIG);
    const original = clients[0];

    await expect(pool.withConnection(async () => { throw new Error('NO [TRYCREATE] nope'); })).rejects.toThrow();
    expect(pool.getStats().total).toBe(1); // reused, not churned

    await expect(pool.withConnection(async () => { throw new TimeoutError('IMAP FETCH timed out after 60000ms'); }))
      .rejects.toThrow('timed out');
    expect(pool.getStats().total).toBe(0);
    expect(original.callCount('disconnect')).toBe(1);
  });

  it('poisons a connection whose socket is already gone when the op fails', async () => {
    const pool = poolWith();
    await pool.initialize(CONFIG);

    await expect(pool.withConnection(async (client) => {
      await client.disconnect();
      throw new Error('Connection not available');
    })).rejects.toThrow('Connection not available');

    expect(pool.getStats().total).toBe(0);
  });

  it('evicts a dead idle connection on acquire and replaces it', async () => {
    const pool = poolWith();
    await pool.initialize(CONFIG);
    await clients[0].disconnect(); // died while sitting in the pool

    const handle = await pool.acquire();

    expect(handle.client).not.toBe(clients[0]);
    expect(pool.getStats()).toEqual({ total: 1, inUse: 1, available: 0 });
  });

  // A leaked/hung checkout must not permanently consume a slot.
  it('evicts a connection stuck in-use past the stuck timeout so the slot frees', async () => {
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);
    const leaked = await pool.acquire();

    vi.setSystemTime(Date.now() + 121_000); // held for > 2 minutes
    const handle = await pool.acquire();

    expect(handle.client).not.toBe(leaked.client);
    expect(pool.getStats()).toEqual({ total: 1, inUse: 1, available: 0 });
  });
});

describe('IMAPConnectionPool — idle reaper', () => {
  it('closes idle connections but never the one still checked out', async () => {
    const pool = poolWith({ maxConnections: 3, idleTimeout: 10_000 });
    await pool.initialize(CONFIG);
    const [a, b, c] = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    a.release();
    b.release();

    await vi.advanceTimersByTimeAsync(40_000); // idleTimeout passed + one 30s sweep

    // Both idle sockets are reaped; the in-use one is the "keep at least one".
    expect(pool.getStats()).toEqual({ total: 1, inUse: 1, available: 0 });
    expect((c.client as unknown as FakeImapServer).callCount('disconnect')).toBe(0);
    expect((a.client as unknown as FakeImapServer).callCount('disconnect')).toBe(1);
  });

  it('leaves connections that have not been idle long enough alone', async () => {
    const pool = poolWith({ maxConnections: 2, idleTimeout: 60_000 });
    await pool.initialize(CONFIG);
    const [first, second] = await Promise.all([pool.acquire(), pool.acquire()]);
    first.release();
    second.release();

    await vi.advanceTimersByTimeAsync(31_000); // a sweep ran, but nothing is idle enough

    expect(pool.getStats()).toEqual({ total: 2, inUse: 0, available: 2 });
    expect((first.client as unknown as FakeImapServer).callCount('disconnect')).toBe(0);
  });
});

describe('IMAPConnectionPool — close', () => {
  it('disconnects everything, rejects further acquires and stops the reaper', async () => {
    const pool = poolWith({ maxConnections: 2 });
    await pool.initialize(CONFIG);
    const handle = await pool.acquire();
    handle.release();

    await pool.close();

    expect(clients[0].callCount('disconnect')).toBe(1);
    expect(pool.getStats()).toEqual({ total: 0, inUse: 0, available: 0 });
    expect(pool.isInitialized()).toBe(false);
    await expect(pool.acquire()).rejects.toThrow('Connection pool is closed');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients[0].callCount('disconnect')).toBe(1); // reaper really stopped
  });

  it('swallows disconnect errors during close (a dead socket must not block shutdown)', async () => {
    makeClient = () => {
      const client = new FakeImapServer();
      client.setDisconnectBehavior('throw');
      return client;
    };
    const pool = poolWith();
    await pool.initialize(CONFIG);

    await expect(pool.close()).resolves.toBeUndefined();
    expect(pool.getStats().total).toBe(0);
  });
});

describe('IMAPConnectionPool — shared connect back-off gate', () => {
  // The regression this guards: the pool was the ONE connect path with no
  // back-off awareness, so during backfill/drain it kept opening sockets against
  // a saturated per-account cap — every new socket re-saturated it and prolonged
  // the "Failed to establish connection in required time" lockout. The gate must
  // make the pool refuse to open a NEW connection while the account is parked.
  it('refuses to open a new connection while the shared gate reports a park', async () => {
    let parkedMs = 0;
    const onConnectError = vi.fn();
    const pool = new IMAPConnectionPool({
      maxConnections: 2,
      connectionTimeout: 1000,
      idleTimeout: 60000,
      connectGate: () => parkedMs,
      onConnectError,
    });
    await pool.initialize(CONFIG);       // gate open at init — pool comes up (1 client)
    const held = await pool.acquire();   // reuses the idle initial connection

    parkedMs = 90_000;                   // account just got parked
    // No idle connection is free and we're under max, so acquire MUST create one —
    // and the gate must stop it cold rather than opening a socket.
    await expect(pool.acquire()).rejects.toBeInstanceOf(PoolConnectionParkedError);

    expect(clients).toHaveLength(1);     // no new socket was opened
    expect(onConnectError).not.toHaveBeenCalled(); // a park is not a connect failure
    held.release();
  });

  it('opens connections normally once the gate reports the park has elapsed', async () => {
    let parkedMs = 0;                    // gate open so the pool can initialize
    const pool = new IMAPConnectionPool({
      maxConnections: 2,
      connectionTimeout: 1000,
      idleTimeout: 60000,
      connectGate: () => parkedMs,
    });
    await pool.initialize(CONFIG);
    const held = await pool.acquire();   // reuse initial idle

    parkedMs = 60_000;                   // account parked
    // While parked, a second (new) connection is refused...
    await expect(pool.acquire()).rejects.toBeInstanceOf(PoolConnectionParkedError);
    expect(clients).toHaveLength(1);

    parkedMs = 0;                        // window elapsed
    const second = await pool.acquire(); // now a fresh socket is allowed
    expect(second.client).not.toBe(held.client);
    expect(clients).toHaveLength(2);
    held.release();
    second.release();
  });

  // The other half of the contract: a real connect FAILURE must be reported so
  // the owner can park the account, which then closes the gate for every path.
  it('reports a failed connect through onConnectError so the account gets parked', async () => {
    const onConnectError = vi.fn();
    const pool = new IMAPConnectionPool({
      maxConnections: 2,
      connectionTimeout: 1000,
      idleTimeout: 60000,
      connectGate: () => 0,
      onConnectError,
    });
    await pool.initialize(CONFIG);
    const held = await pool.acquire();   // hold the initial so the next acquire creates

    const boom = new TimeoutError('Failed to establish connection in required time');
    makeClient = () => {
      const client = new FakeImapServer();
      client.failNextConnect(boom);
      return client;
    };

    await expect(pool.acquire()).rejects.toThrow('Failed to establish connection');
    expect(onConnectError).toHaveBeenCalledTimes(1);
    expect(onConnectError).toHaveBeenCalledWith(boom); // owner classifies + parks
    held.release();
  });

  // remainingParkMs exposes the live gate so a drain loop can pause the WHOLE
  // queue for the window instead of pulling every item and having each refused at
  // acquire() — the parked-drain log flood + wasted retry budget.
  it('remainingParkMs reflects the live gate (clamped at 0)', async () => {
    let parkedMs = 0;
    const pool = new IMAPConnectionPool({
      maxConnections: 2,
      connectionTimeout: 1000,
      idleTimeout: 60000,
      connectGate: () => parkedMs,
    });
    await pool.initialize(CONFIG);
    expect(pool.remainingParkMs()).toBe(0);
    parkedMs = 45_000;
    expect(pool.remainingParkMs()).toBe(45_000);
    parkedMs = -5;                       // a stale/negative gate never reads as parked
    expect(pool.remainingParkMs()).toBe(0);
  });

  it('remainingParkMs is 0 when no gate is configured', async () => {
    const pool = poolWith({ maxConnections: 2 });
    await pool.initialize(CONFIG);
    expect(pool.remainingParkMs()).toBe(0);
  });

  // Back-compat: with no gate wired (standalone pool / other callers) the pool
  // behaves exactly as before — nothing is ever parked.
  it('never parks when no gate is configured', async () => {
    const pool = poolWith({ maxConnections: 2 });
    await pool.initialize(CONFIG);
    const held = await pool.acquire();
    const second = await pool.acquire(); // freely creates a new one
    expect(clients).toHaveLength(2);
    held.release();
    second.release();
  });
});

describe('IMAPConnectionPool — parallel', () => {
  it('respects the concurrency cap across a queue much larger than the pool', async () => {
    const pool = poolWith({ maxConnections: 2 });
    await pool.initialize(CONFIG);
    let live = 0;
    let peak = 0;

    const tasks = Array.from({ length: 8 }, (_, index) => async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 10));
      live--;
      return index;
    });

    const run = pool.parallel(tasks);
    await vi.advanceTimersByTimeAsync(500);
    const results = await run;

    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // order preserved by index
    expect(clients).toHaveLength(2);                   // never over-provisioned
  });

  it('honors an explicit concurrency lower than the pool size', async () => {
    const pool = poolWith({ maxConnections: 4 });
    await pool.initialize(CONFIG);
    let live = 0;
    let peak = 0;

    const tasks = Array.from({ length: 6 }, () => async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 10));
      live--;
      return 1;
    });

    const run = pool.parallel(tasks, 1);
    await vi.advanceTimersByTimeAsync(500);
    await run;

    expect(peak).toBe(1);
  });

  // The result is index-aligned with the tasks: a failed task leaves a hole
  // where it was, rather than compacting the array (which used to make the
  // failure invisible AND shift every later result onto the wrong task).
  it('keeps going after a failing task, leaving a hole at its index', async () => {
    const pool = poolWith({ maxConnections: 2 });
    await pool.initialize(CONFIG);

    const run = pool.parallel([
      async () => 'a',
      async () => { throw new Error('NO bad command'); },
      async () => 'c',
    ]);
    await vi.advanceTimersByTimeAsync(200);

    expect(await run).toEqual(['a', undefined, 'c']);
    expect(pool.isInitialized()).toBe(true);
  });

  // A task that legitimately resolves to `undefined` is not a failure. The old
  // `.filter(r => r !== undefined)` erased it, so "ran and returned nothing" and
  // "never ran" were indistinguishable to the caller.
  it('keeps a task that legitimately returns undefined', async () => {
    const pool = poolWith({ maxConnections: 2 });
    await pool.initialize(CONFIG);

    const run = pool.parallel([async () => undefined, async () => 'b']);
    await vi.advanceTimersByTimeAsync(200);

    expect(await run).toEqual([undefined, 'b']);
  });

  // `tasks.indexOf(task)` mapped every copy of the same function reference onto
  // index 0, so N duplicate tasks all wrote to slot 0 and left N-1 holes.
  it('gives each DUPLICATE task reference its own result slot', async () => {
    const pool = poolWith({ maxConnections: 2 });
    await pool.initialize(CONFIG);
    let calls = 0;
    const sameTask = async () => ++calls;

    const run = pool.parallel([sameTask, sameTask, sameTask]);
    await vi.advanceTimersByTimeAsync(200);
    const results = await run;

    expect(calls).toBe(3);
    expect(results).toHaveLength(3);
    expect([...results].sort()).toEqual([1, 2, 3]);
  });

  it('is a no-op on a closed pool instead of throwing into the caller', async () => {
    const pool = poolWith();
    await pool.initialize(CONFIG);
    await pool.close();

    const task = vi.fn(async () => 'x');
    expect(await pool.parallel([task])).toEqual([]);
    expect(task).not.toHaveBeenCalled();
  });

  // Shutdown races: tasks in flight when close() lands must be treated as
  // cancelled, not logged as failures (and must never reject the batch).
  it('cancels queued tasks when the pool closes mid-run', async () => {
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);
    const started: number[] = [];

    const tasks = Array.from({ length: 4 }, (_, index) => async () => {
      started.push(index);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return index;
    });

    const run = pool.parallel(tasks);
    await vi.advanceTimersByTimeAsync(60);
    await pool.close();
    await vi.advanceTimersByTimeAsync(500);

    await expect(run).resolves.toBeInstanceOf(Array);
    expect(started.length).toBeLessThan(4); // the rest were dropped, not run
  });

  // A task that fails BECAUSE we are shutting down is expected, not a failure to
  // report — the "Failed actions"/error-log noise on every quit came from this.
  it('treats a task that fails after close() as cancelled, not as an error', async () => {
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);

    const run = pool.parallel([async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error('Connection not available');
    }]);
    await pool.close();
    await vi.advanceTimersByTimeAsync(100);

    // Cancelled, so its slot stays empty — but the slot still exists.
    await expect(run).resolves.toEqual([undefined]);
  });
});

describe('IMAPConnectionPool — NOOP-validate idle connections before reuse', () => {
  // Gmail silently drops an idle socket while isConnected() still reads true, so
  // handing a stale one back fails the caller's op — which the app then retries as
  // a NEW connect, i.e. exactly the churn that trips the connect-rate throttle. A
  // connection idle past the staleness window is proven live with a NOOP first; a
  // dead one is dropped and a fresh one opened, so the caller never sees the drop.

  it('does NOT probe a freshly-released connection (hot path stays one round-trip)', async () => {
    // Regression: if we probed on every checkout, the body-prefetch/backfill hot
    // path would double its command count for no gain — a real perf bug.
    makeClient = () => new FakeImapServer({ noop: 'alive' });
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);

    const first = await pool.acquire();
    first.release();
    const second = await pool.acquire(); // idle << 30s

    expect(clients[0].callCount('noop')).toBe(0);
    expect(second.client).toBe(clients[0]); // same socket, no reconnect
    second.release();
    await pool.close();
  });

  it('probes an idle connection past the staleness window and REUSES it when alive', async () => {
    // The whole point: a still-good idle socket is kept, not churned — one NOOP,
    // no new connect.
    makeClient = () => new FakeImapServer({ noop: 'alive' });
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);

    const first = await pool.acquire();
    first.release();
    await tick(30_001); // idle past STALE_REVALIDATE_MS

    const second = await pool.acquire();
    expect(clients[0].callCount('noop')).toBe(1); // probed once
    expect(second.client).toBe(clients[0]); // same socket reused
    expect(clients).toHaveLength(1); // no fresh connection opened
    second.release();
    await pool.close();
  });

  it('drops an idle connection whose NOOP returns dead and opens a fresh one', async () => {
    // The failure this fixes: a stale-dead socket handed back would fail the op and
    // read as churn. It must be dropped BEFORE reuse, transparently to the caller.
    makeClient = () => new FakeImapServer({ noop: 'alive' });
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);

    const first = await pool.acquire();
    first.release();
    clients[0].setNoop('dead'); // socket died while idle
    await tick(30_001);

    const second = await pool.acquire();
    expect(clients[0].callCount('noop')).toBe(1); // probed, found dead
    expect(clients[0].callCount('disconnect')).toBe(1); // dropped
    expect(clients).toHaveLength(2); // fresh one opened
    expect(second.client).toBe(clients[1]); // caller got the fresh socket
    second.release();
    await pool.close();
  });

  it('treats a THROWING NOOP as dead (any error → drop, reacquire)', async () => {
    // A probe that throws (e.g. "connection ended") is as good as dead — validate
    // must swallow it and drop, never propagate it to the caller's acquire().
    makeClient = () => new FakeImapServer({ noop: 'alive' });
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);

    const first = await pool.acquire();
    first.release();
    clients[0].setNoop('throw');
    await tick(30_001);

    const second = await pool.acquire();
    expect(clients[0].callCount('disconnect')).toBe(1);
    expect(second.client).toBe(clients[1]);
    second.release();
    await pool.close();
  });

  it('treats a HUNG NOOP (half-open zombie) as dead via the validation timeout', async () => {
    // The nastiest case: a half-open socket that answers neither data nor FIN. The
    // probe must not wedge acquire() forever — the 10s validation timeout fires and
    // the connection is dropped like any other dead one.
    makeClient = () => new FakeImapServer({ noop: 'alive' });
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);

    const first = await pool.acquire();
    first.release();
    clients[0].setNoop('hang');
    await tick(30_001);

    const acquiring = pool.acquire();
    await tick(10_001); // NOOP validation timeout fires → dropped
    const second = await acquiring;

    expect(clients[0].callCount('disconnect')).toBe(1);
    expect(second.client).toBe(clients[1]);
    second.release();
    await pool.close();
  });

  it('does not probe at all when the client exposes no noop() (older client shape)', async () => {
    // noop() is optional on IIMAPClient; a client without it must be reused as-is
    // (validateConnection returns true), never crash the staleness branch.
    makeClient = () => new FakeImapServer(); // no noop enabled
    const pool = poolWith({ maxConnections: 1 });
    await pool.initialize(CONFIG);

    const first = await pool.acquire();
    first.release();
    await tick(30_001);

    const second = await pool.acquire();
    expect(second.client).toBe(clients[0]); // reused without a probe
    expect(clients).toHaveLength(1);
    second.release();
    await pool.close();
  });
});
