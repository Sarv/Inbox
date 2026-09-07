import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Conversation pre-extraction scheduler. It only hands work to the renderer when
 * an AI provider is actually configured (otherwise the round-trip just stalls and
 * times out), starts 10s after boot, then runs every 45s, and stop() must cancel
 * the pending FIRST tick too — otherwise it fires after storage close on a fast
 * quit.
 */

const INITIAL_DELAY_MS = 10_000;
const INTERVAL_MS = 45_000;

const h = vi.hoisted(() => ({
  storage: null as unknown,
  window: null as { sent: Array<{ channel: string; payload: unknown }> } | null,
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.storage,
  getMainWindow: () =>
    h.window
      ? { webContents: { send: (channel: string, payload: unknown) => h.window!.sent.push({ channel, payload }) } }
      : null,
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

type Scheduler = typeof import('../../../../electron/services/conversation-extraction-scheduler');

/** Fresh module — the "AI configured" flag is module state. */
const load = async (): Promise<Scheduler> => {
  vi.resetModules();
  return import('../../../../electron/services/conversation-extraction-scheduler');
};

interface FakeRepo { pending: unknown[]; calls: number[]; throws: boolean }

const makeStorage = (pending: unknown[], over: Partial<FakeRepo> = {}) => {
  const repo: FakeRepo = { pending, calls: [], throws: false, ...over };
  return {
    repo,
    storage: {
      threadRepo: {
        getPendingExtractionThreads: async (batch: number) => {
          repo.calls.push(batch);
          if (repo.throws) throw new Error('query failed');
          return repo.pending;
        },
      },
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  h.storage = null;
  h.window = { sent: [] };
});

afterEach(() => { vi.useRealTimers(); });

describe('the AI-provider gate', () => {
  it('reports and remembers what the renderer told it', async () => {
    const svc = await load();
    expect(svc.isAIProviderConfigured()).toBe(false);
    svc.setAIProviderConfigured(true);
    expect(svc.isAIProviderConfigured()).toBe(true);
    svc.setAIProviderConfigured(false);
    expect(svc.isAIProviderConfigured()).toBe(false);
  });

  it('does nothing at all while no AI provider is configured', async () => {
    const { repo, storage } = makeStorage([{ id: 't1' }]);
    h.storage = storage;
    const svc = await load();
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 3 * INTERVAL_MS);
    expect(repo.calls).toEqual([]);
    expect(h.window!.sent).toEqual([]);
    svc.stopConversationScheduler();
  });
});

describe('pacing', () => {
  it('first tick after 10s, then every 45s', async () => {
    const { repo, storage } = makeStorage([{ id: 't1' }]);
    h.storage = storage;
    const svc = await load();
    svc.setAIProviderConfigured(true);

    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(repo.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(repo.calls).toEqual([5]); // BATCH_SIZE

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(repo.calls).toEqual([5, 5]);
    svc.stopConversationScheduler();
  });

  it('is idempotent', async () => {
    const { repo, storage } = makeStorage([]);
    h.storage = storage;
    const svc = await load();
    svc.setAIProviderConfigured(true);
    svc.startConversationScheduler();
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(repo.calls).toHaveLength(1);
    svc.stopConversationScheduler();
  });

  it('stop() cancels the pending FIRST tick (fast quit)', async () => {
    const { repo, storage } = makeStorage([{ id: 't1' }]);
    h.storage = storage;
    const svc = await load();
    svc.setAIProviderConfigured(true);
    svc.startConversationScheduler();
    svc.stopConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 5 * INTERVAL_MS);
    expect(repo.calls).toEqual([]);
  });

  it('stop() after the first tick cancels the interval', async () => {
    const { repo, storage } = makeStorage([{ id: 't1' }]);
    h.storage = storage;
    const svc = await load();
    svc.setAIProviderConfigured(true);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    svc.stopConversationScheduler();
    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(repo.calls).toHaveLength(1);
  });

  it('is safe to stop when never started, and can be restarted', async () => {
    const { repo, storage } = makeStorage([]);
    h.storage = storage;
    const svc = await load();
    svc.setAIProviderConfigured(true);
    expect(() => svc.stopConversationScheduler()).not.toThrow();
    svc.startConversationScheduler();
    svc.stopConversationScheduler();
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(repo.calls).toHaveLength(1);
    svc.stopConversationScheduler();
  });
});

describe('the batch hand-off', () => {
  it('sends the pending threads to the renderer', async () => {
    const pending = [{ id: 't1' }, { id: 't2' }];
    const { storage } = makeStorage(pending);
    h.storage = storage;
    const svc = await load();
    svc.setAIProviderConfigured(true);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(h.window!.sent).toEqual([
      { channel: 'conversation:extract-batch', payload: { threads: pending } },
    ]);
    svc.stopConversationScheduler();
  });

  it('stays silent when nothing is pending', async () => {
    const { storage } = makeStorage([]);
    h.storage = storage;
    const svc = await load();
    svc.setAIProviderConfigured(true);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(h.window!.sent).toEqual([]);
    svc.stopConversationScheduler();
  });

  it('skips the tick with no storage or no window', async () => {
    const svc = await load();
    svc.setAIProviderConfigured(true);
    h.storage = null;
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(h.window!.sent).toEqual([]);
    svc.stopConversationScheduler();

    const { repo, storage } = makeStorage([{ id: 't1' }]);
    h.storage = storage;
    h.window = null;
    const svc2 = await load();
    svc2.setAIProviderConfigured(true);
    svc2.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(repo.calls).toEqual([]);
    svc2.stopConversationScheduler();
  });

  it('logs and recovers when the query fails', async () => {
    const { storage } = makeStorage([], { throws: true });
    h.storage = storage;
    const svc = await load();
    svc.setAIProviderConfigured(true);
    svc.startConversationScheduler();
    await expect(vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)).resolves.toBeDefined();
    expect(h.window!.sent).toEqual([]);
    svc.stopConversationScheduler();
  });
});
