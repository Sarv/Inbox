import type { AccountFollowUp } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { countDue, followUpsForThread, subscribeFollowUps, useFollowUpsStore } from '../../../../src/store/follow-ups-store';

// The one renderer list behind the Follow-ups view, its sidebar badge and the
// thread banner. What breaks: a dismiss that lingers on screen, a badge that
// counts pending reminders as due, a banner that shows another account's
// reminder on a thread id that happens to match, or a view that never
// refreshes when the checker marks something due.

const followUp = (id: string, over: Partial<AccountFollowUp> = {}): AccountFollowUp => ({
  id,
  accountId: 'acct-a',
  messageId: `<${id}@x>`,
  subject: id,
  recipients: '',
  fromAddress: 'me@example.com',
  sentAt: 1,
  dueAt: 2,
  status: 'pending',
  resolvedAt: null,
  emailId: `e-${id}`,
  threadId: `t-${id}`,
  ...over,
});

const api = {
  list: vi.fn(),
  dismiss: vi.fn(),
  onChanged: vi.fn(),
};

beforeEach(() => {
  api.list.mockReset().mockResolvedValue({ success: true, data: [followUp('a')] });
  api.dismiss.mockReset().mockResolvedValue({ success: true });
  api.onChanged.mockReset().mockReturnValue(() => {});
  (globalThis as any).window = { electronAPI: { followUps: api } };
  useFollowUpsStore.setState({ items: [], loaded: false });
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe('refresh', () => {
  it('loads the open reminders', async () => {
    await useFollowUpsStore.getState().refresh();
    expect(useFollowUpsStore.getState()).toMatchObject({ items: [followUp('a')], loaded: true });
  });

  // A failed read keeps what is on screen instead of blanking the list.
  it('keeps the current list when the read fails or throws', async () => {
    useFollowUpsStore.setState({ items: [followUp('kept')] });
    api.list.mockResolvedValueOnce({ success: false, error: 'boom' });
    await useFollowUpsStore.getState().refresh();
    api.list.mockRejectedValueOnce(new Error('main restarting'));
    await useFollowUpsStore.getState().refresh();
    expect(useFollowUpsStore.getState().items.map((f) => f.id)).toEqual(['kept']);
  });
});

describe('dismiss', () => {
  // Gone from the list at once, sent to its own account, then re-read.
  it('drops it immediately, dismisses it in its account and refreshes', async () => {
    useFollowUpsStore.setState({ items: [followUp('a'), followUp('b', { accountId: 'acct-b' })] });
    api.list.mockResolvedValueOnce({ success: true, data: [followUp('a')] });
    const pending = useFollowUpsStore.getState().dismiss({ id: 'b', accountId: 'acct-b' });
    expect(useFollowUpsStore.getState().items.map((f) => f.id)).toEqual(['a']);
    await pending;
    expect(api.dismiss).toHaveBeenCalledWith('b', 'acct-b');
    expect(api.list).toHaveBeenCalled();
  });

  // The pre-account slot ('') is the active account on the main side.
  it('sends no account for the pre-account slot', async () => {
    await useFollowUpsStore.getState().dismiss({ id: 'x', accountId: '' });
    expect(api.dismiss).toHaveBeenCalledWith('x', undefined);
  });
});

describe('countDue', () => {
  it('counts only due reminders', () => {
    expect(countDue([followUp('a'), followUp('b', { status: 'due' })])).toBe(1);
  });
});

describe('followUpsForThread', () => {
  const items = [
    followUp('mine', { threadId: 't1' }),
    followUp('other-account', { threadId: 't1', accountId: 'acct-b' }),
    followUp('pre-account', { threadId: 't1', accountId: '' }),
    followUp('other-thread', { threadId: 't2' }),
  ];

  // Thread ids are per-account DB ids: another account's t1 is another thread.
  it('matches the thread within its account', () => {
    expect(followUpsForThread(items, 't1', 'acct-a').map((f) => f.id)).toEqual(['mine', 'pre-account']);
    expect(followUpsForThread(items, 't1', null, 'acct-b').map((f) => f.id)).toEqual(['other-account', 'pre-account']);
  });

  it('matches any account when none is known, and nothing without a thread', () => {
    expect(followUpsForThread(items, 't1', null)).toHaveLength(3);
    expect(followUpsForThread(items, null, 'acct-a')).toEqual([]);
  });
});

describe('subscribeFollowUps', () => {
  // Loads now and again on every main-process change.
  it('refreshes on start and on each change, and unsubscribes', async () => {
    const off = vi.fn();
    let changed: () => void = () => {};
    api.onChanged.mockImplementation((cb: () => void) => { changed = cb; return off; });
    const unsubscribe = subscribeFollowUps();
    expect(api.list).toHaveBeenCalledTimes(1);
    changed();
    expect(api.list).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(off).toHaveBeenCalled();
  });

  it('tolerates a preload without the change channel', () => {
    (globalThis as any).window = { electronAPI: { followUps: { list: api.list } } };
    expect(() => subscribeFollowUps()()).not.toThrow();
  });
});
