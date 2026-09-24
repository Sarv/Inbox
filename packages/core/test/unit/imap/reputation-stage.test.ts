import { SPAMCOP, SPAMHAUS_ZEN, type DnsQuery } from '@sarv-in/mailguard';
import { describe, expect, it, vi } from 'vitest';

import {
  ReputationStage,
  DEFAULT_FAILURE_THRESHOLD,
  type ReputationStageConfig,
} from '../../../src/imap/reputation-stage';

/** A public unicast address — the only kind a blocklist is ever asked about. */
const SENDER_IP = '93.184.216.34';
const LISTED_NAME = '34.216.184.93.zen.spamhaus.org';

/** A resolver that answers from a table and counts what it was asked. */
function fakeDns(answers: Readonly<Record<string, string[] | Error>> = {}): {
  query: DnsQuery;
  asked: string[];
} {
  const asked: string[] = [];
  const query: DnsQuery = (name) => {
    asked.push(name);
    const answer = answers[name];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? []);
  };
  return { query, asked };
}

/** A stage with a fake clock, so the TTL and the breaker are testable without waiting. */
function stageWith(
  config: Partial<ReputationStageConfig>,
  query: DnsQuery,
  clock = { now: 1_000_000 },
): ReputationStage {
  return new ReputationStage({ blocklists: [SPAMHAUS_ZEN], ...config }, { query, now: () => clock.now });
}

