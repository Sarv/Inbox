import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Auth-header backfill — giving already-synced mail a real SPF/DKIM/DMARC verdict.
 *
 * THE incident: 5,768 of 5,872 messages had `auth_status = NULL` because the
 * headers were never stored before, so the whole history showed "Unverified"
 * whatever the server had recorded. The user asked for a backfill.
 *
 * What these pin: verdicts are written only for uids the server actually
 * answered for; a message the server has NO auth header for is finalised (an
 * all-unknown verdict) rather than retried forever; a uid the server did not
 * return stays NULL for the next pass; one account's failure never stops the
 * others; a churning connection is skipped; stop() ends everything.
 */

const h = vi.hoisted(() => ({
  activeStorage: null as unknown,
  activeEngine: null as unknown,
  runtimes: [] as Array<[string, { storage: unknown; syncEngine: unknown; smtpClient: null }]>,
  window: { destroyed: false, sent: [] as Array<{ channel: string; payload: unknown }> },
  unstable: new Set<unknown>(),
  logs: [] as string[],
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.activeStorage,
  getSyncEngine: () => h.activeEngine,
  getAllAccountRuntimes: () => h.runtimes,
  getMainWindow: () => ({
    isDestroyed: () => h.window.destroyed,
    webContents: { send: (channel: string, payload: unknown) => h.window.sent.push({ channel, payload }) },
  }),
}));

vi.mock('../../../../electron/services/connection-health', () => ({
  isConnectionRecentlyUnstable: (engine: unknown) => h.unstable.has(engine),
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: (...a: unknown[]) => { h.logs.push(a.join(' ')); },
    warn: (...a: unknown[]) => { h.logs.push(a.join(' ')); },
    error: () => {}, debug: () => {},
  }),
  // The real parser is exercised in core's own tests; here we only need a
  // stable, recognisable mapping from header text to verdict.
  parseAuthenticationHeaders: (raw: string | undefined) => ({
    spf: raw?.includes('spf=pass') ? 'pass' : 'unknown',
    dkim: raw?.includes('dkim=pass') ? 'pass' : 'unknown',
    dmarc: raw?.includes('dmarc=fail') ? 'fail' : raw?.includes('dmarc=pass') ? 'pass' : 'unknown',
    overall: raw ? (raw.includes('fail') ? 'fail' : 'pass') : 'none',
  }),
}));

type Mod = typeof import('../../../../electron/services/auth-header-backfill');
const load = async (): Promise<Mod> => { vi.resetModules(); return import('../../../../electron/services/auth-header-backfill'); };

interface Row { id: string; uid: number; folderPath: string; authStatus: string | null }

/** A fake account: a backlog of rows and a server that answers for some uids. */
const makeAccount = (rows: Row[], serverHeaders: Record<string, string | undefined | 'MISSING'> = {}) => {
  const state = { rows, fetchCalls: [] as Array<{ folder: string; uids: number[] }>, connected: true, fetchThrows: false, writes: 0 };
  const storage = {
    getEmailsMissingAuthStatus: (limit: number) =>
      state.rows.filter((r) => r.authStatus === null).slice(0, limit).map(({ id, uid, folderPath }) => ({ id, uid, folderPath })),
    countEmailsMissingAuthStatus: () => state.rows.filter((r) => r.authStatus === null).length,
    updateEmailAuthStatusBatch: (batch: Array<{ id: string; authStatus: string }>) => {
      let n = 0;
      for (const b of batch) { const r = state.rows.find((x) => x.id === b.id && x.authStatus === null); if (r) { r.authStatus = b.authStatus; n++; state.writes++; } }
      return n;
    },
  };
  const engine = {
    isConnected: () => state.connected,
    fetchAuthHeaders: async (folder: string, uids: number[]) => {
      state.fetchCalls.push({ folder, uids });
      if (state.fetchThrows) throw new Error('socket reset');
      const m = new Map<number, string | undefined>();
      for (const u of uids) {
        const v = serverHeaders[String(u)];
        if (v === 'MISSING') continue;          // server did not return this uid
        m.set(u, v);                             // undefined = returned, no auth header
      }
      return m;
    },
  };
  return { state, storage, engine };
};

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const FIRST = 45_000;

