/**
 * Sender identity — who a message is from, as a picture and a tick.
 *
 * Three sources, in the order the renderer prefers them:
 *
 *   1. the domain's BIMI logo — shown only for mail that passed DMARC, because
 *      a logo on a spoofed message is worse than no logo; with a Verified Mark
 *      Certificate that chains to a pinned Mark Verifying Authority it also
 *      earns the blue tick (see core utils/bimi.ts),
 *   2. the contact's confirmed photo (the existing confirm-gated avatar flow),
 *   3. the domain's favicon.
 *
 * This service owns the LOOKUPS. They run here in the main process, once per
 * domain, on a background cadence and on demand when the renderer asks about a
 * domain it has no answer for yet — never at render time, and never from the
 * renderer, which only ever sees cached `data:` URIs. Each source is behind its
 * own setting: a BIMI lookup is DNS plus a fetch from the brand's own server,
 * a favicon fetch tells the domain that a client here looked once. Off means
 * off — nothing is fetched AND nothing cached is shown.
 *
 * Lookups are single-flight per domain and bounded in parallel, and a failed
 * one is recorded as an error with a short TTL so it is retried soon without
 * ever looping hot.
 */

import {
  createLogger,
  discoverFavicon,
  lookupBimi,
  withTimeout,
  type BimiLookup,
  type BimiStatus,
  type FaviconResult,
  type FaviconStatus,
  type FetchLike,
} from '@sarvinbox/core';

import { getAllAccountRuntimes, getMainWindow } from '../shared';

import { getBlob, setBlob } from './core-db';
import {
  bimiIsStale,
  faviconIsStale,
  getDomainIdentityStore,
  normalizeDomain,
  type DomainIdentityRow,
  type DomainIdentityStore,
} from './domain-identity-store';
import { chromiumFetch } from './net-fetch';

const logger = createLogger('sender-identity');

// --------------------------------------------------------------------- policy

export interface SenderIdentityPolicy {
  /** Look up and show BIMI logos / verified marks. */
  logos: boolean;
  /** Look up and show domain favicons. */
  favicons: boolean;
}

export const DEFAULT_SENDER_IDENTITY_POLICY: SenderIdentityPolicy = { logos: true, favicons: true };
const POLICY_BLOB_KEY = 'sender-identity-policy';
let cachedPolicy: SenderIdentityPolicy | null = null;

/** Coerce whatever the renderer pushed into a policy; anything odd means the default. */
export function normalizeSenderIdentityPolicy(raw: unknown): SenderIdentityPolicy {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    logos: typeof r.logos === 'boolean' ? r.logos : DEFAULT_SENDER_IDENTITY_POLICY.logos,
    favicons: typeof r.favicons === 'boolean' ? r.favicons : DEFAULT_SENDER_IDENTITY_POLICY.favicons,
  };
}

export function getSenderIdentityPolicy(): SenderIdentityPolicy {
  if (cachedPolicy) return cachedPolicy;
  try {
    const blob = getBlob(POLICY_BLOB_KEY);
    cachedPolicy = normalizeSenderIdentityPolicy(blob ? JSON.parse(blob.toString('utf8')) : null);
  } catch {
    cachedPolicy = { ...DEFAULT_SENDER_IDENTITY_POLICY };
  }
  return cachedPolicy;
}

export function setSenderIdentityPolicy(raw: unknown): SenderIdentityPolicy {
  cachedPolicy = normalizeSenderIdentityPolicy(raw);
  try {
    setBlob(POLICY_BLOB_KEY, Buffer.from(JSON.stringify(cachedPolicy), 'utf8'));
  } catch (e) {
    logger.warn(`[SenderIdentity] policy not persisted: ${(e as Error).message}`);
  }
  return cachedPolicy;
}

/** Test seam. */
export function resetSenderIdentityPolicyCache(): void {
  cachedPolicy = null;
}

// ------------------------------------------------------------------- identity

export interface SenderIdentity {
  address: string;
  /** The address's domain, lower-cased; null when the address has none. */
  domain: string | null;
  /** The BIMI standing, or null when never looked up (or logos are off). */
  bimi: {
    status: BimiStatus;
    logo: string | null;
    organization: string | null;
    issuer: string | null;
    detail: string;
    dmarcPolicy: string | null;
    expires: number | null;
  } | null;
  /** `data:` URI, or null when none is known (or favicons are off). */
  favicon: string | null;
  faviconStatus: FaviconStatus | null;
  /** The contact's confirmed photo, when the caller supplied one. */
  contactPhoto: string | null;
  /** A lookup was queued for this domain; an `identity:updated` event follows. */
  pending: boolean;
}

