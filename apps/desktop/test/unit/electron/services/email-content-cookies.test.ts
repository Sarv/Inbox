import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  defaultSession: {
    clearStorageData: vi.fn(async (_options: unknown) => {}),
    clearCache: vi.fn(async () => {}),
    cookies: { flushStore: vi.fn(async () => {}) },
  },
}));

vi.mock('electron', () => ({ session: { defaultSession: h.defaultSession } }));
vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  CONTENT_CLEAR_TIMEOUT_MS,
  clearEmailContentCache,
  clearEmailContentCookies,
  clearEmailContentData,
  type CookieJar,
  type HttpCache,
} from '../../../../electron/services/email-content-cookies';

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

  // Breaks "Deleting…" for good. Removal awaits this, and a session clear that never
  // settled is a real thing this app has seen (dev-session-reset.ts). Both steps are
  // bounded, because a cookie store can hang on either.
  it.each([
    ['the clear never answers', { clear: () => new Promise<void>(() => {}) }],
    ['the flush never answers', { flush: () => new Promise<void>(() => {}) }],
  ])('gives up after the timeout when %s', async (_label, over) => {
    vi.useFakeTimers();
    try {
      const pending = clearEmailContentCookies(() => jar(over));
      await vi.advanceTimersByTimeAsync(CONTENT_CLEAR_TIMEOUT_MS - 1);
      expect(h.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(false);
      expect(h.warn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // An idempotent re-run (a retried removal) clears an empty jar harmlessly.
  it('can run twice', async () => {
    const target = jar();
    await clearEmailContentCookies(() => target);
    await clearEmailContentCookies(() => target);
    expect(target.clearStorageData).toHaveBeenCalledTimes(2);
  });
});

// CASA 6.6.1. What breaks if these fail: images from a removed account's mail stay
// in the on-disk HTTP cache (measured on Electron 44: the image's bytes are in
// `Cache/Cache_Data` until `clearCache`, gone straight after it, and a fresh renderer
// then refetches), or a cache that cannot be cleared fails the removal.
describe('clearEmailContentCache', () => {
  const cache = (clear: () => Promise<void> = async () => {}) => {
    const value = { clearCache: vi.fn(clear) };
    return value as typeof value & HttpCache;
  };

  it('clears the cache and reports success', async () => {
    const target = cache();
    await expect(clearEmailContentCache(() => target)).resolves.toBe(true);
    expect(target.clearCache).toHaveBeenCalledOnce();
    expect(h.warn).not.toHaveBeenCalled();
  });

  // The session email bodies render in is the default one.
  it('targets the default session when none is given', async () => {
    await expect(clearEmailContentCache()).resolves.toBe(true);
    expect(h.defaultSession.clearCache).toHaveBeenCalledOnce();
  });

  // Transient: a cache file in use. The removal itself has already happened.
  it('returns false and logs when the clear rejects, never throwing', async () => {
    await expect(clearEmailContentCache(() => cache(async () => { throw new Error('EBUSY'); }))).resolves.toBe(false);
    expect(h.warn).toHaveBeenCalledOnce();
  });

  // Permanent: no session at all (a main-process restart, a destroyed window).
  it('survives a session accessor that throws', async () => {
    await expect(clearEmailContentCache(() => { throw new Error('no session'); })).resolves.toBe(false);
    expect(h.warn).toHaveBeenCalledOnce();
  });

  // Breaks a warning into `undefined` when the failure is not an Error at all.
  it('still logs something readable when what it caught is not an Error', async () => {
    await expect(clearEmailContentCache(() => cache(() => Promise.reject('busy')))).resolves.toBe(false);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('busy'));
  });

  // Breaks the "Deleting…" state: removal awaits this, so a cache stuck on a slow
  // disk would otherwise hold it forever.
  it('gives up after the timeout rather than holding the removal', async () => {
    vi.useFakeTimers();
    try {
      const pending = clearEmailContentCache(() => cache(() => new Promise<void>(() => {})));
      await vi.advanceTimersByTimeAsync(CONTENT_CLEAR_TIMEOUT_MS - 1);
      expect(h.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(false);
      expect(h.warn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // An idempotent re-run (a retried removal) clears an empty cache harmlessly.
  it('can run twice', async () => {
    const target = cache();
    await clearEmailContentCache(() => target);
    await clearEmailContentCache(() => target);
    expect(target.clearCache).toHaveBeenCalledTimes(2);
  });
});

describe('clearEmailContentData', () => {
  const session = (over: { clear?: () => Promise<void>; flush?: () => Promise<void>; cache?: () => Promise<void> } = {}) => {
    const value = { ...jar(over), clearCache: vi.fn(over.cache ?? (async () => {})) };
    return value as typeof value & CookieJar & HttpCache;
  };

  it('clears cookies and the cache', async () => {
    const target = session();
    await expect(clearEmailContentData(() => target)).resolves.toEqual({ cookies: true, cache: true });
    expect(target.clearStorageData).toHaveBeenCalledExactlyOnceWith({ storages: ['cookies'] });
    expect(target.clearCache).toHaveBeenCalledOnce();
  });

  it('targets the default session when none is given', async () => {
    await expect(clearEmailContentData()).resolves.toEqual({ cookies: true, cache: true });
    expect(h.defaultSession.clearStorageData).toHaveBeenCalledOnce();
    expect(h.defaultSession.clearCache).toHaveBeenCalledOnce();
  });

  // Breaks if one failure hides the other: a busy cookie store must not leave a
  // removed account's images on disk, or the other way round.
  it('still clears the cache when cookies fail', async () => {
    const target = session({ clear: async () => { throw new Error('cookie store busy'); } });
    await expect(clearEmailContentData(() => target)).resolves.toEqual({ cookies: false, cache: true });
    expect(target.clearCache).toHaveBeenCalledOnce();
  });

  it('still clears cookies when the cache fails', async () => {
    const target = session({ cache: async () => { throw new Error('EBUSY'); } });
    await expect(clearEmailContentData(() => target)).resolves.toEqual({ cookies: true, cache: false });
    expect(target.cookies.flushStore).toHaveBeenCalledOnce();
  });

  // Breaks if a hung cookie store could hold the cache's clear, or the removal, past
  // the one bound. They run together, so the wait is the slower of the two, not the sum.
  it('settles within one timeout when both hang, and when only cookies hang', async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<void>(() => {});
      const both = clearEmailContentData(() => session({ clear: never, cache: never }));
      const cookiesOnly = clearEmailContentData(() => session({ clear: never }));
      await vi.advanceTimersByTimeAsync(CONTENT_CLEAR_TIMEOUT_MS);
      await expect(both).resolves.toEqual({ cookies: false, cache: false });
      await expect(cookiesOnly).resolves.toEqual({ cookies: false, cache: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // Breaks the removal the user asked for: this must report, never throw.
  it('reports both failures without throwing', async () => {
    const target = () => { throw new Error('no session'); };
    await expect(clearEmailContentData(target)).resolves.toEqual({ cookies: false, cache: false });
    expect(h.warn).toHaveBeenCalledTimes(2);
  });
});
