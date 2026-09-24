/**
 * The reputation stage: what other operators have already published about the
 * machine that delivered a message, folded into the score the header stage
 * produced.
 *
 * Every other signal in this pipeline is a fact about the message in front of
 * us and costs nothing to read. This one is a DNS query per distinct sender,
 * sent to a third party, about mail a user is receiving. That difference is
 * why the whole thing is OFF unless the user has named the zones to ask:
 * `@sarv-in/mailguard/reputation` takes the blocklists as a required
 * argument for the same reason, and this class keeps that property rather than
 * quietly supplying a default.
 *
 * WHAT THIS ADDS OVER CALLING THE LIBRARY DIRECTLY. The library answers one
 * question per call, correctly, and stops there. An ingest loop asks the same
 * question over and over, so three things have to sit in front of it:
 *
 *   - **A cache.** A mailbox is a few hundred distinct senders wrapped in
 *     thousands of messages. Without it a 6,000-message sync is 6,000 DNS
 *     round trips to somebody else's resolver, which is both slow and the kind
 *     of traffic that gets a client blocked.
 *   - **In-flight de-duplication.** A batch arrives all at once, and a dozen
 *     messages from one sender must produce ONE query, not a dozen racing
 *     queries that each miss the cache the others are about to fill.
 *   - **A circuit breaker PER ZONE**, which matters more on a desktop client
 *     than anywhere else. Spamhaus and several other operators refuse queries
 *     that arrive through a public resolver — `127.255.255.254`, "you are
 *     querying through an open resolver" — and a laptop on an ISP's DNS or on
 *     8.8.8.8 is exactly that; Barracuda refuses any resolver nobody
 *     registered; URIBL answers `127.0.0.1` to the same. The library reports
 *     each as an error rather than a listing, which is right, but without a
 *     breaker the app would then send one doomed query per sender to that
 *     operator for the rest of the session. So: a zone that fails
 *     consecutively is retired for a cooldown WHILE THE OTHERS KEEP ANSWERING
 *     — with every zone on by default, one operator that will never answer
 *     this network must not silence the five that do. Only when no zone at
 *     all answers does the whole stage pause.
 *
 * The verdict this produces is a `SpamAssessment` like any other stage's, and
 * it is merged into the header stage's score by the caller. It is built from
 * the zones that ANSWERED: a listing one operator reported is true whatever
 * happened to the operator next to it. A lookup in which nobody answered, or
 * that never ran, contributes NOTHING — never a penalty and never a discount.
 * `checkReputation` does not throw, and neither does this.
 */
import {
  assessReputation,
  checkReputation,
  type Blocklist,
  type DnsQuery,
  type SpamAssessment,
} from '@sarv-in/mailguard';

import { logger } from '../utils/logger';

/** How long a verdict about one sender is reused before it is asked again. */
export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
/** Distinct targets remembered. A busy mailbox sees far fewer senders than this. */
export const DEFAULT_CACHE_MAX = 2_000;
/** Consecutive failed lookups that open the breaker. */
export const DEFAULT_FAILURE_THRESHOLD = 5;
/** How long the breaker stays open. Long enough that a wrong resolver costs one burst. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 30 * 60_000;
/** Per-lookup DNS budget. Shorter than the library's default: this is on the sync path. */
export const DEFAULT_TIMEOUT_MS = 3_000;

export interface ReputationStageConfig {
  /**
   * The zones to query. EMPTY MEANS OFF. Which zones a deployment asks by
   * default is the caller's decision, not this class's: every list has terms,
   * several answer "over quota" rather than "listed" once you pass a
   * threshold, and every query tells its operator about a sender this user
   * receives mail from.
   */
  blocklists: readonly Blocklist[];
  /**
   * Resolvers to query through. Worth setting: most operators refuse queries
   * that arrive via a public resolver, so a desktop client on its ISP's DNS
   * gets an error rather than an answer. Empty uses the system's.
   */
  servers?: readonly string[];
  timeoutMs?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  failureThreshold?: number;
  breakerCooldownMs?: number;
}

/** What one message needs looked up. Either half may be absent. */
export interface ReputationSubject {
  ip?: string | null;
  domain?: string | null;
}

/**
 * The stage as the ingest path sees it: one question, one answer, never a
 * throw. Narrowing it to a function keeps `MessageProcessor` unaware of the
 * cache, the breaker and the DNS behind it, and makes it trivial to stub.
 */
export type ReputationLookup = (subject: ReputationSubject) => Promise<SpamAssessment | null>;

/** Injectable clock and resolver, so the whole class is testable without a network. */
export interface ReputationStageDeps {
  query?: DnsQuery;
  now?: () => number;
}

interface CacheEntry {
  assessment: SpamAssessment | null;
  expiresAt: number;
}

/** Cache key for one subject: the pair is what was asked, so the pair is the key. */
function subjectKey(subject: ReputationSubject): string {
  return `${subject.ip ?? ''}|${(subject.domain ?? '').toLowerCase()}`;
}

/**
 * One reputation stage per running app: it owns the cache and the breaker, so
 * sharing it across accounts and folders is the point rather than a hazard.
 */
