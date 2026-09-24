import { SPAMCOP, SPAMHAUS_DBL, SPAMHAUS_ZEN, type Blocklist } from '@sarv-in/mailguard';
import { describe, expect, it, vi } from 'vitest';

import {
  ReputationStage,
  type ReputationCacheStore,
  type ReputationItemKind,
} from '../../../src/imap/reputation-stage';
import { DEFAULT_FAILURE_THRESHOLD, type CircuitBreakerOptions } from '../../../src/utils/circuit-breaker';
import {
  LocalDnsblProvider,
  SarvReputationProvider,
  type ItemReputation,
  type ReputationProvider,
} from '../../../src/utils/spam-reputation';

/** A public unicast address — the only kind a blocklist is ever asked about. */
const SENDER_IP = '93.184.216.34';
const LISTED_NAME = '34.216.184.93.zen.spamhaus.org';

/**
 * A resolver that answers from a table and counts what it was asked. An absent
 * name is NXDOMAIN — "not listed" — exactly as `dns.resolve4` reports it.
 */
function fakeDns(answers: Readonly<Record<string, string[] | Error>> = {}): {
  resolve4: (name: string) => Promise<string[]>;
  asked: string[];
} {
  const asked: string[] = [];
  const resolve4 = (name: string): Promise<string[]> => {
    asked.push(name);
    const answer = answers[name];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === undefined) return Promise.reject(Object.assign(new Error(`queryA ENOTFOUND ${name}`), { code: 'ENOTFOUND' }));
    return Promise.resolve(answer);
  };
  return { resolve4, asked };
}

/**
 * The store's side of the contract, in memory: fresh-or-null by the store's own
 * TTL, and a count of what was written so a test can see what was NOT.
 */
function memoryCache(ttlSec = 6 * 60 * 60): ReputationCacheStore & { writes: string[] } {
  const rows = new Map<string, { rep: ItemReputation; at: number }>();
  const writes: string[] = [];
  return {
    writes,
    get: (kind: ReputationItemKind, item: string, nowSec: number) => {
      const row = rows.get(`${kind}:${item}`);
      return row && nowSec - row.at <= ttlSec ? row.rep : null;
    },
    set: (kind: ReputationItemKind, item: string, rep: ItemReputation, _provider: string, nowSec: number) => {
      writes.push(`${kind}:${item}`);
      rows.set(`${kind}:${item}`, { rep, at: nowSec });
    },
  };
}

/** A stage over this computer's DNS, with a fake clock so TTLs and breakers are testable without waiting. */
function stageWith(
  dns: ReturnType<typeof fakeDns>,
  opts: { lists?: readonly Blocklist[]; breaker?: CircuitBreakerOptions; cache?: ReputationCacheStore; clock?: { now: number } } = {},
): { stage: ReputationStage; provider: LocalDnsblProvider } {
  const clock = opts.clock ?? { now: 1_000_000_000 };
  const provider = new LocalDnsblProvider({
    resolve4: dns.resolve4,
    lists: opts.lists ?? [SPAMHAUS_ZEN],
    breaker: { now: () => clock.now, ...opts.breaker },
  });
  return { stage: new ReputationStage(provider, opts.cache ?? memoryCache(), { now: () => clock.now }), provider };
}

