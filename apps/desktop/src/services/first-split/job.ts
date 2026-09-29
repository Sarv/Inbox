/**
 * The background first-email split: main nominates threads, this job re-checks
 * each one precisely and splits the ones that qualify — one LLM call at a
 * time.
 *
 * Main's scheduler (conversation-extraction-scheduler) nominates, per account,
 * recent threads that show reply/forward evidence and have no current split;
 * it cannot run the AI (the provider config and the DOM live here). For each
 * nominated thread this job asks main for the thread's current key and first
 * member, then:
 *
 *   * the first email's body is not here yet (`unknown`) → nothing: the thread
 *     is nominated again later, when it may have arrived;
 *   * a usable split, a transient failure still backing off, or a permanent
 *     failure → nothing;
 *   * it quotes two or more earlier messages (`auto`) → split it;
 *   * anything else (0 or 1 quotes, designed bulk mail) → store `skipped` with
 *     its quote count, WITHOUT an LLM call, so it is not nominated again.
 *
 * Gated on conversation mode, 'Auto Chat Extract', a configured provider and
 * AI health — once per nomination (refs arriving while any is off are dropped
 * unqueued; the scheduler nominates again on its next pass) and again per
 * item, for a switch flipped mid-drain. Refs are deduped (per account
 * and thread) into one queue, capped, and drained serially.
 */
import {
  firstSplitStateFor,
  type FirstSplitGetResult,
} from '@sarvinbox/core/first-split';
import { createLogger } from '@sarvinbox/core/logger';

import { aiEligibilityFor, firstEmailFacts } from '../../components/email-detail/ai-view-compose';
import { isBackgroundSplitEnabled, syncBackgroundSplitToMain } from '../ai-features';
import { getAIHealth, getDefaultProvider } from '../ai-service';

import { nowSeconds } from './split-first-email';
import {
  defaultFirstSplitBridge,
  firstSplitKeyOf,
  providerSignatureOf,
  runFirstSplit,
  type FirstSplitBridge,
  type FirstSplitRef,
  type FirstSplitRunResult,
  type FirstSplitStoreDeps,
} from './store';

const log = createLogger('FirstSplitJob');

/** Most refs waiting at once; beyond it new refs are dropped (the scheduler nominates again). */
export const MAX_QUEUED_REFS = 500;

/** Main's nomination event payload (`conversation:first-split-candidates`). */
export interface FirstSplitCandidates {
  refs: FirstSplitRef[];
}

/** Where nominations come from: the preload bridge's listener pair. */
export interface FirstSplitCandidateSource {
  on(listener: (payload: FirstSplitCandidates) => void): void;
  off(): void;
}

export interface FirstSplitJobDeps extends FirstSplitStoreDeps {
  bridge?: FirstSplitBridge;
  /** May background AI run right now? Defaults to the settings, the provider and AI health. */
  gate?: () => boolean;
  /** Unix seconds, for the retry-time comparison. */
  now?: () => number;
  run?: typeof runFirstSplit;
}

/** The default gate: every switch the background split depends on. */
export function backgroundSplitAllowed(): boolean {
  return isBackgroundSplitEnabled()
    && !!getDefaultProvider()
    && getAIHealth().healthy;
}

/**
 * What happened to one ref: `split` (a split was stored), `failed` (a run
 * ended in a failure, recorded for retry or for good), `skipped` (ineligible,
 * recorded), `cached` (already split), `waiting` (backing off, failed for good,
 * or held by a provider problem), `guarded` (the session guard: this key's
 * automatic runs keep persisting nothing — a stale save, a save error — so it
 * is not run again this session), `unknown` (no body yet), `gated`
 * (background AI is off), `error` (IPC).
 */
export type JobItemResult =
  | 'gated' | 'unknown' | 'error' | 'cached' | 'waiting' | 'guarded' | 'skipped' | 'split' | 'failed';

