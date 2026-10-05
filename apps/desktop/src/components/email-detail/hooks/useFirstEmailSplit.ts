/**
 * The open thread's first-email split, as the reading pane needs it: what the
 * cache holds for the email on screen, whether a run is going, the automatic
 * run on open, and the reader's own "Process now" / "Try again" / "Re-split".
 *
 *   * Account-scoped: every IPC call names the thread's account
 *     (`threadAccountId`, stamped by loadThread) — the same thread id exists
 *     in every account's database, and main never falls back to the active
 *     one. No account, no call.
 *   * Main is authoritative for the key: the renderer reads main's CURRENT key
 *     (its first member + the stored body's fingerprint) and uses it only when
 *     main's first member IS the email on screen. On a mismatch the state is
 *     `unknown` — no AI for an email main would not vouch for — with one warn.
 *   * Answers land only while they still belong to the email on screen: a
 *     read or a run that resolves after the selection moved is dropped.
 *   * The automatic run needs ALL of: the rules' `autoRunAI` (the first email
 *     quotes two or more messages, AI is available), the chat view SHOWING
 *     (`chatActive` — the List view spends no AI), AI healthy, a state that
 *     wants a run (`miss`, `skipped`, `due`, `failed-retryable`), nothing in
 *     flight, and the store's session guard. It never runs for `on_demand`
 *     (one quoted message: the reader asks), nor because a later mail arrived
 *     (a later mail does not change the first email's key). A transient
 *     failure still backing off is re-read at its retry time, and each newly
 *     persisted failure gets its own automatic retry when it is due.
 */
import type { EmailRecord } from '@sarvinbox/core';
import {
  FIRST_SPLIT_BACKOFF_CAP_SECONDS,
  firstMemberKeyOf,
  firstSplitStateFor,
  parseFirstSplitParts,
  type FirstSplitCurrent,
  type FirstSplitGetResult,
  type FirstSplitPart,
  type FirstSplitRow,
  type FirstSplitState,
} from '@sarvinbox/core/first-split';
import { createLogger } from '@sarvinbox/core/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isAIAssistEnabled } from '../../../services/agent-settings';
import { getAIHealth, getDefaultProvider, type AIProvider } from '../../../services/ai-service';
import { nowSeconds } from '../../../services/first-split/split-first-email';
import {
  automaticRunAllowed,
  defaultFirstSplitBridge,
  firstSplitSettled,
  providerSignatureOf,
  runFirstSplit,
  subscribeFirstSplitProgress,
  type FirstSplitBridge,
  type FirstSplitProgress,
  type FirstSplitRef,
  type FirstSplitRunResult,
} from '../../../services/first-split/store';

const log = createLogger('FirstSplitView');

/** States in which an automatic run may start (see the module comment). */
const AUTO_RUN_STATES: ReadonlySet<FirstSplitState | 'unknown'> = new Set<FirstSplitState>([
  'miss',
  'skipped',
  'due',
  'failed-retryable',
]);

const IDLE: FirstSplitProgress = { running: false, status: null };

/** Bounds on the wait for a backing-off retry: never a busy loop, never past the longest backoff. */
const MIN_RETRY_WAIT_MS = 1_000;
const MAX_RETRY_WAIT_MS = FIRST_SPLIT_BACKOFF_CAP_SECONDS * 1_000;

export interface FirstEmailSplitInput {
  /**
   * The chat rules' `offerChat`: the thread is offered the chat view (always
   * for several members; a single email only when it quotes history). False
   * means nothing here could be shown — no read, no run, no IPC at all (a
   * newsletter or an OTP costs main no body fingerprint).
   */
  enabled: boolean;
  /** The account the thread was loaded from (`threadAccountId`). */
  accountId: string | null | undefined;
  /** The thread's first member, as the reading pane shows it. */
  first: EmailRecord | null | undefined;
  /** The chat rules' `autoRunAI`. */
  autoRunAI: boolean;
  /** The chat rules' `chatActive` — the chat view is the reading surface. */
  chatActive: boolean;
}

/** Injectable for tests; the defaults are the app's. */
export interface FirstEmailSplitDeps {
  bridge?: FirstSplitBridge;
  run?: typeof runFirstSplit;
  healthy?: () => boolean;
  provider?: () => AIProvider | null;
  /** Unix seconds. */
  now?: () => number;
}

