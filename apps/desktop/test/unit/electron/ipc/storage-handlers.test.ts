import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The storage-maintenance IPC surface.
 *
 * The regression this exists for: the SAME email address can be configured on
 * two different servers (a Gmail account and a Sarv account both reading
 * `someone@sarv.com`). Identified by address alone the two rows in Settings ->
 * Advanced are indistinguishable, and the user cannot tell which database they
 * are about to spend ten minutes rebuilding. The host has to travel with every
 * row for the list to mean anything.
 */

const h = vi.hoisted(() => ({
  accountIds: ['acct-gmail', 'acct-sarv'],
  registry: [
    {
      id: 'acct-gmail',
      email: 'someone@sarv.com',
      imapConfig: { host: 'imap.gmail.com', port: 993 },
    },
    {
      id: 'acct-sarv',
      email: 'someone@sarv.com',
      imapConfig: { host: 'imap.sarv.com', port: 993 },
    },
  ] as Array<{ id: string; email: string; imapConfig: Record<string, unknown> | null }>,
  estimates: {
    'acct-gmail': { accountId: 'acct-gmail', fileBytes: 10_000, freeBytes: 8_000, liveBytes: 2_000, freeRatio: 0.8, worthwhile: true },
    'acct-sarv': { accountId: 'acct-sarv', fileBytes: 600, freeBytes: 0, liveBytes: 600, freeRatio: 0, worthwhile: false },
  } as Record<string, unknown>,
  currentAccountId: 'acct-gmail' as string | null,
  compactCalls: [] as string[],
  compactRejects: null as string | null,
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('../../../../electron/services/accounts-registry', () => ({
  listRegistryAccounts: () => h.registry,
}));

vi.mock('../../../../electron/services/db-compact', () => ({
  estimateCompaction: (accountId: string) => h.estimates[accountId] ?? null,
  compactAccountDatabase: async (accountId: string) => {
    h.compactCalls.push(accountId);
    if (h.compactRejects) throw new Error(h.compactRejects);
    return { accountId, beforeBytes: 10_000, afterBytes: 2_000, reclaimedBytes: 8_000, elapsedMs: 1_000 };
  },
}));

vi.mock('../../../../electron/shared', () => ({
  getAllAccountIds: () => h.accountIds,
  getCurrentAccountId: () => h.currentAccountId,
}));

import { registerStorageHandlers } from '../../../../electron/ipc/storage-handlers';

registerStorageHandlers();

const invoke = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!(null, ...args);

beforeEach(() => {
  h.accountIds = ['acct-gmail', 'acct-sarv'];
  h.currentAccountId = 'acct-gmail';
  h.compactCalls = [];
  h.compactRejects = null;
});

describe('storage:usage', () => {
  // Breaks: two accounts on the same address render as identical rows and the
  // user compresses whichever one they guess at.
  it('returns the IMAP host alongside each account so same-address rows differ', async () => {
    const result = (await invoke('storage:usage')) as {
      success: boolean;
      data: Array<{ accountId: string; email: string; host: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.data.map((row) => [row.email, row.host])).toEqual([
      ['someone@sarv.com', 'imap.gmail.com'],
      ['someone@sarv.com', 'imap.sarv.com'],
    ]);
  });

  // Breaks: the panel shows a size but no reclaimable figure, so the button
  // offers a rebuild with no stated benefit.
  it('carries the size and reclaimable figures through', async () => {
    const result = (await invoke('storage:usage')) as { data: Array<Record<string, unknown>> };

    expect(result.data[0]).toMatchObject({ fileBytes: 10_000, freeBytes: 8_000, worthwhile: true });
    expect(result.data[1]).toMatchObject({ freeBytes: 0, worthwhile: false });
  });

  // Breaks: an OAuth account with no stored imapConfig renders `undefined` next
  // to its address.
  it('falls back to an empty host when the account has no IMAP config', async () => {
    h.registry = [{ id: 'acct-gmail', email: 'someone@sarv.com', imapConfig: null }];
    h.accountIds = ['acct-gmail'];

    const result = (await invoke('storage:usage')) as { data: Array<{ host: string }> };

    expect(result.data[0].host).toBe('');
  });

  // Breaks: an account open in the runtime but absent from the registry drops
  // out of the list entirely, so its database can never be compressed.
  it('still lists an account missing from the registry', async () => {
    h.registry = [];
    h.accountIds = ['acct-gmail'];

    const result = (await invoke('storage:usage')) as { data: Array<{ email: string; host: string }> };

    expect(result.data).toEqual([expect.objectContaining({ email: 'acct-gmail', host: '' })]);
  });

  // Breaks: an account whose handle closed between the list and the read throws
  // out of the handler and the whole Advanced tab fails to load.
  it('skips an account whose stats cannot be read', async () => {
    h.accountIds = ['acct-gmail', 'acct-closed'];

    const result = (await invoke('storage:usage')) as { data: unknown[] };

    expect(result.data).toHaveLength(1);
  });
});

describe('storage:compact', () => {
  // Breaks: the renderer's per-row button compresses the active account instead
  // of the row that was clicked — on a two-account setup, the wrong database.
  it('compacts the account it was given', async () => {
    await invoke('storage:compact', 'acct-sarv');

    expect(h.compactCalls).toEqual(['acct-sarv']);
  });

  // Breaks: a call with no id silently does nothing instead of acting on the
  // account the user is looking at.
  it('falls back to the active account', async () => {
    await invoke('storage:compact', undefined);

    expect(h.compactCalls).toEqual(['acct-gmail']);
  });

  // Breaks: with no account open this would compact `undefined`.
  it('refuses when there is no account at all', async () => {
    h.currentAccountId = null;

    const result = (await invoke('storage:compact', undefined)) as { success: boolean };

    expect(result.success).toBe(false);
    expect(h.compactCalls).toEqual([]);
  });

  // Breaks: refusals (mid-sync, no disk headroom) reach the renderer as a
  // generic failure, so the user is never told what to do about it.
  it('passes the refusal reason through verbatim', async () => {
    h.compactRejects = 'Mail is syncing right now. Wait for the sync to finish, then try again.';

    const result = (await invoke('storage:compact', 'acct-gmail')) as { success: boolean; error: string };

    expect(result).toEqual({ success: false, error: h.compactRejects });
  });

  // Breaks: the success banner cannot report what was actually freed.
  it('returns the outcome on success', async () => {
    const result = (await invoke('storage:compact', 'acct-gmail')) as { success: boolean; data: unknown };

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ reclaimedBytes: 8_000 });
  });
});
