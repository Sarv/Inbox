import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  FakeImapServer,
  type FakeConnectOutcome,
  type FakeImapServerOptions,
} from '../../../src/test-support/fake-imap-server';

import { ConnectionManager, type ConnectionManagerConfig } from '../../../src/imap/connection-manager';

// The ConnectionManager owns the reconnect ladder, so its bugs are always the
// same shape: MORE connections than intended (parallel ladders, stacked
// listeners, zombie sockets reused) or a ladder that never stops (auth/quota
// retried forever). Every test below pins one of those rules, the state machine,
// or one of the wake-from-sleep races where _imapConfig is momentarily null.

// ImapFlowClient is constructed INSIDE the manager (constructor, reconnect
// ladder and forceReconnect each build one), so tests substitute the class:
// every `new ImapFlowClient()` yields a FakeImapServer, recorded in `clients`,
// consuming the next entry of `connectScript` for its connect() outcome.
const clients: FakeImapServer[] = [];
const connectScript: FakeConnectOutcome[] = [];
let clientOptions: FakeImapServerOptions = {};

vi.mock('../../../src/imap/imapflow-client', () => ({
  ImapFlowClient: class {
    constructor() {
      const client = new FakeImapServer({ events: true, ...clientOptions });
      // Outcomes are consumed per CONNECT ATTEMPT, not per client — the manager
      // reuses its constructor-built client for the very first connect.
      const connect = client.connect.bind(client);
      client.connect = async (config?: any) => {
        const outcome = connectScript.shift();
        if (outcome) client.scriptConnect(outcome);
        return connect(config);
      };
      clients.push(client);
      return client as unknown as never;
    }
  },
}));

const CONFIG = { host: 'imap.test.local', port: 993, user: 'me@test.local', password: 'pw', tls: true } as any;
const GMAIL_CONFIG = { ...CONFIG, host: 'imap.gmail.com' };

const EVENT_NAMES = [
  'state-change', 'connected', 'disconnected', 'reconnecting', 'reconnected',
  'error', 'max-attempts-reached', 'quota-exceeded', 'auth-error',
] as const;

type Recorded = Array<[string, ...unknown[]]>;

function makeManager(config: Partial<ConnectionManagerConfig> = {}, opts: { withErrorListener?: boolean } = {}) {
  const manager = new ConnectionManager({
    maxReconnectAttempts: 3,
    reconnectDelay: 1000,
    reconnectBackoffMultiplier: 2,
    maxReconnectDelay: 3000,
    healthCheckInterval: 10_000_000, // effectively off unless a test overrides it
    connectionTimeout: 30_000,
    ...config,
  });
  const events: Recorded = [];
  for (const name of EVENT_NAMES) {
    if (name === 'error' && opts.withErrorListener === false) continue;
    manager.on(name as any, (...args: unknown[]) => events.push([name, ...args]));
  }
  return { manager, events };
}

const countOf = (events: Recorded, name: string) => events.filter(([e]) => e === name).length;
const namesOf = (events: Recorded) => events.filter(([e]) => e !== 'state-change').map(([e]) => e);
const argsOf = (events: Recorded, name: string) => events.filter(([e]) => e === name).map(([, ...rest]) => rest);
const lastClient = () => clients[clients.length - 1];

/** Auth / quota / socket errors in the exact shapes the classifiers key off. */
const authError = () => Object.assign(new Error('Invalid credentials (Failure)'), { textCode: 'AUTHENTICATIONFAILED' });
const quotaError = () => new Error('Too many simultaneous connections');
const socketError = () => new Error('connect ECONNREFUSED 1.2.3.4:993');

