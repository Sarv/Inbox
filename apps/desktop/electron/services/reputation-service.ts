/**
 * Blocklist lookups for the whole process — the ONE path.
 *
 * The reputation stage is the spam check that leaves the machine: it tells a
 * third party, in near real time, which addresses and domains are writing to
 * this user. Until 2026-09-24 two paths did it — a lookup made as mail arrived
 * (Security > Blocklists) and a background pass (Settings > General) that asked
 * the same lists about the same sender again, with its own setting, its own
 * cache and its own reading of the answers. This module is what is left: one
 * setting, one provider, one cache, one stage, asked at two moments.
 *
 *  - AS MAIL ARRIVES, about the sender — the connecting IP and the From and
 *    Reply-To domains. Awaited inside ingest, so a listed sender is filed
 *    before the user ever sees the message. This is the only place a sender
 *    is asked about.
 *  - LATER, about the domains a body links to, by the background pass once
 *    the body is downloaded (`spam-reputation-service.ts`), when the user has
 *    opted into link lookups. Same stage, so the same cache and breakers.
 *
 * Three things follow from asking a third party, and are true of no other
 * stage in the filter.
 *
 *  - It is ON by default, with every zone in the scanner's catalogue queried
 *    through this computer's DNS; the user unticks lists, switches provider or
 *    turns it off in Security > Blocklists. Default-on is a product decision
 *    taken on 2026-09-23: what makes it safe to ship is the per-zone breaker
 *    in the local provider — an operator that refuses this network is retired
 *    on its own while the others keep answering.
 *  - There is exactly ONE stage for the process, shared by every account's
 *    sync engine and by the background pass. Two accounts receiving the same
 *    newsletter ask the operator once, not twice.
 *  - Its settings live in the ordinary settings blob, mirrored into the core
 *    DB by the renderer's app-settings bootstrap. Main reads them STRICTLY: a
 *    store that cannot be read is not the same fact as a store with nothing in
 *    it, and with a default of "ask everybody" reading one as the other would
 *    send queries for a user who switched them off. Unreadable means nobody is
 *    asked until a read succeeds.
 *
 * The resolver list matters more than it looks. Spamhaus and others refuse
 * queries that reach them through a public or open resolver, which is what a
 * home connection on its ISP's DNS (or on 8.8.8.8) almost always is. The
 * refusal is itself an answer, `127.255.255.254`; the library reads it as a
 * refusal rather than a listing, and the breaker stops us hammering a zone
 * that will never answer. A user who wants every list realistically needs
 * their own resolver or a keyed subscription zone.
 */
import { promises as dns } from 'node:dns';

import { BLOCKLISTS, type Blocklist } from '@sarv-in/mailguard';
import {
  LocalDnsblProvider,
  ReputationStage,
  SarvReputationProvider,
  createLogger,
  readBlocklistPrefs,
  type BlocklistPrefs,
  type ItemReputation,
  type ReputationCacheStore,
  type ReputationLookup,
  type ReputationProvider,
  type ReputationSubject,
  type SenderReport,
} from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { getCoreDb, readAppSetting } from './core-db';
import { chromiumFetch } from './net-fetch';
import { getValidAccessToken, listSignedInAccounts } from './oauth-service';

const logger = createLogger('Reputation');

/** The localStorage key the settings blob is mirrored under. */
export const SETTINGS_KEY = 'sarvinbox-settings';

/**
 * The user's choices, as stored in that blob. The shape and the reading —
 * defaults, the migrations of the old saved "off" and of the retired Settings >
 * General control, the literal read of everything else — live in core's
 * `blocklist-prefs`, shared with the Blocklists tab so the ticks a user sees
 * are the lists that are queried.
 */
export type ReputationSettings = BlocklistPrefs;

/** Every zone the scanner describes, in catalogue order — what a fresh install asks. */
export const DEFAULT_ZONES: readonly string[] = BLOCKLISTS.map((list) => list.name);

export const DEFAULT_REPUTATION_SETTINGS: ReputationSettings = readBlocklistPrefs(undefined, DEFAULT_ZONES);

const CATALOGUE = new Map<string, Blocklist>(BLOCKLISTS.map((list) => [list.name, list]));

/** Every zone this build can be asked to query, for the settings UI. */
export function availableBlocklists(): ReadonlyArray<{ name: string; zone: string; kind: string }> {
  return BLOCKLISTS.map(({ name, zone, kind }) => ({ name, zone, kind }));
}

