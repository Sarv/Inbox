// @vitest-environment happy-dom
// The run splits real bodies (regions, cleaning) with the DOM.
import { isUsableSplit, parseFirstSplitParts } from '@sarvinbox/core/first-split';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AIProvider } from '../../../../../src/services/ai-service';
import type { CompleteFn } from '../../../../../src/services/first-split/split-first-email';
import {
  automaticRunAllowed,
  firstSplitSettled,
  MAX_AUTOMATIC_RUNS_PER_KEY,
  providerSignatureOf,
  resetFirstSplitStoreForTests,
  runFirstSplit,
  subscribeFirstSplitProgress,
  type FirstSplitProgress,
} from '../../../../../src/services/first-split/store';
import {
  ALICE_TEXT,
  BOB_TEXT,
  CAROL_TEXT,
  DAN_TEXT,
  loopedInEmail,
} from '../../components/email-detail/looped-in-fixture';

import { createFakeBridge, type FakeBridge } from './fake-bridge';

/**
 * Running a split for one thread of one account.
 *
 * What breaks if this file goes red: a retry double-applies (two concurrent
 * runs pay twice and race their saves), an idempotent re-open pays for a split
 * it already has, account B's split lands in account A's database (or A's is
 * shown for B's thread with the same id), an interrupted run leaves a half
 * write, a stale-key loop keeps calling the model on every open, or a failed
 * re-split destroys the good split it was meant to improve.
 */

const answer = JSON.stringify({
  messages: [
    { region: 3, from_address: 'alice@acme.example', body: `<div>${ALICE_TEXT}</div>`, date: '' },
    { region: 2, from_address: 'bob@acme.example', body: `<div>${BOB_TEXT}</div>`, date: '' },
    { region: 1, from_address: 'carol@acme.example', body: `<div>${CAROL_TEXT}</div>`, date: '' },
    { region: 0, from_address: 'dan@acme.example', body: `<div>${DAN_TEXT}</div>`, date: '' },
  ],
});

const PROVIDER = { id: 'p1', type: 'openai', model: 'gpt-x', name: 'P', apiKey: 'k', isDefault: true } as unknown as AIProvider;

let bridge: FakeBridge;
let complete: ReturnType<typeof vi.fn<CompleteFn>>;
const deps = () => ({
  bridge,
  complete,
  provider: () => PROVIDER,
  regionOptions: { registerImage: (src: string) => src },
});
const A = { accountId: 'acct-a', threadId: 't1' };
const B = { accountId: 'acct-b', threadId: 't1' };

beforeEach(() => {
  resetFirstSplitStoreForTests();
  bridge = createFakeBridge();
  complete = vi.fn<CompleteFn>(async () => answer);
  bridge.seed('acct-a', 't1', loopedInEmail());
});

