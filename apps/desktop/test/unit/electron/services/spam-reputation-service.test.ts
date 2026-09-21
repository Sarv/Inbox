import type { FolderRecord, ItemReputation, ReputationProvider, ReputationResult, SenderReport } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  blobs: new Map<string, Buffer>(),
  runtimes: [] as unknown[],
  sent: [] as Array<{ c: string; p: unknown }>,
  coreDb: null as unknown,
  accounts: [] as Array<{ provider: string; email: string }>,
  fetchCalls: [] as Array<{ url: string; init: unknown }>,
  dnsQueries: [] as string[],
  setBlobThrows: false,
  /** When set, the fake Sarv fetch waits on this before answering. */
  fetchGate: null as Promise<void> | null,
}));
vi.mock('../../../../electron/shared', () => ({
  getAllAccountRuntimes: () => h.runtimes,
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (c: string, p: unknown) => h.sent.push({ c, p }) } }),
}));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => { if (!h.coreDb) throw new Error('the core DB is not opened in tests'); return h.coreDb; },
  getBlob: (k: string) => h.blobs.get(k) ?? null,
  setBlob: (k: string, v: Buffer) => { if (h.setBlobThrows) throw new Error('disk full'); h.blobs.set(k, v); },
}));
vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: async (url: string, init: unknown) => { h.fetchCalls.push({ url, init }); if (h.fetchGate) await h.fetchGate; return { ok: true, status: 200, json: async () => ({ ips: [], domains: [] }) }; },
}));
vi.mock('../../../../electron/services/oauth-service', () => ({
  listSignedInAccounts: async () => h.accounts,
  getValidAccessToken: async (_p: string, email: string) => `tok-${email}`,
}));
// The local provider must never hit real DNS from a test: every name is "not listed".
vi.mock('node:dns', () => ({
  promises: { resolve4: async (name: string) => { h.dnsQueries.push(name); throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' }); } },
}));

import {
  REPUTATION_ACTIVE_INTERVAL_MS,
  REPUTATION_CACHE_TTL_S,
  REPUTATION_CACHE_UNKNOWN_TTL_S,
  REPUTATION_FIRST_TICK_MS,
  REPUTATION_IDLE_INTERVAL_MS,
  ReputationCache,
  getReputationCache,
  getSpamReputationPolicy,
  getSpamReputationState,
  kickSpamReputation,
  normalizeSpamReputationPolicy,
  providerForPolicy,
  reportSenderVerdict,
  reportsAllowed,
  resetSpamReputationPolicyCache,
  runReputationPass,
  setSpamReputationPolicy,
  startSpamReputationScheduler,
  stopSpamReputationScheduler,
  type ReputationStorage,
} from '../../../../electron/services/spam-reputation-service';

/**
 * The reputation stage's pass: what it asks, what it caches, what it files.
 *
 * What this protects: this stage changes stored scores after the fact and can
 * move mail on the server. A pass that added points twice on a retried batch,
 * looked up the same campaign IP forty times, filed a message the header
 * stage had already filed (a second server move for a uid that no longer
 * exists), or treated "the provider is down" as a verdict would each be
 * silent — nothing crashes, the mailbox just drifts. Pinned with fakes.
 */
const T0 = 1_760_000_000;
const listedSpam = (list: string): ItemReputation => ({ status: 'listed', hits: [{ list, category: 'spam', detail: `${list} says spam` }] });
const clean: ItemReputation = { status: 'clean', hits: [] };

type Row = ReturnType<ReputationStorage['getEmailsPendingReputation']>[number];
type BodyRow = ReturnType<ReputationStorage['getEmailsPendingLinkReputation']>[number];
const row = (over: Partial<Row> & { id: string }): Row => ({
  uid: 1, folderId: 'f-inbox', folderPath: 'INBOX', tags: '|INBOX|', fromAddress: 'a@sender.example', replyTo: null,
  originIp: '5.6.7.8', spamScore: 0, spamReasons: '[]', spamUserVerdict: null, ...over,
});
const bodyRow = (over: Partial<BodyRow> & { id: string }): BodyRow => ({
  uid: 1, folderId: 'f-inbox', folderPath: 'INBOX', tags: '|INBOX|', fromAddress: 'a@sender.example',
  spamScore: 0, spamReasons: '[]', spamUserVerdict: null, rawBody: '<a href="https://evil.example/login">Sign in</a>', ...over,
});
const folders: FolderRecord[] = [
  { id: 'f-inbox', name: 'INBOX', path: 'INBOX', parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null, totalCount: 0, unreadCount: 0, specialUse: '\\Inbox', subscribed: true, createdAt: T0, updatedAt: T0 },
  { id: 'f-spam', name: 'Spam', path: 'Spam', parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null, totalCount: 0, unreadCount: 0, specialUse: '\\Junk', subscribed: true, createdAt: T0, updatedAt: T0 },
];

/** An in-memory stand-in for the account storage's reputation surface. */
function fakeStorage(rows: Row[], withSpamFolder = true, bodyRows: BodyRow[] = []) {
  const pending = new Map(rows.map((r) => [r.id, { ...r }]));
  const pendingBodies = new Map(bodyRows.map((r) => [r.id, { ...r }]));
  const stamped: Array<{ id: string; spamScore: number; spamReasons: string; at: number }> = [];
  const linkStamped: Array<{ id: string; spamScore: number; spamReasons: string; at: number }> = [];
  const updates: Array<{ id: string; tags?: string; folderId?: string }> = [];
  const storage: ReputationStorage = {
    getEmailsPendingReputation: (limit) => [...pending.values()].slice(0, limit),
    countEmailsPendingReputation: () => pending.size,
    applyReputationBatch: (batch, at) => { let n = 0; for (const b of batch) { if (pending.delete(b.id)) { stamped.push({ ...b, at }); n++; } } return n; },
    getEmailsPendingLinkReputation: (limit) => [...pendingBodies.values()].slice(0, limit),
    countEmailsPendingLinkReputation: () => pendingBodies.size,
    applyLinkReputationBatch: (batch, at) => { let n = 0; for (const b of batch) { if (pendingBodies.delete(b.id)) { linkStamped.push({ ...b, at }); n++; } } return n; },
    getFolders: async () => (withSpamFolder ? folders : [folders[0]]),
    updateEmail: async (id, u) => { updates.push({ id, ...u }); },
  };
  return { storage, stamped, linkStamped, updates };
}
const providerOf = (impl: (q: { ips: string[]; domains: string[] }) => ReputationResult, name = 'test'): ReputationProvider & { calls: Array<{ ips: string[]; domains: string[] }> } => {
  const calls: Array<{ ips: string[]; domains: string[] }> = [];
  return { name, calls, lookup: async (q) => { calls.push(q); return impl(q); } };
};
const answering = (ips: Record<string, ItemReputation>, domains: Record<string, ItemReputation> = {}) =>
  (q: { ips: string[]; domains: string[] }): ReputationResult => ({
    provider: 'test',
    ips: new Map(q.ips.map((ip) => [ip, ips[ip] ?? clean])),
    domains: new Map(q.domains.map((d) => [d, domains[d] ?? clean])),
  });

beforeEach(() => { h.blobs.clear(); h.runtimes = []; h.sent = []; h.accounts = []; h.fetchCalls = []; h.dnsQueries = []; h.setBlobThrows = false; h.fetchGate = null; h.coreDb = new Database(':memory:'); resetSpamReputationPolicyCache(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('policy', () => {
  it('normalises modes and endpoints, persists, and defaults to the Sarv service with no endpoint', () => {
    expect(normalizeSpamReputationPolicy(null)).toEqual({ mode: 'sarv', endpoint: '', reports: false });
    expect(normalizeSpamReputationPolicy({ mode: 'local', endpoint: 'ignored' })).toEqual({ mode: 'local', endpoint: '', reports: false });
    expect(normalizeSpamReputationPolicy({ mode: 'sarv', endpoint: 'https://rep.sarv.example/', reports: true })).toEqual({ mode: 'sarv', endpoint: 'https://rep.sarv.example', reports: true });
    expect(normalizeSpamReputationPolicy({ mode: 'sarv', endpoint: 'http://insecure.example' }).endpoint).toBe(''); // https only
    expect(normalizeSpamReputationPolicy({ mode: 'weird' }).mode).toBe('sarv');
    setSpamReputationPolicy({ mode: 'off' });
    resetSpamReputationPolicyCache();
    expect(getSpamReputationPolicy()).toEqual({ mode: 'off', endpoint: '', reports: false });
  });

  // Off is off; Sarv without an address is off too; local and Sarv-with-address build a provider.
  it('builds a provider only for a usable policy', () => {
    expect(providerForPolicy({ mode: 'off', endpoint: '', reports: false })).toBeNull();
    expect(providerForPolicy({ mode: 'sarv', endpoint: '', reports: false })).toBeNull();
    expect(providerForPolicy({ mode: 'sarv', endpoint: 'https://rep.sarv.example', reports: false })?.name).toBe('sarv');
    expect(providerForPolicy({ mode: 'local', endpoint: '', reports: false })?.name).toBe('local-dnsbl');
  });
});

describe('ReputationCache', () => {
  it('serves a fresh answer, forgets it after its TTL, and gives unknowns a short life', () => {
    const cache = new ReputationCache(new Database(':memory:'));
    cache.set('ip', '5.6.7.8', listedSpam('Spamhaus ZEN'), 'test', T0);
    cache.set('domain', 'x.example', { status: 'unknown', hits: [], note: 'refused' }, 'test', T0);
    expect(cache.get('ip', '5.6.7.8', T0 + REPUTATION_CACHE_TTL_S - 1)).toMatchObject({ status: 'listed' });
    expect(cache.get('ip', '5.6.7.8', T0 + REPUTATION_CACHE_TTL_S + 1)).toBeNull();
    expect(cache.get('domain', 'x.example', T0 + REPUTATION_CACHE_UNKNOWN_TTL_S - 1)).toMatchObject({ status: 'unknown', note: 'refused' });
    expect(cache.get('domain', 'x.example', T0 + REPUTATION_CACHE_UNKNOWN_TTL_S + 1)).toBeNull();
    expect(cache.get('ip', '9.9.9.9', T0)).toBeNull();
    expect(cache.count()).toBe(2);
  });
});

describe('runReputationPass', () => {
  type Engine = { moveToSpam: (folderPath: string, uid: number) => Promise<unknown> };
  const mover = () => vi.fn<[string, number], Promise<unknown>>().mockResolvedValue(undefined);
  const deps = (targets: ReturnType<typeof fakeStorage>[], provider: ReputationProvider | null, engine: Engine | null = null) => ({
    targets: () => targets.map((t, i) => ({ storage: t.storage, engine, label: `acct-${i}` })),
    provider: () => provider,
    cache: new ReputationCache(new Database(':memory:')),
    now: () => T0,
  });

  it('does nothing — and touches no row — when the stage is off', async () => {
    const t = fakeStorage([row({ id: 'a' })]);
    const s = await runReputationPass(deps([t], null));
    expect(s).toMatchObject({ judged: 0, linkJudged: 0, provider: null, pending: 0 });
    expect(t.stamped).toEqual([]);
  });

  it('asks about each distinct IP and domain once, adds the points, and stamps every row', async () => {
    const t = fakeStorage([
      row({ id: 'a', originIp: '5.6.7.8', fromAddress: 'x@camp.example' }),
      row({ id: 'b', originIp: '5.6.7.8', fromAddress: 'y@camp.example', replyTo: 'z@Reply.Example' }),
      row({ id: 'c', originIp: null, fromAddress: 'ok@fine.example', spamScore: 1 }),
    ]);
    const p = providerOf(answering({ '5.6.7.8': { status: 'listed', hits: [{ list: 'Spamhaus ZEN', category: 'policy', detail: 'PBL' }] } }));
    const s = await runReputationPass(deps([t], p));
    expect(p.calls).toEqual([{ ips: ['5.6.7.8'], domains: ['camp.example', 'reply.example', 'fine.example'] }]);
    expect(s).toMatchObject({ judged: 3, scored: 2, filed: 0, pending: 0, provider: 'test' });
    const a = t.stamped.find((x) => x.id === 'a')!;
    expect(a.spamScore).toBe(3); // PBL = 3 points, under the line
    expect(JSON.parse(a.spamReasons)).toEqual([{ id: 'ip-blocklisted', points: 3, detail: expect.stringContaining('5.6.7.8') }]);
    expect(t.stamped.find((x) => x.id === 'c')).toMatchObject({ spamScore: 1, spamReasons: '[]' });
    expect(t.updates).toEqual([]); // nothing crossed the line
  });

  // THE point of the stage: header score 3 + reputation 5 crosses the line →
  // tagged, filed locally, moved on the server. The header stage's reasons
  // are kept, the new one appended.
  it('files a message that crosses the line only because of reputation, locally and on the server', async () => {
    const t = fakeStorage([row({ id: 'a', uid: 42, spamScore: 3, spamReasons: '[{"id":"auth-failed","points":3,"detail":"DMARC failed"}]' })]);
    const engine = { moveToSpam: mover() };
    const s = await runReputationPass(deps([t], providerOf(answering({ '5.6.7.8': listedSpam('SpamCop') })), engine));
    expect(s).toMatchObject({ judged: 1, scored: 1, filed: 1 });
    expect(t.updates).toEqual([{ id: 'a', tags: '|spam|Spam|', folderId: 'f-spam' }]);
    expect(engine.moveToSpam).toHaveBeenCalledWith('INBOX', 42);
    const stamped = t.stamped[0];
    expect(stamped.spamScore).toBe(8);
    expect(JSON.parse(stamped.spamReasons).map((r: { id: string }) => r.id)).toEqual(['auth-failed', 'ip-blocklisted']);
  });

  it('tags but cannot move when the account has no spam folder, and queues no server move', async () => {
    const t = fakeStorage([row({ id: 'a', spamScore: 3 })], false);
    const engine = { moveToSpam: mover() };
    await runReputationPass(deps([t], providerOf(answering({ '5.6.7.8': listedSpam('SpamCop') })), engine));
    expect(t.updates).toEqual([{ id: 'a', tags: '|INBOX|spam|', folderId: 'f-inbox' }]);
    expect(engine.moveToSpam).not.toHaveBeenCalled();
  });

  // The header stage already filed it (score ≥ 5 at insert): the points are
  // still recorded, but there is no second move — the uid is gone from INBOX.
  it('does not file again a message the header stage already filed', async () => {
    const t = fakeStorage([row({ id: 'a', spamScore: 5, tags: '|spam|Spam|', folderId: 'f-spam', folderPath: 'Spam' })]);
    const engine = { moveToSpam: mover() };
    const s = await runReputationPass(deps([t], providerOf(answering({ '5.6.7.8': listedSpam('SpamCop') })), engine));
    expect(s.filed).toBe(0);
    expect(t.updates).toEqual([]);
    expect(engine.moveToSpam).not.toHaveBeenCalled();
    expect(t.stamped[0].spamScore).toBe(10);
  });

  it('serves repeated IPs and domains from the cache instead of asking again', async () => {
    const d = deps([], null);
    const p = providerOf(answering({ '5.6.7.8': listedSpam('SpamCop') }));
    const t1 = fakeStorage([row({ id: 'a' })]);
    await runReputationPass({ ...d, targets: () => [{ storage: t1.storage, engine: null, label: 'x' }], provider: () => p });
    const t2 = fakeStorage([row({ id: 'b' })]);
    await runReputationPass({ ...d, targets: () => [{ storage: t2.storage, engine: null, label: 'x' }], provider: () => p });
    expect(p.calls).toHaveLength(1);
    expect(t2.stamped[0].spamScore).toBe(5); // the cached listing still counted
  });

  // Fail-open, in every form: a provider that says unknown, one that throws,
  // and one that is missing the item. The row is judged once, with no points,
  // and the reason surfaces as a note the Security page can show.
  it('adds no points for unknown answers or a throwing provider, but still judges the rows once', async () => {
    const refused = providerOf((q) => ({ provider: 'test', ips: new Map(q.ips.map((ip) => [ip, { status: 'unknown', hits: [], note: 'Spamhaus refused the query (public resolver or quota)' }])), domains: new Map() }));
    const t = fakeStorage([row({ id: 'a', spamScore: 4 })]);
    const s = await runReputationPass(deps([t], refused));
    expect(s).toMatchObject({ judged: 1, scored: 0, filed: 0, notes: ['Spamhaus refused the query (public resolver or quota)'] });
    expect(t.stamped[0].spamScore).toBe(4);

    const thrower: ReputationProvider = { name: 'broken', lookup: async () => { throw new Error('ECONNRESET'); } };
    const t2 = fakeStorage([row({ id: 'b', spamScore: 4 })]);
    const s2 = await runReputationPass(deps([t2], thrower));
    expect(s2).toMatchObject({ judged: 1, scored: 0, notes: ['Lookup failed: ECONNRESET'] });
    expect(t2.stamped[0].spamScore).toBe(4);
  });

  it('works through every account and reports what is still waiting', async () => {
    const t1 = fakeStorage([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    const t2 = fakeStorage([row({ id: 'd' })]);
    const s = await runReputationPass({ ...deps([t1, t2], providerOf(answering({}))), batch: 2 });
    expect(s.judged).toBe(3); // 2 from the first account (batch), 1 from the second
    expect(s.pending).toBe(1); // the third row of the first account waits for the next pass
  });

  it('isolates a storage that cannot list its rows', async () => {
    const bad: ReputationStorage = {
      ...fakeStorage([]).storage,
      getEmailsPendingReputation: () => { throw new Error('db locked'); },
      countEmailsPendingReputation: () => { throw new Error('db locked'); },
      getEmailsPendingLinkReputation: () => { throw new Error('db locked'); },
      countEmailsPendingLinkReputation: () => { throw new Error('db locked'); },
    };
    const good = fakeStorage([row({ id: 'a' })]);
    const s = await runReputationPass({
      targets: () => [{ storage: bad, engine: null, label: 'bad' }, { storage: good.storage, engine: null, label: 'good' }],
      provider: () => providerOf(answering({})), cache: new ReputationCache(new Database(':memory:')), now: () => T0,
    });
    expect(s.judged).toBe(1);
  });
});

describe('runReputationPass — the body stage (link domains)', () => {
  const deps = (t: ReturnType<typeof fakeStorage>, provider: ReputationProvider, engine: { moveToSpam: (f: string, u: number) => Promise<unknown> } | null = null) => ({
    targets: () => [{ storage: t.storage, engine, label: 'acct' }],
    provider: () => provider,
    cache: new ReputationCache(new Database(':memory:')),
    now: () => T0,
  });
  const phishing: ItemReputation = { status: 'listed', hits: [{ list: 'Spamhaus DBL', category: 'phishing', detail: 'phishing domain' }] };

  // THE classic phish: clean headers, one link to a listed site.
  it('extracts the link domains, looks them up, and files a message that links to a phishing domain', async () => {
    const t = fakeStorage([], true, [bodyRow({ id: 'a', uid: 9, spamScore: 0 })]);
    const p = providerOf(answering({}, { 'evil.example': phishing }));
    const engine = { moveToSpam: vi.fn<[string, number], Promise<unknown>>().mockResolvedValue(undefined) };
    const s = await runReputationPass(deps(t, p, engine));
    expect(p.calls).toEqual([{ ips: [], domains: ['evil.example'] }]);
    expect(s).toMatchObject({ linkJudged: 1, filed: 1, scored: 1, linkPending: 0 });
    expect(t.linkStamped[0].spamScore).toBe(5);
    expect(JSON.parse(t.linkStamped[0].spamReasons)).toEqual([{ id: 'link-blocklisted', points: 5, detail: expect.stringContaining('evil.example') }]);
    expect(t.updates).toEqual([{ id: 'a', tags: '|spam|Spam|', folderId: 'f-spam' }]);
    expect(engine.moveToSpam).toHaveBeenCalledWith('INBOX', 9);
  });

  it("does not look up the sender's own domain among the links, and stamps a link-free body without asking", async () => {
    const t = fakeStorage([], true, [
      bodyRow({ id: 'a', fromAddress: 'news@brand.example', rawBody: '<a href="https://www.brand.example/x">x</a>' }),
      bodyRow({ id: 'b', rawBody: '<p>no links</p>' }),
    ]);
    const p = providerOf(answering({}));
    const s = await runReputationPass(deps(t, p));
    expect(p.calls).toEqual([]);
    expect(s.linkJudged).toBe(2);
  });

  // The two network stages share ONE cap: sender-stage points already on the
  // row leave that much less room for the links.
  it('shares the reputation cap with points the sender stage already added', async () => {
    const t = fakeStorage([], true, [bodyRow({ id: 'a', spamScore: 3, spamReasons: JSON.stringify([{ id: 'ip-blocklisted', points: 3, detail: 'PBL' }]) })]);
    await runReputationPass(deps(t, providerOf(answering({}, { 'evil.example': phishing }))));
    expect(t.linkStamped[0].spamScore).toBe(6); // 3 + min(5, 6 − 3)
  });

  // The user's word outranks the score: points are recorded, nothing is filed.
  it('never files a message the user called not-spam, in either stage', async () => {
    const t = fakeStorage(
      [row({ id: 'h1', spamScore: 3, spamUserVerdict: 'ham' })], true,
      [bodyRow({ id: 'h2', spamScore: 3, spamUserVerdict: 'ham' })],
    );
    const engine = { moveToSpam: vi.fn<[string, number], Promise<unknown>>().mockResolvedValue(undefined) };
    const s = await runReputationPass(deps(t, providerOf(answering({ '5.6.7.8': listedSpam('SpamCop') }, { 'evil.example': phishing })), engine));
    expect(s.filed).toBe(0);
    expect(t.updates).toEqual([]);
    expect(engine.moveToSpam).not.toHaveBeenCalled();
    expect(t.stamped[0].spamScore).toBe(8);
    expect(t.linkStamped[0].spamScore).toBe(8);
  });
});

describe('the report loop', () => {
  it('is allowed only in Sarv mode with an endpoint and the opt-in', () => {
    expect(reportsAllowed({ mode: 'sarv', endpoint: 'https://r.example', reports: true })).toBe(true);
    expect(reportsAllowed({ mode: 'sarv', endpoint: 'https://r.example', reports: false })).toBe(false);
    expect(reportsAllowed({ mode: 'sarv', endpoint: '', reports: true })).toBe(false);
    expect(reportsAllowed({ mode: 'local', endpoint: 'https://r.example', reports: true })).toBe(false);
    expect(normalizeSpamReputationPolicy({ mode: 'sarv', endpoint: 'https://r.example', reports: 'yes' }).reports).toBe(false);
  });

  it('sends the verdict through the provider when allowed, and nothing otherwise', async () => {
    const report = vi.fn<[SenderReport], Promise<boolean>>().mockResolvedValue(true);
    const provider: ReputationProvider = { name: 'sarv', lookup: async () => ({ provider: 'sarv', ips: new Map(), domains: new Map() }), report };
    const verdict: SenderReport = { domain: 'spam.example', ip: '1.2.3.4', verdict: 'spam' };
    reportSenderVerdict(verdict, { policy: { mode: 'sarv', endpoint: 'https://r.example', reports: true }, provider });
    await new Promise((r) => setTimeout(r, 0));
    expect(report).toHaveBeenCalledWith(verdict);
    reportSenderVerdict(verdict, { policy: { mode: 'sarv', endpoint: 'https://r.example', reports: false }, provider });
    reportSenderVerdict(verdict, { policy: { mode: 'local', endpoint: '', reports: true }, provider });
    await new Promise((r) => setTimeout(r, 0));
    expect(report).toHaveBeenCalledTimes(1);
    // A provider without a report channel, or one that rejects, is fine.
    reportSenderVerdict(verdict, { policy: { mode: 'sarv', endpoint: 'https://r.example', reports: true }, provider: { name: 'x', lookup: provider.lookup } });
    reportSenderVerdict(verdict, { policy: { mode: 'sarv', endpoint: 'https://r.example', reports: true }, provider: { ...provider, report: async () => { throw new Error('down'); } } });
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('the real wiring', () => {
  it('the Sarv provider fetches with the first signed-in Sarv account’s bearer, and is unknown with none', async () => {
    const p = providerForPolicy({ mode: 'sarv', endpoint: 'https://rep.sarv.example', reports: false })!;
    let r = await p.lookup({ ips: ['1.2.3.4'], domains: [] });
    expect(r.ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: expect.stringContaining('signed in') });
    expect(h.fetchCalls).toEqual([]);

    h.accounts = [{ provider: 'gmail', email: 'g@gmail.com' }, { provider: 'sarv', email: 'rc@sarv.example' }];
    r = await p.lookup({ ips: ['1.2.3.4'], domains: [] });
    expect(h.fetchCalls[0].url).toBe('https://rep.sarv.example/v1/reputation/lookup');
    expect((h.fetchCalls[0].init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer tok-rc@sarv.example');
    expect(r.ips.get('1.2.3.4')?.status).toBe('unknown'); // the fake service answered for nothing
  });

  it('the local provider queries DNS through node:dns', async () => {
    const p = providerForPolicy({ mode: 'local', endpoint: '', reports: false })!;
    const r = await p.lookup({ ips: ['1.2.3.4'], domains: [] });
    expect(h.dnsQueries).toContain('4.3.2.1.zen.spamhaus.org');
    expect(r.ips.get('1.2.3.4')?.status).toBe('clean');
  });

  it('the shared cache lives on the core DB', () => {
    const cache = getReputationCache();
    cache.set('ip', '9.9.9.9', clean, 'test', T0);
    expect(getReputationCache().get('ip', '9.9.9.9', T0)).toMatchObject({ status: 'clean' });
  });
});

describe('the scheduler', () => {
  afterEach(() => { stopSpamReputationScheduler(); vi.useRealTimers(); });

  it('runs its first pass after the delay over every account, reports progress, and re-arms on the active cadence while rows wait', async () => {
    vi.useFakeTimers();
    setSpamReputationPolicy({ mode: 'local', endpoint: '', reports: false });
    const t = fakeStorage([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    h.runtimes = [['acct-1', { storage: t.storage, syncEngine: { isConnected: () => true, moveToSpam: async () => undefined } }]];

    startSpamReputationScheduler();
    startSpamReputationScheduler(); // idempotent
    expect(getSpamReputationState()).toMatchObject({ running: false, lastRun: null });
    await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS + 10);

    const state = getSpamReputationState();
    expect(state).toMatchObject({ judged: 3, provider: 'local-dnsbl', pending: 0, running: false });
    expect(state.lastRun).not.toBeNull();
    expect(h.sent.some((m) => m.c === 'spam:reputation-progress')).toBe(true);
    expect(t.stamped).toHaveLength(3);
  });

  it('sleeps on the idle cadence when nothing is waiting, and "Run now" pulls the next pass forward', async () => {
    vi.useFakeTimers();
    setSpamReputationPolicy({ mode: 'local', endpoint: '', reports: false });
    const t = fakeStorage([]);
    h.runtimes = [['acct-1', { storage: t.storage, syncEngine: null }]];
    startSpamReputationScheduler();
    await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS + 10);
    const sentAfterFirst = h.sent.length;

    // Nothing pending: the next pass is the IDLE interval away, not the active one.
    await vi.advanceTimersByTimeAsync(REPUTATION_ACTIVE_INTERVAL_MS + 10);
    expect(h.sent.length).toBe(sentAfterFirst);
    kickSpamReputation();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent.length).toBe(sentAfterFirst + 1);
    await vi.advanceTimersByTimeAsync(REPUTATION_IDLE_INTERVAL_MS + 10);
    expect(h.sent.length).toBe(sentAfterFirst + 2);
  });

  it('stops: no further pass fires after stop, and a kick after stop is a no-op', async () => {
    vi.useFakeTimers();
    setSpamReputationPolicy({ mode: 'off', endpoint: '', reports: false });
    startSpamReputationScheduler();
    stopSpamReputationScheduler();
    kickSpamReputation();
    await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS * 2);
    expect(h.sent).toEqual([]);
  });
});

describe('edges', () => {
  it('policy: a non-string or unparseable endpoint is dropped, a corrupt blob means defaults, a failed persist still answers', () => {
    expect(normalizeSpamReputationPolicy({ mode: 'sarv', endpoint: 5 }).endpoint).toBe('');
    expect(normalizeSpamReputationPolicy({ mode: 'sarv', endpoint: 'not a url' }).endpoint).toBe('');
    h.blobs.set('spam-reputation-policy', Buffer.from('{not json'));
    expect(getSpamReputationPolicy()).toEqual({ mode: 'sarv', endpoint: '', reports: false });
    h.setBlobThrows = true;
    expect(setSpamReputationPolicy({ mode: 'local' })).toEqual({ mode: 'local', endpoint: '', reports: false });
  });

  it('cache: a corrupt hits column reads as no hits', () => {
    const db = new Database(':memory:');
    const cache = new ReputationCache(db);
    cache.set('ip', '1.1.1.1', clean, 'test', T0);
    db.prepare("UPDATE reputation_cache SET hits = '{bad' WHERE item = '1.1.1.1'").run();
    expect(cache.get('ip', '1.1.1.1', T0)).toMatchObject({ status: 'clean', hits: [] });
  });

  it('the report loop builds the provider from the policy when none is given, and reaches the service', async () => {
    h.accounts = [{ provider: 'sarv', email: 'rc@sarv.example' }];
    reportSenderVerdict({ domain: 'spam.example', ip: null, verdict: 'spam' }, { policy: { mode: 'sarv', endpoint: 'https://rep.sarv.example', reports: true } });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.fetchCalls.map((c) => c.url)).toEqual(['https://rep.sarv.example/v1/reputation/report']);
  });

  it('a stamping failure is isolated to its account', async () => {
    const t = fakeStorage([row({ id: 'a' })]);
    t.storage.applyReputationBatch = () => { throw new Error('db locked'); };
    const s = await runReputationPass({
      targets: () => [{ storage: t.storage, engine: null, label: 'x' }], provider: () => providerOf(answering({})),
      cache: new ReputationCache(new Database(':memory:')), now: () => T0,
    });
    expect(s.judged).toBe(0);
  });

  it('the scheduler treats a disconnected engine as no engine, and survives a window that is gone', async () => {
    vi.useFakeTimers();
    try {
      setSpamReputationPolicy({ mode: 'local', endpoint: '', reports: false });
      const t = fakeStorage([row({ id: 'a', spamScore: 4 })]);
      h.runtimes = [['acct-1', { storage: t.storage, syncEngine: { isConnected: () => false, moveToSpam: vi.fn() } }]];
      startSpamReputationScheduler();
      await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS + 10);
      expect(getSpamReputationState().judged).toBeGreaterThan(0);
    } finally {
      stopSpamReputationScheduler();
      vi.useRealTimers();
    }
  });
});

describe('more edges', () => {
  const deps = (t: ReturnType<typeof fakeStorage>, provider: ReputationProvider, cache = new ReputationCache(new Database(':memory:'))) => ({
    targets: () => [{ storage: t.storage, engine: null, label: 'acct' }], provider: () => provider, cache, now: () => T0,
  });
  const phishing: ItemReputation = { status: 'listed', hits: [{ list: 'Spamhaus DBL', category: 'phishing', detail: 'phishing domain' }] };

  it('the policy defaults when nothing was ever stored', () => {
    expect(getSpamReputationPolicy()).toEqual({ mode: 'sarv', endpoint: '', reports: false });
  });

  it('the cache keeps user report counts', () => {
    const cache = new ReputationCache(new Database(':memory:'));
    cache.set('domain', 'x.example', { status: 'clean', hits: [], userReports: 7 }, 'sarv', T0);
    expect(cache.get('domain', 'x.example', T0)).toMatchObject({ userReports: 7 });
  });

  it('the body stage serves a link domain from the cache, surfaces an unknown’s note, and survives a throwing provider or stamp', async () => {
    const cache = new ReputationCache(new Database(':memory:'));
    const p = providerOf(answering({}, { 'evil.example': phishing }));
    await runReputationPass(deps(fakeStorage([], true, [bodyRow({ id: 'a' })]), p, cache));
    await runReputationPass(deps(fakeStorage([], true, [bodyRow({ id: 'b' })]), p, cache));
    expect(p.calls).toHaveLength(1); // the second pass hit the cache

    const unknownNote = providerOf((q) => ({ provider: 'test', ips: new Map(), domains: new Map(q.domains.map((d) => [d, { status: 'unknown' as const, hits: [], note: 'URIBL refused the query' }])) }));
    const s1 = await runReputationPass(deps(fakeStorage([], true, [bodyRow({ id: 'c' })]), unknownNote));
    expect(s1.notes).toEqual(['URIBL refused the query']);

    const thrower: ReputationProvider = { name: 'broken', lookup: async () => { throw new Error('ECONNRESET'); } };
    const t = fakeStorage([], true, [bodyRow({ id: 'd' })]);
    const s2 = await runReputationPass(deps(t, thrower));
    expect(s2).toMatchObject({ linkJudged: 1, notes: ['Lookup failed: ECONNRESET'] });

    const t2 = fakeStorage([], true, [bodyRow({ id: 'e' })]);
    t2.storage.applyLinkReputationBatch = () => { throw new Error('db locked'); };
    expect((await runReputationPass(deps(t2, providerOf(answering({}))))).linkJudged).toBe(0);
  });

  // A row the AI categoriser tagged `spam` but the filter never filed: the tag is kept, the row is filed once it crosses.
  it('keeps an existing spam tag when filing, and isolates a failing local update', async () => {
    const t = fakeStorage([row({ id: 'a', spamScore: 3, tags: '|INBOX|spam|' })]);
    await runReputationPass(deps(t, providerOf(answering({ '5.6.7.8': listedSpam('SpamCop') }))));
    expect(t.updates).toEqual([{ id: 'a', tags: '|spam|Spam|', folderId: 'f-spam' }]);

    const failing = fakeStorage([row({ id: 'b', spamScore: 3 })]);
    failing.storage.updateEmail = async () => { throw new Error('db locked'); };
    const s = await runReputationPass(deps(failing, providerOf(answering({ '5.6.7.8': listedSpam('SpamCop') }))));
    expect(s.filed).toBe(0);
    expect(failing.stamped).toHaveLength(1); // scored and stamped all the same
  });

  it('the report loop reads the stored policy when none is given, and stays quiet when the service declines', async () => {
    setSpamReputationPolicy({ mode: 'sarv', endpoint: 'https://rep.sarv.example', reports: true });
    const declined: ReputationProvider = { name: 'sarv', lookup: async () => ({ provider: 'sarv', ips: new Map(), domains: new Map() }), report: async () => false };
    reportSenderVerdict({ domain: 'x.example', ip: null, verdict: 'ham' }, { provider: declined });
    await new Promise((r) => setTimeout(r, 0));
    setSpamReputationPolicy({ mode: 'off', endpoint: '', reports: false });
    const spy: ReputationProvider = { ...declined, report: vi.fn(async () => true) };
    reportSenderVerdict({ domain: 'x.example', ip: null, verdict: 'ham' }, { provider: spy });
    await new Promise((r) => setTimeout(r, 0));
    expect(spy.report).not.toHaveBeenCalled();
  });

  it('the scheduler skips a runtime whose storage predates the stage, logs notes, and does not re-arm after a stop mid-pass', async () => {
    vi.useFakeTimers();
    try {
      setSpamReputationPolicy({ mode: 'sarv', endpoint: 'https://rep.sarv.example', reports: false });
      h.accounts = [{ provider: 'sarv', email: 'rc@sarv.example' }];
      let release!: () => void;
      h.fetchGate = new Promise<void>((r) => { release = r; });
      // The shared cache outlives tests: an IP and domain no other test used, or the pass never reaches the service.
      const t = fakeStorage([row({ id: 'a', originIp: '198.18.7.7', fromAddress: 'x@never-before.example' })]);
      h.runtimes = [
        ['old', { storage: {}, syncEngine: null }],
        ['acct-1', { storage: t.storage, syncEngine: null }],
      ];
      startSpamReputationScheduler();
      await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS + 10);
      expect(getSpamReputationState().running).toBe(true); // waiting on the service
      stopSpamReputationScheduler();
      release();
      await vi.advanceTimersByTimeAsync(10);
      const st = getSpamReputationState();
      expect(st.running).toBe(false);
      expect(st.judged).toBeGreaterThanOrEqual(1);
      expect(st.notes).toContain('No answer for this item');
      const sent = h.sent.length;
      await vi.advanceTimersByTimeAsync(REPUTATION_IDLE_INTERVAL_MS * 2);
      expect(h.sent.length).toBe(sent); // stopped: no further pass
    } finally {
      stopSpamReputationScheduler();
      vi.useRealTimers();
    }
  });
});
