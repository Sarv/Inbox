// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import {
  firstMemberKeyOf,
  type FirstSplitGetResult,
  type FirstSplitRow,
} from '@sarvinbox/core/first-split';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useFirstEmailSplit,
  type FirstEmailSplit,
  type FirstEmailSplitDeps,
  type FirstEmailSplitInput,
} from '../../../../../src/components/email-detail/hooks/useFirstEmailSplit';
import { DEFAULT_AGENT_SETTINGS, saveAgentSettings } from '../../../../../src/services/agent-settings';
import { reportAIHealthy, reportAIUnhealthy, type AIProvider } from '../../../../../src/services/ai-service';
import type { SplitOutcome } from '../../../../../src/services/first-split/split-first-email';
import {
  resetFirstSplitStoreForTests,
  runFirstSplit,
  type FirstSplitBridge,
} from '../../../../../src/services/first-split/store';
import { act, render, settle, type Mounted } from '../../../../helpers/render';

import { splitRow } from './chat-context-fixture';
import { LOOPED_AT, loopedInEmail, loopedInParts } from './looped-in-fixture';

/**
 * The reading pane's view of the first email's split (`useFirstEmailSplit`).
 *
 * What breaks if this file goes red: AI is spent in the List view, or on a
 * single-quote email nobody asked to split; a split lands on the wrong email
 * because its answer arrived after the reader moved on; the cache is read or
 * written in the wrong account (the same thread id lives in every account's
 * database); an email main would not vouch for gets split anyway; or the pane
 * keeps showing "splitting…" after a background run already saved its result.
 */

const PROVIDER = { id: 'p1', type: 'openai', model: 'gpt-x', name: 'P', apiKey: 'k', isDefault: true } as unknown as AIProvider;
const NOW = LOOPED_AT + 60;

const FIRST = loopedInEmail({ threadId: 't1' });
const OTHER = loopedInEmail({ id: 'x1', messageId: '<x1@acme.example>', threadId: 't2' });

/** Main's answer for `first`, with `row` stored. */
const answerFor = (first: EmailRecord, row: FirstSplitRow | null = null, overrides: Partial<NonNullable<FirstSplitGetResult['current']>> = {}): FirstSplitGetResult => ({
  row,
  current: {
    threadId: first.threadId,
    firstKey: firstMemberKeyOf(first),
    firstEmailId: first.id,
    fingerprint: 'fp-1',
    memberCount: 1,
    distinctSenders: 1,
    ...overrides,
  },
});

/** A stored row for `first` under the answer's key. */
const rowFor = (first: EmailRecord, over: Partial<FirstSplitRow> = {}): FirstSplitRow =>
  splitRow(loopedInParts(), {
    threadId: first.threadId,
    firstKey: firstMemberKeyOf(first),
    firstEmailId: first.id,
    sourceFingerprint: 'fp-1',
    ...over,
  });

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

/** A bridge whose `get` answers from `answers` (per thread), recording every call. */
const bridgeWith = (answers: Record<string, FirstSplitGetResult | 'fail' | Deferred<FirstSplitGetResult>>) => {
  const gets: Array<{ accountId: string; threadId: string; options?: unknown }> = [];
  const bridge: FirstSplitBridge = {
    get: vi.fn(async (accountId: string, threadId: string, options?: { withSource?: boolean }) => {
      gets.push({ accountId, threadId, options });
      const answer = answers[threadId];
      if (!answer || answer === 'fail') return { success: false, error: 'Account acct-z is not available' };
      // A fresh object per answer, as IPC delivers it (structured clone).
      if ('promise' in answer) return { success: true, data: structuredClone(await answer.promise) };
      return { success: true, data: structuredClone(answer) };
    }),
    save: vi.fn(async () => ({ success: true, data: { applied: true } })),
  };
  return { bridge, gets };
};

let latest: FirstEmailSplit | null = null;
function Harness({ input, deps }: { input: FirstEmailSplitInput; deps: FirstEmailSplitDeps }) {
  latest = useFirstEmailSplit(input, deps);
  return null;
}