beforeEach(() => {
  clients.length = 0;
  connectScript.length = 0;
  clientOptions = {};
  vi.useFakeTimers();
  // Jitter is ±25% of the backoff; pin it to exactly 1.0 so delays are assertable.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  for (const level of ['debug', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ConnectionManager — connect / disconnect', () => {
  it('walks disconnected -> connecting -> connected, emitting each transition once', async () => {
    const { manager, events } = makeManager();

    await manager.connect(CONFIG);

    expect(events.filter(([e]) => e === 'state-change').map(([, state, prev]) => [prev, state])).toEqual([
      ['disconnected', 'connecting'],
      ['connecting', 'connected'],
    ]);
    expect(countOf(events, 'connected')).toBe(1);
    expect(manager.state).toBe('connected');
    expect(manager.isConnected()).toBe(true);
    expect(manager.isReconnecting()).toBe(false);
    expect(manager.provider).toBe('generic');
    expect(manager.imapConfig).toBe(CONFIG);
    expect(clients).toHaveLength(1);
  });

  it('detects the provider from the host', async () => {
    const { manager } = makeManager();
    await manager.connect(GMAIL_CONFIG);
    expect(manager.provider).toBe('gmail');
  });

  it('is a no-op when already connected (no second socket)', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);

    await manager.connect(CONFIG);

    expect(clients).toHaveLength(1);
    expect(countOf(events, 'connected')).toBe(1);
  });

  it('surfaces a failed connect: error state, error event, and it throws', async () => {
    const { manager, events } = makeManager();
    connectScript.push(socketError());

    await expect(manager.connect(CONFIG)).rejects.toThrow('ECONNREFUSED');

    expect(manager.state).toBe('error');
    expect(namesOf(events)).toEqual(['error']);
    expect(manager.authFailed).toBe(false);
  });

  it('latches authFailed (and its cooldown) when the server rejects the credentials', async () => {
    const { manager, events } = makeManager();
    connectScript.push(authError());

    await expect(manager.connect(CONFIG)).rejects.toThrow('Invalid credentials');

    expect(namesOf(events)).toEqual(['auth-error', 'error']);
    expect(manager.authFailed).toBe(true);
    expect(manager.isInAuthCooldown()).toBe(true);
    expect(await manager.ensureConnection()).toBe(false); // must not retry a bad password
  });

  it('disconnect() tears down once and is idempotent', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    const client = clients[0];

    await manager.disconnect();
    await manager.disconnect();

    expect(client.callCount('disconnect')).toBe(1);
    expect(countOf(events, 'disconnected')).toBe(1);
    expect(manager.state).toBe('disconnected');
    expect(manager.imapConfig).toBeNull();
  });

  it('swallows a failing disconnect during shutdown', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    clients[0].setDisconnectBehavior('throw');

    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(manager.state).toBe('disconnected');
  });

  it('reset() disconnects and clears provider + attempt bookkeeping', async () => {
    const { manager } = makeManager();
    await manager.connect(GMAIL_CONFIG);

    await manager.reset();

    expect(manager.state).toBe('disconnected');
    expect(manager.provider).toBe('generic');
    expect(manager.isInQuotaCooldown()).toBe(false);
  });

  // ImapFlow clients are single-use: reconnecting the same instance throws
  // "Unexpected close". A stale client must also be CLOSED (an abandoned socket
  // counts against Gmail's 15-per-account cap) and stripped of listeners.
  it('rebuilds a fresh client on re-connect and detaches the stale one completely', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    const stale = clients[0];
    await manager.disconnect();

    await manager.connect(CONFIG);

    expect(clients).toHaveLength(2);
    expect(manager.client).toBe(clients[1]);
    expect(stale.socketListenerCount('end')).toBe(0);
    expect(stale.callCount('disconnect')).toBeGreaterThanOrEqual(1);

    // The zombie's socket events must not reach the manager any more.
    const before = events.length;
    stale.emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.length).toBe(before);
    expect(manager.state).toBe('connected');
  });
});

describe('ConnectionManager — exactly one reconnect ladder', () => {
  // A single socket drop makes ImapFlow fire BOTH 'error' and 'end'. Each was
  // routed to handleDisconnect, and the second one reset the state so the
  // re-entry guard missed — producing "attempt 1/10" immediately followed by
  // "attempt 2/10" and two racing connects.
  it('collapses a socket drop that fires error AND end into ONE ladder', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    const dropped = clients[0];

    dropped.emitSocketEvent('error', new Error('Connection ended unexpectedly'));
    dropped.emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0);

    expect(countOf(events, 'reconnecting')).toBe(1);
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 3]]);
    expect(countOf(events, 'disconnected')).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(2); // exactly one replacement socket
    expect(countOf(events, 'reconnected')).toBe(1);
    expect(manager.state).toBe('connected');
  });

  it('ignores further drop events while a ladder is already in flight', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    connectScript.push(socketError());
    const dropped = clients[0];

    dropped.emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) dropped.emitSocketEvent('end'); // duplicate/flapping events
    await vi.advanceTimersByTimeAsync(1000);

    // Attempt numbering is driven by the ladder alone — not inflated by events.
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 3], [2, 3]]);
  });

  // Stacked listeners are the other amplifier: N stale clients each translating
  // one drop into a handleDisconnect call.
  it('never stacks socket listeners — the live client holds exactly one set', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(1000); // ladder swapped in a new client

    expect(clients).toHaveLength(2);
    expect(clients[0].socketListenerCount('end')).toBe(0);
    expect(clients[0].socketListenerCount('error')).toBe(0);
    expect(lastClient().socketListenerCount('end')).toBe(1);
    expect(lastClient().socketListenerCount('error')).toBe(1);
  });

  // The pending connect() is authoritative (it has its own timeout); a ladder
  // started here would race a second client against it on the same manager.
  it('defers to an in-flight connect() instead of starting a ladder', async () => {
    const { manager, events } = makeManager();
    connectScript.push('hang');
    void manager.connect(CONFIG).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.state).toBe('connecting');

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(5000);

    expect(countOf(events, 'reconnecting')).toBe(0);
    expect(clients).toHaveLength(1);
    expect(manager.state).toBe('connecting');
  });
});

