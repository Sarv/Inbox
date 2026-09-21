/**
 * Reputation — the spam filter's second stage, the one that needs the network.
 *
 * The header stage (spam-signals.ts) judges a message from what it carries.
 * This stage asks the world about who sent it: is the connecting IP on a
 * blocklist, is the sender's domain, has anyone else reported it. Those are
 * signals, not verdicts, so they come back as {@link SpamReason}s with points
 * that ADD to the header score — the same threshold, the same tag, the same
 * re-file, just a little later than insert.
 *
 * Two providers behind one interface:
 *
 *   - {@link SarvReputationProvider} — the Sarv-hosted service, reached with the
 *     user's Sarv OAuth bearer. One place holds the list licences (Spamhaus DQS
 *     and friends), the queries do not go to list operators from each user's
 *     machine, and it can add a signal no client can compute alone: how many
 *     OTHER users flagged this sender. The contract is in
 *     docs/REPUTATION_SERVICE.md.
 *
 *   - {@link LocalDnsblProvider} — plain DNSBL queries from this machine, for
 *     self-hosters and for running without the service. Honest about its
 *     limits: Spamhaus and URIBL REFUSE queries that arrive through public
 *     resolvers (Google, Cloudflare) and say so with a special return code; a
 *     naive "any A record means listed" would turn that refusal into a spam
 *     verdict for every sender. Every list here has its codes spelled out.
 *
 * Both fail OPEN: a provider that is down, slow, unauthorised or rate-limited
 * yields "unknown" — never "clean" (which would be cached as a fact) and never
 * a point. Nothing here caches; the main-process service does.
 */
import { SPAM_THRESHOLD, type SpamReason } from './spam-verdict';

// ---------------------------------------------------------------- interface

export interface ReputationQuery {
  ips: string[];
  domains: string[];
}

export interface ListHit {
  /** The list (zone or service feed) that has the entry. */
  list: string;
  /** What the list says it is: spam source, exploited host, policy (dynamic range), phishing, malware, abused, unknown. */
  category: string;
  /** One sentence for the shield. */
  detail: string;
}

export type ReputationStatus = 'listed' | 'clean' | 'unknown';

export interface ItemReputation {
  /** listed = at least one hit; clean = every list answered "not listed"; unknown = no usable answer. */
  status: ReputationStatus;
  hits: ListHit[];
  /** How many other users reported this sender, when the provider knows (the Sarv service). */
  userReports?: number;
  /** Why the answer is unknown, when it is — e.g. a refused query. */
  note?: string;
}

export interface ReputationResult {
  provider: string;
  ips: Map<string, ItemReputation>;
  domains: Map<string, ItemReputation>;
}

export type ReportVerdict = 'spam' | 'ham';

export interface SenderReport {
  domain: string | null;
  ip: string | null;
  verdict: ReportVerdict;
}

export interface ReputationProvider {
  readonly name: string;
  lookup(query: ReputationQuery): Promise<ReputationResult>;
  /**
   * Feed the user's verdict on a sender back, when the provider can use it
   * (the Sarv service counts them into `userReports`). Fire-and-forget and
   * fail-open; a provider without a report channel leaves this out.
   */
  report?(report: SenderReport): Promise<boolean>;
}

export const UNKNOWN: ItemReputation = { status: 'unknown', hits: [] };

/** A result in which nothing could be learned — what a failed provider returns. */
export function unknownResult(provider: string, query: ReputationQuery, note?: string): ReputationResult {
  const item: ItemReputation = note ? { status: 'unknown', hits: [], note } : UNKNOWN;
  return {
    provider,
    ips: new Map(query.ips.map((ip) => [ip, item])),
    domains: new Map(query.domains.map((d) => [d, item])),
  };
}

// ------------------------------------------------------------------ scoring

