import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `imap:resetAndReconnect` — the handler the renderer fires on window focus,
 * tab-visible and network-online.
 *
 * The regression it exists for: this handler decides whether to tear the IMAP
 * connection down, and it decides it from a NOOP liveness probe. A connect that
 * is still shaking hands cannot answer a NOOP, so the probe called it dead and
 * `forceReconnect()` destroyed the connection that was about to succeed. On a
 * cold start that is guaranteed — the renderer's mount connect is ~1.5s into its
 * dial when the focus handler runs — and the user saw a failed auto-connect,
 * an error with a stack in the log, and a wasted socket against the server's
 * simultaneous-connection cap.
 *
 * We capture the handler at registration and drive it directly, mocking only
 * the module's own edges.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  engine: {
    isConnecting: vi.fn(() => false),
    waitUntilConnected: vi.fn(async () => true),
    verifyConnection: vi.fn(async () => true),
    forceReconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    resetReconnectAttempts: vi.fn(),
    isInQuotaCooldown: vi.fn(() => false),
    isInAuthCooldown: vi.fn(() => false),
    syncAll: vi.fn(async () => ({})),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  quotaRemainingMs: 0,
  quitting: false,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
}));
vi.mock('@sarvinbox/core', () => ({
  withTimeout: (p: Promise<unknown>) => p,
  resolveTlsOptions: () => ({}),
  accountIdFor: (user: string, host: string) => `acct-${user}-${host}`,
  ImapFlowClient: class {},
  isAuthError: () => false,
  isQuotaError: () => false,
  isTerminalOAuthError: () => false,
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LogAggregator: class { note() { /* no-op */ } },
  planFolderDrift: () => ({}),
  applyFolderDrift: async () => ({}),
}));
vi.mock('../../../../electron/services/quota-backoff', () => ({
  createQuotaBackoff: () => ({
    remainingMs: () => h.quotaRemainingMs,
    park: vi.fn(),
    clear: vi.fn(),
  }),
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
  getCurrentAccountId: () => 'acct-1',
  setCurrentAccount: vi.fn(),
  getIsQuitting: () => h.quitting,
  getSystemSuspended: () => false,
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  ensureAccountRuntime: vi.fn(),
  accountInboxUnread: vi.fn(),
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
vi.mock('../../../../electron/services/secure-credential-store', () => ({ getAccountSecrets: vi.fn() }));
vi.mock('../../../../electron/sentry', () => ({ identifyClient: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getPipelineUserEmail: () => null,
  setPipelineUserProfile: vi.fn(),
  provisionCategoryLabelsOnConnect: vi.fn(),
  retryPipelineInitOnConnect: vi.fn(),
}));

import { registerSyncHandlers } from '../../../../electron/ipc/sync-handlers';

const resetAndReconnect = () => h.handlers.get('imap:resetAndReconnect')!;

beforeEach(() => {
  h.handlers.clear();
  h.quotaRemainingMs = 0;
  h.quitting = false;
  for (const fn of Object.values(h.engine)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  h.engine.isConnecting.mockReturnValue(false);
  h.engine.waitUntilConnected.mockResolvedValue(true);
  h.engine.verifyConnection.mockResolvedValue(true);
  h.engine.isConnected.mockReturnValue(true);
  h.engine.isInQuotaCooldown.mockReturnValue(false);
  h.engine.isInAuthCooldown.mockReturnValue(false);
  h.engine.syncAll.mockResolvedValue({});
  registerSyncHandlers();
});

describe('imap:resetAndReconnect — a connect in flight is left alone', () => {
  // THE regression. If this fails, a cold start tears down its own mount
  // connect: "Unexpected close", a failed connect reported to the UI, and a
  // second socket opened against the server's cap for no reason.
  it('waits for an in-flight connect instead of probing or tearing it down', async () => {
    h.engine.isConnecting.mockReturnValue(true);
    h.engine.waitUntilConnected.mockResolvedValue(true);

    const res = await resetAndReconnect()({});

    expect(res).toEqual({ success: true, data: { connected: true } });
    expect(h.engine.waitUntilConnected).toHaveBeenCalledTimes(1);
    expect(h.engine.verifyConnection).not.toHaveBeenCalled();
    expect(h.engine.forceReconnect).not.toHaveBeenCalled();
    expect(h.engine.syncAll).not.toHaveBeenCalled();
  });

  // The pending connect can also FAIL. The handler must report that truthfully
  // rather than pretending it connected — the renderer's own recovery reads it.
  it('reports not-connected when the in-flight connect fails, still without a teardown', async () => {
    h.engine.isConnecting.mockReturnValue(true);
    h.engine.waitUntilConnected.mockResolvedValue(false);

    const res = await resetAndReconnect()({});

    expect(res).toEqual({ success: true, data: { connected: false } });
    expect(h.engine.forceReconnect).not.toHaveBeenCalled();
  });

  // The counter reset must still happen: the caller believes the network is
  // back, and piled-up failures must not block the connect that is landing.
  it('still clears the reconnect back-off counter before deferring', async () => {
    h.engine.isConnecting.mockReturnValue(true);

    await resetAndReconnect()({});

    expect(h.engine.resetReconnectAttempts).toHaveBeenCalledTimes(1);
  });
});

describe('imap:resetAndReconnect — the paths the guard must not shadow', () => {
  // A genuinely healthy connection is still left alone (the older regression:
  // an unconditional forceReconnect on every focus caused reconnect flapping).
  it('leaves a live connection alone', async () => {
    h.engine.verifyConnection.mockResolvedValue(true);

    const res = await resetAndReconnect()({});

    expect(res).toEqual({ success: true, data: { connected: true } });
    expect(h.engine.forceReconnect).not.toHaveBeenCalled();
  });

  // A real zombie — nothing connecting, and the NOOP goes unanswered — must
  // still be torn down and resynced, or a dead socket never recovers.
  it('force-reconnects and resyncs a zombie connection', async () => {
    h.engine.isConnecting.mockReturnValue(false);
    h.engine.verifyConnection.mockResolvedValue(false);
    h.engine.isConnected.mockReturnValue(true);

    const res = await resetAndReconnect()({});

    expect(h.engine.forceReconnect).toHaveBeenCalledTimes(1);
    expect(h.engine.syncAll).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ success: true });
  });

  // forceReconnect can no-op (wake-from-sleep: config not re-hydrated yet).
  // Syncing against a connection we don't hold just fails and warns.
  it('skips the post-reconnect sync when the fresh connect did not land', async () => {
    h.engine.verifyConnection.mockResolvedValue(false);
    h.engine.isConnected.mockReturnValue(false);

    const res = await resetAndReconnect()({});

    expect(res).toEqual({ success: true, data: { connected: false } });
    expect(h.engine.syncAll).not.toHaveBeenCalled();
  });

  // The cooldown guards run BEFORE the connecting check and must keep winning:
  // poking a saturated / locked-out account is what prolongs the back-off.
  it.each([
    ['quota cooldown', 'isInQuotaCooldown'],
    ['auth cooldown', 'isInAuthCooldown'],
  ] as const)('does nothing at all during an active %s', async (_label, flag) => {
    h.engine[flag].mockReturnValue(true);
    h.engine.isConnecting.mockReturnValue(true);

    await resetAndReconnect()({});

    expect(h.engine.resetReconnectAttempts).not.toHaveBeenCalled();
    expect(h.engine.waitUntilConnected).not.toHaveBeenCalled();
    expect(h.engine.forceReconnect).not.toHaveBeenCalled();
  });

  it('does nothing while the shared connection-cap back-off is parked', async () => {
    h.quotaRemainingMs = 60_000;
    h.engine.isConnecting.mockReturnValue(true);

    await resetAndReconnect()({});

    expect(h.engine.waitUntilConnected).not.toHaveBeenCalled();
    expect(h.engine.forceReconnect).not.toHaveBeenCalled();
  });
});