export interface FirstEmailSplit {
  /** The cache's answer for the email on screen; `unknown` until main has answered (or would not vouch). */
  state: FirstSplitState | 'unknown';
  /** The stored row — whatever key it was computed for. */
  row: FirstSplitRow | null;
  /** The usable split's parts, oldest first; null unless `state === 'usable'`. */
  parts: FirstSplitPart[] | null;
  usable: boolean;
  /** A run for this thread is in flight — this pane's, a click's or the background job's. */
  running: boolean;
  /** The provider's status text for that run ("retrying in 8s"). */
  status: string | null;
  /** The session guard still lets an automatic run start for this key. */
  automaticRunAllowed: boolean;
  /**
   * What the reader's last click did, for the email on screen — so a click
   * whose run persisted nothing (a re-split kept, a provider failure, a stale
   * save) can say so (`manualRunNoticeFor`). Cleared when any run for this
   * thread starts and when the email on screen changes.
   */
  lastManualRun: FirstSplitRunResult | null;
  /** Split now, ignoring a usable split (the reader's click). Joins a run in flight. */
  run: () => Promise<void>;
}

export function useFirstEmailSplit(input: FirstEmailSplitInput, deps: FirstEmailSplitDeps = {}): FirstEmailSplit {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const { enabled, accountId, first, autoRunAI, chatActive } = input;
  const threadId = first?.threadId || null;
  const firstKey = first ? firstMemberKeyOf(first) : null;
  const bodyLength = first?.rawBody?.trim() ? first.rawBody.length : 0;

  // Whom an answer must belong to. Null while there is nothing main could
  // vouch for yet — no account, no thread, or no body (the key includes the
  // stored body's fingerprint, and main has none to take while it is missing)
  // — and while the thread is not offered the chat view at all.
  const identity = enabled && accountId && threadId && firstKey && bodyLength > 0
    ? `${accountId}|${threadId}|${firstKey}`
    : null;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const [answer, setAnswer] = useState<{ identity: string; got: FirstSplitGetResult | null } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);
  const warnedRef = useRef<string | null>(null);

  // Main's answer for the email on screen: re-read when the email or its body
  // changes, and after every run for this thread settles.
  useEffect(() => {
    if (!identity || !accountId || !threadId) return;
    let live = true;
    const land = (got: FirstSplitGetResult | null) => {
      if (live && identityRef.current === identity) setAnswer({ identity, got });
    };
    const bridge = depsRef.current.bridge ?? defaultFirstSplitBridge;
    bridge.get(accountId, threadId).then(
      (result) => {
        if (!result.success || !result.data) {
          if (live) log.warn(`get acct=${accountId} thread=${threadId} failed: ${result.error ?? 'no data'}`);
          land(null);
          return;
        }
        const current = result.data.current;
        if (!current || current.firstKey !== firstKey) {
          // Main's first member is not the email on screen (a draft or a
          // Trash copy the pane does not count, a resync mid-read): nothing
          // it caches belongs to this email. Once per email, not per read.
          if (live && warnedRef.current !== identity) {
            warnedRef.current = identity;
            log.warn(`acct=${accountId} thread=${threadId} main's first member is not the one on screen — no AI split for it`);
          }
          land(null);
          return;
        }
        land(result.data);
      },
      (error: unknown) => {
        if (live) log.warn(`get acct=${accountId} thread=${threadId} threw: ${(error as Error)?.message ?? error}`);
        land(null);
      },
    );
    return () => {
      live = false;
    };
  }, [identity, accountId, threadId, firstKey, bodyLength, refreshTick]);

  // Runs for this thread, whoever started them: progress for the banner, and
  // a re-read once the run's save has been answered (the hub's
  // `running: false` comes before the save — see `firstSplitSettled`).
  // The run is looked up on EVERY update, "done" included: a run handed a
  // prefetched answer (the background job's) publishes "running" before the
  // single-flight has registered it, so only the later "done" can find it —
  // and at "done" its save is still to come.
  const refKey = accountId && threadId ? `${accountId}|${threadId}` : null;
  const [progress, setProgress] = useState<{ key: string; value: FirstSplitProgress } | null>(null);
  const [manual, setManual] = useState<{ identity: string; result: FirstSplitRunResult } | null>(null);
  useEffect(() => {
    if (!accountId || !threadId || !refKey) return;
    const ref: FirstSplitRef = { accountId, threadId };
    let live = true;
    let watching: Promise<unknown> | undefined;
    const unsubscribe = subscribeFirstSplitProgress(ref, (value) => {
      if (!live) return;
      setProgress({ key: refKey, value });
      // A new run makes the last click's outcome old news.
      if (value.running) setManual(null);
      const settled = firstSplitSettled(ref);
      if (!settled || settled === watching) return;
      watching = settled;
      settled.then(
        () => { if (live) refresh(); },
        () => { if (live) refresh(); },
      );
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [accountId, threadId, refKey, refresh]);
  const running = (progress && progress.key === refKey ? progress.value : IDLE).running;
  const status = (progress && progress.key === refKey ? progress.value : IDLE).status;

  const got = answer && identity && answer.identity === identity ? answer.got : null;
  const current: FirstSplitCurrent | null = got?.current ?? null;
  const row = got?.row ?? null;
  // The provider a stored failure is compared against: read with each answer
  // (per email, and after every run settles), not on every render — the
  // reading pane re-renders on every store change during a sync, and each
  // read parses the AI settings out of localStorage.
  const providerSig = useMemo(
    () => (got ? providerSignatureOf((depsRef.current.provider ?? getDefaultProvider)()) : null),
    [got],
  );
  const state: FirstSplitState | 'unknown' = current
    ? firstSplitStateFor(row, current, (deps.now ?? nowSeconds)(), providerSig)
    : 'unknown';
  const parts = useMemo(
    () => (state === 'usable' ? parseFirstSplitParts(row?.parts) : null),
    [state, row],
  );
  const guardAllows = !!accountId && !!current && automaticRunAllowed(accountId, current);

  // A transient failure backing off becomes `due` at its retry time, but only
  // a render notices: re-read then (and after every read, so a clamped wait
  // re-arms), or the banner keeps "will retry" and the retry never starts.
  const retryAt = state === 'retry-later' ? row?.nextRetryAt ?? null : null;
  useEffect(() => {
    if (retryAt === null || !identity) return;
    const waitMs = (retryAt - (depsRef.current.now ?? nowSeconds)()) * 1000;
    const timer = setTimeout(refresh, Math.min(Math.max(waitMs, MIN_RETRY_WAIT_MS), MAX_RETRY_WAIT_MS));
    return () => clearTimeout(timer);
  }, [identity, retryAt, answer, refresh]);

  // The automatic run (see the module comment). One start per key, state AND
  // stored progress per mount: a run that persisted nothing leaves all three
  // as they were, and must not be restarted by the re-render its own refresh
  // causes — the store's session guard bounds it across opens. A run that
  // persisted a transient failure moved `attempts` / `nextRetryAt`, so that
  // failure gets its own retry when it is due (bounded by
  // FIRST_SPLIT_MAX_ATTEMPTS, after which the state is `failed`).
  const autoStartedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!identity || !accountId || !threadId || !current) return;
    if (!autoRunAI || !chatActive || running) return;
    if (!isAIAssistEnabled()) return;
    if (!AUTO_RUN_STATES.has(state)) return;
    if (!(depsRef.current.healthy ?? (() => getAIHealth().healthy))()) return;
    if (!automaticRunAllowed(accountId, current)) return;
    const token = `${identity}|${current.fingerprint}|${state}|${row?.attempts ?? 0}|${row?.nextRetryAt ?? ''}`;
    if (autoStartedRef.current === token) return;
    autoStartedRef.current = token;
    const startedFor = identity;
    // `runFirstSplit` never rejects; the second handler is for anything else.
    const done = () => { if (identityRef.current === startedFor) refresh(); };
    void (depsRef.current.run ?? runFirstSplit)({ accountId, threadId }, { trigger: 'open' }).then(done, done);
  }, [identity, accountId, threadId, current, row, state, autoRunAI, chatActive, running, refresh]);

  const run = useCallback(async () => {
    if (!identity || !accountId || !threadId) return;
    const startedFor = identity;
    setManual(null);
    try {
      const result = await (depsRef.current.run ?? runFirstSplit)({ accountId, threadId }, { trigger: 'manual' });
      if (identityRef.current === startedFor) setManual({ identity: startedFor, result });
    } finally {
      if (identityRef.current === startedFor) refresh();
    }
  }, [identity, accountId, threadId, refresh]);

  return {
    state,
    row,
    parts,
    usable: parts !== null && parts.length > 0,
    running,
    status,
    automaticRunAllowed: guardAllows,
    lastManualRun: manual && manual.identity === identity ? manual.result : null,
    run,
  };
}