/** The points a category is worth. Listing categories a list operator uses. */
const CATEGORY_POINTS: Record<string, number> = {
  spam: 5, // a spam source (Spamhaus SBL/CSS, SpamCop, Barracuda, DBL spam)
  exploited: 5, // a compromised host / botnet member (Spamhaus XBL, DROP)
  phishing: 5,
  malware: 5,
  botnet: 5,
  policy: 3, // a range that should not be sending mail directly (Spamhaus PBL)
  abused: 2, // a legitimate domain currently abused (Spamhaus DBL 102-106)
  grey: 2, // URIBL grey: bulk senders of dubious value
  unknown: 3,
};
/** Everything the reputation stage can add, so it cannot bury a clean header stage on its own twice over. */
export const REPUTATION_MAX_POINTS = SPAM_THRESHOLD + 1;
/** Reports from other users needed before it counts. One report is one opinion. */
export const USER_REPORTS_MIN = 3;

/** Turn a result into the reasons to add to a message, given the message's own IP and domains. */
export function reputationReasons(result: ReputationResult, message: { originIp?: string | null; domains: string[] }): SpamReason[] {
  const reasons: SpamReason[] = [];
  let total = 0;
  const add = (id: SpamReason['id'], points: number, detail: string) => {
    const capped = Math.min(points, REPUTATION_MAX_POINTS - total);
    if (capped <= 0) return;
    total += capped;
    reasons.push({ id, points: capped, detail });
  };

  if (message.originIp) {
    const ip = result.ips.get(message.originIp);
    if (ip?.status === 'listed') {
      const best = ip.hits.reduce((a, h) => Math.max(a, CATEGORY_POINTS[h.category] ?? CATEGORY_POINTS.unknown), 0);
      const lists = [...new Set(ip.hits.map((h) => h.list))].join(', ');
      add('ip-blocklisted', best, `The sending server ${message.originIp} is on ${lists}: ${ip.hits[0].detail}`);
    }
  }
  for (const domain of [...new Set(message.domains.map((d) => d.toLowerCase()))]) {
    const rep = result.domains.get(domain);
    if (!rep) continue;
    if (rep.status === 'listed') {
      const best = rep.hits.reduce((a, h) => Math.max(a, CATEGORY_POINTS[h.category] ?? CATEGORY_POINTS.unknown), 0);
      const lists = [...new Set(rep.hits.map((h) => h.list))].join(', ');
      add('domain-blocklisted', best, `${domain} is on ${lists}: ${rep.hits[0].detail}`);
    }
    if ((rep.userReports ?? 0) >= USER_REPORTS_MIN) {
      add('user-reported', 3, `${rep.userReports} other Sarv Inbox users reported mail from ${domain} as spam`);
    }
  }
  return reasons;
}

/**
 * Points for a domain the message LINKS to. A link to a phishing or malware
 * site is the classic phish and decides alone; a link to a mere spam domain
 * is a strong hint; grey is a nudge. Same cap as the sender stage, shared —
 * the two stages together never add more than REPUTATION_MAX_POINTS.
 */
const LINK_CATEGORY_POINTS: Record<string, number> = {
  phishing: 5, malware: 5, botnet: 5, spam: 3, exploited: 3, abused: 2, grey: 1, policy: 1, unknown: 2,
};

/** Turn a result into the reasons the link domains of a message earn. */
export function linkReputationReasons(result: ReputationResult, linkDomains: string[], alreadyAdded = 0): SpamReason[] {
  const reasons: SpamReason[] = [];
  let total = Math.max(0, alreadyAdded);
  for (const domain of [...new Set(linkDomains.map((d) => d.toLowerCase()))]) {
    const rep = result.domains.get(domain);
    if (rep?.status !== 'listed') continue;
    const best = rep.hits.reduce((a, h) => Math.max(a, LINK_CATEGORY_POINTS[h.category] ?? LINK_CATEGORY_POINTS.unknown), 0);
    const capped = Math.min(best, REPUTATION_MAX_POINTS - total);
    if (capped <= 0) break;
    total += capped;
    const lists = [...new Set(rep.hits.map((h) => h.list))].join(', ');
    reasons.push({ id: 'link-blocklisted', points: capped, detail: `Links to ${domain}, which is on ${lists}: ${rep.hits[0].detail}` });
  }
  return reasons;
}

