import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setSarvBaseUrl } from '../../../src/oauth/providers';
import { failureCause } from '../../../src/utils/error-diagnostic';
import {
  DEFAULT_DNSBL_LISTS,
  LocalDnsblProvider,
  REPUTATION_MAX_POINTS,
  SARV_REPUTATION_REFUSED_NOTE,
  SarvReputationProvider,
  USER_REPORTS_MIN,
  linkReputationReasons,
  messageDomains,
  reputationAssessment,
  unknownResult,
  type ReputationResult,
} from '../../../src/utils/spam-reputation';

/**
 * The reputation origin these tests configure — the only address the provider
 * will send its bearer to. No build has one (Sarv runs no such service yet), so
 * it is set here the way a dev build's override sets it; `.test` never resolves.
 */
const SARV_REP = 'https://reputation.sarv.test';
beforeAll(() => setSarvBaseUrl({ reputationBase: SARV_REP }));
afterAll(() => setSarvBaseUrl({ reputationBase: '' }));

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
 * (`@sarv-in/mailguard/reputation`, where they have their own suite);
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

/** The reasons alone, as most of these assertions want them. */
const reputationReasons = (...args: Parameters<typeof reputationAssessment>) => reputationAssessment(...args).reasons;

// THE one place a sender's listings become points — at ingest, whichever
// provider answered. A second reading of the same answers is how one listing
// used to be charged twice.
describe('reputationAssessment', () => {
  const result = (over: Partial<{ ips: ReputationResult['ips']; domains: ReputationResult['domains'] }>): ReputationResult => ({
    provider: 'test', ips: over.ips ?? new Map(), domains: over.domains ?? new Map(),
  });
  const hit = (list: string, category: string) => ({ list, category, detail: `${list} says ${category}` });

  // The assessment ingest merges into the header score: a spam-source
  // listing alone is spam, a policy listing alone only suspicious.
  it('adds up to an assessment ingest can merge, spam from a spam source alone', () => {
    const listed = (category: string) => result({ ips: new Map([['1.2.3.4', { status: 'listed', hits: [hit('Spamhaus ZEN', category)] }]]) });
    expect(reputationAssessment(listed('spam'), { originIp: '1.2.3.4', domains: [] })).toMatchObject({ score: 5, isSpam: true, suspicious: true });
    expect(reputationAssessment(listed('policy'), { originIp: '1.2.3.4', domains: [] })).toMatchObject({ score: 3, isSpam: false, suspicious: true });
    expect(reputationAssessment(result({}), { originIp: '1.2.3.4', domains: [] })).toMatchObject({ score: 0, reasons: [] });
  });

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

  // Behaviour changed (reputation-token fix): the address used to be any https
  // host; only Sarv's reputation origin is asked now, so it is what this uses.
  it('posts the batch with the bearer and reads listings and reports', async () => {
    const seen: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const p = new SarvReputationProvider({
      endpoint: `${SARV_REP}/`,
      getToken: async () => 'tok-1',
      fetch: fetchWith(200, {
        ips: [{ ip: '1.2.3.4', status: 'listed', listed: [{ list: 'Spamhaus ZEN', category: 'spam', detail: 'SBL' }] }],
        domains: [{ domain: 'X.example', status: 'clean', listed: [], userReports: 4 }],
      }, seen as never),
    });
    const r = await p.lookup(query);
    expect(seen[0].url).toBe(`${SARV_REP}/v1/reputation/lookup`);
    expect(seen[0].init.headers.authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seen[0].init.body)).toEqual(query);
    expect(r.ips.get('1.2.3.4')).toMatchObject({ status: 'listed', hits: [{ list: 'Spamhaus ZEN', category: 'spam' }] });
    expect(r.domains.get('x.example')).toMatchObject({ status: 'clean', userReports: 4 });
  });

  // Fail OPEN, every way it can fail.
  it('is unknown — never clean — without a token, on an error status, on bad JSON, or when unreachable', async () => {
    const base = { endpoint: SARV_REP, fetch: fetchWith(200, {}) };
    expect((await new SarvReputationProvider({ ...base, getToken: async () => null }).lookup(query)).ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: expect.stringContaining('signed in') });
    expect((await new SarvReputationProvider({ ...base, getToken: async () => { throw new Error('refresh failed'); } }).lookup(query)).ips.get('1.2.3.4')?.status).toBe('unknown');
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: fetchWith(503, {}) }).lookup(query)).ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: expect.stringContaining('503') });
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) }).lookup(query)).ips.get('1.2.3.4')?.status).toBe('unknown');
    // Behaviour changed: the note names the failure's code, not its message
    // (which can quote an address or the text a parse choked on).
    const refused = Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), { code: 'ECONNREFUSED' });
    const unreachable = (await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: async () => { throw refused; } }).lookup(query)).domains.get('x.example');
    expect(unreachable).toMatchObject({ status: 'unknown', note: 'Sarv reputation service unreachable (ECONNREFUSED)' });
    // Items the service left out of a good answer are unknown too.
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: fetchWith(200, { ips: [] }) }).lookup(query)).ips.get('1.2.3.4')?.status).toBe('unknown');
    expect((await new SarvReputationProvider({ ...base, getToken: async () => 't', fetch: fetchWith(200, 'nonsense') }).lookup(query)).ips.get('1.2.3.4')?.status).toBe('unknown');
  });

  it('makes no request for an empty query', async () => {
    const fetch = vi.fn();
    const r = await new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => 't', fetch }).lookup({ ips: [], domains: [] });
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
      endpoint: SARV_REP, getToken: async () => 't',
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

