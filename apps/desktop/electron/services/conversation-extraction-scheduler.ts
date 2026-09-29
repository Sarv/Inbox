/**
 * Background nomination for the chat view's first-email split.
 *
 * The AI split runs in the renderer (it needs the DOM and the renderer's
 * provider config), so main's part is to NOMINATE: every 45 s (the first pass
 * 10 s after launch), for EVERY open account, it asks that account's database
 * for recent threads whose first email has no current split
 * (`listFirstSplitCandidates`: no row, an older split version, a transient
 * failure whose retry time has come, or a first email that changed), keeps the
 * ones that look like a reply or a forward, and sends at most
 * {@link REFS_PER_ACCOUNT} of them per account to the renderer on
 * `conversation:first-split-candidates`. The renderer's job re-checks each one
 * precisely (the first email's quote count, AI settings, AI health) and either
 * splits it, records it as `skipped`, or leaves it.
 *
 * The evidence filter runs INSIDE the scan (its `accept`), so threads that
 * will never be nominated take no scan slot; and each one the scan meets is
 * retired on the spot — stored as `skipped` under its current key
 * (`skipFirstSplits`) — so it leaves the candidate set instead of being
 * re-read every pass. Without both, the ~100 newest newsletters and
 * notifications in the window filled every slot for ever and an older
 * looped-in forward was never reached.
 *
 * Nothing runs unless the renderer has said BOTH that a provider is configured
 * and that the background split is switched on (conversation mode and 'Auto
 * Chat Extract'): with either off the renderer would drop every ref anyway, and
 * a ref sent then would sit out a cool-down it did not need once the user
 * switches it back on.
 *
 * Every ref carries its account id: the same thread id exists in every
 * account's database, and the renderer's IPC for this cache never falls back
 * to the active account.
 *
 * Kept under its old file and export names (main.ts and the AI IPC import
 * them); the old whole-thread extraction batch it used to send is gone.
 */

import {
  FIRST_SPLIT_MAX_ATTEMPTS,
  FIRST_SPLIT_VERSION,
  createLogger,
  hasReplyPrefix,
} from '@sarvinbox/core';
import type { FirstSplitCandidate } from '@sarvinbox/storage-node';

import { getAllAccountRuntimes, getMainWindow } from '../shared';

const logger = createLogger('FirstSplitScheduler');

let schedulerInterval: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let aiProviderConfigured = false;
let backgroundSplitEnabled = false;

const INTERVAL_MS = 45_000; // 45 seconds
const INITIAL_DELAY_MS = 10_000; // 10 seconds after startup

/** The IPC channel the renderer's first-split job listens on. */
export const FIRST_SPLIT_CANDIDATES_CHANNEL = 'conversation:first-split-candidates';
/** Only threads with a message in the last 30 days are looked at. */
export const CANDIDATE_WINDOW_SECONDS = 30 * 24 * 60 * 60;
/** At most this many refs per account per pass — the renderer splits one at a time. */
export const REFS_PER_ACCOUNT = 5;
/**
 * How many candidates one account's scan returns (newest first). Only threads
 * the pass could send count (reply/forward evidence, not cooling down). The
 * scan examines at most ten times this many threads, which also bounds how
 * many threads without evidence one pass retires: 200 per account per pass
 * (each one a membership read, a body fingerprint and a row write, on the main
 * thread) — a 30-day backlog drains over a few passes, and after that only new
 * mail is left to look at.
 */
export const CANDIDATE_SCAN_LIMIT = 20;
/**
 * A thread sent on one pass is not sent again for this long. The renderer
 * writes nothing for a thread it cannot decide yet (its first email's body has
 * not arrived) or may not run (the session guard, an IPC error), and such a
 * thread stays a candidate. Without the cool-down, the same newest five would
 * be nominated every pass and every older thread behind them would starve.
 */
export const NOMINATION_COOLDOWN_MS = 10 * 60 * 1000;

/** When each `${accountId}|${threadId}` was last nominated (epoch ms). */
const lastNominated = new Map<string, number>();

/**
 * Does the first email look like a reply or a forward — the only mail that
 * can carry a looped-in history? In-Reply-To or References, or a reply /
 * forward prefix on its subject ('Re:', 'Fwd:', 'AW:', …, core
 * `hasReplyPrefix`). Everything else is never nominated: the pass retires it
 * (a `skipped` row), so an on-open run is still possible.
 */
