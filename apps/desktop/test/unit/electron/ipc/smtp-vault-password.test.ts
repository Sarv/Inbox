import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: SMTP sending for a saved password account
// stops working now that the renderer no longer reads passwords back (main must
// inject them); or main injects a saved password for a renderer-chosen SMTP
// host, handing the user's real password to that server.
//
// The vault and binding logic are REAL (over the fake core DB); only the SMTP
// client, the account registry and the module's other edges are faked.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  connect: vi.fn(async (_cfg: Record<string, unknown>) => {}),
  smtpClient: null as unknown,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: {},
  app: { getPath: () => '/tmp/sarvinbox-smtp-vault-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => /^enc\((.*)\)$/s.exec(b.toString('utf8'))![1],
  },
}));
vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  SMTPClient: class {
    connect = h.connect;
    isConnected = () => false;
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => [] }));
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
}));
vi.mock('../../../../electron/services/oauth-service', () => ({ getValidAccessToken: vi.fn(async () => 'tok') }));
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

import { registerSmtpHandlers } from '../../../../electron/ipc/smtp-handlers';
import { resetFakeCoreDb } from '../../../../electron/services/__testing__/fake-core-db';
import { setAccountSecrets } from '../../../../electron/services/secure-credential-store';

const SAVED = { host: 'smtp.x.com', port: 465, secure: true, username: 'a@x.com', authMethod: 'password' };

beforeEach(async () => {
  resetFakeCoreDb();
  h.handlers.clear();
  h.connect.mockReset().mockResolvedValue(undefined);
  h.smtpClient = { connect: h.connect, isConnected: () => false };
  registerSmtpHandlers();
  await setAccountSecrets('acct-a', { smtp: { password: 'smtp-pw', host: 'smtp.x.com' } });
});

describe('smtp:connect', () => {
  // Breaks: a saved account can't send after restart (stripped config, no injection).
  it('injects the saved password for its own host', async () => {
    const res = await h.handlers.get('smtp:connect')!({}, SAVED, 'acct-a');
    expect(res).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.x.com', password: 'smtp-pw' }));
  });

  // THE leak. Breaks: main logs in to a renderer-chosen server with the real password.
  it('refuses to inject it for another host, with a re-enter message, and never dials', async () => {
    const res = await h.handlers.get('smtp:connect')!({}, { ...SAVED, host: 'smtp.evil.example' }, 'acct-a');
    expect(res.success).toBe(false);
    expect(res.error).toBe('Your saved sending password is for smtp.x.com. Re-enter your password to connect to smtp.evil.example.');
    expect(h.connect).not.toHaveBeenCalled();
  });

  // Breaks: a password the user just typed is replaced by the vaulted one.
  it('uses a password supplied with the config as-is', async () => {
    await h.handlers.get('smtp:connect')!({}, { ...SAVED, host: 'smtp.new.com', password: 'typed' }, 'acct-a');
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.new.com', password: 'typed' }));
  });

  // Breaks: a nodemailer "Missing credentials" stack instead of a clear message.
  it('fails clearly when nothing is saved', async () => {
    const res = await h.handlers.get('smtp:connect')!({}, { ...SAVED, username: 'b@x.com' }, 'acct-b');
    expect(res).toEqual({ success: false, error: 'No sending password saved for smtp.x.com — set up sending for this account.' });
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe('smtp:connectFor (multi-account send-as)', () => {
  // Breaks: sending as a non-active saved account stops working.
  it('injects the saved password for that account\'s own host', async () => {
    const res = await h.handlers.get('smtp:connectFor')!({}, 'acct-a', SAVED);
    expect(res).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'smtp-pw' }));
  });

  // Breaks: send-as becomes the unguarded route to the password.
  it('refuses another host and never dials', async () => {
    const res = await h.handlers.get('smtp:connectFor')!({}, 'acct-a', { ...SAVED, host: 'smtp.evil.example' });
    expect(res.success).toBe(false);
    expect(h.connect).not.toHaveBeenCalled();
  });
});
