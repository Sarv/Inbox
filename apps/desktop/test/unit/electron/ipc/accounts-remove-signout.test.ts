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
  session: {
    clearStorageData: vi.fn(),
    clearCache: vi.fn(),
    cookies: { flushStore: vi.fn() },
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn), on: () => {} },
  session: { defaultSession: h.session },
}));
// Changed deliberately (CASA I-6): accounts:remove now waits for the revocation
// with core's withTimeout and reads the provider registry for its outcome, so
// the real core is kept and only the logger is silenced.
vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
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
import { CONTENT_CLEAR_TIMEOUT_MS } from '../../../../electron/services/email-content-cookies';

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
  h.session.clearStorageData.mockReset().mockResolvedValue(undefined);
  h.session.clearCache.mockReset().mockResolvedValue(undefined);
  h.session.cookies.flushStore.mockReset().mockResolvedValue(undefined);
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
    // Changed deliberately (CASA I-6): an OAuth removal now reports its revocation outcome.
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'revoked' });
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

    // Changed deliberately (CASA I-6): an OAuth removal now reports its revocation outcome.
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'revoked' });

    expect(h.calls).toEqual(['wipe:a1', 'registry-remove:a1', 'signout:gmail:me@gmail.com', 'ai-revalidate']);
  });

  // Breaks the sign-out on a session store that never answers, which this app has
  // seen (dev-session-reset.ts): the token would never be deleted, the grant never
  // revoked and AI never revalidated. With the registry row already gone, that token
  // recreates the account on the next launch. The removal itself still has to end.
  it.each([
    ['the cookie clear', () => { h.session.clearStorageData.mockReturnValue(new Promise(() => {})); }],
    ['the cache clear', () => { h.session.clearCache.mockReturnValue(new Promise(() => {})); }],
    ['both clears', () => {
      h.session.clearStorageData.mockReturnValue(new Promise(() => {}));
      h.session.clearCache.mockReturnValue(new Promise(() => {}));
    }],
  ])('signs out and revalidates AI even when %s never finishes, and the removal still ends', async (_label, hang) => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    hang();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const removal = remove('a1');
      await vi.waitFor(() => expect(h.calls).toContain('ai-revalidate'));
      expect(h.calls).toEqual(['wipe:a1', 'registry-remove:a1', 'signout:gmail:me@gmail.com', 'ai-revalidate']);

      await vi.advanceTimersByTimeAsync(CONTENT_CLEAR_TIMEOUT_MS);
      await expect(removal).resolves.toMatchObject({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // Breaks the ordering the other way: the token goes before anything touches the
  // session, so a quit in that window cannot bring the account back.
  it('does not start clearing until the sign-out has finished', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    let finishSignOut: (value: unknown) => void = () => {};
    h.signOut.mockReturnValue(new Promise((resolve) => { finishSignOut = resolve; }));

    const removal = remove('a1');
    await vi.waitFor(() => expect(h.calls).toContain('signout:gmail:me@gmail.com'));
    expect(h.session.clearStorageData).not.toHaveBeenCalled();
    expect(h.session.clearCache).not.toHaveBeenCalled();

    finishSignOut({ revocation: Promise.resolve('revoked') });
    await expect(removal).resolves.toMatchObject({ success: true });
    expect(h.session.clearStorageData).toHaveBeenCalledOnce();
    expect(h.session.clearCache).toHaveBeenCalledOnce();
  });

  // Breaks if a failed sign-out cost the user the rest of the removal.
  it('still clears content and revalidates AI when the sign-out fails', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    h.signOut.mockRejectedValue(new Error('token store locked'));
    await expect(remove('a1')).resolves.toMatchObject({ success: true });
    expect(h.calls).toContain('ai-revalidate');
    expect(h.session.clearCache).toHaveBeenCalledOnce();
  });

  // The data goes first: a removal that failed must not clear anything.
  it('neither signs out nor clears content when the account data could not be deleted', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    h.clearWarning.mockImplementation(() => { throw new Error('warning store unreadable'); });
    await expect(remove('a1')).resolves.toMatchObject({ success: false });
    expect(h.calls).toEqual([]);
    expect(h.session.clearStorageData).not.toHaveBeenCalled();
    expect(h.session.clearCache).not.toHaveBeenCalled();
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
    // Changed deliberately (CASA I-6): the skipped sign-out is now reported.
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'skipped' });
    expect(h.calls.some((c) => c.startsWith('signout'))).toBe(false);
  });

  // A failing sign-out (token store locked) must not fail the removal the user asked for.
  it('still reports success when sign-out throws', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    h.signOut.mockRejectedValue(new Error('token store locked'));
    // Changed deliberately (CASA I-6): the failed sign-out is now reported.
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'failed' });
    expect(h.calls).toContain('ai-revalidate');
  });

  // Idempotent re-run: removing an id that's no longer registered signs nothing out.
  it('does not sign out when the account is not in the registry', async () => {
    await remove('gone');
    expect(h.calls.some((c) => c.startsWith('signout'))).toBe(false);
  });
});

