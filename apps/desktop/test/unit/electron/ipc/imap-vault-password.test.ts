import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: a saved password account can't connect now
// that the renderer no longer rehydrates passwords (main must inject them); or
// main injects the saved IMAP password for a renderer-chosen host — the user's
// real password logged in to someone else's server; or a host mismatch is
// reported as retryable and the reconnect loop hammers it forever.
//
// The vault and binding logic are REAL (over the fake core DB). The harness
// for the rest of sync-handlers follows reset-and-reconnect.test.ts.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  vaultLocked: false,
  engine: {
    isConnected: vi.fn(() => false),
    connect: vi.fn(async (_cfg: Record<string, unknown>) => {}),
    // Connected with a config = connect() was dialled with that very object.
    isConnectedWith: vi.fn((_cfg: unknown) => false),
    isRealTimeActive: vi.fn(() => false),
    initializePool: vi.fn(async () => { throw new Error('stop here'); }),
    isConnecting: vi.fn(() => false),
    isForceReconnecting: vi.fn(() => false),
    forceReconnect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  app: { getPath: () => '/tmp/sarvinbox-imap-vault-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => {
      if (h.vaultLocked) throw new Error('keychain locked');
      return /^enc\((.*)\)$/s.exec(b.toString('utf8'))![1];
    },
  },
}));
vi.mock('@sarvinbox/core', async () => ({
  // The real transport rules (pure): which relaxations a config asks for and may have.
  ...(await import('@sarvinbox/core/connection-security')),
  withTimeout: (p: Promise<unknown>) => p,
  accountIdFor: (user: string, host?: string) => (host ? `acct-${user}--${host}` : `acct-${user}`),
  ImapFlowClient: class {},
  isAuthError: () => false,
  isQuotaError: () => false,
  isStartTlsUnavailableError: (e: { code?: string } | undefined) => e?.code === 'STARTTLS_UNAVAILABLE',
  STARTTLS_UNAVAILABLE: 'STARTTLS_UNAVAILABLE',
  isTerminalOAuthError: () => false,
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LogAggregator: class { note() { /* no-op */ } },
  planFolderDrift: () => ({}),
  applyFolderDrift: async () => ({}),
}));
vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => [] }));
vi.mock('../../../../electron/services/quota-backoff', () => ({
  createQuotaBackoff: () => ({ remainingMs: () => 0, park: vi.fn(), clear: vi.fn(), parkOnError: () => ({ reason: null }) }),
}));
vi.mock('../../../../electron/shared', () => ({
  getStorage: () => null,
  requireStorage: () => ({}),
  getStorageFor: () => null,
  getSyncEngine: () => h.engine,
  getSyncEngineFor: () => h.engine,
  requireSyncEngine: () => h.engine,
  getMainWindow: () => null,
  sendToWindow: vi.fn(),
  getCurrentAccountId: () => 'acct-active',
  setCurrentAccount: vi.fn(),
  getIsQuitting: () => false,
  getSystemSuspended: () => false,
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  ensureAccountRuntime: vi.fn(async () => ({ storage: { getFolders: async () => [] }, syncEngine: h.engine })),
  accountInboxUnread: vi.fn(() => 0),
  accountDbExists: () => false,
}));
vi.mock('../../../../electron/services/oauth-service', () => ({
  getValidAccessToken: vi.fn(),
  attachImapBearer: (c: unknown) => c,
}));
vi.mock('../../../../electron/services/body-prefetch-scheduler', () => ({ kickBodyPrefetchScheduler: vi.fn() }));
vi.mock('../../../../electron/services/backfill-scheduler', () => ({ kickBackfillScheduler: vi.fn() }));
vi.mock('../../../../electron/services/connection-health', () => ({ markConnectionUnstable: vi.fn() }));
vi.mock('../../../../electron/services/imap-account-store', () => ({
  saveImapAccount: vi.fn(), loadImapAccount: vi.fn(), clearImapAccount: vi.fn(),
}));
vi.mock('../../../../electron/sentry', () => ({ identifyClient: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getPipelineUserEmail: () => null,
  setPipelineUserProfile: vi.fn(),
  provisionCategoryLabelsOnConnect: vi.fn(),
  retryPipelineInitOnConnect: vi.fn(),
}));

import { registerSyncHandlers } from '../../../../electron/ipc/sync-handlers';
import { resetFakeCoreDb, state as dbState } from '../../../../electron/services/__testing__/fake-core-db';
import { getAccountSecrets, setAccountSecrets } from '../../../../electron/services/secure-credential-store';
import { captureRegistryForLegacyBinding } from '../../../../electron/services/vault-credentials';

const SAVED = { host: 'imap.x.com', port: 993, secure: true, username: 'a@x.com', authMethod: 'password' };

