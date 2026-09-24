import type { DomainAgeLookup } from '@sarv-in/mailguard';
import { ReputationStage, type FolderRecord, type ItemReputation, type ReputationProvider, type ReputationResult } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  settingsUnreadable: false,
  runtimes: [] as unknown[],
  sent: [] as Array<{ c: string; p: unknown }>,
  coreDb: null as unknown,
  accounts: [] as Array<{ provider: string; email: string }>,
  fetchCalls: [] as Array<{ url: string; init: unknown }>,
  dnsQueries: [] as string[],
  /** When set, the fake Sarv fetch waits on this before answering. */
  fetchGate: null as Promise<void> | null,
  /** RDAP answers by URL for the domain-age wiring. IANA's bootstrap defaults to an empty registry: every TLD unsupported, nothing scored. */
  rdap: {} as Record<string, { status: number; body: string }>,
}));
vi.mock('../../../../electron/shared', () => ({
  getAllAccountRuntimes: () => h.runtimes,
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (c: string, p: unknown) => h.sent.push({ c, p }) } }),
}));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => { if (!h.coreDb) throw new Error('the core DB is not opened in tests'); return h.coreDb; },
  readAppSetting: (key: string) => {
    if (h.settingsUnreadable) throw new Error('file is not a database');
    return h.settings.get(key) ?? null;
  },
}));
vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: async (url: string, init: unknown) => {
    h.fetchCalls.push({ url, init });
    if (h.fetchGate) await h.fetchGate;
    const rdap = h.rdap[url] ?? (url === 'https://data.iana.org/rdap/dns.json' ? { status: 200, body: '{"services":[]}' } : undefined);
    if (rdap) {
      const bytes = new TextEncoder().encode(rdap.body);
      return {
        ok: rdap.status < 400, status: rdap.status, url,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(bytes.length) : name.toLowerCase() === 'content-type' ? 'application/rdap+json' : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        json: async () => JSON.parse(rdap.body),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ips: [], domains: [] }) };
  },
}));
vi.mock('../../../../electron/services/oauth-service', () => ({
  listSignedInAccounts: async () => h.accounts,
  getValidAccessToken: async (_p: string, email: string) => `tok-${email}`,
}));
// The blocklist stage the scheduler builds must never hit real DNS from a test: every name is "not listed".
vi.mock('node:dns', () => ({
  promises: {
    Resolver: class {
      setServers(): void {}
      async resolve4(name: string): Promise<string[]> {
        h.dnsQueries.push(name);
        throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
      }
    },
  },
}));

import {
  DEFAULT_REPUTATION_SETTINGS,
  ReputationCache,
  SETTINGS_KEY,
  noteAppSettingChanged,
  resetReputationForTests,
  type ReputationSettings,
} from '../../../../electron/services/reputation-service';
import {
  REPUTATION_ACTIVE_INTERVAL_MS,
  BODY_BATCH_SIZE,
  REPUTATION_FIRST_TICK_MS,
  REPUTATION_IDLE_INTERVAL_MS,
  DomainAgeCache,
  DOMAIN_AGE_CACHE_ERROR_TTL_S,
  DOMAIN_AGE_CACHE_TTL_S,
  ageSourceForSettings,
  resetRdapBootstrapCache,
  type AgeSource,
  getSpamReputationState,
  kickSpamReputation,
  runReputationPass,
  startSpamReputationScheduler,
  stopSpamReputationScheduler,
  type LinkLookup,
  type ReputationStorage,
} from '../../../../electron/services/spam-reputation-service';

/**
 * The background reputation pass: what it asks, what it caches, what it files.
 *
 * What this protects: this pass changes stored scores after the fact and can
 * move mail on the server. A pass that added points twice on a retried batch,
 * looked up the same campaign domain forty times, filed a message the header
 * stage had already filed (a second server move for a uid that no longer
 * exists), treated "the provider is down" as a verdict — or asked the
 * blocklists about a SENDER again, a second time after the ingest check did,
 * and charged the same listing twice — would each be silent: nothing crashes,
 * the mailbox just drifts. Pinned with fakes.
 *
 * The pass asks about two things now: the domains a body links to (through
 * the one blocklist stage, when the user opted in) and how recently domains
 * were registered. The sender is asked about once, as mail arrives — see
 * reputation-service.test.ts.
 */
const T0 = 1_760_000_000;
const clean: ItemReputation = { status: 'clean', hits: [] };
const phishing: ItemReputation = { status: 'listed', hits: [{ list: 'Spamhaus DBL', category: 'phishing', detail: 'phishing domain' }] };

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
/** The one blocklist stage over a fake provider and a real (in-memory) cache — what the pass is handed in the app. */
const stageOf = (provider: ReputationProvider, cache = new ReputationCache(new Database(':memory:'))): LinkLookup =>
  new ReputationStage(provider, cache, { now: () => T0 * 1000 });

// ---- Domain age fakes
const dated = (domain: string, ageDays: number, over: Partial<DomainAgeLookup> = {}): DomainAgeLookup => ({
  domain, status: 'ok', registered: T0 - ageDays * 86_400, ageDays, registrar: null, server: 'https://rdap.example/', detail: null, ...over,
});
const unsupported = (domain: string): DomainAgeLookup => ({ domain, status: 'unsupported', registered: null, ageDays: null, registrar: null, server: null, detail: 'No RDAP service is published for .example' });
const sourceOf = (table: Record<string, DomainAgeLookup | Error>, over: Partial<AgeSource> = {}) => {
  const calls: string[] = [];
  const cache = over.cache ?? new DomainAgeCache(new Database(':memory:'));
  const source: AgeSource = {
    cache,
    lookup: async (domain) => { calls.push(domain); const answer = table[domain]; if (answer instanceof Error) throw answer; return answer ?? unsupported(domain); },
    ...over,
  };
  return { calls, cache, source };
};
/** A sender domain registered today: the most domain age can add, which is what makes it a filing trigger here. */
const brandNew = (domain = 'sender.example') => sourceOf({ [domain]: dated(domain, 0) });

