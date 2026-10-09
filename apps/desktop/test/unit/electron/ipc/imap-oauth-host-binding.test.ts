import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: an IMAP connect path mints the user's OAuth
// token without naming the host it is about to be sent to, so the host guard in
// oauth-service (getAccessTokenForMailHost, tested in
// oauth-token-destinations.test.ts) is bypassed and a renderer-supplied IMAP
// server receives the Gmail token. Each of the three IMAP entry points that
// accept a config from the renderer is driven here, and each must ask for an
// 'imap' token for EXACTLY the config's host.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  getToken: vi.fn(),
  getAccountSecrets: vi.fn(),
  probeConnect: vi.fn(async () => {}),
  engine: {
    isConnected: vi.fn(() => false),
    connect: vi.fn(async () => {}),
    isRealTimeActive: vi.fn(() => false),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
}));
vi.mock('@sarvinbox/core', () => ({
  withTimeout: (p: Promise<unknown>) => p,
  resolveTlsOptions: () => ({}),
  accountIdFor: (user: string, host?: string) => `acct-${user}-${host ?? ''}`,
  ImapFlowClient: class {
    setShuttingDown() { /* no-op */ }
    on() { /* no-op */ }
    connect = h.probeConnect;
    logout = async () => {};
    disconnect = async () => {};
  },
  isAuthError: (e: Error) => /auth/i.test(e?.message ?? ''),
  isQuotaError: () => false,
  isTerminalOAuthError: () => true,
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LogAggregator: class { note() { /* no-op */ } },
  planFolderDrift: () => ({}),
  applyFolderDrift: async () => ({}),
}));
vi.mock('../../../../electron/services/quota-backoff', () => ({
  createQuotaBackoff: () => ({ remainingMs: () => 0, park: vi.fn(), clear: vi.fn(), parkOnError: () => ({ reason: 'other' }) }),
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
  getAccessTokenForMailHost: h.getToken,
  attachImapBearer: (c: unknown) => c,
}));
vi.mock('../../../../electron/services/body-prefetch-scheduler', () => ({ kickBodyPrefetchScheduler: vi.fn() }));
vi.mock('../../../../electron/services/backfill-scheduler', () => ({ kickBackfillScheduler: vi.fn() }));
vi.mock('../../../../electron/services/connection-health', () => ({ markConnectionUnstable: vi.fn() }));
vi.mock('../../../../electron/services/imap-account-store', () => ({
  saveImapAccount: vi.fn(), loadImapAccount: vi.fn(), clearImapAccount: vi.fn(),
}));
vi.mock('../../../../electron/services/secure-credential-store', () => ({ getAccountSecrets: h.getAccountSecrets }));
vi.mock('../../../../electron/sentry', () => ({ identifyClient: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getPipelineUserEmail: () => null,
  setPipelineUserProfile: vi.fn(),
  provisionCategoryLabelsOnConnect: vi.fn(),
  retryPipelineInitOnConnect: vi.fn(),
}));

import { registerSyncHandlers } from '../../../../electron/ipc/sync-handlers';

const refused = () => Object.assign(new Error('A gmail sign-in can only be used with gmail\'s own mail servers'), {
  code: 'TOKEN_DESTINATION_REFUSED',
});
const GMAIL = { host: 'imap.gmail.com', port: 993, secure: true, username: 'me@gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' };
const EVIL = { ...GMAIL, host: 'imap.evil.example' };

beforeEach(() => {
  h.handlers.clear();
  // Stand-in for the real guard: only Gmail's own server gets a token.
  h.getToken.mockReset().mockImplementation(async (_p: string, _u: string, _proto: string, host: string) => {
    if (host !== 'imap.gmail.com') throw refused();
    return 'gmail-token';
  });
  h.getAccountSecrets.mockReset().mockResolvedValue(null);
  h.probeConnect.mockReset().mockResolvedValue(undefined);
  h.engine.isConnected.mockReset().mockReturnValue(false);
  h.engine.connect.mockReset().mockResolvedValue(undefined);
  registerSyncHandlers();
});

