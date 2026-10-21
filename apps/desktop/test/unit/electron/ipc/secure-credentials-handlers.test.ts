import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the renderer — which also renders untrusted
// email HTML, and which DevTools could reach — regains an IPC that returns
// decrypted mailbox passwords, bypassing the Touch ID gate on `reveal`
// (CASA H-1); or saved secrets lose the host they're bound to.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  set: vi.fn(async () => {}),
  get: vi.fn(async () => ({ imap: { password: 'pw', host: 'imap.x.com' } })),
  requestAccess: vi.fn(async () => ({ outcome: 'authorized', status: 0, restarting: true })),
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
vi.mock('../../../../electron/services/secure-storage-status', () => ({
  getSecureStorageStatus: () => ({
    platform: 'darwin', keyStore: 'unavailable', databaseKey: 'encrypted', databaseKeyProtection: 'encrypted', databaseReadable: false,
    stores: [{ id: 'credentials', envelope: 'unknown', protection: 'encrypted', protectedByDatabase: true, label: 'Saved passwords' }],
  }),
}));
vi.mock('../../../../electron/services/secure-storage-access', () => ({ requestSecureStorageAccess: h.requestAccess }));

import { registerSecureCredentialsHandlers } from '../../../../electron/ipc/secure-credentials-handlers';

beforeEach(() => {
  h.handlers.clear();
  h.set.mockClear();
  h.get.mockClear();
  h.requestAccess.mockReset().mockResolvedValue({ outcome: 'authorized', status: 0, restarting: true });
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
      'secureCreds:requestAccess',
      'secureCreds:reveal',
      'secureCreds:set',
      'secureCreds:status',
    ]);
  });

  it('requests native access without accepting a credential or returning secret values', async () => {
    const result = await h.handlers.get('secureCreds:requestAccess')!({});
    expect(result).toEqual({ success: true, data: { outcome: 'authorized', status: 0, restarting: true } });
    expect(h.requestAccess).toHaveBeenCalledWith();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('does not expose native error details or credentials when authorization fails', async () => {
    h.requestAccess.mockRejectedValueOnce(new Error('synthetic-secret-native-error'));
    const result = await h.handlers.get('secureCreds:requestAccess')!({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('macOS could not authorize');
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-native-error');
  });

  it('returns protection metadata without passwords, token values or the database key', async () => {
    const res = await h.handlers.get('secureCreds:status')!({});
    expect(res.success).toBe(true);
    expect(res.data.databaseKey).toBe('encrypted');
    expect(res.data.stores[0].envelope).toBe('unknown');
    expect(h.get).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain('pw');
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