let mounted: Mounted | undefined;
const mount = async (input: FirstEmailSplitInput, deps: FirstEmailSplitDeps) => {
  mounted = render(<Harness input={input} deps={deps} />);
  await settle();
  await settle();
  return mounted;
};
const rerender = async (input: FirstEmailSplitInput, deps: FirstEmailSplitDeps) => {
  mounted!.rerender(<Harness input={input} deps={deps} />);
  await settle();
  await settle();
};

/** Chat showing, first email quoting 2+ messages, account B. */
const AUTO: FirstEmailSplitInput = { enabled: true, accountId: 'acct-b', first: FIRST, autoRunAI: true, chatActive: true };

let run: ReturnType<typeof vi.fn>;
const depsFor = (bridge: FirstSplitBridge, over: FirstEmailSplitDeps = {}): FirstEmailSplitDeps => ({
  bridge,
  run: run as unknown as FirstEmailSplitDeps['run'],
  healthy: () => true,
  provider: () => PROVIDER,
  now: () => NOW,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  resetFirstSplitStoreForTests();
  latest = null;
  run = vi.fn(async () => ({ state: 'unknown' }));
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

describe('useFirstEmailSplit — reading the cache', () => {
  // I7: every IPC call names the thread's account; none is made without one.
  it('reads with the thread\'s account, and makes no call without one', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST, rowFor(FIRST)) });
    await mount({ ...AUTO, accountId: null }, depsFor(bridge));
    expect(gets).toEqual([]);
    expect(latest!.state).toBe('unknown');

    await rerender(AUTO, depsFor(bridge));
    expect(gets).toEqual([{ accountId: 'acct-b', threadId: 't1', options: undefined }]);
    expect(latest!.state).toBe('usable');
    expect(latest!.usable).toBe(true);
    expect(latest!.parts).toHaveLength(4);
  });

  // A thread not offered the chat view (a single newsletter, an OTP) has
  // nothing to show a split in: no read — main would fingerprint the whole
  // stored body and query membership for nobody — and no run, not even a
  // click's. Offering it later reads at once.
  it('makes no call and no run while the chat is not offered', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST) });
    await mount({ ...AUTO, enabled: false }, depsFor(bridge));
    await latest!.run();
    expect(gets).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(latest!.state).toBe('unknown');

    await rerender({ ...AUTO, autoRunAI: false }, depsFor(bridge));
    expect(gets).toEqual([{ accountId: 'acct-b', threadId: 't1', options: undefined }]);
    expect(latest!.state).toBe('miss');
  });

  // UNKNOWN is never 0: without the first email's body there is no key main
  // could vouch for — nothing is read, nothing runs.
  it('waits for the first email\'s body, then reads', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST) });
    const bodiless = { ...FIRST, rawBody: '' };
    await mount({ ...AUTO, first: bodiless }, depsFor(bridge));
    expect(gets).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(latest!.state).toBe('unknown');

    // The body lands: main is asked, and the (auto) email is split.
    await rerender(AUTO, depsFor(bridge));
    expect(gets[0]).toEqual({ accountId: 'acct-b', threadId: 't1', options: undefined });
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Main's first member is not the email on screen: no AI for it, one warn.
  it('treats a renderer/main first-key mismatch as unknown, with one warn and no run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bridge } = bridgeWith({ t1: answerFor(FIRST, null, { firstKey: 'someone-else@acme.example' }) });
    await mount(AUTO, depsFor(bridge));
    expect(latest!.state).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
    // A second read for the same email (after a run elsewhere) does not warn again.
    await rerender({ ...AUTO, first: { ...FIRST, rawBody: `${FIRST.rawBody} ` } }, depsFor(bridge));
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('[FirstSplitView]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('not the one on screen');
  });

  // A thread main has no member for (only drafts left) is unknown as well.
  it('treats a thread with no member as unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bridge } = bridgeWith({ t1: { row: null, current: null } });
    await mount(AUTO, depsFor(bridge));
    expect(latest!.state).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
  });

  // A failed read (the account cannot be resolved, the DB threw) is unknown,
  // logged — never "no split", which would invite a run.
  it('treats a failed read as unknown and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bridge } = bridgeWith({ t1: 'fail' });
    await mount(AUTO, depsFor(bridge));
    expect(latest!.state).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((call) => String(call[0]).includes('get acct=acct-b thread=t1 failed'))).toBe(true);

    const threw: FirstSplitBridge = { ...bridge, get: vi.fn(async () => { throw new Error('ipc down'); }) };
    await rerender({ ...AUTO, first: OTHER }, depsFor(threw));
    expect(latest!.state).toBe('unknown');
    expect(warn.mock.calls.some((call) => String(call[0]).includes('threw: ipc down'))).toBe(true);
  });

  // THE race: the reader moved to another thread before the first read came
  // back. Its answer must not paint the new thread.
  it('ignores an answer that arrives after the selection changed', async () => {
    const slow = deferred<FirstSplitGetResult>();
    const later = deferred<FirstSplitGetResult>();
    const { bridge } = bridgeWith({ t1: slow, t2: later });
    await mount(AUTO, depsFor(bridge));
    await rerender({ ...AUTO, first: OTHER }, depsFor(bridge));

    slow.resolve(answerFor(FIRST, rowFor(FIRST)));
    await settle();
    expect(latest!.state).toBe('unknown');
    expect(latest!.parts).toBeNull();

    later.resolve(answerFor(OTHER));
    await settle();
    await settle();
    expect(latest!.state).toBe('miss');
  });
});