describe('ConnectionManager — backoff ladder', () => {
  it('grows the delay exponentially, caps it, and stops at maxReconnectAttempts', async () => {
    const { manager, events } = makeManager({ maxReconnectAttempts: 3, reconnectDelay: 1000, reconnectBackoffMultiplier: 2, maxReconnectDelay: 3000 });
    await manager.connect(CONFIG);
    connectScript.push(socketError(), socketError(), socketError());

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 1 waits 1000ms…
    await vi.advanceTimersByTimeAsync(999);
    expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(2);

    // …attempt 2 waits 2000ms…
    await vi.advanceTimersByTimeAsync(1999);
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(3);

    // …attempt 3 would be 4000ms but is capped at maxReconnectDelay (3000).
    await vi.advanceTimersByTimeAsync(2999);
    expect(clients).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(10);
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(countOf(events, 'max-attempts-reached')).toBe(1);
    expect(manager.state).toBe('error');

    // The ladder must not resume on its own.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients).toHaveLength(4);
  });

  // Gmail counts connections PER ACCOUNT and releases dropped sockets slowly;
  // reconnecting ~2s after a drop races its reaper into "Too many simultaneous
  // connections". The floor intentionally overrides the normal (smaller) backoff.
  it('applies the ~25s Gmail floor instead of the configured 1s backoff', async () => {
    const { manager } = makeManager({ reconnectDelay: 1000 });
    await manager.connect(GMAIL_CONFIG);

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(24_999);
    expect(clients).toHaveLength(1); // NOT reconnected after 1s

    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(2);
  });

  it('reaching max attempts with NO error listener neither throws nor rejects', async () => {
    const { manager, events } = makeManager({ maxReconnectAttempts: 1 }, { withErrorListener: false });
    await manager.connect(CONFIG);
    connectScript.push(socketError());

    // Neither the synchronous emit nor the ladder may produce an unhandled
    // 'error' (Node's EventEmitter throws when nothing is listening).
    expect(() => clients[0].emitSocketEvent('end')).not.toThrow();
    await vi.advanceTimersByTimeAsync(5000);

    expect(countOf(events, 'max-attempts-reached')).toBe(1);
    expect(manager.state).toBe('error');
  });

  it('honors the cooldown after max attempts, then restarts from attempt 1', async () => {
    const { manager, events } = makeManager({ maxReconnectAttempts: 1 });
    await manager.connect(CONFIG);
    connectScript.push(socketError());
    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(2000);
    expect(countOf(events, 'max-attempts-reached')).toBe(1);

    // Still inside the 60s cooldown: a new drop must NOT open a new ladder.
    lastClient().emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(5000);
    expect(countOf(events, 'reconnecting')).toBe(1);
    expect(countOf(events, 'max-attempts-reached')).toBe(2);

    // After the cooldown the attempt counter resets and mail can flow again.
    await vi.advanceTimersByTimeAsync(60_000);
    lastClient().emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(2000);
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 1], [1, 1]]);
    expect(countOf(events, 'reconnected')).toBe(1);
  });

  it('resetReconnectAttempts() clears a plain network cooldown immediately', async () => {
    const { manager, events } = makeManager({ maxReconnectAttempts: 1 });
    await manager.connect(CONFIG);
    connectScript.push(socketError());
    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(2000);

    manager.resetReconnectAttempts(); // renderer does this on online/resume/unlock
    lastClient().emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(2000);

    expect(countOf(events, 'reconnected')).toBe(1);
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 1], [1, 1]]);
  });
});