describe('ReputationStage', () => {
  // THE gate on the whole feature. Every query tells a third-party operator
  // about a sender this user receives mail from, and several operators charge
  // for volume — so a provider with no zones must send nothing at all, not
  // "the usual ones".
  it('asks nothing through a provider with no zones configured', async () => {
    const dns = fakeDns();
    const { stage } = stageWith(dns, { lists: [] });

    expect(await stage.assess({ ip: SENDER_IP, domains: ['example.com'] })).toBeNull();
    expect(dns.asked).toEqual([]);
  });

  it('scores a listed sender so the caller can add it to the message', async () => {
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const { stage } = stageWith(dns);

    const assessment = await stage.assess({ ip: SENDER_IP });

    expect(assessment?.score).toBe(4);
    expect(assessment?.reasons[0]?.id).toBe('reputation-ip-listed');
  });

  // Regression: an ingest loop asks about the same few hundred senders over
  // thousands of messages. Without the cache a 6,000-message sync is 6,000
  // round trips to somebody else's resolver — slow, and the kind of traffic
  // that gets a client blocked outright.
  it('asks about a sender once and reuses the answer', async () => {
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const { stage } = stageWith(dns);

    for (let i = 0; i < 5; i += 1) await stage.assess({ ip: SENDER_IP });

    expect(dns.asked).toEqual([LISTED_NAME]);
  });

  // Regression: the cache is per ITEM. One mail server relays for many From
  // domains; the answer about the server is the same whichever domain rode
  // on it, so the second message must not ask about the server again.
  it('shares the answer about an address between messages with different sender domains', async () => {
    const dns = fakeDns();
    const { stage } = stageWith(dns, { lists: [SPAMHAUS_ZEN, SPAMHAUS_DBL] });

    await stage.assess({ ip: SENDER_IP, domains: ['one.example'] });
    await stage.assess({ ip: SENDER_IP, domains: ['two.example'] });

    expect(dns.asked.filter((name) => name === LISTED_NAME)).toHaveLength(1);
    expect(dns.asked).toEqual(expect.arrayContaining(['one.example.dbl.spamhaus.org', 'two.example.dbl.spamhaus.org']));
  });

  // Regression: a batch arrives all at once, so a dozen messages from one
  // sender must share ONE query rather than racing a dozen that each miss the
  // cache the others are about to fill.
  it('collapses concurrent lookups of the same sender into one query', async () => {
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const { stage } = stageWith(dns);

    const all = await Promise.all(
      Array.from({ length: 10 }, () => stage.assess({ ip: SENDER_IP })),
    );

    expect(dns.asked).toEqual([LISTED_NAME]);
    expect(all.every((one) => one?.score === 4)).toBe(true);
  });

  // Regression: a blocklist answer is not permanent. A sender delisted this
  // morning must stop being scored, or a cached verdict outlives the fact —
  // so the stage has to hand the store the time and take its word on freshness.
  it('asks again once the store says the cached verdict has expired', async () => {
    const clock = { now: 1_000_000_000 };
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const { stage } = stageWith(dns, { cache: memoryCache(60), clock });

    await stage.assess({ ip: SENDER_IP });
    clock.now += 59_000;
    await stage.assess({ ip: SENDER_IP });
    expect(dns.asked).toHaveLength(1);

    clock.now += 2_000;
    await stage.assess({ ip: SENDER_IP });
    expect(dns.asked).toHaveLength(2);
  });

  // Regression: an unusable target must never become a query. A private
  // address tells the operator about this user's network and nothing else,
  // and no list has anything to say about it.
  it('asks nothing when there is nothing worth asking about', async () => {
    const dns = fakeDns();
    const { stage } = stageWith(dns);

    expect(await stage.assess({})).toBeNull();
    expect(await stage.assess({ ip: null, domains: [null, '', '  '] })).toBeNull();
    expect(await stage.assess({ ip: '10.0.0.4' })).toBeNull();
    expect(dns.asked).toEqual([]);
  });

  // Regression: a lookup that failed is NOT a clean sender. Caching the
  // failure as a verdict would silence the stage for hours over one blip.
  it('adds nothing when a lookup fails, and does not cache the failure', async () => {
    const dns = fakeDns({ [LISTED_NAME]: new Error('queryA ESERVFAIL') });
    const cache = memoryCache();
    const { stage } = stageWith(dns, { cache });

    expect(await stage.assess({ ip: SENDER_IP })).toBeNull();
    expect(await stage.assess({ ip: SENDER_IP })).toBeNull();
    expect(dns.asked).toHaveLength(2);
    expect(cache.writes).toEqual([]);
  });

  // THE regression for a DESKTOP client specifically. Spamhaus and others
  // refuse queries that arrive through a public resolver — the answer is
  // 127.255.255.254, not a listing — and a laptop on its ISP's DNS or on
  // 8.8.8.8 is exactly that. Without the breaker the app sends one doomed
  // query per sender for the rest of the session, forever, to an operator
  // that has already said no.
  it('stops asking after repeated failures, and resumes after the cooldown', async () => {
    const clock = { now: 1_000_000_000 };
    const dns = fakeDns(
      Object.fromEntries(
        Array.from({ length: 20 }, (_unused, i) => [
          `${i + 10}.216.184.93.zen.spamhaus.org`,
          ['127.255.255.254'],
        ]),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { stage } = stageWith(dns, { breaker: { cooldownMs: 600_000 }, clock });

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      await stage.assess({ ip: `93.184.216.${i + 10}` });
    }
    expect(dns.asked).toHaveLength(DEFAULT_FAILURE_THRESHOLD);

    // Breaker open: further senders cost nothing at all.
    expect(await stage.assess({ ip: '93.184.216.99' })).toBeNull();
    expect(dns.asked).toHaveLength(DEFAULT_FAILURE_THRESHOLD);

    clock.now += 600_001;
    await stage.assess({ ip: '93.184.216.99' });
    expect(dns.asked).toHaveLength(DEFAULT_FAILURE_THRESHOLD + 1);

    warn.mockRestore();
  });

  // Regression: a verdict already established is still true while the
  // resolver is unreachable. An open breaker must not blank out answers we
  // already have.
  it('still serves a cached verdict while the breaker is open', async () => {
    const dns = fakeDns({
      [LISTED_NAME]: ['127.0.0.2'],
      ...Object.fromEntries(
        Array.from({ length: 10 }, (_unused, i) => [
          `${i + 40}.216.184.93.zen.spamhaus.org`,
          ['127.255.255.254'],
        ]),
      ),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { stage, provider } = stageWith(dns);

    const first = await stage.assess({ ip: SENDER_IP });
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      await stage.assess({ ip: `93.184.216.${i + 40}` });
    }
    expect(provider.activeLists()).toEqual([]);

    expect(await stage.assess({ ip: SENDER_IP })).toEqual(first);
    warn.mockRestore();
  });

  // Regression: a run of failures separated by successes is a flaky network,
  // not a misconfigured resolver, and must not trip the breaker.
  it('counts only consecutive failures toward the breaker', async () => {
    const dns = fakeDns({
      '35.216.184.93.zen.spamhaus.org': new Error('queryA ETIMEOUT'),
      '36.216.184.93.zen.spamhaus.org': new Error('queryA ETIMEOUT'),
    });
    const { stage } = stageWith(dns, { breaker: { failureThreshold: 3 } });

    await stage.assess({ ip: '93.184.216.35' });
    await stage.assess({ ip: '93.184.216.36' });
    await stage.assess({ ip: SENDER_IP }); // succeeds: not listed
    await stage.assess({ ip: '93.184.216.35' });
    await stage.assess({ ip: '93.184.216.36' });

    // Still closed — a sixth sender is still asked about.
    await stage.assess({ ip: '93.184.216.37' });
    expect(dns.asked).toHaveLength(6);
  });

  it('asks every configured zone about the target it takes', async () => {
    const dns = fakeDns({ '34.216.184.93.bl.spamcop.net': ['127.0.0.2'] });
    const { stage } = stageWith(dns, { lists: [SPAMHAUS_ZEN, SPAMCOP] });

    const assessment = await stage.assess({ ip: SENDER_IP });

    expect(dns.asked).toEqual([LISTED_NAME, '34.216.184.93.bl.spamcop.net']);
    expect(assessment?.score).toBe(3);
  });

  // Regression (moved here from the retired background sender check): a
  // message whose From is clean and whose Reply-To is notorious is still
  // charged, because the Reply-To is where the answers go.
  it('asks about every sender domain it is given and charges the listed one', async () => {
    const dns = fakeDns({ 'notorious.example.dbl.spamhaus.org': ['127.0.1.2'] });
    const { stage } = stageWith(dns, { lists: [SPAMHAUS_DBL] });

    const assessment = await stage.assess({ domains: ['clean.example', 'Notorious.Example', 'clean.example'] });

    expect(dns.asked.sort()).toEqual(['clean.example.dbl.spamhaus.org', 'notorious.example.dbl.spamhaus.org']);
    expect(assessment?.reasons.map((reason) => reason.id)).toEqual(['reputation-domain-listed']);
    expect(assessment?.reasons[0]?.detail).toContain('notorious.example');
  });

  // Regression: the store is a disk. One that cannot be read or written must
  // cost a lookup, never a message — ingest awaits this.
  it('answers from the provider when the store cannot be read or written', async () => {
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const broken: ReputationCacheStore = {
      get: () => { throw new Error('SQLITE_BUSY'); },
      set: () => { throw new Error('SQLITE_FULL'); },
    };
    const { stage } = stageWith(dns, { cache: broken });

    expect((await stage.assess({ ip: SENDER_IP }))?.score).toBe(4);
    expect((await stage.assess({ ip: SENDER_IP }))?.score).toBe(4);
    expect(dns.asked).toHaveLength(2);
  });

  // Regression: ingest awaits this. Whatever it is handed, it answers — a
  // throw here would fail the message it was asked about.
  it('never throws, even on a subject it cannot read', async () => {
    const { stage } = stageWith(fakeDns());
    const hostile = { ip: SENDER_IP, get domains(): string[] { throw new Error('not readable'); } };
    await expect(stage.assess(hostile)).resolves.toBeNull();
  });

  // Fail-open: a provider that throws instead of answering "unknown" is still
  // no opinion, and nothing about it is remembered.
  it('reads a provider that throws as no opinion, and remembers nothing', async () => {
    const cache = memoryCache();
    const thrower: ReputationProvider = { name: 'broken', lookup: async () => { throw new Error('ECONNRESET'); } };
    const stage = new ReputationStage(thrower, cache);

    expect(await stage.assess({ ip: SENDER_IP })).toBeNull();
    const result = await stage.lookup({ ips: [], domains: ['x.example'] });
    expect(result.domains.get('x.example')).toMatchObject({ status: 'unknown', note: 'Lookup failed: ECONNRESET' });
    expect(cache.writes).toEqual([]);
  });

  // The same stage speaks to the Sarv service: whoever the user chose, the
  // cache and the scoring in front of it are one.
  it('scores through the Sarv service the same way, from the category it names', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ips: [{ ip: SENDER_IP, status: 'listed', listed: [{ list: 'Spamhaus ZEN', category: 'spam', detail: 'SBL' }] }], domains: [] }),
    }));
    const provider = new SarvReputationProvider({ endpoint: 'https://rep.sarv.example', getToken: async () => 'tok', fetch });
    const stage = new ReputationStage(provider, memoryCache());

    expect((await stage.assess({ ip: SENDER_IP }))?.reasons[0]).toMatchObject({ id: 'reputation-ip-listed', points: 5 });
    await stage.assess({ ip: SENDER_IP });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stage.providerName).toBe('sarv');
  });
});