describe('linkReputationReasons', () => {
  const result = (domains: Record<string, { category: string; list?: string }>): ReputationResult => ({
    provider: 'test', ips: new Map(),
    domains: new Map(Object.entries(domains).map(([d, h]) => [d, { status: 'listed' as const, hits: [{ list: h.list ?? 'Spamhaus DBL', category: h.category, detail: `${h.category} domain` }] }])),
  });

  // THE classic phish: it comes from anywhere and links to a listed site.
  it('lets a phishing or malware link decide alone, and grades the rest', () => {
    expect(linkReputationReasons(result({ 'evil.example': { category: 'phishing' } }), ['evil.example'])).toEqual([
      { id: 'reputation-link-listed', points: 5, detail: expect.stringContaining('Links to evil.example, which is on Spamhaus DBL') },
    ]);
    expect(linkReputationReasons(result({ 's.example': { category: 'spam' } }), ['s.example'])[0].points).toBe(3);
    expect(linkReputationReasons(result({ 'g.example': { category: 'grey', list: 'URIBL' } }), ['g.example'])[0].points).toBe(1);
    expect(linkReputationReasons(result({ 'w.example': { category: 'weird' } }), ['w.example'])[0].points).toBe(2);
  });

  it('shares the cap with the sender stage and skips clean or unknown link domains', () => {
    const r = result({ 'a.example': { category: 'phishing' }, 'b.example': { category: 'phishing' } });
    const reasons = linkReputationReasons(r, ['a.example', 'A.example', 'b.example', 'clean.example'], 2);
    expect(reasons.map((x) => x.points)).toEqual([4]); // 6 − 2 already added; the second listing has no room left
    expect(linkReputationReasons(r, ['a.example'], REPUTATION_MAX_POINTS)).toEqual([]);
    expect(linkReputationReasons(unknownResult('t', { ips: [], domains: ['u.example'] }), ['u.example'])).toEqual([]);
  });
});

describe('SarvReputationProvider.report', () => {
  const seen: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
  const provider = (status = 202, token: string | null = 'tok') => new SarvReputationProvider({
    endpoint: `${SARV_REP}/`, getToken: async () => token,
    fetch: async (url, init) => { seen.push({ url, init: init as never }); return { ok: status < 400, status, json: async () => ({}) }; },
  });

  it('posts the sender domain, address and verdict with the bearer — and nothing else', async () => {
    seen.length = 0;
    expect(await provider().report({ domain: 'spam.example', ip: '1.2.3.4', verdict: 'spam' })).toBe(true);
    expect(seen[0].url).toBe(`${SARV_REP}/v1/reputation/report`);
    expect(seen[0].init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(seen[0].init.body)).toEqual({ domain: 'spam.example', ip: '1.2.3.4', verdict: 'spam' });
  });

  // Fail-open: a report is a courtesy, never a blocker.
  it('is false without a token, without anything to report, on an error status, or when unreachable', async () => {
    expect(await provider(202, null).report({ domain: 'x.example', ip: null, verdict: 'ham' })).toBe(false);
    expect(await provider().report({ domain: null, ip: null, verdict: 'spam' })).toBe(false);
    expect(await provider(500).report({ domain: 'x.example', ip: null, verdict: 'spam' })).toBe(false);
    const broken = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => 't', fetch: async () => { throw new Error('ECONNRESET'); } });
    expect(await broken.report({ domain: 'x.example', ip: null, verdict: 'spam' })).toBe(false);
    const noToken = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => { throw new Error('refresh failed'); }, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    expect(await noToken.report({ domain: 'x.example', ip: null, verdict: 'spam' })).toBe(false);
  });
});