beforeEach(async () => {
  resetFakeCoreDb();
  h.vaultLocked = false;
  h.handlers.clear();
  h.engine.connect.mockReset().mockResolvedValue(undefined);
  h.engine.isConnectedWith.mockReset().mockImplementation((cfg) => h.engine.connect.mock.calls.some(([c]) => c === cfg));
  h.engine.isConnected.mockReset().mockReturnValue(false);
  registerSyncHandlers();
  await setAccountSecrets('acct-a', { imap: { password: 'imap-pw', host: 'imap.x.com' } });
});

describe('imap:connect', () => {
  // Breaks: a saved account can't reconnect after restart.
  it('injects the saved password for its own host', async () => {
    await h.handlers.get('imap:connect')!({}, SAVED, 'acct-a');
    expect(h.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'imap.x.com', password: 'imap-pw' }));
  });

  // THE leak, and the reconnect storm it would cause if called retryable.
  it('refuses another host with a non-retryable re-enter message, and never dials', async () => {
    const res = await h.handlers.get('imap:connect')!({}, { ...SAVED, host: 'imap.evil.example' }, 'acct-a');
    expect(res).toEqual({
      success: false,
      error: 'Your saved mailbox password is for imap.x.com. Re-enter your password to connect to imap.evil.example.',
      retryable: false,
    });
    expect(h.engine.connect).not.toHaveBeenCalled();
  });

  // Breaks: changing the server in Settings and typing the new password fails.
  it('uses a password supplied with the config as-is, for any host', async () => {
    await h.handlers.get('imap:connect')!({}, { ...SAVED, host: 'imap.new.com', password: 'typed' }, 'acct-a');
    expect(h.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'imap.new.com', password: 'typed' }));
  });

  // Cold start: the keychain isn't readable yet, so the vault read THROWS.
  // Breaks: the wait never settles (unhandled rejection) and the connect hangs.
  it('keeps waiting through a locked vault and connects once it unlocks', async () => {
    h.vaultLocked = true;
    setTimeout(() => { h.vaultLocked = false; }, 300);
    await h.handlers.get('imap:connect')!({}, SAVED, 'acct-a');
    expect(h.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'imap-pw' }));
  });
});

describe('accounts:backgroundSync (multi-account)', () => {
  // Breaks: non-active saved accounts stop syncing in the background.
  it('injects the saved password for that account\'s own host', async () => {
    await h.handlers.get('accounts:backgroundSync')!({}, { accountId: 'acct-a', config: SAVED });
    expect(h.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'imap-pw' }));
  });

  // Breaks: the background path becomes the unguarded route to the password.
  it('refuses another host, non-retryably, and never dials', async () => {
    const res = await h.handlers.get('accounts:backgroundSync')!({}, { accountId: 'acct-a', config: { ...SAVED, host: 'imap.evil.example' } });
    expect(res).toMatchObject({ success: false, retryable: false });
    expect(h.engine.connect).not.toHaveBeenCalled();
  });
});

