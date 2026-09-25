import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultAppearance } from '../../../../src/appearance/appearance';

// What breaks if this suite goes red: the user's theme/zoom silently stops
// persisting (every launch back to the default), or a corrupt stored value
// throws out of a module that runs BEFORE the first render — which is a blank
// window, not a styled-wrong one.

type ZoomCallback = (command: 'in' | 'out' | 'reset') => void;

/** A Map-backed localStorage, with an opt-in write failure (quota/denied). */
const makeStorage = () => {
  const entries = new Map<string, string>();
  let failWrites = false;
  return {
    entries,
    failNextWrites: () => {
      failWrites = true;
    },
    api: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error('QuotaExceededError');
        entries.set(key, value);
      },
      removeItem: (key: string) => void entries.delete(key),
    },
  };
};

let storage: ReturnType<typeof makeStorage>;
let zoomCallbacks: ZoomCallback[];
let mediaListeners: Array<() => void>;
let removedMediaListeners: number;

/** Fresh module instance per test — the store caches the appearance in module scope. */
const loadStore = async () => {
  vi.resetModules();
  return import('../../../../src/appearance/appearance-store');
};

beforeEach(() => {
  storage = makeStorage();
  zoomCallbacks = [];
  mediaListeners = [];
  removedMediaListeners = 0;

  vi.stubGlobal('localStorage', storage.api);
  vi.stubGlobal('window', {
    matchMedia: () => ({
      matches: false,
      addEventListener: (_event: string, listener: () => void) => mediaListeners.push(listener),
      removeEventListener: () => {
        removedMediaListeners += 1;
      },
    }),
    electronAPI: {
      appearance: {
        setZoomFactor: vi.fn(),
        onZoomCommand: (callback: ZoomCallback) => {
          zoomCallbacks.push(callback);
          return () => {
            zoomCallbacks = zoomCallbacks.filter((registered) => registered !== callback);
          };
        },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getAppearance', () => {
  it('returns the defaults when nothing is stored', async () => {
    const store = await loadStore();
    expect(store.getAppearance()).toEqual(defaultAppearance);
  });

  it('reads a stored appearance back', async () => {
    storage.entries.set('sarvinbox-appearance', JSON.stringify({ theme: 'dark', zoom: 125, density: 'compact' }));
    const store = await loadStore();
    expect(store.getAppearance()).toMatchObject({ theme: 'dark', zoom: 125, density: 'compact' });
  });

  // Regression: this runs before the first render. A throw here is a blank
  // window; falling back to the defaults is a styled app with a warning.
  it('falls back to the defaults on a corrupt blob instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    storage.entries.set('sarvinbox-appearance', '{not json');
    const store = await loadStore();
    expect(store.getAppearance()).toEqual(defaultAppearance);
    expect(warn).toHaveBeenCalled();
  });

  // Same value between changes, so useSyncExternalStore does not loop.
  it('returns a stable reference until something changes', async () => {
    const store = await loadStore();
    expect(store.getAppearance()).toBe(store.getAppearance());
  });
});

describe('setAppearance', () => {
  it('merges the patch, persists it and notifies subscribers', async () => {
    const store = await loadStore();
    const seen: number[] = [];
    store.subscribeAppearance(() => seen.push(store.getAppearance().zoom));

    store.setAppearance({ theme: 'dark' });
    store.setAppearance({ zoom: 120 });

    expect(store.getAppearance()).toMatchObject({ theme: 'dark', zoom: 120 });
    expect(JSON.parse(storage.entries.get('sarvinbox-appearance')!)).toMatchObject({ theme: 'dark', zoom: 120 });
    expect(seen).toEqual([100, 120]);
  });

  // Regression: an out-of-range value must never reach storage — it would be
  // read back on every launch and clamped only at apply time.
  it('normalizes what it stores', async () => {
    const store = await loadStore();
    store.setAppearance({ zoom: 9999 });
    expect(JSON.parse(storage.entries.get('sarvinbox-appearance')!).zoom).toBe(160);
  });

  // Transient vs permanent: a storage write that fails is not a reason to
  // abandon the change the user just made — it applies for this session.
  it('still applies and notifies when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await loadStore();
    const listener = vi.fn();
    store.subscribeAppearance(listener);
    storage.failNextWrites();

    store.setAppearance({ theme: 'dark' });

    expect(store.getAppearance().theme).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('stops notifying after a subscriber unsubscribes', async () => {
    const store = await loadStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribeAppearance(listener);
    unsubscribe();
    store.setAppearance({ theme: 'dark' });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('resetAppearance', () => {
  it('returns every field to its default and persists that', async () => {
    const store = await loadStore();
    store.setAppearance({ theme: 'dark', accent: 'rose', zoom: 140, density: 'compact', font: 'mono' });
    store.resetAppearance();
    expect(store.getAppearance()).toEqual(defaultAppearance);
    expect(JSON.parse(storage.entries.get('sarvinbox-appearance')!)).toEqual(defaultAppearance);
  });
});

describe('initAppearance', () => {
  // Regression: this is the whole point of the custom View menu. If the wiring
  // breaks, Cmd +/- silently does nothing at all (the menu items no longer
  // carry Electron's zoom roles).
  it('lets the View menu zoom commands drive the persisted zoom', async () => {
    const store = await loadStore();
    store.initAppearance();
    expect(zoomCallbacks).toHaveLength(1);

    zoomCallbacks[0]!('out');
    expect(store.getAppearance().zoom).toBe(90);
    zoomCallbacks[0]!('out');
    expect(store.getAppearance().zoom).toBe(80);
    zoomCallbacks[0]!('reset');
    expect(store.getAppearance().zoom).toBe(100);
    expect(JSON.parse(storage.entries.get('sarvinbox-appearance')!).zoom).toBe(100);
  });

  it('re-renders subscribers when the OS colour scheme changes', async () => {
    const store = await loadStore();
    store.initAppearance();
    const listener = vi.fn();
    store.subscribeAppearance(listener);

    expect(mediaListeners).toHaveLength(1);
    mediaListeners[0]!();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Regression: a listener with no way off is how a hot reload stacks a second
  // one and every change gets handled twice.
  it('detaches both listeners on dispose', async () => {
    const store = await loadStore();
    const dispose = store.initAppearance();
    dispose();
    expect(removedMediaListeners).toBe(1);
    expect(zoomCallbacks).toHaveLength(0);
  });

  // Not every host is Electron (a browser preview, the test env). Missing
  // bridges must be a no-op, not a crash before first render.
  it('works with no Electron bridge and no matchMedia', async () => {
    vi.stubGlobal('window', {});
    const store = await loadStore();
    expect(() => store.initAppearance()()).not.toThrow();
  });
});
