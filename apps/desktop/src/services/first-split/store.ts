/**
 * Running the first-email split for one thread of one account: read main's
 * current key and source, split, save once.
 *
 *   * Single-flight per (account, thread): a second caller — the background
 *     job and an open thread, or a click on "Process now" while an automatic
 *     run is going — joins the run in flight instead of paying for another.
 *   * Idempotent: unless forced, a thread whose cached split is usable for the
 *     current key is answered from the cache with no AI call.
 *   * Exactly ONE save per run, at the end, under the key the input was read
 *     with. Main recomputes that key inside the write and refuses a stale one,
 *     so an interrupted or overtaken run can never cache a split of an email
 *     that is no longer first; and a failure never replaces a good split for
 *     the same key (core `shouldReplace`).
 *   * Account-scoped end to end: every IPC call names the account, and main
 *     never falls back to the active one — two accounts holding the same
 *     thread id keep separate splits.
 *   * A session guard for the runs that leave NO trace: at most
 *     {@link MAX_AUTOMATIC_RUNS_PER_KEY} automatic runs per key per session
 *     may end without a persisted row — a save refused (`stale`, `kept`,
 *     `invalid`), a provider-wide failure, a save that errored, a run that
 *     threw. Nothing stored says "tried and failed" for those, so without the
 *     guard every open (and every nomination) would pay again. A run whose
 *     save PERSISTED — a transient failure with its backoff included — is not
 *     counted: the stored attempts and retry time already bound it
 *     (core `nextFailureState`, FIRST_SPLIT_MAX_ATTEMPTS). Manual runs are
 *     not limited.
 */
import type { ChatMessage } from '@sarv-in/email-chat-view';
import type { EmailRecord } from '@sarvinbox/core';
import {
  firstMemberKeyOf,
  isUsableSplit,
  type FirstSplitCurrent,
  type FirstSplitGetResult,
  type FirstSplitKey,
  type FirstSplitRow,
  type FirstSplitSaveRequest,
  type FirstSplitSaveResult,
} from '@sarvinbox/core/first-split';
import { createLogger } from '@sarvinbox/core/logger';
import { createSingleFlight } from '@sarvinbox/core/single-flight';

import { firstEmailFacts } from '../../components/email-detail/ai-view-compose';
import { splitThread } from '../../components/email-detail/chat-message-adapter';
import { getDefaultProvider, type AIProvider } from '../ai-service';
import { createProgressHub, type ProgressHub } from '../progress-hub';

import { splitFirstEmail, type SplitDeps, type SplitOutcome } from './split-first-email';

const log = createLogger('FirstSplit');

/** Automatic runs that persisted nothing, allowed per (account, thread, first email, body) per session. */
export const MAX_AUTOMATIC_RUNS_PER_KEY = 2;

/** Which thread, in which account. */
export interface FirstSplitRef {
  accountId: string;
  threadId: string;
}

/** Why a run started. `manual` is the reader's click; the others are automatic. */
export type FirstSplitTrigger = 'open' | 'background' | 'manual';

export interface RunFirstSplitOptions {
  trigger: FirstSplitTrigger;
  /** Ignore a usable cached split and run anyway (a manual re-split). Defaults to `trigger === 'manual'`. */
  force?: boolean;
  /** Main's answer, already fetched `withSource` (the background job reads it to decide). */
  prefetched?: FirstSplitGetResult;
}

/** The IPC this module needs — `window.electronAPI.ai` by default, injectable for tests. */
export interface FirstSplitBridge {
  get(accountId: string, threadId: string, options?: { withSource?: boolean }):
    Promise<{ success: boolean; data?: FirstSplitGetResult; error?: string }>;
  save(accountId: string, request: FirstSplitSaveRequest):
    Promise<{ success: boolean; data?: FirstSplitSaveResult; error?: string }>;
}

export interface FirstSplitStoreDeps extends SplitDeps {
  bridge?: FirstSplitBridge;
  /** The provider the run is charged to; its signature is stored with the result. */
  provider?: () => AIProvider | null;
  /** The split itself — injectable so a test can hold a run open. */
  split?: typeof splitFirstEmail;
}

/** What a run did. */
export type FirstSplitRunResult =
  /** Main has no member, or the source has no body yet: nothing to split under a key main vouches for. */
  | { state: 'unknown' }
  /** The cached split is usable for the current key — no AI call. */
  | { state: 'usable'; current: FirstSplitCurrent; row: FirstSplitRow }
  /** The session guard stopped an automatic run: this key's automatic runs keep persisting nothing. */
  | { state: 'guarded'; current: FirstSplitCurrent }
  /** A provider-wide failure (auth, credit, no provider) — nothing written. */
  | { state: 'provider'; current: FirstSplitCurrent; outcome: SplitOutcome }
  /** The run finished and its one save was answered (`save.applied` may be false: stale / kept). */
  | { state: 'saved'; current: FirstSplitCurrent; outcome: SplitOutcome; save: FirstSplitSaveResult }
  /** An IPC call failed (the account could not be resolved, the database threw). */
  | { state: 'error'; error: string };

