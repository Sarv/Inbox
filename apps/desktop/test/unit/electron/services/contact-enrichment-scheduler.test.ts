import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contact enrichment scheduler. It gates real LLM spend, so the locking and
 * rotation rules are the contract:
 *   - ONE batch in flight at a time, and the lock is claimed BEFORE the first
 *     await (a manual trigger racing the interval must not double-dispatch),
 *   - every early-return path releases the lock (a missing window, a failed
 *     candidate query, no eligible contacts) — otherwise the queue starves,
 *   - a renderer that never acks is unblocked by the 1h stale-lock timeout,
 *   - accounts are served ROUND-ROBIN, one per tick, with a quick follow-up
 *     after each ack, and each batch is tagged with its accountId,
 *   - new mail / body-ready fire a DEBOUNCED tick (one per burst),
 *   - stop() cancels the initial, debounce, follow-up and interval timers.
 */

const INITIAL_DELAY_MS = 60_000;
const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_BATCH_TIMEOUT_MS = 60 * 60 * 1000;
const NEW_MAIL_DEBOUNCE_MS = 60_000;
const FOLLOWUP_DELAY_MS = 3_000;
const BATCH_SIZE = 50;
const MIN_AGE_DAYS = 90;

const h = vi.hoisted(() => ({
  activeStorage: null as unknown,
  runtimes: [] as Array<[string, { storage: unknown; syncEngine: unknown; smtpClient: null }]>,
  window: null as { sent: Array<{ channel: string; payload: unknown }> } | null,
  bus: { synced: [] as Array<(e: unknown) => void>, bodyReady: [] as Array<(e: unknown) => void> },
  busThrows: false,
  unsubThrows: false,
  unsubCalls: 0,
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.activeStorage,
  getAllAccountRuntimes: () => h.runtimes,
  getMainWindow: () =>
    h.window
      ? { webContents: { send: (channel: string, payload: unknown) => h.window!.sent.push({ channel, payload }) } }
      : null,
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
  getEventBus: () => ({
    on: (event: string, cb: (e: unknown) => void) => {
      if (h.busThrows) throw new Error('bus unavailable');
      (event === 'email:body-ready' ? h.bus.bodyReady : h.bus.synced).push(cb);
      return () => {
        h.unsubCalls += 1;
        if (h.unsubThrows) throw new Error('unsub failed');
      };
    },
  }),
}));

type Scheduler = typeof import('../../../../electron/services/contact-enrichment-scheduler');

/** Fresh module — the lock, cursor and timers are module state. */
const load = async (): Promise<Scheduler> => {
  vi.resetModules();
  return import('../../../../electron/services/contact-enrichment-scheduler');
};

interface AccountState {
  candidates: string[];
  calls: Array<{ minAgeDays: number; limit: number }>;
  throws: boolean;
}

const makeAccount = (candidates: string[], over: Partial<AccountState> = {}) => {
  const state: AccountState = { candidates, calls: [], throws: false, ...over };
  const storage = {
    getContactEnrichmentCandidates: async (opts: { minAgeDays: number; limit: number }) => {
      state.calls.push(opts);
      if (state.throws) throw new Error('query failed');
      return state.candidates.map((id) => ({ id }));
    },
  };
  return { state, storage };
};

const runtime = (storage: unknown) => ({ storage, syncEngine: {}, smtpClient: null });
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const dispatched = () => h.window!.sent.filter((s) => s.channel === 'contact-enrichment:run-batch');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 5, 15, 12, 0, 0));
  h.activeStorage = null;
  h.runtimes = [];
  h.window = { sent: [] };
  h.bus.synced = [];
  h.bus.bodyReady = [];
  h.busThrows = false;
  h.unsubThrows = false;
  h.unsubCalls = 0;
});

afterEach(() => { vi.useRealTimers(); });

