import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one-time bulk backfill RUNNER (`maybeBackfillBulk`). The pure decision
 * (`bulkTagUpdates`) is covered in bulk-backfill.test.ts; this pins the run
 * semantics that make it safe to fire-and-forget from the backfill scheduler:
 *   - it runs ONCE per account (a core-DB meta flag) and never concurrently,
 *   - it is inert until the engine is connected and exposes the classify API,
 *   - Trash/Junk and unsubscribed folders are skipped (no threading value),
 *   - it batches 200 UIDs at a time and YIELDS between batches,
 *   - a mid-run disconnect leaves the flag UNSET so the next launch resumes.
 */

const BATCH = 200;
const YIELD_MS = 50;
const META_KEY = 'bulk-backfill:acct-a';

vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));

vi.mock('@sarvinbox/core', async () => {
  const actual = await vi.importActual<typeof import('@sarvinbox/core')>('@sarvinbox/core');
  return {
    ...actual,
    createLogger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    }),
  };
});

import { resetFakeCoreDb, state as dbState } from '../../../../electron/services/__testing__/fake-core-db';

type Module = typeof import('../../../../electron/services/bulk-backfill');

/** Fresh module — the in-flight account set is module state. */
const load = async (): Promise<Module> => {
  vi.resetModules();
  return import('../../../../electron/services/bulk-backfill');
};

interface Folder { id: string; path: string; subscribed?: boolean; specialUse?: string }
interface Row { id: string; uid: number | null; tags: string }

interface State {
  folders: Folder[];
  rows: Map<string, Row[]>;
  connected: boolean;
  bulkUids: (path: string, uids: number[]) => number[];
  classifyThrows: boolean;
  classifyCalls: Array<{ path: string; uids: number[] }>;
  tagCalls: Array<Array<{ id: string; tags: string }>>;
  tagsQueried: string[];
  hasClassify: boolean;
  hasTagsApi: boolean;
  hasFolders: boolean;
}

const make = (over: Partial<State> = {}) => {
  const state: State = {
    folders: [{ id: 'f1', path: 'INBOX', subscribed: true }],
    rows: new Map([['f1', [{ id: 'e1', uid: 1, tags: '|INBOX|' }]]]),
    connected: true,
    bulkUids: (_path, uids) => uids,
    classifyThrows: false,
    classifyCalls: [],
    tagCalls: [],
    tagsQueried: [],
    hasClassify: true,
    hasTagsApi: true,
    hasFolders: true,
    ...over,
  };

  const storage: Record<string, unknown> = {};
  if (state.hasFolders) storage.getFolders = async () => state.folders;
  if (state.hasTagsApi) {
    storage.getEmailTagsInFolder = async (folderId: string) => {
      state.tagsQueried.push(folderId);
      return state.rows.get(folderId) ?? [];
    };
    storage.bulkUpdateTags = async (updates: Array<{ id: string; tags: string }>) => {
      state.tagCalls.push(updates);
    };
  }

  const engine: Record<string, unknown> = { isConnected: () => state.connected };
  if (state.hasClassify) {
    engine.classifyBulkUids = async (path: string, uids: number[]) => {
      state.classifyCalls.push({ path, uids });
      if (state.classifyThrows) throw new Error('fetch failed');
      return new Set(state.bulkUids(path, uids));
    };
  }

  return { state, storage, engine };
};

/** Drive the internal `sleep(YIELD_MS)` yields to completion. */
const run = async (promise: Promise<void>, yields = 30): Promise<void> => {
  for (let i = 0; i < yields; i += 1) await vi.advanceTimersByTimeAsync(YIELD_MS);
  await promise;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 5, 15, 12, 0, 0));
  resetFakeCoreDb();
});

afterEach(() => { vi.useRealTimers(); });