/** A run's progress, for the waiting UI. */
export interface FirstSplitProgress {
  running: boolean;
  /** The provider's status text ("retrying in 8s"), when there is one. */
  status: string | null;
}

/** The preload bridge — the one place this feature names the IPC calls. */
export const defaultFirstSplitBridge: FirstSplitBridge = {
  get: (accountId, threadId, options) => window.electronAPI.ai.getFirstSplit(accountId, threadId, options),
  save: (accountId, request) => window.electronAPI.ai.saveFirstSplit(accountId, request),
};

let inFlight = createSingleFlight<FirstSplitRunResult>();
const automaticRuns = new Map<string, number>();
/** Hubs are tiny; this bound only keeps a very long session from accumulating them. */
const MAX_HUBS = 500;
const hubs = new Map<string, ProgressHub<FirstSplitProgress>>();
/** Live subscribers per hub — a hub somebody is watching is never evicted. */
const watchers = new Map<string, number>();

const refKey = (ref: FirstSplitRef) => `${ref.accountId}|${ref.threadId}`;
const guardKey = (accountId: string, key: FirstSplitKey) =>
  `${accountId}|${key.threadId}|${key.firstKey}|${key.fingerprint}`;

function hubFor(ref: FirstSplitRef): ProgressHub<FirstSplitProgress> {
  const key = refKey(ref);
  let hub = hubs.get(key);
  if (!hub) {
    if (hubs.size >= MAX_HUBS) {
      // The oldest hub nobody watches and no run is using.
      for (const [oldKey, oldHub] of hubs) {
        if (!oldHub.last?.running && !watchers.get(oldKey)) {
          hubs.delete(oldKey);
          break;
        }
      }
    }
    hub = createProgressHub<FirstSplitProgress>();
    hubs.set(key, hub);
  }
  return hub;
}

/** Follow a thread's runs; the latest progress is replayed at once. Returns the unsubscribe. */
export function subscribeFirstSplitProgress(
  ref: FirstSplitRef,
  listener: (progress: FirstSplitProgress) => void,
): () => void {
  const key = refKey(ref);
  watchers.set(key, (watchers.get(key) ?? 0) + 1);
  const unsubscribe = hubFor(ref).subscribe(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    const left = (watchers.get(key) ?? 1) - 1;
    if (left > 0) watchers.set(key, left);
    else watchers.delete(key);
  };
}

/**
 * May an automatic run start for this key (the session guard)? False once
 * {@link MAX_AUTOMATIC_RUNS_PER_KEY} automatic runs persisted nothing — the
 * banner must then offer "Try again", not promise a retry that will not come.
 */
export function automaticRunAllowed(accountId: string, key: FirstSplitKey): boolean {
  return (automaticRuns.get(guardKey(accountId, key)) ?? 0) < MAX_AUTOMATIC_RUNS_PER_KEY;
}

/** The provider a result is recorded against: a 4xx under one provider is retried under another. */
export function providerSignatureOf(provider: AIProvider | null | undefined): string | null {
  return provider ? `${provider.type}:${provider.id}:${provider.model}` : null;
}

/** The key fields only — what main compares a save against. Every save builds its key here. */
export function firstSplitKeyOf(current: FirstSplitCurrent): FirstSplitKey {
  return {
    threadId: current.threadId,
    firstKey: current.firstKey,
    firstEmailId: current.firstEmailId,
    fingerprint: current.fingerprint,
  };
}

/** Standard's turns carried by the source (the library split of `[source]`). */
function standardTurnsOf(source: EmailRecord): ChatMessage[] {
  return splitThread([source], { currentUserEmail: '' });
}

function countsOf(outcome: SplitOutcome): string {
  const rejected = Object.entries(outcome.rejected).map(([reason, count]) => `${reason}:${count}`).join(',');
  return `regions=${outcome.regions} chunks=${outcome.chunks} ai=${outcome.aiParts}`
    + ` fallback=${outcome.fallbackParts + outcome.fallbackRegions}${rejected ? ` rejected=${rejected}` : ''}`;
}