/** The domain of an address, lower-cased; null when there is none worth looking up. */
export function senderDomain(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = normalizeDomain(address.slice(at + 1));
  return domain.includes('.') ? domain : null;
}

/** Shape a cached row into what the renderer consumes, honouring the policy. */
export function identityFromRow(
  address: string,
  domain: string | null,
  row: DomainIdentityRow | null,
  policy: SenderIdentityPolicy,
  contactPhoto: string | null,
  pending: boolean,
): SenderIdentity {
  return {
    address,
    domain,
    bimi: policy.logos && row?.bimiStatus
      ? {
          status: row.bimiStatus,
          logo: row.bimiLogo,
          organization: row.bimiOrganization,
          issuer: row.bimiIssuer,
          detail: row.bimiDetail ?? '',
          dmarcPolicy: row.dmarcPolicy,
          expires: row.bimiExpires,
        }
      : null,
    favicon: policy.favicons ? row?.favicon ?? null : null,
    faviconStatus: policy.favicons ? row?.faviconStatus ?? null : null,
    contactPhoto,
    pending,
  };
}

// -------------------------------------------------------------------- service

export interface SenderIdentityServiceDeps {
  store: DomainIdentityStore;
  lookupBimi: (domain: string) => Promise<BimiLookup>;
  discoverFavicon: (domain: string) => Promise<FaviconResult>;
  policy: () => SenderIdentityPolicy;
  /** Unix seconds. */
  now: () => number;
  /** Fired once per completed domain refresh. */
  onUpdated: (domain: string) => void;
  /** Domains resolved at the same time. */
  maxConcurrent?: number;
}

export class SenderIdentityService {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private readonly maxConcurrent: number;

  constructor(private readonly deps: SenderIdentityServiceDeps) {
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 3);
  }

  /** How many domains are being resolved right now (tests, status). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * What is known about a sender NOW, from the cache — synchronous, so a
   * message renders without waiting on the network. Anything stale or missing
   * (and enabled) is queued; the renderer learns of the answer by event.
   */
  getForAddress(address: string, contactPhoto: string | null = null): SenderIdentity {
    const domain = senderDomain(address);
    const policy = this.deps.policy();
    if (!domain) return identityFromRow(address, null, null, policy, contactPhoto, false);
    const row = this.deps.store.get(domain);
    const now = this.deps.now();
    const needBimi = policy.logos && bimiIsStale(row, now);
    const needFavicon = policy.favicons && faviconIsStale(row, now);
    let pending = false;
    if (needBimi || needFavicon) {
      pending = true;
      void this.refresh(domain, { bimi: needBimi, favicon: needFavicon });
    }
    return identityFromRow(address, domain, row, policy, contactPhoto, pending);
  }

  /**
   * Resolve one domain. Single-flight: a second caller for the same domain
   * joins the running lookup. Each half records its own answer; a thrown
   * lookup is recorded as an error with the short TTL, never left unstamped
   * (an unstamped row would be retried on every render).
   */
  refresh(domain: string, parts: { bimi?: boolean; favicon?: boolean } = { bimi: true, favicon: true }): Promise<void> {
    const key = normalizeDomain(domain);
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = this.slot().then(async () => {
      try {
        const jobs: Promise<void>[] = [];
        if (parts.bimi) jobs.push(this.refreshBimi(key));
        if (parts.favicon) jobs.push(this.refreshFavicon(key));
        await Promise.all(jobs);
      } finally {
        this.active -= 1;
        this.waiting.shift()?.();
        this.inFlight.delete(key);
      }
      try {
        this.deps.onUpdated(key);
      } catch {
        // A renderer that is gone must not fail the lookup.
      }
    });
    this.inFlight.set(key, task);
    return task;
  }

  /** Refresh whichever of `domains` is stale under the current policy, at most `limit` of them. */
  async refreshStale(domains: string[], limit: number): Promise<number> {
    const policy = this.deps.policy();
    if (!policy.logos && !policy.favicons) return 0;
    const now = this.deps.now();
    const rows = this.deps.store.getMany(domains);
    const work: Promise<void>[] = [];
    for (const d of [...new Set(domains.map(normalizeDomain))]) {
      if (work.length >= limit) break;
      const row = rows.get(d) ?? null;
      const bimi = policy.logos && bimiIsStale(row, now);
      const favicon = policy.favicons && faviconIsStale(row, now);
      if (bimi || favicon) work.push(this.refresh(d, { bimi, favicon }));
    }
    await Promise.all(work);
    return work.length;
  }

  private slot(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => { this.active += 1; resolve(); });
    });
  }

  private async refreshBimi(domain: string): Promise<void> {
    let result: BimiLookup;
    try {
      result = await this.deps.lookupBimi(domain);
    } catch (e) {
      result = {
        status: 'error', logo: null, organization: null, issuer: null, certificateExpires: null,
        dmarcPolicy: null, recordDomain: null, detail: `Lookup failed: ${(e as Error)?.message ?? String(e)}`,
      };
    }
    this.deps.store.upsertBimi(domain, result, this.deps.now());
    if (result.status === 'verified' || result.status === 'logo') {
      logger.info(`[SenderIdentity] ${domain}: BIMI ${result.status}${result.organization ? ` (${result.organization})` : ''}`);
    }
  }

  private async refreshFavicon(domain: string): Promise<void> {
    let result: FaviconResult;
    try {
      result = await this.deps.discoverFavicon(domain);
    } catch (e) {
      result = { status: 'error', dataUri: null, source: null, detail: `Fetch failed: ${(e as Error)?.message ?? String(e)}` };
    }
    this.deps.store.upsertFavicon(domain, result, this.deps.now());
  }
}

