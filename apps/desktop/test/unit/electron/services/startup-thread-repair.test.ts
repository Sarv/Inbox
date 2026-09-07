import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression tests for the one-time thread re-thread sweep. The bugs this guards:
//   - it never ran for an already-archived account (old design only repaired on a
//     backfill pending->done transition) → existing fragmented threads stayed split;
//   - it was then gated on "backfill complete", so a still-draining folder blocked
//     the repair FOREVER (the reported "still 1 mail separate");
//   - self (owner) must be registered BEFORE the repair so it's owner-aware.
// So it must: run for any connected account regardless of backfill state, set self
// first, be version-gated (once per logic version), and retry on failure.

interface Harness {
  storage: any;
  engine: any;
  accountId: string;
  runtimes: Map<string, { storage: any; syncEngine: any }>;
  meta: Map<string, string>;
  selfEmail: string;
  repairCalls: number;
  repairThrows: boolean;
  selfSetWith: string[][];
  callOrder: string[];
  folders: any[];
  /** Every repairThreading call, tagged by account, with the options it got. */
  repairOptions: Array<{ label: string; sinceCreatedAt?: number }>;
}

let h: Harness;

function freshStorage(label = 'active') {
  return {
    repairThreading: vi.fn(async (opts: { sinceCreatedAt?: number } = {}) => {
      h.callOrder.push('repair');
      h.repairOptions.push({ label, sinceCreatedAt: opts.sinceCreatedAt });
      if (h.repairThrows) throw new Error('repair failed');
      h.repairCalls += 1;
      return { emailsRetargeted: 3, threadsBefore: 6, threadsAfter: 1, iterations: 2 };
    }),
    setSelfAddresses: vi.fn((addrs: string[]) => {
      h.callOrder.push('self');
      h.selfSetWith.push(addrs);
    }),
    getFolders: vi.fn(async () => h.folders),
  };
}

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.storage,
  getSyncEngine: () => h.engine,
  getCurrentAccountId: () => h.accountId,
  getAllAccountRuntimes: () => h.runtimes,
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
}));

vi.mock('../../../../electron/services/core-db', () => ({
  getMeta: (k: string) => h.meta.get(k) ?? null,
  setMeta: (k: string, v: string) => { h.meta.set(k, v); },
}));

vi.mock('../../../../electron/services/accounts-registry', () => ({
  resolveAccountEmail: () => h.selfEmail,
}));

type Svc = typeof import('../../../../electron/services/startup-thread-repair');
const load = async (): Promise<Svc> => { vi.resetModules(); return import('../../../../electron/services/startup-thread-repair'); };
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  const storage = freshStorage();
  h = {
    storage, engine: { isConnected: () => true }, accountId: 'acct-1',
    runtimes: new Map(), meta: new Map(), selfEmail: 'advik.d@sarv.com',
    repairCalls: 0, repairThrows: false, selfSetWith: [], callOrder: [], folders: [],
    repairOptions: [],
  };
});
afterEach(() => { vi.useRealTimers(); });

