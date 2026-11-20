import { setSarvBaseUrl, type ItemReputation, type ReputationProvider, type SarvReputationDeps, type SenderReport } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Blocklist settings -> the one process-wide lookup.
 *
 * What this guards is the disclosure boundary: which third party is asked,
 * about what, and when. The regressions all have the same shape — a query
 * going out that the user never asked for (a list they unticked, the system
 * resolver when they named their own, anything at all when the settings could
 * not be read), or a setting the user did ask for never reaching the stage.
 * The stage itself (cache, de-duplication, breakers) is covered in the core
 * suite; here it runs for real, over a fake resolver and an in-memory core DB,
 * so every assertion is about the DNS names that would actually go out.
 */

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  settingsUnreadable: false,
  db: null as unknown,
  /** Every A query, with the nameservers the resolver asking it was pointed at. */
  queries: [] as Array<{ name: string; servers: string[] | null }>,
  /** Listed answers by query name; anything else is NXDOMAIN. */
  answers: {} as Record<string, string[]>,
  fetchCalls: [] as Array<{ url: string; init: { body?: string; headers?: Record<string, string>; redirect?: string } }>,
  /** How many of the next Sarv requests fail as a connection reset would. */
  fetchFailures: 0,
  /** What the fake Sarv service answers a lookup with. */
  sarvAnswer: { ips: [], domains: [] } as unknown,
  accounts: [] as Array<{ provider: string; email: string }>,
  /** What main built each Sarv provider with, so main's own transport can be tested apart from core's. */
  sarvDeps: [] as SarvReputationDeps[],
}));
// Spies, so a test can say the token store was never read and no token minted.
const oauth = vi.hoisted(() => ({
  listSignedInAccounts: vi.fn(async () => h.accounts),
  getValidAccessToken: vi.fn(async (_provider: string, email: string) => `tok-${email}`),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/reputation-service-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => h.db,
  readAppSetting: (key: string) => {
    if (h.settingsUnreadable) throw new Error('file is not a database');
    return h.settings.get(key) ?? null;
  },
}));
vi.mock('node:dns', () => ({
  promises: {
    Resolver: class {
      private servers: string[] | null = null;
      setServers(servers: string[]): void {
        const bad = servers.find((server) => !/^[\d.:[\]]+$/.test(server));
        if (bad) throw Object.assign(new TypeError(`Invalid IP address: ${bad}`), { code: 'ERR_INVALID_IP_ADDRESS' });
        this.servers = servers;
      }
      async resolve4(name: string): Promise<string[]> {
        h.queries.push({ name, servers: this.servers });
        const answer = h.answers[name];
        if (answer) return answer;
        throw Object.assign(new Error(`queryA ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      }
    },
  },
}));
vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: async (url: string, init: { body?: string; headers?: Record<string, string>; redirect?: string }) => {
    h.fetchCalls.push({ url, init });
    if (h.fetchFailures > 0) {
      h.fetchFailures -= 1;
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    }
    return { ok: true, status: 200, json: async () => h.sarvAnswer };
  },
}));
vi.mock('../../../../electron/services/oauth-service', () => oauth);
// The real provider, recording the deps main hands it.
vi.mock('@sarvinbox/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@sarvinbox/core')>();
  class RecordingSarvReputationProvider extends core.SarvReputationProvider {
    constructor(deps: SarvReputationDeps) {
      super(deps);
      h.sarvDeps.push(deps);
    }
  }
  return { ...core, SarvReputationProvider: RecordingSarvReputationProvider };
});

import {
  DEFAULT_REPUTATION_SETTINGS,
  DEFAULT_ZONES,
  REPUTATION_CACHE_TTL_S,
  REPUTATION_CACHE_UNKNOWN_TTL_S,
  ReputationCache,
  SETTINGS_KEY,
  SETTINGS_RETRY_MS,
  attachReputation,
  availableBlocklists,
  blocklistProviderName,
  getReputationCache,
  getReputationSettings,
  linkReputationStage,
  noteAppSettingChanged,
  onReputationSettingsChanged,
  readReputationSettings,
  reportSenderVerdict,
  reportsAllowed,
  resetReputationForTests,
  type ReputationSettings,
} from '../../../../electron/services/reputation-service';

const SENDER_IP = '185.199.108.1';
const REVERSED = '1.108.199.185';
const T0 = 1_760_000_000;

/** Store the settings blob the renderer would have mirrored into the core DB. */
const store = (reputation?: unknown, extra: Record<string, unknown> = {}): void => {
  h.settings.set(SETTINGS_KEY, JSON.stringify(reputation === undefined ? extra : { ...extra, reputation }));
};
/** A section saved by this build's Blocklists tab. */
const saved = (over: Partial<ReputationSettings> = {}): ReputationSettings & { chosen: true } => ({
  ...DEFAULT_REPUTATION_SETTINGS, ...over, chosen: true,
});

/** A sync engine, as far as this service is concerned. */
const fakeEngine = () => {
  const engine = {
    lookup: null as null | ((subject: { ip?: string | null; domains?: string[] }) => Promise<unknown>),
    setReputationLookup(fn: (subject: { ip?: string | null; domains?: string[] }) => Promise<unknown>) {
      engine.lookup = fn;
    },
  };
  return engine;
};
const wired = () => {
  const engine = fakeEngine();
  attachReputation(engine);
  return engine;
};
const asked = () => h.queries.map((q) => q.name);
/**
 * The reputation origin these tests configure — the only address the Sarv
 * bearer may go to. No build has one (Sarv runs no such service yet), so each
 * test starts with it set the way a dev build's override sets it.
 */
const SARV_REP = 'https://reputation.sarv.test';
/** Every line the service logs at info or warn, as it would reach app.log. */
const captureLog = () => {
  const lines: Array<{ level: 'info' | 'warn'; line: string }> = [];
  const info = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push({ level: 'info', line: args.map(String).join(' ') }); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push({ level: 'warn', line: args.map(String).join(' ') }); });
  return { lines, restore: () => { info.mockRestore(); warn.mockRestore(); } };
};

beforeEach(() => {
  setSarvBaseUrl({ reputationBase: SARV_REP }); // before the reset, so no stale stage hears it
  resetReputationForTests();
  h.settings.clear();
  h.settingsUnreadable = false;
  h.db = new Database(':memory:');
  h.queries = [];
  h.answers = {};
  h.fetchCalls = [];
  h.fetchFailures = 0;
  h.sarvAnswer = { ips: [], domains: [] };
  h.accounts = [];
  h.sarvDeps = [];
  oauth.listSignedInAccounts.mockClear();
  oauth.getValidAccessToken.mockClear();
});

describe('readReputationSettings', () => {
  it('reads the zones and resolvers the user chose', () => {
    expect(
      readReputationSettings({
        [SETTINGS_KEY]: JSON.stringify({
          reputation: { enabled: true, zones: ['spamhaus-zen'], servers: [' 10.0.0.1 ', '10.0.0.2'] },
        }),
      }),
    ).toEqual({ ...DEFAULT_REPUTATION_SETTINGS, zones: ['spamhaus-zen'], servers: ['10.0.0.1', '10.0.0.2'] });
  });

  // Behaviour changed 2026-09-23: blocklists are on by default, every zone.
  // An absent or unreadable section reads as those defaults, never as a
  // throw at boot. An EXPLICIT section is still read literally — "truthy" is
  // not "true", and a zone list that is not a list is no zones — so a user
  // who turned lists off stays off whatever else the blob has suffered.
  it('reads an absent or unreadable section as the defaults, and an explicit one literally', () => {
    const defaults = DEFAULT_REPUTATION_SETTINGS;
    expect(defaults).toMatchObject({ enabled: true, provider: 'local', zones: [...DEFAULT_ZONES], servers: [], links: false, domainAge: true });
    expect(DEFAULT_ZONES).toEqual(['spamhaus-zen', 'spamhaus-dbl', 'spamcop', 'barracuda', 'surbl', 'uribl']);

    expect(readReputationSettings({})).toEqual(defaults);
    expect(readReputationSettings({ [SETTINGS_KEY]: 'not json' })).toEqual(defaults);
    expect(readReputationSettings({ [SETTINGS_KEY]: '{}' })).toEqual(defaults);
    expect(readReputationSettings({ [SETTINGS_KEY]: '{"reputation":null}' })).toEqual(defaults);
    expect(readReputationSettings({ [SETTINGS_KEY]: '{"reputation":"yes"}' })).toEqual(defaults);
    expect(
      readReputationSettings({ [SETTINGS_KEY]: '{"reputation":{"enabled":1,"zones":"all"}}' }),
    ).toMatchObject({ enabled: false, zones: [], servers: [] });
    expect(
      readReputationSettings({ [SETTINGS_KEY]: '{"reputation":{"enabled":false,"zones":["spamcop"],"servers":[]}}' }),
    ).toMatchObject({ enabled: false, zones: ['spamcop'], servers: [] });
  });

  // THE migration, end to end on the main side: every install that ever saved
  // Settings has the old default stored as an explicit "off". It must read as
  // the new default — and a section the Blocklists tab marked must not.
  it('reads the old saved "off" as the new default, but honours an off the user chose', () => {
    const blob = (reputation: unknown) => ({ [SETTINGS_KEY]: JSON.stringify({ signatures: [], reputation }) });

    expect(readReputationSettings(blob({ enabled: false, zones: [], servers: [] }))).toEqual(DEFAULT_REPUTATION_SETTINGS);
    expect(readReputationSettings(blob({ enabled: false, zones: [], servers: [], chosen: true }))).toEqual({
      ...DEFAULT_REPUTATION_SETTINGS, enabled: false, zones: [], chosen: true,
    });
  });

  // The second migration (the full matrix is in core's blocklist-prefs suite):
  // the retired Settings > General control's choices arrive in the one
  // setting instead of silently resetting.
  it('carries the retired Settings > General choices into the one setting', () => {
    const blob = (legacy: Record<string, unknown>) => ({ [SETTINGS_KEY]: JSON.stringify({ reputation: { enabled: false, zones: [], servers: [] }, ...legacy }) });

    expect(readReputationSettings(blob({ spamReputationMode: 'off' }))).toMatchObject({ enabled: false, domainAge: false });
    expect(readReputationSettings(blob({ spamReputationMode: 'sarv', spamReputationEndpoint: 'https://rep.sarv.example', spamReputationReports: true })))
      .toMatchObject({ enabled: true, provider: 'sarv', endpoint: 'https://rep.sarv.example', reports: true, links: true });
  });

  // Regression: a zone name this build does not know must be dropped, never
  // passed through. Otherwise a typo (or a settings blob from a newer build)
  // becomes a query to a zone nobody in this process can describe.
  it('drops zone names that are not in this build catalogue', () => {
    expect(
      readReputationSettings({
        [SETTINGS_KEY]: JSON.stringify({
          reputation: { enabled: true, zones: ['spamhaus-zen', 'made-up.example', 42], servers: [] },
        }),
      }).zones,
    ).toEqual(['spamhaus-zen']);
  });
});

describe('attachReputation', () => {
  // The default, and the one that matters most: a fresh install asks every
  // catalogue zone from its first message, through the system resolver, with
  // no setting touched. (Behaviour changed 2026-09-23; it used to ask nobody.)
  it('wires a lookup that asks every catalogue zone out of the box, through the system resolver', async () => {
    h.answers[`${REVERSED}.zen.spamhaus.org`] = ['127.0.0.2'];
    const engine = wired();

    await expect(engine.lookup!({ ip: SENDER_IP, domains: ['sender.example'] })).resolves.toMatchObject({ score: 4 });
    expect(asked().sort()).toEqual([
      `${REVERSED}.b.barracudacentral.org`,
      `${REVERSED}.bl.spamcop.net`,
      `${REVERSED}.zen.spamhaus.org`,
      'sender.example.dbl.spamhaus.org',
      'sender.example.multi.surbl.org',
      'sender.example.multi.uribl.com',
    ]);
    expect(h.queries.every((q) => q.servers === null)).toBe(true);
  });

  // `chosen` is what the Blocklists tab writes: without it this exact shape
  // is the old saved default, which the migration reads as ON.
  it('asks nobody once the user has turned the lists off', async () => {
    store({ enabled: false, zones: [], servers: [], chosen: true });
    const engine = wired();

    await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
    expect(asked()).toEqual([]);
  });

  it('asks only the chosen zones, through the chosen resolvers, and scores through them', async () => {
    store(saved({ zones: ['spamhaus-zen', 'spamhaus-dbl'], servers: ['10.0.0.1'] }));
    h.answers[`${REVERSED}.zen.spamhaus.org`] = ['127.0.0.2'];
    const engine = wired();

    await expect(engine.lookup!({ ip: SENDER_IP, domains: ['sender.example'] })).resolves.toMatchObject({ score: 4 });
    expect(asked().sort()).toEqual([`${REVERSED}.zen.spamhaus.org`, 'sender.example.dbl.spamhaus.org']);
    expect(h.queries.every((q) => q.servers?.join(',') === '10.0.0.1')).toBe(true);
  });

  // Regression: "on" with nothing selected is not a reason to query anything.
  it('stays off when it is enabled but no list is selected', async () => {
    store(saved({ zones: [] }));
    const engine = wired();

    await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
    expect(asked()).toEqual([]);
  });

  // Regression: a resolver the user named but node cannot use must not fall
  // back to the system resolver — that is exactly the resolver they chose not
  // to send their correspondents' addresses through. (It used to throw inside
  // the lookup, failing every message's ingest instead.)
  it('asks nobody, rather than the system resolver, when the named resolvers are unusable', async () => {
    store(saved({ servers: ['not-an-ip'] }));
    const engine = wired();

    await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
    expect(asked()).toEqual([]);
  });

  // The Sarv service is the other provider of the ONE setting: asked as mail
  // arrives, with the user's own bearer — and then no list operator hears
  // from this machine at all. Behaviour changed (reputation-token fix): this
  // used to send the bearer to whatever https address was saved; only Sarv's
  // reputation origin is asked now, and never through a redirect.
  it('asks the Sarv service instead of any DNS zone when the settings name it', async () => {
    store(saved({ provider: 'sarv', endpoint: SARV_REP }));
    h.accounts = [{ provider: 'sarv', email: 'rc@sarv.example' }];
    const engine = wired();

    await engine.lookup!({ ip: SENDER_IP, domains: ['sender.example'] });
    expect(h.fetchCalls.map((c) => c.url)).toEqual([`${SARV_REP}/v1/reputation/lookup`]);
    expect(h.fetchCalls[0]!.init.redirect).toBe('error');
    expect(h.fetchCalls[0]!.init.headers?.authorization).toBe('Bearer tok-rc@sarv.example');
    expect(JSON.parse(h.fetchCalls[0]!.init.body ?? '{}')).toEqual({ ips: [SENDER_IP], domains: ['sender.example'] });
    expect(asked()).toEqual([]);
  });

  it('asks nobody for the Sarv service without an address', async () => {
    store(saved({ provider: 'sarv', endpoint: '' }));
    h.accounts = [{ provider: 'sarv', email: 'rc@sarv.example' }];
    const engine = wired();

    await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
    expect(h.fetchCalls).toEqual([]);
    expect(asked()).toEqual([]);
  });

  // Regression: one stage for the process. Two accounts receiving the same
  // newsletter must ask the operator once between them, not once each.
  it('gives every engine the same lookup, and the same answers', async () => {
    store(saved({ zones: ['spamhaus-zen'] }));
    const first = wired();
    const second = wired();

    expect(first.lookup).toBe(second.lookup);
    await first.lookup!({ ip: SENDER_IP });
    await second.lookup!({ ip: SENDER_IP });
    expect(asked()).toEqual([`${REVERSED}.zen.spamhaus.org`]);
  });

  // THE fail-closed rule. The default is "ask everybody", so a core DB that
  // cannot be read — the 2026-09-09 ABI mismatch, a corrupt file — must not
  // read as the default for a user who switched it off: an unreadable store
  // and an empty one are the same value and opposite facts. Nobody is asked
  // until a read succeeds, and then the real settings apply.
  it('asks nobody while the settings cannot be read, and applies them once they can', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      store(saved({ zones: ['spamhaus-zen'] }));
      h.settingsUnreadable = true;
      const engine = wired();

      await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
      expect(asked()).toEqual([]);
      expect(getReputationSettings()).toBeNull();

      // Readable again. A lookup retries on its own cadence — an unopenable
      // core DB must not cost every arriving message a fresh attempt.
      h.settingsUnreadable = false;
      await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
      vi.setSystemTime(Date.now() + SETTINGS_RETRY_MS);
      await engine.lookup!({ ip: SENDER_IP });
      expect(asked()).toEqual([`${REVERSED}.zen.spamhaus.org`]);
    } finally {
      vi.useRealTimers();
    }
  });

  // ...and a settings write retries at once. The stage and its answers are
  // kept through the unreadable spell — nothing is ASKED while it lasts, not
  // even from the cache, because the user may have switched it off — and a
  // store that reads again unchanged picks up where it was.
  it('keeps the stage through an unreadable spell and resumes on the next settings write', async () => {
    store(saved({ zones: ['spamhaus-zen'] }));
    const engine = wired();
    await engine.lookup!({ ip: SENDER_IP });

    h.settingsUnreadable = true;
    noteAppSettingChanged(SETTINGS_KEY);
    await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
    expect(linkReputationStage()).toBeNull();

    h.settingsUnreadable = false;
    noteAppSettingChanged(SETTINGS_KEY);
    await expect(engine.lookup!({ ip: SENDER_IP })).resolves.not.toBeNull();
    expect(asked()).toEqual([`${REVERSED}.zen.spamhaus.org`]); // the answer came from the one cache
  });
});

describe('noteAppSettingChanged', () => {
  // Regression: a zone added in Settings must be queried on the next message,
  // not after the next restart. The engine is never re-wired, so this only
  // works if the lookup reads the CURRENT stage rather than capturing one.
  it('reaches an already-wired engine when the settings change', async () => {
    store({ enabled: false, zones: [], servers: [], chosen: true });
    const engine = wired();
    await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();

    store(saved({ zones: ['spamcop'] }));
    noteAppSettingChanged(SETTINGS_KEY);

    await engine.lookup!({ ip: SENDER_IP });
    expect(asked()).toEqual([`${REVERSED}.bl.spamcop.net`]);
  });

  // Regression: switching it off has to stop the queries immediately, for the
  // same reason switching it on has to start them immediately.
  it('stops asking when the user turns it off', async () => {
    store(saved({ zones: ['spamcop'] }));
    const engine = wired();

    store(saved({ enabled: false, zones: ['spamcop'] }));
    noteAppSettingChanged(SETTINGS_KEY);

    await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
    expect(asked()).toEqual([]);
  });

  // Regression: the cache holds verdicts reached under the OLD zone list. A
  // user who has just added a zone expects the next message to be asked about,
  // so a real change must build a new stage AND empty the one cache — which
  // is on disk now, so it would otherwise outlive the change by hours.
  it('rebuilds the stage, and clears the cache, when the zone list changes', async () => {
    store(saved({ zones: ['spamcop'] }));
    const engine = wired();
    await engine.lookup!({ ip: SENDER_IP });
    expect(getReputationCache().count()).toBe(1);

    store(saved({ zones: ['spamcop', 'spamhaus-zen'] }));
    noteAppSettingChanged(SETTINGS_KEY);
    expect(getReputationCache().count()).toBe(0);

    await engine.lookup!({ ip: SENDER_IP });
    expect(asked()).toEqual([`${REVERSED}.bl.spamcop.net`, `${REVERSED}.bl.spamcop.net`, `${REVERSED}.zen.spamhaus.org`]);
  });

  // Regression: the settings blob is written on every unrelated change — a
  // signature edit, a view-mode toggle. Rebuilding on each one would throw the
  // cache away constantly and turn a quiet feature into steady DNS traffic.
  it('keeps the same stage, and its answers, when the blob changes but this section does not', async () => {
    store(saved({ zones: ['spamcop'] }));
    const engine = wired();
    await engine.lookup!({ ip: SENDER_IP });

    store(saved({ zones: ['spamcop'] }), { signature: 'a new signature' });
    noteAppSettingChanged(SETTINGS_KEY);
    await engine.lookup!({ ip: SENDER_IP });

    expect(asked()).toHaveLength(1);
  });

  // Link lookups, registration dates and reports change what the background
  // pass does, not what any cached answer means: the cache stays, and the pass
  // is told so it does not wait out its idle cadence.
  it('keeps the answers but tells the pass when only the background choices change', async () => {
    store(saved({ zones: ['spamcop'] }));
    const engine = wired();
    await engine.lookup!({ ip: SENDER_IP });
    const told = vi.fn();
    const off = onReputationSettingsChanged(told);

    store(saved({ zones: ['spamcop'], links: true, domainAge: false }));
    noteAppSettingChanged(SETTINGS_KEY);

    expect(told).toHaveBeenCalledTimes(1);
    expect(getReputationCache().count()).toBe(1);
    expect(getReputationSettings()).toMatchObject({ links: true, domainAge: false });
    off();
    noteAppSettingChanged(SETTINGS_KEY);
    store(saved({ zones: ['spamcop'] }));
    noteAppSettingChanged(SETTINGS_KEY);
    expect(told).toHaveBeenCalledTimes(1);
  });

  // A cache that cannot be emptied must not keep the new settings from
  // applying — the lists the user just chose are asked all the same.
  it('applies a settings change even when the cache cannot be cleared', async () => {
    store(saved({ zones: ['spamcop'] }));
    const engine = wired();
    await engine.lookup!({ ip: SENDER_IP });
    (h.db as Database.Database).close();

    store(saved({ zones: ['spamhaus-zen'] }));
    noteAppSettingChanged(SETTINGS_KEY);
    await engine.lookup!({ ip: SENDER_IP });

    expect(asked()).toEqual([`${REVERSED}.bl.spamcop.net`, `${REVERSED}.zen.spamhaus.org`]);
  });

  it('ignores every other settings key', async () => {
    store(saved({ zones: ['spamcop'] }));
    const engine = wired();

    store(saved({ zones: ['spamhaus-zen'] }));
    noteAppSettingChanged('sarvinbox-view-mode');

    await engine.lookup!({ ip: SENDER_IP });
    expect(asked()).toEqual([`${REVERSED}.bl.spamcop.net`]);
  });
});

describe('linkReputationStage', () => {
  // The background pass asks about link domains only when the user opted in,
  // and then through the SAME stage — so an answer the ingest check already
  // has is not asked for again.
  it('is null unless link lookups are on, and is the ingest stage when they are', async () => {
    store(saved({ zones: ['spamhaus-dbl'] }));
    const engine = wired();
    expect(linkReputationStage()).toBeNull();

    store(saved({ zones: ['spamhaus-dbl'], links: true }));
    noteAppSettingChanged(SETTINGS_KEY);
    await engine.lookup!({ domains: ['shared.example'] });
    const result = await linkReputationStage()!.lookup({ ips: [], domains: ['shared.example', 'linked.example'] });

    expect(result.domains.get('shared.example')?.status).toBe('clean');
    expect(asked()).toEqual(['shared.example.dbl.spamhaus.org', 'linked.example.dbl.spamhaus.org']);

    store(saved({ zones: ['spamhaus-dbl'], links: true, enabled: false }));
    noteAppSettingChanged(SETTINGS_KEY);
    expect(linkReputationStage()).toBeNull();
  });
});

describe('the one cache', () => {
  const listedSpam = (list: string): ItemReputation => ({ status: 'listed', hits: [{ list, category: 'spam', detail: `${list} says spam` }] });
  const clean: ItemReputation = { status: 'clean', hits: [] };

  it('serves a fresh answer, forgets it after its TTL, and gives an unknown an older build stored a short life', () => {
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

  it('reads a corrupt hits column as no hits, and keeps user report counts', () => {
    const db = new Database(':memory:');
    const cache = new ReputationCache(db);
    cache.set('ip', '1.1.1.1', clean, 'test', T0);
    db.prepare("UPDATE reputation_cache SET hits = '{bad' WHERE item = '1.1.1.1'").run();
    expect(cache.get('ip', '1.1.1.1', T0)).toMatchObject({ status: 'clean', hits: [] });
    cache.set('domain', 'x.example', { status: 'clean', hits: [], userReports: 7 }, 'sarv', T0);
    expect(cache.get('domain', 'x.example', T0)).toMatchObject({ userReports: 7 });
  });

  // Regression: the in-memory cache this replaced was bounded; a table that
  // only ever grows would hold every sender the user has ever heard from.
  it('prunes only answers too old to be served, and clears everything on demand', () => {
    const cache = new ReputationCache(new Database(':memory:'));
    cache.set('ip', '1.1.1.1', clean, 'test', T0);
    cache.set('ip', '2.2.2.2', clean, 'test', T0 + 100);
    expect(cache.prune(T0 + REPUTATION_CACHE_TTL_S + 50)).toBe(1);
    expect(cache.get('ip', '2.2.2.2', T0 + 100)).not.toBeNull();
    cache.clear();
    expect(cache.count()).toBe(0);
  });

  // The cache is on the core DB, so an answer survives the stage being rebuilt
  // at the next start: the morning's first sync does not re-ask about
  // yesterday's senders.
  it('lives on the core DB and serves a new stage what an old one learned', async () => {
    store(saved({ zones: ['spamcop'] }));
    await wired().lookup!({ ip: SENDER_IP });
    const db = h.db;

    resetReputationForTests();
    h.db = db;
    await wired().lookup!({ ip: SENDER_IP });

    expect(asked()).toEqual([`${REVERSED}.bl.spamcop.net`]);
    expect(getReputationCache().get('ip', SENDER_IP, Math.floor(Date.now() / 1000))).toMatchObject({ status: 'clean' });
  });
});

describe('the report loop', () => {
  // Behaviour changed (reputation-token fix): reports go to Sarv's reputation
  // origin only, so that is the address these settings name.
  const on = saved({ provider: 'sarv', endpoint: SARV_REP, reports: true });
  const provider = (report = vi.fn<(report: SenderReport) => Promise<boolean>>().mockResolvedValue(true)): ReputationProvider & { report: typeof report } => ({
    name: 'sarv', lookup: async () => ({ provider: 'sarv', ips: new Map(), domains: new Map() }), report,
  });
  const verdict: SenderReport = { domain: 'spam.example', ip: '1.2.3.4', verdict: 'spam' };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // The one thing here that leaves the machine because the user did something:
  // only with the Sarv service, its address, the opt-in — and the switch on.
  it('is allowed only with the Sarv service, an address, the opt-in and the switch on', () => {
    expect(reportsAllowed(on)).toBe(true);
    expect(reportsAllowed({ ...on, reports: false })).toBe(false);
    expect(reportsAllowed({ ...on, endpoint: '' })).toBe(false);
    expect(reportsAllowed({ ...on, provider: 'local' })).toBe(false);
    expect(reportsAllowed({ ...on, enabled: false })).toBe(false);
  });

  it('sends the verdict through the provider when allowed, and nothing otherwise', async () => {
    const p = provider();
    reportSenderVerdict(verdict, { settings: on, provider: p });
    await settle();
    expect(p.report).toHaveBeenCalledWith(verdict);
    reportSenderVerdict(verdict, { settings: { ...on, reports: false }, provider: p });
    reportSenderVerdict(verdict, { settings: null, provider: p });
    await settle();
    expect(p.report).toHaveBeenCalledTimes(1);
    // A provider without a report channel, or one that rejects, is fine.
    reportSenderVerdict(verdict, { settings: on, provider: { name: 'x', lookup: p.lookup } });
    reportSenderVerdict(verdict, { settings: on, provider: provider(vi.fn<(report: SenderReport) => Promise<boolean>>().mockRejectedValue(new Error('down'))) });
    await settle();
  });

  it('builds the provider from the stored settings when given none, and reaches the service', async () => {
    store(on);
    h.accounts = [{ provider: 'sarv', email: 'rc@sarv.example' }];
    reportSenderVerdict(verdict);
    await settle();
    expect(h.fetchCalls.map((c) => c.url)).toEqual([`${SARV_REP}/v1/reputation/report`]);
    expect(h.fetchCalls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(h.fetchCalls[0]!.init.body ?? '{}')).toEqual({ domain: 'spam.example', ip: '1.2.3.4', verdict: 'spam' });
  });

  // Regression: a store that cannot be read is not permission to report.
  it('sends nothing while the stored settings cannot be read', async () => {
    store(on);
    h.settingsUnreadable = true;
    const p = provider();
    reportSenderVerdict(verdict, { provider: p });
    await settle();
    expect(p.report).not.toHaveBeenCalled();
  });
});

/**
 * Where the Sarv bearer goes. The address is a setting the renderer writes, and
 * the bearer is also the Sarv mailbox's XOAUTH2 credential, so main asks Sarv's
 * reputation origin or nobody — deciding before the token store is read — and
 * a refused address is permanent until the settings change.
 */
describe('the Sarv bearer goes to Sarv’s reputation service only', () => {
  const sarvAccount = { provider: 'sarv', email: 'rc@sarv.example' };

  // Breaks (CASA): a renderer-written setting sends the Sarv mailbox token, and
  // every arriving sender, to its own server.
  it.each([
    'https://rep.sarv.example',
    'https://reputation.sarv.test.evil.example',
    'https://evilsarv.com',
    'https://user:pw@reputation.sarv.test',
    'https://reputation.sarv.test:8443',
  ])('asks nobody and mints no token when the saved address is %j', async (endpoint) => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint, links: true }));
      h.accounts = [sarvAccount];
      const engine = wired();

      await expect(engine.lookup!({ ip: SENDER_IP, domains: ['sender.example'] })).resolves.toBeNull();
      expect(h.fetchCalls).toEqual([]);
      expect(oauth.listSignedInAccounts).not.toHaveBeenCalled();
      expect(oauth.getValidAccessToken).not.toHaveBeenCalled();
      expect(blocklistProviderName()).toBeNull();
      expect(linkReputationStage()).toBeNull();
    } finally {
      log.restore();
    }
  });

  // Breaks: a user who chose Sarv to keep list operators out has their senders
  // queried from this machine instead.
  it('does not fall back to this computer’s DNS when the address is refused', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: 'https://rep.sarv.example', zones: [...DEFAULT_ZONES] }));
      const engine = wired();

      await engine.lookup!({ ip: SENDER_IP, domains: ['sender.example'] });
      expect(asked()).toEqual([]);
    } finally {
      log.restore();
    }
  });

  // Breaks: a per-message warn stalls the ingest event loop on a first sync, or
  // app.log records credentials typed into the URL, its path or its query.
  it('logs the refusal once per settings change, naming only the address’s origin', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: 'https://user:secret@evil.example:8443/steal?q=token' }));
      const engine = wired();
      for (let i = 0; i < 50; i += 1) await engine.lookup!({ ip: `185.199.108.${i + 1}` });
      noteAppSettingChanged(SETTINGS_KEY); // the same settings, written again
      reportSenderVerdict({ domain: 'spam.example', ip: null, verdict: 'spam' });

      const warns = log.lines.filter((l) => l.level === 'warn').map((l) => l.line);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('(https://evil.example:8443) is not Sarv\'s');
      expect(warns[0]).not.toMatch(/user|secret|steal|token/);

      store(saved({ provider: 'sarv', endpoint: 'https://another.example' }));
      noteAppSettingChanged(SETTINGS_KEY);
      expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
      expect(log.lines.some((l) => l.line.includes('Blocklist lookups on'))).toBe(false);
    } finally {
      log.restore();
    }
  });

  // Breaks: another provider's token (Gmail's restricted scope) or a second
  // Sarv account's token is minted for the reputation service, the typed
  // spelling rather than the checked origin is fetched, or a redirect can carry
  // the bearer away.
  it('asks with the first signed-in Sarv account’s bearer only, at the canonical origin, with no redirects', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: 'https://Reputation.Sarv.test/' }));
      h.accounts = [
        { provider: 'gmail', email: 'a@gmail.example' },
        { provider: 'sarv', email: 'b@sarv.example' },
        { provider: 'sarv', email: 'c@sarv.example' },
      ];
      const engine = wired();

      await engine.lookup!({ ip: SENDER_IP });
      expect(oauth.getValidAccessToken).toHaveBeenCalledTimes(1);
      expect(oauth.getValidAccessToken).toHaveBeenCalledWith('sarv', 'b@sarv.example');
      expect(h.fetchCalls.map((c) => [c.url, c.init.redirect, c.init.headers?.authorization])).toEqual([
        [`${SARV_REP}/v1/reputation/lookup`, 'error', 'Bearer tok-b@sarv.example'],
      ]);
      expect(blocklistProviderName()).toBe('sarv');
      // The info line names the origin asked, not what was typed.
      expect(log.lines.some((l) => l.level === 'info' && l.line.includes(`the Sarv service at ${SARV_REP}`))).toBe(true);
      expect(log.lines.some((l) => l.line.includes('Reputation.Sarv.test'))).toBe(false);
    } finally {
      log.restore();
    }
  });

  // Breaks: main's own redirect rule, under core's, is dropped. A core change
  // that let a redirect through would then carry the bearer to wherever
  // Location points, and no other test would notice.
  it('refuses redirects in main’s own transport, whatever the provider asks for', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: 'https://REPUTATION.sarv.test.:443/' }));
      wired();

      expect(h.sarvDeps).toHaveLength(1);
      const deps = h.sarvDeps[0]!;
      expect(deps.endpoint).toBe(SARV_REP); // the checked origin, not the typed spelling
      const init = { method: 'POST', headers: {}, body: '{}', redirect: 'follow' } as unknown as Parameters<SarvReputationDeps['fetch']>[1];
      await deps.fetch(`${SARV_REP}/v1/reputation/lookup`, init);
      expect(h.fetchCalls.map((c) => c.init.redirect)).toEqual(['error']);
    } finally {
      log.restore();
    }
  });

  // Breaks: the provider falls back to whatever token exists, or counts "not
  // signed in" as an outage that pauses it after the user does sign in.
  it('sends nothing, and mints no Gmail token, while only other providers are signed in', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: SARV_REP }));
      h.accounts = [{ provider: 'gmail', email: 'a@gmail.example' }, { provider: 'microsoft', email: 'm@outlook.example' }];
      const engine = wired();

      for (let i = 0; i < 8; i += 1) await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
      expect(h.fetchCalls).toEqual([]);
      expect(oauth.getValidAccessToken).not.toHaveBeenCalled();

      h.accounts = [...h.accounts, sarvAccount];
      await engine.lookup!({ ip: SENDER_IP });
      expect(h.fetchCalls).toHaveLength(1);
      expect(oauth.getValidAccessToken).toHaveBeenCalledWith('sarv', sarvAccount.email);
    } finally {
      log.restore();
    }
  });

  // Breaks: a connection blip becomes hours of "no opinion" or a cached
  // "clean", or the next message is not asked at all.
  it('asks again on the next message after a network failure, and caches only a real answer', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: SARV_REP }));
      h.accounts = [sarvAccount];
      h.sarvAnswer = { ips: [{ ip: SENDER_IP, status: 'clean' }], domains: [] };
      h.fetchFailures = 1;
      const engine = wired();

      await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
      expect(getReputationCache().count()).toBe(0);
      await expect(engine.lookup!({ ip: SENDER_IP })).resolves.not.toBeNull();
      expect(getReputationCache().count()).toBe(1);
      await engine.lookup!({ ip: SENDER_IP });
      expect(h.fetchCalls).toHaveLength(2); // the third came from the cache
    } finally {
      log.restore();
    }
  });

  // Breaks: fixing the address does nothing until a restart, or answers given
  // while another address was saved survive the fix.
  it('starts asking, with a cleared cache, as soon as a refused address is corrected', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: 'https://rep.sarv.example' }));
      h.accounts = [sarvAccount];
      const engine = wired();
      await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
      getReputationCache().set('ip', SENDER_IP, { status: 'listed', hits: [{ list: 'Old', category: 'spam', detail: 'from before' }] }, 'sarv', Math.floor(Date.now() / 1000));

      store(saved({ provider: 'sarv', endpoint: SARV_REP }));
      noteAppSettingChanged(SETTINGS_KEY);
      expect(getReputationCache().count()).toBe(0);
      await engine.lookup!({ ip: SENDER_IP });
      expect(h.fetchCalls.map((c) => c.url)).toEqual([`${SARV_REP}/v1/reputation/lookup`]);
      expect(blocklistProviderName()).toBe('sarv');
    } finally {
      log.restore();
    }
  });

  // Breaks: pressing Report spam (or a bulk report, one call per domain) sends
  // the bearer to the refused host, builds a provider for it, or logs a line
  // per domain.
  it('reports nothing, builds nothing and mints no token for a refused address', async () => {
    const log = captureLog();
    try {
      const refused = saved({ provider: 'sarv', endpoint: 'https://rep.sarv.example', reports: true });
      expect(reportsAllowed(refused)).toBe(false);
      expect(reportsAllowed({ ...refused, endpoint: SARV_REP })).toBe(true);

      const report = vi.fn<(report: SenderReport) => Promise<boolean>>().mockResolvedValue(true);
      reportSenderVerdict({ domain: 'spam.example', ip: null, verdict: 'spam' }, { settings: refused, provider: { name: 'sarv', lookup: async () => ({ provider: 'sarv', ips: new Map(), domains: new Map() }), report } });

      store(refused);
      h.accounts = [sarvAccount];
      for (let i = 0; i < 20; i += 1) reportSenderVerdict({ domain: `d${i}.example`, ip: null, verdict: 'spam' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(report).not.toHaveBeenCalled();
      expect(h.fetchCalls).toEqual([]);
      expect(oauth.listSignedInAccounts).not.toHaveBeenCalled();
      expect(oauth.getValidAccessToken).not.toHaveBeenCalled();
      expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(1); // the settings read, not each report
    } finally {
      log.restore();
    }
  });

  // Breaks: the release app.log records which sender the user reported.
  it('logs that a verdict was reported, never the sender it was about', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: SARV_REP, reports: true }));
      h.accounts = [sarvAccount];
      reportSenderVerdict({ domain: 'reported-sender.example', ip: '203.0.113.7', verdict: 'spam' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(h.fetchCalls).toHaveLength(1);
      expect(log.lines.some((l) => l.line.includes('Reported a spam verdict'))).toBe(true);
      expect(log.lines.some((l) => /reported-sender|203\.0\.113\.7/.test(l.line))).toBe(false);

      // A report the service did not accept is not claimed as sent.
      const lines = log.lines.length;
      const declined = vi.fn<(report: SenderReport) => Promise<boolean>>().mockResolvedValue(false);
      reportSenderVerdict({ domain: 'x.example', ip: null, verdict: 'ham' }, { provider: { name: 'sarv', lookup: async () => ({ provider: 'sarv', ips: new Map(), domains: new Map() }), report: declined } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(declined).toHaveBeenCalledTimes(1);
      expect(log.lines).toHaveLength(lines);
    } finally {
      log.restore();
    }
  });
});

/**
 * A dev build's SARVINBOX_SARV_REPUTATION_BASE_URL is applied by
 * initializeOAuth, which startup runs AFTER the first engine is wired, so the
 * stage is first built against the registry as the build ships it. It has to
 * follow the registry when that moves, not wait for the next settings write.
 */
describe('the stage follows the Sarv registry when it is re-pointed', () => {
  const DEV_REP = 'https://rep.dev.example';
  const sarvAccount = { provider: 'sarv', email: 'rc@sarv.example' };
  afterEach(() => setSarvBaseUrl({ reputationBase: SARV_REP }));

  // Breaks: the dev override does nothing on a normal launch. The dev service
  // stays refused, with a "not Sarv's" warn, until the user edits the setting.
  it('starts asking the dev service as soon as the registry names it', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: DEV_REP }));
      h.accounts = [sarvAccount];
      const engine = wired();
      await expect(engine.lookup!({ ip: SENDER_IP })).resolves.toBeNull();
      expect(h.fetchCalls).toEqual([]);

      setSarvBaseUrl({ reputationBase: DEV_REP });
      await engine.lookup!({ ip: SENDER_IP });
      expect(h.fetchCalls.map((c) => c.url)).toEqual([`${DEV_REP}/v1/reputation/lookup`]);
      expect(blocklistProviderName()).toBe('sarv');
      expect(log.lines.some((l) => l.level === 'info' && l.line.includes(`the Sarv service at ${DEV_REP}`))).toBe(true);
    } finally {
      log.restore();
    }
  });

  // Breaks: once a dev build re-points the registry, production keeps getting
  // the dev sign-in's bearer from the old provider, and its answers stay cached.
  it('stops asking the old origin, and forgets its answers, once the registry moves away from it', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: SARV_REP }));
      h.accounts = [sarvAccount];
      h.sarvAnswer = { ips: [{ ip: SENDER_IP, status: 'clean' }], domains: [] };
      const engine = wired();
      await engine.lookup!({ ip: SENDER_IP });
      expect(getReputationCache().count()).toBe(1);
      oauth.getValidAccessToken.mockClear();
      const heard = vi.fn();
      onReputationSettingsChanged(heard);

      setSarvBaseUrl({ reputationBase: DEV_REP });
      await expect(engine.lookup!({ ip: '203.0.113.50' })).resolves.toBeNull();
      expect(h.fetchCalls).toHaveLength(1); // only the lookup made before the move
      expect(oauth.getValidAccessToken).not.toHaveBeenCalled();
      expect(getReputationCache().count()).toBe(0);
      expect(blocklistProviderName()).toBeNull();
      expect(heard).toHaveBeenCalledTimes(1); // the background pass hears whom it now asks
      expect(log.lines.filter((l) => l.level === 'warn').map((l) => l.line)).toEqual([
        expect.stringContaining(`(${SARV_REP}) is not Sarv's`),
      ]);
    } finally {
      log.restore();
    }
  });

  // Breaks: every registry write (startup sets it even when nothing changed)
  // rebuilds the stage and throws away every cached answer.
  it('keeps the stage and its answers when the registry is written but the origin does not change', async () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: SARV_REP }));
      h.accounts = [sarvAccount];
      h.sarvAnswer = { ips: [{ ip: SENDER_IP, status: 'clean' }], domains: [] };
      const engine = wired();
      await engine.lookup!({ ip: SENDER_IP });

      setSarvBaseUrl({});
      setSarvBaseUrl({ reputationBase: SARV_REP });
      await engine.lookup!({ ip: SENDER_IP });
      expect(h.fetchCalls).toHaveLength(1); // the second answer came from the cache
      expect(h.sarvDeps).toHaveLength(1); // one provider, never rebuilt
    } finally {
      log.restore();
    }
  });

  // Breaks: a registry move rebuilds the local-DNS stage, clearing its answers,
  // although the Sarv address plays no part in it.
  it('leaves a local-DNS stage and its answers alone', async () => {
    store(saved({ zones: ['spamhaus-zen'] }));
    h.answers[`${REVERSED}.zen.spamhaus.org`] = ['127.0.0.2'];
    const engine = wired();
    await engine.lookup!({ ip: SENDER_IP });

    setSarvBaseUrl({ reputationBase: DEV_REP });
    await engine.lookup!({ ip: SENDER_IP });
    expect(asked()).toEqual([`${REVERSED}.zen.spamhaus.org`]); // answered from the cache
  });
});

