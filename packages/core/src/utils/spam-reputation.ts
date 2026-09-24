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
 * The blocklist catalogue, the return-code tables and the scoring all live in
 * `@sarv-in/mailguard/reputation` now. What stays here is the part that
 * is Inbox's rather than the library's: TWO PROVIDERS BEHIND ONE INTERFACE,
 * so the main process can cache and swap them.
 *
 *   - {@link SarvReputationProvider} — the Sarv-hosted service, reached with the
 *     user's Sarv OAuth bearer. One place holds the list licences (Spamhaus DQS
 *     and friends), the queries do not go to list operators from each user's
 *     machine, and it can add a signal no client can compute alone: how many
 *     OTHER users flagged this sender. The contract is in
 *     docs/REPUTATION_SERVICE.md.
 *
 *   - {@link LocalDnsblProvider} — plain DNSBL queries from this machine, for
 *     self-hosters and for running without the service. It is a thin adapter
 *     over the library's `checkReputationBatch`, which owns the zones, the
 *     pooling and the codes — including the refusals Spamhaus and URIBL answer
 *     a public resolver with, which a naive "any A record means listed" would
 *     turn into a spam verdict for every sender.
 *
 * Both fail OPEN: a provider that is down, slow, unauthorised or rate-limited
 * yields "unknown" — never "clean" (which would be cached as a fact) and never
 * a point. Nothing here caches; the reputation stage in front of them does
 * (packages/core/src/imap/reputation-stage.ts).
 *
 * Both also carry a CIRCUIT BREAKER, because both are asked on the ingest path
 * and a failure there is paid for by every message that follows it: the local
 * provider retires one zone at a time (the big operators refuse queries from
 * public resolvers, and one refusing zone must not silence the others), and the
 * Sarv provider pauses as a whole (one service, one failure mode).
 */
import {
  BLOCKLISTS,
  REPUTATION_MAX_POINTS,
  USER_REPORTS_MIN,
  assessReputation,
  checkReputationBatch,
  type Blocklist,
  type BlocklistCategory,
  type BlocklistHit,
  type BlocklistKind,
  type DnsQuery,
  type ReputationResult as BlocklistReport,
  type ReputationTarget,
} from '@sarv-in/mailguard/reputation';
import type { SpamAssessment, SpamReason } from '@sarv-in/mailguard/verdict';

import { CircuitBreakers, type CircuitBreakerOptions } from './circuit-breaker';
import { logger } from './logger';

/** The zones the local provider asks by default, and how to read their answers. */
export { BLOCKLISTS as DEFAULT_DNSBL_LISTS };
/** Everything the reputation stage can add, so it cannot bury a clean header stage on its own twice over. */
export { REPUTATION_MAX_POINTS };
/** Reports from other users needed before it counts. One report is one opinion. */
export { USER_REPORTS_MIN };
export type { Blocklist };

// ---------------------------------------------------------------- interface

export interface ReputationQuery {
  ips: string[];
  domains: string[];
}