/**
 * Read the user's choices out of a stored settings map.
 *
 * This value crosses from the renderer's localStorage into a DNS query or a
 * bearer-authenticated request, so it is re-derived rather than trusted — by
 * `readBlocklistPrefs`, which is also what the Blocklists tab reads it with.
 * A blob that is present but unparseable reads as no settings at all: the
 * defaults.
 */
export function readReputationSettings(stored: Record<string, string>): ReputationSettings {
  return settingsFrom(stored[SETTINGS_KEY] ?? null);
}

function settingsFrom(raw: string | null): ReputationSettings {
  let blob: unknown;
  try {
    blob = raw ? JSON.parse(raw) : undefined;
  } catch {
    blob = undefined;
  }
  return readBlocklistPrefs(blob, DEFAULT_ZONES);
}

// ---------------------------------------------------------------------- cache

/** Seconds a listed / clean answer is reused. */
export const REPUTATION_CACHE_TTL_S = 6 * 60 * 60;
/**
 * Seconds an unknown answer stored by an older build is honoured. The stage
 * never stores one — a blip must not become hours of "no opinion" — but rows
 * written before the paths merged still sit in the table.
 */
export const REPUTATION_CACHE_UNKNOWN_TTL_S = 30 * 60;

export function ensureReputationCacheSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reputation_cache (
      kind         TEXT NOT NULL,
      item         TEXT NOT NULL,
      status       TEXT NOT NULL,
      hits         TEXT NOT NULL,
      user_reports INTEGER,
      note         TEXT,
      provider     TEXT NOT NULL,
      checked_at   INTEGER NOT NULL,
      PRIMARY KEY (kind, item)
    );
  `);
}

/**
 * The one cache: every answer about an address or a domain, in the core DB,
 * shared by every account and by both moments the stage is asked — and kept
 * across a restart, so the first sync of the morning does not re-ask about
 * yesterday's senders.
 */
export class ReputationCache implements ReputationCacheStore {
  constructor(private readonly db: Database.Database) {
    ensureReputationCacheSchema(db);
  }

  /** A still-fresh answer, or null. */
  get(kind: 'ip' | 'domain', item: string, nowSec: number): ItemReputation | null {
    const r = this.db.prepare('SELECT status, hits, user_reports, note, checked_at FROM reputation_cache WHERE kind = ? AND item = ?')
      .get(kind, item) as { status: ItemReputation['status']; hits: string; user_reports: number | null; note: string | null; checked_at: number } | undefined;
    if (!r) return null;
    const ttl = r.status === 'unknown' ? REPUTATION_CACHE_UNKNOWN_TTL_S : REPUTATION_CACHE_TTL_S;
    if (nowSec - r.checked_at > ttl) return null;
    let hits: ItemReputation['hits'] = [];
    try { hits = JSON.parse(r.hits); } catch { hits = []; }
    return {
      status: r.status, hits,
      ...(r.user_reports != null ? { userReports: r.user_reports } : {}),
      ...(r.note ? { note: r.note } : {}),
    };
  }

  set(kind: 'ip' | 'domain', item: string, rep: ItemReputation, provider: string, nowSec: number): void {
    this.db.prepare(`
      INSERT INTO reputation_cache (kind, item, status, hits, user_reports, note, provider, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, item) DO UPDATE SET status = excluded.status, hits = excluded.hits, user_reports = excluded.user_reports,
        note = excluded.note, provider = excluded.provider, checked_at = excluded.checked_at
    `).run(kind, item, rep.status, JSON.stringify(rep.hits), rep.userReports ?? null, rep.note ?? null, provider, nowSec);
  }

  /** Forget every answer — the lists asked have changed, so every answer is out of date. */
  clear(): void {
    this.db.prepare('DELETE FROM reputation_cache').run();
  }

  /** Drop answers too old to be served, so the table holds recent senders rather than every one ever seen. */
  prune(nowSec: number): number {
    return this.db.prepare('DELETE FROM reputation_cache WHERE checked_at < ?').run(nowSec - REPUTATION_CACHE_TTL_S).changes;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reputation_cache').get() as { n: number }).n;
  }
}

let cacheSingleton: ReputationCache | null = null;
export function getReputationCache(): ReputationCache {
  if (!cacheSingleton) cacheSingleton = new ReputationCache(getCoreDb());
  return cacheSingleton;
}

/**
 * The stage's view of the cache: opened on first use rather than when the
 * stage is built (engines are wired before anyone asks), and every failure is
 * the stage's to absorb — an unreadable cache is a miss, never a failed message.
 */
const cacheStore: ReputationCacheStore = {
  get: (kind, item, nowSec) => getReputationCache().get(kind, item, nowSec),
  set: (kind, item, rep, provider, nowSec) => getReputationCache().set(kind, item, rep, provider, nowSec),
};

// ------------------------------------------------------------------ providers

/** Per-query DNS budget. Short, and one try: the answer is awaited on the ingest path. */
export const DNS_TIMEOUT_MS = 3_000;
/** Per-request budget for the Sarv service, for the same reason. Its breaker bounds a slow day. */
export const SARV_TIMEOUT_MS = 5_000;

/** The first signed-in Sarv account's bearer, or null — the service is per user. */
async function sarvToken(): Promise<string | null> {
  const accounts = await listSignedInAccounts();
  const sarv = accounts.find((a) => a.provider === 'sarv');
  if (!sarv) return null;
  return getValidAccessToken('sarv', sarv.email);
}

/**
 * A resolver over the user's own nameservers, or the system's when they named
 * none — or null when they named ones `node:dns` cannot use. Falling back to
 * the system resolver then would send the queries through exactly the resolver
 * the user chose not to use.
 */
function resolverFor(servers: readonly string[]): ((name: string) => Promise<string[]>) | null {
  const resolver = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  if (servers.length > 0) {
    try {
      resolver.setServers([...servers]);
    } catch (e) {
      logger.warn(`Blocklist resolvers not usable (${servers.join(', ')}): ${(e as Error).message} — asking nobody until they are fixed`);
      return null;
    }
  }
  return (name) => resolver.resolve4(name);
}

/** The provider the settings name, or null when they name nobody who can be asked. */
export function providerForSettings(settings: ReputationSettings): ReputationProvider | null {
  if (!settings.enabled) return null;
  if (settings.provider === 'sarv') {
    if (!settings.endpoint) return null;
    return new SarvReputationProvider({
      endpoint: settings.endpoint,
      getToken: sarvToken,
      fetch: (url, init) => chromiumFetch(url, init as RequestInit),
      timeoutMs: SARV_TIMEOUT_MS,
    });
  }
  const lists = settings.zones
    .map((name) => CATALOGUE.get(name))
    .filter((list): list is Blocklist => list !== undefined);
  if (lists.length === 0) return null;
  const resolve4 = resolverFor(settings.servers);
  return resolve4 ? new LocalDnsblProvider({ lists, resolve4 }) : null;
}

// ---------------------------------------------------------------------- stage

/** How soon a failed settings read is tried again by a lookup. A settings write retries at once. */
export const SETTINGS_RETRY_MS = 30_000;

let stage: ReputationStage | null = null;
/** The settings the stage was built from — the last read that succeeded — or null before the first. */
let applied: ReputationSettings | null = null;
/** The last read failed: nobody is asked until one succeeds. */
let unreadable = false;
let lastFailedReadAt = 0;
const listeners = new Set<() => void>();

/**
 * The settings in force, reading them first if nothing has been read yet —
 * or null while they cannot be read, which means nobody is asked. A failed
 * read is retried at most every SETTINGS_RETRY_MS from here: this is on the
 * ingest path, and an unopenable core DB must not cost every message a
 * fresh attempt to open it.
 */
function current(): ReputationSettings | null {
  if (unreadable ? Date.now() - lastFailedReadAt >= SETTINGS_RETRY_MS : !applied) refreshReputation();
  return unreadable ? null : applied;
}

/**
 * The one lookup every engine is handed. It reads whichever stage is current
 * at call time, so a settings change takes effect without re-wiring a single
 * engine — including engines belonging to accounts activated before the
 * change.
 */
const lookup: ReputationLookup = (subject: ReputationSubject) =>
  current() && stage ? stage.assess(subject) : Promise.resolve(null);

/** Whether two settings ask the same somebody the same things — anything else invalidates every answer. */
const sameAsking = (a: ReputationSettings, b: ReputationSettings): boolean =>
  a.enabled === b.enabled &&
  a.provider === b.provider &&
  a.zones.join(' ') === b.zones.join(' ') &&
  a.servers.join(' ') === b.servers.join(' ') &&
  a.endpoint === b.endpoint;

const sameSettings = (a: ReputationSettings, b: ReputationSettings): boolean =>
  sameAsking(a, b) && a.reports === b.reports && a.links === b.links && a.domainAge === b.domainAge;

/**
 * Give a sync engine the shared lookup.
 *
 * Called for every engine, whether or not anybody is to be asked: a lookup
 * with no stage behind it answers `null` and costs nothing, and wiring
 * only-when-enabled would leave every engine created before the switch unwired.
 */
export function attachReputation(engine: { setReputationLookup(fn: ReputationLookup): void }): void {
  refreshReputation();
  engine.setReputationLookup(lookup);
}

/**
 * Re-read the settings and rebuild the stage if what it asks changed.
 *
 * A rebuild also CLEARS the cache, which is the point: a user who has just
 * added a zone, or switched to the Sarv service, expects the next message to
 * be asked about, not answered from a verdict reached before. A change to
 * anything else — link lookups, registration dates, reports — keeps both.
 */
export function refreshReputation(): void {
  let settings: ReputationSettings;
  try {
    settings = settingsFrom(readAppSetting(SETTINGS_KEY));
  } catch (e) {
    // Fail closed: see the module header. The stage and the settings it was
    // built from are kept, so a store that reads again unchanged resumes
    // where it was — but nothing is asked until it does.
    if (!unreadable) logger.warn(`Blocklist settings unreadable — asking nobody until they can be read: ${(e as Error).message}`);
    unreadable = true;
    lastFailedReadAt = Date.now();
    return;
  }
  unreadable = false;
  const previous = applied;
  if (previous && sameSettings(settings, previous)) return;
  applied = settings;
  if (!previous || !sameAsking(settings, previous)) {
    const provider = providerForSettings(settings);
    stage = provider ? new ReputationStage(provider, cacheStore) : null;
    if (previous) {
      try {
        getReputationCache().clear();
      } catch (e) {
        logger.warn(`Blocklist cache not cleared: ${(e as Error).message}`);
      }
    }
    logger.info(stage ? `Blocklist lookups on: ${describe(settings)}` : 'Blocklist lookups off');
  }
  if (previous) for (const listener of listeners) listener();
}

function describe(settings: ReputationSettings): string {
  const who = settings.provider === 'sarv'
    ? `the Sarv service at ${settings.endpoint}`
    : `${settings.zones.join(', ')} via ${settings.servers.length > 0 ? settings.servers.join(', ') : 'the system resolver'}`;
  return settings.links ? `${who}, link domains included` : who;
}

/**
 * Told by the app-settings IPC that a key was written. Only the settings blob
 * carries this feature's configuration, so everything else is ignored.
 */
export function noteAppSettingChanged(key: string): void {
  if (key === SETTINGS_KEY) refreshReputation();
}

/** Be told when the settings change — the background pass runs early rather than on its idle cadence. */
export function onReputationSettingsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The settings currently in force, or null while they cannot be read (nothing is asked). */
export function getReputationSettings(): ReputationSettings | null {
  return current();
}

/** The provider name the stage asks — for the Security page — or null when nobody is asked. */
export function blocklistProviderName(): string | null {
  return current() && stage ? stage.providerName : null;
}

/**
 * The stage, for the background pass to look up the domains a body links to —
 * or null unless the user opted into link lookups. The same stage the ingest
 * check uses, so a domain is asked about once whichever moment asks first.
 */
export function linkReputationStage(): ReputationStage | null {
  const settings = current();
  return settings?.enabled && settings.links ? stage : null;
}

// -------------------------------------------------------------- the report loop

/** Do the settings allow the user's own verdicts to leave the machine? */
export function reportsAllowed(settings: ReputationSettings): boolean {
  return settings.enabled && settings.provider === 'sarv' && !!settings.endpoint && settings.reports;
}

/**
 * Send the user's Report spam / Not spam verdict to the Sarv service, if — and
 * only if — the settings say so. Fire-and-forget; a failed report is nothing.
 */
export function reportSenderVerdict(
  report: SenderReport,
  deps: { settings?: ReputationSettings | null; provider?: ReputationProvider | null } = {},
): void {
  const settings = deps.settings === undefined ? current() : deps.settings;
  if (!settings || !reportsAllowed(settings)) return;
  const provider = deps.provider === undefined ? providerForSettings(settings) : deps.provider;
  if (!provider?.report) return;
  provider.report(report).then((accepted) => {
    if (accepted) logger.info(`Reported ${report.verdict} for ${report.domain ?? report.ip}`);
  }).catch(() => { /* fail-open */ });
}

/** Test seam: forget the stage and the settings it was built from. */
export function resetReputationForTests(): void {
  stage = null;
  applied = null;
  unreadable = false;
  lastFailedReadAt = 0;
  listeners.clear();
  cacheSingleton = null;
}
