import { resolveTlsOptions } from '@sarvinbox/core';
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
import { resetFakeCoreDb, state as dbState } from '../../../../electron/services/__testing__/fake-core-db';
import { getAccountSecrets, setAccountSecrets } from '../../../../electron/services/secure-credential-store';
import { captureRegistryForLegacyBinding } from '../../../../electron/services/vault-credentials';

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

  // CASA M-5: the sending server would not encrypt a STARTTLS account. Breaks:
  // the window cannot tell this from any other failure, so startup and lazy
  // send swallow it and mail waits in the Outbox with no reason shown.
  it('tags a refused STARTTLS so the window can explain it', async () => {
    const refusal = Object.assign(new Error('The outgoing mail server smtp.x.com did not agree to encrypt this session (STARTTLS).'), { starttlsRefused: true, code: 'ETLS' });
    h.connect.mockRejectedValueOnce(refusal);
    const res = await h.handlers.get('smtp:connect')!({}, SAVED, 'acct-a');
    expect(res).toEqual({ success: false, error: refusal.message, code: 'STARTTLS_UNAVAILABLE' });
  });

  it('does not tag other failures', async () => {
    h.connect.mockRejectedValueOnce(Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH' }));
    expect(await h.handlers.get('smtp:connect')!({}, SAVED, 'acct-a')).toEqual({ success: false, error: 'Invalid login: 535' });
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

// How the saved password is sent is the user's choice saved WITH it, not the
// config's: the config comes from the window, which also renders untrusted
// email. What breaks if these fail: a compromised window ticks "allow
// self-signed" (or picks 'none') for a saved account and main sends the real
// password to a man-in-the-middle; or a legitimately self-signed account stops
// sending; or unticking "allow self-signed" never sticks.
describe('smtp:connect — the transport saved with the password', () => {
  /** Whether the client was asked to check the certificate. */
  const verifies = () => resolveTlsOptions(h.connect.mock.calls[0][0] as never).rejectUnauthorized;

  it('refuses to send it without certificate checks it was not saved with, and never dials', async () => {
    const res = await h.handlers.get('smtp:connect')!({}, { ...SAVED, allowInsecureTLS: true }, 'acct-a');
    expect(res).toEqual({
      success: false,
      error: "Your saved sending password was saved for a connection that checks smtp.x.com's certificate. Re-enter your password to connect without checking it.",
    });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('refuses to send it unencrypted when it was not saved for that, and never dials', async () => {
    const res = await h.handlers.get('smtp:connect')!({}, { ...SAVED, port: 587, secure: false, security: 'none' }, 'acct-a');
    expect(res.error).toBe('Your saved sending password was saved for an encrypted connection to smtp.x.com. Re-enter your password to connect without encryption.');
    expect(h.connect).not.toHaveBeenCalled();
  });

  // The old override is not a way round it either.
  it('checks the certificate whatever tlsOptions the config carries', async () => {
    await h.handlers.get('smtp:connect')!({}, { ...SAVED, tlsOptions: { rejectUnauthorized: false } }, 'acct-a');
    expect(verifies()).toBe(true);
  });

  it('sends it without certificate checks when it was saved that way', async () => {
    await setAccountSecrets('acct-a', { smtp: { password: 'smtp-pw', host: 'smtp.x.com', allowInsecureTLS: true } });
    expect(await h.handlers.get('smtp:connect')!({}, { ...SAVED, allowInsecureTLS: true }, 'acct-a')).toEqual({ success: true });
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'smtp-pw' }));
    expect(verifies()).toBe(false);
  });

  // A password saved by an older build records no transport. With no record
  // of the account in the registry main captured at startup, it is bound
  // strict — never to what a connect asks for. Breaks: the first connect for
  // such a password (possibly a compromised window's, for an account the app
  // had not used yet) decides how it is sent.
  it('binds a legacy entry with no registry record strict, refusing a looser connect', async () => {
    captureRegistryForLegacyBinding();
    dbState.blobs.set('secure-credentials', Buffer.from(`PLAIN1:${JSON.stringify({ 'acct-a': { smtp: { password: 'smtp-pw', host: 'smtp.x.com' } } })}`));
    const res = await h.handlers.get('smtp:connect')!({}, { ...SAVED, allowInsecureTLS: true }, 'acct-a');
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('Re-enter your password') });
    expect(h.connect).not.toHaveBeenCalled();
    expect((await getAccountSecrets('acct-a'))?.smtp).toEqual({ password: 'smtp-pw', host: 'smtp.x.com', allowInsecureTLS: false, allowPlaintext: false });
  });

  // Typing the password IS the choice: the window already holds that secret.
  it('lets a typed password be sent however the config asks', async () => {
    await h.handlers.get('smtp:connect')!({}, { ...SAVED, password: 'typed', allowInsecureTLS: true }, 'acct-a');
    expect(verifies()).toBe(false);
  });

  it('switches the relaxation off for good once a verified connection works', async () => {
    await setAccountSecrets('acct-a', { smtp: { password: 'smtp-pw', host: 'smtp.x.com', allowInsecureTLS: true } });
    expect(await h.handlers.get('smtp:connect')!({}, SAVED, 'acct-a')).toEqual({ success: true });
    expect(verifies()).toBe(true);
    expect((await getAccountSecrets('acct-a'))?.smtp?.allowInsecureTLS).toBe(false);
  });

  // A failed strict connect proves nothing. Breaks: one connect from a config
  // that forgot the opt-in costs a self-signed account its saved choice.
  it('keeps the relaxation when the stricter connection fails', async () => {
    await setAccountSecrets('acct-a', { smtp: { password: 'smtp-pw', host: 'smtp.x.com', allowInsecureTLS: true } });
    h.connect.mockRejectedValue(new Error('self-signed certificate'));
    expect((await h.handlers.get('smtp:connect')!({}, SAVED, 'acct-a')).success).toBe(false);
    expect((await getAccountSecrets('acct-a'))?.smtp?.allowInsecureTLS).toBe(true);
  });
});

describe('smtp:connectFor — the transport saved with the password', () => {
  // Breaks: send-as becomes the unguarded route to a loosened connection.
  it('refuses a relaxation the password was not saved with, and never dials', async () => {
    const res = await h.handlers.get('smtp:connectFor')!({}, 'acct-a', { ...SAVED, allowInsecureTLS: true });
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('Re-enter your password') });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('switches an unused relaxation off once the connection works', async () => {
    await setAccountSecrets('acct-a', { smtp: { password: 'smtp-pw', host: 'smtp.x.com', allowInsecureTLS: true } });
    expect(await h.handlers.get('smtp:connectFor')!({}, 'acct-a', SAVED)).toEqual({ success: true });
    expect((await getAccountSecrets('acct-a'))?.smtp?.allowInsecureTLS).toBe(false);
  });
});
