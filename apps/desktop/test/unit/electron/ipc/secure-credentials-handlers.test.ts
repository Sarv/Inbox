import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the renderer — which also renders untrusted
// email HTML, and which DevTools could reach — regains an IPC that returns
// decrypted mailbox passwords, bypassing the Touch ID gate on `reveal`
// (CASA H-1); or saved secrets lose the host they're bound to.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  set: vi.fn(async () => {}),
  get: vi.fn(async () => ({ imap: { password: 'pw', host: 'imap.x.com' } })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  systemPreferences: {},
}));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../electron/services/secure-credential-store', () => ({
  setAccountSecrets: h.set,
  getAccountSecrets: h.get,
  deleteAccountSecrets: vi.fn(),
  hasAccountSecrets: vi.fn(async () => true),
  isSecureStorageAvailable: () => true,
}));

import { registerSecureCredentialsHandlers } from '../../../../electron/ipc/secure-credentials-handlers';

beforeEach(() => {
  h.handlers.clear();
  h.set.mockClear();
  registerSecureCredentialsHandlers();
});

describe('secure-credentials IPC surface', () => {
  // THE finding. Breaks: any renderer script can read every mailbox password.
  it('registers no handler that returns stored secrets', () => {
    expect(h.handlers.has('secureCreds:get')).toBe(false);
    expect([...h.handlers.keys()].sort()).toEqual([
      'secureCreds:available',
      'secureCreds:delete',
      'secureCreds:has',
      'secureCreds:hasPassword',
      'secureCreds:reveal',
      'secureCreds:set',
    ]);
  });

  // Breaks: "is a password saved?" starts leaking the password itself.
  it('answers hasPassword with a boolean only', async () => {
    const res = await h.handlers.get('secureCreds:hasPassword')!({}, 'acct-a', 'imap');
    expect(res).toEqual({ success: true, data: true });
  });

  // Breaks: the host a secret is saved for never reaches the vault.
  it('passes the host through to the vault with the secret', async () => {
    await h.handlers.get('secureCreds:set')!({}, 'acct-a', { imap: { password: 'pw', host: 'imap.x.com' } });
    expect(h.set).toHaveBeenCalledWith('acct-a', { imap: { password: 'pw', host: 'imap.x.com' } });
  });
});
