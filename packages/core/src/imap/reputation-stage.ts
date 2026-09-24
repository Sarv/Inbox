/**
 * The reputation stage: what other operators have already published about the
 * machine that delivered a message and the domains it names, folded into the
 * score the header stage produced.
 *
 * Every other signal in this pipeline is a fact about the message in front of
 * us and costs nothing to read. This one is a question per distinct sender,
 * sent to a third party, about mail a user is receiving — which is why it only
 * exists when the user's settings name somebody to ask, and why the provider
 * it asks (this computer's DNSBL queries, or the Sarv-hosted service; see
 * utils/spam-reputation.ts) is passed in rather than chosen here.
 *
 * ONE STAGE FOR EVERY QUESTION. The sender is asked about as mail arrives,
 * awaited inside `convertMessage`, so a listed sender is filed before the user
 * ever sees the message; the background pass asks the same stage about the
 * domains a body links to once the body is downloaded. One cache, one set of
 * breakers, one reading of the answers — the two moments cannot disagree about
 * a domain, and a domain asked about at one is not asked again at the other.
 *
 * WHAT THIS ADDS OVER CALLING A PROVIDER DIRECTLY. A provider answers one
 * question per call, correctly, and stops there. The ingest loop asks the same
 * question over and over, so two things sit in front of it:
 *
 *   - **A cache**, per item (an address, a domain) rather than per message: a
 *     mailbox is a few hundred distinct senders wrapped in thousands of
 *     messages, and two messages from one server with different From domains
 *     share the answer about the server. Without it a 6,000-message sync is
 *     6,000 round trips to somebody else's resolver, which is both slow and
 *     the kind of traffic that gets a client blocked. The store is injected —
 *     the desktop app keeps it in its core DB, so it survives a restart.
 *   - **In-flight de-duplication.** A batch arrives all at once, and a dozen
 *     messages from one sender must produce ONE query, not a dozen racing
 *     queries that each miss the cache the others are about to fill.
 *
 * The breakers — a zone or a service that keeps failing is not asked for a
 * while — live in the providers, because only a provider knows what one of its
 * failures looks like.
 *
 * An answer nobody could give is NEVER cached: an outage that became hours of
 * "no opinion" about a sender we could have asked about a minute later would be
 * worse than the outage. And a lookup in which nobody answered contributes
 * NOTHING to a message — never a penalty and never a discount. Nothing here
 * throws.
 */
import type { SpamAssessment } from '@sarv-in/mailguard';

import {
  UNKNOWN,
  reputationAssessment,
  unknownResult,
  type ItemReputation,
  type ReputationProvider,
  type ReputationQuery,
  type ReputationResult,
} from '../utils/spam-reputation';

/** What one message needs looked up: the connecting address and the sender's registrable domains. */
export interface ReputationSubject {
  ip?: string | null;
  /** From and Reply-To, registrable. Blanks and duplicates are ignored. */
  domains?: readonly (string | null | undefined)[];
}

/**
 * The stage as the ingest path sees it: one question, one answer, never a
 * throw. Narrowing it to a function keeps `MessageProcessor` unaware of the
 * cache, the breakers and the network behind it, and makes it trivial to stub.
 */
export type ReputationLookup = (subject: ReputationSubject) => Promise<SpamAssessment | null>;

export type ReputationItemKind = 'ip' | 'domain';

/**
 * Where answers are kept. `get` returns only a still-fresh answer — how long an
 * answer stays fresh is the store's policy, so it can differ by status — and
 * both methods may throw: a store that cannot be read is a miss, one that cannot
 * be written costs the next lookup, and neither may fail a message.
 */
export interface ReputationCacheStore {
  get(kind: ReputationItemKind, item: string, nowSec: number): ItemReputation | null;
  set(kind: ReputationItemKind, item: string, rep: ItemReputation, provider: string, nowSec: number): void;
}

/** Injectable clock, so the whole class is testable without waiting. */
export interface ReputationStageDeps {
  /** Milliseconds. */
  now?: () => number;
}

const normalizeDomain = (domain: string | null | undefined): string => (domain ?? '').trim().toLowerCase();

/**
 * One reputation stage per running app: it owns the in-flight lookups in front
 * of one provider and one cache, so sharing it across accounts and folders is
 * the point rather than a hazard.
 */
export class ReputationStage {
  private readonly now: () => number;
  /** Lookups happening right now, by `kind:item`, so a batch of siblings shares one query. */
  private readonly inFlight = new Map<string, Promise<ItemReputation>>();

