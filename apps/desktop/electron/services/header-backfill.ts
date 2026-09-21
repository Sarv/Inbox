/**
 * Header backfill (main process).
 *
 * Two columns are derived from a message's headers and both were added after
 * mail had already been synced, so both are NULL across the whole history:
 *
 *   - `auth_status` — without it the shield reads "Unverified" no matter what
 *     the receiving server actually recorded. On the reporting mailbox that was
 *     5,768 of 5,872 messages: the entire history, grey.
 *   - `spam_score` / `spam_reasons` / `origin_ip` (v86) — without them the
 *     shield says "Not scored — this message was never put through the filter",
 *     which is true and useless. The scorer runs at ingest only, so nothing
 *     already in the mailbox would ever get a verdict.
 *
 * ONE sweep fills both, because a headers-only FETCH already returns everything
 * `headerStage` needs — envelope, raw header block, INTERNALDATE. Re-reading
 * the same few hundred bytes twice, once per column, would have doubled the
 * IMAP traffic to learn nothing new. A 6,000-message mailbox finishes in a
 * couple of minutes on a healthy connection.
 *
 * The verdicts come from `headerStage`, the same function ingest uses, so a
 * message swept today gets the score it would have got had it arrived today.
 * That is the whole reason the derivation was extracted: a spam score that
 * depends on which code path wrote it is not a score.
 *
 * Rules it borrows from the body-prefetch scheduler, for the same reasons:
 *   - one tick in flight; a fire while running is a no-op,
 *   - every connected account, each on its own pool connection,
 *   - skip a connection that is churning rather than pile on,
 *   - stop() prevents any further tick, including a re-arm from a tick that
 *     was mid-flight.
 *
 * What it deliberately does NOT do: retry a message the server returned with
 * no authentication header. That is a real, final answer ("nothing recorded"),
 * stored as an all-unknown verdict so the row leaves the backlog and the
 * shield says Unverified for the right reason. NULL therefore means exactly
 * "not checked yet", and the progress line can be honest.
 *
 * Nor does it score the user's own Sent and Drafts — `headerStage` refuses to,
 * exactly as ingest does. Those rows are excluded from the spam half of the
 * backlog query for that reason; left in, they would be fetched, declined, and
 * selected again every 1.5 seconds forever.
 */
import { createLogger, headerStage, isOwnMailFolder, parseAuthenticationHeaders, type IMAPMessage } from '@sarvinbox/core';
import { HEADER_STAGE_MAX_ATTEMPTS } from '@sarvinbox/storage-node';

import { getStorage, getSyncEngine, getMainWindow, getAllAccountRuntimes } from '../shared';

import { isConnectionRecentlyUnstable } from './connection-health';

const logger = createLogger('header-backfill');

/** Let initial sync and the body prefetch's first tick settle first. */
export const FIRST_DELAY_MS = 45_000;
/** Gap between batches while there is a backlog — enough to interleave with user fetches. */
export const ACTIVE_INTERVAL_MS = 1_500;
/** Sleep once everything has a verdict; new mail gets its verdict at sync, not here. */
export const IDLE_INTERVAL_MS = 30 * 60_000;
/** UIDs per FETCH. One round-trip; well under the 500 the flag sync uses. */
export const BATCH_SIZE = 200;
/** Folders per tick per account, so one huge Archive cannot starve INBOX. */
const FOLDERS_PER_TICK = 3;

/**
 * How long one account's tick may keep working before it stops starting new
 * chunks.
 *
 * Row-count-based limits assume a fixed cost per row, and this loop's cost per
 * row is a network FETCH plus a synchronous write — neither is fixed. A budget
 * in TIME cannot be wrong about that: whatever each chunk turns out to cost,
 * the tick stops handing out more work once it has held the main process this
 * long, and the rest of the backlog waits for the next tick. It is a ceiling,
 * not a target; a drained mailbox never comes near it.
 */
export const TICK_BUDGET_MS = 2_000;