describe('ConnectionManager — shared connection-cap back-off (reconnect deadlock guard)', () => {
  // Regression: the reconnect ladder was the LAST connect path that ignored the
  // shared per-account cap back-off the pool honours. So while the pool waited out
  // a 120s park, the primary kept reconnecting every ~30s — each attempt opening a
  // socket against a saturated Gmail cap, timing out, and re-saturating it. The
  // primary prevented its own recovery ("Failed to establish connection in
  // required time", attempt N/10 forever). These pin the fix: honour the gate
  // (wait WITHOUT burning an attempt) and feed failures back into the shared park.

  it('waits out an active park BEFORE attempting, and does not consume an attempt', async () => {
    // Breaks if the gate is ignored: the ladder would emit 'reconnecting' on the
    // first tick (as the un-gated ladder does) instead of holding for the window.
    const gate = vi.fn<[], number>();
    gate.mockReturnValueOnce(5000).mockReturnValue(0); // parked once, then clear
    const { manager, events } = makeManager();
    manager.setConnectBackoffHooks(gate, () => {});
    await manager.connect(CONFIG);

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0);
    // Still parked: no attempt scheduled, no replacement socket.
    expect(countOf(events, 'reconnecting')).toBe(0);
    expect(clients).toHaveLength(1);

    // Park window (5000 + 500 guard) elapses → the ladder proceeds to attempt 1.
    await vi.advanceTimersByTimeAsync(5500);
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 3]]); // attempt 1, not inflated

    await vi.advanceTimersByTimeAsync(1000); // attempt-1 backoff → connect succeeds
    expect(countOf(events, 'reconnected')).toBe(1);
    expect(clients).toHaveLength(2);
  });

  it('feeds a failed reconnect into the shared back-off, which the next iteration waits out', async () => {
    // Breaks if onConnectError is not called (the pool + primary drift out of
    // lockstep) or if the ladder ignores the park it just set (the hammering
    // returns): attempt 2 would fire on the ~2s backoff instead of after the park.
    let parkMs = 0;
    const gate = () => parkMs;
    const onConnectError = vi.fn(() => { parkMs = 60_000; }); // parkOnError-style
    const { manager, events } = makeManager();
    manager.setConnectBackoffHooks(gate, onConnectError);
    await manager.connect(CONFIG);
    connectScript.push(socketError()); // attempt 1 fails → parks; attempt 2 succeeds

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0);       // attempt 1 scheduled (gate still 0)
    await vi.advanceTimersByTimeAsync(1000);    // attempt 1 runs and fails
    expect(onConnectError).toHaveBeenCalledTimes(1);
    expect(onConnectError.mock.calls[0][0]).toBeInstanceOf(Error);

    // The park it set now holds the ladder: no attempt 2 on the normal backoff.
    await vi.advanceTimersByTimeAsync(5000);
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 3]]); // still only attempt 1
    expect(clients).toHaveLength(2); // client0 + the failed attempt-1 client

    // Window elapses (park scheduled for 60_000+500 from wait-start); clear it so
    // the next gate poll reopens, then let the wait fire → attempt 2 succeeds.
    parkMs = 0;
    await vi.advanceTimersByTimeAsync(60_500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 3], [2, 3]]);
    expect(countOf(events, 'reconnected')).toBe(1);
  });

  it('is a no-op ladder-wise when the gate reports no park (unchanged behaviour)', async () => {
    // Guards the inverse: a gate that always returns 0 must NOT block the ladder —
    // reconnect fires on the normal schedule, exactly as with no hooks at all.
    const { manager, events } = makeManager();
    manager.setConnectBackoffHooks(() => 0, () => {});
    await manager.connect(CONFIG);

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0);
    expect(argsOf(events, 'reconnecting')).toEqual([[1, 3]]); // fires immediately
    await vi.advanceTimersByTimeAsync(1000);
    expect(countOf(events, 'reconnected')).toBe(1);
  });

  it('aborts a park wait on disconnect() so shutdown never hangs', async () => {
    // Breaks if the park wait is not abortable: disconnect() during the window
    // would leave the ladder pending and the timer live past teardown.
    const gate = () => 120_000; // permanently parked for the duration of the test
    const { manager, events } = makeManager();
    manager.setConnectBackoffHooks(gate, () => {});
    await manager.connect(CONFIG);

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0); // enters the park wait
    expect(countOf(events, 'reconnecting')).toBe(0);

    await manager.disconnect();            // must settle the ladder and clear timers
    await vi.advanceTimersByTimeAsync(200_000);
    expect(countOf(events, 'reconnecting')).toBe(0); // never resumed
    expect(clients).toHaveLength(1);                 // no new socket opened
  });
});

