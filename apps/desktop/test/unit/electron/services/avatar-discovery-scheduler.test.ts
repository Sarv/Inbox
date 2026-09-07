import { createHash } from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Avatar discovery — the one network path behind confirm-gated contact avatars.
 * Pinned: Gravatar is asked with `d=404` (never an identicon), a hit is cached as
 * a bounded `data:` URI, every MISS still stamps "checked" so the tick can't loop
 * hot, ticks are not re-entered, and stop() cancels both timers.
 */

const FIRST_TICK_MS = 45_000;
const TICK_MS = 5 * 60_000;
const STALE_MS = 30 * 24 * 60 * 60_000;
const MAX_BYTES = 256 * 1024;

interface Contact { id: string; email: string }

const h = vi.hoisted(() => ({
  storage: null as unknown,
  window: null as { sent: string[]; sendThrows: boolean } | null,
  fetches: [] as string[],
  respond: null as
    | ((url: string) => Promise<{ ok: boolean; headers: { get: (k: string) => string | null }; arrayBuffer: () => Promise<ArrayBuffer> }>)
    | null,
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.storage,
  getMainWindow: () =>
    h.window
      ? {
          webContents: {
            send: (channel: string) => {
              if (h.window!.sendThrows) throw new Error('window gone');
              h.window!.sent.push(channel);
            },
          },
        }
      : null,
}));

vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: async (url: string) => {
    h.fetches.push(url);
    if (!h.respond) throw new Error('network down');
    return h.respond(url);
  },
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

import {
  startAvatarDiscoveryScheduler,
  stopAvatarDiscoveryScheduler,
} from '../../../../electron/services/avatar-discovery-scheduler';

const imageResponse = (bytes: number, contentType = 'image/png') => async () => ({
  ok: true,
  headers: { get: (k: string) => (k === 'content-type' ? contentType : null) },
  arrayBuffer: async () => new Uint8Array(bytes).fill(7).buffer,
});

const notFound = async () => ({
  ok: false,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
});

interface FakeStorage {
  contacts: Contact[];
  candidates: Array<[string, string]>;
  checked: string[];
  listArgs: Array<[number, number]>;
  listThrows: boolean;
  markThrows: boolean;
  slowFetch?: Promise<void>;
}

const makeStorage = (contacts: Contact[], over: Partial<FakeStorage> = {}) => {
  const s: FakeStorage = {
    contacts,
    candidates: [],
    checked: [],
    listArgs: [],
    listThrows: false,
    markThrows: false,
    ...over,
  };
  const storage = {
    getContactsNeedingAvatar: async (batch: number, staleBefore: number) => {
      s.listArgs.push([batch, staleBefore]);
      if (s.listThrows) throw new Error('db down');
      return s.contacts;
    },
    setContactAvatarCandidate: async (id: string, dataUri: string) => { s.candidates.push([id, dataUri]); },
    markContactAvatarChecked: async (id: string) => {
      if (s.markThrows) throw new Error('write failed');
      s.checked.push(id);
    },
  };
  return { state: s, storage };
};

const settle = async (turns = 30): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(Date.UTC(2026, 5, 15, 12, 0, 0));
  h.storage = null;
  h.window = { sent: [], sendThrows: false };
  h.fetches.length = 0;
  h.respond = notFound;
});

afterEach(() => {
  stopAvatarDiscoveryScheduler();
  vi.useRealTimers();
});

describe('pacing', () => {
  it('probes 45s after start, then every 5 minutes', async () => {
    const { state, storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }]);
    h.storage = storage;

    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS - 1);
    expect(h.fetches).toHaveLength(0);

    await advance(1);
    expect(h.fetches).toHaveLength(1);

    await advance(TICK_MS);
    expect(h.fetches).toHaveLength(2);
    expect(state.listArgs[0][0]).toBe(15); // BATCH
  });

  it('asks only for contacts stale beyond the monthly window', async () => {
    const { state, storage } = makeStorage([]);
    h.storage = storage;
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(state.listArgs[0][1]).toBe(Date.now() - STALE_MS);
  });

  it('is idempotent and stop() cancels both timers', async () => {
    const { storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }]);
    h.storage = storage;
    startAvatarDiscoveryScheduler();
    startAvatarDiscoveryScheduler();
    stopAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS + 5 * TICK_MS);
    expect(h.fetches).toHaveLength(0);
  });
});