export interface HeaderBackfillState {
  remaining: number;
  done: number;
  running: boolean;
  drained: boolean;
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let stopped = false;
let doneThisSession = 0;
let lastRemaining = 0;
let lastDrained = false;
/** Consecutive ticks that wrote nothing while a backlog remained. */
let noProgressTicks = 0;

/**
 * Group a backlog slice into per-folder UID lists — one FETCH per folder.
 * Pure, so the batching is testable without a socket.
 */
export function groupByFolder<T extends { folderPath: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const byFolder = new Map<string, T[]>();
  for (const row of rows) {
    const list = byFolder.get(row.folderPath) ?? [];
    list.push(row);
    byFolder.set(row.folderPath, list);
  }
  return byFolder;
}

/** What one swept message writes back. Nulls are gaps this sweep could not fill. */
export interface HeaderStageRow {
  id: string;
  authStatus: string | null;
  spamScore: number | null;
  spamReasons: string | null;
  originIp: string | null;
}

/**
 * Turn one folder's fetch result into rows to write.
 *
 * A uid ABSENT from `fetched` was not returned by the server this time
 * (connection trouble, or the message was expunged) — it stays NULL and is
 * retried on a later tick, but only up to HEADER_STAGE_MAX_ATTEMPTS times:
 * `backfillAccount` counts the miss, and a row that runs out of tries leaves
 * the backlog still NULL. A uid PRESENT is a real answer, even when the server
 * recorded no authentication header at all: that becomes an all-unknown verdict
 * so the row leaves the backlog.
 *
 * Pure, so the whole mapping is testable without a socket — which matters more
 * here than it looks, because this is where a wrong answer becomes a permanent
 * one. The storage write is COALESCE-guarded and will not overwrite it.
 */
export function verdictRows(
  wanted: Array<{ id: string; uid: number; ownMail: boolean; knownSpammer: boolean }>,
  fetched: ReadonlyMap<number, IMAPMessage>,
): HeaderStageRow[] {
  const out: HeaderStageRow[] = [];
  for (const w of wanted) {
    const message = fetched.get(w.uid);
    if (!message) continue;
    const { spam, originIp } = headerStage(message, {
      knownSpammer: w.knownSpammer,
      ownMail: w.ownMail,
    });
    out.push({
      id: w.id,
      // NOT `headerStage`'s `auth`, and the difference is deliberate. That one
      // is null when the server recorded no verdict, which is what the SCORER
      // must see — and what ingest stores, leaving the column NULL. Here NULL
      // means "not checked yet", so storing it would put the row straight back
      // in the backlog to be fetched again forever. `parseAuthenticationHeaders`
      // turns the absent block into an all-unknown verdict instead: a real,
      // final answer that reads as Unverified for the right reason. The score
      // above is unaffected — it saw the null, exactly as ingest would have.
      authStatus: JSON.stringify(parseAuthenticationHeaders(message.authHeaders)),
      spamScore: spam ? spam.score : null,
      spamReasons: spam ? JSON.stringify(spam.reasons) : null,
      originIp,
    });
  }
  return out;
}

export function getHeaderBackfillState(): HeaderBackfillState {
  return { remaining: lastRemaining, done: doneThisSession, running: inFlight, drained: lastDrained };
}

function emitProgress(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('header-backfill:progress', getHeaderBackfillState());
}

/** Start the loop. Idempotent. Called from main.ts once storage + sync are wired. */
export function startHeaderBackfill(): void {
  if (timer) return;
  stopped = false;
  timer = setTimeout(runTick, FIRST_DELAY_MS);
  logger.info(`[HeaderBackfill] scheduled: first tick in ${FIRST_DELAY_MS / 1000}s`);
}

export function stopHeaderBackfill(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
    logger.info('[HeaderBackfill] stopped');
  }
}

/** Pull the next tick forward — the Security page's "Run now". No-op mid-tick. */
export function kickHeaderBackfill(): void {
  if (!timer || inFlight) return;
  clearTimeout(timer);
  timer = setTimeout(runTick, 250);
}

interface Target { storage: any; engine: any; label: string }

function connectedTargets(): Target[] {
  const targets: Target[] = [];
  const seen = new Set<unknown>();
  const active = getStorage() as any;
  const activeEngine = getSyncEngine() as any;
  if (active && activeEngine?.isConnected?.()) { targets.push({ storage: active, engine: activeEngine, label: 'active' }); seen.add(active); }
  for (const [accountId, rt] of getAllAccountRuntimes()) {
    if (rt.storage && !seen.has(rt.storage) && (rt.syncEngine as any)?.isConnected?.()) {
      targets.push({ storage: rt.storage, engine: rt.syncEngine, label: accountId });
      seen.add(rt.storage);
    }
  }
  return targets;
}

/**
 * The ids of this account's Sent and Drafts folders.
 *
 * Read fresh each tick rather than cached: a folder can be created, renamed or
 * newly marked \Sent between ticks, and a stale set here would let own mail
 * into the spam half of the backlog — where it can never be satisfied. One
 * folder-list read per account per tick is nothing beside the FETCH it guards.
 */
async function ownMailFolderIds(storage: any): Promise<string[]> {
  if (typeof storage.getFolders !== 'function') return [];
  const folders = (await storage.getFolders()) as Array<{ id: string; path: string; name?: string; specialUse?: string | null }>;
  return folders.filter((f) => isOwnMailFolder(f)).map((f) => f.id);
}

