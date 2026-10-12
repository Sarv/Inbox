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

import { resetFakeCoreDb, state as dbState } from '../../../../electron/services/__testing__/fake-core-db';
import { getAccountSecrets, setAccountSecrets } from '../../../../electron/services/secure-credential-store';
import {
  captureRegistryForLegacyBinding,
  hostMismatchMessage,
  narrowSavedTransport,
  resolveVaultPassword,
  transportMismatchMessage,
  vaultIdCandidates,
  withSavedPassword,
  type VaultPasswordFound,
} from '../../../../electron/services/vault-credentials';

const STRICT = { allowInsecureTLS: false, allowPlaintext: false };
const SELF_SIGNED = { allowInsecureTLS: true, allowPlaintext: false };
// Changed deliberately (transport binding): a found password now comes with the
// relaxations saved alongside it and the id it was found under; the 'found'
// expectations below that use this used to be { status, password } only.
const found = (password: string, id: string, transport = STRICT) => ({ status: 'found', password, transport, id });
/**
 * The registry as main snapshots it at startup, before the window exists.
 * Legacy entries are bound from this snapshot only — later registry writes
 * (the window's accounts:save) do not count.
 */
const atStartup = (registry: Array<Record<string, unknown>>) => {
  h.registry = registry;
  captureRegistryForLegacyBinding();
};
/** A vault written by an older build: entries exactly as given, no transport fields. */
const legacyVault = (vault: unknown) => dbState.blobs.set('secure-credentials', Buffer.from(`PLAIN1:${JSON.stringify(vault)}`, 'utf8'));

beforeEach(() => {
  resetFakeCoreDb();
  h.registryThrows = false;
  atStartup([]);
});

describe('resolveVaultPassword — bound entries', () => {
  // Breaks: saved accounts stop connecting.
  it('returns the password for the host it was saved for, case- and root-dot-insensitively', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw', host: 'imap.x.com' } });
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', 'acct-a'));
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'IMAP.X.com.')).resolves.toEqual(found('pw', 'acct-a'));
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
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.x.com')).resolves.toEqual(found('s', 'acct-a'));
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'imap.x.com')).resolves.toMatchObject({ status: 'host-mismatch' });
  });

  // Multi-account: the same address on two servers, each with its own password.
  // Breaks: account B's password is used for account A's server.
  it('picks the candidate bound to the requested host, skipping a mismatch', async () => {
    await setAccountSecrets('acct-u--imap-a-com', { imap: { password: 'a-pw', host: 'imap.a.com' } });
    await setAccountSecrets('acct-u--imap-b-com', { imap: { password: 'b-pw', host: 'imap.b.com' } });
    await expect(resolveVaultPassword(['acct-u--imap-a-com', 'acct-u--imap-b-com'], 'imap', 'imap.b.com'))
      .resolves.toEqual(found('b-pw', 'acct-u--imap-b-com'));
  });

  it('is none for no host, no entry, or an entry without a password', async () => {
    await setAccountSecrets('acct-t', { imap: { accessToken: 'tok', host: 'imap.x.com' } });
    await expect(resolveVaultPassword(['acct-a'], 'imap', undefined)).resolves.toEqual({ status: 'none' });
    await expect(resolveVaultPassword(['acct-missing'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });
    await expect(resolveVaultPassword(['acct-t'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });
  });
});

describe('resolveVaultPassword — legacy (unbound) entries', () => {
  // Changed deliberately (startup snapshot): the registry these tests bind
  // from is now the one main captured at startup (atStartup), not the live one
  // — the window writes the live registry. The rules they pin are unchanged.

  // Upgrade path: entries saved before binding. Breaks: every existing
  // password account stops connecting after the update.
  it('binds to the host the account registry records, then enforces it', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: null }]);
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', 'acct-a'));
    expect((await getAccountSecrets('acct-a'))?.imap?.host).toBe('imap.x.com');
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.evil.example')).resolves.toMatchObject({ status: 'host-mismatch' });
  });

  // Breaks: an unbound legacy password goes to a host the registry disagrees with.
  it('refuses a host the registry disagrees with, without binding', async () => {
    await setAccountSecrets('acct-a', { smtp: { password: 's' } });
    atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: { host: 'smtp.x.com' } }]);
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.evil.example')).resolves.toEqual({
      status: 'host-mismatch', boundHost: 'smtp.x.com',
    });
    expect((await getAccountSecrets('acct-a'))?.smtp?.host).toBeUndefined();
  });

  // THE window-written registry. Breaks: a compromised window rewrites an
  // account's server in the registry (accounts:save) before the app has used
  // that account's saved password, and the password is bound to its server.
  it('ignores registry writes made after startup', async () => {
    await setAccountSecrets('acct-a', { smtp: { password: 's' } });
    atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: { host: 'smtp.x.com' } }]);
    h.registry = [{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: { host: 'smtp.evil.example' } }];
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.evil.example')).resolves.toMatchObject({ status: 'host-mismatch' });
  });

  // No registry record (e.g. an email-only legacy id): bound on first use.
  it('binds to the first host asked for when the registry has no record', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    atStartup([]);
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', 'acct-a'));
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.y.com')).resolves.toMatchObject({ status: 'host-mismatch' });
  });

  // An unreadable registry is not "no record". Breaks: a registry read failure
  // lets an unbound password be bound to whatever host is asked for.
  it('neither uses nor binds an unbound entry when the registry was unreadable at startup', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    h.registryThrows = true;
    captureRegistryForLegacyBinding();
    h.registryThrows = false;
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });
    expect((await getAccountSecrets('acct-a'))?.imap?.host).toBeUndefined();
  });
});

