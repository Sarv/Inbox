import { getEventBus } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  storages: [] as Array<{ accountId: string; storage: object }>,
  registry: [] as Array<{ email: string }>,
  identities: new Map<object, string>(),
  identityError: false,
  evidence: new Map<object, Map<string, Record<string, boolean>>>(),
  notify: vi.fn(),
}));
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: h.notify } }),
}));
vi.mock('../../../../electron/services/account-target', () => ({ openAccountStorages: () => h.storages }));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  listRegistryAccounts: () => h.registry,
  resolveAccountEmail: (storage: object) => {
    if (h.identityError) throw new Error('Identity lookup failed');
    return h.identities.get(storage) ?? '';
  },
}));

import { contactClassificationIdentities, refreshContactClassifications, startContactClassificationRefresh, stopContactClassificationRefresh } from '../../../../electron/services/contact-classification-service';

const account = (id: string, email: string, changes = 1) => {
  const classify = vi.fn(() => changes);
  const storage = { getRepositories: () => ({ agent: {
    autoClassifyContacts: classify,
    getContactClassificationEvidence: () => h.evidence.get(storage) ?? new Map(),
  } }) };
  h.storages.push({ accountId: id, storage });
  h.identities.set(storage, email);
  return classify;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  h.storages = [];
  h.registry = [];
  h.identities.clear();
  h.identityError = false;
  h.evidence.clear();
  h.notify.mockClear();
});
afterEach(() => {
  stopContactClassificationRefresh();
  vi.useRealTimers();
});

describe('shared contact classification refresh', () => {
  it('passes all owned identities to every open account and sums its changed contacts', () => {
    const first = account('a', 'me@one.example', 2);
    const second = account('b', 'me@two.example', 3);
    h.registry = [{ email: 'alias@three.example' }];
    expect(refreshContactClassifications('stale@wrong.example')).toBe(5);
    for (const classify of [first, second]) expect(classify).toHaveBeenCalledWith([
      'alias@three.example', 'me@one.example', 'me@two.example',
    ], expect.any(Map));
  });

  it('refreshes automatically after the throttle and immediately after identities change', () => {
    const classify = account('a', 'me@one.example');
    refreshContactClassifications();
    refreshContactClassifications();
    expect(classify).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_000);
    refreshContactClassifications();
    expect(classify).toHaveBeenCalledTimes(2);
    h.registry.push({ email: 'me@two.example' });
    refreshContactClassifications();
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('forces a fresh pass after scan or explicit classification without waiting', () => {
    const classify = account('a', 'me@one.example');
    refreshContactClassifications();
    refreshContactClassifications(undefined, true);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('uses the profile only when no connected identity exists', () => {
    expect(contactClassificationIdentities('profile@one.example')).toEqual(['profile@one.example']);
    h.registry.push({ email: 'connected@two.example' });
    expect(contactClassificationIdentities('profile@one.example')).toEqual(['connected@two.example']);
  });

  it('keeps other accounts working when one repository fails', () => {
    const broken = account('a', 'me@one.example');
    broken.mockImplementation(() => { throw new Error('Unavailable database'); });
    const healthy = account('b', 'me@two.example', 4);
    expect(refreshContactClassifications()).toBe(4);
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('keeps classification available when an account identity cannot be resolved', () => {
    const classify = account('a', 'me@one.example');
    h.registry = [{ email: 'registered@one.example' }];
    h.identityError = true;
    expect(refreshContactClassifications()).toBe(1);
    expect(classify).toHaveBeenCalledWith(['registered@one.example'], expect.any(Map));
  });

  it('combines evidence from every mailbox before writing the shared contact classification', () => {
    const first = account('a', 'me@one.example');
    const second = account('b', 'me@two.example');
    h.evidence.set(h.storages[0]!.storage, new Map([['person@client.example', { vendor: true, customer: false }]]));
    h.evidence.set(h.storages[1]!.storage, new Map([['person@client.example', { vendor: false, customer: true }]]));
    refreshContactClassifications();
    for (const classify of [first, second]) expect(classify).toHaveBeenCalledWith(
      ['me@one.example', 'me@two.example'], new Map([['person@client.example', { vendor: true, customer: true }]]),
    );
  });

  it('does not erase shared relationship data when one mailbox evidence read fails', () => {
    const classify = account('a', 'me@one.example');
    h.storages.push({ accountId: 'b', storage: { getRepositories: () => { throw new Error('Locked mailbox'); } } });
    expect(refreshContactClassifications()).toBe(0);
    expect(classify).not.toHaveBeenCalled();
  });

  it('automatically refreshes an arrival burst once without any Contacts IPC request', () => {
    const classify = account('a', 'me@one.example');
    startContactClassificationRefresh();
    startContactClassificationRefresh();
    const bus = getEventBus();
    for (let i = 0; i < 100; i++) bus.emit({ type: 'email:synced', isNew: true, emailId: `email-${i}` } as any);
    expect(classify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(classify).toHaveBeenCalledOnce();
    bus.emit({ type: 'email:body-ready', emailId: 'email-next' } as any);
    vi.advanceTimersByTime(30_000);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('cleans up listeners and a pending burst timer when the pipeline stops', () => {
    const classify = account('a', 'me@one.example');
    startContactClassificationRefresh();
    getEventBus().emit({ type: 'email:synced', isNew: true, emailId: 'email' } as any);
    stopContactClassificationRefresh();
    vi.advanceTimersByTime(30_000);
    expect(classify).not.toHaveBeenCalled();
    getEventBus().emit({ type: 'email:synced', isNew: true, emailId: 'after-stop' } as any);
    vi.advanceTimersByTime(30_000);
    expect(classify).not.toHaveBeenCalled();
  });

  it('notifies Contacts once for changed labels and never for unchanged refreshes', () => {
    const classify = account('a', 'me@one.example');
    account('b', 'me@two.example', 0);
    expect(refreshContactClassifications()).toBe(1);
    expect(h.notify).toHaveBeenCalledExactlyOnceWith('contacts:updated');
    // A renderer reload triggered by this event hits the throttle, then later
    // unchanged background passes also stay quiet instead of causing a loop.
    expect(refreshContactClassifications()).toBe(0);
    classify.mockReturnValue(0);
    expect(refreshContactClassifications(undefined, true)).toBe(0);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});
