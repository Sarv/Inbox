import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { account, installLocalStorage, loadConnectionSlice, teardownStoreEnv } from './connection-slice-harness';

// removeAccountById got three behavioural changes that all need pinning:
//  1. It marks the account "deleting" BEFORE any await and keeps it in the list,
//     so the row shows "Deleting…" + is disabled for the whole (often slow, when
//     the connection is wedged) teardown instead of staying clickable/"connected"
//     until it abruptly vanishes.
//  2. A failed durable wipe rolls back: the account stays, its row re-enables, and
//     accountActionError carries the message — a failed delete must be retryable,
//     never a stuck "Deleting…".
//  3. If the account also backed an OAuth AI provider (Sarv is mailbox AND LLM),
//     that provider is pruned — otherwise the extraction loop retries against a
//     dead OAuth session forever and beachballs the app.

const AI_SETTINGS_KEY = 'sarvinbox-ai-settings';

/** loadConnectionSlice + the two things only this file needs: AI providers
 *  seeded into localStorage, and selectAccount stubbed so the "switch to the
 *  remaining account" path doesn't reach IPC. */
const loadSlice = async (initial: Record<string, any>, electronAPI: any) => {
  const providers = initial.__aiProviders;
  delete initial.__aiProviders;
  const { state } = await loadConnectionSlice(initial, electronAPI, {
    seed: () => {
      if (providers) localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify({ providers }));
    },
  });
  state.selectAccount = vi.fn().mockResolvedValue(undefined);
  return { state };
};

const baseElectronAPI = (over: any = {}) => ({
  imap: { disconnect: vi.fn().mockResolvedValue(undefined) },
  smtp: { disconnect: vi.fn().mockResolvedValue(undefined) },
  secureCreds: { delete: vi.fn().mockResolvedValue(undefined) },
  aiSecrets: { delete: vi.fn(), set: vi.fn() },
  ai: { setProviderConfigured: vi.fn().mockResolvedValue(undefined) },
  agent: { setAIConfig: vi.fn().mockResolvedValue(undefined) },
  accounts: { remove: vi.fn().mockResolvedValue({ success: true }) },
  ...over,
});

beforeEach(installLocalStorage);
afterEach(() => {
  teardownStoreEnv();
  vi.restoreAllMocks();
});

describe('removeAccountById', () => {
  it('removes an inactive account and clears the deleting marker on success', async () => {
    const api = baseElectronAPI();
    const { state } = await loadSlice(
      { accounts: [account('a'), account('b')], activeAccountId: 'a' },
      api,
    );

    await state.removeAccountById('b');

    expect(state.accounts.map((a: any) => a.id)).toEqual(['a']);
    expect(state.deletingAccountIds).toEqual([]);
    expect(state.accountActionError).toBeNull();
    // Inactive account: its sessions belong to the active account, so we must NOT
    // tear those down.
    expect(api.imap.disconnect).not.toHaveBeenCalled();
  });

  it('marks the account deleting BEFORE the async teardown resolves', async () => {
    // The regression: the row stayed clickable/"connected" during a slow teardown.
    // The deleting marker must be set synchronously, before the first await.
    let resolveRemove: (v: any) => void = () => {};
    const api = baseElectronAPI({
      accounts: { remove: vi.fn(() => new Promise((res) => { resolveRemove = res; })) },
    });
    const { state } = await loadSlice(
      { accounts: [account('a'), account('b')], activeAccountId: 'a' },
      api,
    );

    const pending = state.removeAccountById('b');
    // Teardown is in flight (accounts.remove hasn't resolved): still listed, marked.
    expect(state.deletingAccountIds).toContain('b');
    expect(state.accounts.map((a: any) => a.id)).toEqual(['a', 'b']);

    resolveRemove({ success: true });
    await pending;
    expect(state.deletingAccountIds).toEqual([]);
    expect(state.accounts.map((a: any) => a.id)).toEqual(['a']);
  });

  it('forgets the removed account’s cached storage figure', async () => {
    // The quota cache is keyed by account id and account ids are derived from
    // email + host: re-adding the same address would otherwise show the deleted
    // account's usage until the first lookup came back.
    const api = baseElectronAPI();
    const { state } = await loadSlice(
      {
        accounts: [account('a'), account('b')],
        activeAccountId: 'a',
        quotaByAccount: { a: { used: 1, limit: 2 }, b: { used: 3, limit: 4 } },
      },
      api,
    );

    await state.removeAccountById('b');

    expect(state.quotaByAccount).toEqual({ a: { used: 1, limit: 2 } });
    expect(JSON.parse(localStorage.getItem('sarvinbox-quota-cache')!)).toEqual({ a: { used: 1, limit: 2 } });
  });

  it('rolls back and records the error when the durable wipe reports failure', async () => {
    // The main handler RESOLVES with { success:false } rather than rejecting, so
    // this must be turned into a thrown failure or the account is half-removed.
    const api = baseElectronAPI({
      accounts: { remove: vi.fn().mockResolvedValue({ success: false, error: 'disk busy' }) },
    });
    const { state } = await loadSlice(
      { accounts: [account('a'), account('b')], activeAccountId: 'a' },
      api,
    );

    await expect(state.removeAccountById('b')).rejects.toThrow('disk busy');

    expect(state.accounts.map((a: any) => a.id)).toEqual(['a', 'b']); // kept
    expect(state.deletingAccountIds).toEqual([]); // re-enabled
    expect(state.accountActionError).toEqual({ id: 'b', message: 'disk busy' });
  });

  it('does not start a second removal for an account already deleting', async () => {
    let resolveRemove: (v: any) => void = () => {};
    const remove = vi.fn(() => new Promise((res) => { resolveRemove = res; }));
    const api = baseElectronAPI({ accounts: { remove } });
    const { state } = await loadSlice(
      { accounts: [account('a'), account('b')], activeAccountId: 'a' },
      api,
    );

    const first = state.removeAccountById('b');
    await state.removeAccountById('b'); // guarded no-op while the first is in flight
    expect(remove).toHaveBeenCalledTimes(1);

    resolveRemove({ success: true });
    await first;
  });

  it('prunes the OAuth AI provider backed by the removed account (beachball fix)', async () => {
    // Sarv is both mailbox AND LLM. If the provider survives account removal, the
    // extraction loop retries a dead OAuth session forever and locks the UI.
    const api = baseElectronAPI();
    const { state } = await loadSlice(
      {
        accounts: [account('a', { email: 'advik.d@sarv.com', imapConfig: { oauthProvider: 'sarv', authMethod: 'oauth2' } })],
        activeAccountId: 'a',
        __aiProviders: [
          { id: 'p1', type: 'sarv', name: 'Sarv', model: 'm', isDefault: true, authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'advik.d@sarv.com' },
        ],
      },
      api,
    );

    await state.removeAccountById('a');

    const providers = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!).providers;
    expect(providers).toHaveLength(0);
    // Re-synced the main pipeline gate so categorization stops too.
    expect(api.ai.setProviderConfigured).toHaveBeenCalledWith(false);
  });

  it('leaves AI providers untouched when the removed account did not back one', async () => {
    const api = baseElectronAPI();
    const { state } = await loadSlice(
      {
        accounts: [account('a', { imapConfig: { authMethod: 'password' } })],
        activeAccountId: 'a',
        __aiProviders: [
          { id: 'p1', type: 'gemini', name: 'Gemini', model: 'g', isDefault: true, authMethod: 'apiKey' },
        ],
      },
      api,
    );

    await state.removeAccountById('a');

    const providers = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)!).providers;
    expect(providers).toHaveLength(1);
  });
});
