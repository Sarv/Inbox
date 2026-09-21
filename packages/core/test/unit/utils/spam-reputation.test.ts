import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DNSBL_LISTS,
  LocalDnsblProvider,
  REPUTATION_MAX_POINTS,
  SarvReputationProvider,
  USER_REPORTS_MIN,
  messageDomains,
  reputationReasons,
  unknownResult,
  type ReputationResult,
} from '../../../src/utils/spam-reputation';

/**
 * The reputation stage: blocklists and the Sarv service as spam signals.
 *
 * What this protects: the difference between "listed", "clean" and "unknown".
 * Spamhaus and URIBL answer a query from a public resolver with a special
 * code that MEANS "I refuse to tell you"; a provider that read any answer as
 * a listing would file every sender as spam on any laptop using Google DNS.
 * The other way round, a service that is down must never be read as "clean"
 * and cached for six hours. Every list's codes are pinned below, as is the
 * fail-open behaviour of the Sarv client.
 *
 * The code tables and the query-name arithmetic are the library's now
 * (`@sarv-in/email-spam-scan/reputation`, where they have their own suite);
 * what is pinned here is what Inbox owns: the resolver-error contract, the
 * roll-up from per-zone answers to one listed/clean/unknown per item, the
 * operator names the shield shows, and the scoring seam.
 */
const notFound = () => Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
type Answers = Record<string, string[] | 'timeout'>;
const resolver = (answers: Answers, calls: string[] = []) => async (name: string): Promise<string[]> => {
  calls.push(name);
  const a = answers[name];
  if (a === undefined) throw notFound();
  if (a === 'timeout') throw Object.assign(new Error('queryA ETIMEOUT'), { code: 'ETIMEOUT' });
  return a;
};

/** A real, globally routable v6 address — the documentation prefix is not one, and is skipped. */
const PUBLIC_IPV6 = '2a00:1450:4001:80e::200e';
const PUBLIC_IPV6_REVERSED = 'e.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.e.0.8.0.1.0.0.4.0.5.4.1.0.0.a.2';