async function run(
  ref: FirstSplitRef,
  options: RunFirstSplitOptions,
  deps: FirstSplitStoreDeps,
): Promise<FirstSplitRunResult> {
  const bridge = deps.bridge ?? defaultFirstSplitBridge;
  const force = options.force ?? options.trigger === 'manual';

  let got = options.prefetched;
  if (!got) {
    const answer = await bridge.get(ref.accountId, ref.threadId, { withSource: true });
    if (!answer.success || !answer.data) {
      log.warn(`split acct=${ref.accountId} thread=${ref.threadId} get failed: ${answer.error ?? 'no data'}`);
      return { state: 'error', error: answer.error ?? 'no data' };
    }
    got = answer.data;
  }
  const { current, source, row } = got;
  if (!current || !source || !(source.rawBody ?? '').trim()) return { state: 'unknown' };
  // Main hands back its own first member; a record that is not it cannot be split under this key.
  if (firstMemberKeyOf(source) !== current.firstKey) {
    log.warn(`split acct=${ref.accountId} thread=${ref.threadId} source is not the first member — not run`);
    return { state: 'unknown' };
  }
  if (!force && isUsableSplit(row, current)) return { state: 'usable', current, row: row! };

  if (!force && !automaticRunAllowed(ref.accountId, current)) return { state: 'guarded', current };

  let persisted = false;
  try {
    const result = await splitAndSave(ref, options, deps, got, current, source);
    persisted = result.state === 'saved' && result.save.applied;
    return result;
  } finally {
    // Counted in `finally`: a run that threw persisted nothing either.
    if (!force && !persisted) {
      const guard = guardKey(ref.accountId, current);
      automaticRuns.set(guard, (automaticRuns.get(guard) ?? 0) + 1);
    }
  }
}

/** The run proper, once it is allowed: split, then the one save. */
async function splitAndSave(
  ref: FirstSplitRef,
  options: RunFirstSplitOptions,
  deps: FirstSplitStoreDeps,
  got: FirstSplitGetResult,
  current: FirstSplitCurrent,
  source: EmailRecord,
): Promise<FirstSplitRunResult> {
  const bridge = deps.bridge ?? defaultFirstSplitBridge;
  const hub = hubFor(ref);
  hub.publish({ running: true, status: null });
  const started = Date.now();
  const facts = firstEmailFacts(source, current.distinctSenders);
  let outcome: SplitOutcome;
  try {
    outcome = await (deps.split ?? splitFirstEmail)(
      {
        source,
        roster: got.roster ?? [],
        standard: standardTurnsOf(source),
        onStatus: (status) => hub.publish({ running: true, status }),
      },
      deps,
    );
  } finally {
    hub.publish({ running: false, status: null });
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const line = `split acct=${ref.accountId} thread=${ref.threadId} trigger=${options.trigger} ${countsOf(outcome)}`;

  if (outcome.status === 'provider') {
    log.warn(`${line} status=provider (nothing saved) ${seconds}s: ${outcome.reason ?? ''}`);
    return { state: 'provider', current, outcome };
  }

  const request: FirstSplitSaveRequest = {
    key: firstSplitKeyOf(current),
    status: outcome.status,
    parts: outcome.parts ?? null,
    errorKind: outcome.errorKind ?? null,
    quoteCount: facts.kind === 'known' ? facts.quoteCount : null,
    modelUsed: providerSignatureOf((deps.provider ?? getDefaultProvider)()),
  };
  const saved = await bridge.save(ref.accountId, request);
  if (!saved.success || !saved.data) {
    log.warn(`${line} status=${outcome.status} save failed ${seconds}s: ${saved.error ?? 'no data'}`);
    return { state: 'error', error: saved.error ?? 'no data' };
  }
  const result = saved.data.applied ? `saved=${saved.data.status ?? outcome.status}` : `not-saved=${saved.data.reason}`;
  const summary = `${line} status=${outcome.status}${outcome.errorKind ? ` errorKind=${outcome.errorKind}` : ''} ${result} ${seconds}s`;
  if (outcome.status === 'ok' || outcome.status === 'partial') log.info(summary);
  else log.warn(summary);
  return { state: 'saved', current, outcome, save: saved.data };
}

/**
 * Split a thread's first email (see the module comment). Never throws: an IPC
 * failure is `{ state: 'error' }`.
 */
export function runFirstSplit(
  ref: FirstSplitRef,
  options: RunFirstSplitOptions,
  deps: FirstSplitStoreDeps = {},
): Promise<FirstSplitRunResult> {
  return inFlight.run(refKey(ref), async () => {
    try {
      return await run(ref, options, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`split acct=${ref.accountId} thread=${ref.threadId} threw: ${message}`);
      return { state: 'error', error: message };
    }
  });
}

/**
 * The run in flight for this thread — whoever started it (an open thread, a
 * click, the background job) — or undefined when none is. Its settlement is
 * when the one save has been answered; the progress hub's `running: false`
 * comes BEFORE the save, so a reader of the cache waits for this instead.
 */
export function firstSplitSettled(ref: FirstSplitRef): Promise<FirstSplitRunResult> | undefined {
  return inFlight.pending(refKey(ref));
}

/** Test-only: a new session — forget runs in flight, the session guard and the progress hubs. */
export function resetFirstSplitStoreForTests(): void {
  inFlight = createSingleFlight<FirstSplitRunResult>();
  automaticRuns.clear();
  hubs.clear();
  watchers.clear();
}
