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
  // CASA M-5. Breaks: removing the only account, whose server refused
  // STARTTLS, leaves its "Not connected … your existing mail is still
  // available" banner above the no-account screen.
  it("drops the removed last account's STARTTLS refusals", async () => {
    const { state } = await loadSlice({
      accounts: [account('a')], activeAccountId: 'a', connected: false,
      connectionSecurityIssue: 'The incoming mail server imap.a did not agree.',
      smtpSecurityIssue: 'The outgoing mail server smtp.a did not agree.',
    }, baseElectronAPI());

    await state.removeAccountById('a');

    expect(state.activeAccountId).toBeNull();
    expect(state.connectionSecurityIssue).toBeNull();
    expect(state.smtpSecurityIssue).toBeNull();
  });

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

  // CASA 6.6.1. An older build's plaintext secrets in localStorage outlive the
  // vault (migrateCredentialsToVault leaves them when a vault write fails).
  describe('legacy plaintext secrets in localStorage', () => {
    const LEGACY_IMAP = 'sarvinbox-credentials';
    const LEGACY_SMTP = 'sarvinbox-smtp-credentials';
    const withLogin = (id: string) => account(id, {
      imapConfig: { host: `imap.${id}.com`, username: `${id}@example.com` },
      smtpConfig: { host: `smtp.${id}.com`, port: 465, secure: true, username: `${id}@example.com` },
    });
    const seedLegacyFor = (id: string) => {
      localStorage.setItem(LEGACY_IMAP, JSON.stringify({ host: `imap.${id}.com`, username: `${id}@example.com`, password: `${id}-imap-pw` }));
      localStorage.setItem(LEGACY_SMTP, JSON.stringify({ host: `smtp.${id}.com`, username: `${id}@example.com`, password: `${id}-smtp-pw` }));
    };
    const plaintextOnDisk = () => [LEGACY_IMAP, LEGACY_SMTP, 'sarvinbox-accounts'].map((k) => localStorage.getItem(k) ?? '').join('\n');

    // Breaks: removing a background account leaves its IMAP/SMTP passwords on
    // disk in the legacy keys (and its row's, in the accounts list).
    it("deletes the removed account's entries while another account remains", async () => {
      const { state } = await loadSlice({ accounts: [withLogin('a'), withLogin('b')], activeAccountId: 'a' }, baseElectronAPI());
      seedLegacyFor('b');
      localStorage.setItem('sarvinbox-accounts', JSON.stringify([withLogin('a'), { ...withLogin('b'), imapConfig: { ...withLogin('b').imapConfig, password: 'b-row-pw' } }]));

      await state.removeAccountById('b');

      expect(localStorage.getItem(LEGACY_IMAP)).toBeNull();
      expect(localStorage.getItem(LEGACY_SMTP)).toBeNull();
      expect(plaintextOnDisk()).not.toMatch(/b-(imap|smtp|row)-pw/);
    });

    // Breaks (credential loss, multi-account): removing B deletes A's legacy
    // entries — after a failed vault migration, A's only copy of its password.
    it("keeps a remaining account's entries", async () => {
      const { state } = await loadSlice({ accounts: [withLogin('a'), withLogin('b')], activeAccountId: 'a' }, baseElectronAPI());
      seedLegacyFor('a');

      await state.removeAccountById('b');

      expect(localStorage.getItem(LEGACY_IMAP)).toContain('a-imap-pw');
      expect(localStorage.getItem(LEGACY_SMTP)).toContain('a-smtp-pw');
    });

    // Breaks: the last account goes but its legacy keys stay — and the next
    // launch resurrects them as "Account 1". It used to be cleared only when
    // the removed account was also the ACTIVE one.
    it.each([['active', 'a'], ['not active', null]] as const)('clears every legacy entry when the last account (%s) is removed', async (_label, active) => {
      const { state } = await loadSlice({ accounts: [withLogin('a')], activeAccountId: active }, baseElectronAPI());
      seedLegacyFor('a');

      await state.removeAccountById('a');

      expect(localStorage.getItem(LEGACY_IMAP)).toBeNull();
      expect(localStorage.getItem(LEGACY_SMTP)).toBeNull();
      expect(plaintextOnDisk()).not.toContain('-pw');
    });

    // Breaks: a removal that FAILED (the account stays) already threw away
    // its legacy plaintext — possibly its only copy of the password.
    it('keeps them when the durable wipe failed', async () => {
      const api = baseElectronAPI({ accounts: { remove: vi.fn().mockResolvedValue({ success: false, error: 'disk busy' }) } });
      const { state } = await loadSlice({ accounts: [withLogin('a'), withLogin('b')], activeAccountId: 'a' }, api);
      seedLegacyFor('b');

      await expect(state.removeAccountById('b')).rejects.toThrow('disk busy');

      expect(localStorage.getItem(LEGACY_IMAP)).toContain('b-imap-pw');
      expect(localStorage.getItem(LEGACY_SMTP)).toContain('b-smtp-pw');
    });
  });

  // The accounts list in localStorage. Before, it was rewritten (through the
  // secret-stripping saveAccounts) BEFORE the main-process removal ran.
  describe('the stored accounts list', () => {
    const ACCOUNTS_KEY = 'sarvinbox-accounts';
    // As a failed vault migration leaves them: each row still carries its password.
    const storedRow = (id: string) => account(id, { imapConfig: { host: `imap.${id}.com`, username: `${id}@example.com`, password: `${id}-row-pw` } });
    const seedStoredRows = (...ids: string[]) => {
      const raw = JSON.stringify(ids.map(storedRow));
      localStorage.setItem(ACCOUNTS_KEY, raw);
      return raw;
    };
    const failing = () => baseElectronAPI({ accounts: { remove: vi.fn().mockResolvedValue({ success: false, error: 'disk busy' }) } });

    // Breaks: a removal that FAILED (the account stays, to be retried) has
    // already dropped its row and stripped every other row's password —
    // after a failed vault migration, their only copy.
    it.each([['a background account', 'b'], ['the active account', 'a']] as const)('is untouched when removing %s fails', async (_label, id) => {
      const { state } = await loadSlice({ accounts: [account('a'), account('b')], activeAccountId: 'a' }, failing());
      const before = seedStoredRows('a', 'b');

      await expect(state.removeAccountById(id)).rejects.toThrow('disk busy');

      expect(localStorage.getItem(ACCOUNTS_KEY)).toBe(before);
      expect(state.accounts.map((a: any) => a.id)).toEqual(['a', 'b']);
      expect(state.activeAccountId).toBe('a');
    });

    // Breaks: the same, when the main process rejects instead of reporting failure.
    it('is untouched when the removal call itself rejects', async () => {
      const api = baseElectronAPI({ accounts: { remove: vi.fn().mockRejectedValue(new Error('IPC gone')) } });
      const { state } = await loadSlice({ accounts: [account('a'), account('b')], activeAccountId: 'a' }, api);
      const before = seedStoredRows('a', 'b');

      await expect(state.removeAccountById('b')).rejects.toThrow('IPC gone');

      expect(localStorage.getItem(ACCOUNTS_KEY)).toBe(before);
    });

    // Breaks: a successful removal is not persisted (the account comes back at
    // the next launch), or it rewrites the OTHER rows — stripping the password
    // a failed vault migration left in them.
    it.each([['a background account', 'b', 'a'], ['the active account', 'a', 'b']] as const)('drops only the removed row when removing %s succeeds', async (_label, removed, kept) => {
      const { state } = await loadSlice({ accounts: [account('a'), account('b')], activeAccountId: 'a' }, baseElectronAPI());
      seedStoredRows('a', 'b');

      await state.removeAccountById(removed);

      expect(JSON.parse(localStorage.getItem(ACCOUNTS_KEY)!)).toEqual([storedRow(kept)]);
      expect(state.accounts.map((a: any) => a.id)).toEqual([kept]);
      if (removed === 'a') expect(state.selectAccount).toHaveBeenCalledWith('b');
    });

    // Breaks: removing the last account leaves its row (with its password) on disk.
    it('is emptied when the last account is removed', async () => {
      const { state } = await loadSlice({ accounts: [account('a')], activeAccountId: 'a' }, baseElectronAPI());
      seedStoredRows('a');

      await state.removeAccountById('a');

      expect(JSON.parse(localStorage.getItem(ACCOUNTS_KEY)!)).toEqual([]);
      expect(state.activeAccountId).toBeNull();
    });
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