describe('ReputationStage', () => {
  // THE gate on the whole feature. Every query tells a third-party operator
  // about a sender this user receives mail from, and several operators charge
  // for volume — so a deployment that has not named its zones must send
  // nothing at all, not "the usual ones".
  it('is off, and asks nothing, until zones are configured', async () => {
    const dns = fakeDns();
    const stage = new ReputationStage({ blocklists: [] }, { query: dns.query });

    expect(stage.enabled).toBe(false);
    expect(await stage.assess({ ip: SENDER_IP, domain: 'example.com' })).toBeNull();
    expect(dns.asked).toEqual([]);
  });

  it('scores a listed sender so the caller can add it to the message', async () => {
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const stage = stageWith({}, dns.query);

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
    const stage = stageWith({}, dns.query);

    for (let i = 0; i < 5; i += 1) await stage.assess({ ip: SENDER_IP });

    expect(dns.asked).toEqual([LISTED_NAME]);
  });

  // Regression: a batch arrives all at once, so a dozen messages from one
  // sender must share ONE query rather than racing a dozen that each miss the
  // cache the others are about to fill.
  it('collapses concurrent lookups of the same sender into one query', async () => {
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const stage = stageWith({}, dns.query);

    const all = await Promise.all(
      Array.from({ length: 10 }, () => stage.assess({ ip: SENDER_IP })),
    );

    expect(dns.asked).toEqual([LISTED_NAME]);
    expect(all.every((one) => one?.score === 4)).toBe(true);
  });

  // Regression: a blocklist answer is not permanent. A sender delisted this
  // morning must stop being scored, or a cached verdict outlives the fact.
  it('asks again once the cached verdict has expired', async () => {
    const clock = { now: 1_000_000 };
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const stage = stageWith({ cacheTtlMs: 60_000 }, dns.query, clock);

    await stage.assess({ ip: SENDER_IP });
    clock.now += 59_000;
    await stage.assess({ ip: SENDER_IP });
    expect(dns.asked).toHaveLength(1);

    clock.now += 2_000;
    await stage.assess({ ip: SENDER_IP });
    expect(dns.asked).toHaveLength(2);
  });

  it('bounds the cache rather than growing it for the life of the process', async () => {
    const dns = fakeDns();
    const stage = stageWith({ cacheMax: 2 }, dns.query);

    for (const ip of ['93.184.216.34', '93.184.216.35', '93.184.216.36']) {
      await stage.assess({ ip });
    }
    // The first sender was evicted, so asking again is a real query.
    await stage.assess({ ip: '93.184.216.34' });

    expect(dns.asked).toHaveLength(4);
  });

  // Regression: an unusable target must never become a query. A private
  // address tells the operator about this user's network and nothing else,
  // and no list has anything to say about it.
  it('asks nothing when there is nothing worth asking about', async () => {
    const dns = fakeDns();
    const stage = stageWith({}, dns.query);

    expect(await stage.assess({})).toBeNull();
    expect(await stage.assess({ ip: null, domain: null })).toBeNull();
    expect(await stage.assess({ ip: '10.0.0.4' })).toBeNull();
    expect(dns.asked).toEqual([]);
  });

  // Regression: a lookup that failed is NOT a clean sender. Caching the
  // failure as a verdict would silence the stage for hours over one blip.
  it('adds nothing when a lookup fails, and does not cache the failure', async () => {
    const dns = fakeDns({ [LISTED_NAME]: new Error('queryA ESERVFAIL') });
    const stage = stageWith({}, dns.query);

    expect(await stage.assess({ ip: SENDER_IP })).toBeNull();
    expect(await stage.assess({ ip: SENDER_IP })).toBeNull();
    expect(dns.asked).toHaveLength(2);
  });

  // THE regression for a DESKTOP client specifically. Spamhaus and others
  // refuse queries that arrive through a public resolver — the answer is
  // 127.255.255.254, not a listing — and a laptop on its ISP's DNS or on
  // 8.8.8.8 is exactly that. Without the breaker the app sends one doomed
  // query per sender for the rest of the session, forever, to an operator
  // that has already said no.
  it('stops asking after repeated failures, and resumes after the cooldown', async () => {
    const clock = { now: 1_000_000 };
    const dns = fakeDns(
      Object.fromEntries(
        Array.from({ length: 20 }, (_unused, i) => [
          `${i + 10}.216.184.93.zen.spamhaus.org`,
          ['127.255.255.254'],
        ]),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stage = stageWith({ breakerCooldownMs: 600_000 }, dns.query, clock);

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      await stage.assess({ ip: `93.184.216.${i + 10}` });
    }
    expect(dns.asked).toHaveLength(DEFAULT_FAILURE_THRESHOLD);

    // Breaker open: further senders cost nothing at all.
    await stage.assess({ ip: '93.184.216.99' });
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
    const clock = { now: 1_000_000 };
    const dns = fakeDns({
      [LISTED_NAME]: ['127.0.0.2'],
      ...Object.fromEntries(
        Array.from({ length: 10 }, (_unused, i) => [
          `${i + 40}.216.184.93.zen.spamhaus.org`,
          ['127.255.255.254'],
        ]),
      ),
    });
    const stage = stageWith({}, dns.query, clock);

    const first = await stage.assess({ ip: SENDER_IP });
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      await stage.assess({ ip: `93.184.216.${i + 40}` });
    }

    expect(await stage.assess({ ip: SENDER_IP })).toEqual(first);
  });

  // Regression: a run of failures separated by successes is a flaky network,
  // not a misconfigured resolver, and must not trip the breaker.
  it('counts only consecutive failures toward the breaker', async () => {
    const dns = fakeDns({
      '35.216.184.93.zen.spamhaus.org': new Error('queryA ETIMEOUT'),
      '36.216.184.93.zen.spamhaus.org': new Error('queryA ETIMEOUT'),
    });
    const stage = stageWith({ failureThreshold: 3 }, dns.query);

    await stage.assess({ ip: '93.184.216.35' });
    await stage.assess({ ip: '93.184.216.36' });
    await stage.assess({ ip: SENDER_IP }); // succeeds: not listed
    await stage.assess({ ip: '93.184.216.35' });
    await stage.assess({ ip: '93.184.216.36' });

    // Still closed — a sixth sender is still asked about.
    await stage.assess({ ip: '93.184.216.37' });
    expect(dns.asked).toHaveLength(6);
  });

  // Regression: changing which zones are configured invalidates every verdict
  // computed under the old set. Serving the old one would make the setting
  // look like it did nothing.
  it('forgets every cached verdict on reset', async () => {
    const dns = fakeDns({ [LISTED_NAME]: ['127.0.0.2'] });
    const stage = stageWith({}, dns.query);

    await stage.assess({ ip: SENDER_IP });
    stage.reset();
    await stage.assess({ ip: SENDER_IP });

    expect(dns.asked).toHaveLength(2);
  });

  it('asks every configured zone about the target it takes', async () => {
    const dns = fakeDns({ '34.216.184.93.bl.spamcop.net': ['127.0.0.2'] });
    const stage = stageWith({ blocklists: [SPAMHAUS_ZEN, SPAMCOP] }, dns.query);

    const assessment = await stage.assess({ ip: SENDER_IP });

    expect(dns.asked).toEqual([LISTED_NAME, '34.216.184.93.bl.spamcop.net']);
    expect(assessment?.score).toBe(3);
  });
});