describe('start / stop', () => {
  it('dispatches its first batch a minute after start, then every 6 hours', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();

    svc.startContactEnrichmentScheduler();
    await advance(INITIAL_DELAY_MS - 1);
    expect(dispatched()).toHaveLength(0);

    await advance(1);
    expect(dispatched()).toHaveLength(1);

    // While that batch is in flight nothing else dispatches.
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(0);
    expect(dispatched()).toHaveLength(1);

    // Ack with nothing left -> the follow-up finds no work and goes idle.
    a.state.candidates = [];
    svc.reportBatchDone();
    await advance(FOLLOWUP_DELAY_MS);
    expect(dispatched()).toHaveLength(1);

    // The 6h interval keeps ticking.
    a.state.candidates = ['c2'];
    await advance(TICK_INTERVAL_MS);
    expect(dispatched()).toHaveLength(2);
    svc.stopContactEnrichmentScheduler();
  });

  it('is idempotent', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    svc.startContactEnrichmentScheduler();
    svc.startContactEnrichmentScheduler();
    await advance(INITIAL_DELAY_MS);
    expect(dispatched()).toHaveLength(1);
    svc.stopContactEnrichmentScheduler();
  });

  it('stop() cancels the pending FIRST tick (fast quit)', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    svc.startContactEnrichmentScheduler();
    svc.stopContactEnrichmentScheduler();
    await advance(INITIAL_DELAY_MS + TICK_INTERVAL_MS);
    expect(dispatched()).toHaveLength(0);
    // Both event subscriptions (email:synced + email:body-ready) are released.
    expect(h.unsubCalls).toBe(2);
  });

  it('stop() cancels a pending debounce and follow-up too', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    svc.startContactEnrichmentScheduler();

    h.bus.synced[0]({ isNew: true });      // arms the debounce
    await advance(INITIAL_DELAY_MS);        // first dispatch
    svc.reportBatchDone();                  // arms the follow-up
    svc.stopContactEnrichmentScheduler();

    const before = dispatched().length;
    await advance(NEW_MAIL_DEBOUNCE_MS + FOLLOWUP_DELAY_MS + TICK_INTERVAL_MS);
    expect(dispatched()).toHaveLength(before);
  });

  it('starts even when the event bus refuses the subscription', async () => {
    h.busThrows = true;
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    expect(() => svc.startContactEnrichmentScheduler()).not.toThrow();
    await advance(INITIAL_DELAY_MS);
    expect(dispatched()).toHaveLength(1);
    svc.stopContactEnrichmentScheduler();
  });

  it('tolerates unsubscribers that throw, and a double stop', async () => {
    h.unsubThrows = true;
    const svc = await load();
    svc.startContactEnrichmentScheduler();
    expect(() => svc.stopContactEnrichmentScheduler()).not.toThrow();
    expect(() => svc.stopContactEnrichmentScheduler()).not.toThrow();
  });
});

describe('the dispatched batch', () => {
  it('asks for 50 candidates on the 90-day cadence and sends their ids', async () => {
    const a = makeAccount(['c1', 'c2', 'c3']);
    h.activeStorage = a.storage;
    const svc = await load();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(3);

    expect(a.state.calls[0]).toEqual({ minAgeDays: MIN_AGE_DAYS, limit: BATCH_SIZE });
    expect(dispatched()[0].payload).toEqual({ contactIds: ['c1', 'c2', 'c3'], accountId: undefined });
  });

  it('tags the batch with the owning accountId for a multi-account install', async () => {
    const a = makeAccount([]);
    const b = makeAccount(['b1']);
    h.runtimes = [['acct-a', runtime(a.storage)], ['acct-b', runtime(b.storage)]];
    const svc = await load();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
    expect(dispatched()[0].payload).toEqual({ contactIds: ['b1'], accountId: 'acct-b' });
  });
});

describe('the single-batch lock', () => {
  it('a second tick while a batch is in flight dispatches nothing', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(0);
    expect(dispatched()).toHaveLength(1);
  });

  it('overlapping ticks cannot BOTH dispatch (the lock is claimed before the first await)', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    const [first, second] = await Promise.all([svc.triggerEnrichmentNow(), svc.triggerEnrichmentNow()]);
    expect([first, second].sort()).toEqual([0, 1]);
    expect(dispatched()).toHaveLength(1);
  });

  it('the ack releases the lock', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    await svc.triggerEnrichmentNow();
    svc.reportBatchDone();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
  });

  it('an ack with no batch in flight is ignored (no stray follow-up)', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    svc.reportBatchDone();
    await advance(FOLLOWUP_DELAY_MS * 2);
    expect(dispatched()).toHaveLength(0);
  });

  it('a crashed renderer is unblocked by the 1h stale-lock timeout', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    await svc.triggerEnrichmentNow();

    vi.setSystemTime(Date.now() + STALE_BATCH_TIMEOUT_MS - 1);
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(0);

    vi.setSystemTime(Date.now() + 2);
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
    expect(dispatched()).toHaveLength(2);
  });

  it('RELEASES the lock when there is no window to dispatch to', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    h.window = null;
    const svc = await load();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(0);

    // Not stuck: once the window exists the next tick dispatches.
    h.window = { sent: [] };
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
  });

  it('RELEASES the lock when no account has eligible contacts', async () => {
    const a = makeAccount([]);
    h.activeStorage = a.storage;
    const svc = await load();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(0);

    a.state.candidates = ['c1'];
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
  });

  it('RELEASES the lock when there is no storage at all', async () => {
    const svc = await load();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(0);
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
  });

  it('skips (and does not wedge on) an account whose candidate query fails', async () => {
    const broken = makeAccount(['x'], { throws: true });
    const ok = makeAccount(['c1']);
    h.runtimes = [['acct-broken', runtime(broken.storage)], ['acct-ok', runtime(ok.storage)]];
    const svc = await load();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
    expect(dispatched()[0].payload).toMatchObject({ accountId: 'acct-ok' });
  });

  it('skips a runtime with no storage', async () => {
    const ok = makeAccount(['c1']);
    h.runtimes = [['acct-empty', runtime(null)], ['acct-ok', runtime(ok.storage)]];
    const svc = await load();
    await expect(svc.triggerEnrichmentNow()).resolves.toBe(1);
  });
});