export class ReputationStage {
  private readonly config: ReputationStageConfig;
  private readonly query?: DnsQuery;
  private readonly now: () => number;

  /** Verdicts already established, by subject. Insertion order is the eviction order. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Lookups happening right now, so a batch of siblings shares one query. */
  private readonly inFlight = new Map<string, Promise<SpamAssessment | null>>();

  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  /** Per-zone failure counts and cooldowns, by the zone's catalogue name. */
  private readonly zones = new Map<string, { failures: number; openUntil: number }>();

  constructor(config: ReputationStageConfig, deps: ReputationStageDeps = {}) {
    this.config = config;
    this.query = deps.query;
    this.now = deps.now ?? Date.now;
  }

  /** Whether any zone is configured. `false` means this stage does nothing at all. */
  get enabled(): boolean {
    return this.config.blocklists.length > 0;
  }

  /**
   * The assessment for one message's sender, or null when there is nothing to
   * add — disabled, nothing worth asking about, the breaker open, or a lookup
   * that did not complete. Null is always "no opinion", never "clean".
   */
  async assess(subject: ReputationSubject): Promise<SpamAssessment | null> {
    if (!this.enabled) return null;
    if (!subject.ip && !subject.domain) return null;

    const key = subjectKey(subject);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.assessment;

    // The breaker is checked AFTER the cache: a verdict already established is
    // still true while the resolver is unreachable.
    if (this.now() < this.breakerOpenUntil) return null;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const lookup = this.lookup(subject, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    return lookup;
  }

  /** Forget every cached verdict — for a settings change that alters the zones. */
  reset(): void {
    this.cache.clear();
    this.zones.clear();
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
  }

  /** The configured zones whose own breaker is not open right now. */
  activeZones(): Blocklist[] {
    const now = this.now();
    return this.config.blocklists.filter((list) => (this.zones.get(list.name)?.openUntil ?? 0) <= now);
  }

  private async lookup(
    subject: ReputationSubject,
    key: string,
  ): Promise<SpamAssessment | null> {
    const zones = this.activeZones();
    // Every zone is sitting out a cooldown: nothing to ask, and not a failure
    // either — the failures that retired them were already counted.
    if (zones.length === 0) return null;

    const result = await checkReputation(subject, zones, {
      timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      servers: this.config.servers,
      query: this.query,
    });

    // Each zone keeps its own score: one that answered is forgiven its past,
    // one that did not moves toward its own cooldown. The library names a zone
    // by its catalogue id in one list and by its DNS zone in another; both
    // resolve to the id here so the two lists cannot disagree about a zone.
    const idOf = new Map(zones.flatMap((list) => [[list.name, list.name], [list.zone, list.name]]));
    for (const answered of result.checked) this.zones.delete(idOf.get(answered) ?? answered);
    for (const error of result.errors) this.recordZoneFailure(idOf.get(error.name) ?? idOf.get(error.zone) ?? error.name, error.error);

    // Nobody answered: not a verdict, and caching one would turn a momentary
    // outage into hours of "no opinion" about a sender we could have asked
    // about a minute later.
    if (result.checked.length === 0) {
      this.recordFailure(result.errors[0]?.error);
      return null;
    }

    // At least one operator answered, and what it said is true whatever
    // happened to the operators beside it. The zones that failed are on
    // their way out through their own breaker; their answer, if they ever
    // give one, is a later sender's to collect.
    this.consecutiveFailures = 0;
    const assessment = assessReputation(result);
    this.remember(key, assessment);
    return assessment;
  }

  private recordZoneFailure(name: string, reason: string): void {
    const entry = this.zones.get(name) ?? { failures: 0, openUntil: 0 };
    entry.failures += 1;
    const threshold = this.config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    if (entry.failures >= threshold) {
      const cooldown = this.config.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
      entry.openUntil = this.now() + cooldown;
      entry.failures = 0;
      logger.warn(
        `[Reputation] ${name}: ${threshold} consecutive failed lookups — not asking it for ${Math.round(cooldown / 60_000)} min. Last error: ${reason}`,
      );
    }
    this.zones.set(name, entry);
  }

  private recordFailure(reason: string | undefined): void {
    this.consecutiveFailures += 1;
    const threshold = this.config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    if (this.consecutiveFailures < threshold) return;

    const cooldown = this.config.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.breakerOpenUntil = this.now() + cooldown;
    this.consecutiveFailures = 0;
    logger.warn(
      `[Reputation] ${threshold} consecutive failed lookups — pausing for ${Math.round(cooldown / 60_000)} min. Last error: ${reason ?? 'unknown'}`,
    );
  }

  private remember(key: string, assessment: SpamAssessment): void {
    const max = this.config.cacheMax ?? DEFAULT_CACHE_MAX;
    // Re-insert so the map's iteration order is write order: eviction then
    // drops the sender whose verdict was established longest ago, which is
    // also the one whose TTL is closest to expiring anyway.
    this.cache.delete(key);
    this.cache.set(key, {
      assessment,
      expiresAt: this.now() + (this.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS),
    });
    while (this.cache.size > max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