/**
 * The breakers, at the provider — where they live, because only a provider
 * knows what one of its failures looks like. What this protects: every
 * question here is asked on the ingest path, so a zone or a service that will
 * never answer is paid for by every message behind it unless something stops
 * asking. (The same breakers seen through the stage, as ingest sees them, are
 * pinned in reputation-stage.test.ts.)
 */
describe('LocalDnsblProvider — per-zone breakers', () => {
  const zen = DEFAULT_DNSBL_LISTS.find((list) => list.name === 'spamhaus-zen')!;
  const dbl = DEFAULT_DNSBL_LISTS.find((list) => list.name === 'spamhaus-dbl')!;
  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  // Regression: a batch of link domains gives an IP zone nothing to ask. It
  // must not count as that zone answering — which would keep forgiving a zone
  // that refuses every address — nor as it failing.
  it('neither forgives nor fails a zone the call gave nothing to ask', async () => {
    const spy = warn();
    const answers: Answers = {};
    for (let i = 1; i <= 9; i += 1) answers[`${i}.3.2.1.zen.spamhaus.org`] = ['127.255.255.254'];
    const p = new LocalDnsblProvider({ resolve4: resolver(answers), lists: [zen, dbl], breaker: { failureThreshold: 3 } });

    await p.lookup({ ips: ['1.2.3.1'], domains: [] });
    await p.lookup({ ips: [], domains: ['a.example'] });
    await p.lookup({ ips: ['1.2.3.2'], domains: [] });
    await p.lookup({ ips: [], domains: ['b.example'] });
    expect(p.activeLists().map((list) => list.name)).toEqual(['spamhaus-zen', 'spamhaus-dbl']);
    await p.lookup({ ips: ['1.2.3.3'], domains: [] });
    expect(p.activeLists().map((list) => list.name)).toEqual(['spamhaus-dbl']);
    spy.mockRestore();
  });

  // A zone that answered ANY item in a batch is answering this network.
  it('forgives a zone that answered part of a batch', async () => {
    const answers: Answers = { '1.3.2.1.zen.spamhaus.org': 'timeout', '2.3.2.1.zen.spamhaus.org': 'timeout' };
    const p = new LocalDnsblProvider({ resolve4: resolver(answers), lists: [zen], breaker: { failureThreshold: 2 } });

    for (let i = 0; i < 3; i += 1) await p.lookup({ ips: ['1.2.3.1', '1.2.3.2', '1.2.3.9'], domains: [] });
    expect(p.activeLists()).toHaveLength(1);
  });

  // THE gate: no zone configured means no query — and no note either, because
  // nothing went wrong.
  it('asks nothing, and answers unknown, with no zone configured', async () => {
    const calls: string[] = [];
    const r = await new LocalDnsblProvider({ resolve4: resolver({}, calls), lists: [] }).lookup({ ips: ['1.2.3.4'], domains: ['x.example'] });
    expect(calls).toEqual([]);
    expect(r.ips.get('1.2.3.4')).toEqual({ status: 'unknown', hits: [] });
    expect(r.domains.get('x.example')).toEqual({ status: 'unknown', hits: [] });
  });

  it('says why it asked nobody when every zone is resting', async () => {
    const spy = warn();
    const calls: string[] = [];
    const p = new LocalDnsblProvider({ resolve4: resolver({ '4.3.2.1.zen.spamhaus.org': 'timeout' }, calls), lists: [zen], breaker: { failureThreshold: 1 } });
    await p.lookup({ ips: ['1.2.3.4'], domains: [] });
    const r = await p.lookup({ ips: ['1.2.3.4'], domains: [] });
    expect(calls).toHaveLength(1);
    expect(r.ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: expect.stringContaining('resting') });
    spy.mockRestore();
  });
});

