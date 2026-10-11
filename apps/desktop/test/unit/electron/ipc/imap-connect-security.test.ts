import { beforeEach, describe, expect, it, vi } from 'vitest';

// CASA M-5 in main's imap:connect. What breaks if this file fails:
// - the last-good config is saved without the account's connection security,
//   so a recovered "None" account (or a self-signed one) dials as
//   STARTTLS-required and fails after a restart;
// - a STARTTLS refusal is retried as a blip, or — worse — handled like a
//   rejected password, which forgets the saved account;
// - an account that is already connected reconnects with its OLD settings
//   after the user saved new ones (e.g. stays unencrypted after switching to
//   STARTTLS);
// - a mid-session refusal never reaches the window, so the user is not told.
// The harness follows imap-vault-password.test.ts, with an engine fake that
// lets the handler run to the end.

const h = vi.hoisted(() => {
  const listeners = new Map<string, (...a: any[]) => void>();
  const on = (name: string) => vi.fn((cb: (...a: any[]) => void) => { listeners.set(name, cb); });
  return {
    handlers: new Map<string, (...a: any[]) => any>(),
    listeners,
    sent: [] as Array<[string, unknown]>,
    saveImapAccount: vi.fn(async () => {}),
    clearImapAccount: vi.fn(async () => {}),
    engine: {
      isConnected: vi.fn(() => false),
      connect: vi.fn(async (_cfg: Record<string, unknown>) => {}),
      isRealTimeActive: vi.fn(() => false),
      initializePool: vi.fn(async () => {}),
      isConnecting: vi.fn(() => false),
      isForceReconnecting: vi.fn(() => false),
      forceReconnect: vi.fn(async (_cfg?: Record<string, unknown>) => {}),
      disconnect: vi.fn(async () => {}),
      processPendingOps: vi.fn(async () => {}),
      onDisconnect: on('disconnect'),
      onReconnect: on('reconnect'),
      onReconnecting: on('reconnecting'),
      onReconnectFailed: on('reconnect-failed'),
      onAuthError: on('auth-error'),
      onSecurityError: on('security-error'),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  app: { getPath: () => '/tmp/sarvinbox-imap-security-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));
vi.mock('@sarvinbox/core', () => ({
  withTimeout: (p: Promise<unknown>) => p,
  resolveTlsOptions: () => ({}),
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
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel: string, payload?: unknown) => h.sent.push([channel, payload]) } }),
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
vi.mock('../../../../electron/services/oauth-service', () => ({ getValidAccessToken: vi.fn(), attachImapBearer: (c: unknown) => c }));
vi.mock('../../../../electron/services/body-prefetch-scheduler', () => ({ kickBodyPrefetchScheduler: vi.fn() }));
vi.mock('../../../../electron/services/backfill-scheduler', () => ({ kickBackfillScheduler: vi.fn() }));
vi.mock('../../../../electron/services/connection-health', () => ({ markConnectionUnstable: vi.fn() }));
vi.mock('../../../../electron/services/imap-account-store', () => ({
  saveImapAccount: h.saveImapAccount, loadImapAccount: vi.fn(), clearImapAccount: h.clearImapAccount,
}));
vi.mock('../../../../electron/sentry', () => ({ identifyClient: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getPipelineUserEmail: () => 'me@x.com',
  setPipelineUserProfile: vi.fn(),
  provisionCategoryLabelsOnConnect: vi.fn(),
  retryPipelineInitOnConnect: vi.fn(),
}));

import { registerSyncHandlers } from '../../../../electron/ipc/sync-handlers';

const NONE_ACCOUNT = {
  host: 'mail.example.org', port: 143, secure: false, security: 'none', allowInsecureTLS: true,
  username: 'me@x.com', password: 'pw', authMethod: 'password',
};
const connect = (config: Record<string, unknown>) => h.handlers.get('imap:connect')!({}, config, 'acct-a');

beforeEach(() => {
  h.handlers.clear();
  // Not h.listeners: sync-handlers bridges each engine's events ONCE per
  // process (disconnectBridged), so they stay registered across tests.
  h.sent.length = 0;
  h.saveImapAccount.mockClear();
  h.clearImapAccount.mockClear();
  h.engine.connect.mockReset().mockResolvedValue(undefined);
  h.engine.forceReconnect.mockReset().mockResolvedValue(undefined);
  h.engine.isConnected.mockReset().mockReturnValue(false);
  h.engine.isForceReconnecting.mockReset().mockReturnValue(false);
  registerSyncHandlers();
});

describe('imap:connect — connection security (CASA M-5)', () => {
  it('saves the account\'s connection security and self-signed choice with the last-good config', async () => {
    expect(await connect(NONE_ACCOUNT)).toMatchObject({ success: true });
    expect(h.saveImapAccount).toHaveBeenCalledWith(expect.objectContaining({ security: 'none', allowInsecureTLS: true }));
  });

  it('reports a STARTTLS refusal with its code, not retryable, and keeps the saved account', async () => {
    const refusal = Object.assign(new Error('The incoming mail server mail.example.org did not agree to encrypt this session (STARTTLS)'), { code: 'STARTTLS_UNAVAILABLE' });
    h.engine.connect.mockRejectedValue(refusal);
    expect(await connect({ ...NONE_ACCOUNT, security: 'starttls' })).toEqual({
      success: false, error: refusal.message, retryable: false, code: 'STARTTLS_UNAVAILABLE',
    });
    expect(h.clearImapAccount).not.toHaveBeenCalled();
    expect(h.saveImapAccount).not.toHaveBeenCalled();
  });

  it('reconnects an already-connected account with the settings it was just given', async () => {
    h.engine.isConnected.mockReturnValue(true);
    await connect({ ...NONE_ACCOUNT, security: 'starttls' });
    expect(h.engine.forceReconnect).toHaveBeenCalledWith(expect.objectContaining({ security: 'starttls' }));
  });

  // Breaks: saving new settings while a focus/online reset is mid-reconnect
  // (not connected, not idle) reaches a plain connect() that meets the run's
  // 'connecting' state and returns without dialling them — success reported,
  // the old (e.g. unencrypted) settings live on.
  it('hands new settings to a reconnect that is already running instead of a plain connect', async () => {
    h.engine.isForceReconnecting.mockReturnValue(true);
    h.engine.forceReconnect.mockImplementation(async () => { h.engine.isConnected.mockReturnValue(true); });
    await connect({ ...NONE_ACCOUNT, security: 'starttls' });
    expect(h.engine.forceReconnect).toHaveBeenCalledWith(expect.objectContaining({ security: 'starttls' }));
    expect(h.engine.connect).not.toHaveBeenCalled();
  });

  it('tells the window when the server stops encrypting mid-session, without forgetting the account', async () => {
    await connect(NONE_ACCOUNT);
    h.listeners.get('security-error')!(new Error('The incoming mail server … did not agree to encrypt'));
    expect(h.sent).toContainEqual(['imap:security-error', 'The incoming mail server … did not agree to encrypt']);
    expect(h.clearImapAccount).not.toHaveBeenCalled();
  });
});
