// @vitest-environment happy-dom
// The job reads first-email facts (a DOM split) and the settings in localStorage.
import { setLogLevel } from '@sarvinbox/core/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_CONFIG_KEY, loadAgentSettings, saveAgentSettings } from '../../../../../src/services/agent-settings';
import { reportAIHealthy, reportAIUnhealthy, type AIProvider } from '../../../../../src/services/ai-service';
import {
  backgroundSplitAllowed,
  createFirstSplitJob,
  initializeFirstSplitJob,
  MAX_QUEUED_REFS,
  processCandidate,
  removeFirstSplitJob,
  type FirstSplitCandidates,
  type FirstSplitJobDeps,
} from '../../../../../src/services/first-split/job';
import type { CompleteFn } from '../../../../../src/services/first-split/split-first-email';
import { resetFirstSplitStoreForTests } from '../../../../../src/services/first-split/store';
import { email } from '../../components/email-detail/email-fixture';
import {
  ALICE_TEXT,
  BOB_TEXT,
  CAROL_TEXT,
  DAN_TEXT,
  LOOPED_AT,
  loopedInEmail,
} from '../../components/email-detail/looped-in-fixture';

import { createFakeBridge, type FakeBridge } from './fake-bridge';

/**
 * The background first-email split.
 *
 * What breaks if this file goes red: background AI is spent on threads that
 * do not need it (a reply quoting one message, bulk mail) or while the reader
 * switched it off or the provider is failing; the same thread is split twice
 * because two nominations raced; ineligible threads are re-nominated forever
 * because nothing recorded them as skipped; or the job logs one line per
 * thread on a first sync of thousands — a hot-path log that stalls the event
 * loop.
 */

const PROVIDER = { id: 'p1', type: 'openai', model: 'gpt-x', name: 'P', apiKey: 'k', isDefault: true } as unknown as AIProvider;
const answer = JSON.stringify({
  messages: [
    { region: 3, from_address: 'alice@acme.example', body: `<div>${ALICE_TEXT}</div>` },
    { region: 2, from_address: 'bob@acme.example', body: `<div>${BOB_TEXT}</div>` },
    { region: 1, from_address: 'carol@acme.example', body: `<div>${CAROL_TEXT}</div>` },
    { region: 0, from_address: 'dan@acme.example', body: `<div>${DAN_TEXT}</div>` },
  ],
});

/** A reply quoting ONE message — offered chat, AI on demand only. */
const singleQuote = () =>
  email({
    id: 'q1',
    date: LOOPED_AT,
    rawBody: [
      '<div dir="ltr">Sounds good.</div>',
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">',
      'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br></div>',
      `<blockquote class="gmail_quote"><div dir="ltr">${ALICE_TEXT}</div></blockquote></div>`,
    ].join(''),
  });

let bridge: FakeBridge;
let complete: ReturnType<typeof vi.fn<CompleteFn>>;
const deps = (overrides: Partial<FirstSplitJobDeps> = {}): FirstSplitJobDeps => ({
  bridge,
  complete,
  gate: () => true,
  provider: () => PROVIDER,
  now: () => LOOPED_AT,
  regionOptions: { registerImage: (src: string) => src },
  ...overrides,
});
const ref = (threadId: string, accountId = 'acct-a') => ({ accountId, threadId });

beforeEach(() => {
  resetFirstSplitStoreForTests();
  bridge = createFakeBridge();
  complete = vi.fn<CompleteFn>(async () => answer);
});
afterEach(() => {
  removeFirstSplitJob();
  setLogLevel('debug');
  vi.restoreAllMocks();
});