// CASA I-6: accounts:remove reports what happened to the grant at the provider,
// so Settings can say whether the user still has something to do (Google:
// revoke at myaccount.google.com/permissions; Microsoft: no app can revoke).
// Removal itself must succeed whatever the provider does.
describe('accounts:remove — revocation outcome', () => {
  // Breaks: Settings claims (or denies) a revocation the provider did or did not confirm.
  it.each([
    ['revoked', 'revoked'],
    ['already-invalid', 'revoked'],
    ['unsupported', 'unsupported'],
    ['failed', 'failed'],
  ])('reports a %s revocation as %s', async (outcome, reported) => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    h.signOut.mockResolvedValue({ revocation: Promise.resolve(outcome) });
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: reported });
  });

  // Microsoft has no revocation endpoint at all. Breaks: Outlook removal reads as revoked.
  it('reports Microsoft as unsupported', async () => {
    h.registry = [oauth('a1', 'microsoft', 'me@outlook.com')];
    h.signOut.mockResolvedValue({ revocation: Promise.resolve('unsupported') });
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'unsupported' });
  });

  // No token left on this device: where the provider supports revocation the
  // grant may still be live, so the user must be told; elsewhere nothing could
  // have been revoked anyway.
  it.each([
    ['gmail', 'failed', 'me@gmail.com'],
    ['microsoft', 'unsupported', 'me@outlook.com'],
    ['sarv', 'failed', 'me@sarv.com'],
  ])('reports a %s grant with no stored token as %s', async (provider, reported, email) => {
    h.registry = [oauth('a1', provider, email)];
    h.signOut.mockResolvedValue({ revocation: Promise.resolve('no-account') });
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: reported });
  });

  // Offline / provider hanging. Breaks: the "Deleting…" state waits forever,
  // or a timeout fails the removal the user asked for.
  it('waits at most 10 s for the provider, then reports failed and still removes', async () => {
    vi.useFakeTimers();
    try {
      h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
      h.signOut.mockResolvedValue({ revocation: new Promise(() => {}) });
      const pending = remove('a1');
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toEqual({ success: true, revocation: 'failed' });
      expect(h.calls).toEqual(['wipe:a1', 'registry-remove:a1', 'signout:gmail:me@gmail.com', 'ai-revalidate']);
    } finally {
      vi.useRealTimers();
    }
  });

  // A revocation that rejects (it should not) must not fail the removal either.
  it('reports failed when the revocation promise rejects', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com')];
    h.signOut.mockResolvedValue({ revocation: Promise.reject(new Error('fetch failed')) });
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'failed' });
  });

  // Multi-account: the grant another mailbox still uses is not touched, and that is said.
  it('reports skipped when another remaining account still uses the grant', async () => {
    h.registry = [oauth('a1', 'gmail', 'me@gmail.com'), oauth('a2', 'gmail', 'me@gmail.com')];
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'skipped' });
    expect(h.signOut).not.toHaveBeenCalled();
  });

  // The token store treats addresses case-insensitively, so these are ONE grant.
  // Breaks: removing one row revokes the session the surviving row runs on.
  it('keeps the grant when a remaining row differs from the removed one only in case', async () => {
    h.registry = [oauth('a1', 'sarv', 'Me@sarv.com'), oauth('a2', 'sarv', 'me@sarv.com')];
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'skipped' });
    expect(h.signOut).not.toHaveBeenCalled();
  });

  // Multi-account. Breaks: removing one Sarv account signs another out.
  it('signs out only the removed Sarv account when another Sarv account remains', async () => {
    h.registry = [oauth('a1', 'sarv', 'one@sarv.com'), oauth('a2', 'sarv', 'two@sarv.com')];
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'revoked' });
    expect(h.signOut).toHaveBeenCalledExactlyOnceWith('sarv', 'one@sarv.com');
  });

  // Sarv can revoke now. What the user is told follows what Sarv answered.
  // Breaks: a failure reads as done, or a token already gone reads as a failure.
  it.each([
    ['revoked', 'revoked'],
    ['already-invalid', 'revoked'],
    ['failed', 'failed'],
    ['no-account', 'failed'],
  ])('Sarv: a sign-out that ends %s is reported as %s, and the account is still removed', async (outcome, reported) => {
    h.registry = [oauth('a1', 'sarv', 'me@sarv.com')];
    h.signOut.mockResolvedValue({ revocation: Promise.resolve(outcome) });
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: reported });
    expect(h.calls).toEqual(['wipe:a1', 'registry-remove:a1', 'signout:sarv:me@sarv.com', 'ai-revalidate']);
  });

  // Idempotent re-run: the same removal twice. Breaks: the second run revokes or
  // reports something, which would show a notice about a removal that went fine.
  it('removing the same Sarv account twice signs out once', async () => {
    h.registry = [oauth('a1', 'sarv', 'me@sarv.com')];
    await expect(remove('a1')).resolves.toEqual({ success: true, revocation: 'revoked' });
    await expect(remove('a1')).resolves.toEqual({ success: true });
    expect(h.signOut).toHaveBeenCalledOnce();
  });

  // Password accounts have no grant: no outcome at all, so no notice.
  // Breaks: waiting for the revocation and the content clear one after the other
  // doubles the worst-case removal from 10 s to 20 s, and a slow provider would
  // hold the clear back even though nothing makes it depend on the answer.
  it('clears content while the revocation is still pending, then reports its outcome', async () => {
    h.registry = [oauth('a1', 'sarv', 'me@sarv.com')];
    let answer!: (outcome: string) => void;
    h.signOut.mockResolvedValue({ revocation: new Promise((resolve) => { answer = resolve; }) });
    const removal = remove('a1');
    await vi.waitFor(() => expect(h.session.clearStorageData).toHaveBeenCalledTimes(1));
    answer('revoked');
    await expect(removal).resolves.toEqual({ success: true, revocation: 'revoked' });
  });

  it('reports no revocation for a password account', async () => {
    h.registry = [{ id: 'p1', imapConfig: { authMethod: 'password', username: 'x@y.com' } }];
    await expect(remove('p1')).resolves.toEqual({ success: true });
    expect(await remove('gone')).not.toHaveProperty('revocation');
  });
});