beforeEach(() => {
  vi.useFakeTimers();
  h.activeStorage = null; h.activeEngine = null; h.runtimes = [];
  h.window = { destroyed: false, sent: [] }; h.unstable = new Set(); h.logs = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('pure helpers', () => {
  it('groups a backlog slice into one UID list per folder', async () => {
    const { groupByFolder } = await load();
    const g = groupByFolder([
      { id: 'a', uid: 1, folderPath: 'INBOX' }, { id: 'b', uid: 2, folderPath: 'Archive' }, { id: 'c', uid: 3, folderPath: 'INBOX' },
    ]);
    expect([...g.keys()]).toEqual(['INBOX', 'Archive']);
    expect(g.get('INBOX')?.map((r) => r.uid)).toEqual([1, 3]);
  });

  // THE distinction the whole backfill rests on. Absent = not answered, keep
  // NULL and retry. Present-but-undefined = answered "no header", finalise.
  it('writes a verdict only for uids the server answered, finalising "no header" as unknown', async () => {
    const { verdictRows } = await load();
    const fetched = new Map<number, string | undefined>([[1, 'spf=pass dkim=pass dmarc=pass'], [2, undefined]]);
    const rows = verdictRows([{ id: 'a', uid: 1 }, { id: 'b', uid: 2 }, { id: 'c', uid: 3 }], fetched);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);            // c (uid 3) stays NULL
    expect(JSON.parse(rows[0].authStatus).overall).toBe('pass');
    expect(JSON.parse(rows[1].authStatus)).toMatchObject({ spf: 'unknown', overall: 'none' });
  });
});

describe('the tick', () => {
  it('backfills the active account and reports progress', async () => {
    const a = makeAccount(
      [{ id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }, { id: 'b', uid: 2, folderPath: 'INBOX', authStatus: null }],
      { '1': 'spf=pass dkim=pass dmarc=pass', '2': 'dmarc=fail' },
    );
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startAuthHeaderBackfill();
    await advance(FIRST + 10);

    expect(a.state.rows.every((r) => r.authStatus !== null)).toBe(true);
    expect(JSON.parse(a.state.rows[1].authStatus!).overall).toBe('fail');
    expect(svc.getAuthBackfillState()).toMatchObject({ done: 2, remaining: 0, drained: true });
    expect(h.window.sent.at(-1)?.channel).toBe('auth-backfill:progress');
  });

  it('issues one fetch per folder, not per message', async () => {
    const a = makeAccount([
      { id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }, { id: 'b', uid: 2, folderPath: 'INBOX', authStatus: null },
      { id: 'c', uid: 9, folderPath: 'Archive', authStatus: null },
    ], { '1': 'spf=pass', '2': 'spf=pass', '9': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startAuthHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toEqual([{ folder: 'INBOX', uids: [1, 2] }, { folder: 'Archive', uids: [9] }]);
  });

  // A uid the server did not return (expunged, or a blip) must not be written
  // — and must still be there for the next pass rather than silently finalised.
  it('leaves a uid the server did not answer for as NULL and retries it', async () => {
    const a = makeAccount(
      [{ id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }, { id: 'gone', uid: 2, folderPath: 'INBOX', authStatus: null }],
      { '1': 'spf=pass', '2': 'MISSING' },
    );
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startAuthHeaderBackfill();
    await advance(FIRST + 10);

    expect(a.state.rows.find((r) => r.id === 'gone')?.authStatus).toBeNull();
    expect(svc.getAuthBackfillState().remaining).toBe(1);
    expect(svc.getAuthBackfillState().drained).toBe(false);
    // …and the next tick asks for it again.
    await advance(1_500 + 10);
    expect(a.state.fetchCalls.filter((c) => c.uids.includes(2))).toHaveLength(2);
  });

  it('skips a churning connection instead of piling on, and comes back', async () => {
    const a = makeAccount([{ id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine; h.unstable.add(a.engine);
    const svc = await load();
    svc.startAuthHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(0);
    expect(svc.getAuthBackfillState().drained).toBe(false);

    h.unstable.clear();
    await advance(1_500 + 10);
    expect(a.state.fetchCalls).toHaveLength(1);
  });

  it('one account failing never stops the others', async () => {
    const bad = makeAccount([{ id: 'x', uid: 1, folderPath: 'INBOX', authStatus: null }]);
    bad.state.fetchThrows = true;
    const good = makeAccount([{ id: 'y', uid: 1, folderPath: 'INBOX', authStatus: null }], { '1': 'spf=pass' });
    h.activeStorage = bad.storage; h.activeEngine = bad.engine;
    h.runtimes = [['acct-b', { storage: good.storage, syncEngine: good.engine, smtpClient: null }]];
    (await load()).startAuthHeaderBackfill();
    await advance(FIRST + 10);

    expect(good.state.rows[0].authStatus).not.toBeNull();
    expect(h.logs.some((l) => l.includes('tick failed (isolated)'))).toBe(true);
  });

  it('does nothing when no account is connected, then picks up once one is', async () => {
    const a = makeAccount([{ id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }], { '1': 'spf=pass' });
    a.state.connected = false;
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startAuthHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(0);
    a.state.connected = true;
    await advance(1_500 + 10);
    expect(a.state.fetchCalls).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('sleeps the long idle interval once drained', async () => {
    const a = makeAccount([{ id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startAuthHeaderBackfill();
    await advance(FIRST + 10);
    const calls = a.state.fetchCalls.length;
    await advance(29 * 60_000);
    expect(a.state.fetchCalls).toHaveLength(calls); // still asleep
  });

  it('kick pulls the next tick forward', async () => {
    const a = makeAccount([{ id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startAuthHeaderBackfill();
    svc.kickAuthHeaderBackfill();
    await advance(300);
    expect(a.state.fetchCalls).toHaveLength(1);
  });

  it('stop() prevents any further tick', async () => {
    const a = makeAccount([{ id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startAuthHeaderBackfill();
    svc.stopAuthHeaderBackfill();
    await advance(FIRST + 60_000);
    expect(a.state.fetchCalls).toHaveLength(0);
  });

  it('start is idempotent', async () => {
    const a = makeAccount([{ id: 'a', uid: 1, folderPath: 'INBOX', authStatus: null }], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startAuthHeaderBackfill(); svc.startAuthHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(1);
  });
});
