import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  defaultSession: {
    clearStorageData: vi.fn(async (_options: unknown) => {}),
    cookies: { flushStore: vi.fn(async () => {}) },
  },
}));

vi.mock('electron', () => ({ session: { defaultSession: h.defaultSession } }));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));

import { clearEmailContentCookies, type CookieJar } from '../../../../electron/services/email-content-cookies';

// CASA 6.6.1. What breaks if these fail: tracker cookies that remote images in
// a removed account's mail set stay in the app's cookie jar on disk — or the
// clear reaches further than cookies and wipes the renderer's localStorage
// (every account, every setting), or a failing clear fails the removal.

const jar = (over: { clear?: () => Promise<void>; flush?: () => Promise<void> } = {}) => {
  const value = {
    clearStorageData: vi.fn(over.clear ?? (async () => {})),
    cookies: { flushStore: vi.fn(over.flush ?? (async () => {})) },
  };
  return value as typeof value & CookieJar;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clearEmailContentCookies', () => {
  it('clears ONLY cookies, then flushes the deletion to disk', async () => {
    const target = jar();
    await expect(clearEmailContentCookies(() => target)).resolves.toBe(true);
    expect(target.clearStorageData).toHaveBeenCalledExactlyOnceWith({ storages: ['cookies'] });
    expect(target.cookies.flushStore).toHaveBeenCalledOnce();
    expect(target.clearStorageData.mock.invocationCallOrder[0]).toBeLessThan(target.cookies.flushStore.mock.invocationCallOrder[0]);
  });

  // The session email bodies render in is the default one (the main window
  // sets no partition). Clearing some other session would clear nothing.
  it('targets the default session when no jar is given', async () => {
    await expect(clearEmailContentCookies()).resolves.toBe(true);
    expect(h.defaultSession.clearStorageData).toHaveBeenCalledExactlyOnceWith({ storages: ['cookies'] });
    expect(h.defaultSession.cookies.flushStore).toHaveBeenCalledOnce();
  });

  it.each([
    ['the clear rejects', { clear: async () => { throw new Error('cookie store busy'); } }],
    ['the flush rejects', { flush: async () => { throw new Error('disk full'); } }],
  ])('returns false and logs a warning when %s, never throwing', async (_label, over) => {
    await expect(clearEmailContentCookies(() => jar(over))).resolves.toBe(false);
    expect(h.warn).toHaveBeenCalledOnce();
  });

  // No session at all (a main-process restart, a destroyed window) is the
  // same best-effort failure, not a crash of the removal.
  it('survives a session accessor that throws', async () => {
    await expect(clearEmailContentCookies(() => { throw new Error('no session'); })).resolves.toBe(false);
    expect(h.warn).toHaveBeenCalledOnce();
  });

  // An idempotent re-run (a retried removal) clears an empty jar harmlessly.
  it('can run twice', async () => {
    const target = jar();
    await clearEmailContentCookies(() => target);
    await clearEmailContentCookies(() => target);
    expect(target.clearStorageData).toHaveBeenCalledTimes(2);
  });
});