describe('ConnectionManager — terminal failures', () => {
  // Terminal: retrying the same rejected credentials is what kept the server's
  // brute-force lockout alive (so even a correct password got rejected).
  it('stops the ladder dead on an auth failure and refuses every automatic retry', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    connectScript.push(authError());

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(2000);

    expect(countOf(events, 'auth-error')).toBe(1);
    expect(manager.state).toBe('error');
    expect(manager.authFailed).toBe(true);
    expect(manager.isInAuthCooldown()).toBe(true);

    // No further attempts, from any trigger.
    await vi.advanceTimersByTimeAsync(300_000);
    lastClient().emitSocketEvent('end');
    await manager.forceReconnect();
    expect(await manager.ensureConnection()).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(clients).toHaveLength(2);
    expect(countOf(events, 'reconnecting')).toBe(1); // just the one that failed
  });

  it('keeps the auth cooldown even when the renderer resets reconnect attempts', async () => {
    const { manager } = makeManager();
    connectScript.push(authError());
    await expect(manager.connect(CONFIG)).rejects.toThrow();

    manager.resetReconnectAttempts();

    expect(manager.isInAuthCooldown()).toBe(true);
    await manager.forceReconnect();
    expect(clients).toHaveLength(1); // forceReconnect refused: no new socket
  });

  it('clears the auth latch when connect() supplies fresh credentials', async () => {
    const { manager } = makeManager();
    connectScript.push(authError());
    await expect(manager.connect(CONFIG)).rejects.toThrow();

    await manager.connect(CONFIG); // re-auth path

    expect(manager.authFailed).toBe(false);
    expect(manager.isInAuthCooldown()).toBe(false);
    expect(manager.state).toBe('connected');
  });

  // Retrying a connection-cap rejection just adds another connect against an
  // already saturated cap; the pool has to be torn down and the slots left to
  // time out server-side.
  it('pauses on a quota error, signals upstream, and keeps the 5-minute cooldown', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    connectScript.push(quotaError());

    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(2000);

    expect(countOf(events, 'quota-exceeded')).toBe(1);
    expect(manager.isInQuotaCooldown()).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients).toHaveLength(2); // ladder really stopped

    // A network blip / alt-tab must NOT clear a server-side cap back-off.
    manager.resetReconnectAttempts();
    expect(manager.isInQuotaCooldown()).toBe(true);

    // …but it does expire by itself.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(manager.isInQuotaCooldown()).toBe(false);
  });
});

describe('ConnectionManager — ensureConnection / withConnection', () => {
  it('short-circuits when already connected', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    expect(await manager.ensureConnection()).toBe(true);
    expect(clients).toHaveLength(1);
  });

  // Wake-from-sleep race: the sleep-time disconnect() nulled _imapConfig and the
  // re-hydrating connect() hasn't run yet. A no-op, not an error.
  it('reports not-connected (never throws) when there is no config yet', async () => {
    const { manager } = makeManager();
    await expect(manager.ensureConnection()).resolves.toBe(false);
  });

  // An IPC call arriving on a dead-but-configured connection has to drive its own
  // ladder (nothing else will) and report the real outcome.
  it('starts a ladder itself when the connection is down and none is running', async () => {
    const { manager, events } = makeManager();
    connectScript.push(socketError());
    await expect(manager.connect(CONFIG)).rejects.toThrow();

    const [connected] = await Promise.all([
      manager.ensureConnection(),
      vi.advanceTimersByTimeAsync(2000),
    ]);

    expect(connected).toBe(true);
    expect(countOf(events, 'reconnecting')).toBe(1);
    expect(manager.state).toBe('connected');
  });

  it('joins the in-flight ladder instead of starting a second one', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    await manager.disconnect();
    await manager.connect(CONFIG);
    lastClient().emitSocketEvent('end'); // ladder starts, waiting out its backoff

    const [a, b] = await Promise.all([
      manager.ensureConnection(),
      manager.ensureConnection(),
      vi.advanceTimersByTimeAsync(2000),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(countOf(events, 'reconnecting')).toBe(1); // one ladder shared by both
  });

  // Regression: stopReconnect() has to SETTLE the ladder promise, or every
  // ensureConnection() awaiter (IPC calls) hangs forever.
  it('unblocks awaiters when the ladder is cancelled by a disconnect', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    connectScript.push('hang');
    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0);

    const pending = manager.ensureConnection();
    await manager.disconnect();

    await expect(pending).resolves.toBe(false);
  });

  it('withConnection runs the op on the live client and reconnects on a socket error', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);

    const host = await manager.withConnection(async (client) => client.host);
    expect(host).toBe('imap.test.local');

    await expect(manager.withConnection(async () => { throw new Error('Connection not available'); }))
      .rejects.toThrow('Connection not available');
    await vi.advanceTimersByTimeAsync(0);
    expect(countOf(events, 'reconnecting')).toBe(1);
  });

  it('withConnection does NOT reconnect on a command-level rejection', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);

    await expect(manager.withConnection(async () => { throw new Error("NO Mailbox doesn't exist"); }))
      .rejects.toThrow('Mailbox');
    await vi.advanceTimersByTimeAsync(0);

    expect(countOf(events, 'reconnecting')).toBe(0);
    expect(manager.state).toBe('connected');
  });

  // The manager re-exports the shared classifiers so callers (sync-engine, the
  // op-queue) never re-implement them with a divergent substring list.
  it('exposes the shared error classifiers', () => {
    const { manager } = makeManager();
    expect(manager.isConnectionError(new Error('Connection ended'))).toBe(true);
    expect(manager.isQuotaError(quotaError())).toBe(true);
    expect(manager.isAuthError(authError())).toBe(true);
    expect(manager.isRateLimited(Object.assign(new Error('slow down'), { code: 'ETHROTTLE' }))).toBe(true);
    expect(manager.isRateLimited(new Error("NO Mailbox doesn't exist"))).toBe(false);
  });

  it('withConnection refuses to run when the connection cannot be established', async () => {
    const { manager } = makeManager();
    const op = vi.fn();
    await expect(manager.withConnection(op)).rejects.toThrow('Not connected to IMAP server');
    expect(op).not.toHaveBeenCalled();
  });
});