describe('LocalDnsblProvider — reading the lists', () => {
  const lookup = (answers: Answers, q: { ips?: string[]; domains?: string[] }, lists = DEFAULT_DNSBL_LISTS) =>
    new LocalDnsblProvider({ resolve4: resolver(answers), lists }).lookup({ ips: q.ips ?? [], domains: q.domains ?? [] });

  it('queries every list in the reversed form and reads a Spamhaus spam-source listing', async () => {
    const calls: string[] = [];
    const p = new LocalDnsblProvider({ resolve4: resolver({ '4.3.2.1.zen.spamhaus.org': ['127.0.0.2'] }, calls) });
    const r = await p.lookup({ ips: ['1.2.3.4'], domains: [] });
    expect(calls.sort()).toEqual(['4.3.2.1.b.barracudacentral.org', '4.3.2.1.bl.spamcop.net', '4.3.2.1.zen.spamhaus.org']);
    expect(r.ips.get('1.2.3.4')).toMatchObject({ status: 'listed', hits: [{ list: 'Spamhaus ZEN', category: 'spam' }] });
  });

  it('distinguishes Spamhaus categories: exploited, DROP, policy', async () => {
    expect((await lookup({ '4.3.2.1.zen.spamhaus.org': ['127.0.0.4'] }, { ips: ['1.2.3.4'] })).ips.get('1.2.3.4')?.hits[0].category).toBe('exploited');
    expect((await lookup({ '4.3.2.1.zen.spamhaus.org': ['127.0.0.9'] }, { ips: ['1.2.3.4'] })).ips.get('1.2.3.4')?.hits[0].category).toBe('exploited');
    expect((await lookup({ '4.3.2.1.zen.spamhaus.org': ['127.0.0.11'] }, { ips: ['1.2.3.4'] })).ips.get('1.2.3.4')?.hits[0].category).toBe('policy');
  });

  // THE public-resolver trap. 127.255.255.254 is Spamhaus saying "no": unknown, not listed.
  it('reads a Spamhaus refusal as unknown with a note, never as a listing', async () => {
    const r = await lookup({ '4.3.2.1.zen.spamhaus.org': ['127.255.255.254'] }, { ips: ['1.2.3.4'] });
    const ip = r.ips.get('1.2.3.4')!;
    expect(ip.status).toBe('clean'); // the other two lists answered "not listed"
    expect(ip.hits).toEqual([]);
    const only = new LocalDnsblProvider({ resolve4: resolver({ '4.3.2.1.zen.spamhaus.org': ['127.255.255.254'] }), lists: [DEFAULT_DNSBL_LISTS[0]] });
    const alone = (await only.lookup({ ips: ['1.2.3.4'], domains: [] })).ips.get('1.2.3.4')!;
    expect(alone.status).toBe('unknown');
    // The note reaches the log and the spam-pass summary: the operator's name,
    // not the library's internal id (`spamhaus-zen`).
    expect(alone.note).toContain('Spamhaus ZEN');
    expect(alone.note).toContain('public or open resolver');
  });

  it('is clean when every list answers NXDOMAIN, unknown when every list times out', async () => {
    expect((await lookup({}, { ips: ['1.2.3.4'] })).ips.get('1.2.3.4')).toMatchObject({ status: 'clean', hits: [] });
    const t = await lookup({ '4.3.2.1.zen.spamhaus.org': 'timeout', '4.3.2.1.bl.spamcop.net': 'timeout', '4.3.2.1.b.barracudacentral.org': 'timeout' }, { ips: ['1.2.3.4'] });
    expect(t.ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: expect.stringContaining('ETIMEOUT') });
  });

  it('reads SpamCop and Barracuda listings', async () => {
    const r = await lookup({ '4.3.2.1.bl.spamcop.net': ['127.0.0.2'], '4.3.2.1.b.barracudacentral.org': ['127.0.0.2'] }, { ips: ['1.2.3.4'] });
    expect(r.ips.get('1.2.3.4')?.hits.map((h) => h.list).sort()).toEqual(['Barracuda', 'SpamCop']);
  });

  it('reads Spamhaus DBL categories and its refusal code', async () => {
    const dbl = (code: string) => lookup({ 'evil.example.dbl.spamhaus.org': [code] }, { domains: ['evil.example'] }).then((r) => r.domains.get('evil.example')!);
    expect((await dbl('127.0.1.2')).hits[0].category).toBe('spam');
    expect((await dbl('127.0.1.4')).hits[0].category).toBe('phishing');
    expect((await dbl('127.0.1.5')).hits[0].category).toBe('malware');
    expect((await dbl('127.0.1.6')).hits[0].category).toBe('botnet');
    expect((await dbl('127.0.1.104')).hits[0].category).toBe('abused');
    expect((await dbl('127.0.1.255')).hits).toEqual([]); // refused, and the other lists said not listed → clean
  });

  it('reads SURBL and URIBL bitmasks, and their "query blocked" code', async () => {
    const one = (zone: string, codes: string[]) => lookup({ [`x.example.${zone}`]: codes }, { domains: ['x.example'] }).then((r) => r.domains.get('x.example')!);
    expect((await one('multi.surbl.org', ['127.0.0.8'])).hits[0]).toMatchObject({ list: 'SURBL', category: 'phishing' });
    expect((await one('multi.surbl.org', ['127.0.0.16'])).hits[0].category).toBe('malware');
    expect((await one('multi.surbl.org', ['127.0.0.64'])).hits[0].category).toBe('abused');  // bit 64 is a cracked site, not a spammer's own domain
    expect((await one('multi.uribl.com', ['127.0.0.2'])).hits[0]).toMatchObject({ list: 'URIBL', category: 'spam' });
    expect((await one('multi.uribl.com', ['127.0.0.4'])).hits[0].category).toBe('grey');
    expect((await one('multi.uribl.com', ['127.0.0.1'])).hits).toEqual([]);
    const uriblOnly = new LocalDnsblProvider({ resolve4: resolver({ 'x.example.multi.uribl.com': ['127.0.0.1'] }), lists: DEFAULT_DNSBL_LISTS.filter((l) => l.zone === 'multi.uribl.com') });
    expect((await uriblOnly.lookup({ ips: [], domains: ['x.example'] })).domains.get('x.example')).toMatchObject({ status: 'unknown', note: expect.stringContaining('URIBL') });
  });

  // A v6 address asked of a v4-only zone comes back NXDOMAIN from a nameserver
  // that has never heard of v6 — which reads as "not listed", a clean verdict
  // nobody actually gave. Only zones that declare v6 are asked.
  it('asks only the IPv6-capable zones about a v6 address, and is unknown when none can answer', async () => {
    const calls: string[] = [];
    const p = new LocalDnsblProvider({ resolve4: resolver({}, calls) });
    const r = await p.lookup({ ips: [PUBLIC_IPV6], domains: [] });
    expect(calls).toEqual([`${PUBLIC_IPV6_REVERSED}.zen.spamhaus.org`]);
    expect(r.ips.get(PUBLIC_IPV6)?.status).toBe('clean');
    const v4only = new LocalDnsblProvider({ resolve4: resolver({}), lists: DEFAULT_DNSBL_LISTS.filter((l) => l.zone === 'bl.spamcop.net') });
    expect((await v4only.lookup({ ips: [PUBLIC_IPV6], domains: [] })).ips.get(PUBLIC_IPV6)).toMatchObject({ status: 'unknown' });
    expect((await v4only.lookup({ ips: ['not-an-ip'], domains: [] })).ips.get('not-an-ip')).toMatchObject({ status: 'unknown' });
  });

  // No operator has anything to say about a documentation, private or loopback
  // address, and asking one tells them about the network for nothing.
  it('asks nobody about a non-public address, and answers unknown rather than clean', async () => {
    const calls: string[] = [];
    const p = new LocalDnsblProvider({ resolve4: resolver({}, calls) });
    const r = await p.lookup({ ips: ['2001:db8::1', '10.0.0.4'], domains: [] });
    expect(calls).toEqual([]);
    expect(r.ips.get('2001:db8::1')).toMatchObject({ status: 'unknown' });
    expect(r.ips.get('10.0.0.4')).toMatchObject({ status: 'unknown' });
  });

  // The resolver contract the library is handed: only these three codes mean
  // "the zone has no entry". Anything else is a failure, and a failure is
  // unknown — reading a SERVFAIL as "not listed" caches an outage as clean.
  it('maps every not-found resolver code to "not listed", and any other error to unknown', async () => {
    const failWith = (code: string) => new LocalDnsblProvider({
      resolve4: async () => { throw Object.assign(new Error(`queryA ${code}`), { code }); },
      lists: DEFAULT_DNSBL_LISTS.filter((l) => l.zone === 'bl.spamcop.net'),
    }).lookup({ ips: ['1.2.3.4'], domains: [] }).then((r) => r.ips.get('1.2.3.4')!);
    for (const code of ['ENOTFOUND', 'ENODATA', 'NXDOMAIN']) {
      expect(await failWith(code), code).toMatchObject({ status: 'clean', hits: [] });
    }
    expect(await failWith('SERVFAIL')).toMatchObject({ status: 'unknown', note: expect.stringContaining('SpamCop') });
  });

  it('deduplicates items, lower-cases domains and bounds concurrency', async () => {
    let inFlight = 0; let peak = 0;
    const resolve4 = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 1)); inFlight--; throw notFound(); };
    const p = new LocalDnsblProvider({ resolve4, concurrency: 2 });
    const r = await p.lookup({ ips: ['1.2.3.4', '1.2.3.4'], domains: ['A.example', 'a.example', 'b.example'] });
    expect(peak).toBeLessThanOrEqual(2);
    expect([...r.domains.keys()].sort()).toEqual(['a.example', 'b.example']);
  });
});