describe('runFirstSplit', () => {
  it('splits, saves once under main’s key, and records quote count and provider', async () => {
    const result = await runFirstSplit(A, { trigger: 'open' }, deps());
    expect(result.state).toBe('saved');
    expect(bridge.saves).toHaveLength(1);
    const { request, accountId } = bridge.saves[0]!;
    expect(accountId).toBe('acct-a');
    expect(request).toMatchObject({ status: 'ok', quoteCount: 3, modelUsed: providerSignatureOf(PROVIDER) });
    expect(Object.keys(request.key).sort()).toEqual(['fingerprint', 'firstEmailId', 'firstKey', 'threadId']);
    const row = bridge.row('acct-a', 't1')!;
    expect(parseFirstSplitParts(row.parts)).toHaveLength(4);
  });

  // Single-flight: the background job and the open thread (or a click on
  // Process now during an automatic run) must not pay twice.
  it('calls the model once for two concurrent runs, forced or not', async () => {
    let release!: (value: string) => void;
    complete.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = runFirstSplit(A, { trigger: 'open' }, deps());
    const second = runFirstSplit(A, { trigger: 'manual', force: true }, deps());
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    release(answer);
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(bridge.saves).toHaveLength(1);
  });

  // Idempotent re-run: a usable split for the current key is answered from
  // the cache, with no AI call and no write.
  it('answers from a usable split without calling the model', async () => {
    await runFirstSplit(A, { trigger: 'open' }, deps());
    complete.mockClear();
    const again = await runFirstSplit(A, { trigger: 'background' }, deps());
    expect(again.state).toBe('usable');
    expect(complete).not.toHaveBeenCalled();
    expect(bridge.saves).toHaveLength(1);
  });

  // Multi-account: the same thread id in two account databases is two
  // independent threads — each run reads and writes its own account.
  it('keeps accounts A and B apart for the same thread id', async () => {
    bridge.seed('acct-b', 't1', loopedInEmail({ rawBody: loopedInEmail().rawBody + '<p>b</p>' }));
    await runFirstSplit(A, { trigger: 'open' }, deps());
    await runFirstSplit(B, { trigger: 'open' }, deps());
    expect(complete).toHaveBeenCalledTimes(2);
    expect(bridge.gets.map((each) => each.accountId)).toEqual(['acct-a', 'acct-b']);
    expect(bridge.saves.map((each) => each.accountId)).toEqual(['acct-a', 'acct-b']);
    expect(bridge.row('acct-a', 't1')!.sourceFingerprint).not.toBe(bridge.row('acct-b', 't1')!.sourceFingerprint);
  });

  // An interrupted run (the app closed mid-call) wrote nothing; the next
  // session's run writes exactly once.
  it('writes nothing from a run that never finishes, and once from the next', async () => {
    complete.mockImplementationOnce(() => new Promise<string>(() => {}));
    void runFirstSplit(A, { trigger: 'open' }, deps());
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(bridge.saves).toHaveLength(0);

    vi.resetModules(); // a new session: fresh single-flight and guard
    const fresh = await import('../../../../../src/services/first-split/store');
    const result = await fresh.runFirstSplit(A, { trigger: 'open' }, deps());
    expect(result.state).toBe('saved');
    expect(bridge.saves).toHaveLength(1);
  });

  // The session guard: a save refused as stale (the first email changed under
  // the run) must not turn every open into another paid call.
  it('caps automatic re-runs after stale saves, but not manual ones', async () => {
    const e1 = loopedInEmail();
    // Every save finds the stored body changed since the read.
    const originalSave = bridge.save.bind(bridge);
    bridge.save = async (accountId, request) => {
      bridge.setSource('acct-a', 't1', { ...e1, rawBody: e1.rawBody + '<p>healed</p>' });
      const result = await originalSave(accountId, request);
      bridge.setSource('acct-a', 't1', e1);
      return result;
    };
    for (let i = 0; i < MAX_AUTOMATIC_RUNS_PER_KEY; i++) {
      const result = await runFirstSplit(A, { trigger: 'open' }, deps());
      expect(result).toMatchObject({ state: 'saved', save: { applied: false, reason: 'stale' } });
    }
    const capped = await runFirstSplit(A, { trigger: 'open' }, deps());
    expect(capped.state).toBe('guarded');
    expect(complete).toHaveBeenCalledTimes(MAX_AUTOMATIC_RUNS_PER_KEY);
    const got = await bridge.get('acct-a', 't1');
    expect(automaticRunAllowed('acct-a', got.data!.current!)).toBe(false);
    // A click is never capped.
    expect((await runFirstSplit(A, { trigger: 'manual' }, deps())).state).toBe('saved');
    expect(complete).toHaveBeenCalledTimes(MAX_AUTOMATIC_RUNS_PER_KEY + 1);
  });

  // Regression: the guard counted EVERY automatic run, so a key whose runs
  // kept PERSISTING a transient row (with its backoff) stopped at two per
  // session — the stored attempts cap (5) could never be reached, and the
  // scheduler kept re-nominating a due row the guard would never run. A
  // persisted failure is bounded by its own backoff, not by the guard.
  it('does not count automatic runs whose transient failure was persisted', async () => {
    complete.mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
    for (let i = 0; i < MAX_AUTOMATIC_RUNS_PER_KEY + 1; i++) {
      const result = await runFirstSplit(A, { trigger: i === 0 ? 'open' : 'background' }, deps());
      expect(result).toMatchObject({ state: 'saved', save: { applied: true, status: 'transient' } });
    }
    expect(complete).toHaveBeenCalledTimes(MAX_AUTOMATIC_RUNS_PER_KEY + 1);
    expect(bridge.row('acct-a', 't1')).toMatchObject({ status: 'transient', attempts: MAX_AUTOMATIC_RUNS_PER_KEY + 1 });
    const got = await bridge.get('acct-a', 't1');
    expect(automaticRunAllowed('acct-a', got.data!.current!)).toBe(true);
  });

  // The runs that leave NO trace are the ones the guard exists for: a
  // provider-wide failure, a save that errored, a split that threw. Without
  // counting them every open would pay again (or hit the dead provider again).
  it('counts provider failures, save errors and throws against the guard', async () => {
    complete.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
    expect((await runFirstSplit(A, { trigger: 'open' }, deps())).state).toBe('provider');
    const throwing = { ...deps(), split: async () => { throw new Error('DOM gone'); } };
    expect(await runFirstSplit(A, { trigger: 'background' }, throwing)).toEqual({ state: 'error', error: 'DOM gone' });
    const got = await bridge.get('acct-a', 't1');
    expect(automaticRunAllowed('acct-a', got.data!.current!)).toBe(false);
    expect((await runFirstSplit(A, { trigger: 'open' }, deps())).state).toBe('guarded');

    // A save that errored counts too (a fresh key: another thread).
    bridge.seed('acct-a', 't2', loopedInEmail());
    const erroring = { ...deps(), bridge: { ...bridge, save: async () => ({ success: false, error: 'db locked' }) } };
    const T2 = { accountId: 'acct-a', threadId: 't2' };
    for (let i = 0; i < MAX_AUTOMATIC_RUNS_PER_KEY; i++) {
      expect(await runFirstSplit(T2, { trigger: 'open' }, erroring)).toEqual({ state: 'error', error: 'db locked' });
    }
    expect((await runFirstSplit(T2, { trigger: 'open' }, erroring)).state).toBe('guarded');
    // Manual runs are never counted nor stopped.
    expect((await runFirstSplit(T2, { trigger: 'manual' }, deps())).state).toBe('saved');
  });

  // A forced re-split that fails transiently must leave the good split alone.
  it('keeps the previous ok split when a forced re-split fails transiently', async () => {
    await runFirstSplit(A, { trigger: 'open' }, deps());
    const good = bridge.row('acct-a', 't1');
    complete.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));
    const result = await runFirstSplit(A, { trigger: 'manual' }, deps());
    expect(result).toMatchObject({ state: 'saved', save: { applied: false, reason: 'kept' } });
    expect(bridge.row('acct-a', 't1')).toBe(good);
    const got = await bridge.get('acct-a', 't1');
    expect(isUsableSplit(got.data!.row, got.data!.current)).toBe(true);
  });

  // Provider-wide failures are not this thread's: nothing is written.
  it('writes nothing for a provider-wide failure', async () => {
    complete.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const result = await runFirstSplit(A, { trigger: 'open' }, deps());
    expect(result.state).toBe('provider');
    expect(bridge.saves).toHaveLength(0);
  });

  // Nothing main can vouch for: no member, no body yet, or a record that is
  // not the first member — no AI, no write.
  it('does nothing without a current key or a source body', async () => {
    bridge.seed('acct-a', 't2', null);
    bridge.seed('acct-a', 't3', loopedInEmail({ rawBody: '', cleanBody: 'preview only' }));
    expect(await runFirstSplit({ accountId: 'acct-a', threadId: 't2' }, { trigger: 'open' }, deps())).toEqual({ state: 'unknown' });
    expect(await runFirstSplit({ accountId: 'acct-a', threadId: 't3' }, { trigger: 'open' }, deps())).toEqual({ state: 'unknown' });
    const got = (await bridge.get('acct-a', 't1', { withSource: true })).data!;
    const mismatched = { ...got, source: loopedInEmail({ id: 'other', messageId: '<other@acme.example>' }) };
    expect(await runFirstSplit(A, { trigger: 'background', prefetched: mismatched }, deps())).toEqual({ state: 'unknown' });
    expect(complete).not.toHaveBeenCalled();
    expect(bridge.saves).toHaveLength(0);
  });

  // The background job already read main's answer; the run must not re-read.
  it('uses a prefetched answer without another get', async () => {
    const got = (await bridge.get('acct-a', 't1', { withSource: true })).data!;
    bridge.gets.length = 0;
    await runFirstSplit(A, { trigger: 'background', prefetched: got }, deps());
    expect(bridge.gets).toHaveLength(0);
    expect(bridge.saves).toHaveLength(1);
  });

  it('reports an IPC failure as an error, never throwing', async () => {
    expect(await runFirstSplit({ accountId: 'nope', threadId: 't1' }, { trigger: 'open' }, deps()))
      .toMatchObject({ state: 'error' });
    bridge.save = async () => ({ success: false, error: 'db locked' });
    expect(await runFirstSplit(A, { trigger: 'open' }, deps())).toMatchObject({ state: 'error', error: 'db locked' });
    bridge.get = async () => { throw new Error('bridge gone'); };
    expect(await runFirstSplit(A, { trigger: 'manual' }, deps())).toMatchObject({ state: 'error', error: 'bridge gone' });
  });

  // The waiting UI follows a run: running with status text, then done.
  it('publishes progress to subscribers, late joiners included', async () => {
    const seen: FirstSplitProgress[] = [];
    complete.mockImplementationOnce(async (options) => {
      options.onStatus?.('retrying in 8s');
      return answer;
    });
    const unsubscribe = subscribeFirstSplitProgress(A, (progress) => seen.push(progress));
    await runFirstSplit(A, { trigger: 'open' }, deps());
    unsubscribe();
    expect(seen).toEqual([
      { running: true, status: null },
      { running: true, status: 'retrying in 8s' },
      { running: false, status: null },
    ]);
    const late: FirstSplitProgress[] = [];
    subscribeFirstSplitProgress(A, (progress) => late.push(progress))();
    expect(late).toEqual([{ running: false, status: null }]);
  });
});