describe('ConnectionManager — waitUntilConnected', () => {
  it('resolves true immediately when already connected', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    expect(await manager.waitUntilConnected()).toBe(true);
  });

  it('resolves on the next connected/reconnected event', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    clients[0].emitSocketEvent('end');

    const waiting = manager.waitUntilConnected(20_000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(await waiting).toBe(true);
  });

  it('resolves false on timeout without leaving listeners behind', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    connectScript.push('hang');
    clients[0].emitSocketEvent('end');

    const waiting = manager.waitUntilConnected(5000);
    await vi.advanceTimersByTimeAsync(6000);

    expect(await waiting).toBe(false);
    expect(manager.listenerCount('connected')).toBe(1); // only the test's recorder
    expect(manager.listenerCount('state-change')).toBe(1); // ditto — the fail-fast watcher is detached
  });

  it('does not wait at all on a latched/dead connection', async () => {
    const { manager } = makeManager();
    connectScript.push(authError());
    await expect(manager.connect(CONFIG)).rejects.toThrow();
    expect(await manager.waitUntilConnected()).toBe(false); // authFailed + error state

    const { manager: other } = makeManager();
    await other.connect(CONFIG);
    await other.disconnect();
    expect(await other.waitUntilConnected()).toBe(false); // shutting down
  });
});

// A connect() that is still shaking hands is neither connected nor dead, and
// nothing else in the manager occupies the 'connecting' state (the ladder stays
// in 'reconnecting'). Every caller that asks "is this connection healthy?" gets
// `false` for it, and the ones that read false as "zombie" then tear down the
// socket that was about to succeed — the cold-start race where the window-focus
// reconnect killed the mount connect. These pin the third state and the two
// callers that have to honour it.
describe('ConnectionManager — an in-flight connect is not a dead connection', () => {
  // If isConnecting() stops distinguishing a handshake from a dead socket, the
  // focus-driven resetAndReconnect goes back to force-reconnecting a live dial.
  it('reports isConnecting() only while the handshake is in flight', async () => {
    const { manager } = makeManager();
    expect(manager.isConnecting()).toBe(false);

    connectScript.push('hang');
    void manager.connect(CONFIG);

    // The three probes a caller might reach for, on a connection that is fine:
    // only isConnecting() tells the truth about it.
    expect(manager.isConnecting()).toBe(true);
    expect(manager.isConnected()).toBe(false);
    expect(await manager.verifyConnection()).toBe(false);
  });

  it('clears isConnecting() once the handshake lands', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    expect(manager.isConnecting()).toBe(false);
  });

  // The ladder must keep to 'reconnecting'. waitUntilConnected's fail-fast path
  // below is armed only for 'connecting', and it relies on that separation.
  it('is not "connecting" while the reconnect ladder runs', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    connectScript.push('hang');
    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(2000);

    expect(manager.isReconnecting()).toBe(true);
    expect(manager.isConnecting()).toBe(false);
  });

  // Regression: ensureConnection() arriving mid-handshake fell through to the
  // ladder, which builds a SECOND client and clobbers the socket the first
  // connect was about to hand over.
  it('ensureConnection waits for an in-flight connect instead of racing it', async () => {
    const { manager, events } = makeManager();
    const connecting = manager.connect(CONFIG);
    const ensuring = manager.ensureConnection(); // fires mid-handshake

    await connecting;

    expect(await ensuring).toBe(true);
    expect(clients).toHaveLength(1); // no competing socket
    expect(countOf(events, 'reconnecting')).toBe(0);
    expect(countOf(events, 'connected')).toBe(1);
  });

  // The failure path must not hold the caller for the full 20s wait: no timer is
  // advanced here, so this can only resolve via the leave-'connecting' shortcut.
  it('ensureConnection reports an in-flight connect that fails, without waiting out the timeout', async () => {
    const { manager } = makeManager();
    connectScript.push(socketError());
    const connecting = manager.connect(CONFIG).catch(() => { /* owned by its caller */ });
    const ensuring = manager.ensureConnection();

    await connecting;

    expect(await ensuring).toBe(false);
    expect(clients).toHaveLength(1);
  });

  // Same shortcut, straight through waitUntilConnected — this is what the
  // resetAndReconnect IPC awaits, and it must answer as soon as the connect it
  // is waiting on has failed.
  it('waitUntilConnected resolves false the moment an in-flight connect fails', async () => {
    const { manager } = makeManager();
    connectScript.push(socketError());
    const connecting = manager.connect(CONFIG).catch(() => { /* owned by its caller */ });

    const waiting = manager.waitUntilConnected(20_000);
    await connecting;

    expect(await waiting).toBe(false);
  });

  // ...but a LADDER keeps trying on its own, so the shortcut must not fire for
  // it: giving up on a failed rung would report "not connected" while the next
  // rung is about to succeed.
  it('waitUntilConnected keeps waiting through a failed ladder rung', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    connectScript.push(socketError()); // rung 1 fails; rung 2 connects
    clients[0].emitSocketEvent('end');

    const waiting = manager.waitUntilConnected(20_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await waiting).toBe(true);
  });
});