describe('probing', () => {
  it('asks Gravatar with d=404 using the md5 of the normalized address', async () => {
    const { storage } = makeStorage([{ id: 'c1', email: '  MixedCase@Example.com ' }]);
    h.storage = storage;
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);

    const hash = createHash('md5').update('mixedcase@example.com').digest('hex');
    expect(h.fetches[0]).toBe(`https://www.gravatar.com/avatar/${hash}?s=160&d=404`);
  });

  it('caches a hit as a data: URI and nudges the Contacts view', async () => {
    const { state, storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }]);
    h.storage = storage;
    h.respond = imageResponse(10, 'image/jpeg');

    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);

    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0][0]).toBe('c1');
    expect(state.candidates[0][1].startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(state.checked).toEqual([]);
    expect(h.window!.sent).toEqual(['contacts:avatars-updated']);
  });

  it('stamps "checked" for a 404 and does not nudge the UI', async () => {
    const { state, storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }]);
    h.storage = storage;
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(state.candidates).toEqual([]);
    expect(state.checked).toEqual(['c1']);
    expect(h.window!.sent).toEqual([]);
  });

  it('stamps "checked" for a non-image response', async () => {
    const { state, storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }]);
    h.storage = storage;
    h.respond = imageResponse(10, 'text/html');
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(state.checked).toEqual(['c1']);
  });

  it('rejects an oversized or empty image', async () => {
    const { state, storage } = makeStorage([
      { id: 'big', email: 'big@example.com' },
      { id: 'empty', email: 'empty@example.com' },
    ]);
    h.storage = storage;
    h.respond = async (url: string) =>
      url.includes(createHash('md5').update('big@example.com').digest('hex'))
        ? imageResponse(MAX_BYTES + 1)()
        : imageResponse(0)();

    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(state.candidates).toEqual([]);
    expect(state.checked.sort()).toEqual(['big', 'empty']);
  });

  it('stamps "checked" on a network error so a broken run cannot loop hot', async () => {
    const { state, storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }]);
    h.storage = storage;
    h.respond = null; // chromiumFetch throws
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(state.checked).toEqual(['c1']);
  });

  it('swallows a failing "checked" write', async () => {
    const { storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }], { markThrows: true });
    h.storage = storage;
    h.respond = null;
    startAvatarDiscoveryScheduler();
    await expect(advance(FIRST_TICK_MS)).resolves.toBeUndefined();
  });

  it('survives a missing window after a hit', async () => {
    const { state, storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }]);
    h.storage = storage;
    h.respond = imageResponse(10);
    h.window = null;
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(state.candidates).toHaveLength(1);
  });

  it('survives a dead webContents after a hit', async () => {
    const { storage } = makeStorage([{ id: 'c1', email: 'a@example.com' }]);
    h.storage = storage;
    h.respond = imageResponse(10);
    h.window = { sent: [], sendThrows: true };
    startAvatarDiscoveryScheduler();
    await expect(advance(FIRST_TICK_MS)).resolves.toBeUndefined();
  });
});

describe('robustness', () => {
  it('does nothing before an account is active', async () => {
    h.storage = null;
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(h.fetches).toEqual([]);
  });

  it('does nothing for a storage without the contacts API', async () => {
    h.storage = {};
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(h.fetches).toEqual([]);
  });

  it('does nothing when no contact needs a probe', async () => {
    const { storage } = makeStorage([]);
    h.storage = storage;
    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(h.fetches).toEqual([]);
  });

  it('logs and recovers when the query itself fails', async () => {
    const { storage } = makeStorage([], { listThrows: true });
    h.storage = storage;
    startAvatarDiscoveryScheduler();
    await expect(advance(FIRST_TICK_MS)).resolves.toBeUndefined();
    // The next tick still runs.
    await advance(TICK_MS);
  });

  it('does NOT re-enter a tick that is still in flight', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { storage } = makeStorage([
      { id: 'c1', email: 'a@example.com' },
      { id: 'c2', email: 'b@example.com' },
    ]);
    h.storage = storage;
    h.respond = async () => {
      await blocked;
      return notFound();
    };

    startAvatarDiscoveryScheduler();
    await advance(FIRST_TICK_MS);
    expect(h.fetches).toHaveLength(1); // stuck on the first probe

    await advance(3 * TICK_MS);
    expect(h.fetches).toHaveLength(1); // no re-entry

    release();
    await settle();
    expect(h.fetches).toHaveLength(2); // the original tick finishes its batch
  });
});
