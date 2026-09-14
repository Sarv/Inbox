import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body prefetch scheduler. Pinned behaviour:
 *   - first tick 20s after start; 60s while there is a backlog; a 10-minute sleep
 *     once every account is drained,
 *   - seeds are expanded with their THREAD SIBLINGS and the total is capped per
 *     tick (200) so IMAP load stays bounded,
 *   - an email whose body can never be fetched is given up after 3 attempts and
 *     marked unfetchable — otherwise it is re-seeded forever,
 *   - seeds are newest-first, so a head that cannot be downloaded ROTATES out of
 *     the way instead of pinning the same 80 rows every tick,
 *   - one account's tick is bounded by a wall-clock budget,
 *   - a user-initiated fetch DEFERS the background batch (connection priority),
 *   - new mail KICKS the loop instead of waiting out the idle interval,
 *   - one account's failure never stops the others; a tick in flight is never
 *     re-entered; stop() prevents any further tick.
 */

const FIRST_DELAY_MS = 20_000;
const ACTIVE_INTERVAL_MS = 60_000;
const IDLE_INTERVAL_MS = 10 * 60_000;
const SEED_PER_TICK = 80;
const TOTAL_CAP_PER_TICK = 200;
const SIBLING_FETCH_LIMIT = 400;
const MAX_BODY_FETCH_ATTEMPTS = 3;
const STARVED_BACKOFF_1_MS = 120_000;
const TICK_BUDGET_MS = 5 * 60_000;
const RETIRED_RECHECK_MS = 6 * 60 * 60_000;
const BOOST_INTERVAL_MS = 2_000;

const h = vi.hoisted(() => ({
  logs: [] as string[],
  activeStorage: null as unknown,
  activeEngine: null as unknown,
  runtimes: [] as Array<[string, { storage: unknown; syncEngine: unknown; smtpClient: null }]>,
  window: null as { destroyed: boolean; sent: Array<{ channel: string; payload: unknown }> } | null,
  busHandlers: [] as Array<(event: unknown) => void>,
  busThrows: false,
  unsubThrows: false,
  unsubCalls: 0,
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.activeStorage,
  getSyncEngine: () => h.activeEngine,
  getAllAccountRuntimes: () => h.runtimes,
  getMainWindow: () =>
    h.window
      ? {
          isDestroyed: () => h.window!.destroyed,
          webContents: {
            send: (channel: string, payload: unknown) => h.window!.sent.push({ channel, payload }),
          },
        }
      : null,
}));

class FakeTimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message: string, readonly phase?: 'queued' | 'running') {
    super(message);
    this.name = 'TimeoutError';
  }
}

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    // Captured, not discarded: the per-tick failure summary IS the feature under
    // test in the "tick summary" block below.
    info: (...args: unknown[]) => { h.logs.push(args.join(' ')); },
    warn: (...args: unknown[]) => { h.logs.push(args.join(' ')); },
    error: () => {}, debug: () => {}, trace: () => {},
  }),
  isTimeoutError: (e: unknown) => (e as { isTimeout?: boolean })?.isTimeout === true,
  isAuthError: (e: unknown) => /auth|credential/i.test((e as Error)?.message ?? ''),
  isQuotaError: (e: unknown) => /over quota|rate/i.test((e as Error)?.message ?? ''),
  getEventBus: () => ({
    on: (_event: string, cb: (event: unknown) => void) => {
      if (h.busThrows) throw new Error('bus unavailable');
      h.busHandlers.push(cb);
      return () => {
        h.unsubCalls += 1;
        if (h.unsubThrows) throw new Error('unsub failed');
      };
    },
  }),
  // The real helper races a promise against a timeout; the tests never need the
  // timeout arm, so pass the promise through (keeps fake timers simple).
  withTimeout: async <T>(promise: Promise<T>) => promise,
  // Real `fetchBodyQueued` wraps engine.fetchBody in a two-phase deadline. The
  // deadline itself is tested in core (timeout.test.ts / fetch-body-queued.test.ts);
  // here we only care that the scheduler routes every fetch through it.
  fetchBodyQueued: async (
    engine: { fetchBody: (id: string, path: string, uid: number) => Promise<unknown> },
    emailId: string,
    folderPath: string,
    uid: number,
  ) => engine.fetchBody(emailId, folderPath, uid),
}));

type Scheduler = typeof import('../../../../electron/services/body-prefetch-scheduler');

/** Fresh module — timers, in-flight flag, defer window and the failure counters
 *  are all module state. */
const load = async (): Promise<Scheduler> => {
  vi.resetModules();
  return import('../../../../electron/services/body-prefetch-scheduler');
};

interface Email { id: string; folderId: string; uid: number | null; rawBody?: string; threadId?: string }

interface AccountState {
  emails: Map<string, Email>;
  seeds: string[];
  siblings: string[];
  remaining: number;
  connected: boolean;
  /** fetchBody THROWS for these — a connection blip / timeout / auth pause. */
  fetchFails: Set<string>;
  /** fetchBody throws THIS error for the id, so a test can pin a failure CLASS. */
  fetchErrors: Map<string, unknown>;
  /** storage.getEmail returns null for these — a row we cannot even read. */
  missingRows: Set<string>;
  /**
   * fetchBody RESOLVES null for these — the engine reached a verdict ("no
   * message for this UID", unselectable folder, engine retries exhausted). Only
   * this outcome is evidence about the message, so only it may accrue a strike.
   */
  fetchNulls: Set<string>;
  /** Rows cleared by clearBodiesUnfetchable(), newest call last. */
  cleared: number[];
  /** Wall-clock ONE fetch consumes. Lets a test exhaust the per-tick budget. */
  fetchDelayMs: number;
  seedCalls: number[];
  /** Calls to the UNREAD seed query — proves a manual run changed seed source. */
  unreadSeedCalls: number[];
  /** OFFSET passed with each seed query — the rotation window under test. */
  seedOffsetCalls: number[];
  siblingCalls: Array<[string[], number]>;
  fetched: string[];
  unfetchable: string[][];
  markThrows: boolean;
  useLegacyApi: boolean;
  seedThrows: boolean;
  /** Unread-only backlog. Defined on the storage ONLY when a test sets it, so
   *  every existing test keeps exercising the background seed path. */
  unreadSeeds?: string[];
}