describe('useFirstEmailSplit — the automatic run', () => {
  const runs = () => run.mock.calls.map((call) => [call[0], (call[1] as { trigger: string }).trigger]);

  // Decision 4: automatic only while the chat view is SHOWING, only for a
  // first email quoting 2+ messages, only while AI is healthy.
  it('runs for an auto email with the chat showing and AI healthy', async () => {
    const { bridge } = bridgeWith({ t1: answerFor(FIRST) });
    await mount(AUTO, depsFor(bridge));
    expect(runs()).toEqual([[{ accountId: 'acct-b', threadId: 't1' }, 'open']]);
  });

  // Regression: retained provider settings after onboarding Skip must not
  // transmit an opened email automatically; a deliberate Process now stays available.
  it('keeps automatic open processing off while preserving the explicit manual action', async () => {
    saveAgentSettings({ ...DEFAULT_AGENT_SETTINGS, enabled: false });
    const { bridge } = bridgeWith({ t1: answerFor(FIRST) });
    await mount(AUTO, depsFor(bridge));
    expect(run).not.toHaveBeenCalled();
    await act(async () => { await latest!.run(); });
    expect(runs()).toEqual([[{ accountId: 'acct-b', threadId: 't1' }, 'manual']]);
  });

  it.each([
    ['in the List view', { chatActive: false }],
    ['for an on-demand (single-quote) email', { autoRunAI: false }],
  ])('never runs %s', async (_name, input) => {
    const { bridge } = bridgeWith({ t1: answerFor(FIRST) });
    await mount({ ...AUTO, ...input }, depsFor(bridge));
    expect(run).not.toHaveBeenCalled();
  });

  it('never runs while AI is unhealthy', async () => {
    const { bridge } = bridgeWith({ t1: answerFor(FIRST) });
    await mount(AUTO, depsFor(bridge, { healthy: () => false }));
    expect(run).not.toHaveBeenCalled();
  });

  // Only the states that want a run start one; a usable split, a transient
  // failure still backing off and a permanent failure do not.
  it.each([
    ['a usable split', rowFor(FIRST), false],
    ['a transient failure backing off', rowFor(FIRST, { status: 'transient', parts: null, attempts: 1, nextRetryAt: NOW + 300 }), false],
    ['a permanent failure', rowFor(FIRST, { status: 'failed', parts: null, errorKind: 'unusable' }), false],
    ['a transient failure that is due', rowFor(FIRST, { status: 'transient', parts: null, attempts: 1, nextRetryAt: NOW - 1 }), true],
    ['a skipped row', rowFor(FIRST, { status: 'skipped', parts: null }), true],
    ['a 4xx under another provider', rowFor(FIRST, { status: 'failed', parts: null, errorKind: 'client', modelUsed: 'openai:old:gpt-y' }), true],
  ])('with %s: runs=%s', async (_name, row, expected) => {
    const { bridge } = bridgeWith({ t1: answerFor(FIRST, row) });
    await mount(AUTO, depsFor(bridge));
    expect(run.mock.calls.length > 0).toBe(expected);
  });

  // Idempotent: a run that persisted nothing leaves the state as it was, and
  // the re-render its own refresh causes must not start another.
  it('starts once per key and state, and re-reads after the run', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST) });
    await mount(AUTO, depsFor(bridge));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(gets.length).toBeGreaterThanOrEqual(2);
    await rerender({ ...AUTO }, depsFor(bridge));
    expect(run).toHaveBeenCalledTimes(1);
  });

  // A transient failure is retried each time it comes due, not once per
  // session: the once-only token must include the stored attempts / retry
  // time, and the pane must notice the retry time passing. Without either,
  // the SECOND automatic retry never starts although the banner still says
  // "will retry automatically" — a transient failure treated as permanent.
  it('retries a newly persisted transient failure when it comes due, and only once per failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let clock = NOW;
      const answers: Record<string, FirstSplitGetResult> = {
        t1: answerFor(FIRST, rowFor(FIRST, { status: 'transient', parts: null, attempts: 1, nextRetryAt: NOW - 1 })),
      };
      const { bridge } = bridgeWith(answers);
      // The first retry fails transiently again, and main persists attempt 2 with a later retry time.
      run = vi.fn(async () => {
        answers.t1 = answerFor(FIRST, rowFor(FIRST, { status: 'transient', parts: null, attempts: 2, nextRetryAt: clock + 600 }));
        return { state: 'unknown' };
      });
      await mount(AUTO, depsFor(bridge, { now: () => clock }));
      await settle();
      expect(run).toHaveBeenCalledTimes(1);
      expect(latest!.state).toBe('retry-later');
      expect(latest!.automaticRunAllowed).toBe(true);

      // Time passes to the retry: the pane re-reads on its own, finds it due, and runs again.
      clock += 601;
      await act(async () => { vi.advanceTimersByTime(601_000); });
      await settle();
      await settle();
      expect(run).toHaveBeenCalledTimes(2);

      // A run that persists nothing leaves the row as it was: no third start from the re-render.
      run.mockImplementation(async () => ({ state: 'unknown' }));
      await settle();
      await rerender({ ...AUTO }, depsFor(bridge, { now: () => clock }));
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // No timer outlives the email it was for: moving on clears it.
  it('clears the retry timer when the reader moves on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { bridge, gets } = bridgeWith({
        t1: answerFor(FIRST, rowFor(FIRST, { status: 'transient', parts: null, attempts: 1, nextRetryAt: NOW + 300 })),
        t2: answerFor(OTHER, rowFor(OTHER)),
      });
      await mount(AUTO, depsFor(bridge));
      expect(latest!.state).toBe('retry-later');
      await rerender({ ...AUTO, first: OTHER }, depsFor(bridge));
      const before = gets.length;
      await act(async () => { vi.advanceTimersByTime(301_000); });
      await settle();
      expect(gets.length).toBe(before);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // The store's session guard: once this key's automatic runs have kept
  // persisting nothing, no further automatic run starts this session — and
  // the banner is told so (it offers Try again, not "will retry").
  it('stops at the session guard', async () => {
    const { bridge } = bridgeWith({ t1: answerFor(FIRST) });
    const source: FirstSplitBridge = {
      get: async () => ({ success: true, data: { ...answerFor(FIRST), source: FIRST, roster: [] } }),
      save: async () => ({ success: true, data: { applied: false, reason: 'stale' } }),
    };
    const provider: SplitOutcome = {
      status: 'provider', regions: 0, chunks: 0, fallbackRegions: 0, aiParts: 0, fallbackParts: 0, rejected: {},
    };
    for (let i = 0; i < 2; i++) {
      await runFirstSplit({ accountId: 'acct-b', threadId: 't1' }, { trigger: 'open' }, {
        bridge: source,
        provider: () => PROVIDER,
        split: async () => provider,
      });
    }
    await mount(AUTO, depsFor(bridge));
    expect(latest!.automaticRunAllowed).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('useFirstEmailSplit — the app\'s defaults', () => {
  // Without an injected check, AI health is the app's: an unhealthy provider
  // (auth failed, out of credit) spends nothing automatically.
  it('reads AI health from the app', async () => {
    const { bridge } = bridgeWith({ t1: answerFor(FIRST) });
    const { healthy: _unused, ...appHealth } = depsFor(bridge);
    reportAIUnhealthy('test: auth failed');
    try {
      await mount(AUTO, appHealth);
      expect(run).not.toHaveBeenCalled();
    } finally {
      reportAIHealthy();
    }
    await rerender({ ...AUTO, first: { ...FIRST, rawBody: `${FIRST.rawBody} ` } }, appHealth);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // No first email (the thread is loading, or holds only drafts): nothing.
  it('does nothing without a first email', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST) });
    await mount({ ...AUTO, first: null }, depsFor(bridge));
    expect(gets).toEqual([]);
    expect(latest!.state).toBe('unknown');
    await latest!.run();
    expect(run).not.toHaveBeenCalled();
  });

  // A read that settles after the pane closed is dropped, silently.
  it('drops a read that settles after unmount', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slow = deferred<FirstSplitGetResult>();
    const failing: FirstSplitBridge = {
      get: vi.fn(async () => { await slow.promise; return { success: false, error: 'late' }; }),
      save: vi.fn(),
    };
    await mount(AUTO, depsFor(failing));
    mounted!.unmount();
    mounted = undefined;
    slow.resolve(answerFor(FIRST));
    await settle();
    expect(warn.mock.calls.some((call) => String(call[0]).includes('late'))).toBe(false);

    const throwing: FirstSplitBridge = {
      get: vi.fn(async () => { await Promise.resolve(); throw new Error('late throw'); }),
      save: vi.fn(),
    };
    mounted = render(<Harness input={AUTO} deps={depsFor(throwing)} />);
    mounted.unmount();
    mounted = undefined;
    await settle();
    expect(warn.mock.calls.some((call) => String(call[0]).includes('late throw'))).toBe(false);
  });
});