describe('the run gates', () => {
  it('does nothing without an account id', async () => {
    const mod = await load();
    const { storage, engine, state } = make();
    await mod.maybeBackfillBulk(storage, engine, '');
    expect(state.classifyCalls).toEqual([]);
  });

  it('does nothing when the account already completed a pass', async () => {
    dbState.meta.set(META_KEY, '123');
    const mod = await load();
    const { storage, engine, state } = make();
    await mod.maybeBackfillBulk(storage, engine, 'acct-a');
    expect(state.classifyCalls).toEqual([]);
  });

  it('does nothing while DISCONNECTED or without the classify API', async () => {
    const mod = await load();
    const offline = make({ connected: false });
    await mod.maybeBackfillBulk(offline.storage, offline.engine, 'acct-a');
    expect(offline.state.classifyCalls).toEqual([]);

    const noApi = make({ hasClassify: false });
    await mod.maybeBackfillBulk(noApi.storage, noApi.engine, 'acct-a');
    expect(noApi.state.tagsQueried).toEqual([]);
    expect(dbState.meta.has(META_KEY)).toBe(false); // retried on a later tick
  });

  it('does nothing for a storage without the tag APIs', async () => {
    const mod = await load();
    const { storage, engine, state } = make({ hasTagsApi: false });
    await mod.maybeBackfillBulk(storage, engine, 'acct-a');
    expect(state.classifyCalls).toEqual([]);
    expect(dbState.meta.has(META_KEY)).toBe(false);
  });

  it('never runs two passes for the same account concurrently', async () => {
    const mod = await load();
    const { storage, engine, state } = make();
    const first = mod.maybeBackfillBulk(storage, engine, 'acct-a');
    const second = mod.maybeBackfillBulk(storage, engine, 'acct-a');
    await run(Promise.all([first, second]).then(() => undefined));
    expect(state.classifyCalls).toHaveLength(1);
  });
});

describe('a clean pass', () => {
  it('tags the bulk mail and records the completion flag', async () => {
    const mod = await load();
    const { storage, engine, state } = make({
      rows: new Map([['f1', [
        { id: 'e1', uid: 1, tags: '|INBOX|' },
        { id: 'e2', uid: 2, tags: '|INBOX|' },
      ]]]),
      bulkUids: () => [1],
    });

    await run(mod.maybeBackfillBulk(storage, engine, 'acct-a'));

    expect(state.classifyCalls).toEqual([{ path: 'INBOX', uids: [1, 2] }]);
    expect(state.tagCalls).toEqual([[{ id: 'e1', tags: '|INBOX|bulk|' }]]);
    expect(dbState.meta.get(META_KEY)).toMatch(/^\d+$/); // completion timestamp
  });

  it('skips rows with no UID and rows already tagged bulk', async () => {
    const mod = await load();
    const { storage, engine, state } = make({
      rows: new Map([['f1', [
        { id: 'no-uid', uid: null, tags: '|INBOX|' },
        { id: 'zero-uid', uid: 0, tags: '|INBOX|' },
        { id: 'already', uid: 3, tags: '|INBOX|bulk|' },
        { id: 'todo', uid: 4, tags: '|INBOX|' },
      ]]]),
    });
    await run(mod.maybeBackfillBulk(storage, engine, 'acct-a'));
    expect(state.classifyCalls[0].uids).toEqual([4]);
  });

  it('writes nothing when the server reports no bulk mail', async () => {
    const mod = await load();
    const { storage, engine, state } = make({ bulkUids: () => [] });
    await run(mod.maybeBackfillBulk(storage, engine, 'acct-a'));
    expect(state.tagCalls).toEqual([]);
    expect(dbState.meta.has(META_KEY)).toBe(true);
  });

  it('writes nothing when every bulk row was already tagged', async () => {
    const mod = await load();
    const { storage, engine, state } = make({
      rows: new Map([['f1', [{ id: 'e1', uid: 1, tags: '|INBOX|' }]]]),
      // The server says UID 2 is bulk — not in this batch, so no update applies.
      bulkUids: () => [2],
    });
    await run(mod.maybeBackfillBulk(storage, engine, 'acct-a'));
    expect(state.tagCalls).toEqual([]);
  });

  it('batches 200 UIDs at a time, yielding between batches', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `e${i}`, uid: i + 1, tags: '|INBOX|' }));
    const mod = await load();
    const { storage, engine, state } = make({ rows: new Map([['f1', rows]]), bulkUids: () => [] });
    await run(mod.maybeBackfillBulk(storage, engine, 'acct-a'));
    expect(state.classifyCalls.map((c) => c.uids.length)).toEqual([BATCH, BATCH, 50]);
  });

  it('skips Trash / Junk and unsubscribed folders', async () => {
    const mod = await load();
    const { storage, engine, state } = make({
      folders: [
        { id: 'trash', path: 'Trash', specialUse: '\\Trash' },
        { id: 'junk', path: 'Spam', specialUse: '\\Junk' },
        { id: 'muted', path: 'Muted', subscribed: false },
        { id: 'f1', path: 'INBOX', subscribed: true },
      ],
    });
    await run(mod.maybeBackfillBulk(storage, engine, 'acct-a'));
    expect(state.tagsQueried).toEqual(['f1']);
  });

  it('tolerates a storage with no folders API (completes as an empty pass)', async () => {
    const mod = await load();
    const { storage, engine } = make({ hasFolders: false });
    await run(mod.maybeBackfillBulk(storage, engine, 'acct-a'));
    expect(dbState.meta.has(META_KEY)).toBe(true);
  });
});