describe('ConnectionManager — health check', () => {
  it('keeps a healthy connection alive without reconnecting', async () => {
    clientOptions = { noop: 'alive' };
    const { manager, events } = makeManager({ healthCheckInterval: 1000 });
    await manager.connect(CONFIG);

    await vi.advanceTimersByTimeAsync(5000);

    expect(clients[0].callCount('noop')).toBe(5);
    expect(countOf(events, 'reconnecting')).toBe(0);
    expect(manager.state).toBe('connected');
  });

  // A single NOOP can queue behind a slow op on the shared IDLE socket; treating
  // that as death re-armed the timers and flapped connected<->reconnecting.
  it('needs THREE consecutive failed probes before it declares the socket dead', async () => {
    clientOptions = { noop: 'throw' };
    const { manager, events } = makeManager({ healthCheckInterval: 1000 });
    await manager.connect(CONFIG);

    await vi.advanceTimersByTimeAsync(2000);
    expect(countOf(events, 'reconnecting')).toBe(0); // 2 failures: not yet

    await vi.advanceTimersByTimeAsync(1000);
    expect(countOf(events, 'disconnected')).toBe(1);
    expect(countOf(events, 'reconnecting')).toBe(1);
  });

  it('resets the failure streak as soon as one probe succeeds', async () => {
    clientOptions = { noop: 'throw' };
    const { manager, events } = makeManager({ healthCheckInterval: 1000 });
    await manager.connect(CONFIG);

    await vi.advanceTimersByTimeAsync(2000);      // 2 failures
    clients[0].setNoop('alive');
    await vi.advanceTimersByTimeAsync(1000);      // healthy → streak cleared
    clients[0].setNoop('throw');
    await vi.advanceTimersByTimeAsync(2000);      // 2 more failures only

    expect(countOf(events, 'reconnecting')).toBe(0);
  });

  it('counts a NOOP that answers "not alive" as a failed probe', async () => {
    clientOptions = { noop: 'dead' };
    const { manager, events } = makeManager({ healthCheckInterval: 1000 });
    await manager.connect(CONFIG);

    await vi.advanceTimersByTimeAsync(3000);

    expect(countOf(events, 'reconnecting')).toBe(1);
  });

  // Overlapping probes pile up on the one socket; a slow NOOP must make the next
  // tick SKIP, not add another in-flight command.
  it('never overlaps probes while one is still in flight', async () => {
    clientOptions = { noop: 'hang' };
    const { manager } = makeManager({ healthCheckInterval: 1000 });
    await manager.connect(CONFIG);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(clients[0].callCount('noop')).toBe(1);
  });

  it('does nothing when the client has no NOOP at all', async () => {
    const { manager, events } = makeManager({ healthCheckInterval: 1000 });
    await manager.connect(CONFIG);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(countOf(events, 'reconnecting')).toBe(0);
  });

  it('stops probing after disconnect()', async () => {
    clientOptions = { noop: 'alive' };
    const { manager } = makeManager({ healthCheckInterval: 1000 });
    await manager.connect(CONFIG);
    await vi.advanceTimersByTimeAsync(1000);
    await manager.disconnect();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(clients[0].callCount('noop')).toBe(1);
  });

  it('skips the probe while the manager is not connected', async () => {
    clientOptions = { noop: 'alive' };
    const { manager } = makeManager({ healthCheckInterval: 1000 });
    await manager.connect(CONFIG);
    connectScript.push('hang');
    clients[0].emitSocketEvent('end'); // state leaves 'connected'

    await vi.advanceTimersByTimeAsync(5000);

    expect(clients[0].callCount('noop')).toBe(0);
  });
});