describe('SarvReputationProvider — the breaker', () => {
  const query = { ips: ['1.2.3.4'], domains: [] };

  // Regression: the service is asked as mail arrives. One that is down must
  // be paused after a run of failures, or every new sender's message waits
  // out the full request timeout before it can be filed.
  it('pauses after consecutive failures, and asks again after the cooldown', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clock = { now: 1_000 };
    const fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const p = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => 't', fetch, breaker: { failureThreshold: 2, cooldownMs: 60_000, now: () => clock.now } });

    await p.lookup(query);
    await p.lookup(query);
    const paused = await p.lookup(query);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(paused.ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: expect.stringContaining('paused') });

    clock.now += 60_001;
    await p.lookup(query);
    expect(fetch).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  // Not being signed in costs no request, so it is not a failure — and an
  // answer in between failures forgives them.
  it('counts neither a missing sign-in nor failures an answer came between', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let token: string | null = null;
    let ok = false;
    const fetch = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ ips: [] }) }));
    const p = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => token, fetch, breaker: { failureThreshold: 2 } });

    for (let i = 0; i < 5; i += 1) await p.lookup(query);
    expect(fetch).not.toHaveBeenCalled();

    token = 't';
    await p.lookup(query); // fails
    ok = true;
    await p.lookup(query); // answers
    ok = false;
    await p.lookup(query); // fails — one in a row, not two
    await p.lookup(query); // fails — two: now paused
    await p.lookup(query);
    expect(fetch).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });
});

/**
 * Where the Sarv bearer goes. The address comes from a renderer-written
 * setting, and the bearer is also the Sarv mailbox's XOAUTH2 credential, so the
 * provider itself — where the Authorization header is attached, whoever built
 * it — sends only to Sarv's reputation origin, never follows a redirect, and
 * treats any other address as refused for good rather than as an outage.
 */