/**
 * Every build ships with no reputation origin: Sarv runs no such service yet.
 * A Sarv choice saved when the tab offered it must then ask nobody, with one
 * warn saying why, and never move to this computer's DNS.
 */
describe('with no Sarv reputation service configured, as every build ships', () => {
  const sarvAccount = { provider: 'sarv', email: 'rc@sarv.example' };
  const NO_SERVICE = "set to ask Sarv's reputation service, which this build has no address for";
  beforeEach(() => setSarvBaseUrl({ reputationBase: '' }));

  // Breaks: the Sarv bearer goes to whatever address the saved choice names
  // (the address this fix first built in had no DNS record, so whoever
  // registered it would have received it); or the lookups quietly move to
  // this computer's DNS, asking list operators the user chose not to ask; or
  // app.log does not say why blocklists are off.
  it('asks nobody, mints no token, reports nothing, does not switch to DNS, and warns once why', async () => {
    const log = captureLog();
    try {
      const choice = saved({ provider: 'sarv', endpoint: 'https://reputation.sarv.com', reports: true });
      store(choice);
      h.accounts = [sarvAccount];
      const engine = wired();
      await expect(engine.lookup!({ ip: SENDER_IP, domains: ['sender.example'] })).resolves.toBeNull();
      await engine.lookup!({ ip: '203.0.113.50' });
      reportSenderVerdict({ domain: 'spam.example', ip: null, verdict: 'spam' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(h.fetchCalls).toEqual([]);
      expect(h.queries).toEqual([]);
      expect(h.sarvDeps).toEqual([]);
      expect(oauth.listSignedInAccounts).not.toHaveBeenCalled();
      expect(oauth.getValidAccessToken).not.toHaveBeenCalled();
      expect(blocklistProviderName()).toBeNull();
      expect(reportsAllowed(choice)).toBe(false);
      const warns = log.lines.filter((l) => l.level === 'warn').map((l) => l.line);
      expect(warns).toEqual([expect.stringContaining(NO_SERVICE)]);
      expect(warns[0]).not.toContain('reputation.sarv.com');
    } finally {
      log.restore();
    }
  });

  // Breaks: a Sarv choice with no address saved reads as plain "off" in
  // app.log, so nothing says the choice itself is what keeps blocklists off.
  it('gives the same reason when the Sarv choice has no address saved', () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: '' }));
      wired();
      expect(log.lines.filter((l) => l.level === 'warn').map((l) => l.line)).toEqual([expect.stringContaining(NO_SERVICE)]);
    } finally {
      log.restore();
    }
  });

  // Breaks: blocklists turned off, or set to this computer's DNS, start
  // warning about a Sarv service they never asked for.
  it('says nothing about Sarv when the switch is off or local DNS is chosen', () => {
    const log = captureLog();
    try {
      store(saved({ provider: 'sarv', endpoint: '', enabled: false }));
      wired();
      store(saved({ zones: ['spamhaus-zen'] }));
      noteAppSettingChanged(SETTINGS_KEY);
      expect(log.lines.some((l) => l.line.includes(NO_SERVICE))).toBe(false);
      expect(blocklistProviderName()).toBe('local-dnsbl');
    } finally {
      log.restore();
    }
  });
});