// ------------------------------------------------------------- the real wiring

/** Per-request ceiling. A brand's logo server that hangs must not hold a slot for long. */
const FETCH_TIMEOUT_MS = 15_000;

/** Chromium's fetch, with a deadline on the connection and on the body read. */
const timedFetch: FetchLike = async (url) => {
  const res = await withTimeout(chromiumFetch(url), FETCH_TIMEOUT_MS, `Timed out fetching ${url}`);
  return {
    ok: res.ok,
    status: res.status,
    url: res.url,
    headers: { get: (name: string) => res.headers.get(name) },
    arrayBuffer: () => withTimeout(res.arrayBuffer(), FETCH_TIMEOUT_MS, `Timed out reading ${url}`),
  };
};

let service: SenderIdentityService | null = null;

export function getSenderIdentityService(): SenderIdentityService {
  if (!service) {
    service = new SenderIdentityService({
      store: getDomainIdentityStore(),
      // No resolver injected: the library builds one per lookup with a 5s
      // c-ares timeout and no retry, and answers a name that does not exist
      // with "no records" instead of an error — the distinction BIMI turns on.
      lookupBimi: (domain) => lookupBimi(domain, { fetch: timedFetch }),
      discoverFavicon: (domain) => discoverFavicon(domain, { fetch: timedFetch }),
      policy: getSenderIdentityPolicy,
      now: () => Math.floor(Date.now() / 1000),
      onUpdated: (domain) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('identity:updated', { domain });
      },
    });
  }
  return service;
}

// ------------------------------------------------------------------ scheduler

/** Let the initial sync settle first. */
export const IDENTITY_FIRST_TICK_MS = 60_000;
export const IDENTITY_TICK_MS = 10 * 60_000;
/** Sender domains considered per account per tick, most recent first. */
const DOMAINS_PER_ACCOUNT = 40;
/** Domains refreshed per tick across all accounts. */
const REFRESH_PER_TICK = 25;

let firstTimeout: ReturnType<typeof setTimeout> | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** One pass: the domains the user has heard from most recently, refreshed if stale. */
export async function senderIdentityTick(svc: SenderIdentityService = getSenderIdentityService()): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  try {
    const policy = getSenderIdentityPolicy();
    if (!policy.logos && !policy.favicons) return 0;
    const domains: string[] = [];
    for (const [, rt] of getAllAccountRuntimes()) {
      const storage = rt.storage as unknown as { getRecentSenderDomains?: (n: number) => Promise<string[]> } | null;
      if (!storage?.getRecentSenderDomains) continue;
      try {
        domains.push(...(await storage.getRecentSenderDomains(DOMAINS_PER_ACCOUNT)));
      } catch (e) {
        logger.warn(`[SenderIdentity] could not list sender domains: ${(e as Error).message}`);
      }
    }
    const refreshed = await svc.refreshStale(domains, REFRESH_PER_TICK);
    if (refreshed > 0) logger.info(`[SenderIdentity] refreshed ${refreshed} domain(s)`);
    return refreshed;
  } catch (e) {
    logger.warn(`[SenderIdentity] tick failed: ${(e as Error).message}`);
    return 0;
  } finally {
    ticking = false;
  }
}

export function startSenderIdentityScheduler(): void {
  if (tickInterval) return;
  firstTimeout = setTimeout(() => void senderIdentityTick(), IDENTITY_FIRST_TICK_MS);
  tickInterval = setInterval(() => void senderIdentityTick(), IDENTITY_TICK_MS);
  firstTimeout.unref?.();
  tickInterval.unref?.();
  logger.info('[SenderIdentity] scheduler started');
}

export function stopSenderIdentityScheduler(): void {
  if (firstTimeout) { clearTimeout(firstTimeout); firstTimeout = null; }
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}