const makeAccount = (over: Partial<AccountState> = {}) => {
  const state: AccountState = {
    emails: new Map(),
    seeds: [],
    siblings: [],
    remaining: 0,
    connected: true,
    fetchFails: new Set(),
    fetchErrors: new Map(),
    missingRows: new Set(),
    fetchNulls: new Set(),
    cleared: [],
    fetchDelayMs: 0,
    seedCalls: [],
    unreadSeedCalls: [],
    seedOffsetCalls: [],
    siblingCalls: [],
    fetched: [],
    unfetchable: [],
    markThrows: false,
    useLegacyApi: false,
    seedThrows: false,
    ...over,
  };

  const email = (id: string): Email =>
    state.emails.get(id) ?? { id, folderId: 'INBOX', uid: Number(id.replace(/\D/g, '')) || 1 };

  const storage: Record<string, unknown> = {
    getEmail: async (id: string) => (
      state.missingRows.has(id) ? null : (state.emails.has(id) ? state.emails.get(id) : email(id))
    ),
    getFolder: async (folderId: string) => (folderId === 'gone' ? null : { path: folderId }),
    getThreadSiblingsWithoutBody: (seeds: string[], limit: number) => {
      state.siblingCalls.push([seeds, limit]);
      return state.siblings;
    },
    markBodiesUnfetchable: (ids: string[]) => {
      if (state.markThrows) throw new Error('write failed');
      state.unfetchable.push(ids);
    },
    clearBodiesUnfetchable: () => {
      const n = state.unfetchable.reduce((sum, ids) => sum + ids.length, 0);
      state.unfetchable = [];
      state.cleared.push(n);
      return n;
    },
  };
  if (state.useLegacyApi) {
    storage.getUnreadEmailIdsWithoutBody = (limit: number) => {
      state.seedCalls.push(limit);
      return state.seeds;
    };
    storage.countUnreadEmailsWithoutBody = () => state.remaining;
  } else {
    storage.getSeedEmailIdsWithoutBody = (limit: number, offset = 0) => {
      state.seedCalls.push(limit);
      state.seedOffsetCalls.push(offset);
      if (state.seedThrows) throw new Error('db closed');
      // Mirrors the SQL: a window into the newest-first backlog, so a rotated
      // offset really does hand back different rows (or none, past the end).
      return state.seeds.slice(offset, offset + limit);
    };
    storage.countEmailsWithoutBody = () => state.remaining;
    if (state.unreadSeeds) {
      storage.getUnreadEmailIdsWithoutBody = (limit: number) => {
        state.unreadSeedCalls.push(limit);
        return state.unreadSeeds!.slice(0, limit);
      };
    }
  }

  const engine = {
    isConnected: () => state.connected,
    fetchBody: async (emailId: string) => {
      if (state.fetchDelayMs > 0) {
        await new Promise((resolve) => { setTimeout(resolve, state.fetchDelayMs); });
      }
      // Resolving null models the engine's VERDICT; throwing models a blip.
      if (state.fetchNulls.has(emailId)) return null;
      if (state.fetchErrors.has(emailId)) throw state.fetchErrors.get(emailId);
      if (state.fetchFails.has(emailId)) throw new Error(`Connection error (${emailId})`);
      state.fetched.push(emailId);
      return { rawBody: 'raw', cleanBody: 'clean', contentType: 'text/html' };
    },
  };

  return { state, storage, engine };
};

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  h.logs = [];
  vi.setSystemTime(Date.UTC(2026, 5, 15, 12, 0, 0));
  h.activeStorage = null;
  h.activeEngine = null;
  h.runtimes = [];
  h.window = { destroyed: false, sent: [] };
  h.busHandlers = [];
  h.busThrows = false;
  h.unsubThrows = false;
  h.unsubCalls = 0;
});

afterEach(() => { vi.useRealTimers(); });

describe('start / stop', () => {
  it('runs the first tick 20s after start and wakes on new mail', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBodyPrefetchScheduler();
    expect(h.busHandlers).toHaveLength(1);
    await advance(FIRST_DELAY_MS - 1);
    expect(a.state.fetched).toEqual([]);

    await advance(1);
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();
  });

  it('is idempotent', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();
  });

  it('STILL fetches a row whose uid is null (relinked/never-synced) — not skipped', async () => {
    // Regression: the old `|| !email.uid` guard short-circuited uid-null rows to
    // "transient", re-seeding the same ghosts every tick forever (the frozen Gmail
    // backlog). They must be handed to fetchBody, which re-resolves the uid from
    // the message-id. Here the engine mock just returns a body → it counts as
    // fetched, proving the row is no longer skipped at the scheduler.
    const a = makeAccount({ seeds: ['e-nouid'] });
    a.state.emails.set('e-nouid', { id: 'e-nouid', folderId: 'INBOX', uid: null });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.fetched).toEqual(['e-nouid']);
    svc.stopBodyPrefetchScheduler();
  });

  it('still skips a row whose FOLDER no longer exists (nothing to fetch against)', async () => {
    // A deleted folder cascade-deletes its emails, so this is defensive: a row we
    // can't resolve a folder for is transient, never a strike.
    const a = makeAccount({ seeds: ['e-gone'] });
    a.state.emails.set('e-gone', { id: 'e-gone', folderId: 'gone', uid: 5 });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.fetched).toEqual([]);        // not fetched
    expect(a.state.unfetchable).toEqual([]);    // and never marked |nobody|
    svc.stopBodyPrefetchScheduler();
  });

  it('stop() cancels the pending tick and unsubscribes', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    svc.stopBodyPrefetchScheduler();
    await advance(10 * IDLE_INTERVAL_MS);
    expect(a.state.fetched).toEqual([]);
    expect(h.unsubCalls).toBe(1);
  });

  it('starts even when the event bus refuses the subscription', async () => {
    h.busThrows = true;
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    expect(() => svc.startBodyPrefetchScheduler()).not.toThrow();
    await advance(FIRST_DELAY_MS);
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();
  });

  it('tolerates a throwing unsubscribe and a double stop', async () => {
    h.unsubThrows = true;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    expect(() => svc.stopBodyPrefetchScheduler()).not.toThrow();
    expect(() => svc.stopBodyPrefetchScheduler()).not.toThrow();
  });
});

