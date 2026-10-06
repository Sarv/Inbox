import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ThreadMessage } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the manual "draft a reply" (agent:draftReply).
// It had its own thread query — every row of the thread, drafts included, the
// last ten, bodies cut to 300 characters — and handed the drafter
// `{ from, date: number, body }`, not the ThreadMessage it declares; and it
// always read the ACTIVE account, so a row from another account in the unified
// view was "Email not found". It now shares the pipeline's builder and names
// its account. Real account databases; the LLM call is refused (no provider),
// which happens only AFTER the drafter has gathered the thread.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  current: 'acct-a' as string | null,
  byId: new Map<string, unknown>(),
  built: [] as Array<{ storage: unknown; threadId: string; messages: ThreadMessage[] }>,
  created: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
}));
vi.mock('../../../../electron/shared', () => ({
  getCurrentAccountId: () => h.current,
  requireStorage: () => {
    const active = h.current ? h.byId.get(h.current) : null;
    if (!active) throw new Error('Storage not initialized');
    return active;
  },
  getSyncEngine: () => null,
  getStorageFor: (id: string) => h.byId.get(id) ?? null,
  getSyncEngineFor: () => null,
  getAllAccountRuntimes: () => [],
}));
// As in production: the runtime opener creates (and registers) a database for
// ANY id it is handed; only the registry says which ids are accounts.
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  ensureAccountRuntime: vi.fn(async (id: string) => {
    h.created.push(id);
    const storage = { blankDatabaseFor: id, getEmail: async () => null };
    h.byId.set(id, storage);
    return { storage, syncEngine: null };
  }),
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  resolveAccountIdentity: () => ({ email: 'me@me.test', name: 'Me', aliases: ['me@me.test'] }),
  readRegistryAccounts: () => [{ id: 'acct-a' }, { id: 'acct-b' }],
}));
vi.mock('../../../../electron/services/agent-config-store', () => ({ saveAgentConfig: vi.fn(), loadAgentConfig: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getIntelligence: vi.fn(() => null),
  getUnifiedPipeline: vi.fn(() => null),
  setPipelineUserProfile: vi.fn(),
  getPipelineAIConfig: vi.fn(() => null),
}));
// The REAL builder, observed: what the drafter was handed, and from which storage.
vi.mock('../../../../electron/services/thread-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../electron/services/thread-context')>();
  return {
    ...actual,
    buildThreadMessages: (storage: never, threadId: string, options: never) => {
      const messages = actual.buildThreadMessages(storage, threadId, options);
      h.built.push({ storage, threadId, messages });
      return messages;
    },
  };
});

import { logUserAction, registerAgentHandlers } from '../../../../electron/ipc/agent-handlers';
import { openTestAccount, type TestAccount } from '../../../helpers/account-storage';

registerAgentHandlers();

const T0 = 1_780_000_000;
const draftReply = async (emailId: string, accountId?: string) =>
  (await h.handlers.get('agent:draftReply')!({} as never, emailId, accountId)) as { success: boolean; error?: string };

let dir = '';
let a: TestAccount;
let b: TestAccount;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-draft-reply-'));
  a = await openTestAccount(dir, 'a');
  b = await openTestAccount(dir, 'b');
  // The same thread id in both accounts; the email being answered is B's.
  await a.add('t', { id: 'a-only', date: T0, subject: 'Other conversation' });
  await b.add('t', { id: 'b1', date: T0, fromAddress: 'boss@x.test', fromName: 'Boss', subject: 'Budget' });
  await b.add('t', { id: 'b-draft', date: T0 + 30, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
  await b.add('t', { id: 'b2', date: T0 + 60, fromAddress: 'me@me.test', fromName: null, subject: 'Re: Budget' });
  await b.add('t', { id: 'b3', date: T0 + 120, fromAddress: 'boss@x.test', fromName: 'Boss', subject: 'Re: Budget' });
  h.current = 'acct-a';
  h.byId = new Map<string, unknown>([['acct-a', a.storage], ['acct-b', b.storage]]);
  h.built = [];
  h.created = [];
});

afterEach(async () => {
  await a.close();
  await b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('agent:draftReply — thread context and account', () => {
  // Breaks: the divergent second builder — untyped messages, drafts in the
  // thread, the wrong account's rows.
  it("hands the drafter ThreadMessage objects of the NAMED account's conversation, without drafts", async () => {
    const result = await draftReply('b3', 'acct-b');

    // It got as far as the LLM call (which is refused: no provider).
    expect(result).toEqual({ success: false, error: 'No AI provider configured' });
    expect(h.built).toHaveLength(1);
    const [{ storage, threadId, messages }] = h.built;
    expect(storage).toBe(b.storage);
    expect(threadId).toBe('t');
    expect(messages.map((m) => m.messageId)).toEqual(['<b1@test.example>', '<b2@test.example>', '<b3@test.example>']);
    for (const message of messages) {
      expect(Object.keys(message).sort()).toEqual(['body', 'cc', 'date', 'from', 'isFromUser', 'messageId', 'subject', 'to']);
      expect(typeof message.date).toBe('string');
    }
    expect(messages[0]).toMatchObject({ from: 'Boss <boss@x.test>', subject: 'Budget', isFromUser: false });
    expect(messages[1]).toMatchObject({ from: 'me@me.test', isFromUser: true });
  });

  // Breaks: without an account the handler still serves the active account
  // (the pre-existing contract), where B's email does not exist.
  it('reads the active account when no account is named', async () => {
    expect(await draftReply('b3')).toEqual({ success: false, error: 'Email not found' });
    expect(h.built).toEqual([]);
  });

  // Breaks: an account that cannot be resolved silently drafts from the
  // active account's database — or a removed account's id recreates a blank
  // mailbox database under it.
  it('fails for an account it cannot resolve instead of falling back, creating nothing', async () => {
    const result = await draftReply('b3', 'acct-gone');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/acct-gone is not available/);
    expect(h.built).toEqual([]);
    expect(h.created).toEqual([]);
  });
});

describe('importance action account ownership', () => {
  // Regression: marking Important from unified inbox must not train the active account on another account's mail.
  it('writes the action only into the explicitly resolved account database', async () => {
    await logUserAction('b3', 'important', { threadId: 't', senderAddress: 'boss@x.test' }, b.storage);
    expect(await a.storage.getRepositories().agent.getActionsByEmail('b3')).toEqual([]);
    expect(await b.storage.getRepositories().agent.getActionsByEmail('b3')).toEqual([
      expect.objectContaining({ emailId: 'b3', actionType: 'important', threadId: 't' }),
    ]);
  });

  // Regression: older callers without an explicit account still log into their active account.
  it('keeps active-account logging for an unscoped action', async () => {
    await logUserAction('a-only', 'unimportant');
    expect(await a.storage.getRepositories().agent.getActionsByEmail('a-only')).toHaveLength(1);
    expect(await b.storage.getRepositories().agent.getActionsByEmail('a-only')).toEqual([]);
  });
});
