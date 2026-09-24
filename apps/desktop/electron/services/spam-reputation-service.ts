/**
 * The spam filter's background reputation pass — what can only be judged once
 * a message is stored.
 *
 * The header stage scores every message at insert, and the blocklist check
 * (`reputation-service.ts`) asks about the SENDER before that score is stored,
 * so a listed sender is filed before the user ever sees the message. This pass
 * runs a little later, in the background, over rows it has not judged yet, for
 * the two questions insert cannot ask:
 *
 *  - LINK DOMAINS. Once a body is downloaded, what the blocklists say about
 *    the domains it links to — asked through the SAME stage the ingest check
 *    uses, so one cache and one provider serve both, and only when the user
 *    opted into link lookups in Security > Blocklists.
 *  - DOMAIN AGE (mailguard `/age`): how recently the sender's domain, and the
 *    domains the body links to, were registered, asked of the domain registry
 *    over RDAP. It is the one fact about a campaign domain that is true before
 *    any blocklist has heard of it — the lure of 2026-09-23 linked to a domain
 *    five days old — and it needs no blocklist, only the registry. Registration
 *    dates never change, so the answer is cached for a month rather than hours.
 *
 * It never asks about the sender's blocklist standing. Until 2026-09-24 it did —
 * a second copy of the ingest check with its own setting and its own cache,
 * asking the same lists about the same sender again and needing a guard so one
 * listing was not charged twice. The sender is asked once now, as mail arrives.
 *
 * Whatever the pass adds, a message that crosses the line only now is tagged,
 * filed locally and its server-side move queued, exactly as the header stage
 * would have at insert. Every failure is fail-open: an unknown adds no points
 * and a row is judged once, whatever came back.
 */
import {
  assessDomainAge,
  fetchRdapBootstrap,
  lookupDomainAge,
  DOMAIN_AGE_MAX_POINTS,
  type DomainAgeLookup,
  type FetchLike,
  type RdapBootstrap,
} from '@sarv-in/mailguard';
import {
  SPAM_THRESHOLD,
  addTag,
  computeFilterActionResult,
  createLogger,
  createLoopYielder,
  hasTag,
  isSpamScore,
  linkDomains,
  linkReputationReasons,
  messageDomains,
  parseSpamReasons,
  registrableDomain,
  stageOfReason,
  yieldToEventLoop,
  type FolderRecord,
  type ReputationQuery,
  type ReputationResult,
  type SpamReason,
} from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { getAllAccountRuntimes, getMainWindow } from '../shared';

import { getCoreDb } from './core-db';
import { chromiumFetch } from './net-fetch';
import {
  blocklistProviderName,
  getReputationCache,
  getReputationSettings,
  linkReputationStage,
  onReputationSettingsChanged,
  type ReputationSettings,
} from './reputation-service';

const logger = createLogger('spam-reputation');

// ------------------------------------------------------------ domain age cache

/** Seconds a registry's answer is kept. A registration date does not change. */
export const DOMAIN_AGE_CACHE_TTL_S = 30 * 24 * 60 * 60;
/** Seconds before a failed lookup (registry down, rate-limited) is tried again. */
export const DOMAIN_AGE_CACHE_ERROR_TTL_S = 60 * 60;

export function ensureDomainAgeCacheSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_age_cache (
      domain      TEXT PRIMARY KEY,
      status      TEXT NOT NULL,
      registered  INTEGER,
      registrar   TEXT,
      server      TEXT,
      detail      TEXT,
      checked_at  INTEGER NOT NULL
    );
  `);
}

/**
 * What the registry said about each domain, kept for a month. The age is
 * recomputed from the stored registration date on every read, so a domain
 * cached at five days old is read as thirty-five days old a month later —
 * the cache holds the fact, not the arithmetic.
 */
export class DomainAgeCache {
  constructor(private readonly db: Database.Database) {
    ensureDomainAgeCacheSchema(db);
  }

  get(domain: string, nowSec: number): DomainAgeLookup | null {
    const r = this.db.prepare('SELECT status, registered, registrar, server, detail, checked_at FROM domain_age_cache WHERE domain = ?')
      .get(domain) as { status: DomainAgeLookup['status']; registered: number | null; registrar: string | null; server: string | null; detail: string | null; checked_at: number } | undefined;
    if (!r) return null;
    const ttl = r.status === 'error' ? DOMAIN_AGE_CACHE_ERROR_TTL_S : DOMAIN_AGE_CACHE_TTL_S;
    if (nowSec - r.checked_at > ttl) return null;
    return {
      domain,
      status: r.status,
      registered: r.registered,
      ageDays: r.registered === null ? null : Math.max(0, Math.floor((nowSec - r.registered) / 86_400)),
      registrar: r.registrar,
      server: r.server,
      detail: r.detail,
    };
  }

  set(domain: string, lookup: DomainAgeLookup, nowSec: number): void {
    this.db.prepare(`
      INSERT INTO domain_age_cache (domain, status, registered, registrar, server, detail, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET status = excluded.status, registered = excluded.registered, registrar = excluded.registrar,
        server = excluded.server, detail = excluded.detail, checked_at = excluded.checked_at
    `).run(domain, lookup.status, lookup.registered, lookup.registrar, lookup.server, lookup.detail, nowSec);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM domain_age_cache').get() as { n: number }).n;
  }
}

let ageCacheSingleton: DomainAgeCache | null = null;
export function getDomainAgeCache(): DomainAgeCache {
  if (!ageCacheSingleton) ageCacheSingleton = new DomainAgeCache(getCoreDb());
  return ageCacheSingleton;
}

/** The registry lookups one pass may make: the cache and this cap together bound what a pass costs. */
export const AGE_LOOKUPS_PER_PASS = 40;

/** Where the pass gets a domain's age from: a lookup and the cache in front of it. */
export interface AgeSource {
  lookup(domain: string): Promise<DomainAgeLookup>;
  cache: DomainAgeCache;
  /** Fresh registry lookups per pass. Default AGE_LOOKUPS_PER_PASS. */
  maxLookups?: number;
}

/** The age reasons, which keep their own budget apart from the blocklist cap. */
const AGE_REASON_IDS = new Set<string>(['reputation-domain-new', 'reputation-link-new']);

/**
 * Blocklist points a row already carries — the sender listings the ingest check
 * charged, and any link listing — which is the cap the link stage shares.
 */
function blocklistPointsOn(reasons: SpamReason[]): number {
  return reasons.filter((r) => stageOfReason(r.id) === 'reputation' && !AGE_REASON_IDS.has(r.id)).reduce((s, r) => s + r.points, 0);
}

// ------------------------------------------------------------------- the pass

/** The storage surface one pass needs — structural, so tests can fake it. */
export interface ReputationStorage {
  getEmailsPendingReputation(limit: number): Array<{
    id: string; uid: number; folderId: string; folderPath: string; tags: string;
    fromAddress: string; replyTo: string | null; originIp: string | null;
    spamScore: number; spamReasons: string | null; spamUserVerdict?: 'spam' | 'ham' | null;
  }>;
  countEmailsPendingReputation(): number;
  applyReputationBatch(rows: Array<{ id: string; spamScore: number; spamReasons: string }>, checkedAtSec: number): number;
  getEmailsPendingLinkReputation(limit: number): Array<{
    id: string; uid: number; folderId: string; folderPath: string; tags: string;
    fromAddress: string; spamScore: number; spamReasons: string | null;
    spamUserVerdict: 'spam' | 'ham' | null; rawBody: string | null;
  }>;
  countEmailsPendingLinkReputation(): number;
  applyLinkReputationBatch(rows: Array<{ id: string; spamScore: number; spamReasons: string }>, checkedAtSec: number): number;
  getFolders(): Promise<FolderRecord[]>;
  updateEmail(id: string, updates: { tags?: string; folderId?: string }): Promise<void>;
}

export interface ReputationTarget {
  storage: ReputationStorage;
  /** The account's sync engine when connected — for the server-side move. */
  engine: { moveToSpam(folderPath: string, uid: number): Promise<unknown> } | null;
  label: string;
}

/**
 * Where link domains are looked up: the one blocklist stage the ingest check
 * uses (`linkReputationStage()`), cached and fail-open.
 */
export interface LinkLookup {
  readonly providerName: string;
  lookup(query: ReputationQuery): Promise<ReputationResult>;
}

export interface ReputationPassDeps {
  targets: () => ReputationTarget[];
  /** null = link lookups are off, or nobody is asked. */
  links: () => LinkLookup | null;
  /** null / absent = domain age is off. With no link lookups AND no age source the pass does nothing. */
  age?: () => AgeSource | null;
  /** Unix seconds. */
  now: () => number;
  /** Rows judged per account per pass. */
  batch?: number;
  /** Rows whose BODY is read at a time — see BODY_BATCH_SIZE. */
  bodyBatch?: number;
  /** How long the pass may keep handing out work, in ms. See TICK_BUDGET_MS. */
  budgetMs?: number;
  /** Millisecond clock for that budget — `now()` is in seconds. Injected for tests. */
  nowMs?: () => number;
  /** Yield primitive, injected for tests. */
  yieldFn?: () => Promise<void>;
}

/**
 * How long one pass may keep starting new work before it stops and leaves the
 * rest of the backlog to the next one.
 *
 * A row limit cannot bound this, because the cost of a row is not fixed: a
 * body-stage row costs an HTML parse over however much MIME that message
 * carries, which is anything from a two-line reply to a megabyte of newsletter
 * markup. A budget in TIME is right whatever one row turns out to cost — the
 * pass stops handing out work once it has held the main process this long. It
 * is a ceiling, not a target; a drained mailbox never approaches it.
 */
export const TICK_BUDGET_MS = 2_000;

/**
 * Rows the body stage reads at a time.
 *
 * Sender-stage rows are a few hundred bytes of headers. A body-stage row
 * carries `raw_body` — the whole MIME source, attachments included — so the
 * same 200-row batch is a multi-hundred-megabyte read held in memory before a
 * single domain has been extracted from it. Chunking bounds that peak; the
 * deadline above, not this number, decides how much of the backlog a pass
 * gets through.
 */
export const BODY_BATCH_SIZE = 25;

export interface ReputationPassSummary {
  /** Sender-stage rows stamped this pass. */
  judged: number;
  /** Rows that gained points. */
  scored: number;
  /** Rows that crossed the spam line only now, and were filed. */
  filed: number;
  /** Rows still waiting for the sender stage after the pass, across accounts. */
  pending: number;
  /** Body-stage rows (link domains) judged this pass, and still waiting. */
  linkJudged: number;
  linkPending: number;
  /** Who link domains were looked up through, or null when that is off. */
  linkProvider: string | null;
  /** Whether registration dates were looked up. */
  domainAge: boolean;
  /** Fresh registry lookups made for domain age this pass. */
  ageLookups: number;
  /** Distinct notes from unknown answers — "Spamhaus refused the query", "Not signed in to Sarv". */
  notes: string[];
}

/** One pass over every account's unjudged rows. */
export async function runReputationPass(deps: ReputationPassDeps): Promise<ReputationPassSummary> {
  const links = deps.links();
  const age = deps.age?.() ?? null;
  const summary: ReputationPassSummary = {
    judged: 0, scored: 0, filed: 0, pending: 0, linkJudged: 0, linkPending: 0,
    linkProvider: links?.providerName ?? null, domainAge: age !== null, ageLookups: 0, notes: [],
  };
  if (!links && !age) return summary;
  const batch = deps.batch ?? 200;
  const bodyBatch = deps.bodyBatch ?? BODY_BATCH_SIZE;
  const nowMs = deps.nowMs ?? Date.now;
  const yieldFn = deps.yieldFn ?? yieldToEventLoop;
  const deadline = nowMs() + (deps.budgetMs ?? TICK_BUDGET_MS);
  // Awaited on every row of every loop below: it returns without yielding
  // while its own small budget holds, so the common cost is one clock read,
  // and hands the thread back to libuv the moment the budget is spent.
  const breathe = createLoopYielder({ now: nowMs, yieldFn });
  const notes = new Set<string>();

  // ---- Domain age, shared by both stages -----------------------------------
  //
  // One answer per domain per pass, from the month-long cache first and the
  // registry after, with a cap on fresh lookups so a pass over a large backlog
  // is bounded in registry traffic as well as in time. A lookup that fails is
  // cached for an hour (the cache's own rule) and adds nothing.
  const ages = new Map<string, DomainAgeLookup>();
  let ageBudget = age?.maxLookups ?? AGE_LOOKUPS_PER_PASS;
  const learnAges = async (domains: Iterable<string>): Promise<void> => {
    if (!age) return;
    const now = deps.now();
    for (const raw of new Set(domains)) {
      const domain = raw.toLowerCase();
      if (ages.has(domain)) continue;
      const cached = age.cache.get(domain, now);
      if (cached) { ages.set(domain, cached); continue; }
      if (ageBudget <= 0) continue;
      ageBudget -= 1;
      let lookup: DomainAgeLookup;
      try {
        lookup = await age.lookup(domain);
      } catch (e) {
        lookup = { domain, status: 'error', registered: null, ageDays: null, registrar: null, server: null, detail: (e as Error).message };
      }
      summary.ageLookups += 1;
      age.cache.set(domain, lookup, now);
      ages.set(domain, lookup);
      if (lookup.status === 'error' && lookup.detail) notes.add(`Domain age: ${lookup.detail}`);
    }
  };
  /** The youngest dated answer among some domains, or null. */
  const youngestOf = (domains: string[]): DomainAgeLookup | null => {
    let best: DomainAgeLookup | null = null;
    for (const d of domains) {
      const lookup = ages.get(d.toLowerCase());
      if (lookup?.status !== 'ok' || lookup.ageDays === null) continue;
      if (best === null || (best.ageDays ?? Infinity) > lookup.ageDays) best = lookup;
    }
    return best;
  };
  /** Age points a row already carries — the age budget is shared by both stages. */
  const agePointsOn = (row: { spamReasons: string | null }): number =>
    parseSpamReasons(row.spamReasons).filter((r) => AGE_REASON_IDS.has(r.id)).reduce((s, r) => s + r.points, 0);

  // ---- Sender stage: how old the sender's domains are ----------------------
  //
  // Registration dates only. The sender's blocklist standing was asked as the
  // message arrived; asking again here is the duplicate this pass used to be.
  // With domain age off there is nothing to judge a sender row by, so its rows
  // are left waiting rather than stamped — switching age on later still reaches
  // them.
  for (const target of age ? deps.targets() : []) {
    if (nowMs() >= deadline) break;
    let rows: ReturnType<ReputationStorage['getEmailsPendingReputation']>;
    try {
      rows = target.storage.getEmailsPendingReputation(batch);
    } catch (e) {
      logger.warn(`[Reputation] ${target.label}: could not list pending rows: ${(e as Error).message}`);
      continue;
    }
    if (rows.length === 0) continue;

    await learnAges(rows.flatMap((r) => messageDomains(r)));
    const judged = await judgeRows(
      target,
      rows,
      (row) => assessDomainAge({ sender: youngestOf(messageDomains(row)) }, { maxPoints: DOMAIN_AGE_MAX_POINTS - agePointsOn(row) }).reasons,
      summary,
      'sender',
      breathe,
    );
    try {
      summary.judged += target.storage.applyReputationBatch(judged, deps.now());
    } catch (e) {
      logger.warn(`[Reputation] ${target.label}: stamping failed: ${(e as Error).message}`);
    }
  }

  // ---- Body stage: the domains each message LINKS to -----------------------
  //
  // Chunked and deadline-bounded where the sender stage is not, because every
  // row here is a raw MIME body that gets HTML-parsed on this thread. One
  // 200-row pass was therefore an unbounded stretch of synchronous parsing
  // holding the main process, which is the freeze a CPU profile named in the
  // inline-image pass: yielding is what lets IMAP reads, IPC replies and the
  // renderer through while it runs.
  for (const target of deps.targets()) {
    while (nowMs() < deadline) {
      let rows: ReturnType<ReputationStorage['getEmailsPendingLinkReputation']>;
      try {
        rows = target.storage.getEmailsPendingLinkReputation(bodyBatch);
      } catch (e) {
        logger.warn(`[Reputation] ${target.label}: could not list rows awaiting the body stage: ${(e as Error).message}`);
        break;
      }
      if (rows.length === 0) break;
      const linkDomainsOf = new Map<string, string[]>();
      for (const row of rows) {
        await breathe();
        linkDomainsOf.set(row.id, linkDomains(row.rawBody, { exclude: [registrableDomain(senderDomainOf(row.fromAddress))] }));
      }
      const asked = [...new Set([...linkDomainsOf.values()].flat())];
      let result: ReputationResult = { provider: links?.providerName ?? 'none', ips: new Map(), domains: new Map() };
      if (links && asked.length > 0) {
        try {
          result = await links.lookup({ ips: [], domains: asked });
        } catch (e) {
          // The stage never throws; a lookup that does is still fail-open.
          notes.add(`Lookup failed: ${(e as Error).message}`);
        }
        for (const rep of result.domains.values()) if (rep.status === 'unknown' && rep.note) notes.add(rep.note);
      }
      await learnAges(asked);

      const judged = await judgeRows(target, rows, (row) => {
        const found = linkDomainsOf.get(row.id) ?? [];
        // One cap for every blocklist point a message can carry: the listings
        // the ingest check charged leave that much less room for the links.
        // Age points are not in that sum — they have a budget of their own.
        const already = blocklistPointsOn(parseSpamReasons(row.spamReasons));
        const linkAges = found.map((d) => ages.get(d.toLowerCase())).filter((l): l is DomainAgeLookup => l !== undefined);
        return [
          ...(links ? linkReputationReasons(result, found, already) : []),
          ...assessDomainAge({ links: linkAges }, { maxPoints: DOMAIN_AGE_MAX_POINTS - agePointsOn(row) }).reasons,
        ];
      }, summary, 'link', breathe);
      let stamped = 0;
      try {
        stamped = target.storage.applyLinkReputationBatch(judged, deps.now());
      } catch (e) {
        logger.warn(`[Reputation] ${target.label}: stamping the body stage failed: ${(e as Error).message}`);
        break; // unstamped rows are still pending: another chunk would re-read the same ones
      }
      summary.linkJudged += stamped;
      // Nothing left the queue, so the next chunk would be this chunk. Stop
      // rather than spin on it until the deadline.
      if (stamped === 0) break;
    }
  }

  for (const target of deps.targets()) {
    if (age) {
      try { summary.pending += target.storage.countEmailsPendingReputation(); } catch { /* counted as zero */ }
    }
    try { summary.linkPending += target.storage.countEmailsPendingLinkReputation(); } catch { /* counted as zero */ }
  }
  summary.notes = [...notes];
  return summary;
}

/** The domain of an address, lower-cased, or null. */
function senderDomainOf(address: string | null | undefined): string | null {
  const at = (address || '').lastIndexOf('@');
  return at < 0 ? null : (address || '').slice(at + 1).trim().toLowerCase() || null;
}

interface JudgeableRow {
  id: string; uid: number; folderId: string; folderPath: string; tags: string;
  spamScore: number; spamReasons: string | null; spamUserVerdict?: 'spam' | 'ham' | null;
}

/**
 * Add each row's new reasons to its stored score and file what crossed the
 * line: tag, local move, queued server move. Shared by both stages.
 * A row the user called 'ham' is scored (for the record) but never filed;
 * one the header stage already filed is not filed a second time.
 */
async function judgeRows<R extends JudgeableRow>(
  target: ReputationTarget,
  rows: R[],
  reasonsFor: (row: R) => SpamReason[],
  summary: ReputationPassSummary,
  stage: 'sender' | 'link' = 'sender',
  breathe: () => Promise<boolean> = async () => false,
): Promise<Array<{ id: string; spamScore: number; spamReasons: string }>> {
  let folders: FolderRecord[] | null = null;
  const updates: Array<{ id: string; spamScore: number; spamReasons: string }> = [];
  for (const row of rows) {
    // Filing a row is a synchronous storage write; better-sqlite3 resolves its
    // awaits as microtasks, so without this the whole batch runs as one
    // uninterruptible block however many rows crossed the line.
    await breathe();
    const reasons = reasonsFor(row);
    const score = row.spamScore + reasons.reduce((s, r) => s + r.points, 0);
    const allReasons = [...parseSpamReasons(row.spamReasons), ...reasons];
    updates.push({ id: row.id, spamScore: score, spamReasons: JSON.stringify(allReasons) });
    if (reasons.length) summary.scored += 1;
    if (score < SPAM_THRESHOLD || isSpamScore(row.spamScore) || row.spamUserVerdict === 'ham') continue;
    try {
      folders ??= await target.storage.getFolders();
      const tagged = hasTag(row.tags, 'spam') ? row.tags : addTag(row.tags, 'spam');
      const moved = computeFilterActionResult({ tags: tagged, folderId: row.folderId }, [{ type: 'moveToSpam' }], folders);
      await target.storage.updateEmail(row.id, { tags: moved.tags, folderId: moved.folderId });
      if (moved.changed && target.engine) {
        target.engine.moveToSpam(row.folderPath, row.uid).catch((err: unknown) => {
          logger.warn(`[Reputation] server-side move failed for uid ${row.uid} in ${row.folderPath}: ${(err as Error)?.message ?? err}`);
        });
      }
      summary.filed += 1;
    } catch (e) {
      logger.warn(`[Reputation] ${target.label}: ${stage}-stage re-file failed for ${row.id}: ${(e as Error).message}`);
    }
  }
  return updates;
}

// --------------------------------------------------------------- real wiring

/** RDAP over Chromium's network stack: the OS trust store and the user's proxy, like every other outbound call. */
const rdapFetch: FetchLike = (url) =>
  chromiumFetch(url, { headers: { accept: 'application/rdap+json' } }) as unknown as ReturnType<FetchLike>;

/** How long IANA's bootstrap file is believed before it is fetched again. It changes rarely. */
export const RDAP_BOOTSTRAP_TTL_MS = 24 * 60 * 60_000;
/** How soon a failed bootstrap fetch is retried — long enough not to hammer IANA during an outage. */
export const RDAP_BOOTSTRAP_RETRY_MS = 10 * 60_000;
let bootstrapPromise: Promise<RdapBootstrap | null> | null = null;
let bootstrapFetchedAt = 0;
let bootstrapTtl = RDAP_BOOTSTRAP_TTL_MS;

/** IANA's TLD → RDAP server table, fetched once a day and shared by every lookup. */
function rdapBootstrap(): Promise<RdapBootstrap | null> {
  const now = Date.now();
  if (bootstrapPromise && now - bootstrapFetchedAt < bootstrapTtl) return bootstrapPromise;
  bootstrapFetchedAt = now;
  bootstrapTtl = RDAP_BOOTSTRAP_TTL_MS;
  bootstrapPromise = fetchRdapBootstrap(rdapFetch).then((bootstrap) => {
    if (!bootstrap) bootstrapTtl = RDAP_BOOTSTRAP_RETRY_MS;
    return bootstrap;
  });
  return bootstrapPromise;
}

/** Test seam. */
export function resetRdapBootstrapCache(): void {
  bootstrapPromise = null;
  bootstrapFetchedAt = 0;
  bootstrapTtl = RDAP_BOOTSTRAP_TTL_MS;
}

/** The age source the settings allow, or null: with the toggle off, the registry is asked nothing. */
export function ageSourceForSettings(settings: ReputationSettings): AgeSource | null {
  if (!settings.domainAge) return null;
  return {
    cache: getDomainAgeCache(),
    lookup: async (domain) => lookupDomainAge(domain, { fetch: rdapFetch, bootstrap: await rdapBootstrap() }),
  };
}

function liveTargets(): ReputationTarget[] {
  const out: ReputationTarget[] = [];
  for (const [accountId, rt] of getAllAccountRuntimes()) {
    const storage = rt.storage as unknown as ReputationStorage | null;
    if (!storage?.getEmailsPendingReputation) continue;
    const engine = rt.syncEngine as unknown as { isConnected?: () => boolean; moveToSpam(folderPath: string, uid: number): Promise<unknown> } | null;
    out.push({ storage, engine: engine?.isConnected?.() ? engine : null, label: accountId });
  }
  return out;
}

// ------------------------------------------------------------------ scheduler

export const REPUTATION_FIRST_TICK_MS = 90_000;
export const REPUTATION_ACTIVE_INTERVAL_MS = 60_000;
export const REPUTATION_IDLE_INTERVAL_MS = 10 * 60_000;

export interface SpamReputationState {
  pending: number;
  judged: number;
  filed: number;
  /** Body stage (link domains). */
  linkPending: number;
  linkJudged: number;
  /** Who the blocklists are asked through as mail arrives, or null when nobody is. */
  blocklists: string | null;
  /** Who link domains were last looked up through, or null when link lookups are off. */
  linkProvider: string | null;
  /** Whether registration dates were looked up on the last pass. */
  domainAge: boolean;
  /** Registry lookups made for domain age this session. */
  ageChecked: number;
  notes: string[];
  running: boolean;
  /** Unix seconds of the last completed pass, null before the first. */
  lastRun: number | null;
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let stopped = false;
let unsubscribe: (() => void) | null = null;
const state: SpamReputationState = {
  pending: 0, judged: 0, filed: 0, linkPending: 0, linkJudged: 0, blocklists: null, linkProvider: null,
  domainAge: false, ageChecked: 0, notes: [], running: false, lastRun: null,
};

export function getSpamReputationState(): SpamReputationState {
  return { ...state, blocklists: blocklistProviderName(), running: inFlight };
}

function emitProgress(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('spam:reputation-progress', getSpamReputationState());
}

async function tick(): Promise<void> {
  if (stopped) return;
  if (inFlight) { timer = setTimeout(tick, REPUTATION_ACTIVE_INTERVAL_MS); return; }
  inFlight = true;
  let more = false;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    // Keep the one blocklist cache to answers that can still be served.
    try { getReputationCache().prune(nowSec); } catch { /* the next pass tries again */ }
    // Unreadable settings: nothing is looked up at all (see reputation-service).
    const settings = getReputationSettings();
    const summary = await runReputationPass({
      targets: liveTargets,
      links: () => linkReputationStage(),
      age: () => (settings ? ageSourceForSettings(settings) : null),
      now: () => Math.floor(Date.now() / 1000),
    });
    state.pending = summary.pending;
    state.judged += summary.judged;
    state.filed += summary.filed;
    state.linkPending = summary.linkPending;
    state.linkJudged += summary.linkJudged;
    state.linkProvider = summary.linkProvider;
    state.domainAge = summary.domainAge;
    state.ageChecked += summary.ageLookups;
    state.notes = summary.notes;
    state.lastRun = Math.floor(Date.now() / 1000);
    more = (summary.domainAge || summary.linkProvider !== null) && (summary.pending > 0 || summary.linkPending > 0);
    if (summary.judged > 0 || summary.linkJudged > 0) {
      logger.info(`[Reputation] judged ${summary.judged} sender row(s) and ${summary.linkJudged} body row(s): ${summary.scored} gained points, ${summary.filed} filed as spam; ${summary.pending} + ${summary.linkPending} pending`
        + (summary.notes.length ? ` — ${summary.notes.join('; ')}` : ''));
    }
  } catch (e) {
    logger.error('[Reputation] pass failed:', e);
  } finally {
    inFlight = false;
    emitProgress();
    if (!stopped) timer = setTimeout(tick, more ? REPUTATION_ACTIVE_INTERVAL_MS : REPUTATION_IDLE_INTERVAL_MS);
  }
}

export function startSpamReputationScheduler(): void {
  if (timer) return;
  stopped = false;
  timer = setTimeout(tick, REPUTATION_FIRST_TICK_MS);
  // A newly enabled lookup should not wait out the idle cadence.
  unsubscribe ??= onReputationSettingsChanged(kickSpamReputation);
  logger.info(`[Reputation] scheduled: first pass in ${REPUTATION_FIRST_TICK_MS / 1000}s`);
}

export function stopSpamReputationScheduler(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
  unsubscribe?.();
  unsubscribe = null;
}

/** Pull the next pass forward — the Security page's "Run now", or a settings change. No-op mid-pass. */
export function kickSpamReputation(): void {
  if (!timer || inFlight) return;
  clearTimeout(timer);
  timer = setTimeout(tick, 250);
}