describe('pacing', () => {
  it('keeps the 60s cadence while a backlog remains, then sleeps 10 minutes', async () => {
    const a = makeAccount({ seeds: ['e1'], remaining: 5 });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.seedCalls).toHaveLength(1);

    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.seedCalls).toHaveLength(2);

    // Backlog drains -> the next tick schedules the long sleep.
    a.state.remaining = 0;
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.seedCalls).toHaveLength(3);

    await advance(ACTIVE_INTERVAL_MS * 5);
    expect(a.state.seedCalls).toHaveLength(3); // sleeping
    await advance(IDLE_INTERVAL_MS);
    expect(a.state.seedCalls).toHaveLength(4);
    svc.stopBodyPrefetchScheduler();
  });

  it('an empty seed list counts as drained (long sleep)', async () => {
    const a = makeAccount({ seeds: [] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.seedCalls).toHaveLength(1);
    await advance(ACTIVE_INTERVAL_MS * 5);
    expect(a.state.seedCalls).toHaveLength(1);
    svc.stopBodyPrefetchScheduler();
  });

  it('retries later when nothing is connected yet', async () => {
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);

    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();
  });

  it('does NOT re-enter a tick that is still in flight', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = {
      ...(a.storage as Record<string, unknown>),
      getSeedEmailIdsWithoutBody: (limit: number) => {
        a.state.seedCalls.push(limit);
        return a.state.seeds;
      },
      getEmail: async (id: string) => { await blocked; return { id, folderId: 'INBOX', uid: 1 }; },
    };
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.seedCalls).toHaveLength(1);

    await advance(5 * ACTIVE_INTERVAL_MS);
    expect(a.state.seedCalls).toHaveLength(1); // never re-entered

    release();
    await advance(1);
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();
  });

  // THE THROTTLE STORM at the fetch layer. When Gmail throttles FETCH throughput
  // on a big mailbox, every body fetch times out and the tick downloads nothing.
  // The old flat 60s cadence re-burst 80 fetches into the same throttle every
  // minute, prolonging it. A starved tick must now back off (2m → 4m → …) so the
  // throttle can decay, instead of hammering it.
  it('backs off a throttled account whose fetches all time out, instead of re-bursting every 60s', async () => {
    const a = makeAccount({ seeds: ['e1'], remaining: 5, fetchFails: new Set(['e1']) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    // Ticks are counted by sibling expansion, not by seed queries: a starved
    // tick rotates the seed window, so a later tick can issue TWO seed queries
    // (the rotated window, then the wrap back to 0) while still being one tick.
    await advance(FIRST_DELAY_MS);
    expect(a.state.siblingCalls).toHaveLength(1);   // tick 1 ran, starved → next in 2m

    // Under the OLD flat cadence this would fire at 60s — it must NOT.
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.siblingCalls).toHaveLength(1);
    // First back-off rung is 2×60s = 120s.
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.siblingCalls).toHaveLength(2);   // tick 2, still starved → next in 4m

    await advance(ACTIVE_INTERVAL_MS * 3);          // 3m < 4m: not yet
    expect(a.state.siblingCalls).toHaveLength(2);
    await advance(ACTIVE_INTERVAL_MS);              // 4m reached
    expect(a.state.siblingCalls).toHaveLength(3);
    svc.stopBodyPrefetchScheduler();
  });

  // Recovery must be immediate the moment fetches succeed again — the back-off
  // exists only while the server is starving us, never a step the queue has to
  // climb back down.
  it('snaps back to the 60s cadence the moment a body downloads again', async () => {
    const a = makeAccount({ seeds: ['e1'], remaining: 5, fetchFails: new Set(['e1']) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);               // tick 1 starved → next in 2m
    a.state.fetchFails.clear();                  // throttle clears
    await advance(ACTIVE_INTERVAL_MS * 2);       // tick 2 at 2m downloads e1 → streak reset
    expect(a.state.fetched).toContain('e1');
    // Back on the active cadence: the next tick is 60s away, not a backed-off 4m.
    // Counted by sibling expansion — see the note in the back-off test above.
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.siblingCalls).toHaveLength(3);
    svc.stopBodyPrefetchScheduler();
  });

  // A new-mail kick during a throttle must not blow past the back-off and
  // re-burst; only a reconnect (resetBackoff) may resume immediately.
  it('ignores a plain kick while throttled but resumes on a reconnect reset-kick', async () => {
    const a = makeAccount({ seeds: ['e1'], remaining: 5, fetchFails: new Set(['e1']) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);               // tick 1 starved → backed off
    expect(a.state.seedCalls).toHaveLength(1);

    // Plain kick (IDLE new mail): suppressed while starved.
    svc.kickBodyPrefetchScheduler();
    await advance(1_000);
    expect(a.state.seedCalls).toHaveLength(1);

    // Reconnect reset-kick: drops the back-off and retries at once.
    a.state.fetchFails.clear();
    svc.kickBodyPrefetchScheduler({ resetBackoff: true });
    await advance(1_000);
    expect(a.state.fetched).toContain('e1');
    svc.stopBodyPrefetchScheduler();
  });
});

describe('computeNextTickDelay', () => {
  it('sleeps the long idle interval and resets the streak when every account is drained', () => {
    // Nothing left to fetch → the 10-minute sleep, and the streak must clear so a
    // future backlog starts at the fast cadence, not a stale back-off rung.
    return load().then((svc) => {
      expect(svc.computeNextTickDelay({ drained: true, starved: false, starvedStreak: 4 }))
        .toEqual({ delayMs: IDLE_INTERVAL_MS, starvedStreak: 0 });
    });
  });

  it('uses the active cadence and resets the streak when a body downloaded', () => {
    // Any progress proves the server isn't throttling us → fast cadence, streak 0.
    return load().then((svc) => {
      expect(svc.computeNextTickDelay({ drained: false, starved: false, starvedStreak: 3 }))
        .toEqual({ delayMs: ACTIVE_INTERVAL_MS, starvedStreak: 0 });
    });
  });

  it('escalates 2m → 4m → 8m across consecutive starved ticks and caps at the idle interval', () => {
    // The fetch-layer analogue of the connect-timeout ladder: sustained "all
    // fetches timed out" backs off harder so Gmail's FETCH throttle can decay.
    return load().then((svc) => {
      let streak = 0;
      const windows: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const next = svc.computeNextTickDelay({ drained: false, starved: true, starvedStreak: streak });
        streak = next.starvedStreak;
        windows.push(next.delayMs);
      }
      expect(windows).toEqual([120_000, 240_000, 480_000, IDLE_INTERVAL_MS, IDLE_INTERVAL_MS]);
    });
  });
});

describe('computeNextTickDelay — during a manual run', () => {
  // The point of the manual button: back-to-back batches instead of a minute of
  // idling between each 200-body tick, which would make a 500-body request take
  // eight minutes of doing almost nothing and read as a button that didn't work.
  it('comes straight back for the next batch while a budget remains', async () => {
    const svc = await load();
    expect(svc.computeNextTickDelay({
      drained: false, starved: false, starvedStreak: 0, boostRemaining: 300,
    })).toEqual({ delayMs: BOOST_INTERVAL_MS, starvedStreak: 0 });
  });

  // THE safety property. A manual run must not override the server telling us to
  // slow down — re-bursting into a FETCH throttle every 2s is what prolongs it,
  // and it is exactly what a "hurry up" button invites.
  it('still backs off a throttled server, budget or not', async () => {
    const svc = await load();
    expect(svc.computeNextTickDelay({
      drained: false, starved: true, starvedStreak: 0, boostRemaining: 500,
    })).toEqual({ delayMs: 120_000, starvedStreak: 1 });
  });

  // An exhausted budget is an ended run: the cadence must fall back rather than
  // keep polling every 2 seconds for the rest of the session.
  it('returns to the normal cadence once the budget is spent', async () => {
    const svc = await load();
    expect(svc.computeNextTickDelay({
      drained: false, starved: false, starvedStreak: 0, boostRemaining: 0,
    })).toEqual({ delayMs: ACTIVE_INTERVAL_MS, starvedStreak: 0 });
  });

  // Nothing left to download ends the run too, however much budget is left.
  it('sleeps normally when the backlog drained mid-run', async () => {
    const svc = await load();
    expect(svc.computeNextTickDelay({
      drained: true, starved: false, starvedStreak: 0, boostRemaining: 400,
    })).toEqual({ delayMs: IDLE_INTERVAL_MS, starvedStreak: 0 });
  });

  // Omitting the field must behave exactly as before this feature existed —
  // every other caller passes three fields.
  it('defaults to no boost when the caller omits it', async () => {
    const svc = await load();
    expect(svc.computeNextTickDelay({ drained: false, starved: false, starvedStreak: 0 }))
      .toEqual({ delayMs: ACTIVE_INTERVAL_MS, starvedStreak: 0 });
  });
});

