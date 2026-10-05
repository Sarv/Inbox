import { beforeEach, describe, expect, it, vi } from 'vitest';

// accounts:remove must end the removed mailbox's OAuth grant: delete its tokens
// and revoke it at the provider. It used to happen in the renderer, and only for
// the ACTIVE account — removing a background Gmail account left its refresh
// token on disk and the app still listed under the user's Google third-party
// access, which contradicts the privacy policy and fails Google's review.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  registry: [] as Array<{ id: string; imapConfig: Record<string, unknown> | null }>,
  registryThrows: false,
  calls: [] as string[],
  signOut: vi.fn(),
  clearWarning: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn), on: () => {} },
}));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../../../electron/services/accounts-registry', async () => {
  const actual = await vi.importActual<typeof import('../../../../electron/services/accounts-registry')>(
    '../../../../electron/services/accounts-registry',
  );
  return {
    oauthIdentityOf: actual.oauthIdentityOf,
    listRegistryAccounts: () => [...h.registry],
    readRegistryAccounts: () => {
      if (h.registryThrows) throw new Error('addon failed to load');
      return [...h.registry];
    },
    removeRegistryAccount: (id: string) => {
      h.calls.push(`registry-remove:${id}`);
      h.registry = h.registry.filter((a) => a.id !== id);
    },
    upsertRegistryAccounts: () => {},
    getRegistryActiveAccountId: () => null,
    setRegistryActiveAccountId: () => {},
    getAllAppSettings: () => ({}),
    setAppSetting: () => {},
    deleteAppSetting: () => {},
  };
});
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  deleteAccountData: async (id: string) => { h.calls.push(`wipe:${id}`); },
  cleanupOrphanedAccountDbs: () => [],
  ensureAccountRuntime: async () => null,
  loadPrimaryAccountId: () => null,
  savePrimaryAccountId: () => {},
  accountInboxUnread: async () => 0,
  rekeyAccount: async () => {},
  legacyDbExists: () => false,
}));
vi.mock('../../../../electron/services/oauth-refresh-scheduler', () => ({
  signOutOAuthAccount: (p: string, e: string) => { h.calls.push(`signout:${p}:${e}`); return h.signOut(p, e); },
}));
vi.mock('../../../../electron/services/outbox-service', () => ({ rebindOutboxStorage: () => {} }));
vi.mock('../../../../electron/services/attachment-warning-preferences', () => ({
  clearUnscannedWarningPreference: h.clearWarning,
}));
vi.mock('../../../../electron/services/reputation-service', () => ({ noteAppSettingChanged: () => {} }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  disablePipelineAIIfProviderRemoved: async () => { h.calls.push('ai-revalidate'); },
}));
vi.mock('../../../../electron/shared', () => ({
  setCurrentAccount: () => {},
  hasAccountRuntime: () => false,
  getCurrentAccountId: () => null,
}));

import { registerAccountsHandlers } from '../../../../electron/ipc/accounts-handlers';

const oauth = (id: string, provider: string, username: string) =>
  ({ id, imapConfig: { authMethod: 'oauth2', oauthProvider: provider, username } });
const remove = (id: string) => h.handlers.get('accounts:remove')!(null, id);

beforeEach(() => {
  h.handlers.clear();
  h.registry = [];
  h.registryThrows = false;
  h.calls.length = 0;
  h.signOut.mockReset().mockResolvedValue({ revocation: Promise.resolve('revoked') });
  h.clearWarning.mockReset();
  registerAccountsHandlers();
});

describe('accounts:remove — OAuth sign-out', () => {
  // Breaks: removing/re-adding a mailbox inherits an old warning-suppression choice or clears another mailbox's choice.
  it('clears only the removed account warning preference before deleting its data', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com'), oauth('a2', 'microsoft', 'me@outlook.com')];
    h.clearWarning.mockImplementation((accountId: string) => {
      expect(accountId).toBe('a1');
      expect(h.calls).toEqual([]);
    });
    await expect(remove('a1')).resolves.toEqual({ success: true });
    expect(h.clearWarning).toHaveBeenCalledExactlyOnceWith('a1');
  });

  // Breaks: account data is wiped while durable suppression could not be cleared.
  it('does not remove data when the warning preference store is unreadable', async () => {
    h.clearWarning.mockImplementation(() => { throw new Error('warning store unreadable'); });
    await expect(remove('a1')).resolves.toEqual({ success: false, error: 'warning store unreadable' });
    expect(h.calls).toEqual([]);
  });

  // Multi-account: a NON-active Gmail account is signed out too, after its data
  // is wiped and BEFORE AI is revalidated (a removed Sarv grant must read as gone).
  it('signs out the removed account\'s grant between the wipe and the AI revalidation', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com'), oauth('a2', 'microsoft', 'me@outlook.com')];

    await expect(remove('a1')).resolves.toEqual({ success: true });

    expect(h.calls).toEqual(['wipe:a1', 'registry-remove:a1', 'signout:gmail:me@gmail.com', 'ai-revalidate']);
  });

  // Password accounts have no grant to revoke.
  it('does nothing OAuth-related for a password account', async () => {
    h.registry = [{ id: 'p1', imapConfig: { authMethod: 'password', username: 'x@y.com' } }];
    await remove('p1');
    expect(h.calls.some((c) => c.startsWith('signout'))).toBe(false);
  });

  // Revoking a grant another mailbox still uses would log that mailbox out.
  it('keeps the grant when another remaining account uses the same provider + address', async () => {
    h.registry = [oauth('a1', 'sarv', 'me@sarv.com'), oauth('a2', 'sarv', 'me@sarv.com')];
    await remove('a1');
    expect(h.calls.some((c) => c.startsWith('signout'))).toBe(false);
  });

  // Unreadable ≠ empty: an unreadable registry must not license a revocation.
  it('skips sign-out when the registry cannot be read after removal', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    // list (the pre-removal read) works; the authoritative read throws.
    h.registryThrows = true;
    await expect(remove('a1')).resolves.toEqual({ success: true });
    expect(h.calls.some((c) => c.startsWith('signout'))).toBe(false);
  });

  // A failing sign-out (token store locked) must not fail the removal the user asked for.
  it('still reports success when sign-out throws', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    h.signOut.mockRejectedValue(new Error('token store locked'));
    await expect(remove('a1')).resolves.toEqual({ success: true });
    expect(h.calls).toContain('ai-revalidate');
  });

  // Idempotent re-run: removing an id that's no longer registered signs nothing out.
  it('does not sign out when the account is not in the registry', async () => {
    await remove('gone');
    expect(h.calls.some((c) => c.startsWith('signout'))).toBe(false);
  });
});