/**
 * The stage's second caller: the background pass, asking about the domains a
 * body links to. Same cache, same de-duplication — a domain the ingest check
 * or an earlier batch already asked about is not asked again.
 */
describe('ReputationStage.lookup — many items at once', () => {
  it('asks once for everything the cache does not know, and answers every item', async () => {
    const dns = fakeDns({ 'evil.example.dbl.spamhaus.org': ['127.0.1.4'] });
    const { stage } = stageWith(dns, { lists: [SPAMHAUS_DBL] });
    await stage.assess({ domains: ['known.example'] });
    dns.asked.length = 0;

    const result = await stage.lookup({ ips: [], domains: ['known.example', 'evil.example', 'EVIL.example', ''] });

    expect(dns.asked).toEqual(['evil.example.dbl.spamhaus.org']);
    expect(result.domains.get('evil.example')?.status).toBe('listed');
    expect(result.domains.get('known.example')?.status).toBe('clean');
    expect([...result.domains.keys()].sort()).toEqual(['evil.example', 'known.example']);
  });

  it('shares an item already in flight with a second caller', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[][] = [];
    const provider: ReputationProvider = {
      name: 'slow',
      lookup: async (query) => {
        calls.push(query.domains);
        await gate;
        return { provider: 'slow', ips: new Map(), domains: new Map(query.domains.map((d) => [d, { status: 'clean' as const, hits: [] }])) };
      },
    };
    const stage = new ReputationStage(provider, memoryCache());

    const first = stage.lookup({ ips: [], domains: ['a.example', 'b.example'] });
    const second = stage.lookup({ ips: [], domains: ['b.example', 'c.example'] });
    release();
    const [one, two] = await Promise.all([first, second]);

    expect(calls).toEqual([['a.example', 'b.example'], ['c.example']]);
    expect(two.domains.get('b.example')?.status).toBe('clean');
    expect(one.domains.size).toBe(2);
  });

  // An item the provider left out of its answer is unknown — never clean,
  // and never cached as anything.
  it('reads an item the provider did not answer for as unknown, and does not cache it', async () => {
    const cache = memoryCache();
    const provider: ReputationProvider = { name: 'partial', lookup: async () => ({ provider: 'partial', ips: new Map(), domains: new Map() }) };
    const stage = new ReputationStage(provider, cache);

    const result = await stage.lookup({ ips: ['1.2.3.4'], domains: ['x.example'] });

    expect(result.ips.get('1.2.3.4')?.status).toBe('unknown');
    expect(result.domains.get('x.example')?.status).toBe('unknown');
    expect(cache.writes).toEqual([]);
  });
});