describe('round-robin rotation', () => {
  it('serves ONE account per tick and advances the cursor', async () => {
    const a = makeAccount(['a1']);
    const b = makeAccount(['b1']);
    const c = makeAccount(['c1']);
    h.runtimes = [['acct-a', runtime(a.storage)], ['acct-b', runtime(b.storage)], ['acct-c', runtime(c.storage)]];
    const svc = await load();

    for (const expected of ['acct-a', 'acct-b', 'acct-c', 'acct-a']) {
      await svc.triggerEnrichmentNow();
      expect(dispatched()[dispatched().length - 1].payload).toMatchObject({ accountId: expected });
      svc.reportBatchDone();
    }
  });

  it('a batch ack quickly serves the NEXT account with work', async () => {
    const a = makeAccount(['a1']);
    const b = makeAccount(['b1']);
    h.runtimes = [['acct-a', runtime(a.storage)], ['acct-b', runtime(b.storage)]];
    const svc = await load();
    svc.startContactEnrichmentScheduler();
    await advance(INITIAL_DELAY_MS);
    expect(dispatched()[0].payload).toMatchObject({ accountId: 'acct-a' });

    svc.reportBatchDone();
    await advance(FOLLOWUP_DELAY_MS);
    expect(dispatched()[1].payload).toMatchObject({ accountId: 'acct-b' });

    // Nothing left -> the follow-up chain converges to idle.
    a.state.candidates = [];
    b.state.candidates = [];
    svc.reportBatchDone();
    await advance(FOLLOWUP_DELAY_MS * 5);
    expect(dispatched()).toHaveLength(2);
    svc.stopContactEnrichmentScheduler();
  });

  it('only ONE follow-up is armed at a time', async () => {
    const a = makeAccount(['a1']);
    h.activeStorage = a.storage;
    const svc = await load();
    await svc.triggerEnrichmentNow();
    svc.reportBatchDone();
    svc.reportBatchDone(); // no batch in flight -> ignored
    await advance(FOLLOWUP_DELAY_MS);
    expect(dispatched()).toHaveLength(2);
  });
});

describe('the new-mail trigger', () => {
  it('debounces a burst of arriving mail into ONE tick', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    svc.startContactEnrichmentScheduler();

    for (let i = 0; i < 20; i += 1) h.bus.synced[0]({ isNew: true });
    await advance(NEW_MAIL_DEBOUNCE_MS);
    expect(dispatched()).toHaveLength(1);
    svc.stopContactEnrichmentScheduler();
  });

  it('ignores a sync event that is not new mail', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    svc.startContactEnrichmentScheduler();
    h.bus.synced[0]({ isNew: false });
    h.bus.synced[0](undefined);
    await advance(NEW_MAIL_DEBOUNCE_MS - 1);
    expect(dispatched()).toHaveLength(0);
    svc.stopContactEnrichmentScheduler();
  });

  it('also triggers when a BODY lands (the signature only exists then)', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    svc.startContactEnrichmentScheduler();
    h.bus.bodyReady[0]({ emailId: 'e1' });
    await advance(NEW_MAIL_DEBOUNCE_MS);
    expect(dispatched()).toHaveLength(1);
    svc.stopContactEnrichmentScheduler();
  });

  it('does not arm the debounce while a batch is in flight', async () => {
    const a = makeAccount(['c1']);
    h.activeStorage = a.storage;
    const svc = await load();
    svc.startContactEnrichmentScheduler();
    await svc.triggerEnrichmentNow();          // batch in flight

    h.bus.synced[0]({ isNew: true });
    await advance(NEW_MAIL_DEBOUNCE_MS * 2);
    expect(dispatched()).toHaveLength(1);
    svc.stopContactEnrichmentScheduler();
  });
});

describe('reportContactEnrichmentProgress', () => {
  it('accepts both an ok and a skipped contact without throwing', async () => {
    const svc = await load();
    expect(() => svc.reportContactEnrichmentProgress({ contactId: 'c1', ok: true })).not.toThrow();
    expect(() => svc.reportContactEnrichmentProgress({ contactId: 'c2', ok: false, reason: 'no signals' })).not.toThrow();
    expect(() => svc.reportContactEnrichmentProgress({ contactId: 'c3', ok: false })).not.toThrow();
  });
});