export function hasReplyEvidence(candidate: Pick<FirstSplitCandidate, 'subject' | 'inReplyTo' | 'references'>): boolean {
  return !!candidate.inReplyTo?.trim()
    || !!candidate.references?.trim()
    || hasReplyPrefix(candidate.subject);
}

/** One pass: nominate each open account's candidates, retire the rest. Never throws. */
async function nominateCandidates(): Promise<void> {
  if (!aiProviderConfigured || !backgroundSplitEnabled) return;
  const mainWindow = getMainWindow();
  if (!mainWindow) return;

  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  // Forget cool-downs that have run out, so the map holds one pass window at most.
  for (const [key, at] of lastNominated) {
    if (nowMs - at >= NOMINATION_COOLDOWN_MS) lastNominated.delete(key);
  }

  let nominated = 0;
  let retired = 0;
  let accounts = 0;
  for (const [accountId, runtime] of getAllAccountRuntimes()) {
    // One account's database throwing (closed mid-switch, locked, corrupt)
    // must not stop the others from being nominated.
    try {
      const storage = runtime.storage!;
      // Threads the scan meets that can never be nominated (no reply/forward
      // evidence): collected by `accept`, retired below.
      const noEvidence: string[] = [];
      const candidates = storage.listFirstSplitCandidates({
        since: now - CANDIDATE_WINDOW_SECONDS,
        scanLimit: CANDIDATE_SCAN_LIMIT,
        version: FIRST_SPLIT_VERSION,
        now,
        maxAttempts: FIRST_SPLIT_MAX_ATTEMPTS,
        accept: (candidate) => {
          if (!hasReplyEvidence(candidate)) {
            noEvidence.push(candidate.threadId);
            return false;
          }
          return !lastNominated.has(`${accountId}|${candidate.threadId}`);
        },
      });
      const refs = candidates
        .slice(0, REFS_PER_ACCOUNT)
        .map((candidate) => ({ accountId, threadId: candidate.threadId }));
      if (refs.length > 0) {
        mainWindow.webContents.send(FIRST_SPLIT_CANDIDATES_CHANNEL, { refs });
        for (const ref of refs) lastNominated.set(`${ref.accountId}|${ref.threadId}`, nowMs);
        nominated += refs.length;
        accounts += 1;
      }
      // After the send: a retire that fails (locked database) must not cost
      // this pass its nominations. What it did not write is met, and retired,
      // again next pass.
      if (noEvidence.length > 0) retired += storage.skipFirstSplits(noEvidence, now);
    } catch (error) {
      logger.warn(`nominate acct=${accountId} failed: ${(error as Error)?.message ?? error}`);
    }
  }
  // The renderer re-nominates nothing it acted on, but a thread it cannot
  // decide yet comes back every cool-down, and new non-reply mail is retired
  // every pass — so this is trace, not info. The renderer's job logs what it
  // actually did (split / skipped / failed).
  if (nominated > 0 || retired > 0) {
    logger.trace(`nominated ${nominated} thread(s) across ${accounts} account(s), retired ${retired} without reply evidence`);
  }
}

/**
 * Start the scheduler
 */
export function startConversationScheduler(): void {
  if (schedulerInterval) return;

  logger.info('Starting (45s interval)');

  // First tick after initial delay (tracked so stop() can cancel it —
  // otherwise it fires after storage close on a fast quit)
  initialTimer = setTimeout(() => {
    initialTimer = null;
    nominateCandidates().catch(() => {});
  }, INITIAL_DELAY_MS);

  // Regular interval
  schedulerInterval = setInterval(() => {
    nominateCandidates().catch(() => {});
  }, INTERVAL_MS);
}

/**
 * Stop the scheduler
 */
export function stopConversationScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('Stopped');
  }
  lastNominated.clear();
}

/**
 * Set whether an AI provider is configured (called from renderer via IPC)
 */
export function setAIProviderConfigured(configured: boolean): void {
  aiProviderConfigured = configured;
  logger.info(`AI provider configured: ${configured}`);
}

/**
 * Set whether the background first-email split is switched on — conversation
 * mode AND 'Auto Chat Extract' (called from the renderer via IPC, on startup
 * and on every toggle). While it is off no pass scans or nominates. Switching
 * it on forgets every cool-down, so nothing waits out one earned before.
 */
export function setBackgroundSplitEnabled(enabled: boolean): void {
  if (enabled && !backgroundSplitEnabled) lastNominated.clear();
  backgroundSplitEnabled = enabled;
  logger.info(`Background first-email split: ${enabled ? 'on' : 'off'}`);
}