function isRef(value: unknown): value is FirstSplitRef {
  const ref = value as Partial<FirstSplitRef> | null;
  return !!ref && typeof ref.accountId === 'string' && ref.accountId !== ''
    && typeof ref.threadId === 'string' && ref.threadId !== '';
}

/** Re-check one nominated thread and act on it (see the module comment). */
export async function processCandidate(ref: FirstSplitRef, deps: FirstSplitJobDeps = {}): Promise<JobItemResult> {
  if (!(deps.gate ?? backgroundSplitAllowed)()) return 'gated';
  const bridge = deps.bridge ?? defaultFirstSplitBridge;
  const answer = await bridge.get(ref.accountId, ref.threadId, { withSource: true });
  if (!answer.success || !answer.data) {
    log.trace(`thread acct=${ref.accountId} thread=${ref.threadId} get failed`);
    return 'error';
  }
  const got: FirstSplitGetResult = answer.data;
  const { current, source } = got;
  if (!current || !source || !(source.rawBody ?? '').trim()) return 'unknown';

  const state = firstSplitStateFor(
    got.row,
    current,
    (deps.now ?? nowSeconds)(),
    providerSignatureOf((deps.provider ?? getDefaultProvider)()),
  );
  if (state === 'usable') return 'cached';
  if (state === 'retry-later' || state === 'failed') return 'waiting';

  const facts = firstEmailFacts(source, current.distinctSenders);
  const eligibility = aiEligibilityFor(facts);
  if (eligibility === 'unknown') return 'unknown';
  if (eligibility !== 'auto') {
    // Recorded once per key, so the thread is not nominated again.
    if (state === 'skipped') return 'skipped';
    const saved = await bridge.save(ref.accountId, {
      key: firstSplitKeyOf(current),
      status: 'skipped',
      quoteCount: facts.kind === 'known' ? facts.quoteCount : null,
    });
    return saved.success ? 'skipped' : 'error';
  }

  const result: FirstSplitRunResult = await (deps.run ?? runFirstSplit)(
    ref,
    { trigger: 'background', prefetched: got },
    deps,
  );
  if (result.state === 'error') return 'error';
  if (result.state === 'usable') return 'cached';
  if (result.state === 'guarded') return 'guarded';
  if (result.state !== 'saved') return 'waiting';
  return result.outcome.status === 'ok' || result.outcome.status === 'partial' ? 'split' : 'failed';
}

/** The job's queue and its one worker. */
export interface FirstSplitJob {
  /** Queue refs (deduped, capped) and make sure the worker is draining. */
  enqueue(refs: readonly unknown[]): void;
  /** Resolves when the queue is empty and nothing is running. Tests / shutdown. */
  idle(): Promise<void>;
  /** Refs waiting, not counting the one in progress. */
  readonly size: number;
}