describe('useFirstEmailSplit — the reader\'s run', () => {
  // Decision 2: a single-quote email is split only on demand.
  it('runs on demand with the thread\'s account, then re-reads', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST) });
    await mount({ ...AUTO, autoRunAI: false }, depsFor(bridge));
    expect(run).not.toHaveBeenCalled();
    const before = gets.length;

    await latest!.run();
    await settle();
    expect(run).toHaveBeenCalledWith({ accountId: 'acct-b', threadId: 't1' }, { trigger: 'manual' });
    expect(gets.length).toBe(before + 1);
  });

  // A forced re-split whose save main KEPT the old split for persisted
  // nothing: the banner is unchanged, so the pane must remember what the
  // click did or the reader cannot tell it failed. The outcome belongs to
  // the email it ran for, and any new run makes it old news.
  it('keeps the last click\'s outcome for the email on screen until a run starts or the email changes', async () => {
    const kept = {
      state: 'saved',
      current: answerFor(FIRST).current,
      outcome: { status: 'transient', errorKind: 'timeout', regions: 1, chunks: 1, fallbackRegions: 0, aiParts: 0, fallbackParts: 0, rejected: {} },
      save: { applied: false, reason: 'kept' },
    };
    run = vi.fn(async () => kept);
    const { bridge } = bridgeWith({ t1: answerFor(FIRST, rowFor(FIRST)), t2: answerFor(OTHER, rowFor(OTHER)) });
    await mount({ ...AUTO, autoRunAI: false }, depsFor(bridge));
    expect(latest!.lastManualRun).toBeNull();

    await act(async () => { await latest!.run(); });
    await settle();
    expect(latest!.lastManualRun).toEqual(kept);
    expect(latest!.state).toBe('usable');

    // Another run for this thread starts (the background job's): cleared.
    const hold = deferred<SplitOutcome>();
    const background = runFirstSplit({ accountId: 'acct-b', threadId: 't1' }, {
      trigger: 'background',
      force: true,
      prefetched: { ...answerFor(FIRST), source: FIRST, roster: [] },
    }, { bridge, provider: () => PROVIDER, split: () => hold.promise });
    await settle();
    expect(latest!.lastManualRun).toBeNull();
    hold.resolve({ status: 'provider', regions: 0, chunks: 0, fallbackRegions: 0, aiParts: 0, fallbackParts: 0, rejected: {} });
    await background;
    await settle();

    // Clicked again, then the reader moves on: the old email's outcome is not shown for the new one.
    await act(async () => { await latest!.run(); });
    expect(latest!.lastManualRun).toEqual(kept);
    await rerender({ ...AUTO, autoRunAI: false, first: OTHER }, depsFor(bridge));
    expect(latest!.lastManualRun).toBeNull();
  });

  // A click whose run resolves after the reader moved on records nothing for the new email.
  it('does not record a click\'s outcome for an email the reader already left', async () => {
    const hold = deferred<unknown>();
    run = vi.fn(() => hold.promise);
    const { bridge } = bridgeWith({ t1: answerFor(FIRST), t2: answerFor(OTHER) });
    await mount({ ...AUTO, autoRunAI: false }, depsFor(bridge));
    const pending = latest!.run();
    await rerender({ ...AUTO, autoRunAI: false, first: OTHER }, depsFor(bridge));
    hold.resolve({ state: 'provider', current: answerFor(FIRST).current, outcome: {} });
    await act(async () => { await pending; });
    // Back to the first email: its late outcome was dropped, not parked.
    await rerender({ ...AUTO, autoRunAI: false }, depsFor(bridge));
    expect(latest!.lastManualRun).toBeNull();
  });

  // Nothing to run for: no account, or no body.
  it('does nothing without an account or a body', async () => {
    const { bridge } = bridgeWith({ t1: answerFor(FIRST) });
    await mount({ ...AUTO, accountId: undefined }, depsFor(bridge));
    await latest!.run();
    await rerender({ ...AUTO, first: { ...FIRST, rawBody: '   ' } }, depsFor(bridge));
    await latest!.run();
    expect(run).not.toHaveBeenCalled();
  });

  // The reader moved on before the run came back: the old thread's result is
  // not re-read into the new one.
  it('does not re-read for a thread the reader already left', async () => {
    const hold = deferred<unknown>();
    run = vi.fn(() => hold.promise);
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST), t2: answerFor(OTHER) });
    await mount({ ...AUTO, autoRunAI: false }, depsFor(bridge));
    const pending = latest!.run();
    await rerender({ ...AUTO, autoRunAI: false, first: OTHER }, depsFor(bridge));
    const before = gets.length;
    hold.resolve({ state: 'unknown' });
    await pending;
    await settle();
    expect(gets.length).toBe(before);
  });

  // Same for the automatic run: it lands for the thread it started on only.
  it('does not re-read after an automatic run for a thread the reader left', async () => {
    const hold = deferred<unknown>();
    run = vi.fn(() => hold.promise);
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST), t2: answerFor(OTHER, rowFor(OTHER)) });
    await mount(AUTO, depsFor(bridge));
    expect(run).toHaveBeenCalledTimes(1);
    await rerender({ ...AUTO, first: OTHER }, depsFor(bridge));
    const before = gets.length;
    hold.resolve({ state: 'unknown' });
    await settle();
    await settle();
    expect(gets.length).toBe(before);
  });

  // A run that throws (it should not — runFirstSplit never rejects) still
  // re-reads rather than leave the pane on a stale answer.
  it('re-reads even when the run rejects', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST) });
    run = vi.fn(async () => { throw new Error('boom'); });
    await mount({ ...AUTO, autoRunAI: false }, depsFor(bridge));
    const before = gets.length;
    await expect(latest!.run()).rejects.toThrow('boom');
    await settle();
    expect(gets.length).toBe(before + 1);
  });
});