describe('manual body download', () => {
  /** Start the scheduler with one connected account and run its first tick. */
  const started = async (over: Parameters<typeof makeAccount>[0] = {}) => {
    const a = makeAccount(over);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS + 10);
    return { a, svc };
  };

  // THE feature: the button targets the "Unread + no body yet" row, and the AI
  // only acts on unread mail. Seeding the background list instead would download
  // hundreds of read bodies the pipeline ignores, leaving the number the user is
  // watching almost unmoved.
  it('seeds the UNREAD backlog rather than the background thread-driven one', async () => {
    const { a, svc } = await started({ seeds: ['read1'], unreadSeeds: ['u1', 'u2'], remaining: 2 });
    a.state.fetched.length = 0;

    svc.startManualBodyDownload(100);
    await advance(1_000);

    expect(a.state.unreadSeedCalls.length).toBeGreaterThan(0);
    expect(a.state.fetched).toContain('u1');
    expect(a.state.fetched).not.toContain('read1');
  });

  // A tick where every fetch timed out downloaded nothing. Spending the budget on
  // what we ATTEMPTED would let one bad minute consume the user's whole request
  // and report the run "finished" with zero bodies downloaded.
  it('spends the budget on bodies that landed, not on attempts', async () => {
    const { svc } = await started({
      unreadSeeds: ['u1', 'u2'],
      seeds: ['u1', 'u2'],
      remaining: 2,
      fetchFails: new Set(['u1', 'u2']),
    });

    svc.startManualBodyDownload(2);
    await advance(1_000);

    // Nothing downloaded → the whole budget survives the tick.
    expect(svc.getManualBodyDownloadState()).toMatchObject({ active: true, downloaded: 0 });
  });

  // The run has to end on its own, or the scheduler polls every 2s forever.
  it('ends the run once the budget is spent', async () => {
    const { svc } = await started({ unreadSeeds: ['u1'], seeds: ['u1'], remaining: 1 });

    svc.startManualBodyDownload(1);
    await advance(5_000);

    expect(svc.getManualBodyDownloadState().active).toBe(false);
  });

  // Asking for 500 when only 12 exist must not leave a run armed against mail
  // that isn't there.
  it('ends the run when the backlog drains before the budget does', async () => {
    const { svc } = await started({ unreadSeeds: [], seeds: [], remaining: 0 });

    svc.startManualBodyDownload(500);
    await advance(5_000);

    expect(svc.getManualBodyDownloadState().active).toBe(false);
  });

  // The panel shows "312 of 500"; without a target it could only show a
  // countdown, and without the event it would not move until the 30s poll.
  it('reports progress to the renderer', async () => {
    const { svc } = await started({ unreadSeeds: ['u1'], seeds: ['u1'], remaining: 1 });
    h.window!.sent.length = 0;

    svc.startManualBodyDownload(50);
    await advance(5_000);

    const progress = h.window!.sent.filter((m) => m.channel === 'body-download:progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].payload).toMatchObject({ active: true, target: 50 });
  });

  // Two concurrent drains would fight over the same connection pool, so a second
  // press raises the budget instead of starting a rival run.
  it('raises the budget instead of starting a second run', async () => {
    const { svc } = await started({ unreadSeeds: ['u1'], seeds: ['u1'], remaining: 1 });

    svc.startManualBodyDownload(100);
    const after = svc.startManualBodyDownload(50);

    expect(after.target).toBe(150);
  });

  it('cancels on request, leaving the background scheduler running', async () => {
    const { svc } = await started({ unreadSeeds: ['u1'], seeds: ['u1'], remaining: 1 });

    svc.startManualBodyDownload(500);
    expect(svc.stopManualBodyDownload().active).toBe(false);
    expect(svc.getManualBodyDownloadState()).toMatchObject({ active: false, target: 0 });
  });

  // Pressing the button before any account has connected must say so rather than
  // arm a budget nothing will ever spend — a button that silently does nothing.
  it('reports inactive when the scheduler is not running', async () => {
    const svc = await load();
    expect(svc.startManualBodyDownload(500).active).toBe(false);
  });

  // A run cannot outlive the scheduler that spends its budget; leaving it armed
  // would resume a download the next start() never asked for.
  it('is cleared when the scheduler stops', async () => {
    const { svc } = await started({ unreadSeeds: ['u1'], seeds: ['u1'], remaining: 1 });

    svc.startManualBodyDownload(500);
    svc.stopBodyPrefetchScheduler();

    expect(svc.getManualBodyDownloadState().active).toBe(false);
  });

  // Older storage (or a background account whose adapter predates the unread
  // query) must still download SOMETHING rather than throwing or stalling.
  it('falls back to the background seed when unread-first is unavailable', async () => {
    const { a, svc } = await started({ seeds: ['e1'], remaining: 1 });
    a.state.fetched.length = 0;

    svc.startManualBodyDownload(10);
    await advance(1_000);

    expect(a.state.fetched).toContain('e1');
  });
});

describe('kickBodyPrefetchScheduler', () => {
  it('pulls the next tick forward to ~1s', async () => {
    const a = makeAccount({ seeds: ['e1'], remaining: 0 });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);          // first tick; queue drained -> 10min sleep

    a.state.seeds = ['e2'];
    svc.kickBodyPrefetchScheduler();
    await advance(1_000);
    expect(a.state.fetched).toEqual(['e1', 'e2']);
    svc.stopBodyPrefetchScheduler();
  });

  it('new mail on the bus kicks the loop; a non-new event does not', async () => {
    const a = makeAccount({ seeds: ['e1'], remaining: 0 });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);

    a.state.seeds = ['e2'];
    h.busHandlers[0]({ isNew: false });
    h.busHandlers[0](undefined);
    await advance(2_000);
    expect(a.state.fetched).toEqual(['e1']);

    h.busHandlers[0]({ isNew: true });
    await advance(1_000);
    expect(a.state.fetched).toEqual(['e1', 'e2']);
    svc.stopBodyPrefetchScheduler();
  });

  it('is a no-op before start', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.kickBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.fetched).toEqual([]);
  });
});

describe('deferBodyPrefetch', () => {
  it('yields the connection while the user is downloading, then resumes', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    // The window has to outlast the 20s first tick for it to be deferred.
    svc.deferBodyPrefetch(40_000);
    await advance(FIRST_DELAY_MS);
    expect(a.state.seedCalls).toHaveLength(0); // deferred, not run

    await advance(20_250); // the tick re-armed itself for the end of the window
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();
  });

  it('extends an existing defer window but never shortens it', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    svc.deferBodyPrefetch(30_000);
    svc.deferBodyPrefetch(1_000); // shorter -> ignored
    await advance(FIRST_DELAY_MS + 5_000);
    expect(a.state.seedCalls).toHaveLength(0);

    await advance(30_000);
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();
  });

  it('defaults to a 15s window', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    // Defer just before the first tick so the default 15s window covers it.
    await advance(FIRST_DELAY_MS - 1);
    svc.deferBodyPrefetch();
    await advance(1);
    expect(a.state.seedCalls).toHaveLength(0);
    await advance(15_250);
    expect(a.state.seedCalls).toHaveLength(1);
    svc.stopBodyPrefetchScheduler();
  });
});