describe('processCandidate', () => {
  // A looped-in first email quoting 2+ messages: split in the background.
  it('splits a first email quoting two or more messages', async () => {
    bridge.seed('acct-a', 't1', loopedInEmail());
    expect(await processCandidate(ref('t1'), deps())).toBe('split');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(bridge.row('acct-a', 't1')!.status).toBe('ok');
  });

  // 0 or 1 quotes (or bulk mail): recorded `skipped` with the count and NO
  // model call, so the scheduler stops nominating the thread.
  it.each([
    ['one quoted message', () => singleQuote(), 1],
    ['nothing quoted', () => email({ id: 'p1', rawBody: '<p>Just a note.</p>' }), 0],
    ['a plain-text reply with one attribution (marker count)', () =>
      email({ id: 'x1', contentType: 'text', rawBody: 'Fine by me.\n\nOn Tue, 3 Mar 2026 at 10:00, Alice Chen <alice@acme.example> wrote:\nSee you Friday.' }), 1],
  ])('saves skipped without a model call for %s', async (_label, make, quoteCount) => {
    bridge.seed('acct-a', 't1', make());
    expect(await processCandidate(ref('t1'), deps())).toBe('skipped');
    expect(complete).not.toHaveBeenCalled();
    expect(bridge.row('acct-a', 't1')).toMatchObject({ status: 'skipped', quoteCount });
  });

  // Idempotent: a thread already recorded skipped for this key is not
  // written again.
  it('does not re-save a thread already skipped for the current key', async () => {
    bridge.seed('acct-a', 't1', singleQuote());
    await processCandidate(ref('t1'), deps());
    await processCandidate(ref('t1'), deps());
    expect(bridge.saves).toHaveLength(1);
  });

  it('saves skipped for designed bulk mail from one sender', async () => {
    bridge.seed('acct-a', 't1', email({
      id: 'k1',
      fromAddress: 'no-reply@kekamail.com',
      messageId: '<k1@kekamail.com>',
      tags: '|INBOX|bulk|',
      rawBody: '<table role="presentation" bgcolor="#fff"><tr><td>Digest</td></tr></table>',
    }), { distinctSenders: 1 });
    expect(await processCandidate(ref('t1'), deps())).toBe('skipped');
    expect(complete).not.toHaveBeenCalled();
  });

  // UNKNOWN is not 0: a first email whose body has not arrived is left for a
  // later nomination, never recorded as skipped.
  it('writes nothing when the first email’s body has not arrived', async () => {
    bridge.seed('acct-a', 't1', loopedInEmail({ rawBody: '' }));
    bridge.seed('acct-a', 't2', null);
    expect(await processCandidate(ref('t1'), deps())).toBe('unknown');
    expect(await processCandidate(ref('t2'), deps())).toBe('unknown');
    expect(bridge.saves).toHaveLength(0);
  });

  it('leaves a usable split, a backing-off retry and a permanent failure alone', async () => {
    bridge.seed('acct-a', 't1', loopedInEmail());
    await processCandidate(ref('t1'), deps());
    complete.mockClear();
    expect(await processCandidate(ref('t1'), deps())).toBe('cached');

    bridge.seed('acct-a', 't2', loopedInEmail());
    complete.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }));
    expect(await processCandidate(ref('t2'), deps())).toBe('failed'); // the run saved a transient row
    expect(bridge.row('acct-a', 't2')!.status).toBe('transient');
    complete.mockClear();
    expect(await processCandidate(ref('t2'), deps())).toBe('waiting');
    expect(complete).not.toHaveBeenCalled();
  });

  // Regression: the session guard counted every automatic run, so a thread
  // whose first two background runs persisted a transient failure was
  // `guarded` from then on — never retried this session although its row said
  // "due", and re-nominated by the scheduler forever. Persisted failures are
  // bounded by the stored backoff and attempt cap instead.
  it('retries a thread with two persisted transient failures once it is due', async () => {
    bridge.seed('acct-a', 't1', loopedInEmail());
    const later = () => 1_900_000_000; // past every backoff the fake bridge stored
    complete.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }));
    complete.mockRejectedValueOnce(Object.assign(new Error('timeout'), { status: 504 }));
    expect(await processCandidate(ref('t1'), deps({ now: later }))).toBe('failed');
    expect(await processCandidate(ref('t1'), deps({ now: later }))).toBe('failed');
    expect(bridge.row('acct-a', 't1')).toMatchObject({ status: 'transient', attempts: 2 });
    expect(await processCandidate(ref('t1'), deps({ now: later }))).toBe('split');
    expect(complete).toHaveBeenCalledTimes(3);
    expect(bridge.row('acct-a', 't1')!.status).toBe('ok');
  });

  it('is gated before any IPC', async () => {
    bridge.seed('acct-a', 't1', loopedInEmail());
    expect(await processCandidate(ref('t1'), deps({ gate: () => false }))).toBe('gated');
    expect(bridge.gets).toHaveLength(0);
  });

  it('asks the preload bridge by default', async () => {
    const getFirstSplit = vi.fn(bridge.get);
    (window as unknown as { electronAPI: unknown }).electronAPI = { ai: { getFirstSplit, saveFirstSplit: bridge.save } };
    bridge.seed('acct-a', 't1', singleQuote());
    expect(await processCandidate(ref('t1'), { ...deps(), bridge: undefined })).toBe('skipped');
    expect(getFirstSplit).toHaveBeenCalledWith('acct-a', 't1', { withSource: true });
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('reports an IPC failure', async () => {
    expect(await processCandidate(ref('t1', 'unknown-account'), deps())).toBe('error');
  });

  // Multi-account: the same thread id in two accounts is two threads, each
  // written to its own account.
  it('processes the same thread id in two accounts separately', async () => {
    bridge.seed('acct-a', 't1', loopedInEmail());
    bridge.seed('acct-b', 't1', singleQuote());
    expect(await processCandidate(ref('t1', 'acct-a'), deps())).toBe('split');
    expect(await processCandidate(ref('t1', 'acct-b'), deps())).toBe('skipped');
    expect(bridge.row('acct-a', 't1')!.status).toBe('ok');
    expect(bridge.row('acct-b', 't1')!.status).toBe('skipped');
  });
});

