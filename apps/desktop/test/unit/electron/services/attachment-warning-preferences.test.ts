import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ values: new Map<string, unknown>(), prepare: vi.fn(), failure: false }));
vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: () => {
  if (h.failure) throw new Error('Core store unreadable');
  return { prepare: h.prepare };
} }));

import { clearUnscannedWarningPreference, unscannedWarningPreferences } from '../../../../electron/services/attachment-warning-preferences';

const remember = (accountId: string) => unscannedWarningPreferences.remember(accountId, unscannedWarningPreferences.revision(accountId));

beforeEach(() => {
  h.values.clear(); h.failure = false; h.prepare.mockReset().mockImplementation((sql: string) => ({
    get: (key: string) => h.values.has(key) ? { value: h.values.get(key) } : undefined,
    run: (key: string, value?: string) => {
      if (sql.startsWith('INSERT')) h.values.set(key, value);
      else if (sql.includes('LIKE')) { for (const existing of h.values.keys()) if (existing.startsWith(key.slice(0, -1))) h.values.delete(existing); }
      else h.values.delete(key);
    },
  }));
});

// Breaks: remembered bypasses leak between accounts, survive reset, become renderer-writable, or treat a broken DB as consent.
describe('main-only durable unscanned warning preferences', () => {
  it('defaults to warning and remembers only the exact captured account in registry metadata', () => {
    expect(unscannedWarningPreferences.read('account-a')).toBe(false);
    remember('account-a');
    expect(unscannedWarningPreferences.read('account-a')).toBe(true);
    expect(unscannedWarningPreferences.read('account-b')).toBe(false);
    expect(h.prepare.mock.calls.every(([sql]) => sql.includes('registry_meta') && !sql.includes('app_settings'))).toBe(true);
    expect([...h.values.keys()][0]).not.toContain('account-a');
    expect([...h.values.values()]).toEqual(['1']);
  });

  it('resets one removed account and resets all warnings without touching unrelated metadata', () => {
    remember('account-a'); remember('account-b');
    clearUnscannedWarningPreference('account-a');
    expect(unscannedWarningPreferences.read('account-a')).toBe(false); expect(unscannedWarningPreferences.read('account-b')).toBe(true);
    h.values.set('unrelated-meta', 'keep'); unscannedWarningPreferences.resetAll();
    expect(unscannedWarningPreferences.read('account-b')).toBe(false); expect(h.values.get('unrelated-meta')).toBe('keep');
    unscannedWarningPreferences.reset('account-never-remembered');
  });

  it.each([null, 'true', '{}', 1])('rejects malformed stored preference %s instead of bypassing', value => {
    remember('account-a'); h.values.set([...h.values.keys()][0]!, value);
    expect(() => unscannedWarningPreferences.read('account-a')).toThrow('preference is unreadable');
  });

  it.each(['read', 'remember', 'reset'] as const)('rejects empty and non-string account identities in %s', method => {
    for (const account of ['', undefined, 42]) expect(() => method === 'remember' ? remember(account as string) : unscannedWarningPreferences[method](account as string)).toThrow('account is unavailable');
  });

  it('propagates read and write failures without silently acknowledging a remembered preference', () => {
    h.failure = true;
    expect(() => unscannedWarningPreferences.read('account-a')).toThrow('Core store unreadable');
    expect(() => remember('account-a')).toThrow('Core store unreadable');
    expect(() => unscannedWarningPreferences.reset('account-a')).toThrow('Core store unreadable');
    expect(() => unscannedWarningPreferences.resetAll()).toThrow('Core store unreadable');
  });

  it('invalidates stale prompts by account scope and then globally without discarding other current prompts', () => {
    const accountA = unscannedWarningPreferences.revision('account-a');
    const accountB = unscannedWarningPreferences.revision('account-b');
    unscannedWarningPreferences.reset('account-a');
    expect(() => unscannedWarningPreferences.remember('account-a', accountA)).toThrow('warning preferences changed');
    unscannedWarningPreferences.remember('account-b', accountB);
    expect(unscannedWarningPreferences.read('account-b')).toBe(true);
    const freshA = unscannedWarningPreferences.revision('account-a');
    unscannedWarningPreferences.resetAll();
    expect(() => unscannedWarningPreferences.remember('account-a', freshA)).toThrow('warning preferences changed');
    expect(() => unscannedWarningPreferences.remember('account-b', accountB)).toThrow('warning preferences changed');
    expect(() => unscannedWarningPreferences.remember('account-a', undefined as unknown as string)).toThrow('warning preferences changed');
  });

  it.each(['account', 'all'] as const)('invalidates pending choices even if the %s reset fails', scope => {
    const revision = unscannedWarningPreferences.revision('account-a'); h.failure = true;
    expect(() => scope === 'account' ? unscannedWarningPreferences.reset('account-a') : unscannedWarningPreferences.resetAll()).toThrow('Core store unreadable');
    h.failure = false;
    expect(() => unscannedWarningPreferences.remember('account-a', revision)).toThrow('warning preferences changed');
  });
});