describe('SarvReputationProvider — where the bearer may go', () => {
  const query = { ips: ['1.2.3.4'], domains: ['x.example'] };
  type Seen = { url: string; init: { redirect?: string; headers: Record<string, string> } };
  const answering = (seen: Seen[]) => vi.fn(async (url: string, init: unknown) => {
    seen.push({ url, init: init as Seen['init'] });
    return { ok: true, status: 200, json: async () => ({ ips: [], domains: [] }) };
  });

  // Breaks: any constructor of the provider other than main's
  // providerForSettings can still send the bearer to a renderer-chosen host.
  it.each([
    'https://rep.sarv.example',
    'https://reputation.sarv.test.evil.example',
    'https://user:pw@reputation.sarv.test',
    'http://reputation.sarv.test',
    'https://reputation.sarv.test/v1',
    '',
  ])('asks nothing and mints no token for %j', async (endpoint) => {
    const getToken = vi.fn(async () => 'tok');
    const fetch = vi.fn();
    const p = new SarvReputationProvider({ endpoint, getToken, fetch });

    const r = await p.lookup(query);
    expect(r.ips.get('1.2.3.4')).toEqual({ status: 'unknown', hits: [], note: SARV_REPUTATION_REFUSED_NOTE });
    expect(r.domains.get('x.example')).toEqual({ status: 'unknown', hits: [], note: SARV_REPUTATION_REFUSED_NOTE });
    expect(await p.report({ domain: 'spam.example', ip: '1.2.3.4', verdict: 'spam' })).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  // Breaks: a build with no reputation origin (every build, until Sarv runs the
  // service) still sends the bearer to the address the settings name.
  it('asks nothing and mints no token, even for the address it asked a moment ago, once no origin is configured', async () => {
    setSarvBaseUrl({ reputationBase: '' });
    try {
      const getToken = vi.fn(async () => 'tok');
      const fetch = vi.fn();
      const p = new SarvReputationProvider({ endpoint: SARV_REP, getToken, fetch });
      expect((await p.lookup(query)).ips.get('1.2.3.4')?.note).toBe(SARV_REPUTATION_REFUSED_NOTE);
      expect(await p.report({ domain: 'spam.example', ip: '1.2.3.4', verdict: 'spam' })).toBe(false);
      expect(getToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      setSarvBaseUrl({ reputationBase: SARV_REP });
    }
  });

  // Breaks: what the policy checked and what is fetched diverge (the raw
  // string used to be concatenated, so a typed spelling was the destination).
  it('sends lookup and report to the canonical origin, never the typed spelling', async () => {
    const seen: Seen[] = [];
    const p = new SarvReputationProvider({ endpoint: 'https://REPUTATION.sarv.test.:443/', getToken: async () => 'tok', fetch: answering(seen) });

    await p.lookup(query);
    await p.report({ domain: 'spam.example', ip: null, verdict: 'spam' });
    expect(seen.map((s) => s.url)).toEqual([`${SARV_REP}/v1/reputation/lookup`, `${SARV_REP}/v1/reputation/report`]);
  });

  // Breaks: a 307/308 from the service re-POSTs the sender list, and on a
  // same-site hop the bearer, to wherever Location points.
  it('refuses redirects on lookup and report', async () => {
    const seen: Seen[] = [];
    const p = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => 'tok', fetch: answering(seen) });

    await p.lookup(query);
    await p.report({ domain: 'spam.example', ip: null, verdict: 'ham' });
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.init.redirect === 'error')).toBe(true);
    expect(seen.every((s) => s.init.headers.authorization === 'Bearer tok')).toBe(true);
  });

  // Breaks: a permanent refusal is treated like an outage — paused, retried,
  // warned about every cooldown — so a corrected address is ignored for half an
  // hour, or app.log fills with a line per arriving message.
  it('never steps or trips the breaker for a refused address', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getToken = vi.fn(async () => 'tok');
    const p = new SarvReputationProvider({ endpoint: 'https://evil.example', getToken, fetch: vi.fn(), breaker: { failureThreshold: 1 } });

    for (let i = 0; i < 5; i += 1) {
      expect((await p.lookup(query)).ips.get('1.2.3.4')?.note).toBe(SARV_REPUTATION_REFUSED_NOTE);
    }
    expect(getToken).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // Breaks: a transient blip (a reset, a 503, a timeout) is read as permanent
  // and the next message is not asked, or one is cached as an answer.
  it('asks again after a reset, a 503 or a timeout, each one unknown', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcomes: Array<'reset' | 503 | 'timeout' | 'ok'> = ['reset', 503, 'timeout', 'ok'];
    const fetch = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      const next = outcomes.shift();
      if (next === 'reset') throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      if (next === 'timeout') {
        return new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
        });
      }
      if (next === 503) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ips: [{ ip: '1.2.3.4', status: 'clean' }] }) };
    });
    const p = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => 't', fetch, timeoutMs: 5, breaker: { failureThreshold: 5 } });

    const notes = [];
    for (let i = 0; i < 3; i += 1) notes.push((await p.lookup({ ips: ['1.2.3.4'], domains: [] })).ips.get('1.2.3.4'));
    expect(notes).toEqual([
      { status: 'unknown', hits: [], note: 'Sarv reputation service unreachable (ECONNRESET)' },
      { status: 'unknown', hits: [], note: 'Sarv reputation service answered 503' },
      { status: 'unknown', hits: [], note: 'Sarv reputation service unreachable (AbortError)' },
    ]);
    expect((await p.lookup({ ips: ['1.2.3.4'], domains: [] })).ips.get('1.2.3.4')?.status).toBe('clean');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(spy).not.toHaveBeenCalled(); // three in a row is below this breaker's threshold
    spy.mockRestore();
  });

  // Breaks: the breaker's warning (a release app.log line) quotes an address
  // from the failure or the text a parse error choked on.
  it('names only what the failure was when the breaker trips', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    const failures: unknown[] = [
      Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), { code: 'ECONNREFUSED' }),
      new SyntaxError('Unexpected token < in JSON: <html>private-body-text'),
      // A transport that throws on an error status, with the body in its message.
      Object.assign(new Error('Bad Gateway: <html>private-body-text'), { status: 502 }),
    ];
    for (const failure of failures) {
      const p = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => 't', fetch: async () => { throw failure; }, breaker: { failureThreshold: 1 } });
      await p.lookup(query);
    }
    const rateLimited = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => 't', fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }), breaker: { failureThreshold: 1 } });
    await rateLimited.lookup(query);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('Last error: ECONNREFUSED');
    expect(lines[1]).toContain('Last error: SyntaxError');
    expect(lines[2]).toContain('Last error: status 502');
    expect(lines[3]).toContain('Last error: status 429');
    expect(lines.join('\n')).not.toMatch(/203\.0\.113\.9|private-body-text/);
    spy.mockRestore();
  });

  // Breaks: main's fetch is Electron's net.fetch, which rejects with a plain
  // Error whose only identifier is its message. Without this the note and the
  // breaker's warn say just "Error" while the service's host does not resolve.
  it('keeps Chromium’s net::ERR_ name for a net.fetch failure, and nothing else of its message', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    const failures: Array<[unknown, string]> = [
      [new Error('net::ERR_NAME_NOT_RESOLVED'), 'net::ERR_NAME_NOT_RESOLVED'],
      // A wrapper that adds words around it, one of them the host.
      [new TypeError('fetch to reputation.sarv.test failed: net::ERR_CONNECTION_REFUSED'), 'net::ERR_CONNECTION_REFUSED'],
      // A real machine code still wins over a token in the message.
      [Object.assign(new Error('net::ERR_FAILED'), { code: 'ECONNRESET' }), 'ECONNRESET'],
      // Lower case, or no name after the prefix, is not Chromium's: the class.
      [new Error('net::err_failed at reputation.sarv.test'), 'Error'],
      [new Error('net::ERR_'), 'Error'],
    ];
    for (const [failure, cause] of failures) {
      const p = new SarvReputationProvider({ endpoint: SARV_REP, getToken: async () => 't', fetch: async () => { throw failure; }, breaker: { failureThreshold: 1 } });
      expect((await p.lookup(query)).domains.get('x.example')?.note).toBe(`Sarv reputation service unreachable (${cause})`);
      expect(failureCause(failure)).toBe(cause);
    }
    expect(lines.map((line) => line.slice(line.indexOf('Last error: ')))).toEqual(failures.map(([, cause]) => `Last error: ${cause}`));
    expect(lines.join('\n')).not.toContain('reputation.sarv.test');
    // A thrown non-Error has no message to read.
    expect(failureCause('net::ERR_FAILED')).toBe('string');
    spy.mockRestore();
  });
});

