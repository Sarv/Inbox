import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mailbox passwords never leave main, and main only sends a saved password to
 * the server it was saved for. The connect config — host included — comes from
 * the renderer, which also renders untrusted email HTML; without the binding, a
 * compromised renderer could ask main to log in to ITS server with the user's
 * real password, which is the same leak as handing the password over.
 *
 * Runs against the real vault store over the fake core DB; only the account
 * registry and Electron are faked.
 */

const h = vi.hoisted(() => ({
  registry: [] as Array<Record<string, unknown>>,
  registryThrows: false,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sarvinbox-vault-cred-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => /^enc\((.*)\)$/s.exec(b.toString('utf8'))![1],
  },
}));
vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  readRegistryAccounts: () => {
    if (h.registryThrows) throw new Error('registry unreadable');
    return h.registry;
  },
}));

import { resetFakeCoreDb } from '../../../../electron/services/__testing__/fake-core-db';
import { getAccountSecrets, setAccountSecrets } from '../../../../electron/services/secure-credential-store';
import {
  hostMismatchMessage,
  resolveVaultPassword,
  vaultIdCandidates,
} from '../../../../electron/services/vault-credentials';

beforeEach(() => {
  resetFakeCoreDb();
  h.registry = [];
  h.registryThrows = false;
});

describe('resolveVaultPassword — bound entries', () => {
  // Breaks: saved accounts stop connecting.
  it('returns the password for the host it was saved for, case- and root-dot-insensitively', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw', host: 'imap.x.com' } });
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'found', password: 'pw' });
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'IMAP.X.com.')).resolves.toEqual({ status: 'found', password: 'pw' });
  });

  // THE leak. Breaks: a renderer-chosen server receives the real password.
  it('refuses another host, reporting which host the password belongs to', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw', host: 'imap.x.com' } });
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.evil.example')).resolves.toEqual({
      status: 'host-mismatch', boundHost: 'imap.x.com',
    });
  });

  // Breaks: the IMAP password is sent to the SMTP server or vice versa.
  it('keeps IMAP and SMTP bindings separate', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'i', host: 'imap.x.com' }, smtp: { password: 's', host: 'smtp.x.com' } });
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.x.com')).resolves.toEqual({ status: 'found', password: 's' });
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'imap.x.com')).resolves.toMatchObject({ status: 'host-mismatch' });
  });

  // Multi-account: the same address on two servers, each with its own password.
  // Breaks: account B's password is used for account A's server.
  it('picks the candidate bound to the requested host, skipping a mismatch', async () => {
    await setAccountSecrets('acct-u--imap-a-com', { imap: { password: 'a-pw', host: 'imap.a.com' } });
    await setAccountSecrets('acct-u--imap-b-com', { imap: { password: 'b-pw', host: 'imap.b.com' } });
    await expect(resolveVaultPassword(['acct-u--imap-a-com', 'acct-u--imap-b-com'], 'imap', 'imap.b.com'))
      .resolves.toEqual({ status: 'found', password: 'b-pw' });
  });

  it('is none for no host, no entry, or an entry without a password', async () => {
    await setAccountSecrets('acct-t', { imap: { accessToken: 'tok', host: 'imap.x.com' } });
    await expect(resolveVaultPassword(['acct-a'], 'imap', undefined)).resolves.toEqual({ status: 'none' });
    await expect(resolveVaultPassword(['acct-missing'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });
    await expect(resolveVaultPassword(['acct-t'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });
  });
});

describe('resolveVaultPassword — legacy (unbound) entries', () => {
  // Upgrade path: entries saved before binding. Breaks: every existing
  // password account stops connecting after the update.
  it('binds to the host the account registry records, then enforces it', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    h.registry = [{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: null }];
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'found', password: 'pw' });
    expect((await getAccountSecrets('acct-a'))?.imap?.host).toBe('imap.x.com');
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.evil.example')).resolves.toMatchObject({ status: 'host-mismatch' });
  });

  // Breaks: an unbound legacy password goes to a host the registry disagrees with.
  it('refuses a host the registry disagrees with, without binding', async () => {
    await setAccountSecrets('acct-a', { smtp: { password: 's' } });
    h.registry = [{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: { host: 'smtp.x.com' } }];
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.evil.example')).resolves.toEqual({
      status: 'host-mismatch', boundHost: 'smtp.x.com',
    });
    expect((await getAccountSecrets('acct-a'))?.smtp?.host).toBeUndefined();
  });

  // No registry record (e.g. an email-only legacy id): bound on first use.
  it('binds to the first host asked for when the registry has no record', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'found', password: 'pw' });
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.y.com')).resolves.toMatchObject({ status: 'host-mismatch' });
  });

  // An unreadable registry is not "no record". Breaks: a registry read failure
  // lets an unbound password be bound to whatever host is asked for.
  it('neither uses nor binds an unbound entry while the registry is unreadable', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    h.registryThrows = true;
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });
    expect((await getAccountSecrets('acct-a'))?.imap?.host).toBeUndefined();
  });
});

describe('vaultIdCandidates', () => {
  // Legacy accounts were vaulted under the registry id, the registry-derived
  // id, the host-derived id or the email-only id. Breaks: a stored password
  // isn't found and the user is asked to re-enter it.
  it('lists every legacy id variant once, in priority order', () => {
    h.registry = [{ id: 'acct-legacy', email: 'a@x.com', imapConfig: { host: 'imap.x.com' } }];
    expect(vaultIdCandidates('acct-legacy', 'a@x.com', 'smtp.x.com')).toEqual([
      'acct-legacy', 'acct-a-x-com--imap-x-com', 'acct-a-x-com--smtp-x-com', 'acct-a-x-com',
    ]);
  });

  it('still lists the derived ids with no account id or an unreadable registry', () => {
    expect(vaultIdCandidates(undefined, 'a@x.com', 'imap.x.com')).toEqual(['acct-a-x-com--imap-x-com', 'acct-a-x-com']);
    h.registryThrows = true;
    expect(vaultIdCandidates('acct-a', 'a@x.com', 'imap.x.com')).toEqual(['acct-a', 'acct-a-x-com--imap-x-com', 'acct-a-x-com']);
  });
});

describe('hostMismatchMessage', () => {
  // Breaks: the user sees a vague error and can't tell they need to re-enter it.
  it('names both servers and tells the user to re-enter the password', () => {
    expect(hostMismatchMessage('imap', 'imap.y.com', 'imap.x.com')).toBe(
      'Your saved mailbox password is for imap.x.com. Re-enter your password to connect to imap.y.com.',
    );
    expect(hostMismatchMessage('smtp', 'smtp.y.com', 'smtp.x.com')).toContain('sending password');
  });
});