describe('the fetch batch', () => {
  it('expands seeds with thread siblings and caps the total per tick', async () => {
    const seeds = Array.from({ length: 80 }, (_, i) => `s${i}`);
    const siblings = Array.from({ length: 400 }, (_, i) => `t${i}`);
    const a = makeAccount({ seeds, siblings });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);

    expect(a.state.seedCalls[0]).toBe(SEED_PER_TICK);
    expect(a.state.siblingCalls[0]).toEqual([seeds, SIBLING_FETCH_LIMIT]);
    expect(a.state.fetched).toHaveLength(TOTAL_CAP_PER_TICK);
    expect(a.state.fetched.slice(0, 80)).toEqual(seeds);
    svc.stopBodyPrefetchScheduler();
  });

  it('stops issuing sub-batches once the per-tick wall-clock budget is spent', async () => {
    // Each body now gets its own queue-wait window, so on a stalled server one
    // account could otherwise hold the tick for tens of minutes — long past the
    // point where the cadence logic should have backed off and moved on. What is
    // left is deferred to the next tick, never dropped.
    const seeds = Array.from({ length: SEED_PER_TICK }, (_, i) => `s${i}`);
    const a = makeAccount({ seeds, remaining: 100, fetchDelayMs: 60_000 });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    await advance(TICK_BUDGET_MS);
    // 10 per sub-batch, 60s each: five sub-batches fit in the 5-minute budget.
    expect(a.state.fetched).toHaveLength(50);
    expect(a.state.seedCalls).toHaveLength(1);   // still the SAME tick
    svc.stopBodyPrefetchScheduler();
  });

  it('pushes each fetched body to the renderer', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);

    expect(h.window!.sent).toEqual([
      {
        channel: 'body:fetched',
        payload: {
          id: 'e1', folderId: 'INBOX', uid: 1,
          rawBody: 'raw', cleanBody: 'clean', contentType: 'text/html',
        },
      },
    ]);
    svc.stopBodyPrefetchScheduler();
  });

  it('skips the renderer push when the window is gone or destroyed', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    h.window = null;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();

    const b = makeAccount({ seeds: ['e2'] });
    h.activeStorage = b.storage;
    h.activeEngine = b.engine;
    h.window = { destroyed: true, sent: [] };
    const svc2 = await load();
    svc2.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(b.state.fetched).toEqual(['e2']);
    expect(h.window.sent).toEqual([]);
    svc2.stopBodyPrefetchScheduler();
  });

  it('never re-fetches a body that is already present', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    a.state.emails.set('e1', { id: 'e1', folderId: 'INBOX', uid: 1, rawBody: 'already here' });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.fetched).toEqual([]);
    expect(a.state.unfetchable).toEqual([]);
    svc.stopBodyPrefetchScheduler();
  });

  it('falls back to the legacy unread-only storage API', async () => {
    const a = makeAccount({ seeds: ['e1'], useLegacyApi: true, remaining: 3 });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.seedCalls[0]).toBe(SEED_PER_TICK);
    expect(a.state.fetched).toEqual(['e1']);
    svc.stopBodyPrefetchScheduler();
  });

  it('treats a storage with NEITHER seed API as drained', async () => {
    h.activeStorage = {};
    h.activeEngine = { isConnected: () => true };
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await expect(advance(FIRST_DELAY_MS)).resolves.toBeDefined();
    svc.stopBodyPrefetchScheduler();
  });
});

describe('the give-up guard', () => {
  // A GHOST row: the engine resolves null because the server has no message for
  // that UID. This is the only outcome allowed to end in a `|nobody|` tag.
  const failingAccount = () => {
    const a = makeAccount({ seeds: ['ghost'], remaining: 1 });
    a.state.fetchNulls.add('ghost');
    return a;
  };

  it('marks an email unfetchable only after 3 consecutive failures', async () => {
    const a = failingAccount();
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    expect(a.state.unfetchable).toEqual([]);
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.unfetchable).toEqual([]);
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.unfetchable).toEqual([['ghost']]);
    svc.stopBodyPrefetchScheduler();
  });

  it('resets the counter when a later attempt succeeds', async () => {
    const a = failingAccount();
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    await advance(ACTIVE_INTERVAL_MS);       // 2 failures so far
    a.state.fetchNulls.delete('ghost');
    await advance(ACTIVE_INTERVAL_MS);       // success -> counter cleared
    a.state.fetchNulls.add('ghost');
    await advance(ACTIVE_INTERVAL_MS);       // failure #1 again
    await advance(ACTIVE_INTERVAL_MS);       // #2
    expect(a.state.unfetchable).toEqual([]);
    await advance(ACTIVE_INTERVAL_MS);       // #3 -> given up
    expect(a.state.unfetchable).toEqual([['ghost']]);
    expect(MAX_BODY_FETCH_ATTEMPTS).toBe(3);
    svc.stopBodyPrefetchScheduler();
  });

  // THE REGRESSION. A body fetch that throws — connection blip, rate-limit
  // backoff, auth pause, or our own 35s timeout while the engine still holds the
  // item queued — tells us NOTHING about the message. Counting those as strikes
  // is what silently tagged good Gmail mail `|nobody|` after three blips, and
  // those bodies then never downloaded again for the life of the database.
  it('NEVER gives up on an email whose fetch keeps throwing (transient failure)', async () => {
    const a = makeAccount({ seeds: ['blip'], remaining: 1 });
    a.state.fetchFails.add('blip');            // throws every time
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    // Every fetch throwing is now a "starved" tick, so the cadence backs off
    // (2m/4m/8m…) instead of retrying flat every 60s — advance well past the
    // cap so several ticks still run. The give-up invariant is unchanged.
    for (let i = 0; i < 6; i += 1) await advance(IDLE_INTERVAL_MS);
    expect(a.state.unfetchable).toEqual([]);   // still queued, never abandoned

    // …and it downloads the moment the connection recovers: a reconnect kicks
    // the scheduler with resetBackoff, dropping the throttle back-off so the
    // retry is immediate rather than waiting out the backed-off interval.
    a.state.fetchFails.delete('blip');
    svc.kickBodyPrefetchScheduler({ resetBackoff: true });
    await advance(1_000);
    expect(a.state.fetched).toContain('blip');
    svc.stopBodyPrefetchScheduler();
  });

  // Same reasoning for our own local read failures: an unreadable row or one
  // with no server UID yet is not evidence the SERVER lost the message.
  it('does not give up on an email with no UID, a missing folder or an unreadable row', async () => {
    const a = makeAccount({ seeds: ['nouid', 'nofolder', 'missing'], remaining: 3 });
    a.state.emails.set('nouid', { id: 'nouid', folderId: 'INBOX', uid: null });
    a.state.emails.set('nofolder', { id: 'nofolder', folderId: 'gone', uid: 5 });
    const storage = a.storage as Record<string, unknown>;
    storage.getEmail = async (id: string) =>
      id === 'missing' ? null : a.state.emails.get(id) ?? { id, folderId: 'INBOX', uid: 1 };

    h.activeStorage = storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    await advance(ACTIVE_INTERVAL_MS);
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.unfetchable).toEqual([]);
    svc.stopBodyPrefetchScheduler();
  });

  // The marker is a CACHED VERDICT, so every launch gives those rows one more
  // chance — otherwise a single bad session leaves mail body-less forever with
  // no way back short of editing the database.
  it('clears the persisted un-fetchable markers on start so they are retried', async () => {
    const a = failingAccount();
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    await advance(ACTIVE_INTERVAL_MS);
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.unfetchable).toEqual([['ghost']]);   // genuinely gone → tagged
    svc.stopBodyPrefetchScheduler();

    svc.startBodyPrefetchScheduler();                    // next launch
    expect(a.state.cleared.at(-1)).toBe(1);              // the tag was dropped
    expect(a.state.unfetchable).toEqual([]);
    svc.stopBodyPrefetchScheduler();
  });

  it('starts even when the storage cannot clear its markers', async () => {
    const a = failingAccount();
    (a.storage as Record<string, unknown>).clearBodiesUnfetchable = () => { throw new Error('db closed'); };
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    expect(() => svc.startBodyPrefetchScheduler()).not.toThrow();
    svc.stopBodyPrefetchScheduler();
  });

  it('tolerates a storage that cannot persist the give-up', async () => {
    const a = failingAccount();
    a.state.markThrows = true;
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    await advance(ACTIVE_INTERVAL_MS);
    await expect(advance(ACTIVE_INTERVAL_MS)).resolves.toBeDefined();
    svc.stopBodyPrefetchScheduler();
  });
});

