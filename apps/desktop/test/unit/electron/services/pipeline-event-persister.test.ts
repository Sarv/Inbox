import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pipeline event log persister. Buffered writes, so the invariants are about not
 * LOSING and not GROWING: a failed batch stays buffered for the next flush, only
 * one write is in flight at a time, and while storage is unavailable the buffer is
 * hard-capped (dropping the oldest) instead of growing without bound. Event data
 * is sanitised (Errors reduced, long strings truncated, functions dropped).
 */

const MAX_BUFFER_SIZE = 50;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_PENDING_BUFFER = 1_000;

const h = vi.hoisted(() => ({
  storage: null as unknown,
  handlers: [] as Array<(event: unknown) => void>,
  unsubCalls: 0,
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
  getEventBus: () => ({
    onAll: (cb: (event: unknown) => void) => {
      h.handlers.push(cb);
      return () => { h.unsubCalls += 1; };
    },
  }),
}));

vi.mock('../../../../electron/shared', () => ({ getStorage: () => h.storage }));

type Service = typeof import('../../../../electron/services/pipeline-event-persister');

/** Fresh module — the buffer and timers are module state. */
const load = async (): Promise<Service> => {
  vi.resetModules();
  return import('../../../../electron/services/pipeline-event-persister');
};

interface LoggedEvent {
  id: string; eventType: string; emailId: string | null; threadId: string | null;
  data: string | null; timestamp: number; createdAt: number;
}

interface FakeRepo {
  batches: LoggedEvent[][];
  rejectNext: boolean;
  cleanupResult: number;
  cleanupThrows: boolean;
  cutoffs: number[];
  pending: Array<() => void>;
  holdWrites: boolean;
}

const makeStorage = (over: Partial<FakeRepo> = {}) => {
  const repo: FakeRepo = {
    batches: [],
    rejectNext: false,
    cleanupResult: 7,
    cleanupThrows: false,
    cutoffs: [],
    pending: [],
    holdWrites: false,
    ...over,
  };
  const storage = {
    getRepositories: () => ({
      agent: {
        logPipelineEventBatch: (events: LoggedEvent[]) => {
          repo.batches.push(events);
          if (repo.rejectNext) {
            repo.rejectNext = false;
            return Promise.reject(new Error('write failed'));
          }
          if (repo.holdWrites) return new Promise<void>((resolve) => repo.pending.push(resolve));
          return Promise.resolve();
        },
        cleanupOldEvents: async (cutoff: number) => {
          repo.cutoffs.push(cutoff);
          if (repo.cleanupThrows) throw new Error('cleanup failed');
          return repo.cleanupResult;
        },
      },
    }),
  };
  return { repo, storage };
};

const emit = (event: Record<string, unknown>): void => {
  for (const handler of h.handlers) handler(event);
};

const emitMany = (count: number, type = 'email:categorized'): void => {
  for (let i = 0; i < count; i += 1) emit({ type, emailId: `e${i}` });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 5, 15, 12, 0, 0));
  h.storage = null;
  h.handlers = [];
  h.unsubCalls = 0;
});

afterEach(() => { vi.useRealTimers(); });

describe('start / stop', () => {
  it('subscribes once and is idempotent', async () => {
    const svc = await load();
    svc.startPipelineEventPersister();
    svc.startPipelineEventPersister();
    expect(h.handlers).toHaveLength(1);
    svc.stopPipelineEventPersister();
  });

  it('flushes periodically', async () => {
    const { repo, storage } = makeStorage();
    h.storage = storage;
    const svc = await load();
    svc.startPipelineEventPersister();
    emit({ type: 'email:synced', emailId: 'e1' });
    expect(repo.batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches).toHaveLength(1);
    svc.stopPipelineEventPersister();
  });

  it('stop() unsubscribes, cancels the timer and does a FINAL flush', async () => {
    const { repo, storage } = makeStorage();
    h.storage = storage;
    const svc = await load();
    svc.startPipelineEventPersister();
    emit({ type: 'email:synced', emailId: 'e1' });

    svc.stopPipelineEventPersister();
    expect(h.unsubCalls).toBe(1);
    expect(repo.batches).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10 * FLUSH_INTERVAL_MS);
    expect(repo.batches).toHaveLength(1); // timer really cancelled
  });

  it('stop() is safe when never started and when the buffer is empty', async () => {
    const svc = await load();
    expect(() => svc.stopPipelineEventPersister()).not.toThrow();
    expect(h.unsubCalls).toBe(0);
  });
});