describe('reputationReasons', () => {
  const result = (over: Partial<{ ips: ReputationResult['ips']; domains: ReputationResult['domains'] }>): ReputationResult => ({
    provider: 'test', ips: over.ips ?? new Map(), domains: over.domains ?? new Map(),
  });
  const hit = (list: string, category: string) => ({ list, category, detail: `${list} says ${category}` });

  it('scores a spam-source IP listing at the threshold, a policy listing below it', () => {
    const spam = reputationReasons(result({ ips: new Map([['1.2.3.4', { status: 'listed', hits: [hit('Spamhaus ZEN', 'spam')] }]]) }), { originIp: '1.2.3.4', domains: [] });
    expect(spam).toEqual([{ id: 'reputation-ip-listed', points: 5, detail: expect.stringContaining('The sending address 1.2.3.4 is listed by Spamhaus ZEN') }]);
    const policy = reputationReasons(result({ ips: new Map([['1.2.3.4', { status: 'listed', hits: [hit('Spamhaus ZEN', 'policy')] }]]) }), { originIp: '1.2.3.4', domains: [] });
    expect(policy[0].points).toBe(3);
  });

  it('scores a domain listing and other users’ reports, and caps the total', () => {
    const r = result({
      ips: new Map([['1.2.3.4', { status: 'listed', hits: [hit('SpamCop', 'spam')] }]]),
      domains: new Map([['evil.example', { status: 'listed', hits: [hit('Spamhaus DBL', 'phishing')], userReports: 9 }]]),
    });
    const reasons = reputationReasons(r, { originIp: '1.2.3.4', domains: ['evil.example', 'EVIL.example'] });
    expect(reasons.map((x) => x.id)).toEqual(['reputation-ip-listed', 'reputation-domain-listed']); // the cap left nothing for the reports
    // One reason for the domain side, however many domains carried the listing.
    expect(reasons[1].detail).toContain('The sender domain evil.example is listed by Spamhaus DBL');
    expect(reasons.reduce((s, x) => s + x.points, 0)).toBe(REPUTATION_MAX_POINTS);
  });

  it('counts user reports only from the minimum, and nothing for clean or unknown items', () => {
    const few = result({ domains: new Map([['x.example', { status: 'clean', hits: [], userReports: USER_REPORTS_MIN - 1 }]]) });
    expect(reputationReasons(few, { originIp: null, domains: ['x.example'] })).toEqual([]);
    const enough = result({ domains: new Map([['x.example', { status: 'clean', hits: [], userReports: USER_REPORTS_MIN }]]) });
    expect(reputationReasons(enough, { originIp: null, domains: ['x.example'] })).toEqual([{ id: 'reputation-user-reported', points: 3, detail: expect.stringContaining(`${USER_REPORTS_MIN} other`) }]);
    const unknown = unknownResult('test', { ips: ['1.2.3.4'], domains: ['x.example'] });
    expect(reputationReasons(unknown, { originIp: '1.2.3.4', domains: ['x.example'] })).toEqual([]);
  });
});