describe('startup-thread-repair', () => {
  it('re-threads a connected account once when the version is stale, and stamps it', async () => {
    const svc = await load();
    svc.startStartupThreadRepair();
    await advance(45_000);
    expect(h.repairCalls).toBe(1);
    expect(h.meta.get('threading-repair-version:acct-1')).toBe(String(svc.THREADING_REPAIR_VERSION));
  });

  it('registers self (owner) BEFORE repairing so the re-thread is owner-aware', async () => {
    const svc = await load();
    svc.startStartupThreadRepair();
    await advance(45_000);
    expect(h.selfSetWith).toEqual([['advik.d@sarv.com']]);
    expect(h.callOrder).toEqual(['self', 'repair']); // self first
  });

  it('runs regardless of backfill state (no "backfill complete" gate blocking it)', async () => {
    // storage has no folders/backfill info at all — must still repair.
    const svc = await load();
    svc.startStartupThreadRepair();
    await advance(45_000);
    expect(h.repairCalls).toBe(1);
  });

  it('does NOT repair when the version is already current (still sets self for insert-time)', async () => {
    const svc = await load();
    h.meta.set('threading-repair-version:acct-1', String(svc.THREADING_REPAIR_VERSION));
    svc.startStartupThreadRepair();
    await advance(45_000);
    expect(h.repairCalls).toBe(0);
    expect(h.selfSetWith).toEqual([['advik.d@sarv.com']]); // self still registered
  });

  it('retries on a later tick when the repair throws (not stamped, not marked done)', async () => {
    const svc = await load();
    h.repairThrows = true;
    svc.startStartupThreadRepair();
    await advance(45_000);
    expect(h.meta.has('threading-repair-version:acct-1')).toBe(false); // not stamped
    // Recover, next tick succeeds.
    h.repairThrows = false;
    await advance(60_000);
    expect(h.repairCalls).toBe(1);
    expect(h.meta.get('threading-repair-version:acct-1')).toBe(String(svc.THREADING_REPAIR_VERSION));
  });

  it('is idempotent within a session — a successful account is not repaired again', async () => {
    const svc = await load();
    svc.startStartupThreadRepair();
    await advance(45_000);
    await advance(60_000);
    await advance(60_000);
    expect(h.repairCalls).toBe(1);
  });

  it('keeps re-threading while backfill is INCOMPLETE, then stamps once it finishes', async () => {
    const svc = await load();
    h.folders = [{ path: 'INBOX', subscribed: true, backfillComplete: false }]; // still downloading
    svc.startStartupThreadRepair();
    await advance(45_000);
    expect(h.repairCalls).toBe(1);
    expect(h.meta.has('threading-repair-version:acct-1')).toBe(false); // not stamped (incomplete)

    // A tick before the throttle window elapses does NOT re-run.
    await advance(60_000);
    expect(h.repairCalls).toBe(1);

    // After the re-repair interval, it runs again (new mail may have backfilled).
    await advance(10 * 60_000);
    expect(h.repairCalls).toBe(2);
    expect(h.meta.has('threading-repair-version:acct-1')).toBe(false); // still incomplete

    // History finishes → the next run stamps and stops.
    h.folders = [{ path: 'INBOX', subscribed: true, backfillComplete: true }];
    await advance(10 * 60_000);
    expect(h.repairCalls).toBe(3);
    expect(h.meta.get('threading-repair-version:acct-1')).toBe(String(svc.THREADING_REPAIR_VERSION));
    // Now done — no further runs.
    await advance(10 * 60_000);
    expect(h.repairCalls).toBe(3);
  });

  // ---- incremental re-runs ----
  //
  // The repair only stamps its version once the whole history is local, so on a
  // large account it re-runs every 10 minutes forever. Each of those re-runs used
  // to walk the ENTIRE mailbox again — with the resolver's per-row lookup that
  // was a 25-second main-thread freeze, on repeat, which is what made the
  // beachball (and the IMAP timeouts it caused) permanent rather than one-time.
  // The FIRST pass of a session must still be full (the resolver logic changed,
  // so old threads may need re-joining); every pass after it only needs the rows
  // stored since the previous one.

  it('runs the first pass FULL and later passes scoped to what arrived since', async () => {
    const svc = await load();
    h.folders = [{ path: 'INBOX', subscribed: true, backfillComplete: false }]; // keeps re-running
    svc.startStartupThreadRepair();
    await advance(45_000);

    expect(h.repairOptions).toEqual([{ label: 'active', sinceCreatedAt: undefined }]);
    const firstPassAt = Date.now();

    await advance(10 * 60_000);
    expect(h.repairCalls).toBe(2);
    // Window opens 15 min BEFORE the previous pass began: rows stored while that
    // pass was running may have been examined before their parent arrived, and
    // re-examining a slice of overlap is far cheaper than missing them.
    const second = h.repairOptions[1].sinceCreatedAt as number;
    expect(second).toBe(Math.floor(firstPassAt / 1000) - 15 * 60);
    // Seconds, not milliseconds — `created_at` is unixepoch(). A ms value here
    // would be far in the future and silently match NOTHING, i.e. the repair
    // would appear to run while never fixing anything again.
    expect(second).toBeLessThan(Date.now());
  });

  it('goes back to a FULL pass after a failed one', async () => {
    const svc = await load();
    h.repairThrows = true;
    svc.startStartupThreadRepair();
    await advance(45_000);
    expect(h.repairOptions).toEqual([{ label: 'active', sinceCreatedAt: undefined }]);

    // The failed pass may have applied nothing, so its window cannot be trusted
    // as "already done" — the retry must be full, not incremental.
    h.repairThrows = false;
    await advance(60_000);
    expect(h.repairOptions[1]).toEqual({ label: 'active', sinceCreatedAt: undefined });
  });

  it('tracks each account’s window independently', async () => {
    const bg = freshStorage('background');
    h.runtimes.set('acct-2', { storage: bg, syncEngine: { isConnected: () => true } });
    const svc = await load();
    h.folders = [{ path: 'INBOX', subscribed: true, backfillComplete: false }];
    svc.startStartupThreadRepair();
    await advance(45_000);

    // Both accounts start with their OWN full pass — a shared "last repaired"
    // timestamp would let one account's pass shrink the other's first window and
    // permanently skip its old mail.
    expect(h.repairOptions).toEqual([
      { label: 'active', sinceCreatedAt: undefined },
      { label: 'background', sinceCreatedAt: undefined },
    ]);

    await advance(10 * 60_000);
    expect(h.repairOptions.slice(2).every((o) => typeof o.sinceCreatedAt === 'number')).toBe(true);
    expect(h.repairOptions.slice(2).map((o) => o.label)).toEqual(['active', 'background']);
  });

  it('also re-threads connected BACKGROUND accounts', async () => {
    const bg = freshStorage('background');
    h.runtimes.set('acct-2', { storage: bg, syncEngine: { isConnected: () => true } });
    const svc = await load();
    svc.startStartupThreadRepair();
    await advance(45_000);
    expect(h.repairCalls).toBe(2); // active + background
    expect(h.meta.get('threading-repair-version:acct-2')).toBe(String(svc.THREADING_REPAIR_VERSION));
  });
});