describe('imap:probeCredentials', () => {
  // Breaks: the "can these credentials connect?" probe is the unguarded way in.
  it('asks for an IMAP token for exactly the probed host', async () => {
    const res = await h.handlers.get('imap:probeCredentials')!({}, GMAIL);
    expect(h.getToken).toHaveBeenCalledWith('gmail', 'me@gmail.com', 'imap', 'imap.gmail.com');
    expect(res).toEqual({ success: true });
  });

  // THE leak through the probe.
  it('reports the refusal and never dials a foreign host', async () => {
    const res = await h.handlers.get('imap:probeCredentials')!({}, EVIL);
    expect(h.getToken).toHaveBeenCalledWith('gmail', 'me@gmail.com', 'imap', 'imap.evil.example');
    expect(res.success).toBe(false);
    expect(h.probeConnect).not.toHaveBeenCalled();
  });
});

describe('imap:connect', () => {
  // THE leak through the primary connect. No vaulted password to fall back to,
  // so the refusal is the result and nothing is dialled.
  it('fails a foreign host without connecting', async () => {
    const res = await h.handlers.get('imap:connect')!({}, EVIL, 'acct-1');
    expect(h.getToken).toHaveBeenCalledWith('gmail', 'me@gmail.com', 'imap', 'imap.evil.example');
    expect(res.success).toBe(false);
    expect(h.engine.connect).not.toHaveBeenCalled();
  });

  // An account converted to oauth2 IN PLACE on a non-provider server keeps its
  // vaulted app password, saved for that server. Breaks: the refusal strands it
  // instead of letting the existing self-heal fall back to that password — and
  // the token is still never sent there.
  it('lets a converted account on a non-provider host self-heal to its vaulted password', async () => {
    h.getAccountSecrets.mockResolvedValue({ imap: { password: 'app-pw', host: 'mail.example.org' } });
    const res = await h.handlers.get('imap:connect')!({}, { ...GMAIL, host: 'mail.example.org' }, 'acct-1');
    expect(h.getToken).toHaveBeenCalledWith('gmail', 'me@gmail.com', 'imap', 'mail.example.org');
    // The rest of the connect (pool, sync) is outside this harness; reaching
    // the engine with the password config is the part that matters here.
    expect(String(res.error ?? '')).not.toContain('own mail servers');
    expect(h.engine.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: 'mail.example.org', authMethod: 'password', password: 'app-pw', accessToken: undefined,
    }));
  });
  // The fallback password is bound to its server too. Breaks: a refused token
  // falls back to a password saved for ANOTHER server, so a renderer-chosen
  // host receives the user's real password instead of their token.
  it('does not fall back to a vaulted password saved for another server', async () => {
    h.getAccountSecrets.mockResolvedValue({ imap: { password: 'app-pw', host: 'mail.example.org' } });
    const res = await h.handlers.get('imap:connect')!({}, EVIL, 'acct-1');
    expect(res.success).toBe(false);
    expect(h.engine.connect).not.toHaveBeenCalled();
    expect(h.probeConnect).not.toHaveBeenCalled();
  });
});

describe('accounts:backgroundSync (multi-account)', () => {
  // Breaks: a non-active account's background connect becomes the unguarded path.
  it('asks for an IMAP token for exactly that account\'s host, and refuses a foreign one', async () => {
    await h.handlers.get('accounts:backgroundSync')!({}, { accountId: 'acct-2', config: GMAIL });
    expect(h.getToken).toHaveBeenLastCalledWith('gmail', 'me@gmail.com', 'imap', 'imap.gmail.com');
    expect(h.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'gmail-token' }));

    h.engine.connect.mockClear();
    const res = await h.handlers.get('accounts:backgroundSync')!({}, { accountId: 'acct-3', config: EVIL });
    expect(h.getToken).toHaveBeenLastCalledWith('gmail', 'me@gmail.com', 'imap', 'imap.evil.example');
    expect(res.success).toBe(false);
    expect(h.engine.connect).not.toHaveBeenCalled();
  });
});
