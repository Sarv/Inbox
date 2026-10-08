import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: an SMTP path mints the user's OAuth token for
// a renderer-supplied host again — `smtp:connect` / `smtp:connectFor` take the
// whole SMTPConfig (host included) from the renderer, which also renders
// untrusted email HTML. A foreign host must be refused at the handler, before
// any token is read, while the provider's own server keeps working.
//
// The guard and token path are the REAL oauth-service; only the token store,
// the SMTP client and the module's other edges are faked.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  getAccount: vi.fn(),
  connect: vi.fn(async (_cfg: Record<string, unknown>) => {}),
  smtpClient: null as unknown,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: {},
  shell: { openExternal: async () => {} },
  app: { getPath: () => '/tmp', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));
vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  SMTPClient: class {
    connect = h.connect;
    isConnected = () => false;
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../electron/shared', () => ({
  getStorage: vi.fn(() => null),
  getStorageFor: vi.fn(),
  getSyncEngine: vi.fn(() => null),
  getSyncEngineFor: vi.fn(),
  getSmtpClient: () => h.smtpClient,
  getSmtpClientFor: vi.fn(() => null),
  setSmtpClient: vi.fn(),
  setSmtpClientFor: vi.fn(),
  getMainWindow: vi.fn(),
  getCurrentAccountId: vi.fn(() => 'acct-1'),
  getSystemSuspended: () => false,
}));
vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: h.getAccount,
  saveAccount: async () => {},
  removeAccount: async () => false,
  listAccounts: async () => [],
}));
vi.mock('../../../../electron/services/network-readiness', () => ({ waitForNetworkReady: async () => true }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({ getPipelineUserName: vi.fn(() => 'Me') }));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: vi.fn(),
  drainOutbox: vi.fn(async () => {}),
  getOutboxQueueForAccount: vi.fn(),
  drainOutboxForAccount: vi.fn(async () => {}),
  notifyOutboxChanged: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn(async () => {}) }));
vi.mock('../../../../electron/services/pgp-service', () => ({ sendTransformFor: vi.fn() }));
vi.mock('../../../../electron/ipc/follow-up-handlers', () => ({ recordFollowUpForSend: vi.fn() }));

import { registerSmtpHandlers, sendEmailFromMain } from '../../../../electron/ipc/smtp-handlers';

const NOW_SEC = Math.floor(Date.now() / 1000);
const GMAIL = { host: 'smtp.gmail.com', port: 465, secure: true, username: 'me@gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' };
const EVIL = { ...GMAIL, host: 'smtp.evil.example' };

beforeEach(() => {
  h.handlers.clear();
  h.connect.mockReset().mockResolvedValue(undefined);
  h.getAccount.mockReset().mockImplementation(async (provider: string, email: string) => ({
    provider, email, accessToken: 'gmail-token', refreshToken: 'rt',
    accessExpiresAt: NOW_SEC + 3_600, scopes: [], updatedAt: NOW_SEC - 60,
  }));
  h.smtpClient = { connect: h.connect, isConnected: () => false };
  registerSmtpHandlers();
});

describe('smtp:connect', () => {
  // Breaks: Gmail sending stops working.
  it('connects with the token for the provider\'s own SMTP host', async () => {
    const res = await h.handlers.get('smtp:connect')!({}, GMAIL);
    expect(res).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.gmail.com', accessToken: 'gmail-token' }));
  });

  // THE leak. Breaks: a renderer-chosen SMTP server receives the Gmail token.
  it('refuses a foreign host without reading the token store or dialling', async () => {
    const res = await h.handlers.get('smtp:connect')!({}, EVIL);
    expect(res.success).toBe(false);
    expect(res.error).toContain('smtp.evil.example');
    expect(h.getAccount).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe('smtp:connectFor (multi-account send-as)', () => {
  // Breaks: the second account's sending stops working.
  it('connects another account with the token for its provider\'s host', async () => {
    const res = await h.handlers.get('smtp:connectFor')!({}, 'acct-2', GMAIL);
    expect(res).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'gmail-token' }));
  });

  // Breaks: the send-as path becomes the unguarded way round smtp:connect.
  it('refuses a foreign host without reading the token store or dialling', async () => {
    const res = await h.handlers.get('smtp:connectFor')!({}, 'acct-2', EVIL);
    expect(res.success).toBe(false);
    expect(h.getAccount).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe('send retry after an expired token', () => {
  // The retry re-mints from the client's stored config. Breaks: a config that
  // somehow reached the client with a foreign host gets a FORCE-refreshed token
  // presented to it on the retry.
  it('refuses to force-refresh a token for a foreign host and does not reconnect', async () => {
    const sendEmail = vi.fn(async () => ({ success: false, error: 'Invalid credentials: token expired' }));
    h.smtpClient = { isConnected: () => true, getConfig: () => EVIL, connect: h.connect, sendEmail };
    await sendEmailFromMain({ to: ['bob@example.org'], subject: 'hi', body: 'b' } as never);
    expect(h.getAccount).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