describe('computeNextSeedOffset', () => {
  // The pure rotation decision. If it ever returns 0 for a starved tick, the
  // scheduler goes back to asking for the same stuck head forever and the
  // backlog behind it is never attempted — the "5/80 fetched, 75 retry later"
  // tick repeating against an unmoving 14,000-email backlog.
  it('advances one window when a tick tried bodies and downloaded none', async () => {
    const svc = await load();
    expect(svc.computeNextSeedOffset({ offset: 0, attempted: 80, downloaded: 0 })).toBe(SEED_PER_TICK);
    expect(svc.computeNextSeedOffset({ offset: 80, attempted: 80, downloaded: 0 })).toBe(160);
    // A partial window still counts: 20 rows tried, 20 rows failed, move on.
    expect(svc.computeNextSeedOffset({ offset: 160, attempted: 20, downloaded: 0 })).toBe(240);
  });

  it('snaps back to the newest mail the moment anything downloads', async () => {
    // Newest-first is the product behaviour; rotation is only a rescue. One
    // success proves the head is fetchable again, so the window must reset.
    const svc = await load();
    expect(svc.computeNextSeedOffset({ offset: 240, attempted: 80, downloaded: 1 })).toBe(0);
    expect(svc.computeNextSeedOffset({ offset: 240, attempted: 80, downloaded: 80 })).toBe(0);
  });

  it('resets when there was nothing to try at this offset', async () => {
    // An empty window is not evidence of a stuck head — walking further would
    // just march the offset off the end of a backlog that has already drained.
    const svc = await load();
    expect(svc.computeNextSeedOffset({ offset: 240, attempted: 0, downloaded: 0 })).toBe(0);
    expect(svc.computeNextSeedOffset({ offset: 0, attempted: 0, downloaded: 0 })).toBe(0);
  });
});