describe('resolveVaultPassword — how the password may be sent', () => {
  // Breaks: a self-signed account's saved password stops connecting, or the
  // relaxation chosen for IMAP leaks onto SMTP.
  it('returns the relaxations saved with the password, per kind', async () => {
    await setAccountSecrets('acct-a', {
      imap: { password: 'i', host: 'imap.x.com', allowInsecureTLS: true },
      smtp: { password: 's', host: 'smtp.x.com', allowPlaintext: true },
    });
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('i', 'acct-a', SELF_SIGNED));
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.x.com'))
      .resolves.toEqual(found('s', 'acct-a', { allowInsecureTLS: false, allowPlaintext: true }));
  });

});

describe('resolveVaultPassword — legacy entries without a recorded transport', () => {
  // Upgrade path: every password saved before this change. Breaks: an existing
  // self-signed or unencrypted account stops connecting after the update.
  it('binds to what the startup registry records for that kind, then keeps it', async () => {
    legacyVault({ 'acct-a': { imap: { password: 'pw', host: 'imap.x.com' }, smtp: { password: 's', host: 'smtp.x.com' } } });
    atStartup([{
      id: 'acct-a', email: 'a@x.com',
      imapConfig: { host: 'imap.x.com', allowInsecureTLS: true, security: 'none' },
      smtpConfig: { host: 'smtp.x.com', security: 'ssl' },
    }]);
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com'))
      .resolves.toEqual(found('pw', 'acct-a', { allowInsecureTLS: true, allowPlaintext: true }));
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.x.com')).resolves.toEqual(found('s', 'acct-a'));
    expect(await getAccountSecrets('acct-a')).toEqual({
      imap: { password: 'pw', host: 'imap.x.com', allowInsecureTLS: true, allowPlaintext: true },
      smtp: { password: 's', host: 'smtp.x.com', ...STRICT },
    });
    // Bound: the next startup's registry does not move it.
    atStartup([]);
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com'))
      .resolves.toEqual(found('pw', 'acct-a', { allowInsecureTLS: true, allowPlaintext: true }));
  });

  // THE bypass the review found. Breaks: before the app happens to use a
  // legacy password (another account's sending password, an account without
  // background sync), a compromised window writes "None" / "allow self-signed"
  // into the registry and the password is bound — and sent — that way.
  it('ignores registry writes made after startup', async () => {
    legacyVault({ 'acct-b': { smtp: { password: 's', host: 'smtp.b.com' } } });
    atStartup([{ id: 'acct-b', email: 'b@b.com', imapConfig: { host: 'imap.b.com' }, smtpConfig: { host: 'smtp.b.com', security: 'ssl' } }]);
    h.registry = [{ id: 'acct-b', email: 'b@b.com', imapConfig: { host: 'imap.b.com' }, smtpConfig: { host: 'smtp.b.com', security: 'none', allowInsecureTLS: true } }];
    await expect(resolveVaultPassword(['acct-b'], 'smtp', 'smtp.b.com')).resolves.toEqual(found('s', 'acct-b'));
  });

  // An OAuth registry config never grants either relaxation to the password.
  it('reads an OAuth registry config as strict', async () => {
    legacyVault({ 'acct-a': { imap: { password: 'pw', host: 'imap.x.com' } } });
    atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com', authMethod: 'oauth2', allowInsecureTLS: true, security: 'none' } }]);
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', 'acct-a'));
  });

  // Nothing recorded to go by (an email-only legacy id, or no sending config):
  // strict, never what a connect asks for. Breaks: the first connect for such
  // a password — possibly a compromised window's — decides how it is sent.
  it('binds strict when the startup registry has no config for that kind', async () => {
    legacyVault({ 'acct-a': { smtp: { password: 's', host: 'smtp.x.com' } }, 'acct-b': { imap: { password: 'b', host: 'imap.b.com' } } });
    atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: null }]);
    await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.x.com')).resolves.toEqual(found('s', 'acct-a'));
    await expect(resolveVaultPassword(['acct-b'], 'imap', 'imap.b.com')).resolves.toEqual(found('b', 'acct-b'));
    expect((await getAccountSecrets('acct-b'))?.imap).toEqual({ password: 'b', host: 'imap.b.com', ...STRICT });
  });

  // Fills only what is missing. Breaks: a partly-recorded entry is re-decided.
  it('keeps a relaxation the entry already records', async () => {
    legacyVault({ 'acct-a': { imap: { password: 'pw', host: 'imap.x.com', allowInsecureTLS: true } } });
    atStartup([]);
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', 'acct-a', SELF_SIGNED));
  });

  // The registry only matters for entries that record nothing. Breaks: every
  // saved password stops connecting whenever the registry can't be read.
  it('uses an entry that records its transport even with no startup snapshot', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw', host: 'imap.x.com', allowInsecureTLS: true } });
    h.registryThrows = true;
    captureRegistryForLegacyBinding();
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', 'acct-a', SELF_SIGNED));
  });

  // No snapshot is not "no record". Breaks: a registry that could not be read
  // at startup makes every legacy password bind strict-or-whatever by default.
  it('neither uses nor binds the entry when the registry was unreadable at startup', async () => {
    legacyVault({ 'acct-a': { imap: { password: 'pw', host: 'imap.x.com' } } });
    h.registryThrows = true;
    captureRegistryForLegacyBinding();
    h.registryThrows = false;
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });
    expect((await getAccountSecrets('acct-a'))?.imap).toEqual({ password: 'pw', host: 'imap.x.com' });
  });
});