describe('interruption', () => {
  it('leaves the flag UNSET when the connection drops mid-batch (resumes next launch)', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: `e${i}`, uid: i + 1, tags: '|INBOX|' }));
    const acct = make({ rows: new Map([['f1', rows]]) });
    // The connection dies while the FIRST batch is being classified, so the
    // second batch's guard throws mid-pass.
    acct.state.bulkUids = () => { acct.state.connected = false; return []; };
    const mod = await load();

    await run(mod.maybeBackfillBulk(acct.storage, acct.engine, 'acct-a'));

    expect(acct.state.classifyCalls).toHaveLength(1);
    expect(dbState.meta.has(META_KEY)).toBe(false);
  });

  it('stops between FOLDERS when the connection drops, without marking done', async () => {
    const acct = make({
      folders: [{ id: 'f1', path: 'INBOX', subscribed: true }, { id: 'f2', path: 'Work', subscribed: true }],
      rows: new Map([
        ['f1', [{ id: 'e1', uid: 1, tags: '|INBOX|' }]],
        ['f2', [{ id: 'e2', uid: 2, tags: '|Work|' }]],
      ]),
    });
    // Dies while classifying the only batch of the FIRST folder, so the loop
    // breaks before touching the second folder.
    acct.state.bulkUids = () => { acct.state.connected = false; return []; };
    const mod = await load();
    await run(mod.maybeBackfillBulk(acct.storage, acct.engine, 'acct-a'));

    expect(acct.state.tagsQueried).toEqual(['f1']);
    // A disconnect between folders must NOT mark the pass complete: the flag is
    // the only record that this account still needs bulk classification, so
    // setting it here would permanently skip every folder we never reached
    // (re-classifying is idempotent, so resuming next launch costs nothing).
    expect(dbState.meta.has(META_KEY)).toBe(false);
  });

  it('swallows a classify failure and leaves the flag unset', async () => {
    const mod = await load();
    const { storage, engine, state } = make({ classifyThrows: true });
    await run(mod.maybeBackfillBulk(storage, engine, 'acct-a'));
    expect(dbState.meta.has(META_KEY)).toBe(false);
    expect(state.tagCalls).toEqual([]);
  });

  it('frees the in-flight slot so a later tick can retry', async () => {
    const mod = await load();
    const acct = make({ classifyThrows: true });
    await run(mod.maybeBackfillBulk(acct.storage, acct.engine, 'acct-a'));

    acct.state.classifyThrows = false;
    await run(mod.maybeBackfillBulk(acct.storage, acct.engine, 'acct-a'));
    expect(dbState.meta.has(META_KEY)).toBe(true);
  });
});