// The window marker has to OUTLIVE the process. It used to be this session's
// `lastRepairAt`, so a relaunch believed it had never looked and walked the whole
// mailbox again: measured at ~26s of main-thread work per launch, retargeting 0
// emails, on an account whose backfill never finishes (so the version stamp never
// lands and "once per logic version" never engages). That repeated, needless full
// pass is the multi-second freeze the user sees shortly after every launch.
//
// `h.meta` stands in for `registry_meta` in the core DB, so it persists across a
// `load()` exactly as the real table persists across a relaunch.
describe('startup-thread-repair — the window survives a relaunch', () => {
  /** One app run: fresh module registry, same meta store, repair fires once. */
  async function runOnce(): Promise<Svc> {
    const svc = await load();
    svc.startStartupThreadRepair();
    await advance(45_000);
    svc.stopStartupThreadRepair();
    return svc;
  }

  it('does the FULL pass once, then only the incremental window on later launches', async () => {
    h.folders = [{ path: 'INBOX', subscribed: true, backfillComplete: false }]; // never stamps the version
    await runOnce();
    expect(h.repairOptions).toEqual([{ label: 'active', sinceCreatedAt: undefined }]);
    const firstLaunchAt = Date.now();

    // Second launch: a brand-new process, nothing in memory, meta intact.
    h.storage = freshStorage();
    await advance(60_000);
    await runOnce();

    expect(h.repairCalls).toBe(2);
    expect(h.repairOptions[1].sinceCreatedAt).toBe(Math.floor(firstLaunchAt / 1000) - 15 * 60);

    // Third launch: the window keeps moving forward with each completed pass, so
    // the cost stays proportional to what arrived rather than to the mailbox.
    const secondLaunchAt = Date.now();
    h.storage = freshStorage();
    await advance(60_000);
    await runOnce();
    expect(h.repairOptions[2].sinceCreatedAt).toBe(Math.floor(secondLaunchAt / 1000) - 15 * 60);
  });

  it('a FAILED pass does not move the window — the next launch is still full', async () => {
    h.repairThrows = true;
    await runOnce();
    expect(h.repairOptions).toEqual([{ label: 'active', sinceCreatedAt: undefined }]);

    h.repairThrows = false;
    h.storage = freshStorage();
    await advance(60_000);
    await runOnce();

    // Nothing was proven scanned, so the mailbox must be walked in full — losing
    // mail to a skipped window is far worse than paying for one more pass.
    expect(h.repairOptions[1]).toEqual({ label: 'active', sinceCreatedAt: undefined });
  });

  it('a resolver-version bump expires the window so old mail is re-threaded once', async () => {
    h.folders = [{ path: 'INBOX', subscribed: true, backfillComplete: false }];
    const svc = await runOnce();
    expect(h.repairOptions[0].sinceCreatedAt).toBeUndefined();

    // Simulate the bump: the key carries the version, so the stored watermark for
    // the OLD version can no longer be read — no reset step to forget.
    const stale = [...h.meta.keys()].filter((k) => k.startsWith('threading-repair-scanned-through:'));
    expect(stale).toEqual([`threading-repair-scanned-through:v${svc.THREADING_REPAIR_VERSION}:acct-1`]);
    h.meta.delete(stale[0]);
    h.meta.set('threading-repair-scanned-through:v999:acct-1', String(Math.floor(Date.now() / 1000)));

    h.storage = freshStorage();
    await advance(60_000);
    await runOnce();
    expect(h.repairOptions[1]).toEqual({ label: 'active', sinceCreatedAt: undefined });
  });

  it('keeps each account’s window separate across launches', async () => {
    const bg = freshStorage('background');
    h.runtimes.set('acct-2', { storage: bg, syncEngine: { isConnected: () => true } });
    h.folders = [{ path: 'INBOX', subscribed: true, backfillComplete: false }];
    await runOnce();
    const firstLaunchAt = Date.now();

    // Only the ACTIVE account's window advances if only it succeeded — a shared
    // marker would let one account's pass declare the other's mail already
    // scanned, permanently skipping it.
    h.meta.delete([...h.meta.keys()].find((k) => k.endsWith(':acct-2')) as string);
    h.storage = freshStorage();
    h.runtimes.set('acct-2', { storage: freshStorage('background'), syncEngine: { isConnected: () => true } });
    await advance(60_000);
    await runOnce();

    const second = h.repairOptions.slice(2);
    expect(second.find((o) => o.label === 'active')?.sinceCreatedAt)
      .toBe(Math.floor(firstLaunchAt / 1000) - 15 * 60);
    expect(second.find((o) => o.label === 'background')?.sinceCreatedAt).toBeUndefined();
  });
});