// ------------------------------------------------------------ local DNSBL

export interface DnsblList {
  /** DNS zone the query is appended to. */
  zone: string;
  /** Human name for the shield. */
  name: string;
  kind: 'ip' | 'domain';
  /** Whether IPv6 addresses may be queried (nibble format). */
  ipv6?: boolean;
  /**
   * Read the A records the zone answered with. `refused` means the zone
   * answered but declined to say (public-resolver block, rate limit) — the
   * answer is unknown, never listed.
   */
  interpret(records: string[]): { listed: boolean; refused: boolean; category: string; detail: string };
}

const lastOctet = (a: string): number => Number.parseInt(a.split('.').pop() ?? '', 10);

/** Spamhaus ZEN return codes (SBL, CSS, XBL, PBL, DROP) and its error codes. */
function interpretSpamhausZen(records: string[]) {
  const codes = records.map(lastOctet);
  const errors = records.filter((r) => r.startsWith('127.255.255.'));
  if (errors.length && errors.length === records.length) {
    return { listed: false, refused: true, category: 'unknown', detail: 'Spamhaus refused the query (public resolver or quota)' };
  }
  if (codes.some((c) => c === 2 || c === 3)) return { listed: true, refused: false, category: 'spam', detail: 'Spamhaus SBL/CSS lists it as a spam source' };
  if (codes.some((c) => c >= 4 && c <= 7)) return { listed: true, refused: false, category: 'exploited', detail: 'Spamhaus XBL lists it as an exploited or hijacked host' };
  if (codes.some((c) => c === 9)) return { listed: true, refused: false, category: 'exploited', detail: 'Spamhaus DROP: a hijacked or criminal network' };
  if (codes.some((c) => c === 10 || c === 11)) return { listed: true, refused: false, category: 'policy', detail: 'Spamhaus PBL: an address range that should not send mail directly' };
  return { listed: false, refused: false, category: 'unknown', detail: '' };
}

/** Spamhaus DBL (domains): 127.0.1.x. */
function interpretSpamhausDbl(records: string[]) {
  const codes = records.filter((r) => r.startsWith('127.0.1.')).map(lastOctet);
  if (records.some((r) => r === '127.0.1.255' || r.startsWith('127.255.255.'))) {
    return { listed: false, refused: true, category: 'unknown', detail: 'Spamhaus refused the query (public resolver or quota)' };
  }
  if (codes.includes(2)) return { listed: true, refused: false, category: 'spam', detail: 'Spamhaus DBL lists it as a spam domain' };
  if (codes.includes(4)) return { listed: true, refused: false, category: 'phishing', detail: 'Spamhaus DBL lists it as a phishing domain' };
  if (codes.includes(5)) return { listed: true, refused: false, category: 'malware', detail: 'Spamhaus DBL lists it as a malware domain' };
  if (codes.includes(6)) return { listed: true, refused: false, category: 'botnet', detail: 'Spamhaus DBL lists it as a botnet command-and-control domain' };
  if (codes.some((c) => c >= 102 && c <= 106)) return { listed: true, refused: false, category: 'abused', detail: 'Spamhaus DBL lists it as a legitimate domain currently abused by spammers' };
  return { listed: false, refused: false, category: 'unknown', detail: '' };
}

/** Lists that answer 127.0.0.2 for "listed" and nothing else meaningful. */
const interpretSimple = (name: string, detail: string) => (records: string[]) => ({
  listed: records.some((r) => r.startsWith('127.0.0.') && lastOctet(r) >= 2),
  refused: false,
  category: 'spam',
  detail: records.length ? `${name}: ${detail}` : '',
});

