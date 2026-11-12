// Bounded, windowed incremental new-message fetch.
//
// Why this exists: the incremental "get mail newer than lastUid" step used to
// issue ONE unbounded `UID FETCH lastUid+1:*`. On a LARGE mailbox (tens of
// thousands of messages) or a slow server that single command routinely blew the
// 60s per-op timeout — the socket got recycled and the SAME unbounded fetch was
// retried on the next cycle, forever. New mail then only landed on the rare cycle
// the fetch happened to finish under 60s (observed: hours of "IMAP FETCH timed
// out — recycling the wedged connection" with the occasional "Added N new").
//
// The fix is the same discipline the historical backfill already uses: page the
// range `[sinceUid+1 .. uidNext-1]` in bounded UID windows via
// `fetchMessagesByUidRange`, so every FETCH is small enough to complete. This is
// the shared source used by BOTH the realtime IDLE path and the folder-syncer
// incremental path — never duplicate the windowing.

import type { FetchOptions, IIMAPClient, IMAPMessage } from '../types/imap';
import { logger } from '../utils/logger';

// ── Pacing ──────────────────────────────────────────────────────────────────
//
// A fixed window answers "how many UIDs" but the thing that decides whether a
// FETCH completes is how long THIS server takes per message, and that is not a
// constant: imap.sarv.com served about one header a second on 2026-11-12, ten
// times slower than three weeks earlier. At that pace no 500-UID window can
// finish, so every pass timed out, kept nothing and retried the same window —
// an INBOX only ~490 messages behind showed no new mail for days.
//
// So the size of each FETCH follows the time the previous one took, a pass
// stops when its time budget is spent, and whatever arrived before a failure is
// kept. A slow server then means "new mail trickles in", never "no mail at all".

/** How long one paced FETCH should take. Short enough to leave most of a pass's
 *  budget for further windows, long enough that a fast server still batches. */
export const FETCH_TARGET_MS = 10_000;
/** First paced window when nothing is known about the server yet. The usual
 *  "a handful of new messages" gap still fits in one round-trip. */
export const PACED_INITIAL_WINDOW = 64;
/** Smallest paced fetch. Below this the per-command overhead dominates. */
export const PACED_MIN_WINDOW = 8;
/** How long one new-mail pass (periodic sync or an IDLE wake-up) may spend
 *  fetching before it hands back what it has. Sized to stay well inside the
 *  sync's stuck timeout on a server too slow to read the whole gap in one pass. */
export const NEW_MAIL_FETCH_BUDGET_MS = 45_000;

/**
 * What a caller remembers between passes about one folder on one account: the
 * fetch size this server last handled in reasonable time. Owned by the caller
 * (one per folder), mutated by the helpers. In memory only — after a restart
 * the first pass simply measures again.
 */