/** Build a job (the module-level one below is what the app uses). */
export function createFirstSplitJob(deps: FirstSplitJobDeps = {}): FirstSplitJob {
  const queue: FirstSplitRef[] = [];
  const known = new Set<string>();
  let draining: Promise<void> | null = null;

  const drain = async () => {
    const tally: Record<JobItemResult, number> = {
      gated: 0, unknown: 0, error: 0, cached: 0, waiting: 0, guarded: 0, skipped: 0, split: 0, failed: 0,
    };
    let processed = 0;
    while (queue.length > 0) {
      const ref = queue.shift()!;
      let result: JobItemResult;
      try {
        result = await processCandidate(ref, deps);
      } catch (error) {
        log.trace(`thread acct=${ref.accountId} thread=${ref.threadId} threw: ${(error as Error)?.message ?? error}`);
        result = 'error';
      } finally {
        known.delete(`${ref.accountId}|${ref.threadId}`);
      }
      tally[result] += 1;
      processed += 1;
      log.trace(`thread acct=${ref.accountId} thread=${ref.threadId} -> ${result}`);
    }
    // Only drained with at least one ref, so at least one count is non-zero.
    const counts = (Object.keys(tally) as JobItemResult[])
      .filter((key) => tally[key] > 0)
      .map((key) => `${key}=${tally[key]}`)
      .join(' ');
    // The scheduler re-nominates every pass (45 s, per account), so a batch
    // that did nothing — gated, no body yet, cached, backing off — would
    // write the same line to app.log all day. Only a batch that acted, or
    // hit an error, is worth an info line.
    const acted = tally.split + tally.failed + tally.skipped + tally.error > 0;
    if (acted) log.info(`batch refs=${processed} ${counts}`);
    else log.trace(`batch refs=${processed} ${counts}`);
  };

  const ensureDraining = () => {
    if (draining) return;
    draining = drain().finally(() => {
      draining = null;
      // Refs that arrived after the loop's last check.
      if (queue.length > 0) ensureDraining();
    });
  };

  return {
    enqueue(refs) {
      // Background AI off (a toggle, no provider, AI unhealthy): drop the
      // nomination whole, before any queueing or IPC. The scheduler
      // nominates again on its next pass; processCandidate still re-checks
      // per item, for a switch flipped mid-drain.
      if (!(deps.gate ?? backgroundSplitAllowed)()) {
        log.trace(`gated: dropped ${refs.length} ref(s)`);
        return;
      }
      let dropped = 0;
      for (const ref of refs) {
        if (!isRef(ref)) continue;
        const key = `${ref.accountId}|${ref.threadId}`;
        if (known.has(key)) continue;
        if (queue.length >= MAX_QUEUED_REFS) {
          dropped += 1;
          continue;
        }
        known.add(key);
        queue.push({ accountId: ref.accountId, threadId: ref.threadId });
      }
      if (dropped > 0) log.warn(`queue full (${MAX_QUEUED_REFS}): dropped ${dropped} ref(s)`);
      if (queue.length > 0) ensureDraining();
    },
    async idle() {
      while (draining) await draining;
    },
    get size() {
      return queue.length;
    },
  };
}

let active: { job: FirstSplitJob; source: FirstSplitCandidateSource } | null = null;

/**
 * Start listening for nominations. Idempotent: a second call while listening
 * does nothing (a duplicate listener would double every AI call).
 */
export function initializeFirstSplitJob(source: FirstSplitCandidateSource, deps: FirstSplitJobDeps = {}): FirstSplitJob {
  if (active) return active.job;
  const job = createFirstSplitJob(deps);
  source.on((payload) => job.enqueue(Array.isArray(payload?.refs) ? payload.refs : []));
  active = { job, source };
  return job;
}

/** Stop listening. Refs already queued finish; none are accepted after. */
export function removeFirstSplitJob(): void {
  if (!active) return;
  active.source.off();
  active = null;
}

/**
 * The preload's nomination channel as a {@link FirstSplitCandidateSource}, or
 * null where there is no bridge (outside Electron, or a preload without it).
 */
export function ipcCandidateSource(): FirstSplitCandidateSource | null {
  // `globalThis.window`: undefined (not a ReferenceError) where there is no DOM.
  const ai = (globalThis as { window?: Window }).window?.electronAPI?.ai;
  if (!ai?.onFirstSplitCandidates || !ai.removeFirstSplitCandidatesListener) return null;
  return {
    on: (listener) => ai.onFirstSplitCandidates(listener),
    off: () => ai.removeFirstSplitCandidatesListener(),
  };
}

/**
 * The app's wiring (App.tsx, once on mount): listen to main's nominations
 * through the preload, and tell main's scheduler whether the background split
 * is switched on (it neither scans nor nominates while it is off; the settings
 * tab pushes every later toggle). Idempotent like
 * {@link initializeFirstSplitJob}; pair with {@link removeFirstSplitJob} on
 * unmount. A no-op without a bridge — main then stays off.
 */
export function startFirstSplitJob(): void {
  const source = ipcCandidateSource();
  if (!source) {
    log.warn('no nomination bridge — background first-email split disabled');
    return;
  }
  initializeFirstSplitJob(source);
  void syncBackgroundSplitToMain();
}