describe('backgroundSplitAllowed', () => {
  const setFeatures = (autoExtract: boolean, conversation = true) =>
    localStorage.setItem('sarvinbox-ai-features', JSON.stringify([
      { id: 'conversation-mode', enabled: conversation },
      { id: 'auto-chat-extract', enabled: autoExtract },
    ]));
  const setProvider = (present: boolean) =>
    localStorage.setItem('sarvinbox-ai-settings', JSON.stringify({ providers: present ? [PROVIDER] : [] }));

  beforeEach(() => {
    localStorage.clear();
    reportAIHealthy();
  });
  afterEach(() => reportAIHealthy());

  // Refs are dropped while any switch is off — the scheduler nominates again.
  it('requires conversation mode, auto chat extract, a provider and healthy AI', () => {
    setFeatures(true);
    setProvider(true);
    expect(backgroundSplitAllowed()).toBe(true);
    setFeatures(false);
    expect(backgroundSplitAllowed()).toBe(false);
    setFeatures(true, false);
    expect(backgroundSplitAllowed()).toBe(false);
    setFeatures(true);
    setProvider(false);
    expect(backgroundSplitAllowed()).toBe(false);
    setProvider(true);
    reportAIUnhealthy('Authentication failed');
    expect(backgroundSplitAllowed()).toBe(false);
  });

  // Regression: Skip/onboarding suspension must prevent automatic splitting
  // even when provider credentials and Auto Chat Extract remain saved.
  it('does not transmit a nominated email while AI Assist is disabled', async () => {
    setFeatures(true); setProvider(true);
    const settings = loadAgentSettings();
    saveAgentSettings({ ...settings, enabled: false });
    bridge.seed('acct-a', 't1', loopedInEmail());
    expect(backgroundSplitAllowed()).toBe(false);
    expect(await processCandidate(ref('t1'), deps({ gate: undefined }))).toBe('gated');
    expect(complete).not.toHaveBeenCalled();
    expect(bridge.saves).toHaveLength(0);

    saveAgentSettings({ ...settings, enabled: true });
    expect(await processCandidate(ref('t1'), deps({ gate: undefined }))).toBe('split');
    expect(complete).toHaveBeenCalledOnce();
  });

  // Regression: unreadable consent/enable settings must never act like a fresh
  // opt-in and trigger background mail transmission.
  it('keeps automatic splits gated when the AI Assist setting is unreadable', () => {
    setFeatures(true); setProvider(true);
    localStorage.setItem(AGENT_CONFIG_KEY, 'corrupt');
    expect(backgroundSplitAllowed()).toBe(false);
  });
});