describe('buffering', () => {
  it('flushes immediately once the buffer hits 50 events', async () => {
    const { repo, storage } = makeStorage();
    h.storage = storage;
    const svc = await load();
    svc.startPipelineEventPersister();

    emitMany(MAX_BUFFER_SIZE - 1);
    expect(repo.batches).toHaveLength(0);
    emitMany(1);
    expect(repo.batches).toHaveLength(1);
    expect(repo.batches[0]).toHaveLength(MAX_BUFFER_SIZE);
    svc.stopPipelineEventPersister();
  });

  it('drains the buffer only AFTER the write resolves', async () => {
    const { repo, storage } = makeStorage();
    h.storage = storage;
    const svc = await load();
    svc.startPipelineEventPersister();
    emit({ type: 'a' });
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    // Second tick had nothing left to write.
    expect(repo.batches).toHaveLength(1);
    svc.stopPipelineEventPersister();
  });

  it('KEEPS a failed batch for the next flush (no silent loss)', async () => {
    const { repo, storage } = makeStorage({ rejectNext: true });
    h.storage = storage;
    const svc = await load();
    svc.startPipelineEventPersister();
    emit({ type: 'a', emailId: 'e1' });

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches).toHaveLength(2);
    expect(repo.batches[1][0].emailId).toBe('e1'); // retried, not dropped
    svc.stopPipelineEventPersister();
  });

  it('runs ONE write at a time; events arriving mid-write wait their turn', async () => {
    const { repo, storage } = makeStorage({ holdWrites: true });
    h.storage = storage;
    const svc = await load();
    svc.startPipelineEventPersister();
    emit({ type: 'first' });
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches).toHaveLength(1);

    emit({ type: 'second' });
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches).toHaveLength(1); // still in flight — not re-entered

    repo.pending.forEach((resolve) => resolve());
    repo.holdWrites = false;
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches).toHaveLength(2);
    expect(repo.batches[1].map((e) => e.eventType)).toEqual(['second']);
    svc.stopPipelineEventPersister();
  });

  it('buffers safely while storage / the agent repo is unavailable', async () => {
    const svc = await load();
    svc.startPipelineEventPersister();
    emit({ type: 'a' });
    await expect(vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)).resolves.toBeDefined();

    // Storage appears but exposes no agent repo -> still just buffered.
    h.storage = { getRepositories: () => ({}) };
    await expect(vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)).resolves.toBeDefined();

    // Once a real repo shows up the buffered event is written.
    const { repo, storage } = makeStorage();
    h.storage = storage;
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches[0]).toHaveLength(1);
    svc.stopPipelineEventPersister();
  });

  it('logs and recovers when getRepositories itself throws', async () => {
    h.storage = { getRepositories: () => { throw new Error('closed'); } };
    const svc = await load();
    svc.startPipelineEventPersister();
    emit({ type: 'a' });
    await expect(vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)).resolves.toBeDefined();

    // Not wedged: a working storage flushes afterwards.
    const { repo, storage } = makeStorage();
    h.storage = storage;
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches).toHaveLength(1);
    svc.stopPipelineEventPersister();
  });

  it('hard-caps the pending buffer, dropping the OLDEST events', async () => {
    const svc = await load();
    svc.startPipelineEventPersister();
    // No storage: every 50 events triggers a flush that only caps the buffer.
    for (let i = 0; i < MAX_PENDING_BUFFER + 200; i += 1) emit({ type: 'x', emailId: `e${i}` });

    const { repo, storage } = makeStorage();
    h.storage = storage;
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(repo.batches[0]).toHaveLength(MAX_PENDING_BUFFER);
    // The oldest were dropped, the newest kept.
    expect(repo.batches[0][repo.batches[0].length - 1].emailId).toBe(`e${MAX_PENDING_BUFFER + 199}`);
    svc.stopPipelineEventPersister();
  });
});