// How the saved password is sent is the choice saved WITH it, not the
// config's (vault-credentials.ts). Breaks: a compromised window ticks "allow
// self-signed" (or picks 'none') for a saved account and main sends the real
// password to a man-in-the-middle; a self-signed account stops connecting; or
// unticking "allow self-signed" never sticks.
describe('imap:connect — the transport saved with the password', () => {
  const dialled = () => h.engine.connect.mock.calls[0][0];

  it('refuses certificate checks off when the password was not saved that way, non-retryably, and never dials', async () => {
    const res = await h.handlers.get('imap:connect')!({}, { ...SAVED, allowInsecureTLS: true }, 'acct-a');
    expect(res).toEqual({
      success: false,
      error: "Your saved mailbox password was saved for a connection that checks imap.x.com's certificate. Re-enter your password to connect without checking it.",
      retryable: false,
    });
    expect(h.engine.connect).not.toHaveBeenCalled();
  });

  it('refuses an unencrypted connection the password was not saved for', async () => {
    const res = await h.handlers.get('imap:connect')!({}, { ...SAVED, port: 143, secure: false, security: 'none' }, 'acct-a');
    expect(res).toMatchObject({ success: false, retryable: false, error: expect.stringContaining('without encryption') });
    expect(h.engine.connect).not.toHaveBeenCalled();
  });

  it('dials with the relaxation the password was saved with', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'imap-pw', host: 'imap.x.com', allowInsecureTLS: true } });
    await h.handlers.get('imap:connect')!({}, { ...SAVED, allowInsecureTLS: true }, 'acct-a');
    expect(dialled()).toMatchObject({ password: 'imap-pw', allowInsecureTLS: true });
  });

  it('switches an unused relaxation off for good once the stricter connection works', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'imap-pw', host: 'imap.x.com', allowInsecureTLS: true } });
    await h.handlers.get('imap:connect')!({}, SAVED, 'acct-a');
    expect(dialled()).toMatchObject({ password: 'imap-pw', allowInsecureTLS: false });
    expect((await getAccountSecrets('acct-a'))?.imap?.allowInsecureTLS).toBe(false);
  });

  // connect() returns without dialling when another connect is already in
  // flight (ConnectionManager's "Already connected or connecting"). Breaks: a
  // stricter config that was never dialled drops the saved choice, and the
  // account is refused "re-enter your password" though nothing stricter worked.
  it('keeps the relaxation when the connect did not dial this config', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'imap-pw', host: 'imap.x.com', allowInsecureTLS: true } });
    h.engine.isConnectedWith.mockReturnValue(false);
    await h.handlers.get('imap:connect')!({}, SAVED, 'acct-a');
    expect(h.engine.connect).toHaveBeenCalled();
    expect((await getAccountSecrets('acct-a'))?.imap?.allowInsecureTLS).toBe(true);

    await h.handlers.get('accounts:backgroundSync')!({}, { accountId: 'acct-a', config: SAVED });
    expect((await getAccountSecrets('acct-a'))?.imap?.allowInsecureTLS).toBe(true);
  });

  // Breaks: one connect from a config that forgot the opt-in costs a
  // self-signed account its saved choice.
  it('keeps the relaxation when the stricter connection fails', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'imap-pw', host: 'imap.x.com', allowInsecureTLS: true } });
    h.engine.connect.mockRejectedValue(new Error('self-signed certificate in certificate chain'));
    await h.handlers.get('imap:connect')!({}, SAVED, 'acct-a');
    expect((await getAccountSecrets('acct-a'))?.imap?.allowInsecureTLS).toBe(true);
  });

  // A password saved by an older build records no transport. With no record
  // of the account in the registry main captured at startup, it is bound
  // strict — never to what a connect asks for. Breaks: the first connect for
  // such a password (possibly a compromised window's, for an account the app
  // had not used yet) decides how it is sent.
  it('binds a legacy entry with no registry record strict, refusing a looser connect', async () => {
    captureRegistryForLegacyBinding();
    dbState.blobs.set('secure-credentials', Buffer.from(`PLAIN1:${JSON.stringify({ 'acct-a': { imap: { password: 'imap-pw', host: 'imap.x.com' } } })}`));
    const res = await h.handlers.get('imap:connect')!({}, { ...SAVED, allowInsecureTLS: true }, 'acct-a');
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('Re-enter your password') });
    expect(h.engine.connect).not.toHaveBeenCalled();
    expect((await getAccountSecrets('acct-a'))?.imap).toEqual({ password: 'imap-pw', host: 'imap.x.com', allowInsecureTLS: false, allowPlaintext: false });
  });

  // Typing the password IS the choice; the window already holds that secret.
  it('dials a typed password however the config asks', async () => {
    await h.handlers.get('imap:connect')!({}, { ...SAVED, password: 'typed', allowInsecureTLS: true, security: 'none' }, 'acct-a');
    expect(dialled()).toMatchObject({ password: 'typed', allowInsecureTLS: true, security: 'none' });
  });
});

describe('accounts:backgroundSync — the transport saved with the password', () => {
  // Breaks: the background path becomes the unguarded route to a loosened connection.
  it('refuses a relaxation the password was not saved with, non-retryably, and never dials', async () => {
    const res = await h.handlers.get('accounts:backgroundSync')!({}, { accountId: 'acct-a', config: { ...SAVED, allowInsecureTLS: true } });
    expect(res).toMatchObject({ success: false, retryable: false, error: expect.stringContaining('Re-enter your password') });
    expect(h.engine.connect).not.toHaveBeenCalled();
  });

  it('switches an unused relaxation off once the connection works', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'imap-pw', host: 'imap.x.com', allowPlaintext: true } });
    await h.handlers.get('accounts:backgroundSync')!({}, { accountId: 'acct-a', config: SAVED });
    expect(h.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'imap-pw' }));
    expect((await getAccountSecrets('acct-a'))?.imap?.allowPlaintext).toBe(false);
  });
});

describe('imap:getSavedConfig', () => {
  // The last-good IMAP config is stored WITH its password. Breaks: the renderer
  // regains a path to the plaintext mailbox password (CASA H-1).
  it('returns the saved config without any secret', async () => {
    const { loadImapAccount } = await import('../../../../electron/services/imap-account-store');
    vi.mocked(loadImapAccount).mockResolvedValueOnce({ ...SAVED, password: 'imap-pw', accessToken: 'a', refreshToken: 'r' } as never);
    const res = await h.handlers.get('imap:getSavedConfig')!({});
    expect(res).toEqual({ success: true, data: SAVED });
  });

  it('passes "nothing saved" through', async () => {
    const { loadImapAccount } = await import('../../../../electron/services/imap-account-store');
    vi.mocked(loadImapAccount).mockResolvedValueOnce(null as never);
    expect(await h.handlers.get('imap:getSavedConfig')!({})).toEqual({ success: true, data: null });
  });
});