describe('the job queue', () => {
  // Two nominations of the same thread must not split it twice.
  it('dedupes refs and processes them one at a time', async () => {
    let running = 0;
    let peak = 0;
    complete.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return answer;
    });
    for (const id of ['t1', 't2', 't3']) bridge.seed('acct-a', id, loopedInEmail());
    const job = createFirstSplitJob(deps());
    job.enqueue([ref('t1'), ref('t2'), ref('t1')]);
    job.enqueue([ref('t2'), ref('t3'), { threadId: 'no-account' }, null]);
    await job.idle();
    // One get per distinct thread: a duplicate that slipped into the queue
    // would be answered from the cache (so `complete` alone cannot see it),
    // but it still costs a get(withSource) and a DOM split of the source.
    expect(bridge.gets.map((each) => each.threadId)).toEqual(['t1', 't2', 't3']);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(job.size).toBe(0);
  });

  // Breaks: a flood of nominations grows the queue without bound.
  it('caps the queue and drops the overflow', async () => {
    // Open for the nomination, closed per item — so each queued ref is
    // answered at once, without IPC.
    const gate = vi.fn(() => gate.mock.calls.length === 1);
    const job = createFirstSplitJob(deps({ gate }));
    const refs = Array.from({ length: MAX_QUEUED_REFS + 25 }, (_, index) => ref(`t${index}`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    job.enqueue(refs);
    // The first ref is already being processed; the rest wait.
    expect(job.size).toBeLessThanOrEqual(MAX_QUEUED_REFS);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('dropped 25'))).toBe(true);
    await job.idle();
    expect(gate).toHaveBeenCalledTimes(1 + MAX_QUEUED_REFS);
  });

  // Breaks: with 'Auto Chat Extract' off (the default) every 45 s nomination,
  // per account, was queued, re-checked item by item and logged as an info
  // `batch refs=N gated=N` line — ~80 app.log lines an hour per account,
  // forever. A gated nomination is dropped whole, unqueued and unlogged.
  it('drops a nomination whole while background AI is off', async () => {
    bridge.seed('acct-a', 't1', loopedInEmail());
    const get = vi.spyOn(bridge, 'get');
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const job = createFirstSplitJob(deps({ gate: () => false }));
    job.enqueue([ref('t1'), ref('t2')]);
    expect(job.size).toBe(0);
    await job.idle();
    expect(get).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(info.mock.calls.some((call) => String(call[0]).includes('[FirstSplitJob]'))).toBe(false);
  });

  // Breaks: a batch that did nothing (no body yet, already split, backing
  // off, gated mid-drain) writes an info line on every scheduler pass.
  it('logs a batch that did nothing at trace, not info', async () => {
    bridge.seed('acct-a', 't1', loopedInEmail());
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const run = vi.fn(async () => ({ state: 'usable' }) as never);
    // Open for the nomination, closed for t2's item (flipped mid-drain).
    let calls = 0;
    const job = createFirstSplitJob(deps({ run, gate: () => ++calls !== 3 }));
    job.enqueue([ref('t1'), ref('t2')]);
    await job.idle();
    expect(info.mock.calls.some((call) => String(call[0]).includes('[FirstSplitJob]'))).toBe(false);
    setLogLevel('trace');
    job.enqueue([ref('t1')]);
    await job.idle();
    expect(info.mock.calls.some((call) => String(call[0]).includes('[FirstSplitJob]'))).toBe(false);
    expect(debug.mock.calls.some((call) => String(call[0]).includes('[TRACE] [FirstSplitJob] batch refs=1 cached=1'))).toBe(true);
  });

  // Hot-path rule: ONE info line per batch; per-thread lines at trace only.
  it('logs one aggregate line per batch and per-thread lines at trace only', async () => {
    for (const id of ['t1', 't2']) bridge.seed('acct-a', id, loopedInEmail());
    bridge.seed('acct-a', 't3', singleQuote());
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const job = createFirstSplitJob(deps());
    job.enqueue([ref('t1'), ref('t2'), ref('t3')]);
    await job.idle();
    const jobLines = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('[FirstSplitJob]'));
    expect(jobLines).toHaveLength(1);
    expect(jobLines[0]).toContain('batch refs=3 skipped=1 split=2');
    expect(debug.mock.calls.some((call) => String(call[0]).includes('[FirstSplitJob]'))).toBe(false);

    setLogLevel('trace');
    bridge.seed('acct-a', 't4', singleQuote());
    job.enqueue([ref('t4')]);
    await job.idle();
    expect(debug.mock.calls.some((call) => String(call[0]).includes('[TRACE] [FirstSplitJob] thread acct=acct-a thread=t4 -> skipped'))).toBe(true);
  });

  it('counts a thread whose processing threw as an error and carries on', async () => {
    bridge.seed('acct-a', 't2', loopedInEmail());
    const job = createFirstSplitJob(deps({ bridge: { ...bridge, get: async (accountId, threadId, options) => {
      if (threadId === 't1') throw new Error('boom');
      return bridge.get(accountId, threadId, options);
    } } }));
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    job.enqueue([ref('t1'), ref('t2')]);
    await job.idle();
    expect(info.mock.calls.map((call) => String(call[0])).find((line) => line.includes('[FirstSplitJob]')))
      .toContain('batch refs=2 error=1 split=1');
  });
});