/** SURBL multi: a bitmask in the last octet. 127.0.0.1 is "query blocked". */
function interpretSurbl(records: string[]) {
  const mask = records.filter((r) => r.startsWith('127.0.0.')).reduce((m, r) => m | lastOctet(r), 0);
  if (records.some((r) => r === '127.0.0.1') && mask === 1) return { listed: false, refused: true, category: 'unknown', detail: 'SURBL blocked the query' };
  if (mask & 8) return { listed: true, refused: false, category: 'phishing', detail: 'SURBL lists it as a phishing domain' };
  if (mask & 16) return { listed: true, refused: false, category: 'malware', detail: 'SURBL lists it as a malware domain' };
  if (mask & (64 | 128)) return { listed: true, refused: false, category: 'spam', detail: 'SURBL lists it as an abused or cracked spam domain' };
  return { listed: false, refused: false, category: 'unknown', detail: '' };
}

/** URIBL multi: 2 black, 4 grey, 8 red; 127.0.0.1 is "query refused". */
function interpretUribl(records: string[]) {
  const mask = records.filter((r) => r.startsWith('127.0.0.')).reduce((m, r) => m | lastOctet(r), 0);
  if (records.some((r) => r === '127.0.0.1') && mask === 1) return { listed: false, refused: true, category: 'unknown', detail: 'URIBL refused the query (public resolver or quota)' };
  if (mask & (2 | 8)) return { listed: true, refused: false, category: 'spam', detail: 'URIBL lists it as a spam domain' };
  if (mask & 4) return { listed: true, refused: false, category: 'grey', detail: 'URIBL grey: a bulk sender of dubious value' };
  return { listed: false, refused: false, category: 'unknown', detail: '' };
}