// The reading pane re-reads the cache when a run for its thread settles —
// whoever started it. The progress hub's "done" comes BEFORE the save, so the
// pane waits on the run itself; this is how it finds it.
describe('firstSplitSettled', () => {
  it('is the run in flight for exactly that account and thread, and nothing once it settled', async () => {
    let release!: (value: string) => void;
    complete.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    expect(firstSplitSettled(A)).toBeUndefined();
    const run = runFirstSplit(A, { trigger: 'background' }, deps());
    const pending = firstSplitSettled(A)!;
    expect(pending).toBeDefined();
    // Same thread id, another account: another run (none here).
    expect(firstSplitSettled(B)).toBeUndefined();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    release(answer);
    const settled = await pending;
    expect(settled).toBe(await run);
    // Its save was answered by the time it settled.
    expect(bridge.saves).toHaveLength(1);
    expect(firstSplitSettled(A)).toBeUndefined();
  });
});

describe('providerSignatureOf', () => {
  it('changes with the provider or its model, and is null without one', () => {
    expect(providerSignatureOf(null)).toBeNull();
    expect(providerSignatureOf(PROVIDER)).not.toBe(providerSignatureOf({ ...PROVIDER, model: 'gpt-y' } as AIProvider));
  });
});

describe('runFirstSplit — the defaults', () => {
  // Without injected deps the run talks to the preload bridge, naming the
  // account on every call (main never falls back to the active account).
  it('uses window.electronAPI.ai, with the account on every call', async () => {
    const getFirstSplit = vi.fn(bridge.get);
    const saveFirstSplit = vi.fn(bridge.save);
    (window as unknown as { electronAPI: unknown }).electronAPI = { ai: { getFirstSplit, saveFirstSplit } };
    localStorage.clear(); // no provider configured: the result records none
    const result = await runFirstSplit(A, { trigger: 'open' }, { complete, regionOptions: { registerImage: (src) => src } });
    expect(result.state).toBe('saved');
    expect(getFirstSplit).toHaveBeenCalledWith('acct-a', 't1', { withSource: true });
    expect(saveFirstSplit.mock.calls[0]![0]).toBe('acct-a');
    expect(saveFirstSplit.mock.calls[0]![1].modelUsed).toBeNull();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  // Progress hubs are bounded: a very long session evicts the oldest idle one.
  it('evicts the oldest idle progress hub once the bound is reached', async () => {
    await runFirstSplit(A, { trigger: 'open' }, deps());
    const replayed = (ref: { accountId: string; threadId: string }) => {
      const seen: FirstSplitProgress[] = [];
      subscribeFirstSplitProgress(ref, (progress) => seen.push(progress))();
      return seen;
    };
    expect(replayed(A)).toHaveLength(1);
    for (let index = 0; index < 500; index++) replayed({ accountId: 'acct-a', threadId: `other-${index}` });
    expect(replayed(A)).toHaveLength(0);
  });

  // The open thread's banner is subscribed: its hub must survive any number
  // of other threads' runs, or it would miss the next run's progress.
  it('never evicts a hub somebody is watching', async () => {
    await runFirstSplit(A, { trigger: 'open' }, deps());
    const seen: FirstSplitProgress[] = [];
    const unsubscribe = subscribeFirstSplitProgress(A, (progress) => seen.push(progress));
    for (let index = 0; index < 600; index++) {
      subscribeFirstSplitProgress({ accountId: 'acct-a', threadId: `other-${index}` }, () => {})();
    }
    await runFirstSplit(A, { trigger: 'manual' }, deps());
    expect(seen.filter((progress) => progress.running)).not.toHaveLength(0);
    unsubscribe();
    unsubscribe(); // twice is harmless
  });
});

describe('runFirstSplit — IPC edges', () => {
  it('reports an answer with no data and no message as "no data"', async () => {
    expect(await runFirstSplit(A, { trigger: 'open' }, { ...deps(), bridge: { ...bridge, get: async () => ({ success: false }) } }))
      .toEqual({ state: 'error', error: 'no data' });
    expect(await runFirstSplit(A, { trigger: 'manual' }, { ...deps(), bridge: { ...bridge, save: async () => ({ success: true }) } }))
      .toEqual({ state: 'error', error: 'no data' });
  });

  it('reports a non-Error throw by its text', async () => {
    const throwing = { ...bridge, get: async () => { throw 'bridge string'; } };
    expect(await runFirstSplit(A, { trigger: 'open' }, { ...deps(), bridge: throwing })).toEqual({ state: 'error', error: 'bridge string' });
  });

  // A prefetched answer without a roster (an older main) still splits.
  it('splits a prefetched answer that carries no roster', async () => {
    const got = (await bridge.get('acct-a', 't1', { withSource: true })).data!;
    const { roster: _roster, ...withoutRoster } = got;
    expect((await runFirstSplit(A, { trigger: 'background', prefetched: withoutRoster }, deps())).state).toBe('saved');
  });
});