/**
 * What a failed DNS lookup leaves behind. Node's resolver names the query in its
 * message — a sender's reversed address, or a domain the mail links to — and
 * that message used to become the zone's note (shown on the Security page and
 * logged by the background pass) and its breaker's warning.
 */
describe('LocalDnsblProvider — failures name no query', () => {
  const zen = DEFAULT_DNSBL_LISTS.find((list) => list.name === 'spamhaus-zen')!;
  const dbl = DEFAULT_DNSBL_LISTS.find((list) => list.name === 'spamhaus-dbl')!;
  const failing = (make: (name: string) => unknown) => async (name: string): Promise<string[]> => { throw make(name); };

  // Breaks: app.log and the Security page carry the sender's address or a
  // domain from the mail as part of a resolver error.
  it('keeps the code of a resolver failure, not the name it asked about', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    const p = new LocalDnsblProvider({
      resolve4: failing((name) => Object.assign(new Error(`queryA ETIMEOUT ${name}`), { code: 'ETIMEOUT' })),
      lists: [zen, dbl],
      breaker: { failureThreshold: 1 },
    });

    const r = await p.lookup({ ips: ['1.2.3.4'], domains: ['secret-link.example'] });
    expect(r.ips.get('1.2.3.4')).toMatchObject({ status: 'unknown', note: 'Spamhaus ZEN: ETIMEOUT' });
    expect(r.domains.get('secret-link.example')).toMatchObject({ status: 'unknown', note: 'Spamhaus DBL: ETIMEOUT' });
    expect(lines).toHaveLength(2); // both zones tripped, once each
    expect(lines.every((line) => line.includes('Last error: ETIMEOUT'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/4\.3\.2\.1|secret-link/);
    spy.mockRestore();
  });

  // Breaks: a failure with no code (a library bug, a TypeError) is logged with
  // its message, which may quote the query too.
  it('keeps the class of a failure that has no code', async () => {
    const p = new LocalDnsblProvider({ resolve4: failing((name) => new TypeError(`bad answer for ${name}`)), lists: [dbl] });
    const r = await p.lookup({ ips: [], domains: ['secret-link.example'] });
    expect(r.domains.get('secret-link.example')).toMatchObject({ status: 'unknown', note: 'Spamhaus DBL: TypeError' });
  });

  // Breaks: an answer that is a refusal stops being read as one (the library's
  // own sentence, which names no query, is what the note carries).
  it('still explains an operator refusal in the library’s words', async () => {
    const p = new LocalDnsblProvider({ resolve4: resolver({ '4.3.2.1.zen.spamhaus.org': ['127.255.255.254'] }), lists: [zen] });
    const note = (await p.lookup({ ips: ['1.2.3.4'], domains: [] })).ips.get('1.2.3.4')?.note ?? '';
    expect(note).toMatch(/^Spamhaus ZEN: .*resolver/);
    expect(note).not.toContain('4.3.2.1');
  });
});
