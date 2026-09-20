import type { FolderRecord, ItemReputation, ReputationProvider, ReputationResult } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ blobs: new Map<string, Buffer>(), runtimes: [] as unknown[], sent: [] as unknown[] }));
vi.mock('../../../../electron/shared', () => ({
  getAllAccountRuntimes: () => h.runtimes,
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (c: string, p: unknown) => h.sent.push({ c, p }) } }),
}));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => { throw new Error('the core DB is not opened in tests'); },
  getBlob: (k: string) => h.blobs.get(k) ?? null,
  setBlob: (k: string, v: Buffer) => { h.blobs.set(k, v); },
}));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: vi.fn() }));
vi.mock('../../../../electron/services/oauth-service', () => ({
  listSignedInAccounts: async () => [],
  getValidAccessToken: async () => 'tok',
}));

import {
  REPUTATION_CACHE_TTL_S,
  REPUTATION_CACHE_UNKNOWN_TTL_S,
  ReputationCache,
  getSpamReputationPolicy,
  normalizeSpamReputationPolicy,
  providerForPolicy,
  resetSpamReputationPolicyCache,
  runReputationPass,
  setSpamReputationPolicy,
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
const row = (over: Partial<Row> & { id: string }): Row => ({
  uid: 1, folderId: 'f-inbox', folderPath: 'INBOX', tags: '|INBOX|', fromAddress: 'a@sender.example', replyTo: null,
  originIp: '5.6.7.8', spamScore: 0, spamReasons: '[]', ...over,
});
const folders: FolderRecord[] = [
  { id: 'f-inbox', name: 'INBOX', path: 'INBOX', parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null, totalCount: 0, unreadCount: 0, specialUse: '\\Inbox', subscribed: true, createdAt: T0, updatedAt: T0 },
  { id: 'f-spam', name: 'Spam', path: 'Spam', parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null, totalCount: 0, unreadCount: 0, specialUse: '\\Junk', subscribed: true, createdAt: T0, updatedAt: T0 },
];

/** An in-memory stand-in for the account storage's reputation surface. */
function fakeStorage(rows: Row[], withSpamFolder = true) {
  const pending = new Map(rows.map((r) => [r.id, { ...r }]));
  const stamped: Array<{ id: string; spamScore: number; spamReasons: string; at: number }> = [];
  const updates: Array<{ id: string; tags?: string; folderId?: string }> = [];
  const storage: ReputationStorage = {
    getEmailsPendingReputation: (limit) => [...pending.values()].slice(0, limit),
    countEmailsPendingReputation: () => pending.size,
    applyReputationBatch: (batch, at) => { let n = 0; for (const b of batch) { if (pending.delete(b.id)) { stamped.push({ ...b, at }); n++; } } return n; },
    getFolders: async () => (withSpamFolder ? folders : [folders[0]]),
    updateEmail: async (id, u) => { updates.push({ id, ...u }); },
  };
  return { storage, stamped, updates };
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

beforeEach(() => { h.blobs.clear(); h.runtimes = []; h.sent = []; resetSpamReputationPolicyCache(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('policy', () => {
  it('normalises modes and endpoints, persists, and defaults to the Sarv service with no endpoint', () => {
    expect(normalizeSpamReputationPolicy(null)).toEqual({ mode: 'sarv', endpoint: '' });
    expect(normalizeSpamReputationPolicy({ mode: 'local', endpoint: 'ignored' })).toEqual({ mode: 'local', endpoint: '' });
    expect(normalizeSpamReputationPolicy({ mode: 'sarv', endpoint: 'https://rep.sarv.example/' })).toEqual({ mode: 'sarv', endpoint: 'https://rep.sarv.example' });
    expect(normalizeSpamReputationPolicy({ mode: 'sarv', endpoint: 'http://insecure.example' }).endpoint).toBe(''); // https only
    expect(normalizeSpamReputationPolicy({ mode: 'weird' }).mode).toBe('sarv');
    setSpamReputationPolicy({ mode: 'off' });
    resetSpamReputationPolicyCache();
    expect(getSpamReputationPolicy()).toEqual({ mode: 'off', endpoint: '' });
  });

  // Off is off; Sarv without an address is off too; local and Sarv-with-address build a provider.
  it('builds a provider only for a usable policy', () => {
    expect(providerForPolicy({ mode: 'off', endpoint: '' })).toBeNull();
    expect(providerForPolicy({ mode: 'sarv', endpoint: '' })).toBeNull();
    expect(providerForPolicy({ mode: 'sarv', endpoint: 'https://rep.sarv.example' })?.name).toBe('sarv');
    expect(providerForPolicy({ mode: 'local', endpoint: '' })?.name).toBe('local-dnsbl');
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
    expect(s).toMatchObject({ judged: 0, provider: null, pending: 0 });
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
    };
    const good = fakeStorage([row({ id: 'a' })]);
    const s = await runReputationPass({
      targets: () => [{ storage: bad, engine: null, label: 'bad' }, { storage: good.storage, engine: null, label: 'good' }],
      provider: () => providerOf(answering({})), cache: new ReputationCache(new Database(':memory:')), now: () => T0,
    });
    expect(s.judged).toBe(1);
  });
});