/** One account's tick: a few folders' worth of the backlog. Returns rows written. */
async function backfillAccount(t: Target): Promise<{ written: number; remaining: number; missed: number }> {
  const storage = t.storage;
  if (typeof storage.getEmailsMissingHeaderStage !== 'function' || typeof t.engine.fetchHeaderMessages !== 'function') {
    return { written: 0, remaining: 0, missed: 0 }; // older storage/engine — nothing to do here
  }
  const ownMail = await ownMailFolderIds(storage);
  const ownMailSet = new Set(ownMail);
  const slice = storage.getEmailsMissingHeaderStage(BATCH_SIZE * FOLDERS_PER_TICK, ownMail) as Array<{
    id: string; uid: number; folderPath: string; folderId: string;
  }>;
  if (slice.length === 0) return { written: 0, remaining: 0, missed: 0 };

  let written = 0;
  let missed = 0;
  let folders = 0;
  const deadline = Date.now() + TICK_BUDGET_MS;
  for (const [folderPath, wanted] of groupByFolder(slice)) {
    if (folders >= FOLDERS_PER_TICK || Date.now() >= deadline) break;
    folders += 1;
    for (let i = 0; i < wanted.length; i += BATCH_SIZE) {
      if (Date.now() >= deadline) break;
      const chunk = wanted.slice(i, i + BATCH_SIZE);
      const fetched: Map<number, IMAPMessage> = await t.engine.fetchHeaderMessages(folderPath, chunk.map((w) => w.uid));
      // A uid we asked for and did not get back is one attempt spent. Three of
      // them and the row leaves the backlog: without this an expunged message,
      // or a folder that will not open, is selected and re-fetched every 1.5
      // seconds for as long as the app runs, writing nothing and saying
      // nothing. The columns stay NULL, which is still the truth.
      const absent = chunk.filter((w) => !fetched.has(w.uid)).map((w) => w.id);
      if (absent.length > 0 && typeof storage.recordHeaderStageMiss === 'function') {
        storage.recordHeaderStageMiss(absent);
        missed += absent.length;
      }
      // The same lookup ingest does before scoring, so a sender the user has
      // reported scores here exactly as they would on arrival. One indexed
      // primary-key read per message; a failure is "unknown", never a failed row.
      const scored = await Promise.all(chunk.map(async (w) => ({
        ...w,
        ownMail: ownMailSet.has(w.folderId),
        knownSpammer: await isKnownSpammer(storage, fetched.get(w.uid)),
      })));
      const rows = verdictRows(scored, fetched);
      if (rows.length) written += storage.updateEmailHeaderStageBatch(rows);
    }
  }
  const remaining = storage.countEmailsMissingHeaderStage(ownMail) as number;
  return { written, remaining, missed };
}

/** Has the user reported this sender? Unknown (false) on any failure. */
async function isKnownSpammer(storage: any, message: IMAPMessage | undefined): Promise<boolean> {
  const fromAddress = message?.envelope?.from?.[0]?.address;
  if (!fromAddress || typeof storage.isSpammer !== 'function') return false;
  try {
    return (await storage.isSpammer(fromAddress)) === true;
  } catch {
    return false;
  }
}

async function runTick(): Promise<void> {
  if (stopped) return;
  if (inFlight) { timer = setTimeout(runTick, ACTIVE_INTERVAL_MS); return; }
  inFlight = true;
  let remaining = 0;
  let written = 0;
  let missed = 0;
  let sawWork = false;
  try {
    const targets = connectedTargets();
    if (targets.length === 0) {
      // Nothing connected YET is not "drained" — the backlog is still there,
      // we just cannot see it. Treating this as drained parked the loop on the
      // 30-minute idle sleep at cold start, so an account that connected ten
      // seconds later waited half an hour for its first verdict. Keep the
      // active cadence and re-check.
      remaining = lastRemaining;
      sawWork = true;
      return;
    }
    for (const t of targets) {
      try {
        if (isConnectionRecentlyUnstable(t.engine)) {
          // Pile-on avoidance: come back when the socket has settled. Count
          // the account as not drained so we return at the active cadence.
          sawWork = true;
          continue;
        }
        const r = await backfillAccount(t);
        written += r.written;
        remaining += r.remaining;
        missed += r.missed;
        if (r.remaining > 0) sawWork = true;
      } catch (e) {
        // One account's failure must never stop the others.
        logger.warn(`[HeaderBackfill] ${t.label}: tick failed (isolated): ${(e as Error).message}`);
        sawWork = true;
      }
    }
  } catch (err) {
    logger.error('[HeaderBackfill] tick failed:', err);
  } finally {
    inFlight = false;
    doneThisSession += written;
    lastRemaining = remaining;
    lastDrained = !sawWork && remaining === 0;
    if (written > 0 || lastDrained) {
      logger.info(`[HeaderBackfill] wrote ${written} verdict(s); ${remaining} remaining${lastDrained ? ' — drained' : ''}`);
      noProgressTicks = 0;
    } else if (remaining > 0) {
      // A tick that wrote nothing used to log nothing at all, so a backlog
      // that could not be satisfied spun silently at the active cadence for as
      // long as the app ran — the exact state that hid a 12.7% main-process
      // CPU cost until someone profiled it. Throttled, because the point is a
      // trail, not a flood.
      noProgressTicks += 1;
      if (noProgressTicks === 1 || noProgressTicks % 20 === 0) {
        logger.warn(
          `[HeaderBackfill] no progress on ${noProgressTicks} consecutive tick(s); ${remaining} remaining, `
          + `${missed} message(s) the server did not return this tick (a row is retired after ${HEADER_STAGE_MAX_ATTEMPTS} tries)`,
        );
      }
    }
    emitProgress();
    if (!stopped) timer = setTimeout(runTick, lastDrained ? IDLE_INTERVAL_MS : ACTIVE_INTERVAL_MS);
  }
}