export interface ListHit {
  /** The list (zone or service feed) that has the entry. */
  list: string;
  /** The DNS zone behind that name, when the answer came from one. */
  zone?: string;
  /** What the list says it is: spam source, exploited host, policy (dynamic range), phishing, malware, abused, unknown. */
  category: string;
  /** One sentence for the shield. */
  detail: string;
  /** What the operator's own code table says the listing is worth, when it said. */
  points?: number;
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

/**
 * The user's own word on a message, which outranks every score: 'ham' means
 * "not spam, and do not file it again whatever the filter finds"; 'spam'
 * means "spam, whatever the score said". Stored in emails.spam_user_verdict;
 * null when the user has not said.
 *
 * It lives here rather than with the scoring types because it is not one of
 * the library's verdicts at all — the library scores a message from evidence,
 * and this is a person overruling it. It is also what the report loop below
 * sends to the Sarv service, so the stored value and the reported one can
 * never drift apart.
 */
export type SpamUserVerdict = 'spam' | 'ham';

export interface SenderReport {
  domain: string | null;
  ip: string | null;
  verdict: SpamUserVerdict;
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

/**
 * What a category is worth when the hit does not say.
 *
 * The library's catalogue prices every return code of every zone it knows, so
 * a local lookup arrives with its own points. This table exists for the OTHER
 * provider: the Sarv service's wire contract names a category per listing and
 * no points (docs/REPUTATION_SERVICE.md), and a category has to be worth
 * something before it can be scored.
 */
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

const KNOWN_CATEGORIES = new Set<string>([
  'spam', 'exploited', 'phishing', 'malware', 'botnet', 'policy', 'abused', 'grey',
]);

/** One stored/served hit in the shape the library scores. */
function blocklistHit(hit: ListHit, kind: BlocklistKind, target: string): BlocklistHit {
  return {
    name: hit.list,
    zone: hit.zone ?? hit.list,
    kind,
    target,
    codes: [],
    meanings: hit.detail ? [hit.detail] : [],
    categories: KNOWN_CATEGORIES.has(hit.category) ? [hit.category as BlocklistCategory] : [],
    points: hit.points ?? CATEGORY_POINTS[hit.category] ?? CATEGORY_POINTS.unknown,
    text: null,
  };
}

/**
 * Turn a result into the assessment a message earns, given the message's own
 * IP and domains — THE one place a sender's listings become points, whichever
 * provider answered and whenever it was asked.
 *
 * The scoring is the library's {@link assessReputation}: the highest hit per
 * side rather than the sum (the public lists mirror each other, so three zones
 * naming the same address is one observation, not three), address first, then
 * domain, then the reports, all under one shared budget. Assembling a single
 * report for the whole message — rather than scoring each item — is what keeps
 * that budget shared.
 */
export function reputationAssessment(result: ReputationResult, message: { originIp?: string | null; domains: string[] }): SpamAssessment {
  const originIp = message.originIp ?? null;
  const hits: BlocklistHit[] = [];
  const consulted: ItemReputation[] = [];

  const ip = originIp ? result.ips.get(originIp) : undefined;
  if (ip) {
    consulted.push(ip);
    if (ip.status === 'listed') hits.push(...ip.hits.map((hit) => blocklistHit(hit, 'ip', originIp as string)));
  }

  // The domain the reports are about: the most-reported one, so a message whose
  // From is clean and whose Reply-To is notorious is still charged for it.
  let reportedDomain: string | null = null;
  let userReports = 0;
  for (const domain of [...new Set(message.domains.map((d) => d.toLowerCase()))]) {
    const rep = result.domains.get(domain);
    if (!rep) continue;
    consulted.push(rep);
    if (rep.status === 'listed') hits.push(...rep.hits.map((hit) => blocklistHit(hit, 'domain', domain)));
    if ((rep.userReports ?? 0) > userReports) {
      userReports = rep.userReports ?? 0;
      reportedDomain = domain;
    }
  }

  const report: BlocklistReport = {
    ip: originIp,
    domain: reportedDomain,
    listed: hits.length > 0,
    hits,
    checked: [],
    errors: [],
    completed: consulted.length > 0 && consulted.every((item) => item.status !== 'unknown'),
  };
  return assessReputation(report, { userReports });
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
    reasons.push({ id: 'reputation-link-listed', points: capped, detail: `Links to ${domain}, which is on ${lists}: ${rep.hits[0].detail}` });
  }
  return reasons;
}

// ------------------------------------------------------------ local DNSBL

export interface DnsblDeps {
  /** `dns.promises.resolve4` shape. ENOTFOUND / ENODATA / NXDOMAIN = not listed; anything else = unknown. */
  resolve4: (name: string) => Promise<string[]>;
  /** The zones to ask. EMPTY MEANS NOBODY IS ASKED. Default: the whole catalogue. */
  lists?: readonly Blocklist[];
  /** Queries in flight at once. */
  concurrency?: number;
  /** Each zone's breaker: consecutive failed lookups that retire it, and for how long. */
  breaker?: CircuitBreakerOptions;
}

const NOT_LISTED_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

/**
 * The operator's own name for each zone, for the sentence a reader sees.
 *
 * The library reports a stable id (`spamhaus-zen`) because an id is what code
 * should match on and what survives a rename; "Spamhaus ZEN" is what the
 * shield has said since the filter shipped, and a reason line is read by a
 * person. An unknown zone falls back to the id rather than to nothing.
 */
const DNSBL_LABELS: Readonly<Record<string, string>> = {
  'zen.spamhaus.org': 'Spamhaus ZEN',
  'bl.spamcop.net': 'SpamCop',
  'b.barracudacentral.org': 'Barracuda',
  'dbl.spamhaus.org': 'Spamhaus DBL',
  'multi.surbl.org': 'SURBL',
  'multi.uribl.com': 'URIBL',
};

/** What the library made of one target, in the shape the cache and the shield store. */
function itemFrom(report: BlocklistReport): ItemReputation {
  const hits: ListHit[] = report.hits.map((hit) => {
    const list = DNSBL_LABELS[hit.zone] ?? hit.name;
    return {
      list,
      zone: hit.zone,
      category: hit.categories[0] ?? 'unknown',
      detail: hit.meanings.join('; ') || `${list} lists it`,
      points: hit.points,
    };
  });
  // `checked` is the zones that answered usably — a refusal and a timeout are
  // both errors to the library. One list refusing (Spamhaus answers every
  // query from a public resolver that way) must not discard the two that DID
  // say "not listed"; only an item NOBODY could answer for is unknown.
  const status: ReputationStatus = hits.length
    ? 'listed'
    : report.checked.length > 0
      ? 'clean'
      : 'unknown';
  // Same substitution for the diagnostic line: it reaches the log and the
  // spam-pass summary, where "Spamhaus ZEN" is the name an operator will
  // recognise from the list's own documentation.
  const failure = report.errors[0];
  const note = failure ? `${DNSBL_LABELS[failure.zone] ?? failure.name}: ${failure.error}` : undefined;
  return { status, hits, ...(note && status !== 'listed' ? { note } : {}) };
}

/**
 * DNSBL from this machine. One query per (item, zone), pooled by the library;
 * a zone's answer is read through its own code table, so a refusal is unknown,
 * not a listing.
 *
 * A BREAKER PER ZONE, which matters more on a desktop client than anywhere
 * else. Spamhaus and several other operators refuse queries that arrive
 * through a public resolver — `127.255.255.254`, "you are querying through an
 * open resolver" — and a laptop on an ISP's DNS or on 8.8.8.8 is exactly that;
 * Barracuda refuses any resolver nobody registered; URIBL answers `127.0.0.1`
 * to the same. The library reports each as an error rather than a listing,
 * which is right, but without a breaker the app would then send one doomed
 * query per sender to that operator for the rest of the session. So a zone
 * that fails consecutively is retired for a cooldown WHILE THE OTHERS KEEP
 * ANSWERING — with every zone on by default, one operator that will never
 * answer this network must not silence the five that do. With every zone
 * retired, nothing is asked at all.
 */
export class LocalDnsblProvider implements ReputationProvider {
  readonly name = 'local-dnsbl';
  private readonly lists: readonly Blocklist[];
  private readonly concurrency: number;
  private readonly breakers: CircuitBreakers;
  /**
   * The injected resolver in the library's terms: a name that does not exist
   * is an empty answer, and only a genuine failure throws. `includeText` is
   * never asked for, so `A` is the only record type this is ever called with.
   */
  private readonly query: DnsQuery;