describe('withSavedPassword', () => {
  const saved = (transport = STRICT): VaultPasswordFound => ({ status: 'found', password: 'pw', transport, id: 'acct-a' });
  const config = { host: 'imap.x.com', port: 993, username: 'a@x.com', authMethod: 'password' as const, security: 'ssl' as const };

  it('injects the password for a connect asking for no more than was saved', () => {
    expect(withSavedPassword(config, 'imap', saved())).toEqual({ config: { ...config, password: 'pw', allowInsecureTLS: false } });
    expect(withSavedPassword({ ...config, allowInsecureTLS: true }, 'imap', saved(SELF_SIGNED)))
      .toEqual({ config: { ...config, password: 'pw', allowInsecureTLS: true } });
  });

  // THE finding. Breaks: a compromised window adds "allow self-signed" (or
  // 'none') to a saved account's connect, and main hands the real password to
  // a man-in-the-middle.
  it('refuses a connect asking for a relaxation the password was not saved with', () => {
    expect(withSavedPassword({ ...config, allowInsecureTLS: true }, 'imap', saved())).toEqual({
      refusal: "Your saved mailbox password was saved for a connection that checks imap.x.com's certificate. Re-enter your password to connect without checking it.",
    });
    expect(withSavedPassword({ ...config, security: 'none' as const }, 'imap', saved(SELF_SIGNED))).toEqual({
      refusal: 'Your saved mailbox password was saved for an encrypted connection to imap.x.com. Re-enter your password to connect without encryption.',
    });
  });

  // Tightening is the user's call. Breaks: unticking "allow self-signed" is ignored.
  it('lets a connect be stricter than the password was saved for', () => {
    const both = { allowInsecureTLS: true, allowPlaintext: true };
    expect(withSavedPassword(config, 'imap', saved(both))).toEqual({ config: { ...config, password: 'pw', allowInsecureTLS: false } });
  });
});

describe('narrowSavedTransport', () => {
  const both = { allowInsecureTLS: true, allowPlaintext: true };
  const savedBoth = async (): Promise<VaultPasswordFound> => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw', host: 'imap.x.com', ...both } });
    return { status: 'found', password: 'pw', transport: both, id: 'acct-a' };
  };

  // A verified, encrypted connection to that server just worked. Breaks: the
  // user's switch back to "verify" never sticks, so a later config can switch
  // the saved password back to an unverified connection.
  it('switches off the relaxations a working connection did without', async () => {
    await narrowSavedTransport('imap', await savedBoth(), { security: 'starttls' });
    expect((await getAccountSecrets('acct-a'))?.imap).toEqual({ password: 'pw', host: 'imap.x.com', ...STRICT });
  });

  it('keeps the relaxations the connection used', async () => {
    await narrowSavedTransport('imap', await savedBoth(), { allowInsecureTLS: true, security: 'none' });
    expect((await getAccountSecrets('acct-a'))?.imap).toEqual({ password: 'pw', host: 'imap.x.com', ...both });
    await narrowSavedTransport('imap', await savedBoth(), { allowInsecureTLS: true, security: 'ssl' });
    expect((await getAccountSecrets('acct-a'))?.imap).toEqual({ password: 'pw', host: 'imap.x.com', allowInsecureTLS: true, allowPlaintext: false });
  });

  // Best-effort: a vault that can't be written must not fail a working connect.
  it('swallows a write failure', async () => {
    const saved = await savedBoth();
    dbState.blobs.set('secure-credentials', Buffer.from('garbage'));
    await expect(narrowSavedTransport('imap', saved, {})).resolves.toBeUndefined();
  });
});

describe('transportMismatchMessage', () => {
  // Breaks: the user sees a vague error and can't tell what to do.
  it('says what the saved password allows and to re-enter it', () => {
    expect(transportMismatchMessage('smtp', 'smtp.x.com', 'insecure-tls')).toContain('Your saved sending password');
    expect(transportMismatchMessage('smtp', 'smtp.x.com', 'plaintext')).toContain('Re-enter your password to connect without encryption.');
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
