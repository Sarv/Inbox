/**
 * How far back the BACKGROUND AI pipeline is allowed to reach.
 *
 * The poll auto-categorizes only the newest N emails by date. New mail is
 * always inside that window, so it is handled in real time; a large historical
 * backlog is deliberately left alone rather than spending LLM calls on it
 * unattended.
 *
 * N used to be a hardcoded 500 whose own comment claimed it "mirrors the manual
 * bulk cap (maxAIProcessingEmails, default 500)" — but that setting lives in the
 * renderer's localStorage and appeared nowhere else in the main process. So a
 * user who raised "AI Processing Limit" to All watched nothing happen: 252
 * emails sat fully eligible (pending, unread, body downloaded, extraction done)
 * and every one of them fell outside a window their setting could not move.
 *
 * Persisted in the core DB rather than held in memory for the same reason
 * pipeline-ai-config is: the renderer pushes it, and a main-process restart
 * without a re-push would silently drop the user back to the default. Stored in
 * plain JSON — a window size is not a secret.
 */
import { createLogger } from '@sarvinbox/core';

import { getBlob, setBlob } from './core-db';

const logger = createLogger('ai-backlog-cap');

const BLOB_KEY = 'ai-backlog-cap';

/** Matches defaultSettings.maxAIProcessingEmails in the renderer. */
export const DEFAULT_BACKLOG_CAP = 500;

/**
 * Upper bound. The settings UI tops out at "All (10,000+)", and a window is an
 * `ORDER BY date DESC LIMIT n` subquery — letting it grow without limit would
 * turn every poll tick into a full-table scan on a large mailbox.
 */
export const MAX_BACKLOG_CAP = 100_000;

let cached: number | null = null;

/**
 * Clamp whatever arrives into a usable window size.
 *
 * Zero is the dangerous input and the reason this is a named, tested function:
 * `getEmailsPendingAgent` treats `recentWindow <= 0` as "no window at all", so a
 * cap that fell through as 0 would silently switch the background pipeline from
 * "newest 500" to "the entire mailbox, unattended". A bad value must fail back
 * to the default, never to unbounded.
 */
export function normalizeBacklogCap(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BACKLOG_CAP;
  return Math.min(Math.floor(n), MAX_BACKLOG_CAP);
}

/** The current window size. Cached — this is read on the poll's hot path. */
export function getAutoBacklogCap(): number {
  if (cached !== null) return cached;
  try {
    const raw = getBlob(BLOB_KEY);
    cached = raw ? normalizeBacklogCap(JSON.parse(raw.toString('utf8'))?.cap) : DEFAULT_BACKLOG_CAP;
  } catch (e) {
    // An unreadable value must not take the pipeline down with it.
    logger.warn('[AIBacklogCap] could not read stored cap, using default:', (e as Error).message);
    cached = DEFAULT_BACKLOG_CAP;
  }
  return cached;
}

/** Persist a new window size. Returns the value actually stored. */
export function setAutoBacklogCap(value: unknown): number {
  const cap = normalizeBacklogCap(value);
  const previous = cached;
  cached = cap;
  try {
    setBlob(BLOB_KEY, Buffer.from(JSON.stringify({ cap }), 'utf8'));
    if (previous !== cap) logger.info(`[AIBacklogCap] background AI window set to newest ${cap}`);
  } catch (e) {
    logger.warn('[AIBacklogCap] could not persist cap:', (e as Error).message);
  }
  return cap;
}

/** Drop the cache so the next read hits storage. For tests and re-init. */
export function resetBacklogCapCache(): void {
  cached = null;
}