  constructor(deps: DnsblDeps) {
    this.lists = deps.lists ?? BLOCKLISTS;
    this.concurrency = Math.max(1, deps.concurrency ?? 8);
    this.breakers = new CircuitBreakers(deps.breaker);
    this.query = async (name) => {
      try {
        return await deps.resolve4(name);
      } catch (e) {
        const code = (e as { code?: string })?.code ?? '';
        if (NOT_LISTED_CODES.has(code)) return [];
        throw e;
      }
    };
  }

  /** The configured zones whose own breaker is not open right now. */
  activeLists(): Blocklist[] {
    return this.lists.filter((list) => this.breakers.isClosed(list.name));
  }

  async lookup(query: ReputationQuery): Promise<ReputationResult> {
    const ips = [...new Set(query.ips)];
    const domains = [...new Set(query.domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
    const lists = this.activeLists();
    // Nothing configured, or every zone sitting out a cooldown: nothing to ask,
    // and not a failure either — the failures that retired them were counted.
    if (lists.length === 0) {
      return unknownResult(
        this.name,
        { ips, domains },
        this.lists.length > 0 ? 'Every blocklist is resting after refusing or failing repeatedly' : undefined,
      );
    }
    const targets: ReputationTarget[] = [
      ...ips.map((ip) => ({ ip })),
      ...domains.map((domain) => ({ domain })),
    ];

    const reports = await checkReputationBatch(targets, lists, {
      query: this.query,
      concurrency: this.concurrency,
    });
    this.scoreZones(lists, reports);

    const result: ReputationResult = { provider: this.name, ips: new Map(), domains: new Map() };
    reports.forEach((report, i) => {
      if (i < ips.length) result.ips.set(ips[i], itemFrom(report));
      else result.domains.set(domains[i - ips.length], itemFrom(report));
    });
    // Anything the caller asked about that never became a target (an unusable
    // address, an empty domain) still has to answer — as unknown, never clean.
    for (const ip of query.ips) if (!result.ips.has(ip)) result.ips.set(ip, UNKNOWN);
    for (const d of query.domains) {
      const key = d.trim().toLowerCase();
      if (!result.domains.has(key)) result.domains.set(key, UNKNOWN);
    }
    return result;
  }

  /**
   * Each zone keeps its own score: one that answered anything is forgiven its
   * past, one that failed everything it was asked moves toward its own
   * cooldown. A zone this call gave nothing to ask — an IP zone for a batch of
   * link domains — is neither. The library names a zone by its DNS zone in
   * `checked` and by its catalogue id in `errors`.
   */
  private scoreZones(lists: readonly Blocklist[], reports: readonly BlocklistReport[]): void {
    const answered = new Set(reports.flatMap((report) => report.checked));
    const lastError = new Map(reports.flatMap((report) => report.errors.map((error) => [error.name, error.error] as const)));
    for (const list of lists) {
      if (answered.has(list.zone)) {
        this.breakers.succeeded(list.name);
        continue;
      }
      const reason = lastError.get(list.name);
      if (reason === undefined || !this.breakers.failed(list.name)) continue;
      logger.warn(
        `[Reputation] ${list.name}: ${this.breakers.failureThreshold} consecutive failed lookups — not asking it for ${Math.round(this.breakers.cooldownMs / 60_000)} min. Last error: ${reason}`,
      );
    }
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
  /** The service's breaker: consecutive failed lookups that pause it, and for how long. */
  breaker?: CircuitBreakerOptions;
}

const SARV_SERVICE = 'sarv';

/**
 * The Sarv-hosted lookup. Authenticated with the user's own Sarv token, and
 * fail-open: no token, a 4xx/5xx, a timeout or malformed JSON all come back as
 * unknown — mail is never held hostage to a service. It is asked as mail
 * arrives, so a service that keeps failing is PAUSED rather than waited on by
 * every message behind it; not being signed in costs no request and is not a
 * failure.
 */
export class SarvReputationProvider implements ReputationProvider {
  readonly name = 'sarv';
  private readonly breakers: CircuitBreakers;

  constructor(private readonly deps: SarvReputationDeps) {
    this.breakers = new CircuitBreakers(deps.breaker);
  }

  async lookup(query: ReputationQuery): Promise<ReputationResult> {
    if (query.ips.length === 0 && query.domains.length === 0) return { provider: this.name, ips: new Map(), domains: new Map() };
    if (!this.breakers.isClosed(SARV_SERVICE)) {
      return unknownResult(this.name, query, 'Sarv reputation service paused after repeated failures');
    }
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
      if (!res.ok) return this.failed(query, `Sarv reputation service answered ${res.status}`);
      const body = (await res.json()) as SarvReputationResponse;
      this.breakers.succeeded(SARV_SERVICE);
      return this.parse(body, query);
    } catch (e) {
      return this.failed(query, `Sarv reputation service unreachable: ${(e as Error)?.message ?? e}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A lookup that learned nothing: unknown for everything asked, and one step toward the pause. */
  private failed(query: ReputationQuery, note: string): ReputationResult {
    if (this.breakers.failed(SARV_SERVICE)) {
      logger.warn(
        `[Reputation] Sarv service: ${this.breakers.failureThreshold} consecutive failed lookups — not asking it for ${Math.round(this.breakers.cooldownMs / 60_000)} min. Last error: ${note}`,
      );
    }
    return unknownResult(this.name, query, note);
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