/**
 * Per-zone breakers, as ingest experiences them. With every catalogue zone on
 * by default, most machines will have at least one operator that never answers
 * them — URIBL refuses public resolvers, Barracuda refuses unregistered ones —
 * and a stage that treated any zone's refusal as the lookup failing would score
 * nothing on exactly those machines while the zones that DO answer went unheard.
 */
describe('ReputationStage — one zone refusing does not silence the rest', () => {
  const SPAMCOP_NAME = '34.216.184.93.bl.spamcop.net';
  const ipAt = (i: number) => `93.184.216.${i + 10}`;
  const zenOf = (i: number) => `${i + 10}.216.184.93.zen.spamhaus.org`;
  const spamcopOf = (i: number) => `${i + 10}.216.184.93.bl.spamcop.net`;

  // Regression: a listing one operator reported is true whatever happened to
  // the operator beside it. Discarding it because SpamCop was down turned a
  // real listing into "no opinion".
  it('scores the zones that answered even when another one failed', async () => {
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'], [SPAMCOP_NAME]: new Error('queryA ETIMEOUT') });
    const { stage } = stageWith(dns, { lists: [SPAMHAUS_ZEN, SPAMCOP] });

    const assessment = await stage.assess({ ip: SENDER_IP });

    expect(assessment?.reasons[0]?.id).toBe('reputation-ip-listed');
    // The operator's own name, as the shield has always shown it.
    expect(assessment?.reasons[0]?.detail).toContain('Spamhaus ZEN');
    expect(dns.asked.sort()).toEqual([SPAMCOP_NAME, LISTED_NAME].sort());
  });

  // Regression: THE default-on case. One zone that will never answer this
  // network is retired after its own run of failures, on its own; the other
  // keeps being asked about every sender, and the retired one is tried again
  // after its cooldown.
  it('retires a zone after its own run of failures while the others keep answering', async () => {
    const clock = { now: 1_000_000_000 };
    const answers: Record<string, string[] | Error> = {};
    for (let i = 0; i < 20; i += 1) {
      answers[spamcopOf(i)] = ['127.0.0.1']; // SpamCop's "you are refused" answer, read by the library as an error
    }
    const dns = fakeDns(answers);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { stage, provider } = stageWith(dns, { lists: [SPAMHAUS_ZEN, SPAMCOP], breaker: { cooldownMs: 600_000 }, clock });

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      expect(await stage.assess({ ip: ipAt(i) })).not.toBeNull(); // ZEN answered every time
    }
    expect(provider.activeLists().map((zone) => zone.name)).toEqual(['spamhaus-zen']);

    // The next sender is asked of ZEN only.
    await stage.assess({ ip: ipAt(7) });
    expect(dns.asked).toContain(zenOf(7));
    expect(dns.asked).not.toContain(spamcopOf(7));

    // After its cooldown the retired zone is asked again.
    clock.now += 600_001;
    await stage.assess({ ip: ipAt(8) });
    expect(dns.asked).toContain(spamcopOf(8));

    warn.mockRestore();
  });

  // Regression: a zone that answers again is forgiven — its count must reset,
  // or three refusals a week apart would retire an operator that is working.
  it('forgives a zone that answers, and counts only its consecutive failures', async () => {
    const answers: Record<string, string[] | Error> = {};
    for (let i = 0; i < 20; i += 1) {
      if (i % 2 === 0) answers[spamcopOf(i)] = new Error('queryA ETIMEOUT');
    }
    const dns = fakeDns(answers);
    const { stage, provider } = stageWith(dns, { lists: [SPAMHAUS_ZEN, SPAMCOP], breaker: { failureThreshold: 3 } });

    for (let i = 0; i < 12; i += 1) await stage.assess({ ip: ipAt(i) });
    expect(provider.activeLists()).toHaveLength(2);
  });

  it('asks nothing while every zone is sitting out its cooldown', async () => {
    const answers: Record<string, string[] | Error> = {};
    for (let i = 0; i < 20; i += 1) answers[zenOf(i)] = ['127.255.255.254'];
    const dns = fakeDns(answers);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { stage, provider } = stageWith(dns, { breaker: { cooldownMs: 600_000, failureThreshold: 2 } });

    await stage.assess({ ip: ipAt(0) });
    await stage.assess({ ip: ipAt(1) });
    expect(provider.activeLists()).toEqual([]);
    const asked = dns.asked.length;
    expect(await stage.assess({ ip: ipAt(2) })).toBeNull();
    expect(dns.asked).toHaveLength(asked);
    warn.mockRestore();
  });
});