describe('SarvReputationProvider', () => {
  const query = { ips: ['1.2.3.4'], domains: ['x.example'] };
  const fetchWith = (status: number, body: unknown, seen: Array<{ url: string; init: unknown }> = []) => async (url: string, init: unknown) => {
    seen.push({ url, init });
    return { ok: status < 400, status, json: async () => body };
  };

  it('posts the batch with the bearer and reads listings and reports', async () => {
    const seen: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const p = new SarvReputationProvider({
      endpoint: 'https://reputation.sarv.example/',
      getToken: async () => 'tok-1',
      fetch: fetchWith(200, {
        ips: [{ ip: '1.2.3.4', status: 'listed', listed: [{ list: 'Spamhaus ZEN', category: 'spam', detail: 'SBL' }] }],
        domains: [{ domain: 'X.example', status: 'clean', listed: [], userReports: 4 }],
      }, seen as never),
    });
    const r = await p.lookup(query);
    expect(seen[0].url).toBe('https://reputation.sarv.example/v1/reputation/lookup');
    expect(seen[0].init.headers.authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seen[0].init.body)).toEqual(query);
    expect(r.ips.get('1.2.3.4')).toMatchObject({ status: 'listed', hits: [{ list: 'Spamhaus ZEN', category: 'spam' }] });
    expect(r.domains.get('x.example')).toMatchObject({ status: 'clean', userReports: 4 });
  });

  // Fail OPEN, every way it can fail.
  it('is unknown — never clean — without a token, on an error status, on bad JSON, or when unreachable', async () => {
    const base = { endpoint: 'https://r.example', fetch: fetchWith(200, {}) };
    expect((await new SarvReputationProvider({ ...base, getToken: async () => null }).lookup(query)).ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: expect.stringContaining('signed in') });
    expect((await new SarvReputationProvider({ ...base, getToken: async () => { throw new Error('refresh failed'); } }).lookup(query)).ips.get('1.2.3.4')?.status).toBe('unknown');
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: fetchWith(503, {}) }).lookup(query)).ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: expect.stringContaining('503') });
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) }).lookup(query)).ips.get('1.2.3.4')?.status).toBe('unknown');
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: async () => { throw new Error('ECONNREFUSED'); } }).lookup(query)).domains.get('x.example')).toMatchObject({ status: 'unknown', note: expect.stringContaining('ECONNREFUSED') });
    // Items the service left out of a good answer are unknown too.
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: fetchWith(200, { ips: [] }) }).lookup(query)).ips.get('1.2.3.4')?.status).toBe('unknown');
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: fetchWith(200, 'nonsense') }).lookup(query)).ips.get('1.2.3.4')?.status).toBe('unknown');
  });

  it('makes no request for an empty query', async () => {
    const fetch = vi.fn();
    const r = await new SarvReputationProvider({ endpoint: 'https://r.example', getToken: async () => 't', fetch }).lookup({ ips: [], domains: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.ips.size).toBe(0);
  });
});

