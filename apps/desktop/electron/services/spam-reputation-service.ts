/**
 * The spam filter's reputation stage — the part that asks the network.
 *
 * The header stage scores every message at insert. This stage runs a little
 * later, in the background, over rows it has not judged yet: it looks up the
 * connecting IP and the sender / Reply-To domains through ONE provider, adds
 * whatever points the answer earns to the stored score, and — when a message
 * crosses the line only now — tags it, files it locally and queues the
 * server-side move, exactly as the header stage would have at insert.
 *
 * Providers (core spam-reputation.ts): the Sarv-hosted service, reached with
 * the user's own Sarv OAuth token (the default once its endpoint is
 * configured), or plain DNSBL queries from this machine for self-hosters. Off
 * is off: rows stay unjudged and nothing leaves the machine.
 *
 * Every answer is cached per IP / domain in the core DB so a campaign that
 * hits the inbox forty times costs one lookup, and every failure is fail-open:
 * an unknown adds no points and a row is judged once, whatever came back.
 */
import { promises as dns } from 'node:dns';

import {
  LocalDnsblProvider,
  SPAM_THRESHOLD,
  SarvReputationProvider,
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
  reputationReasons,
  stageOfReason,
  yieldToEventLoop,
  type FolderRecord,
  type ItemReputation,
  type ReputationProvider,
  type ReputationResult,
  type SenderReport,
  type SpamReason,
} from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { getAllAccountRuntimes, getMainWindow } from '../shared';

import { getBlob, getCoreDb, setBlob } from './core-db';
import { chromiumFetch } from './net-fetch';
import { getValidAccessToken, listSignedInAccounts } from './oauth-service';

const logger = createLogger('spam-reputation');

// --------------------------------------------------------------------- policy

export type ReputationMode = 'off' | 'local' | 'sarv';

export interface SpamReputationPolicy {
  mode: ReputationMode;
  /** The Sarv reputation service origin. Empty = not configured = no lookups in 'sarv' mode. */
  endpoint: string;
  /**
   * Send the user's own Report spam / Not spam verdicts to the Sarv service
   * (sender domain, connecting IP, verdict — never subject, body or
   * recipients). Opt-in: this is the one thing here that leaves the machine
   * because the user did something, not because mail arrived.
   */
  reports: boolean;
}

export const DEFAULT_SPAM_REPUTATION_POLICY: SpamReputationPolicy = { mode: 'sarv', endpoint: '', reports: false };
const POLICY_BLOB_KEY = 'spam-reputation-policy';
let cachedPolicy: SpamReputationPolicy | null = null;

export function normalizeSpamReputationPolicy(raw: unknown): SpamReputationPolicy {
  const r = (raw ?? {}) as Record<string, unknown>;
  const mode = r.mode === 'off' || r.mode === 'local' || r.mode === 'sarv' ? r.mode : DEFAULT_SPAM_REPUTATION_POLICY.mode;
  let endpoint = typeof r.endpoint === 'string' ? r.endpoint.trim() : '';
  try {
    endpoint = endpoint && new URL(endpoint).protocol === 'https:' ? endpoint.replace(/\/+$/, '') : '';
  } catch {
    endpoint = '';
  }
  return { mode, endpoint, reports: r.reports === true };
}

export function getSpamReputationPolicy(): SpamReputationPolicy {
  if (cachedPolicy) return cachedPolicy;
  try {
    const blob = getBlob(POLICY_BLOB_KEY);
    cachedPolicy = normalizeSpamReputationPolicy(blob ? JSON.parse(blob.toString('utf8')) : null);
  } catch {
    cachedPolicy = { ...DEFAULT_SPAM_REPUTATION_POLICY };
  }
  return cachedPolicy;
}

export function setSpamReputationPolicy(raw: unknown): SpamReputationPolicy {
  cachedPolicy = normalizeSpamReputationPolicy(raw);
  try {
    setBlob(POLICY_BLOB_KEY, Buffer.from(JSON.stringify(cachedPolicy), 'utf8'));
  } catch (e) {
    logger.warn(`[Reputation] policy not persisted: ${(e as Error).message}`);
  }
  return cachedPolicy;
}

/** Test seam. */
export function resetSpamReputationPolicyCache(): void {
  cachedPolicy = null;
}

// ---------------------------------------------------------------------- cache

/** Seconds a listed / clean answer is reused. */
export const REPUTATION_CACHE_TTL_S = 6 * 60 * 60;
/** Seconds before an unknown (refused, unreachable) is asked again. */
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