const store = (settings: Partial<ReputationSettings>): void => {
  h.settings.set(SETTINGS_KEY, JSON.stringify({ reputation: { ...DEFAULT_REPUTATION_SETTINGS, ...settings, chosen: true } }));
};

beforeEach(() => {
  resetReputationForTests();
  h.settings.clear(); h.settingsUnreadable = false; h.runtimes = []; h.sent = []; h.accounts = []; h.fetchCalls = []; h.dnsQueries = [];
  h.fetchGate = null; h.rdap = {}; h.coreDb = new Database(':memory:');
  resetRdapBootstrapCache();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('runReputationPass — the sender stage', () => {
  type Engine = { moveToSpam: (folderPath: string, uid: number) => Promise<unknown> };
  const mover = () => vi.fn<(folder: string, uid: number) => Promise<unknown>>().mockResolvedValue(undefined);
  const deps = (targets: ReturnType<typeof fakeStorage>[], age: AgeSource | null, engine: Engine | null = null, links: LinkLookup | null = null) => ({
    targets: () => targets.map((t, i) => ({ storage: t.storage, engine, label: `acct-${i}` })),
    links: () => links,
    age: () => age,
    now: () => T0,
  });

  it('does nothing — and touches no row — when neither link lookups nor domain age are on', async () => {
    const t = fakeStorage([row({ id: 'a' })], true, [bodyRow({ id: 'b' })]);
    const s = await runReputationPass(deps([t], null));
    expect(s).toMatchObject({ judged: 0, linkJudged: 0, linkProvider: null, domainAge: false, pending: 0 });
    expect(t.stamped).toEqual([]);
    expect(t.linkStamped).toEqual([]);
  });

  // THE regression this pass was rebuilt for. The ingest check asks the
  // blocklists about the sender as the message arrives; asking again here
  // was a second copy with its own cache, and it charged the same listing
  // twice until a guard stopped it. The sender stage asks the registry about
  // each distinct domain once, and never the blocklists.
  it('never asks the blocklists about the sender, and asks the registry once per distinct sender domain', async () => {
    const t = fakeStorage([
      row({ id: 'a', originIp: '5.6.7.8', fromAddress: 'x@camp.example' }),
      row({ id: 'b', originIp: '5.6.7.8', fromAddress: 'y@camp.example', replyTo: 'z@Reply.Example' }),
      row({ id: 'c', originIp: null, fromAddress: 'ok@fine.example', spamScore: 1 }),
    ]);
    const p = providerOf(answering({ '5.6.7.8': phishing }));
    const { calls, source } = sourceOf({ 'camp.example': dated('camp.example', 2) });
    const s = await runReputationPass(deps([t], source, null, stageOf(p)));
    expect(p.calls).toEqual([]);
    expect(calls.sort()).toEqual(['camp.example', 'fine.example', 'reply.example']);
    expect(s).toMatchObject({ judged: 3, scored: 2, filed: 0, pending: 0, linkProvider: 'test', domainAge: true });
    expect(JSON.parse(t.stamped.find((x) => x.id === 'a')!.spamReasons).map((r: { id: string }) => r.id)).toEqual(['reputation-domain-new']);
    expect(t.stamped.find((x) => x.id === 'c')).toMatchObject({ spamScore: 1, spamReasons: '[]' });
  });

  // A row the ingest check already charged keeps that one charge: the pass
  // adds nothing about the same listing, whatever the provider now says.
  it('leaves a listing the ingest check charged exactly as it was', async () => {
    const stored = JSON.stringify([{ id: 'reputation-ip-listed', points: 3, detail: 'The sending address 5.6.7.8 is listed by Spamhaus ZEN (PBL).' }]);
    const t = fakeStorage([row({ id: 'a', originIp: '5.6.7.8', fromAddress: 'x@listed.example', spamScore: 3, spamReasons: stored })]);
    const p = providerOf(answering({ '5.6.7.8': { status: 'listed', hits: [{ list: 'Spamhaus ZEN', category: 'policy', detail: 'PBL' }] } }));
    await runReputationPass(deps([t], sourceOf({}).source, null, stageOf(p)));
    expect(p.calls).toEqual([]);
    expect(t.stamped[0]).toMatchObject({ spamScore: 3, spamReasons: stored });
    expect(t.updates).toEqual([]);
  });

  // THE point of filing here: header score 3 + a sender domain registered
  // today (3) crosses the line → tagged, filed locally, moved on the server.
  // The header stage's reasons are kept, the new one appended.
  it('files a message that crosses the line only now, locally and on the server', async () => {
    const t = fakeStorage([row({ id: 'a', uid: 42, spamScore: 3, spamReasons: '[{"id":"auth-failed","points":3,"detail":"DMARC failed"}]' })]);
    const engine = { moveToSpam: mover() };
    const s = await runReputationPass(deps([t], brandNew().source, engine));
    expect(s).toMatchObject({ judged: 1, scored: 1, filed: 1 });
    expect(t.updates).toEqual([{ id: 'a', tags: '|spam|Spam|', folderId: 'f-spam' }]);
    expect(engine.moveToSpam).toHaveBeenCalledWith('INBOX', 42);
    const stamped = t.stamped[0];
    expect(stamped.spamScore).toBe(6);
    expect(JSON.parse(stamped.spamReasons).map((r: { id: string }) => r.id)).toEqual(['auth-failed', 'reputation-domain-new']);
  });

  it('tags but cannot move when the account has no spam folder, and queues no server move', async () => {
    const t = fakeStorage([row({ id: 'a', spamScore: 3 })], false);
    const engine = { moveToSpam: mover() };
    await runReputationPass(deps([t], brandNew().source, engine));
    expect(t.updates).toEqual([{ id: 'a', tags: '|INBOX|spam|', folderId: 'f-inbox' }]);
    expect(engine.moveToSpam).not.toHaveBeenCalled();
  });

  // The header stage already filed it (score ≥ 5 at insert): the points are
  // still recorded, but there is no second move — the uid is gone from INBOX.
  it('does not file again a message the header stage already filed', async () => {
    const t = fakeStorage([row({ id: 'a', spamScore: 5, tags: '|spam|Spam|', folderId: 'f-spam', folderPath: 'Spam' })]);
    const engine = { moveToSpam: mover() };
    const s = await runReputationPass(deps([t], brandNew().source, engine));
    expect(s.filed).toBe(0);
    expect(t.updates).toEqual([]);
    expect(engine.moveToSpam).not.toHaveBeenCalled();
    expect(t.stamped[0].spamScore).toBe(8);
  });

  // With registration dates off there is nothing to judge a sender row by:
  // it is left waiting rather than stamped, so switching them on later still
  // reaches it — and it is not counted as waiting on a check that is off.
  it('leaves sender rows alone when domain age is off, even with link lookups on', async () => {
    const t = fakeStorage([row({ id: 'a' })]);
    const s = await runReputationPass(deps([t], null, null, stageOf(providerOf(answering({})))));
    expect(t.stamped).toEqual([]);
    expect(s).toMatchObject({ judged: 0, pending: 0, linkProvider: 'test', domainAge: false });
  });

  it('works through every account and reports what is still waiting', async () => {
    const t1 = fakeStorage([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    const t2 = fakeStorage([row({ id: 'd' })]);
    const s = await runReputationPass({ ...deps([t1, t2], sourceOf({}).source), batch: 2 });
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
      links: () => null, age: () => sourceOf({}).source, now: () => T0,
    });
    expect(s.judged).toBe(1);
  });
});

describe('runReputationPass — the body stage (link domains)', () => {
  const deps = (t: ReturnType<typeof fakeStorage>, links: LinkLookup | null, engine: { moveToSpam: (f: string, u: number) => Promise<unknown> } | null = null) => ({
    targets: () => [{ storage: t.storage, engine, label: 'acct' }],
    links: () => links,
    now: () => T0,
  });

  // THE classic phish: clean headers, one link to a listed site.
  it('extracts the link domains, looks them up, and files a message that links to a phishing domain', async () => {
    const t = fakeStorage([], true, [bodyRow({ id: 'a', uid: 9, spamScore: 0 })]);
    const p = providerOf(answering({}, { 'evil.example': phishing }));
    const engine = { moveToSpam: vi.fn<(folder: string, uid: number) => Promise<unknown>>().mockResolvedValue(undefined) };
    const s = await runReputationPass(deps(t, stageOf(p), engine));
    expect(p.calls).toEqual([{ ips: [], domains: ['evil.example'] }]);
    expect(s).toMatchObject({ linkJudged: 1, filed: 1, scored: 1, linkPending: 0 });
    expect(t.linkStamped[0].spamScore).toBe(5);
    expect(JSON.parse(t.linkStamped[0].spamReasons)).toEqual([{ id: 'reputation-link-listed', points: 5, detail: expect.stringContaining('evil.example') }]);
    expect(t.updates).toEqual([{ id: 'a', tags: '|spam|Spam|', folderId: 'f-spam' }]);
    expect(engine.moveToSpam).toHaveBeenCalledWith('INBOX', 9);
  });

  it("does not look up the sender's own domain among the links, and stamps a link-free body without asking", async () => {
    const t = fakeStorage([], true, [
      bodyRow({ id: 'a', fromAddress: 'news@brand.example', rawBody: '<a href="https://www.brand.example/x">x</a>' }),
      bodyRow({ id: 'b', rawBody: '<p>no links</p>' }),
    ]);
    const p = providerOf(answering({}));
    const s = await runReputationPass(deps(t, stageOf(p)));
    expect(p.calls).toEqual([]);
    expect(s.linkJudged).toBe(2);
  });

  // ONE cap for every blocklist point a message carries: the listings the
  // ingest check charged leave that much less room for the links.
  it('shares the reputation cap with the listings the ingest check charged', async () => {
    const t = fakeStorage([], true, [bodyRow({ id: 'a', spamScore: 3, spamReasons: JSON.stringify([{ id: 'reputation-ip-listed', points: 3, detail: 'PBL' }]) })]);
    await runReputationPass(deps(t, stageOf(providerOf(answering({}, { 'evil.example': phishing })))));
    expect(t.linkStamped[0].spamScore).toBe(6); // 3 + min(5, 6 − 3)
  });

  // ...and a legacy-named listing from before the reason ids were renamed
  // counts against that cap just the same.
  it('counts a stored listing under its old reason id against the cap too', async () => {
    const t = fakeStorage([], true, [bodyRow({ id: 'a', spamScore: 5, spamReasons: JSON.stringify([{ id: 'ip-blocklisted', points: 5, detail: 'SBL' }]) })]);
    await runReputationPass(deps(t, stageOf(providerOf(answering({}, { 'evil.example': phishing })))));
    expect(t.linkStamped[0].spamScore).toBe(6);
  });

  it('adds nothing once the cap is spent', async () => {
    const t = fakeStorage([], true, [bodyRow({ id: 'a', spamScore: 6, spamReasons: JSON.stringify([{ id: 'reputation-ip-listed', points: 6, detail: 'listed' }]) })]);
    await runReputationPass(deps(t, stageOf(providerOf(answering({}, { 'evil.example': phishing })))));
    expect(JSON.parse(t.linkStamped[0].spamReasons)).toHaveLength(1);
  });

  // Link lookups are opt-in: with them off, the links are not sent anywhere —
  // the body stage runs for registration dates alone.
  it('sends no link domain anywhere when link lookups are off', async () => {
    const t = fakeStorage([], true, [bodyRow({ id: 'a' })]);
    const { calls, source } = sourceOf({});
    const s = await runReputationPass({ ...deps(t, null), age: () => source });
    expect(s).toMatchObject({ linkJudged: 1, linkProvider: null, domainAge: true });
    expect(calls).toEqual(['evil.example']); // the registry, not a blocklist
    expect(t.linkStamped[0].spamScore).toBe(0);
  });

  // The user's word outranks the score: points are recorded, nothing is filed.
  it('never files a message the user called not-spam, in either stage', async () => {
    const t = fakeStorage(
      [row({ id: 'h1', spamScore: 3, spamUserVerdict: 'ham' })], true,
      [bodyRow({ id: 'h2', spamScore: 3, spamUserVerdict: 'ham' })],
    );
    const engine = { moveToSpam: vi.fn<(folder: string, uid: number) => Promise<unknown>>().mockResolvedValue(undefined) };
    const s = await runReputationPass({ ...deps(t, stageOf(providerOf(answering({}, { 'evil.example': phishing }))), engine), age: () => brandNew().source });
    expect(s.filed).toBe(0);
    expect(t.updates).toEqual([]);
    expect(engine.moveToSpam).not.toHaveBeenCalled();
    expect(t.stamped[0].spamScore).toBe(6);
    expect(t.linkStamped[0].spamScore).toBe(8);
  });
});

describe('the scheduler', () => {
  afterEach(() => { stopSpamReputationScheduler(); vi.useRealTimers(); });

  it('runs its first pass after the delay over every account, reports progress, and re-arms on the active cadence while rows wait', async () => {
    vi.useFakeTimers();
    const t = fakeStorage([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    h.runtimes = [['acct-1', { storage: t.storage, syncEngine: { isConnected: () => true, moveToSpam: async () => undefined } }]];

    startSpamReputationScheduler();
    startSpamReputationScheduler(); // idempotent
    expect(getSpamReputationState()).toMatchObject({ running: false, lastRun: null });
    await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS + 10);

    const state = getSpamReputationState();
    // The defaults: every list asked through this computer's DNS as mail
    // arrives, link lookups off, registration dates on.
    expect(state).toMatchObject({ judged: 3, blocklists: 'local-dnsbl', linkProvider: null, domainAge: true, pending: 0, running: false });
    expect(state.lastRun).not.toBeNull();
    expect(h.sent.some((m) => m.c === 'spam:reputation-progress')).toBe(true);
    expect(t.stamped).toHaveLength(3);
    expect(h.dnsQueries).toEqual([]); // the pass never asks a list about a sender
  });

  it('sleeps on the idle cadence when nothing is waiting, and "Run now" pulls the next pass forward', async () => {
    vi.useFakeTimers();
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

  // Regression: this used to be the `spam:setReputationPolicy` IPC's job. A
  // lookup the user just switched on must not wait out the idle cadence.
  it('pulls the next pass forward when the settings change', async () => {
    vi.useFakeTimers();
    h.runtimes = [['acct-1', { storage: fakeStorage([]).storage, syncEngine: null }]];
    startSpamReputationScheduler();
    await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS + 10);
    const sentAfterFirst = h.sent.length;

    store({ links: true });
    noteAppSettingChanged(SETTINGS_KEY);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent.length).toBe(sentAfterFirst + 1);
    expect(getSpamReputationState().linkProvider).toBe('local-dnsbl');
  });

  // Fail closed: settings that cannot be read ask nobody — not the registry,
  // not a blocklist — and the rows wait rather than being stamped unjudged.
  it('looks nothing up while the settings cannot be read', async () => {
    vi.useFakeTimers();
    h.settingsUnreadable = true;
    const t = fakeStorage([row({ id: 'a' })], true, [bodyRow({ id: 'b' })]);
    h.runtimes = [['acct-1', { storage: t.storage, syncEngine: null }]];
    startSpamReputationScheduler();
    await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS + 10);
    expect(t.stamped).toEqual([]);
    expect(t.linkStamped).toEqual([]);
    expect(h.fetchCalls).toEqual([]);
    expect(getSpamReputationState()).toMatchObject({ blocklists: null, domainAge: false, linkProvider: null });
  });

  it('stops: no further pass fires after stop, and a kick after stop is a no-op', async () => {
    vi.useFakeTimers();
    store({ enabled: false, domainAge: false });
    startSpamReputationScheduler();
    stopSpamReputationScheduler();
    kickSpamReputation();
    store({ links: true });
    noteAppSettingChanged(SETTINGS_KEY);
    await vi.advanceTimersByTimeAsync(REPUTATION_FIRST_TICK_MS * 2);
    expect(h.sent).toEqual([]);
  });
});

describe('edges', () => {
  it('a stamping failure is isolated to its account', async () => {
    const t = fakeStorage([row({ id: 'a' })]);
    t.storage.applyReputationBatch = () => { throw new Error('db locked'); };
    const s = await runReputationPass({
      targets: () => [{ storage: t.storage, engine: null, label: 'x' }], links: () => null, age: () => sourceOf({}).source, now: () => T0,
    });
    expect(s.judged).toBe(0);
  });

  it('the scheduler treats a disconnected engine as no engine, and survives a window that is gone', async () => {
    vi.useFakeTimers();
    try {
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
  const deps = (t: ReturnType<typeof fakeStorage>, links: LinkLookup | null, age: AgeSource | null = null) => ({
    targets: () => [{ storage: t.storage, engine: null, label: 'acct' }], links: () => links, age: () => age, now: () => T0,
  });

  // Fail-open for link lookups, in every form: a cached answer is reused, an
  // unknown adds no points but says why, and a lookup that throws — or a stamp
  // that fails — costs the row nothing but a note.
  it('the body stage serves a link domain from the cache, surfaces an unknown’s note, and survives a throwing lookup or stamp', async () => {
    const p = providerOf(answering({}, { 'evil.example': phishing }));
    const links = stageOf(p);
    await runReputationPass(deps(fakeStorage([], true, [bodyRow({ id: 'a' })]), links));
    await runReputationPass(deps(fakeStorage([], true, [bodyRow({ id: 'b' })]), links));
    expect(p.calls).toHaveLength(1); // the second pass hit the one cache

    const unknownNote = providerOf((q) => ({ provider: 'test', ips: new Map(), domains: new Map(q.domains.map((d) => [d, { status: 'unknown' as const, hits: [], note: 'URIBL refused the query' }])) }));
    const s1 = await runReputationPass(deps(fakeStorage([], true, [bodyRow({ id: 'c', spamScore: 4 })]), stageOf(unknownNote)));
    expect(s1).toMatchObject({ linkJudged: 1, scored: 0, notes: ['URIBL refused the query'] });

    const throwingProvider: ReputationProvider = { name: 'broken', lookup: async () => { throw new Error('ECONNRESET'); } };
    const t = fakeStorage([], true, [bodyRow({ id: 'd', spamScore: 4 })]);
    const s2 = await runReputationPass(deps(t, stageOf(throwingProvider)));
    expect(s2).toMatchObject({ linkJudged: 1, scored: 0, notes: ['Lookup failed: ECONNRESET'] });
    expect(t.linkStamped[0].spamScore).toBe(4);

    const throwingLookup: LinkLookup = { providerName: 'odd', lookup: async () => { throw new Error('boom'); } };
    const s3 = await runReputationPass(deps(fakeStorage([], true, [bodyRow({ id: 'e' })]), throwingLookup));
    expect(s3).toMatchObject({ linkJudged: 1, notes: ['Lookup failed: boom'] });

    const t2 = fakeStorage([], true, [bodyRow({ id: 'f' })]);
    t2.storage.applyLinkReputationBatch = () => { throw new Error('db locked'); };
    expect((await runReputationPass(deps(t2, stageOf(providerOf(answering({})))))).linkJudged).toBe(0);
  });

  // A row the AI categoriser tagged `spam` but the filter never filed: the tag is kept, the row is filed once it crosses.
  it('keeps an existing spam tag when filing, and isolates a failing local update', async () => {
    const t = fakeStorage([row({ id: 'a', spamScore: 3, tags: '|INBOX|spam|' })]);
    await runReputationPass(deps(t, null, brandNew().source));
    expect(t.updates).toEqual([{ id: 'a', tags: '|spam|Spam|', folderId: 'f-spam' }]);

    const failing = fakeStorage([row({ id: 'b', spamScore: 3 })]);
    failing.storage.updateEmail = async () => { throw new Error('db locked'); };
    const s = await runReputationPass(deps(failing, null, brandNew().source));
    expect(s.filed).toBe(0);
    expect(failing.stamped).toHaveLength(1); // scored and stamped all the same
  });

  it('the scheduler skips a runtime whose storage predates the stage, logs notes, and does not re-arm after a stop mid-pass', async () => {
    vi.useFakeTimers();
    try {
      store({ provider: 'sarv', endpoint: 'https://rep.sarv.example', links: true, domainAge: false });
      h.accounts = [{ provider: 'sarv', email: 'rc@sarv.example' }];
      let release!: () => void;
      h.fetchGate = new Promise<void>((r) => { release = r; });
      const t = fakeStorage([], true, [bodyRow({ id: 'a', rawBody: '<a href="https://never-before.example/x">x</a>' })]);
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
      expect(st.linkJudged).toBeGreaterThanOrEqual(1);
      expect(st.notes).toContain('No answer for this item');
      expect(st).toMatchObject({ blocklists: 'sarv', linkProvider: 'sarv' });
      const sent = h.sent.length;
      await vi.advanceTimersByTimeAsync(REPUTATION_IDLE_INTERVAL_MS * 2);
      expect(h.sent.length).toBe(sent); // stopped: no further pass
    } finally {
      stopSpamReputationScheduler();
      vi.useRealTimers();
    }
  });
});

/**
 * What keeps this pass off the main thread.
 *
 * What this protects: nothing here changes a score, so every one of these
 * failures is invisible to the other tests in this file — they would all stay
 * green while the pass froze the app. The body stage reads whole MIME bodies
 * and HTML-parses each one synchronously, which is exactly the shape a CPU
 * profile named as the beachball in the inline-image pass: the bound has to be
 * TIME (a body is any size) and the loop has to hand the thread back.
 */
describe('runReputationPass — holding the main thread', () => {
  const pacing = (
    t: ReturnType<typeof fakeStorage>,
    links: LinkLookup,
    over: Partial<{ nowMs: () => number; budgetMs: number; yieldFn: () => Promise<void>; age: () => AgeSource | null }> = {},
  ) => ({
    targets: () => [{ storage: t.storage, engine: null, label: 'acct' }],
    links: () => links,
    now: () => T0,
    ...over,
  });
  const bodies = (n: number): BodyRow[] => Array.from({ length: n }, (_, i) => bodyRow({ id: `b${i}` }));
  const countingReads = (t: ReturnType<typeof fakeStorage>) => {
    const limits: number[] = [];
    const real = t.storage.getEmailsPendingLinkReputation;
    t.storage.getEmailsPendingLinkReputation = (limit) => { limits.push(limit); return real(limit); };
    return limits;
  };

  // A body-stage row carries `raw_body`: the whole MIME source, attachments
  // included. Asking for the sender stage's 200 of those at once is a
  // multi-hundred-megabyte read before one domain has been extracted.
  it('reads bodies in bounded chunks, and still drains the backlog', async () => {
    const t = fakeStorage([], true, bodies(60));
    const limits = countingReads(t);
    const s = await runReputationPass(pacing(t, stageOf(providerOf(answering({})))));
    expect(Math.max(...limits)).toBe(BODY_BATCH_SIZE);
    expect(s).toMatchObject({ linkJudged: 60, linkPending: 0 });
  });

  // A row limit cannot bound a loop whose per-row cost is an HTML parse over a
  // body of any size; a deadline can. The chunk in flight finishes — it has
  // already been read and looked up — and no new one starts.
  it('stops starting chunks once the time budget is spent, leaving the rest pending', async () => {
    const t = fakeStorage([], true, bodies(60));
    let ms = 0;
    const s = await runReputationPass(pacing(t, stageOf(providerOf(answering({}))), {
      nowMs: () => (ms += 40), // a clock that runs out mid-chunk
      budgetMs: 1_000,
      yieldFn: async () => {},
    }));
    expect(s).toMatchObject({ linkJudged: BODY_BATCH_SIZE, linkPending: 60 - BODY_BATCH_SIZE });
  });

  // better-sqlite3 is synchronous, so an `await` around it resolves as a
  // microtask and the queue drains without ever reaching libuv's poll phase:
  // a loop that never yields freezes IMAP reads, IPC replies and the renderer
  // along with itself.
  it('hands the thread back while parsing bodies and while filing rows', async () => {
    const t = fakeStorage([row({ id: 'a', spamScore: 3 })], true, bodies(3));
    let ms = 0;
    let yields = 0;
    await runReputationPass(pacing(t, stageOf(providerOf(answering({}))), {
      nowMs: () => (ms += 10), // each row costs more than the yielder's budget
      yieldFn: async () => { yields += 1; },
      age: () => brandNew().source,
    }));
    expect(yields).toBeGreaterThanOrEqual(4); // at least once per row parsed or filed
    expect(t.linkStamped).toHaveLength(3);
    expect(t.updates).toEqual([{ id: 'a', tags: '|spam|Spam|', folderId: 'f-spam' }]);
  });

  // Nothing left the queue, so the next chunk is this chunk. Re-reading it
  // until the deadline would burn the whole budget on rows it cannot stamp —
  // and with the rows in hand it would look like progress in the log.
  it('stops instead of re-reading the same chunk when nothing leaves the queue', async () => {
    const stalled = fakeStorage([], true, bodies(3));
    stalled.storage.applyLinkReputationBatch = () => 0;
    const stalledReads = countingReads(stalled);
    expect((await runReputationPass(pacing(stalled, stageOf(providerOf(answering({})))))).linkJudged).toBe(0);
    expect(stalledReads).toHaveLength(1);

    const broken = fakeStorage([], true, bodies(3));
    broken.storage.applyLinkReputationBatch = () => { throw new Error('db locked'); };
    const brokenReads = countingReads(broken);
    expect((await runReputationPass(pacing(broken, stageOf(providerOf(answering({})))))).linkJudged).toBe(0);
    expect(brokenReads).toHaveLength(1);
  });

  // The pass can be entered with the budget already gone (a slow tick before
  // it). It must judge nothing and still report the backlog, or the Security
  // tab would show zero waiting rows for as long as the app stayed busy.
  it('starts no account when the budget is already spent, and still reports what is waiting', async () => {
    const t = fakeStorage([row({ id: 'a' })], true, bodies(2));
    const s = await runReputationPass(pacing(t, stageOf(providerOf(answering({}))), {
      nowMs: () => 0,
      budgetMs: 0,
      yieldFn: async () => {},
      age: () => sourceOf({}).source,
    }));
    expect(s).toMatchObject({ judged: 0, linkJudged: 0, pending: 1, linkPending: 2 });
  });
});

/**
 * Domain age in the pass.
 *
 * What this protects: the lure of 2026-09-23 linked to a domain five days old
 * that no blocklist had heard of. Age is the one fact about a campaign domain
 * that is true before anyone reports it — and it is equally true of a start-up's
 * first week, so the cap that keeps age from filing a message on its own is
 * pinned here as hard as the detection is. Most of these run with no link
 * lookups at all, because that is the default install: link lookups are opt-in,
 * and the registry needs no blocklist.
 */
describe('domain age', () => {
  const ageDeps = (targets: ReturnType<typeof fakeStorage>[], source: AgeSource | null, links: LinkLookup | null = null) => ({
    targets: () => targets.map((t, i) => ({ storage: t.storage, engine: null, label: `acct-${i}` })),
    links: () => links,
    age: () => source,
    now: () => T0,
  });

  // Not a blocklist, so the blocklist switch does not govern it — its own
  // toggle does, and with that off the registry is asked nothing.
  it('wires a source only when its toggle is on, whether or not the blocklists are', () => {
    expect(ageSourceForSettings({ ...DEFAULT_REPUTATION_SETTINGS, domainAge: false })).toBeNull();
    expect(ageSourceForSettings({ ...DEFAULT_REPUTATION_SETTINGS })).not.toBeNull();
    expect(ageSourceForSettings({ ...DEFAULT_REPUTATION_SETTINGS, enabled: false })).not.toBeNull();
    expect(ageSourceForSettings({ ...DEFAULT_REPUTATION_SETTINGS, provider: 'sarv', endpoint: '' })).not.toBeNull();
  });

  // THE case: no link lookups (the default install), a 78-day-old sender in
  // the sender stage and a five-day-old link in the body stage. 2 + 1 stays in
  // the inbox; 2 + 3 crosses the line and is filed.
  it('runs with no link lookups at all, scoring the sender domain and the youngest linked domain', async () => {
    const t = fakeStorage(
      [row({ id: 'a', fromAddress: 'Adobesign@powersublinks.com', originIp: null, spamScore: 2 })],
      true,
      [bodyRow({ id: 'b', spamScore: 2, rawBody: '<a href="https://kuaiyudh.top/v/#rc">Sarv.com Engagement Letter</a> <a href="https://cdn.example/x">img</a>' })],
    );
    const { calls, source } = sourceOf({ 'powersublinks.com': dated('powersublinks.com', 78), 'kuaiyudh.top': dated('kuaiyudh.top', 5), 'cdn.example': dated('cdn.example', 4000) });
    const s = await runReputationPass(ageDeps([t], source));

    expect(s).toMatchObject({ linkProvider: null, domainAge: true, judged: 1, linkJudged: 1, scored: 2, filed: 1, ageLookups: 3, notes: [] });
    expect(calls.sort()).toEqual(['cdn.example', 'kuaiyudh.top', 'powersublinks.com']);
    const a = t.stamped.find((x) => x.id === 'a')!;
    expect(a.spamScore).toBe(3);
    expect(JSON.parse(a.spamReasons)).toEqual([{ id: 'reputation-domain-new', points: 1, detail: expect.stringContaining('powersublinks.com was registered only 78 days ago') }]);
    const b = t.linkStamped.find((x) => x.id === 'b')!;
    expect(b.spamScore).toBe(5);
    expect(JSON.parse(b.spamReasons)).toEqual([{ id: 'reputation-link-new', points: 3, detail: expect.stringContaining('kuaiyudh.top, a domain registered only 5 days ago') }]);
    expect(t.updates).toEqual([{ id: 'b', tags: expect.stringContaining('|spam|'), folderId: 'f-spam' }]);
  });

  // Regression: the age budget is ONE budget across both stages. A sender the
  // sender stage already charged 3 for leaves the links a single point, so a
  // brand-new sender linking to its own brand-new site cannot reach the line
  // on age alone — that is the start-up's first week, not spam.
  it('shares the age cap between the sender stage and the body stage, so age alone never files', async () => {
    const already = JSON.stringify([{ id: 'reputation-domain-new', points: 3, detail: 'new sender' }]);
    const t = fakeStorage([], true, [bodyRow({ id: 'b', spamScore: 3, spamReasons: already, rawBody: '<a href="https://brandnew.example/x">launch</a>' })]);
    const { source } = sourceOf({ 'brandnew.example': dated('brandnew.example', 0) });
    await runReputationPass(ageDeps([t], source));
    const b = t.linkStamped[0]!;
    expect(b.spamScore).toBe(4);
    expect(JSON.parse(b.spamReasons).at(-1)).toMatchObject({ id: 'reputation-link-new', points: 1 });
    expect(t.updates).toEqual([]);
  });

  // Blocklist points and age points are separate facts with separate budgets:
  // a sender the ingest check found listed, on a domain registered today, is
  // both.
  it('adds age on top of the listing the ingest check charged, each within its own cap', async () => {
    const listed = JSON.stringify([{ id: 'reputation-ip-listed', points: 3, detail: 'The sending address 5.6.7.8 is listed by Spamhaus ZEN (PBL).' }]);
    const t = fakeStorage([row({ id: 'a', fromAddress: 'x@fresh.example', originIp: '5.6.7.8', spamScore: 3, spamReasons: listed })]);
    const { source } = sourceOf({ 'fresh.example': dated('fresh.example', 0) });
    const s = await runReputationPass(ageDeps([t], source));
    const a = t.stamped[0]!;
    expect(JSON.parse(a.spamReasons).map((r: { id: string; points: number }) => [r.id, r.points])).toEqual([['reputation-ip-listed', 3], ['reputation-domain-new', 3]]);
    expect(a.spamScore).toBe(6);
    expect(s.filed).toBe(1);
  });

  // The cache is the whole cost model: a registration date never changes, so
  // one answer serves a month of mail from that domain, and its age keeps
  // counting up from the stored date rather than freezing at what it was.
  it('caches an answer for a month and recomputes the age from the stored date, and retries a failure after an hour', async () => {
    const cache = new DomainAgeCache(new Database(':memory:'));
    cache.set('kuaiyudh.top', dated('kuaiyudh.top', 5), T0);
    cache.set('down.example', { ...unsupported('down.example'), status: 'error', detail: 'The RDAP server answered 429' }, T0);
    expect(cache.count()).toBe(2);
    expect(cache.get('nobody.example', T0)).toBeNull();
    expect(cache.get('kuaiyudh.top', T0)?.ageDays).toBe(5);
    expect(cache.get('kuaiyudh.top', T0 + 30 * 86_400)?.ageDays).toBe(35);
    expect(cache.get('kuaiyudh.top', T0 + DOMAIN_AGE_CACHE_TTL_S + 1)).toBeNull();
    expect(cache.get('down.example', T0 + DOMAIN_AGE_CACHE_ERROR_TTL_S - 1)?.status).toBe('error');
    expect(cache.get('down.example', T0 + DOMAIN_AGE_CACHE_ERROR_TTL_S + 1)).toBeNull();

    // Through the pass: the second account's rows from the same domain cost no lookup.
    const first = sourceOf({ 'camp.example': dated('camp.example', 3) }, { cache });
    const t1 = fakeStorage([row({ id: 'a', fromAddress: 'x@camp.example', originIp: null })]);
    await runReputationPass(ageDeps([t1], first.source));
    const second = sourceOf({}, { cache });
    const t2 = fakeStorage([row({ id: 'b', fromAddress: 'y@camp.example', originIp: null })]);
    const s = await runReputationPass(ageDeps([t2], second.source));
    expect(second.calls).toEqual([]);
    expect(s.ageLookups).toBe(0);
    expect(JSON.parse(t2.stamped[0]!.spamReasons)[0]).toMatchObject({ id: 'reputation-domain-new', points: 3 });
  });

  // Regression: a pass over a large backlog must not become hundreds of
  // registry requests. Beyond the budget a domain is simply not asked about
  // this pass — and not cached as anything, so the next pass asks.
  it('bounds the registry lookups per pass and leaves the rest for the next one', async () => {
    const t = fakeStorage([
      row({ id: 'a', fromAddress: 'x@one.example', originIp: null }),
      row({ id: 'b', fromAddress: 'x@two.example', originIp: null }),
    ]);
    const { calls, cache, source } = sourceOf({ 'one.example': dated('one.example', 1), 'two.example': dated('two.example', 1) }, { maxLookups: 1 });
    const s = await runReputationPass(ageDeps([t], source));
    expect(calls).toHaveLength(1);
    expect(s.ageLookups).toBe(1);
    expect(cache.get('two.example', T0)).toBeNull();
    expect(t.stamped.map((x) => x.spamScore).sort()).toEqual([0, 3]);
  });

  // Fail-open: a registry that throws or errors adds nothing, is remembered for
  // an hour so it is not hammered, and is named in the notes the Security page shows.
  it('adds nothing for a failed or unsupported lookup, and reports the failure', async () => {
    const t = fakeStorage([row({ id: 'a', fromAddress: 'x@boom.example', originIp: null }), row({ id: 'b', fromAddress: 'x@nordap.example', originIp: null })]);
    const { cache, source } = sourceOf({ 'boom.example': new Error('socket hang up') });
    const s = await runReputationPass(ageDeps([t], source));
    expect(s).toMatchObject({ judged: 2, scored: 0, ageLookups: 2, notes: ['Domain age: socket hang up'] });
    expect(cache.get('boom.example', T0)?.status).toBe('error');
    expect(cache.get('nordap.example', T0)?.status).toBe('unsupported');
  });

  // The real wiring: IANA's table once, then the registry, through Chromium's
  // fetch — with the RDAP media type asked for, as RFC 7480 wants.
  it('looks the domain up through IANA’s bootstrap and the registry, fetching the bootstrap once', async () => {
    h.rdap['https://data.iana.org/rdap/dns.json'] = { status: 200, body: JSON.stringify({ services: [[['top'], ['https://rdap.zdnsgtld.com/top/']]] }) };
    h.rdap['https://rdap.zdnsgtld.com/top/domain/kuaiyudh.top'] = { status: 200, body: JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2026-09-17T23:11:55Z' }] }) };
    h.rdap['https://rdap.zdnsgtld.com/top/domain/other.top'] = { status: 404, body: '' };
    const source = ageSourceForSettings(DEFAULT_REPUTATION_SETTINGS)!;

    const first = await source.lookup('kuaiyudh.top');
    const second = await source.lookup('other.top');
    expect(first.status).toBe('ok');
    expect(first.ageDays).toBeGreaterThanOrEqual(5);
    expect(second.status).toBe('not-found');
    // Compared by host, not substring: the assertion is about which server was asked.
    const host = (url: string) => new URL(url).hostname;
    expect(h.fetchCalls.filter((c) => host(c.url) === 'data.iana.org')).toHaveLength(1);
    expect((h.fetchCalls.find((c) => host(c.url) === 'rdap.zdnsgtld.com')?.init as { headers: { accept: string } }).headers.accept).toBe('application/rdap+json');
    expect(source.cache).toBe(ageSourceForSettings({ ...DEFAULT_REPUTATION_SETTINGS, provider: 'sarv' })!.cache);
  });

  it('retries a failed bootstrap fetch on the next lookup rather than believing the failure for a day', async () => {
    h.rdap['https://data.iana.org/rdap/dns.json'] = { status: 503, body: '' };
    const source = ageSourceForSettings(DEFAULT_REPUTATION_SETTINGS)!;
    expect((await source.lookup('kuaiyudh.top')).status).toBe('error');
    resetRdapBootstrapCache();
    h.rdap['https://data.iana.org/rdap/dns.json'] = { status: 200, body: JSON.stringify({ services: [[['top'], ['https://rdap.zdnsgtld.com/top/']]] }) };
    h.rdap['https://rdap.zdnsgtld.com/top/domain/kuaiyudh.top'] = { status: 200, body: JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2026-09-17T23:11:55Z' }] }) };
    expect((await source.lookup('kuaiyudh.top')).status).toBe('ok');
  });
});