/** What the service logs about its own failures: the failure's code, never what the user typed. */
describe('its own failures in the log', () => {
  // Breaks: whatever was typed into the resolver field (node's message quotes
  // it) reaches the release app.log.
  it('names how many resolvers were unusable and why, not what was typed', async () => {
    const log = captureLog();
    try {
      store(saved({ servers: ['10.0.0.1', 'office-dns.corp.example'] }));
      wired();
      const warns = log.lines.filter((l) => l.level === 'warn').map((l) => l.line);
      expect(warns).toEqual([expect.stringContaining('Blocklist resolvers not usable (2 named): ERR_INVALID_IP_ADDRESS')]);
      expect(warns[0]).not.toMatch(/office-dns|10\.0\.0\.1/);
    } finally {
      log.restore();
    }
  });

  // Breaks: an unreadable store's or a closed cache's error message (which can
  // carry a file path or SQL) reaches the release app.log.
  it('names only the class of a failed settings read or cache clear', async () => {
    const log = captureLog();
    try {
      h.settingsUnreadable = true;
      wired();
      noteAppSettingChanged(SETTINGS_KEY); // still unreadable: said once, not per read
      h.settingsUnreadable = false;
      store(saved({ zones: ['spamcop'] }));
      noteAppSettingChanged(SETTINGS_KEY);
      (h.db as Database.Database).close();
      store(saved({ zones: ['spamhaus-zen'] }));
      noteAppSettingChanged(SETTINGS_KEY);

      const warns = log.lines.filter((l) => l.level === 'warn').map((l) => l.line);
      expect(warns).toEqual([
        expect.stringMatching(/Blocklist settings unreadable — asking nobody until they can be read: Error$/),
        expect.stringMatching(/Blocklist cache not cleared: TypeError$/),
      ]);
      expect(warns.join('\n')).not.toMatch(/not a database|connection is not open/);
    } finally {
      log.restore();
    }
  });

  // Breaks: the info line stops saying which resolvers ask, which is how a
  // network an operator refuses is told from a list that is down. They are
  // logged only once node has accepted each as an address, so they are never
  // free text (see the unusable case above).
  it('names the resolvers it asks through once they are usable', async () => {
    const log = captureLog();
    try {
      store(saved({ zones: ['spamhaus-zen'], servers: ['10.0.0.1', '10.0.0.2'], links: true }));
      wired();
      expect(log.lines.filter((l) => l.level === 'info').map((l) => l.line)).toEqual([
        expect.stringContaining('Blocklist lookups on: spamhaus-zen via 10.0.0.1, 10.0.0.2, link domains included'),
      ]);
    } finally {
      log.restore();
    }
  });
});

describe('availableBlocklists', () => {
  // If a zone stops appearing, the user simply cannot choose it, with no
  // error anywhere to say so.
  it('describes every zone this build can query', () => {
    const names = availableBlocklists().map((list) => list.name);
    expect(names).toEqual(expect.arrayContaining(['spamhaus-zen', 'spamhaus-dbl', 'spamcop']));
    expect(availableBlocklists().every((list) => list.zone.includes('.'))).toBe(true);
  });
});