describe('useFirstEmailSplit — runs started elsewhere', () => {
  // A run the BACKGROUND job (or another pane) started for this thread: the
  // pane shows it running, and re-reads once its save is answered — not when
  // the hub says "done", which comes before the save.
  it('shows a run in flight and re-reads after its save', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST) });
    await mount({ ...AUTO, chatActive: false }, depsFor(bridge));
    const before = gets.length;

    const hold = deferred<SplitOutcome>();
    const source: FirstSplitBridge = {
      get: async () => ({ success: true, data: { ...answerFor(FIRST), source: FIRST, roster: [] } }),
      save: async () => ({ success: true, data: { applied: true, status: 'ok' } }),
    };
    const statusRef: { current?: (status: string) => void } = {};
    const background = runFirstSplit({ accountId: 'acct-b', threadId: 't1' }, { trigger: 'background' }, {
      bridge: source,
      provider: () => PROVIDER,
      split: (input) => {
        statusRef.current = input.onStatus;
        return hold.promise;
      },
    });
    await settle();
    expect(latest!.running).toBe(true);
    const whileRunning = gets.length;

    // A status update from the same run: shown, and not a second re-read.
    act(() => { statusRef.current?.('AI provider busy — retrying in 8s'); });
    await settle();
    expect(latest!.status).toBe('AI provider busy — retrying in 8s');
    expect(gets.length).toBe(whileRunning);

    hold.resolve({
      status: 'ok', parts: loopedInParts(), regions: 4, chunks: 1, fallbackRegions: 0, aiParts: 4, fallbackParts: 0, rejected: {},
    });
    await background;
    await settle();
    await settle();
    expect(latest!.running).toBe(false);
    expect(gets.length).toBeGreaterThan(before);
  });

  // The background job's real path: it hands the run main's answer
  // (`prefetched`), so the run publishes "running" synchronously — before the
  // single-flight has registered it. With no status update to look again, a
  // pane that only watched on "running" never re-read after the job's save
  // and kept showing the stale state (List view: nothing else re-reads it).
  it('re-reads after a background run started with a prefetched answer, with no status update', async () => {
    const { bridge, gets } = bridgeWith({ t1: answerFor(FIRST) });
    await mount({ ...AUTO, chatActive: false }, depsFor(bridge));
    const before = gets.length;

    const hold = deferred<SplitOutcome>();
    const saveHeld = deferred<{ success: boolean; data: { applied: boolean; status: 'ok' } }>();
    const source: FirstSplitBridge = {
      get: vi.fn(async () => { throw new Error('a prefetched run must not read again'); }),
      save: vi.fn(() => saveHeld.promise),
    };
    const background = runFirstSplit({ accountId: 'acct-b', threadId: 't1' }, {
      trigger: 'background',
      prefetched: { ...answerFor(FIRST), source: FIRST, roster: [] },
    }, {
      bridge: source,
      provider: () => PROVIDER,
      split: () => hold.promise,
    });
    await settle();
    expect(latest!.running).toBe(true);

    hold.resolve({
      status: 'ok', parts: loopedInParts(), regions: 4, chunks: 1, fallbackRegions: 0, aiParts: 4, fallbackParts: 0, rejected: {},
    });
    await settle();
    // The hub said "done", but the save has not been answered: no re-read yet.
    expect(latest!.running).toBe(false);
    expect(gets.length).toBe(before);

    saveHeld.resolve({ success: true, data: { applied: true, status: 'ok' } });
    await background;
    await settle();
    await settle();
    expect(gets.length).toBe(before + 1);
    expect(source.get).not.toHaveBeenCalled();
  });

  // The same thread id in another account is another thread: its runs are
  // not this pane's.
  it('ignores a run for the same thread id in another account', async () => {
    const { bridge } = bridgeWith({ t1: answerFor(FIRST) });
    await mount({ ...AUTO, chatActive: false }, depsFor(bridge));
    const hold = deferred<SplitOutcome>();
    const source: FirstSplitBridge = {
      get: async () => ({ success: true, data: { ...answerFor(FIRST), source: FIRST, roster: [] } }),
      save: async () => ({ success: true, data: { applied: true, status: 'ok' } }),
    };
    const other = runFirstSplit({ accountId: 'acct-a', threadId: 't1' }, { trigger: 'background' }, {
      bridge: source,
      provider: () => PROVIDER,
      split: () => hold.promise,
    });
    await settle();
    expect(latest!.running).toBe(false);
    hold.resolve({ status: 'transient', errorKind: 'timeout', regions: 1, chunks: 1, fallbackRegions: 0, aiParts: 0, fallbackParts: 0, rejected: {} });
    await other;
  });
});