describe('initializeFirstSplitJob / removeFirstSplitJob', () => {
  // A duplicate listener would double every background AI call.
  it('registers exactly one listener, and removal clears it', async () => {
    let listener: ((payload: FirstSplitCandidates) => void) | null = null;
    const source = { on: vi.fn((fn: typeof listener) => { listener = fn; }), off: vi.fn(() => { listener = null; }) };
    bridge.seed('acct-a', 't1', loopedInEmail());
    const job = initializeFirstSplitJob(source, deps());
    expect(initializeFirstSplitJob(source, deps())).toBe(job);
    expect(source.on).toHaveBeenCalledTimes(1);
    listener!({ refs: [ref('t1')] });
    listener!({ refs: 'garbage' } as unknown as FirstSplitCandidates);
    await job.idle();
    expect(complete).toHaveBeenCalledTimes(1);
    removeFirstSplitJob();
    removeFirstSplitJob();
    expect(source.off).toHaveBeenCalledTimes(1);
    expect(listener).toBeNull();
  });
});

describe('processCandidate — every run outcome', () => {
  beforeEach(() => bridge.seed('acct-a', 't1', loopedInEmail()));

  it.each([
    [{ state: 'error', error: 'x' } as const, 'error'],
    [{ state: 'usable' } as const, 'cached'],
    // A guarded key is reported apart from one that is backing off.
    [{ state: 'guarded' } as const, 'guarded'],
    [{ state: 'provider' } as const, 'waiting'],
    [{ state: 'saved', outcome: { status: 'transient' } } as const, 'failed'],
    [{ state: 'saved', outcome: { status: 'partial' } } as const, 'split'],
  ])('maps a run that ended %j to %s', async (result, expected) => {
    const run = vi.fn(async () => result as never);
    expect(await processCandidate(ref('t1'), deps({ run }))).toBe(expected);
    expect(run).toHaveBeenCalledWith(ref('t1'), expect.objectContaining({ trigger: 'background' }), expect.anything());
  });

  it('reports a failed skipped-save as an error', async () => {
    bridge.seed('acct-a', 't2', singleQuote());
    const failing = { ...bridge, save: async () => ({ success: false, error: 'db locked' }) };
    expect(await processCandidate(ref('t2'), deps({ bridge: failing }))).toBe('error');
  });

  // No DOM to split with: the facts are unknown, and unknown is never "skip".
  it('writes nothing when the first email cannot be examined', async () => {
    vi.stubGlobal('DOMParser', undefined);
    try {
      expect(await processCandidate(ref('t1'), deps())).toBe('unknown');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bridge.saves).toHaveLength(0);
  });
});

describe('the job queue — edges', () => {
  // A nomination arriving as a batch finishes (after the drain loop's last
  // check, before it hands back) must still be processed, not stranded.
  it('processes a ref that arrives just as a batch ends', async () => {
    bridge.seed('acct-a', 't1', singleQuote());
    bridge.seed('acct-a', 't2', singleQuote());
    const job = createFirstSplitJob(deps());
    let late = true;
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (late && String(line).includes('[FirstSplitJob] batch')) {
        late = false;
        job.enqueue([ref('t2')]);
      }
    });
    job.enqueue([ref('t1')]);
    await job.idle();
    expect(bridge.row('acct-a', 't2')?.status).toBe('skipped');
  });

  it('survives a non-Error thrown while processing', async () => {
    const job = createFirstSplitJob(deps({ bridge: { ...bridge, get: async () => { throw 'string failure'; } } }));
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    job.enqueue([ref('t1')]);
    await job.idle();
    expect(info.mock.calls.map((call) => String(call[0])).find((line) => line.includes('[FirstSplitJob]'))).toContain('error=1');
  });
});
