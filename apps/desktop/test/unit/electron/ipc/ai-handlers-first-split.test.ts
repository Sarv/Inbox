import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  EmailRecord,
  FirstSplitClearAllResult,
  FirstSplitGetResult,
  FirstSplitKey,
  FirstSplitSaveRequest,
  FirstSplitSaveResult,
} from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the first-email split cache's IPC. Two
// accounts hold the SAME thread id (thread ids come from headers), so a handler
// that reads or writes the active account's database for another account's
// thread shows one account's AI split in the other's chat view — or stores it
// there. Clear Cache must reach every CONFIGURED account (open or not) and must
// not report a failed account as "0 cleared". Real account databases, the real
// facade.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  current: 'acct-a' as string | null,
  byId: new Map<string, unknown>(),
  registry: ['acct-a', 'acct-b'] as string[],
  registryError: null as Error | null,
  /** What ensureAccountRuntime opens for an id that has no open runtime. */
  openable: new Map<string, unknown>(),
  created: [] as string[],
  /** The pre-account default slot: the storage requireStorage hands out while no account is current. */
  defaultSlot: null as unknown,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
}));
vi.mock('../../../../electron/shared', () => ({
  getCurrentAccountId: () => h.current,
  requireStorage: () => {
    const active = h.current ? h.byId.get(h.current) : h.defaultSlot;
    if (!active) throw new Error('Storage not initialized');
    return active;
  },
  getSyncEngine: () => null,
  getStorageFor: (id: string) => h.byId.get(id) ?? null,
  getSyncEngineFor: () => null,
  getAllAccountRuntimes: () => [...h.byId.entries()].map(([id, storage]) => [id, { storage, syncEngine: null, smtpClient: null }]),
}));
// As in production: ensureAccountRuntime OPENS a database (creating an empty,
// migrated one) for ANY id it is handed, and registers the runtime.
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  ensureAccountRuntime: vi.fn(async (id: string) => {
    h.created.push(id);
    const storage = h.openable.get(id) ?? { blankDatabaseFor: id, clearAllFirstSplits: () => ({ removed: 0, splits: 0 }) };
    h.byId.set(id, storage);
    return { storage, syncEngine: null };
  }),
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  readRegistryAccounts: () => {
    if (h.registryError) throw h.registryError;
    return h.registry.map((id) => ({ id, email: `${id}@x.test` }));
  },
}));
vi.mock('../../../../electron/services/ai-backlog-cap', () => ({ getAutoBacklogCap: vi.fn(), setAutoBacklogCap: vi.fn() }));
vi.mock('../../../../electron/services/ai-secret-store', () => ({
  getAllAiSecrets: vi.fn(), setAiSecret: vi.fn(), deleteAiSecret: vi.fn(), isSecureStorageAvailable: vi.fn(),
}));
vi.mock('../../../../electron/services/conversation-extraction-scheduler', () => ({
  setAIProviderConfigured: vi.fn(),
  setBackgroundSplitEnabled: vi.fn(),
}));
vi.mock('../../../../electron/services/pipeline-ai-config-store', () => ({ clearPipelineAIConfig: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({ onCategoryDefinitionUpserted: vi.fn() }));

import { registerAIHandlers, UNNAMED_MAILBOX_LABEL } from '../../../../electron/ipc/ai-handlers';
import { ensureAccountRuntime } from '../../../../electron/services/accounts-runtime';
import { setBackgroundSplitEnabled } from '../../../../electron/services/conversation-extraction-scheduler';
import { openTestAccount, type TestAccount } from '../../../helpers/account-storage';

registerAIHandlers();

type Envelope<T> = { success: boolean; data?: T; error?: string };
const call = async <T>(channel: string, ...args: unknown[]): Promise<Envelope<T>> =>
  (await h.handlers.get(channel)!({} as never, ...args)) as Envelope<T>;
const get = (accountId: string, threadId: string, withSource = false) =>
  call<FirstSplitGetResult>('ai:firstSplit:get', accountId, threadId, { withSource });
const save = (accountId: string, request: FirstSplitSaveRequest) =>
  call<FirstSplitSaveResult>('ai:firstSplit:save', accountId, request);

const T0 = 1_780_000_000;
const THREAD = 'thread-shared';

const PARTS = [
  { role: 'own' as const, fromAddress: 'a@x.test', fromName: 'A', date: T0, dateApprox: false, body: '<p>own</p>', fallback: false },
  { role: 'quote' as const, fromAddress: 'b@x.test', fromName: null, date: T0 - 60, dateApprox: false, body: '<p>quoted</p>', fallback: false },
];
const okFor = (key: FirstSplitKey): FirstSplitSaveRequest => ({ key, status: 'ok', parts: PARTS, quoteCount: 1, modelUsed: 'm' });

let dir = '';
let accountA: TestAccount;
let accountB: TestAccount;
let a: TestAccount['storage'];
let b: TestAccount['storage'];

/** An email in THREAD — the SAME thread id in both accounts, as header-derived ids are. */
const email = (id: string, over: Partial<EmailRecord> = {}): Partial<EmailRecord> & { id: string } => ({
  id, subject: 'Looped in', fromAddress: `${id}@sender.test`, fromName: `Sender ${id}`, date: T0, ...over,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ai-handlers-first-split-'));
  accountA = await openTestAccount(dir, 'a');
  accountB = await openTestAccount(dir, 'b');
  await accountA.add(THREAD, email('a1'));
  await accountB.add(THREAD, email('b1'));
  a = accountA.storage;
  b = accountB.storage;
  h.current = 'acct-a';
  h.byId = new Map<string, unknown>([['acct-a', a], ['acct-b', b]]);
  h.registry = ['acct-a', 'acct-b'];
  h.registryError = null;
  h.openable = new Map();
  h.created = [];
  h.defaultSlot = null;
});

afterEach(async () => {
  await accountA.close();
  await accountB.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ai:firstSplit:get / save — routed by account, never by the active one', () => {
  // Breaks: cross-account cache sharing — account B's thread served A's first email.
  it("reads each account's own current key for the same thread id", async () => {
    const fromA = await get('acct-a', THREAD);
    const fromB = await get('acct-b', THREAD);
    expect(fromA.data!.current).toMatchObject({ threadId: THREAD, firstEmailId: 'a1', memberCount: 1, distinctSenders: 1 });
    expect(fromB.data!.current).toMatchObject({ threadId: THREAD, firstEmailId: 'b1' });
    expect(fromA.data!.row).toBeNull();
    // No source unless asked for.
    expect(fromA.data!.source).toBeUndefined();
  });

  // Breaks: THE audit regression — a save for account B while A is active
  // lands in A's database.
  it('a save for account B while A is active lands only in B', async () => {
    const keyB = (await get('acct-b', THREAD)).data!.current!;
    expect((await save('acct-b', okFor(keyB))).data).toEqual({ applied: true, status: 'ok' });

    expect(b.getFirstSplitSync(THREAD)).toMatchObject({ status: 'ok', firstEmailId: 'b1' });
    expect(a.getFirstSplitSync(THREAD)).toBeNull();
    expect((await get('acct-b', THREAD)).data!.row).toMatchObject({ status: 'ok' });
    expect((await get('acct-a', THREAD)).data!.row).toBeNull();
  });

  // Breaks: a raced run (a mail arrived in front of the first email) caches a
  // split of an email that is no longer first.
  it("returns applied:false 'stale' for a key that is no longer current", async () => {
    const key = (await get('acct-a', THREAD)).data!.current!;
    await accountA.add(THREAD, email('a0', { date: T0 - 100 }));
    expect((await save('acct-a', okFor(key))).data).toEqual({ applied: false, reason: 'stale' });
    expect(a.getFirstSplitSync(THREAD)).toBeNull();
  });

  // Breaks: an account that cannot be resolved silently falls back to the
  // active account (the read of the wrong cache, or the write into it) — or,
  // for a removed account's id, a blank database is CREATED under it (the
  // runtime opener makes one for any id) and joins every all-accounts loop.
  it('fails loudly for an account it cannot resolve, and never creates a database for it', async () => {
    const key = (await get('acct-a', THREAD)).data!.current!;
    const read = await get('acct-gone', THREAD);
    const write = await save('acct-gone', okFor(key));
    expect(read).toMatchObject({ success: false, error: expect.stringMatching(/not available/) });
    expect(write).toMatchObject({ success: false, error: expect.stringMatching(/not available/) });
    expect(a.getFirstSplitSync(THREAD)).toBeNull();
    expect(h.created).toEqual([]);
    expect(h.byId.has('acct-gone')).toBe(false);
  });

  // Breaks: the AI splits an OLDER draft or a Trash copy instead of the first
  // real message — the source must be the first MEMBER.
  it('withSource returns the first MEMBER and the distinct senders, never a draft or a Trash copy', async () => {
    await accountA.add(THREAD, email('draft', { date: T0 - 300, tags: '|INBOX.Drafts|', folderId: 'f-drafts' }));
    await accountA.add(THREAD, email('binned', { date: T0 - 200, tags: '|Trash|', folderId: 'f-trash' }));
    await accountA.add(THREAD, email('a2', { date: T0 + 100, fromAddress: 'A1@Sender.test', fromName: 'Again' }));
    await accountA.add(THREAD, email('a3', { date: T0 + 200, fromAddress: 'c@sender.test', fromName: null }));

    const result = (await get('acct-a', THREAD, true)).data!;
    expect(result.source).toMatchObject({ id: 'a1', rawBody: '<p>a1 body</p>' });
    expect(result.current).toMatchObject({ firstEmailId: 'a1', memberCount: 3, distinctSenders: 2 });
    expect(result.roster).toEqual([
      { address: 'a1@sender.test', name: 'Sender a1' },
      { address: 'c@sender.test', name: null },
    ]);
  });

  // Breaks: the split's name lookup — a sender with no address becomes a
  // roster entry, or a sender's display name is lost because their first
  // message carried none.
  it('builds the roster from real addresses only, filling a missing name from a later message', async () => {
    await accountA.add(THREAD, email('noname', { date: T0 + 100, fromAddress: 'q@sender.test', fromName: null }));
    await accountA.add(THREAD, email('named', { date: T0 + 200, fromAddress: 'Q@sender.test', fromName: ' Quinn ' }));
    await accountA.add(THREAD, email('blank', { date: T0 + 300, fromAddress: '  ', fromName: 'Nobody' }));

    const result = (await get('acct-a', THREAD, true)).data!;
    expect(result.roster).toEqual([
      { address: 'a1@sender.test', name: 'Sender a1' },
      { address: 'q@sender.test', name: 'Quinn' },
    ]);
    expect(result.current).toMatchObject({ memberCount: 4, distinctSenders: 2 });
  });

  // Breaks: a malformed payload from the renderer is stored (an "ok" row that
  // can never be shown) or throws instead of being refused.
  it("refuses a malformed payload with applied:false 'invalid'", async () => {
    const key = (await get('acct-a', THREAD)).data!.current!;
    expect((await save('acct-a', { ...okFor(key), parts: [] })).data).toEqual({ applied: false, reason: 'invalid' });
    expect(a.getFirstSplitSync(THREAD)).toBeNull();
  });

  // Breaks: a thread with no member (a lone draft) reports a key a run would
  // then save against.
  it('reports no current key (and no source) for a thread with no member', async () => {
    const result = (await get('acct-a', 'no-such-thread', true)).data!;
    expect(result).toEqual({ row: null, current: null, source: null, roster: [] });
  });
});

describe('ai:firstSplit:clearAll — every account', () => {
  // Breaks: Clear Cache covering only the active account.
  it('clears both accounts and counts every row', async () => {
    await save('acct-a', okFor((await get('acct-a', THREAD)).data!.current!));
    await save('acct-b', okFor((await get('acct-b', THREAD)).data!.current!));

    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result.data).toEqual({ cleared: 2, splits: 2, failedAccounts: [] });
    expect(a.getFirstSplitSync(THREAD)).toBeNull();
    expect(b.getFirstSplitSync(THREAD)).toBeNull();
  });

  // Breaks: Clear Cache does nothing when no account is active yet (still on
  // the pre-account slot) although background accounts hold rows.
  it('still clears every open account when none is active', async () => {
    await save('acct-b', okFor((await get('acct-b', THREAD)).data!.current!));
    h.current = null;
    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result.data).toEqual({ cleared: 1, splits: 1, failedAccounts: [] });
  });

  // Breaks: a failing account is reported as "0 cleared" — the user is told
  // the cache is empty while that account's rows are still there.
  it('reports an account that throws instead of counting it as 0, and still clears the others', async () => {
    await save('acct-a', okFor((await get('acct-a', THREAD)).data!.current!));
    await save('acct-b', okFor((await get('acct-b', THREAD)).data!.current!));
    const broken = { clearAllFirstSplits: () => { throw new Error('database is locked'); } };
    h.byId.set('acct-c', broken);
    h.registry = ['acct-a', 'acct-b', 'acct-c'];

    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result.data).toEqual({ cleared: 2, splits: 2, failedAccounts: ['acct-c'] });
  });

  // Breaks: Clear Cache skipping, without a trace, a configured account whose
  // runtime is not open this session (runtimes open lazily) — "cleared N,
  // failedAccounts []" while that account's rows are still there.
  it('clears a configured account whose runtime is not open this session', async () => {
    const accountC = await openTestAccount(dir, 'c');
    try {
      await accountC.add(THREAD, email('c1'));
      accountC.storage.saveFirstSplit(okFor(accountC.storage.firstMemberKeySync(THREAD)!));
      h.registry = ['acct-a', 'acct-b', 'acct-c'];
      h.openable.set('acct-c', accountC.storage);

      const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
      expect(result.data).toEqual({ cleared: 1, splits: 1, failedAccounts: [] });
      expect(h.created).toEqual(['acct-c']);
      expect(accountC.storage.getFirstSplitSync(THREAD)).toBeNull();
    } finally {
      await accountC.close();
    }
  });

  // Breaks: a configured account that cannot be opened (held for maintenance,
  // primary not established) counted as "nothing to clear".
  it('reports a configured account that cannot be opened', async () => {
    h.registry = ['acct-a', 'acct-b', 'acct-held'];
    vi.mocked(ensureAccountRuntime).mockResolvedValueOnce(null);
    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result.data).toEqual({ cleared: 0, splits: 0, failedAccounts: ['acct-held'] });
  });

  // Breaks: an open storage the registry does not name (the pre-account
  // default slot) keeping its rows after Clear Cache.
  it('also clears an open storage the registry does not name', async () => {
    await save('acct-b', okFor((await get('acct-b', THREAD)).data!.current!));
    h.registry = ['acct-a'];
    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result.data).toEqual({ cleared: 1, splits: 1, failedAccounts: [] });
    expect(b.getFirstSplitSync(THREAD)).toBeNull();
  });

  // Breaks: one database cleared (and counted) twice when two configured ids
  // resolve to it, and an open storage outside the registry that fails being
  // dropped from the report.
  it('counts a shared database once, and reports a failing open storage the registry does not name', async () => {
    await save('acct-a', okFor((await get('acct-a', THREAD)).data!.current!));
    h.registry = ['acct-a', 'acct-a-alias', 'acct-b'];
    h.byId.set('acct-a-alias', a);
    h.byId.set('acct-orphan', { clearAllFirstSplits: () => { throw new Error('database is closed'); } });

    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result.data).toEqual({ cleared: 1, splits: 1, failedAccounts: ['acct-orphan'] });
  });

  // Breaks: the user reading "Could not clear active" — the pre-account
  // default slot has no account id, and its failure must be named in words
  // the reader understands.
  it('names a failing pre-account default slot "this mailbox", not an internal token', async () => {
    h.current = null;
    h.defaultSlot = { clearAllFirstSplits: () => { throw new Error('database is closed'); } };
    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result.data!.failedAccounts).toEqual([UNNAMED_MAILBOX_LABEL]);
    expect(UNNAMED_MAILBOX_LABEL).toBe('this mailbox');
  });

  // Breaks: Clear Cache reporting the scheduler's bookkeeping rows (`skipped`
  // for every thread without quoted history, up to 200 per account per pass)
  // as "saved splits" — the user is told thousands were cleared when only a
  // handful existed. Every row still goes; only ok/partial rows are counted
  // as splits.
  it('counts only ok/partial rows as splits, across accounts, while still removing skipped rows', async () => {
    await save('acct-a', okFor((await get('acct-a', THREAD)).data!.current!));
    const keyB = (await get('acct-b', THREAD)).data!.current!;
    await save('acct-b', { key: keyB, status: 'skipped', quoteCount: 0, modelUsed: null });

    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result.data).toEqual({ cleared: 2, splits: 1, failedAccounts: [] });
    expect(a.getFirstSplitSync(THREAD)).toBeNull();
    expect(b.getFirstSplitSync(THREAD)).toBeNull();
  });

  // Breaks: an unreadable account list reported as a (partial) success — the
  // user is told the cache is clear when which accounts exist is unknown.
  it('fails the whole call, clearing nothing, when the account list cannot be read', async () => {
    await save('acct-a', okFor((await get('acct-a', THREAD)).data!.current!));
    h.registryError = new Error('core DB unreadable');
    const result = await call<FirstSplitClearAllResult>('ai:firstSplit:clearAll');
    expect(result).toEqual({ success: false, error: expect.stringMatching(/account list.*core DB unreadable/) });
    expect(a.getFirstSplitSync(THREAD)).not.toBeNull();
  });
});

describe('ai:setBackgroundSplitEnabled', () => {
  // Breaks: main's first-split scheduler scanning every account (and cooling
  // refs down) while the reader has the background split switched off, or
  // never scanning once it is on. A malformed payload must read as OFF —
  // never as a switch the reader did not turn on.
  it('hands the switch to the scheduler, and anything but `true` reads as off', async () => {
    const setter = vi.mocked(setBackgroundSplitEnabled);
    setter.mockClear();
    expect(await call('ai:setBackgroundSplitEnabled', true)).toEqual({ success: true });
    expect(await call('ai:setBackgroundSplitEnabled', false)).toEqual({ success: true });
    await call('ai:setBackgroundSplitEnabled', 'yes');
    await call('ai:setBackgroundSplitEnabled');
    expect(setter.mock.calls).toEqual([[true], [false], [false], [false]]);
  });
});