/**
 * Per-zone breakers. With every catalogue zone on by default, most machines
 * will have at least one operator that never answers them — URIBL refuses
 * public resolvers, Barracuda refuses unregistered ones — and a stage that
 * treated any zone's refusal as the lookup failing would score nothing on
 * exactly those machines while the zones that DO answer went unheard.
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
    const stage = stageWith({ blocklists: [SPAMHAUS_ZEN, SPAMCOP] }, dns.query);

    const assessment = await stage.assess({ ip: SENDER_IP });

    expect(assessment?.reasons[0]?.id).toBe('reputation-ip-listed');
    expect(assessment?.reasons[0]?.detail).toContain('spamhaus-zen');
    expect(dns.asked.sort()).toEqual([SPAMCOP_NAME, LISTED_NAME].sort());
  });

  // Regression: THE default-on case. One zone that will never answer this
  // network is retired after its own run of failures, on its own; the other
  // keeps being asked about every sender, and the retired one is tried again
  // after its cooldown.
  it('retires a zone after its own run of failures while the others keep answering', async () => {
    const clock = { now: 1_000_000 };
    const answers: Record<string, string[] | Error> = {};
    for (let i = 0; i < 20; i += 1) {
      answers[zenOf(i)] = [];
      answers[spamcopOf(i)] = ['127.0.0.1']; // SpamCop's "you are refused" answer, read by the library as an error
    }
    const dns = fakeDns(answers);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stage = stageWith({ blocklists: [SPAMHAUS_ZEN, SPAMCOP], breakerCooldownMs: 600_000 }, dns.query, clock);

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      expect(await stage.assess({ ip: ipAt(i) })).not.toBeNull(); // ZEN answered every time
    }
    expect(stage.activeZones().map((zone) => zone.name)).toEqual(['spamhaus-zen']);

    // The next sender is asked of ZEN only.
    await stage.assess({ ip: ipAt(7) });
    expect(dns.asked).toContain(zenOf(7));
    expect(dns.asked).not.toContain(spamcopOf(7));

    // Whole stage still live: the global breaker only counts lookups in which nobody answered.
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
      answers[zenOf(i)] = [];
      answers[spamcopOf(i)] = i % 2 === 0 ? new Error('queryA ETIMEOUT') : [];
    }
    const dns = fakeDns(answers);
    const stage = stageWith({ blocklists: [SPAMHAUS_ZEN, SPAMCOP], failureThreshold: 3 }, dns.query);

    for (let i = 0; i < 12; i += 1) await stage.assess({ ip: ipAt(i) });
    expect(stage.activeZones()).toHaveLength(2);
  });

  it('asks nothing, and counts no failure, while every zone is sitting out its cooldown', async () => {
    const clock = { now: 1_000_000 };
    const answers: Record<string, string[] | Error> = {};
    for (let i = 0; i < 20; i += 1) answers[zenOf(i)] = ['127.255.255.254'];
    const dns = fakeDns(answers);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stage = stageWith({ breakerCooldownMs: 600_000, failureThreshold: 2 }, dns.query, clock);

    await stage.assess({ ip: ipAt(0) });
    await stage.assess({ ip: ipAt(1) });
    expect(stage.activeZones()).toEqual([]);
    const asked = dns.asked.length;
    expect(await stage.assess({ ip: ipAt(2) })).toBeNull();
    expect(dns.asked).toHaveLength(asked);

    // Reset clears the zone breakers too — a settings change starts everyone fresh.
    stage.reset();
    expect(stage.activeZones()).toHaveLength(1);
    warn.mockRestore();
  });
});