export interface FetchPace {
  size: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * The size to try after a fetch of `size` took `elapsedMs`: scaled toward
 * FETCH_TARGET_MS, by at most 4x in either direction so one odd reading (a
 * window that happened to be empty, a single huge message) cannot swing it.
 */
export function nextFetchSize(size: number, elapsedMs: number, bounds: { min: number; max: number }): number {
  const ratio = FETCH_TARGET_MS / Math.max(1, elapsedMs);
  return clamp(Math.round(size * clamp(ratio, 0.25, 4)), bounds.min, bounds.max);
}

/** The size to try after a fetch of `size` FAILED (timed out, connection lost). */
export function fetchSizeAfterFailure(size: number, min: number): number {
  return Math.max(min, Math.floor(size / 4));
}

/** Default UID span per bounded FETCH. Small enough that even a LARGE/slow
 *  mailbox returns one window well under the 60s per-op timeout, large enough
 *  that the common "a handful of new messages" case is still a single round-trip. */
export const NEW_MESSAGE_WINDOW = 500;

export interface WindowedFetchOptions {
  /** UID span per FETCH. Defaults to NEW_MESSAGE_WINDOW. */
  windowSize?: number;
  /** Stop after roughly this many messages have been collected, so a huge gap
   *  can't make a single call unbounded in time/memory — the caller advances
   *  lastSyncUid over what was fetched and the next cycle continues the drain.
   *  Undefined = drain the whole range. */
  maxMessages?: number;
  /**
   * Pace the windows to this server's speed instead of using a fixed span. The
   * span starts at `pace.size` (PACED_INITIAL_WINDOW for a fresh pace), follows
   * the time each window took, never exceeds `windowSize`, and is written back
   * so the caller's next pass starts where this one ended.
   */
  pace?: FetchPace;
  /** Stop starting new windows once this much time has passed. The pass returns
   *  what it has; the rest is the next pass's (and the background drain's) work. */
  budgetMs?: number;
  /** Clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

/** A fresh pace for a folder nothing has been measured on yet. */
export function newFetchPace(size = PACED_INITIAL_WINDOW): FetchPace {
  return { size };
}

/** The pace kept for `key` in `paces`, created on first use. */
export function fetchPaceFor(paces: Map<string, FetchPace>, key: string, initialSize?: number): FetchPace {
  let pace = paces.get(key);
  if (!pace) {
    pace = newFetchPace(initialSize);
    paces.set(key, pace);
  }
  return pace;
}

/**
 * Shared window loop state for both directions: the span to use next, the
 * budget check, and what to do when a window fails.
 */
function createWindowRun(windowOptions: WindowedFetchOptions | undefined) {
  const max = Math.max(1, windowOptions?.windowSize ?? NEW_MESSAGE_WINDOW);
  const pace = windowOptions?.pace;
  const min = Math.min(PACED_MIN_WINDOW, max);
  const now = windowOptions?.now ?? Date.now;
  const started = now();
  return {
    /** UID span of the next window. Fixed at `max` unless the caller paces. */
    span: (): number => (pace ? clamp(Math.round(pace.size), min, max) : max),
    /** Record a window that completed; returns false when the budget is spent. */
    completed(span: number, windowStarted: number): boolean {
      if (pace) pace.size = nextFetchSize(span, now() - windowStarted, { min, max });
      return windowOptions?.budgetMs === undefined || now() - started < windowOptions.budgetMs;
    },
    /** Record a window that failed, so the next pass asks for less. */
    failed(span: number): void {
      if (pace) pace.size = fetchSizeAfterFailure(span, min);
    },
    now,
  };
}

/**
 * A window failed after earlier ones succeeded. Keep what arrived: throwing
 * here used to discard every message already fetched in this pass, which is
 * how a slow server became "no new mail at all".
 */
function keepPartial(collected: number, error: unknown): void {
  logger.warn(`New-mail fetch stopped early with ${collected} message(s) kept: ${(error as Error)?.message ?? error}`);
}

/**
 * Fetch messages with UID strictly greater than `sinceUid`, up to (and including)
 * `uidNext - 1`, in bounded UID windows. Returns them in ascending UID order.
 *
 * - Never issues an unbounded `:*` fetch.
 * - Filters out UID <= sinceUid defensively (some servers echo the boundary
 *   message for an out-of-range low bound), so lastSyncUid can never regress.
 * - Falls back to the (unbounded) `getNewMessages` only when the client can't do
 *   bounded ranges (`fetchMessagesByUidRange` is optional on IIMAPClient) — a
 *   correctness floor for minimal fakes, not the hot path.
 */
export async function fetchNewMessagesWindowed(
  client: IIMAPClient,
  sinceUid: number,
  uidNext: number,
  options?: FetchOptions,
  windowOptions?: WindowedFetchOptions,
): Promise<IMAPMessage[]> {
  const hiEnd = uidNext - 1; // highest UID that can currently exist
  if (hiEnd <= sinceUid) return []; // nothing newer than what we already have

  // Client without bounded-range support: fall back to the legacy unbounded
  // fetch so behaviour is preserved for impls/fakes that only implement the
  // minimal interface. Still filter the boundary echo.
  if (typeof client.fetchMessagesByUidRange !== 'function') {
    const msgs = await client.getNewMessages(sinceUid, options);
    return msgs.filter((m) => m.uid > sinceUid);
  }

  const run = createWindowRun(windowOptions);
  const maxMessages = windowOptions?.maxMessages;
  const collected: IMAPMessage[] = [];

  for (let lo = sinceUid + 1; lo <= hiEnd;) {
    const span = run.span();
    const hi = Math.min(lo + span - 1, hiEnd);
    const windowStarted = run.now();
    let window: IMAPMessage[];
    try {
      window = await client.fetchMessagesByUidRange(lo, hi, options);
    } catch (error) {
      run.failed(span);
      // Ascending windows are contiguous from the watermark, so what was
      // collected is a complete prefix the caller can safely advance over.
      if (collected.length === 0) throw error;
      keepPartial(collected.length, error);
      break;
    }
    for (const m of window) {
      if (m.uid > sinceUid) collected.push(m);
    }
    lo = hi + 1;
    const withinBudget = run.completed(span, windowStarted);
    if (maxMessages !== undefined && collected.length >= maxMessages) break;
    if (!withinBudget) break;
  }

  // Ascending by UID — callers that want newest-first reverse it themselves.
  collected.sort((a, b) => a.uid - b.uid);
  return collected;
}

/** What a newest-first pass fetched, plus how far down it actually looked. */
export interface NewestFirstFetch {
  /** Messages with UID > sinceUid, ascending by UID (callers reverse themselves). */
  messages: IMAPMessage[];
  /**
   * Lowest UID this pass scanned. `<= sinceUid + 1` means the whole range was
   * covered, so the caller may advance its contiguous watermark. Anything higher
   * means the pass stopped early (on `maxMessages`, on its time budget, or on a
   * window that failed after others succeeded) and a HOLE remains below —
   * advancing the watermark past it would skip that mail from incremental sync
   * forever.
   */
  scannedDownToUid: number;
}

/**
 * Like `fetchNewMessagesWindowed`, but walks the windows DOWNWARD from the
 * newest UID so the most recent mail arrives on the FIRST call.
 *
 * Why this exists: the ascending version has to traverse the entire gap before
 * the caller sees today's mail. On an account whose watermark has fallen far
 * behind (observed: INBOX pinned at UID 3226 while the server was at uidNext
 * 27709 -- a 24,482-UID gap) that traversal cannot finish inside the 120s sync
 * timeout, so the sync was torn down, the watermark never advanced, and the next
 * cycle restarted from the same place. The mailbox drained steadily from the
 * OLDEST end while the newest month of mail never appeared at all.
 *
 * Fetching newest-first fixes the symptom the user actually sees; the hole left
 * underneath is filled by SyncEngine.drainFolderChunk, which computes its work as
 * `serverUids - localUids` and so is unaffected by the watermark. That is why
 * this reports `scannedDownToUid`: the caller must NOT advance `lastSyncUid` over
 * a hole just because it holds a newer message.
 */
export async function fetchNewestMessagesWindowed(
  client: IIMAPClient,
  sinceUid: number,
  uidNext: number,
  options?: FetchOptions,
  windowOptions?: WindowedFetchOptions,
): Promise<NewestFirstFetch> {
  const hiEnd = uidNext - 1; // highest UID that can currently exist
  if (hiEnd <= sinceUid) return { messages: [], scannedDownToUid: sinceUid + 1 };

  // No bounded-range support: same correctness floor as the ascending version.
  // The unbounded fetch covers the whole range, so nothing is left behind.
  if (typeof client.fetchMessagesByUidRange !== 'function') {
    const msgs = await client.getNewMessages(sinceUid, options);
    return {
      messages: msgs.filter((m) => m.uid > sinceUid).sort((a, b) => a.uid - b.uid),
      scannedDownToUid: sinceUid + 1,
    };
  }

  const run = createWindowRun(windowOptions);
  const maxMessages = windowOptions?.maxMessages;
  const collected: IMAPMessage[] = [];
  let scannedDownToUid = hiEnd + 1;

  for (let hi = hiEnd; hi > sinceUid;) {
    const span = run.span();
    const lo = Math.max(sinceUid + 1, hi - span + 1);
    const windowStarted = run.now();
    let window: IMAPMessage[];
    try {
      window = await client.fetchMessagesByUidRange(lo, hi, options);
    } catch (error) {
      run.failed(span);
      // Nothing scanned yet: an honest failure, and the next pass asks for
      // less. Otherwise the newest mail already fetched is kept and
      // `scannedDownToUid` tells the caller a hole remains below it.
      if (scannedDownToUid > hiEnd) throw error;
      keepPartial(collected.length, error);
      break;
    }
    for (const m of window) {
      if (m.uid > sinceUid) collected.push(m);
    }
    scannedDownToUid = lo;
    hi = lo - 1;
    const withinBudget = run.completed(span, windowStarted);
    if (maxMessages !== undefined && collected.length >= maxMessages) break;
    if (!withinBudget) break;
  }

  collected.sort((a, b) => a.uid - b.uid);
  return { messages: collected, scannedDownToUid };
}