describe('the persisted row', () => {
  // The row is stamped when the event ARRIVES, so capture that second before the
  // flush advances the fake clock.
  const flushOne = async (event: Record<string, unknown>): Promise<{ row: LoggedEvent; atSec: number }> => {
    const { repo, storage } = makeStorage();
    h.storage = storage;
    const svc = await load();
    svc.startPipelineEventPersister();
    const atSec = Math.floor(Date.now() / 1000);
    emit(event);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    svc.stopPipelineEventPersister();
    return { row: repo.batches[0][0], atSec };
  };

  it('carries a unique id, the event type and epoch-SECOND timestamps', async () => {
    const { row, atSec } = await flushOne({ type: 'email:categorized', timestamp: Date.now() });
    expect(row.id).toMatch(/^evt-\d+-[a-z0-9]+$/);
    expect(row.eventType).toBe('email:categorized');
    expect(row.timestamp).toBe(atSec);
    expect(row.createdAt).toBe(atSec);
  });

  it('falls back to now when the event carries no timestamp', async () => {
    const { row, atSec } = await flushOne({ type: 'x' });
    expect(row.timestamp).toBe(atSec);
  });

  it('extracts emailId / threadId from the event or its email payload', async () => {
    const direct = await flushOne({ type: 'x', emailId: 'e1', threadId: 't1' });
    expect(direct.row).toMatchObject({ emailId: 'e1', threadId: 't1' });

    const nested = await flushOne({ type: 'x', email: { id: 'e2', threadId: 't2' } });
    expect(nested.row).toMatchObject({ emailId: 'e2', threadId: 't2' });

    const neither = await flushOne({ type: 'x' });
    expect(neither.row).toMatchObject({ emailId: null, threadId: null });
  });

  it('reduces an Error to its name + message', async () => {
    const { row } = await flushOne({ type: 'x', error: new TypeError('bad input') });
    expect(JSON.parse(row.data!)).toEqual({ error: { message: 'bad input', name: 'TypeError' } });
  });

  it('truncates a long string and drops functions', async () => {
    const { row } = await flushOne({ type: 'x', body: 'a'.repeat(600), cb: () => {} });
    const data = JSON.parse(row.data!) as { body: string; cb?: unknown };
    expect(data.body).toHaveLength(503);
    expect(data.body.endsWith('...')).toBe(true);
    expect('cb' in data).toBe(false);
  });

  it('stores null instead of an empty object', async () => {
    const { row } = await flushOne({ type: 'x', timestamp: 1_700_000_000_000 });
    expect(row.data).toBeNull();
  });

  it('stores null when the payload cannot be serialised (circular)', async () => {
    const circular: Record<string, unknown> = { type: 'x' };
    circular.self = circular;
    const { row } = await flushOne(circular);
    expect(row.data).toBeNull();
  });
});

describe('cleanupOldPipelineEvents', () => {
  it('deletes events older than the cutoff and returns the count', async () => {
    const { repo, storage } = makeStorage();
    h.storage = storage;
    const svc = await load();
    await expect(svc.cleanupOldPipelineEvents(30)).resolves.toBe(7);
    expect(repo.cutoffs[0]).toBe(Math.floor(Date.now() / 1000) - 30 * 86_400);
  });

  it('defaults to a 90-day window', async () => {
    const { repo, storage } = makeStorage();
    h.storage = storage;
    const svc = await load();
    await svc.cleanupOldPipelineEvents();
    expect(repo.cutoffs[0]).toBe(Math.floor(Date.now() / 1000) - 90 * 86_400);
  });

  it('is 0 without storage, without an agent repo, or on failure', async () => {
    const svc = await load();
    await expect(svc.cleanupOldPipelineEvents()).resolves.toBe(0);

    h.storage = { getRepositories: () => ({}) };
    await expect(svc.cleanupOldPipelineEvents()).resolves.toBe(0);

    const { storage } = makeStorage({ cleanupThrows: true });
    h.storage = storage;
    await expect(svc.cleanupOldPipelineEvents()).resolves.toBe(0);
  });
});