export class ReputationCache {
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

  /** Cached rows, newest first — for the Security page. */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reputation_cache').get() as { n: number }).n;
  }
}

let cacheSingleton: ReputationCache | null = null;
export function getReputationCache(): ReputationCache {
  if (!cacheSingleton) cacheSingleton = new ReputationCache(getCoreDb());
  return cacheSingleton;
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

export interface ReputationPassDeps {
  targets: () => ReputationTarget[];
  /** null = the stage is off. */
  provider: () => ReputationProvider | null;
  cache: ReputationCache;
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
  /** Rows stamped this pass. */
  judged: number;
  /** Rows that gained reputation points. */
  scored: number;
  /** Rows that crossed the spam line only because of reputation, and were filed. */
  filed: number;
  /** Rows still waiting for the sender stage after the pass, across accounts. */
  pending: number;
  /** Body-stage rows (link domains) judged this pass, and still waiting. */
  linkJudged: number;
  linkPending: number;
  provider: string | null;
  /** Distinct notes from unknown answers — "Spamhaus refused the query", "Not signed in to Sarv". */
  notes: string[];
}

const empty = (provider: string): ReputationResult => ({ provider, ips: new Map(), domains: new Map() });

/** One pass over every account's unjudged rows. */
export async function runReputationPass(deps: ReputationPassDeps): Promise<ReputationPassSummary> {
  const provider = deps.provider();
  const summary: ReputationPassSummary = { judged: 0, scored: 0, filed: 0, pending: 0, linkJudged: 0, linkPending: 0, provider: provider?.name ?? null, notes: [] };
  if (!provider) return summary;
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

  for (const target of deps.targets()) {
    if (nowMs() >= deadline) break;
    let rows: ReturnType<ReputationStorage['getEmailsPendingReputation']>;
    try {
      rows = target.storage.getEmailsPendingReputation(batch);
    } catch (e) {
      logger.warn(`[Reputation] ${target.label}: could not list pending rows: ${(e as Error).message}`);
      continue;
    }
    if (rows.length === 0) continue;

    // What to ask about, minus what the cache already knows.
    const now = deps.now();
    const result = empty(provider.name);
    const askIps: string[] = [];
    const askDomains: string[] = [];
    for (const ip of new Set(rows.map((r) => r.originIp).filter((x): x is string => !!x))) {
      const hit = deps.cache.get('ip', ip, now);
      if (hit) result.ips.set(ip, hit); else askIps.push(ip);
    }
    for (const d of new Set(rows.flatMap((r) => messageDomains(r)))) {
      const hit = deps.cache.get('domain', d, now);
      if (hit) result.domains.set(d, hit); else askDomains.push(d);
    }
    if (askIps.length || askDomains.length) {
      let fresh: ReputationResult;
      try {
        fresh = await provider.lookup({ ips: askIps, domains: askDomains });
      } catch (e) {
        // A provider that throws instead of answering "unknown" is still fail-open.
        fresh = empty(provider.name);
        notes.add(`Lookup failed: ${(e as Error).message}`);
      }
      for (const [ip, rep] of fresh.ips) { result.ips.set(ip, rep); deps.cache.set('ip', ip, rep, provider.name, now); }
      for (const [d, rep] of fresh.domains) { result.domains.set(d, rep); deps.cache.set('domain', d, rep, provider.name, now); }
    }
    for (const rep of [...result.ips.values(), ...result.domains.values()]) if (rep.status === 'unknown' && rep.note) notes.add(rep.note);

    // Score, and file what crossed the line.
    const judged = await judgeRows(target, rows, (row) => reputationReasons(result, { originIp: row.originIp, domains: messageDomains(row) }), summary, 'sender', breathe);
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
      const now = deps.now();
      const linkDomainsOf = new Map<string, string[]>();
      for (const row of rows) {
        await breathe();
        linkDomainsOf.set(row.id, linkDomains(row.rawBody, { exclude: [registrableDomain(senderDomainOf(row.fromAddress))] }));
      }
      const result = empty(provider.name);
      const ask: string[] = [];
      for (const d of new Set([...linkDomainsOf.values()].flat())) {
        const hit = deps.cache.get('domain', d, now);
        if (hit) result.domains.set(d, hit); else ask.push(d);
      }
      if (ask.length) {
        let fresh: ReputationResult;
        try {
          fresh = await provider.lookup({ ips: [], domains: ask });
        } catch (e) {
          fresh = empty(provider.name);
          notes.add(`Lookup failed: ${(e as Error).message}`);
        }
        for (const [d, rep] of fresh.domains) { result.domains.set(d, rep); deps.cache.set('domain', d, rep, provider.name, now); }
      }
      for (const rep of result.domains.values()) if (rep.status === 'unknown' && rep.note) notes.add(rep.note);

      const judged = await judgeRows(target, rows, (row) => {
        // The two network stages share one cap: points the sender stage already
        // added leave that much less room for the links.
        const already = parseSpamReasons(row.spamReasons).filter((r) => stageOfReason(r.id) === 'reputation').reduce((s, r) => s + r.points, 0);
        return linkReputationReasons(result, linkDomainsOf.get(row.id) ?? [], already);
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
    try { summary.pending += target.storage.countEmailsPendingReputation(); } catch { /* counted as zero */ }
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
 * line: tag, local move, queued server move. Shared by both network stages.
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

// -------------------------------------------------------------- the report loop

/** Does the policy allow the user's verdicts to leave the machine? */
export function reportsAllowed(policy: SpamReputationPolicy): boolean {
  return policy.mode === 'sarv' && !!policy.endpoint && policy.reports;
}

/**
 * Send the user's Report spam / Not spam verdict to the Sarv service, if — and
 * only if — the policy says so. Fire-and-forget; a failed report is nothing.
 */
export function reportSenderVerdict(
  report: SenderReport,
  deps: { policy?: SpamReputationPolicy; provider?: ReputationProvider | null } = {},
): void {
  const policy = deps.policy ?? getSpamReputationPolicy();
  if (!reportsAllowed(policy)) return;
  const provider = deps.provider === undefined ? providerForPolicy(policy) : deps.provider;
  if (!provider?.report) return;
  provider.report(report).then((accepted) => {
    if (accepted) logger.info(`[Reputation] reported ${report.verdict} for ${report.domain ?? report.ip}`);
  }).catch(() => { /* fail-open */ });
}

// --------------------------------------------------------------- real wiring

/** The first signed-in Sarv account's bearer, or null — the service is per user. */
async function sarvToken(): Promise<string | null> {
  const accounts = await listSignedInAccounts();
  const sarv = accounts.find((a) => a.provider === 'sarv');
  if (!sarv) return null;
  return getValidAccessToken('sarv', sarv.email);
}

/** Build the provider the policy names, or null when the stage is off / not configured. */
export function providerForPolicy(policy: SpamReputationPolicy): ReputationProvider | null {
  if (policy.mode === 'local') return new LocalDnsblProvider({ resolve4: (name) => dns.resolve4(name) });
  if (policy.mode === 'sarv' && policy.endpoint) {
    return new SarvReputationProvider({
      endpoint: policy.endpoint,
      getToken: sarvToken,
      fetch: (url, init) => chromiumFetch(url, init as RequestInit),
    });
  }
  return null;
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
  provider: string | null;
  notes: string[];
  running: boolean;
  /** Unix seconds of the last completed pass, null before the first. */
  lastRun: number | null;
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let stopped = false;
const state: SpamReputationState = { pending: 0, judged: 0, filed: 0, linkPending: 0, linkJudged: 0, provider: null, notes: [], running: false, lastRun: null };

export function getSpamReputationState(): SpamReputationState {
  return { ...state, running: inFlight };
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
    const policy = getSpamReputationPolicy();
    const summary = await runReputationPass({
      targets: liveTargets,
      provider: () => providerForPolicy(policy),
      cache: getReputationCache(),
      now: () => Math.floor(Date.now() / 1000),
    });
    state.pending = summary.pending;
    state.judged += summary.judged;
    state.filed += summary.filed;
    state.linkPending = summary.linkPending;
    state.linkJudged += summary.linkJudged;
    state.provider = summary.provider;
    state.notes = summary.notes;
    state.lastRun = Math.floor(Date.now() / 1000);
    more = summary.provider !== null && (summary.pending > 0 || summary.linkPending > 0);
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
  logger.info(`[Reputation] scheduled: first pass in ${REPUTATION_FIRST_TICK_MS / 1000}s`);
}

export function stopSpamReputationScheduler(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}

/** Pull the next pass forward — the Security page's "Run now". No-op mid-pass. */
export function kickSpamReputation(): void {
  if (!timer || inFlight) return;
  clearTimeout(timer);
  timer = setTimeout(tick, 250);
}