/** The lists the local provider asks by default. Order = the order results are reported. */
export const DEFAULT_DNSBL_LISTS: readonly DnsblList[] = [
  { zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN', kind: 'ip', ipv6: true, interpret: interpretSpamhausZen },
  { zone: 'bl.spamcop.net', name: 'SpamCop', kind: 'ip', interpret: interpretSimple('SpamCop', 'reported by SpamCop users as a spam source') },
  { zone: 'b.barracudacentral.org', name: 'Barracuda', kind: 'ip', interpret: interpretSimple('Barracuda', 'listed as a spam source by Barracuda Reputation') },
  { zone: 'dbl.spamhaus.org', name: 'Spamhaus DBL', kind: 'domain', interpret: interpretSpamhausDbl },
  { zone: 'multi.surbl.org', name: 'SURBL', kind: 'domain', interpret: interpretSurbl },
  { zone: 'multi.uribl.com', name: 'URIBL', kind: 'domain', interpret: interpretUribl },
];

/** `1.2.3.4` → `4.3.2.1`; an IPv6 address → its 32 reversed nibbles. Null for anything else. */
export function dnsblLabel(ip: string): { label: string; v6: boolean } | null {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return { label: [v4[4], v4[3], v4[2], v4[1]].join('.'), v6: false };
  if (!ip.includes(':')) return null;
  // Expand :: and pad each group to four hex digits.
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const nibbles = groups.map((g) => g.padStart(4, '0')).join('').toLowerCase().split('');
  return { label: nibbles.reverse().join('.'), v6: true };
}

export interface DnsblDeps {
  /** `dns.promises.resolve4` shape. ENOTFOUND / ENODATA = not listed; anything else = unknown. */
  resolve4: (name: string) => Promise<string[]>;
  lists?: readonly DnsblList[];
  /** Queries in flight at once. */
  concurrency?: number;
}

const NOT_LISTED_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

/** Run `fn` over `items` with at most `n` in flight. */
async function pooled<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * DNSBL from this machine. One query per (item, list); a list's answer is
 * read through its own code table, so a refusal is unknown, not a listing.
 */
export class LocalDnsblProvider implements ReputationProvider {
  readonly name = 'local-dnsbl';
  private readonly lists: readonly DnsblList[];
  private readonly concurrency: number;

  constructor(private readonly deps: DnsblDeps) {
    this.lists = deps.lists ?? DEFAULT_DNSBL_LISTS;
    this.concurrency = Math.max(1, deps.concurrency ?? 8);
  }

  async lookup(query: ReputationQuery): Promise<ReputationResult> {
    const jobs: Array<{ kind: 'ip' | 'domain'; item: string; list: DnsblList; name: string }> = [];
    for (const ip of new Set(query.ips)) {
      const label = dnsblLabel(ip);
      if (!label) continue;
      for (const list of this.lists) {
        if (list.kind !== 'ip' || (label.v6 && !list.ipv6)) continue;
        jobs.push({ kind: 'ip', item: ip, list, name: `${label.label}.${list.zone}` });
      }
    }
    for (const domain of new Set(query.domains.map((d) => d.trim().toLowerCase()).filter(Boolean))) {
      for (const list of this.lists) {
        if (list.kind !== 'domain') continue;
        jobs.push({ kind: 'domain', item: domain, list, name: `${domain}.${list.zone}` });
      }
    }

    const answers = await pooled(jobs, this.concurrency, async (job) => {
      try {
        const records = await this.deps.resolve4(job.name);
        return { job, records, error: null as string | null };
      } catch (e) {
        const code = (e as { code?: string })?.code ?? '';
        return { job, records: NOT_LISTED_CODES.has(code) ? [] : null, error: NOT_LISTED_CODES.has(code) ? null : (code || (e as Error).message) };
      }
    });

    const result: ReputationResult = { provider: this.name, ips: new Map(), domains: new Map() };
    const bucket = (job: (typeof jobs)[number]) => (job.kind === 'ip' ? result.ips : result.domains);
    for (const { job, records, error } of answers) {
      const map = bucket(job);
      const cur = map.get(job.item) ?? { status: 'clean' as ReputationStatus, hits: [] as ListHit[], answered: 0, refused: 0 };
      const item = cur as ItemReputation & { answered?: number; refused?: number };
      if (records === null) {
        item.note = item.note ?? `${job.list.name}: ${error}`;
      } else {
        const read = job.list.interpret(records);
        if (read.refused) {
          item.refused = (item.refused ?? 0) + 1;
          item.note = item.note ?? read.detail;
        } else {
          item.answered = (item.answered ?? 0) + 1;
          if (read.listed) item.hits.push({ list: job.list.name, category: read.category, detail: read.detail });
        }
      }
      map.set(job.item, item);
    }
    for (const map of [result.ips, result.domains]) {
      for (const [k, v] of map) {
        const item = v as ItemReputation & { answered?: number; refused?: number };
        const status: ReputationStatus = item.hits.length ? 'listed' : (item.answered ?? 0) > 0 ? 'clean' : 'unknown';
        map.set(k, { status, hits: item.hits, ...(item.note && status !== 'listed' ? { note: item.note } : {}) });
      }
    }
    // Items with no eligible list (an IPv6 address on v4-only lists) are unknown.
    for (const ip of query.ips) if (!result.ips.has(ip)) result.ips.set(ip, UNKNOWN);
    for (const d of query.domains) if (!result.domains.has(d.trim().toLowerCase())) result.domains.set(d.trim().toLowerCase(), UNKNOWN);
    return result;
  }
}

// ------------------------------------------------------------- Sarv service

/** The wire shape — see docs/REPUTATION_SERVICE.md. */
export interface SarvReputationResponse {
  ips?: Array<{ ip: string; status?: ReputationStatus; listed?: Array<{ list: string; category?: string; detail?: string }> }>;
  domains?: Array<{ domain: string; status?: ReputationStatus; listed?: Array<{ list: string; category?: string; detail?: string }>; userReports?: number }>;
}

export interface SarvReputationDeps {
  /** Service origin, e.g. `https://reputation.sarv.com`. */
  endpoint: string;
  /** A valid Sarv OAuth access token, or null when nobody is signed in. */
  getToken: () => Promise<string | null>;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  timeoutMs?: number;
}

/**
 * The Sarv-hosted lookup. Batched (one request per sync batch), authenticated
 * with the user's own Sarv token, and fail-open: no token, a 4xx/5xx, a
 * timeout or malformed JSON all come back as unknown — mail is never held
 * hostage to a service.
 */
export class SarvReputationProvider implements ReputationProvider {
  readonly name = 'sarv';

  constructor(private readonly deps: SarvReputationDeps) {}

  async lookup(query: ReputationQuery): Promise<ReputationResult> {
    if (query.ips.length === 0 && query.domains.length === 0) return { provider: this.name, ips: new Map(), domains: new Map() };
    let token: string | null;
    try {
      token = await this.deps.getToken();
    } catch {
      token = null;
    }
    if (!token) return unknownResult(this.name, query, 'Not signed in to Sarv');

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 10_000) : null;
    try {
      const res = await this.deps.fetch(`${this.deps.endpoint.replace(/\/+$/, '')}/v1/reputation/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ips: query.ips, domains: query.domains }),
        signal: controller?.signal,
      });
      if (!res.ok) return unknownResult(this.name, query, `Sarv reputation service answered ${res.status}`);
      const body = (await res.json()) as SarvReputationResponse;
      return this.parse(body, query);
    } catch (e) {
      return unknownResult(this.name, query, `Sarv reputation service unreachable: ${(e as Error)?.message ?? e}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** POST /v1/reputation/report — the user's verdict, never their mail. True when the service accepted it. */
  async report(report: SenderReport): Promise<boolean> {
    if (!report.domain && !report.ip) return false;
    let token: string | null;
    try {
      token = await this.deps.getToken();
    } catch {
      token = null;
    }
    if (!token) return false;
    try {
      const res = await this.deps.fetch(`${this.deps.endpoint.replace(/\/+$/, '')}/v1/reputation/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ domain: report.domain, ip: report.ip, verdict: report.verdict }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private parse(body: SarvReputationResponse, query: ReputationQuery): ReputationResult {
    const result = unknownResult(this.name, query, 'No answer for this item');
    const toItem = (e: { status?: ReputationStatus; listed?: Array<{ list: string; category?: string; detail?: string }>; userReports?: number }): ItemReputation => {
      const hits: ListHit[] = (e.listed ?? []).map((h) => ({ list: h.list, category: h.category ?? 'unknown', detail: h.detail ?? `Listed on ${h.list}` }));
      const status: ReputationStatus = hits.length ? 'listed' : e.status === 'clean' ? 'clean' : 'unknown';
      return { status, hits, ...(e.userReports !== undefined ? { userReports: e.userReports } : {}) };
    };
    if (!body || typeof body !== 'object') return result;
    for (const e of Array.isArray(body.ips) ? body.ips : []) if (e?.ip && result.ips.has(e.ip)) result.ips.set(e.ip, toItem(e));
    for (const e of Array.isArray(body.domains) ? body.domains : []) if (e?.domain && result.domains.has(e.domain.toLowerCase())) result.domains.set(e.domain.toLowerCase(), toItem(e));
    return result;
  }
}

/** The distinct domains a message should be judged by: sender and Reply-To. */
export function messageDomains(email: { fromAddress?: string | null; replyTo?: string | null }): string[] {
  const out = new Set<string>();
  for (const addr of [email.fromAddress, email.replyTo]) {
    const at = (addr || '').lastIndexOf('@');
    if (at < 0) continue;
    const d = (addr || '').slice(at + 1).trim().toLowerCase();
    if (d.includes('.')) out.add(d);
  }
  return [...out];
}