describe('ConnectionManager — verifyConnection', () => {
  it('answers from the NOOP without ever triggering the reconnect ladder', async () => {
    clientOptions = { noop: 'alive' };
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);

    expect(await manager.verifyConnection()).toBe(true);

    clients[0].setNoop('dead');
    expect(await manager.verifyConnection()).toBe(false);
    clients[0].setNoop('throw');
    expect(await manager.verifyConnection()).toBe(false);
    expect(countOf(events, 'reconnecting')).toBe(0); // probe only — never tears down
  });

  it('reports false for a zombie socket that never answers', async () => {
    clientOptions = { noop: 'hang' };
    const { manager } = makeManager();
    await manager.connect(CONFIG);

    const probe = manager.verifyConnection(10_000);
    await vi.advanceTimersByTimeAsync(10_001);

    expect(await probe).toBe(false);
  });

  it('falls back to the socket state when the client has no NOOP, and is false when down', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    expect(await manager.verifyConnection()).toBe(true);

    await manager.disconnect();
    expect(await manager.verifyConnection()).toBe(false);
  });
});

describe('ConnectionManager — forceReconnect', () => {
  // Zombie recovery: the socket looks open but the server dropped it long ago,
  // so the old client must be replaced, not reused, and the UI must be told
  // (the renderer only reacts to 'reconnected').
  it('builds a FRESH client, drops the zombie, and emits reconnected', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    const zombie = clients[0];

    await manager.forceReconnect();

    expect(clients).toHaveLength(2);
    expect(manager.client).toBe(clients[1]);
    expect(manager.client).not.toBe(zombie);
    expect(zombie.callCount('disconnect')).toBe(1);
    expect(zombie.socketListenerCount('end')).toBe(0);
    expect(countOf(events, 'reconnected')).toBe(1);
    expect(manager.state).toBe('connected');

    // The fresh client is unused, so connect() must NOT have discarded it again.
    expect(clients).toHaveLength(2);
  });

  it('is a harmless no-op during the wake race when config is not hydrated yet', async () => {
    const { manager, events } = makeManager();

    await expect(manager.forceReconnect()).resolves.toBeUndefined();

    expect(clients).toHaveLength(1); // only the constructor's client
    expect(events).toEqual([]);
  });

  it('does not wait forever on a zombie whose disconnect never returns', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    clients[0].setDisconnectBehavior('hang');

    const forced = manager.forceReconnect();
    await vi.advanceTimersByTimeAsync(3000); // the 3s cap on the old socket

    await expect(forced).resolves.toBeUndefined();
    expect(manager.state).toBe('connected');
  });

  it('proceeds when the zombie\'s disconnect throws (the socket is unreliable by definition)', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    clients[0].setDisconnectBehavior('throw');

    await expect(manager.forceReconnect()).resolves.toBeUndefined();
    expect(manager.state).toBe('connected');
    expect(clients).toHaveLength(2);
  });

  it('times out (and reports) when the replacement connect also hangs', async () => {
    const { manager } = makeManager();
    await manager.connect(CONFIG);
    connectScript.push('hang');

    const forced = manager.forceReconnect(5000);
    const assertion = expect(forced).rejects.toThrow('forceReconnect: connect timed out');
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it('cancels an in-flight ladder so it cannot clobber the fresh connection', async () => {
    const { manager, events } = makeManager();
    await manager.connect(CONFIG);
    clients[0].emitSocketEvent('end');
    await vi.advanceTimersByTimeAsync(0); // ladder armed, still waiting out its backoff
    expect(manager.isReconnecting()).toBe(true);

    await manager.forceReconnect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(manager.state).toBe('connected');
    expect(countOf(events, 'reconnected')).toBe(1);
    expect(clients).toHaveLength(2); // ladder never got to build its own client
  });
});
