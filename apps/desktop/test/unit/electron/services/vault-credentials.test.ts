import { accountIdFor } from '@sarvinbox/core';
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
  warn: vi.fn(),
}));

vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: () => {}, warn: h.warn, error: () => {}, debug: () => {} }),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sarvinbox-vault-cred-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s: string) => Buffer.from(`${process.platform === 'linux' ? 'v11' : ''}enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => /^(?:v11)?enc\((.*)\)$/s.exec(b.toString('utf8'))![1],
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
  unknownServerMessage,
  vaultIdCandidates,
  vaultRefusalMessage,
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
  h.warn.mockReset();
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

  // Changed deliberately (CASA, residual of the host binding): this used to bind to
  // the first host asked for, which handed an unbound password to whichever connect
  // got there first, and a compromised window can ask first. Nothing else ever binds
  // an entry no account owns, so it stayed claimable indefinitely. The new rule is that
  // an entry with no account behind it at startup is simply not used, and the user is
  // told to re-enter it.
  it('neither uses nor binds an entry no account accounts for at startup', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    atStartup([]);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.evil.example')).resolves.toEqual({ status: 'unknown-server' });
    }
    expect((await getAccountSecrets('acct-a'))?.imap?.host).toBeUndefined();
  });

  // Breaks a startup connect into a storm: it re-reads the vault every 150 ms while it
  // waits for the keychain, which used to log dozens of these per id per attempt.
  it('warns once about a refused entry, however often it is asked', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    atStartup([]);
    for (let attempt = 0; attempt < 5; attempt++) await resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com');
    expect(h.warn.mock.calls.filter(([message]) => String(message).includes('not using the saved'))).toHaveLength(1);
  });

  // The other reason for a refused entry repeats on every poll too.
  it('warns once when the registry could not be read at startup', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    h.registryThrows = true;
    captureRegistryForLegacyBinding();
    for (let attempt = 0; attempt < 5; attempt++) await resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com');
    expect(h.warn.mock.calls.filter(([message]) => String(message).includes('not using the saved'))).toHaveLength(1);
  });

  // A later entry that is usable still wins over one nothing vouches for.
  it('still finds a usable password under a later id', async () => {
    await setAccountSecrets('acct-old', { imap: { password: 'old' } });
    await setAccountSecrets('acct-new', { imap: { password: 'new', host: 'imap.x.com' } });
    atStartup([]);
    await expect(resolveVaultPassword(['acct-old', 'acct-new'], 'imap', 'imap.x.com')).resolves.toEqual(found('new', 'acct-new'));
  });

  // A mismatch names the real server, so it is the more useful thing to tell the user.
  it('prefers a mismatch over an unknown server', async () => {
    await setAccountSecrets('acct-old', { imap: { password: 'old' } });
    await setAccountSecrets('acct-bound', { imap: { password: 'bound', host: 'imap.y.com' } });
    atStartup([]);
    await expect(resolveVaultPassword(['acct-old', 'acct-bound'], 'imap', 'imap.x.com'))
      .resolves.toEqual({ status: 'host-mismatch', boundHost: 'imap.y.com' });
  });

  // Breaks if the fix locks out what it should only have stopped being first-come: the
  // same password typed again is an ordinary new secret, bound to where it was typed for.
  it('lets the user re-enter a password for an entry nothing vouches for', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'old' } });
    atStartup([]);
    await setAccountSecrets('acct-a', { imap: { password: 'new', host: 'imap.x.com' } });
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('new', 'acct-a'));
  });

  // Breaks a real upgrade path. Older versions vaulted under ids derived from the
  // address, not the registry id, so these are real accounts with real passwords, and
  // used to depend on the first-host rule. Each must still connect, without any prompt.
  describe('ids older versions derived from the account', () => {
    const account = { id: accountIdFor('a@x.com', 'imap.x.com'), email: 'a@x.com',
      imapConfig: { host: 'imap.x.com', username: 'alias' }, smtpConfig: { host: 'smtp.x.com', username: 'sender' } };

    it.each([
      ['the email-only id', accountIdFor('a@x.com'), 'imap', 'imap.x.com'],
      ['the email and sending server', accountIdFor('a@x.com', 'smtp.x.com'), 'smtp', 'smtp.x.com'],
      ['the IMAP login', accountIdFor('alias'), 'imap', 'imap.x.com'],
      ['the IMAP login and server', accountIdFor('alias', 'imap.x.com'), 'imap', 'imap.x.com'],
      ['the SMTP login', accountIdFor('sender'), 'smtp', 'smtp.x.com'],
    ] as const)('binds %s to the server the registry records', async (_label, id, kind, host) => {
      await setAccountSecrets(id, { [kind]: { password: 'pw' } });
      atStartup([account]);
      await expect(resolveVaultPassword([id], kind, host)).resolves.toEqual(found('pw', id));
      expect((await getAccountSecrets(id))?.[kind]?.host).toBe(host);
    });

    // THE attack. Breaks: a compromised window gets in before the app's own first
    // connect and has the saved password sent to its server. It is refused, the entry
    // stays unbound, and the app's own connect that follows still works.
    it('refuses a server the registry does not record, even when asked first', async () => {
      const id = accountIdFor('a@x.com');
      await setAccountSecrets(id, { imap: { password: 'pw' } });
      atStartup([account]);
      await expect(resolveVaultPassword([id], 'imap', 'imap.evil.example')).resolves.toEqual({ status: 'host-mismatch', boundHost: 'imap.x.com' });
      expect((await getAccountSecrets(id))?.imap?.host).toBeUndefined();
      await expect(resolveVaultPassword([id], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', id));
    });

    // Multi-account: one address on two servers shares an email-only id. Either may
    // claim it, as before, since both are the user's own; a third server may not.
    it('accepts either server of an address the user has on two, and no other', async () => {
      const id = accountIdFor('a@x.com');
      await setAccountSecrets(id, { imap: { password: 'pw' } });
      atStartup([account, { id: accountIdFor('a@x.com', 'imap.y.com'), email: 'a@x.com', imapConfig: { host: 'imap.y.com' }, smtpConfig: null }]);
      await expect(resolveVaultPassword([id], 'imap', 'imap.evil.example')).resolves.toMatchObject({ status: 'host-mismatch' });
      await expect(resolveVaultPassword([id], 'imap', 'imap.y.com')).resolves.toEqual(found('pw', id));
      await expect(resolveVaultPassword([id], 'imap', 'imap.x.com')).resolves.toMatchObject({ status: 'host-mismatch', boundHost: 'imap.y.com' });
    });

    // Multi-account: one account's record must not vouch for another's password.
    it('does not let another account vouch for an entry', async () => {
      const id = accountIdFor('b@x.com');
      await setAccountSecrets(id, { imap: { password: 'pw' } });
      atStartup([account]);
      await expect(resolveVaultPassword([id], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'unknown-server' });
      expect((await getAccountSecrets(id))?.imap?.host).toBeUndefined();
    });

    // Breaks the promise above for a self-signed account. The host rule finds its owner
    // through the derived id; if the transport looked only at the exact id it would find
    // no record, write "strict" for good, and refuse the account's own connect with
    // "Re-enter your password".
    it('reads the transport from the account the host rule found', async () => {
      const id = accountIdFor('a@x.com');
      legacyVault({ [id]: { imap: { password: 'pw' } } });
      atStartup([{ id: accountIdFor('a@x.com', 'imap.x.com'), email: 'a@x.com', imapConfig: { host: 'imap.x.com', allowInsecureTLS: true }, smtpConfig: null }]);

      const result = await resolveVaultPassword([id], 'imap', 'imap.x.com');

      expect(result).toEqual(found('pw', id, SELF_SIGNED));
      expect(withSavedPassword({ host: 'imap.x.com', allowInsecureTLS: true }, 'imap', result as VaultPasswordFound)).toHaveProperty('config');
      expect((await getAccountSecrets(id))?.imap).toEqual({ password: 'pw', host: 'imap.x.com', ...SELF_SIGNED });
    });

    // The same when the host was bound by an earlier version and only the transport
    // is missing: it is still found through the account, not the exact id.
    it('reads it through the account for an entry already bound to its host', async () => {
      const id = accountIdFor('a@x.com');
      legacyVault({ [id]: { imap: { password: 'pw', host: 'imap.x.com' } } });
      atStartup([{ id: accountIdFor('a@x.com', 'imap.x.com'), email: 'a@x.com', imapConfig: { host: 'imap.x.com', allowInsecureTLS: true }, smtpConfig: null }]);
      await expect(resolveVaultPassword([id], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', id, SELF_SIGNED));
    });

    // Multi-account: the relaxations of one server must not travel to the other, and
    // which is which depends on the server asked for, not on registry order.
    it.each([
      ['imap.strict.com', STRICT],
      ['imap.selfsigned.com', SELF_SIGNED],
    ])('takes the transport from the owner whose server is %s', async (host, transport) => {
      const id = accountIdFor('a@x.com');
      legacyVault({ [id]: { imap: { password: 'pw' } } });
      atStartup([
        { id: accountIdFor('a@x.com', 'imap.strict.com'), email: 'a@x.com', imapConfig: { host: 'imap.strict.com' }, smtpConfig: null },
        { id: accountIdFor('a@x.com', 'imap.selfsigned.com'), email: 'a@x.com', imapConfig: { host: 'imap.selfsigned.com', allowInsecureTLS: true }, smtpConfig: null },
      ]);
      await expect(resolveVaultPassword([id], 'imap', host)).resolves.toEqual(found('pw', id, transport));
    });

    // Relaxations chosen for one server do not carry to another, and a password bound
    // by the same-site rule has no record of its own, so it stays strict.
    it('stays strict for a server the same account does not record', async () => {
      legacyVault({ 'acct-a': { smtp: { password: 's' } } });
      atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com', allowInsecureTLS: true }, smtpConfig: null }]);
      await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.x.com')).resolves.toEqual(found('s', 'acct-a'));
    });
  });

  // A sending password on an account whose sending server was never recorded: seeded
  // accounts have smtpConfig null. The IMAP server says which provider this is.
  describe('a password whose own server was never recorded', () => {
    const imapOnly = (host: string) => ({ id: 'acct-a', email: 'a@x.com', imapConfig: { host }, smtpConfig: null });

    // Breaks an existing account's sending, without so much as a prompt.
    it('binds to a server on the same site as the one recorded', async () => {
      await setAccountSecrets('acct-a', { smtp: { password: 's' } });
      atStartup([imapOnly('imap.x.com')]);
      await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.x.com')).resolves.toEqual(found('s', 'acct-a'));
      expect((await getAccountSecrets('acct-a'))?.smtp?.host).toBe('smtp.x.com');
    });

    // Breaks the point of the rule. These look alike to anything short of a real
    // registrable-domain comparison. The refusal claims no server: nothing on record
    // says this password was for the IMAP server, only that this host is not its site.
    it.each(['smtp.evil.example', 'x.com.evil.example', 'evil-x.com', 'x.co', 'smtp.y.com'])('refuses %s, without saying which server it is for', async (host) => {
      await setAccountSecrets('acct-a', { smtp: { password: 's' } });
      atStartup([imapOnly('imap.x.com')]);
      await expect(resolveVaultPassword(['acct-a'], 'smtp', host)).resolves.toEqual({ status: 'unknown-server' });
      expect((await getAccountSecrets('acct-a'))?.smtp?.host).toBeUndefined();
    });

    // THE measured bind: a legacy SMTP password on mail.me.duckdns.org went for good to
    // attacker.duckdns.org. Everyone under these suffixes is a different customer, so a
    // plain registrable-domain check reads them all as one site. The second column is
    // the same customer's own other server, which must still bind.
    it.each([
      ['mail.me.duckdns.org', 'attacker.duckdns.org', 'smtp.me.duckdns.org'],
      ['mail.me.github.io', 'attacker.github.io', 'smtp.me.github.io'],
      ['mail.me.no-ip.org', 'attacker.no-ip.org', 'smtp.me.no-ip.org'],
      ['mail.me.herokuapp.com', 'attacker.herokuapp.com', 'smtp.me.herokuapp.com'],
      ['ec2-1-1-1-1.ap-south-1.compute.amazonaws.com', 'ec2-2-2-2-2.ap-south-1.compute.amazonaws.com', null],
    ])('treats tenants of a shared suffix as different sites: %s and %s', async (recorded, attacker, sameTenant) => {
      await setAccountSecrets('acct-a', { smtp: { password: 's' } });
      atStartup([imapOnly(recorded)]);
      await expect(resolveVaultPassword(['acct-a'], 'smtp', attacker)).resolves.toEqual({ status: 'unknown-server' });
      expect((await getAccountSecrets('acct-a'))?.smtp?.host).toBeUndefined();
      if (sameTenant) await expect(resolveVaultPassword(['acct-a'], 'smtp', sameTenant)).resolves.toEqual(found('s', 'acct-a'));
    });

    // Breaks the ordinary country-code provider, which is most of the world's mail.
    it('keeps co.uk style suffixes working', async () => {
      await setAccountSecrets('acct-a', { smtp: { password: 's' } });
      atStartup([imapOnly('imap.x.co.uk')]);
      await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.y.co.uk')).resolves.toEqual({ status: 'unknown-server' });
      await expect(resolveVaultPassword(['acct-a'], 'smtp', 'co.uk')).resolves.toEqual({ status: 'unknown-server' });
      await expect(resolveVaultPassword(['acct-a'], 'smtp', 'smtp.x.co.uk')).resolves.toEqual(found('s', 'acct-a'));
    });

    // A server named by address has no site: only the same address will do. The same
    // goes for localhost, which a local bridge (Proton Bridge, say) is reached on.
    it.each([
      ['192.168.1.5', '192.168.1.6'],
      ['localhost', '127.0.0.1'],
    ])('compares %s exactly', async (recorded, other) => {
      await setAccountSecrets('acct-a', { smtp: { password: 's' } });
      atStartup([imapOnly(recorded)]);
      await expect(resolveVaultPassword(['acct-a'], 'smtp', other)).resolves.toEqual({ status: 'unknown-server' });
      await expect(resolveVaultPassword(['acct-a'], 'smtp', recorded)).resolves.toEqual(found('s', 'acct-a'));
    });

    it('works the other way round, for an IMAP password', async () => {
      await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
      atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: null, smtpConfig: { host: 'smtp.x.com' } }]);
      await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.evil.example')).resolves.toEqual({ status: 'unknown-server' });
      await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', 'acct-a'));
    });

    // An account with no server recorded at all has nothing to compare with.
    it('is not used when the account records no server at all', async () => {
      await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
      atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: null, smtpConfig: null }]);
      await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'unknown-server' });
    });

    // Accepted cost of the rule: one prompt for a real pair on two sites. No pair list.
    // Breaks if the prompt misleads: it must not call the password one for imap.icloud.com.
    it('asks once for a real cross-site pair, and the prompt names only the server asked for', async () => {
      await setAccountSecrets('acct-a', { smtp: { password: 's' } });
      atStartup([imapOnly('imap.icloud.com')]);
      const result = await resolveVaultPassword(['acct-a'], 'smtp', 'smtp.mail.me.com');
      expect(result).toEqual({ status: 'unknown-server' });
      const message = vaultRefusalMessage('smtp', 'smtp.mail.me.com', result)!;
      expect(message).toContain('smtp.mail.me.com');
      expect(message).toContain('Re-enter your password');
      expect(message).not.toContain('icloud');
    });
  });

  // Only passwords go through here. Breaks the claim the file header makes: a token
  // left in an old vault entry must not be returned, or bound, for any host.
  it('never returns or binds an entry holding only a token', async () => {
    legacyVault({ 'acct-a': { imap: { accessToken: 'at', refreshToken: 'rt' } } });
    atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: null }]);
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });
    expect((await getAccountSecrets('acct-a'))?.imap?.host).toBeUndefined();
  });

  // Transient, not permanent: an unreadable registry leaves the entry unbound, and the
  // next start that can read it binds as normal. Breaks: one bad start costs a password.
  it('binds on the next start after a start that could not read the registry', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    h.registryThrows = true;
    captureRegistryForLegacyBinding();
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual({ status: 'none' });

    h.registryThrows = false;
    atStartup([{ id: 'acct-a', email: 'a@x.com', imapConfig: { host: 'imap.x.com' }, smtpConfig: null }]);
    await expect(resolveVaultPassword(['acct-a'], 'imap', 'imap.x.com')).resolves.toEqual(found('pw', 'acct-a'));
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

describe('vaultRefusalMessage', () => {
  // Breaks the user being told what to do: each settled refusal has its own message,
  // and the unsettled answers have none, so a caller can fall through to its own.
  it('answers for the two settled refusals and nothing else', () => {
    expect(vaultRefusalMessage('imap', 'imap.y.com', { status: 'host-mismatch', boundHost: 'imap.x.com' }))
      .toBe(hostMismatchMessage('imap', 'imap.y.com', 'imap.x.com'));
    expect(vaultRefusalMessage('smtp', 'smtp.y.com', { status: 'unknown-server' })).toBe(unknownServerMessage('smtp', 'smtp.y.com'));
    expect(vaultRefusalMessage('imap', 'imap.y.com', { status: 'none' })).toBeNull();
    expect(vaultRefusalMessage('imap', 'imap.x.com', found('pw', 'acct-a') as VaultPasswordFound)).toBeNull();
  });

  it('says which kind of password, and to re-enter it', () => {
    expect(unknownServerMessage('imap', 'imap.y.com')).toContain('mailbox password');
    expect(unknownServerMessage('smtp', 'smtp.y.com')).toContain('sending password');
    expect(unknownServerMessage('smtp', 'smtp.y.com')).toContain('Re-enter your password');
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