  constructor(
    private readonly provider: ReputationProvider,
    private readonly cache: ReputationCacheStore,
    deps: ReputationStageDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** Who answers — the provider's name, as the cache and the Security page record it. */
  get providerName(): string {
    return this.provider.name;
  }

  /**
   * The assessment for one message's sender, or null when there is nothing to
   * add — nothing worth asking about, or nobody able to answer. Null is always
   * "no opinion", never "clean".
   */
  async assess(subject: ReputationSubject): Promise<SpamAssessment | null> {
    try {
      const ip = subject.ip || null;
      const domains = [...new Set((subject.domains ?? []).map(normalizeDomain).filter(Boolean))];
      if (!ip && domains.length === 0) return null;
      const result = await this.lookup({ ips: ip ? [ip] : [], domains });
      const answers = [...result.ips.values(), ...result.domains.values()];
      if (answers.every((answer) => answer.status === 'unknown')) return null;
      return reputationAssessment(result, { originIp: ip, domains });
    } catch {
      return null;
    }
  }

  /**
   * What is known about every item asked — from the cache where it is fresh,
   * from a lookup already in flight, and from ONE provider call for the rest.
   * Every item asked is in the result; one nobody could answer for is unknown.
   */
  async lookup(query: ReputationQuery): Promise<ReputationResult> {
    const nowSec = Math.floor(this.now() / 1000);
    const result: ReputationResult = { provider: this.provider.name, ips: new Map(), domains: new Map() };
    const ask: ReputationQuery = { ips: [], domains: [] };
    const waiting: Promise<void>[] = [];

    const plan = (kind: ReputationItemKind, item: string, into: Map<string, ItemReputation>, asking: string[]): void => {
      const cached = this.cached(kind, item, nowSec);
      if (cached) {
        into.set(item, cached);
        return;
      }
      const pending = this.inFlight.get(`${kind}:${item}`);
      if (pending) {
        waiting.push(pending.then((rep) => {
          into.set(item, rep);
        }));
        return;
      }
      asking.push(item);
    };
    for (const ip of new Set(query.ips.filter(Boolean))) plan('ip', ip, result.ips, ask.ips);
    for (const domain of new Set(query.domains.map(normalizeDomain).filter(Boolean))) {
      plan('domain', domain, result.domains, ask.domains);
    }

    if (ask.ips.length > 0 || ask.domains.length > 0) {
      const call = this.ask(ask);
      const keys: string[] = [];
      for (const ip of ask.ips) {
        keys.push(`ip:${ip}`);
        this.inFlight.set(`ip:${ip}`, call.then((fresh) => fresh.ips.get(ip) ?? UNKNOWN));
      }
      for (const domain of ask.domains) {
        keys.push(`domain:${domain}`);
        this.inFlight.set(`domain:${domain}`, call.then((fresh) => fresh.domains.get(domain) ?? UNKNOWN));
      }
      try {
        const fresh = await call;
        for (const ip of ask.ips) {
          const rep = fresh.ips.get(ip) ?? UNKNOWN;
          result.ips.set(ip, rep);
          this.remember('ip', ip, rep, nowSec);
        }
        for (const domain of ask.domains) {
          const rep = fresh.domains.get(domain) ?? UNKNOWN;
          result.domains.set(domain, rep);
          this.remember('domain', domain, rep, nowSec);
        }
      } finally {
        for (const key of keys) this.inFlight.delete(key);
      }
    }

    await Promise.all(waiting);
    return result;
  }

  /** The provider's answer, or unknown for everything asked: a provider that throws is still fail-open. */
  private async ask(query: ReputationQuery): Promise<ReputationResult> {
    try {
      return await this.provider.lookup(query);
    } catch (e) {
      return unknownResult(this.provider.name, query, `Lookup failed: ${(e as Error)?.message ?? e}`);
    }
  }

  private cached(kind: ReputationItemKind, item: string, nowSec: number): ItemReputation | null {
    try {
      return this.cache.get(kind, item, nowSec);
    } catch {
      return null;
    }
  }

  private remember(kind: ReputationItemKind, item: string, rep: ItemReputation, nowSec: number): void {
    if (rep.status === 'unknown') return;
    try {
      this.cache.set(kind, item, rep, this.provider.name, nowSec);
    } catch {
      // Not remembered: the next message from this sender asks again.
    }
  }
}