describe('seed-window rotation', () => {
  it('rotates past a stuck head, then snaps back once a body downloads', async () => {
    // The end-to-end regression: with a permanently-failing newest 80, the older
    // backlog must still get attempted. Before rotation, s80+ were never fetched.
    const seeds = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const a = makeAccount({
      seeds,
      remaining: 100,                                    // never drained
      fetchFails: new Set(seeds.slice(0, SEED_PER_TICK)), // the head is stuck
    });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    expect(a.state.seedOffsetCalls).toEqual([0]);
    expect(a.state.fetched).toEqual([]);                 // starved

    // Starved → back off 2m, and start the next window past the stuck head.
    await advance(STARVED_BACKOFF_1_MS);
    expect(a.state.seedOffsetCalls).toEqual([0, SEED_PER_TICK]);
    expect(a.state.fetched).toEqual(seeds.slice(SEED_PER_TICK)); // s80..s99 land

    // Progress → active cadence AND back to the newest mail.
    await advance(ACTIVE_INTERVAL_MS);
    expect(a.state.seedOffsetCalls).toEqual([0, SEED_PER_TICK, 0]);
    svc.stopBodyPrefetchScheduler();
  });

  it('wraps to the newest when the rotated window falls off the end of the backlog', async () => {
    // A short backlog rotates past its own end. Reporting that empty window as
    // "drained" would put the account to sleep for 10 minutes with mail still
    // missing bodies, so it must re-read from 0 and keep working.
    const seeds = ['s0', 's1', 's2'];
    const a = makeAccount({ seeds, remaining: 3, fetchFails: new Set(seeds) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    expect(a.state.seedOffsetCalls).toEqual([0]);

    // Offset 80 is past the end → empty → wrapped to 0 in the SAME tick.
    await advance(STARVED_BACKOFF_1_MS);
    expect(a.state.seedOffsetCalls).toEqual([0, SEED_PER_TICK, 0]);
    // …and the tick really ran the wrapped window rather than sleeping on it.
    expect(a.state.siblingCalls).toHaveLength(2);
    svc.stopBodyPrefetchScheduler();
  });

  it('starts a fresh session at the newest mail', async () => {
    // The offsets are an in-session rescue, not persisted state: a restart (or a
    // re-start after stop) must not begin halfway down yesterday's backlog.
    const seeds = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const a = makeAccount({ seeds, remaining: 100, fetchFails: new Set(seeds) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    await advance(STARVED_BACKOFF_1_MS);
    expect(a.state.seedOffsetCalls).toEqual([0, SEED_PER_TICK]);

    svc.stopBodyPrefetchScheduler();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.seedOffsetCalls).toEqual([0, SEED_PER_TICK, 0]);
    svc.stopBodyPrefetchScheduler();
  });

  it('a reconnect kick clears the rotation along with the back-off', async () => {
    // The head may have looked un-fetchable only because the socket was sick.
    // Once the link genuinely returns, the newest mail deserves priority again.
    const seeds = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const a = makeAccount({ seeds, remaining: 100, fetchFails: new Set(seeds) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    expect(a.state.seedOffsetCalls).toEqual([0]);

    a.state.fetchFails.clear();
    svc.kickBodyPrefetchScheduler({ resetBackoff: true });
    await advance(1_000);
    expect(a.state.seedOffsetCalls).toEqual([0, 0]);
    expect(a.state.fetched).toEqual(seeds.slice(0, SEED_PER_TICK));
    svc.stopBodyPrefetchScheduler();
  });

  it('a plain new-mail kick does NOT reset the rotation', async () => {
    // Only a genuine recovery resets. A new-mail kick during a starved streak is
    // ignored outright (it would re-burst into the same throttle), so the
    // rotation it was going to use must survive to the next scheduled tick.
    const seeds = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const a = makeAccount({ seeds, remaining: 100, fetchFails: new Set(seeds) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    svc.kickBodyPrefetchScheduler();
    await advance(2_000);
    expect(a.state.seedOffsetCalls).toEqual([0]);   // kick ignored while starved

    await advance(STARVED_BACKOFF_1_MS);
    expect(a.state.seedOffsetCalls).toEqual([0, SEED_PER_TICK]);
    svc.stopBodyPrefetchScheduler();
  });

  it('rotates each account independently', async () => {
    // Offsets are keyed per account. A stuck Gmail head must not push the other
    // account's window off its own newest mail.
    const stuckSeeds = Array.from({ length: 100 }, (_, i) => `g${i}`);
    const stuck = makeAccount({ seeds: stuckSeeds, remaining: 100, fetchFails: new Set(stuckSeeds) });
    const healthy = makeAccount({ seeds: ['w1'], remaining: 5 });
    h.activeStorage = stuck.storage;
    h.activeEngine = stuck.engine;
    h.runtimes = [['work', { storage: healthy.storage, syncEngine: healthy.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    // One account downloaded, so the tick isn't starved -> active cadence.
    await advance(ACTIVE_INTERVAL_MS);
    expect(stuck.state.seedOffsetCalls).toEqual([0, SEED_PER_TICK]);
    expect(healthy.state.seedOffsetCalls).toEqual([0, 0]);
    svc.stopBodyPrefetchScheduler();
  });
});

describe('multi-account fan-out', () => {
  it('prefetches for the active account and every CONNECTED background account', async () => {
    const active = makeAccount({ seeds: ['a1'] });
    const background = makeAccount({ seeds: ['b1'] });
    const offline = makeAccount({ seeds: ['c1'], connected: false });
    h.activeStorage = active.storage;
    h.activeEngine = active.engine;
    h.runtimes = [
      ['acct-bg', { storage: background.storage, syncEngine: background.engine, smtpClient: null }],
      ['acct-off', { storage: offline.storage, syncEngine: offline.engine, smtpClient: null }],
    ];
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);

    expect(active.state.fetched).toEqual(['a1']);
    expect(background.state.fetched).toEqual(['b1']);
    expect(offline.state.fetched).toEqual([]);
    svc.stopBodyPrefetchScheduler();
  });

  it('never prefetches the same storage twice', async () => {
    const a = makeAccount({ seeds: ['e1'] });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    h.runtimes = [['acct-active', { storage: a.storage, syncEngine: a.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.seedCalls).toHaveLength(1);
    svc.stopBodyPrefetchScheduler();
  });

  it('isolates one account’s failure and keeps the active cadence', async () => {
    const broken = makeAccount({ seeds: ['x'], seedThrows: true });
    const ok = makeAccount({ seeds: ['e1'], remaining: 0 });
    h.activeStorage = broken.storage;
    h.activeEngine = broken.engine;
    h.runtimes = [['acct-ok', { storage: ok.storage, syncEngine: ok.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    expect(ok.state.fetched).toEqual(['e1']);

    // Not "all drained" -> the 60s cadence is kept, not the 10-minute sleep.
    await advance(ACTIVE_INTERVAL_MS);
    expect(ok.state.seedCalls).toHaveLength(2);
    svc.stopBodyPrefetchScheduler();
  });

  it('skips a runtime with no storage', async () => {
    const active = makeAccount({ seeds: ['a1'] });
    h.activeStorage = active.storage;
    h.activeEngine = active.engine;
    h.runtimes = [['acct-empty', { storage: null, syncEngine: active.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await expect(advance(FIRST_DELAY_MS)).resolves.toBeDefined();
    expect(active.state.fetched).toEqual(['a1']);
    svc.stopBodyPrefetchScheduler();
  });
});

// The `|nobody|` tag is the only permanent consequence in this file, so the two
// ways it can be reached wrongly both get a regression test: strikes leaking
// ACROSS accounts, and a retired row that never gets another chance because the
// only reset ran at startup — for an account that connects later, or on a machine
// that simply never restarts.
describe('the give-up guard — account isolation and second chances', () => {
  it('counts strikes PER ACCOUNT, so one account’s ghost cannot retire the other’s live mail', async () => {
    // Email ids are derived from the message, so the same id legitimately exists
    // in two accounts that both received it. With a shared (id-only) counter the
    // two accounts' outcomes mixed: the account that fetched it fine cleared the
    // other's strikes (a ghost that then never retires), and — in the mirror
    // case — a verdict in one account counted toward retiring the row in an
    // account that never failed once.
    const ghosted = makeAccount({ seeds: ['shared'], remaining: 1 });
    ghosted.state.fetchNulls.add('shared');          // server has no such message HERE
    const healthy = makeAccount({ seeds: ['shared'], remaining: 1 }); // same id, fetches fine
    h.activeStorage = ghosted.storage;
    h.activeEngine = ghosted.engine;
    h.runtimes = [['acct-healthy', { storage: healthy.storage, syncEngine: healthy.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBodyPrefetchScheduler();

    await advance(FIRST_DELAY_MS);
    await advance(ACTIVE_INTERVAL_MS);
    expect(ghosted.state.unfetchable).toEqual([]);   // 2 strikes — not yet
    await advance(ACTIVE_INTERVAL_MS);

    expect(ghosted.state.unfetchable).toEqual([['shared']]); // 3 strikes here
    expect(healthy.state.unfetchable).toEqual([]);           // and never there
    expect(healthy.state.fetched.filter((id) => id === 'shared').length).toBeGreaterThan(0);
    svc.stopBodyPrefetchScheduler();
  });

  it('clears the markers of an account that connects AFTER the scheduler started', async () => {
    // Background accounts are registered later, so the start-time sweep never saw
    // them: whatever a previous session retired stayed retired for the whole run,
    // with nothing able to put it back in the backlog.
    const active = makeAccount({ seeds: ['a1'], remaining: 1 });
    h.activeStorage = active.storage;
    h.activeEngine = active.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);

    const late = makeAccount({ seeds: ['b1'], remaining: 1 });
    late.state.unfetchable = [['retired-last-session']];   // what a prior run left tagged
    h.runtimes = [['acct-late', { storage: late.storage, syncEngine: late.engine, smtpClient: null }]];

    await advance(ACTIVE_INTERVAL_MS);
    expect(late.state.cleared).toEqual([1]);               // swept on first sight
    expect(late.state.fetched).toEqual(['b1']);

    // …and only ONCE: re-clearing every tick would undo a give-up the moment it
    // was made, putting dead rows back in the seed forever.
    await advance(ACTIVE_INTERVAL_MS);
    expect(late.state.cleared).toEqual([1]);
    svc.stopBodyPrefetchScheduler();
  });

  it('gives retired rows another chance every few hours once the backlog is drained', async () => {
    // A mail client runs for weeks. With the reset only at startup, a row retired
    // during one bad afternoon was excluded from every backlog query until the app
    // was restarted. Re-trying only while DRAINED means it costs nothing we would
    // otherwise be spending.
    const a = makeAccount({ seeds: [], remaining: 0 });     // nothing to do → drained
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    expect(a.state.cleared).toHaveLength(1);                // the start-time sweep

    await advance(FIRST_DELAY_MS);
    await advance(IDLE_INTERVAL_MS * 3);                    // hours short of the window
    expect(a.state.cleared).toHaveLength(1);

    await advance(RETIRED_RECHECK_MS);
    expect(a.state.cleared).toHaveLength(2);                // re-swept
    svc.stopBodyPrefetchScheduler();
  });

  it('does NOT re-try retired rows while there is still a backlog to fetch', async () => {
    // The re-check must never compete with real work: putting dead rows back into
    // a 14,000-email backlog spends the tick budget on mail we already know is
    // gone, which is exactly what the tag was introduced to stop.
    const a = makeAccount({ seeds: ['e1'], remaining: 500 });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    await advance(RETIRED_RECHECK_MS * 2);

    expect(a.state.cleared).toHaveLength(1);                // start-time sweep only
    svc.stopBodyPrefetchScheduler();
  });
});

/**
 * The tick summary. Regression this whole block guards: a body-prefetch tick
 * used to swallow every per-item failure, so a mailbox whose bodies never
 * downloaded logged "0/18 bodies fetched" and nothing else — no way to tell a
 * saturated queue from a stalled fetch from a server that simply has no body,
 * which are three different bugs with three different fixes. The summary must
 * name the classes, must stay ONE line however big the batch (this path runs
 * 200 bodies a tick — a per-item log here stalls the main thread), and must
 * stay silent when nothing failed.
 */
describe('classifyBodyFetchFailure', () => {
  let svc: Scheduler;
  beforeEach(async () => { svc = await load(); });

  // The two phases want OPPOSITE fixes — fetch fewer at once vs. allow longer —
  // so collapsing them into one "timeout" bucket loses the entire signal.
  it('separates a fetch that never started from one that started and stalled', () => {
    expect(svc.classifyBodyFetchFailure(new FakeTimeoutError('Timeout', 'queued'))).toBe('timeout-queued');
    expect(svc.classifyBodyFetchFailure(new FakeTimeoutError('Timeout', 'running'))).toBe('timeout-running');
  });

  // A single-budget timeout (or a duck-typed one from an older path) has no
  // phase; it must still be recognised as a timeout rather than falling through
  // to its raw message.
  it('labels a phase-less timeout as a plain timeout', () => {
    expect(svc.classifyBodyFetchFailure(new FakeTimeoutError('Timeout'))).toBe('timeout');
    expect(svc.classifyBodyFetchFailure({ isTimeout: true })).toBe('timeout');
  });

  // Auth and rate-limit are the two failures that are NOT about this message —
  // seeing either dominate a tick means stop fetching, not retry harder.
  it('names an auth pause and a rate limit', () => {
    expect(svc.classifyBodyFetchFailure(new Error('Invalid credentials'))).toBe('auth');
    expect(svc.classifyBodyFetchFailure(new Error('Server is over quota'))).toBe('rate-limit');
  });

  // Cardinality guard: without it a 200-body tick of "No message found for UID
  // <n>" produces 200 buckets and the summary is longer than the batch it
  // summarises — i.e. a per-item log wearing an aggregate's name.
  it('collapses the digits out of a message so one fault is one bucket', () => {
    const first = svc.classifyBodyFetchFailure(new Error('No message found for UID 27290'));
    const second = svc.classifyBodyFetchFailure(new Error('No message found for UID 4'));
    expect(first).toBe('No message found for UID N');
    expect(second).toBe(first);
  });

  it('truncates a long message and never yields an empty label', () => {
    expect(svc.classifyBodyFetchFailure(new Error('x'.repeat(200)))).toHaveLength(60);
    expect(svc.classifyBodyFetchFailure(new Error(''))).toBe('Error');
    expect(svc.classifyBodyFetchFailure(undefined)).toBe('unknown');
    expect(svc.classifyBodyFetchFailure('socket hang up')).toBe('socket hang up');
  });
});

describe('formatFailureSummary', () => {
  let svc: Scheduler;
  beforeEach(async () => { svc = await load(); });

  // A healthy tick must not grow a trailing separator with nothing after it.
  it('is empty when nothing failed', () => {
    expect(svc.formatFailureSummary(new Map())).toBe('');
  });

  // Commonest first: the dominant class is the one worth acting on, and ties
  // break on the label so consecutive ticks can be diffed against each other.
  it('ranks by count and breaks ties deterministically', () => {
    expect(svc.formatFailureSummary(new Map([['b', 2], ['a', 2], ['c', 9]])))
      .toBe('c x9, a x2, b x2');
  });

  // The tail is capped so a pathological tick cannot turn one log line into a
  // hundred — the count still says how much was hidden.
  it('caps the classes it names and counts the rest', () => {
    const many = new Map([['a', 6], ['b', 5], ['c', 4], ['d', 3], ['e', 2], ['f', 1]]);
    expect(svc.formatFailureSummary(many)).toBe('a x6, b x5, c x4, d x3, +2 more');
  });
});

describe('the tick summary line', () => {
  const tickLine = (): string => h.logs.find((line) => line.includes('Tick complete')) ?? '';

  const runOneTick = async (a: ReturnType<typeof makeAccount>): Promise<Scheduler> => {
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBodyPrefetchScheduler();
    await advance(FIRST_DELAY_MS);
    await advance(5_000);   // let any per-fetch delay inside the tick settle
    svc.stopBodyPrefetchScheduler();
    return svc;
  };

  // The exact case that started this: bodies that never arrive, with the log
  // saying only "0/N fetched". The class and the elapsed time together say which
  // budget was spent, which is the difference between a fix and a guess.
  it('names the dominant failure class and how long the tick took', async () => {
    const a = makeAccount({ seeds: ['e1', 'e2', 'e3'], remaining: 3, fetchDelayMs: 1000 });
    for (const id of ['e1', 'e2', 'e3']) a.state.fetchErrors.set(id, new FakeTimeoutError('Timeout', 'running'));
    await runOneTick(a);

    expect(tickLine()).toContain('0/3 bodies fetched in 1.0s');
    expect(tickLine()).toContain('timeout-running x3');
  });

  // Mixed causes in one tick must stay distinguishable — a tick that is half
  // rate-limited and half genuinely empty reads as neither if they merge.
  it('keeps distinct causes apart in a single line', async () => {
    const a = makeAccount({ seeds: ['ok', 'slow', 'ghost', 'norow', 'nofolder'], remaining: 4 });
    a.state.fetchErrors.set('slow', new FakeTimeoutError('Timeout', 'queued'));
    a.state.fetchNulls.add('ghost');
    a.state.missingRows.add('norow');
    a.state.emails.set('nofolder', { id: 'nofolder', folderId: 'gone', uid: 5 });
    await runOneTick(a);

    const line = tickLine();
    expect(line).toContain('1/5 bodies fetched');
    for (const reason of ['timeout-queued x1', 'engine-verdict x1', 'row-missing x1', 'folder-missing x1']) {
      expect(line).toContain(reason);
    }
  });

  // Silence when healthy: an unconditional summary would put a dangling marker
  // on every good tick and train everyone to stop reading the line.
  it('adds nothing to a tick where every body landed', async () => {
    const a = makeAccount({ seeds: ['e1', 'e2'] });
    await runOneTick(a);

    expect(tickLine()).toContain('2/2 bodies fetched in 0.0s');
    expect(tickLine()).not.toContain('—');
  });

  // One line per tick, not one per body. 200 bodies all failing the same way is
  // precisely the shape that made per-item logging a main-thread stall.
  it('stays a single line for a full-size failing tick', async () => {
    const seeds = Array.from({ length: SEED_PER_TICK }, (_, i) => `s${i}`);
    const a = makeAccount({ seeds, remaining: SEED_PER_TICK });
    for (const id of seeds) a.state.fetchErrors.set(id, new Error(`Connection ${id} closed`));
    await runOneTick(a);

    expect(tickLine()).toContain(`0/${SEED_PER_TICK} bodies fetched`);
    expect(tickLine()).toContain(`Connection sN closed x${SEED_PER_TICK}`);
    expect(h.logs.filter((line) => line.includes('Connection sN closed'))).toHaveLength(1);
  });
});