describe('messageDomains', () => {
  it('collects the sender and Reply-To domains, lower-cased and deduplicated', () => {
    expect(messageDomains({ fromAddress: 'a@Brand.Example', replyTo: 'b@reply.example' })).toEqual(['brand.example', 'reply.example']);
    expect(messageDomains({ fromAddress: 'a@brand.example', replyTo: 'c@BRAND.example' })).toEqual(['brand.example']);
    expect(messageDomains({ fromAddress: 'nope', replyTo: null })).toEqual([]);
  });
});

describe('edges', () => {
  it('scores an unfamiliar category at the default weight and ignores a domain the result does not know', () => {
    const r: ReputationResult = {
      provider: 'test',
      ips: new Map([['1.2.3.4', { status: 'listed', hits: [{ list: 'Custom', category: 'weird', detail: 'listed' }] }]]),
      domains: new Map(),
    };
    const reasons = reputationReasons(r, { originIp: '1.2.3.4', domains: ['unknown.example'] });
    expect(reasons).toEqual([{ id: 'reputation-ip-listed', points: 3, detail: expect.stringContaining('Custom') }]);
    expect(reputationReasons(r, { originIp: null, domains: [] })).toEqual([]);
  });

  it('unknownResult carries a note only when given one', () => {
    expect(unknownResult('p', { ips: ['1.2.3.4'], domains: [] }).ips.get('1.2.3.4')).toEqual({ status: 'unknown', hits: [] });
    expect(unknownResult('p', { ips: [], domains: ['d.example'] }, 'why').domains.get('d.example')).toEqual({ status: 'unknown', hits: [], note: 'why' });
  });

  // 127.0.0.1 is not in SpamCop's code table and SpamCop does not declare it a
  // refusal, so it is an answer nobody can read: a wildcard resolver or a
  // hijacked zone, and neither may be cached as "clean" for six hours.
  it('reads an undescribed 127.0.0.1 from SpamCop as unknown, never as a listing and never as clean', async () => {
    const p = new LocalDnsblProvider({ resolve4: resolver({ '4.3.2.1.bl.spamcop.net': ['127.0.0.1'] }), lists: DEFAULT_DNSBL_LISTS.filter((l) => l.zone === 'bl.spamcop.net') });
    expect((await p.lookup({ ips: ['1.2.3.4'], domains: [] })).ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', hits: [] });
    const absent = new LocalDnsblProvider({ resolve4: resolver({}), lists: DEFAULT_DNSBL_LISTS.filter((l) => l.zone === 'bl.spamcop.net') });
    expect((await absent.lookup({ ips: ['1.2.3.4'], domains: [] })).ips.get('1.2.3.4')).toMatchObject({ status: 'clean', hits: [] });
  });

  it('handles an empty query and skips blank domains', async () => {
    const calls: string[] = [];
    const p = new LocalDnsblProvider({ resolve4: resolver({}, calls) });
    const r = await p.lookup({ ips: [], domains: [' ', ''] });
    expect(calls).toEqual([]);
    expect(r.domains.get('')).toMatchObject({ status: 'unknown' });
  });

  it('the Sarv client reads a listed item without category or detail, and an answer with unknown status', async () => {
    const p = new SarvReputationProvider({
      endpoint: 'https://r.example', getToken: async () => 't',
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ips: [{ ip: '1.2.3.4', listed: [{ list: 'L' }] }], domains: [{ domain: 'x.example' }, { domain: 'not-asked.example', status: 'clean' }] }) }),
    });
    const r = await p.lookup({ ips: ['1.2.3.4'], domains: ['x.example'] });
    expect(r.ips.get('1.2.3.4')).toEqual({ status: 'listed', hits: [{ list: 'L', category: 'unknown', detail: 'Listed on L' }] });
    expect(r.domains.get('x.example')).toEqual({ status: 'unknown', hits: [] });
    expect(r.domains.has('not-asked.example')).toBe(false);
  });

  it('messageDomains tolerates missing fields', () => {
    expect(messageDomains({})).toEqual([]);
    expect(messageDomains({ fromAddress: 'a@localhost' })).toEqual([]); // no dot: nothing to look up
  });
});
