import {
  buildAutocryptHeader,
  generateKeyPair,
  inspectKey,
  protectPrivateKey,
  readAnyKey,
  type GeneratedKey,
  type PgpPrefs,
} from '@sarvinbox/core/pgp';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ safeStorage: {} }));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => {
    throw new Error('the core DB is not opened in tests');
  },
}));

import type { KeyLookupResult } from '../../../../electron/services/pgp-key-lookup';
import { PgpKeyStore } from '../../../../electron/services/pgp-key-store';
import {
  FAILED_LOOKUP_TTL_MS,
  NO_KEY_TTL_MS,
  PgpKeyring,
  PgpKeyringError,
} from '../../../../electron/services/pgp-keyring';
import type { Keychain } from '../../../../electron/services/pgp-secret-seal';

/**
 * The keyring's decisions. What this protects: a private key stored in the
 * clear on a keyring-less Linux box; a locked key silently dropping a send to
 * unsigned or unencrypted; a recipient's mail encrypted to an Autocrypt header
 * over a key the user imported; the Sent copy encrypted without the sender's
 * own key (unreadable to them forever); and lookups leaking addresses when the
 * settings could not be read.
 */
const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const fakeKeychain = (available = true): Keychain => ({
  isAvailable: () => available,
  encrypt: (text) => Buffer.from(text, 'utf8').reverse(),
  decrypt: (buf) => Buffer.from(buf).reverse().toString('utf8'),
});
const DEFAULT_PREFS: PgpPrefs = { wkdLookup: true, keyserverLookup: false, autoEncrypt: true };

let bob: GeneratedKey;
let bobNew: GeneratedKey;
let carol: GeneratedKey;

beforeAll(async () => {
  [bob, bobNew, carol] = await Promise.all([
    generateKeyPair({ name: 'Bob', email: 'bob@example.org' }),
    generateKeyPair({ name: 'Bob', email: 'bob@example.org' }),
    generateKeyPair({ name: 'Carol', email: 'carol@example.org' }),
  ]);
});

function setup(options: { keychain?: boolean; prefs?: () => PgpPrefs; lookup?: (email: string) => Promise<KeyLookupResult> } = {}) {
  const db = new Database(':memory:');
  const store = new PgpKeyStore(db);
  const clock = { now: T0 };
  const lookup = vi.fn(options.lookup ?? (async () => ({ key: null, failed: false })));
  const keychain = fakeKeychain(options.keychain ?? true);
  const deps = { store, keychain, lookup, prefs: options.prefs ?? (() => DEFAULT_PREFS), now: () => clock.now };
  return { store, clock, lookup, keyring: new PgpKeyring(deps), deps, db };
}

describe('own keys', () => {
  // Breaks: a generated key with a keychain was written in the clear, or not usable straight away.
  it('generates a keychain-sealed key that opens without a prompt', async () => {
    const { keyring, store } = setup();
    const summary = await keyring.generateOwnKey({ name: 'Me', email: 'Me@Example.org' });
    expect(summary).toMatchObject({ email: 'me@example.org', protection: 'keychain', unlocked: true, isPrivate: true, signByDefault: false });
    const row = store.getOwnKey(summary.fingerprint)!;
    expect(row.secret.toString('utf8').startsWith('ENC1:')).toBe(true);
    expect(row.secret.toString('utf8')).not.toContain('PRIVATE KEY');
    expect(row.addedAt).toBe(new Date(T0).toISOString());
    expect(await keyring.signingKeyFor('me@example.org')).not.toBeNull();
  });

  // Breaks: on Linux without a keyring a key was generated with no protection at all.
  it('requires a passphrase to generate without a keychain, and stores the key locked', async () => {
    const { keyring, store, deps } = setup({ keychain: false });
    expect(keyring.keychainAvailable()).toBe(false);
    await expect(keyring.generateOwnKey({ name: 'Me', email: 'me@example.org' })).rejects.toMatchObject({ code: 'passphrase-required' });
    const summary = await keyring.generateOwnKey({ name: 'Me', email: 'me@example.org', passphrase: 'pw' });
    expect(summary).toMatchObject({ protection: 'passphrase', isPassphraseProtected: true, unlocked: true });
    const stored = store.getOwnKey(summary.fingerprint)!.secret.toString('utf8');
    expect(stored.startsWith('LOCK1:')).toBe(true);
    expect((await inspectKey(stored.slice('LOCK1:'.length))).isPassphraseProtected).toBe(true);

    // A new session (fresh keyring over the same rows) starts locked.
    const next = new PgpKeyring(deps);
    expect((await next.listOwnKeys())[0].unlocked).toBe(false);
    await expect(next.signingKeyFor('me@example.org')).rejects.toMatchObject({ code: 'locked' });
    const opening = await next.openingKeys(null);
    expect(opening).toMatchObject({ decryptionKeys: [], lockedKeys: [expect.anything()] });
    await expect(next.unlockOwnKey(summary.fingerprint, 'wrong')).rejects.toThrow();
    await next.unlockOwnKey(summary.fingerprint, 'pw');
    expect((await next.listOwnKeys())[0].unlocked).toBe(true);
    expect((await next.openingKeys(null)).decryptionKeys).toHaveLength(1);
  });

  // Breaks: a protected import stayed prompting every session, or imported without its passphrase.
  it('imports a protected key once and re-seals it with the keychain', async () => {
    const { keyring, store } = setup();
    const locked = await protectPrivateKey(bob.armoredPrivateKey, 'secret');
    await expect(keyring.importOwnKey(locked)).rejects.toMatchObject({ code: 'passphrase-required' });
    await expect(keyring.importOwnKey(locked, 'nope')).rejects.toThrow();
    const [summary] = await keyring.importOwnKey(locked, 'secret');
    expect(summary).toMatchObject({ fingerprint: bob.info.fingerprint, protection: 'keychain', unlocked: true });
    expect(store.getOwnKey(bob.info.fingerprint)!.secret.toString('utf8').startsWith('ENC1:')).toBe(true);
  });

  // Breaks: a public key was accepted as the user's own key (nothing could be decrypted).
  it('rejects a public key as an own key', async () => {
    const { keyring } = setup();
    await expect(keyring.importOwnKey(bob.armoredPublicKey)).rejects.toMatchObject({ code: 'not-private' });
  });

  // Breaks: without a keychain an unprotected import was stored in the clear, or a protected one re-protected wrongly.
  it('without a keychain keeps imported keys passphrase-protected', async () => {
    const { keyring, store } = setup({ keychain: false });
    await expect(keyring.importOwnKey(bob.armoredPrivateKey)).rejects.toMatchObject({ code: 'passphrase-required' });
    await keyring.importOwnKey(bob.armoredPrivateKey, 'fresh');
    const protectedCopy = store.getOwnKey(bob.info.fingerprint)!.secret.toString('utf8').slice('LOCK1:'.length);
    expect((await inspectKey(protectedCopy)).isPassphraseProtected).toBe(true);

    const locked = await protectPrivateKey(carol.armoredPrivateKey, 'orig');
    await keyring.importOwnKey(locked, 'orig');
    expect(store.getOwnKey(carol.info.fingerprint)!.secret.toString('utf8')).toBe(`LOCK1:${locked}`);
  });

  // Breaks: re-importing a key reset the sign-by-default choice.
  it('keeps sign-by-default across a re-import', async () => {
    const { keyring } = setup();
    await keyring.importOwnKey(bob.armoredPrivateKey);
    expect(keyring.setSignByDefault(bob.info.fingerprint, true)).toBe(true);
    expect(await keyring.signsByDefault('bob@example.org')).toBe(true);
    await keyring.importOwnKey(bob.armoredPrivateKey);
    expect(await keyring.signsByDefault('BOB@example.org')).toBe(true);
    expect(await keyring.signsByDefault('nobody@example.org')).toBe(false);
  });

  // Breaks: a backup was written unprotected, or a locked key could be exported without unlocking.
  it('exports a passphrase-protected backup and the public key', async () => {
    const { keyring, deps } = setup({ keychain: false });
    const summary = await keyring.generateOwnKey({ name: 'Me', email: 'me@example.org', passphrase: 'pw' });
    await expect(keyring.exportOwnKey(summary.fingerprint, '')).rejects.toMatchObject({ code: 'passphrase-required' });
    const backup = await keyring.exportOwnKey(summary.fingerprint, 'backup-pw');
    expect((await inspectKey(backup)).isPassphraseProtected).toBe(true);
    expect(keyring.exportOwnPublicKey(summary.fingerprint)).toContain('PUBLIC KEY');
    await expect(new PgpKeyring(deps).exportOwnKey(summary.fingerprint, 'x')).rejects.toMatchObject({ code: 'locked' });
    expect(() => keyring.exportOwnPublicKey('NOPE')).toThrow(PgpKeyringError);
  });

  // Linux without a keyring (basic_text): a key sealed there before the app
  // could tell is only obfuscated, but still opens. The Encryption tab tells the
  // user to back it up and import the backup. Breaks: that advice leaves the
  // key keychain-sealed (still exposed), or loses its settings.
  it('re-protects a basic_text-sealed key with its backup passphrase on re-import', async () => {
    const { keyring, store, deps } = setup();
    const summary = await keyring.generateOwnKey({ name: 'Me', email: 'me@example.org' });
    keyring.setSignByDefault(summary.fingerprint, true);
    const basicText: Keychain = { ...fakeKeychain(false), canOpen: () => true };
    const later = new PgpKeyring({ ...deps, keychain: basicText });
    expect((await later.listOwnKeys())[0]).toMatchObject({ protection: 'keychain', unlocked: true });

    const backup = await later.exportOwnKey(summary.fingerprint, 'backup-pw');
    const [reimported] = await later.importOwnKey(backup, 'backup-pw');
    expect(reimported).toMatchObject({ fingerprint: summary.fingerprint, protection: 'passphrase', signByDefault: true });
    const secret = store.getOwnKey(summary.fingerprint)!.secret.toString('utf8');
    expect(secret.startsWith('LOCK1:')).toBe(true);
    expect((await inspectKey(secret.slice('LOCK1:'.length))).isPassphraseProtected).toBe(true);
  });

  // Breaks: a deleted key kept decrypting from the session cache.
  it('deletes a key from the store and from memory', async () => {
    const { keyring } = setup();
    const summary = await keyring.generateOwnKey({ name: 'Me', email: 'me@example.org' });
    expect(keyring.deleteOwnKey(summary.fingerprint)).toBe(true);
    expect(await keyring.listOwnKeys()).toEqual([]);
    expect(await keyring.signingKeyFor('me@example.org')).toBeNull();
    expect((await keyring.openingKeys(null)).decryptionKeys).toEqual([]);
    await expect(keyring.unlockOwnKey(summary.fingerprint, 'x')).rejects.toMatchObject({ code: 'not-found' });
  });

  // Breaks: unlocking a keychain key (no passphrase) errored instead of being a no-op.
  it('treats unlocking a keychain key as a no-op', async () => {
    const { keyring } = setup();
    const summary = await keyring.generateOwnKey({ name: 'Me', email: 'me@example.org' });
    await expect(keyring.unlockOwnKey(summary.fingerprint, 'anything')).resolves.toBeUndefined();
  });

  // Breaks: a keychain-sealed key read in a fresh session could not be opened.
  it('opens keychain keys lazily in a new session', async () => {
    const { keyring, deps } = setup();
    await keyring.generateOwnKey({ name: 'Me', email: 'me@example.org' });
    const next = new PgpKeyring(deps);
    expect((await next.openingKeys(null)).decryptionKeys).toHaveLength(1);
  });
});

describe('contact keys', () => {
  // Breaks: importing a correspondent's key did not make mail to them encryptable.
  it('imports public keys by hand, one row per address', async () => {
    const { keyring } = setup();
    const added = await keyring.importContactKeys(`${bob.armoredPublicKey}\n${carol.armoredPrivateKey}`);
    expect(added.map((key) => key.email).sort()).toEqual(['bob@example.org', 'carol@example.org']);
    expect(added.every((key) => key.source === 'manual' && !key.isPrivate)).toBe(true);
    expect(await keyring.listContactKeys()).toHaveLength(2);
    expect(keyring.deleteContactKey('bob@example.org', bob.info.fingerprint)).toBe(true);
  });

  const header = (key: GeneratedKey, addr = 'bob@example.org') =>
    readAnyKey(key.armoredPublicKey).then((parsed) =>
      buildAutocryptHeader({ addr, preferEncrypt: 'mutual', keydata: Buffer.from(parsed.write()) }),
    );

  // Breaks: anyone could plant a key for another address by naming it in their Autocrypt header.
  it('records an Autocrypt key only for the From address', async () => {
    const { keyring, store } = setup();
    const value = await header(bob);
    expect(await keyring.recordAutocrypt({ fromAddress: 'mallory@evil.example', header: value, sentAt: '2026-09-01T00:00:00.000Z' })).toBe(false);
    expect(await keyring.recordAutocrypt({ fromAddress: 'not a header', header: 'garbage', sentAt: '' })).toBe(false);
    expect(await keyring.recordAutocrypt({ fromAddress: 'Bob@Example.org', header: value, sentAt: '2026-09-01T00:00:00.000Z' })).toBe(true);
    expect(store.contactKeysFor('bob@example.org')[0]).toMatchObject({
      source: 'autocrypt',
      preferEncrypt: 'mutual',
      lastSeen: '2026-09-01T00:00:00.000Z',
    });
    // The same header again is remembered, not re-parsed or re-written.
    expect(await keyring.recordAutocrypt({ fromAddress: 'bob@example.org', header: value, sentAt: '2026-09-02T00:00:00.000Z' })).toBe(true);
    expect(store.contactKeysFor('bob@example.org')[0].lastSeen).toBe('2026-09-01T00:00:00.000Z');
  });

  // Breaks: a header whose keydata is not a key threw out of the sync pipeline.
  it('ignores Autocrypt keydata that is not a key', async () => {
    const { keyring } = setup();
    const value = buildAutocryptHeader({ addr: 'bob@example.org', preferEncrypt: 'mutual', keydata: Buffer.from('not a key') });
    expect(await keyring.recordAutocrypt({ fromAddress: 'bob@example.org', header: value, sentAt: '' })).toBe(false);
  });

  // Breaks: an Autocrypt header overrode the key the user imported by hand.
  it('prefers a manual key over a newer Autocrypt one', async () => {
    const { keyring } = setup();
    await keyring.importContactKeys(bob.armoredPublicKey);
    await keyring.recordAutocrypt({ fromAddress: 'bob@example.org', header: await header(bobNew), sentAt: '2026-09-01T00:00:00.000Z' });
    const [status] = await keyring.resolveRecipients(['bob@example.org'], { discover: false });
    expect(status).toMatchObject({ status: 'key', source: 'manual', fingerprint: bob.info.fingerprint });
  });

  // Breaks: of two Autocrypt keys, the stale one (seen earlier) was used after the sender rotated.
  it('uses the most recently seen Autocrypt key', async () => {
    const { keyring } = setup();
    await keyring.recordAutocrypt({ fromAddress: 'bob@example.org', header: await header(bobNew), sentAt: '2026-08-01T00:00:00.000Z' });
    await keyring.recordAutocrypt({ fromAddress: 'bob@example.org', header: await header(bob), sentAt: '2026-09-01T00:00:00.000Z' });
    const [status] = await keyring.resolveRecipients(['bob@example.org'], { discover: false });
    expect(status).toMatchObject({ source: 'autocrypt', fingerprint: bob.info.fingerprint });
  });
});

describe('recipients', () => {
  const discovered = (key: GeneratedKey): KeyLookupResult => ({
    key: { source: 'wkd', armoredPublicKey: key.armoredPublicKey, fingerprint: key.info.fingerprint },
    failed: false,
  });

  // Breaks: typing in the To field hit the network without being asked to discover.
  it('does not look anything up unless asked', async () => {
    const { keyring, lookup } = setup();
    expect(await keyring.resolveRecipients(['bob@example.org', 'BOB@example.org', ''], { discover: false })).toEqual([
      { email: 'bob@example.org', status: 'none' },
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });

  // Breaks: a discovered key was not stored, so every send looked it up again.
  it('discovers a key, stores it, and reports its source', async () => {
    const { keyring, lookup, store } = setup({ lookup: async () => discovered(bob) });
    const [status] = await keyring.resolveRecipients(['bob@example.org'], { discover: true });
    expect(status).toEqual({ email: 'bob@example.org', status: 'key', source: 'wkd', fingerprint: bob.info.fingerprint });
    expect(lookup).toHaveBeenCalledWith('bob@example.org', { wkd: true, keyserver: false });
    expect(store.contactKeysFor('bob@example.org')[0].source).toBe('wkd');
  });

  // Breaks: the user's own address was looked up on the network, or reported as keyless.
  it('resolves the user\'s own address from the own keyring', async () => {
    const { keyring, lookup } = setup();
    const summary = await keyring.generateOwnKey({ name: 'Me', email: 'me@example.org' });
    const [status] = await keyring.resolveRecipients(['me@example.org'], { discover: true });
    expect(status).toMatchObject({ status: 'key', source: 'own', fingerprint: summary.fingerprint });
    expect(lookup).not.toHaveBeenCalled();
  });

  // Breaks: an unreadable settings store let addresses leak to WKD / the keyserver.
  it('fails closed when the settings cannot be read, and skips lookups turned off', async () => {
    const unreadable = setup({
      prefs: () => {
        throw new Error('db locked');
      },
    });
    expect((await unreadable.keyring.resolveRecipients(['bob@example.org'], { discover: true }))[0].status).toBe('none');
    expect(unreadable.lookup).not.toHaveBeenCalled();

    const off = setup({ prefs: () => ({ wkdLookup: false, keyserverLookup: false, autoEncrypt: true }) });
    await off.keyring.resolveRecipients(['bob@example.org'], { discover: true });
    expect(off.lookup).not.toHaveBeenCalled();
  });

  // Breaks: every keystroke re-queried a server that already said "no key", or an outage was cached for an hour.
  it('remembers "no key" for an hour and a failed lookup for five minutes', async () => {
    const answers: KeyLookupResult[] = [{ key: null, failed: false }, { key: null, failed: true }, discovered(bob)];
    const { keyring, lookup, clock } = setup({ lookup: async () => answers.shift()! });
    await keyring.resolveRecipients(['bob@example.org'], { discover: true });
    await keyring.resolveRecipients(['bob@example.org'], { discover: true });
    expect(lookup).toHaveBeenCalledTimes(1);
    clock.now += NO_KEY_TTL_MS + 1;
    await keyring.resolveRecipients(['bob@example.org'], { discover: true });
    expect(lookup).toHaveBeenCalledTimes(2);
    clock.now += FAILED_LOOKUP_TTL_MS - 1;
    await keyring.resolveRecipients(['bob@example.org'], { discover: true });
    expect(lookup).toHaveBeenCalledTimes(2);
    clock.now += 2;
    expect((await keyring.resolveRecipients(['bob@example.org'], { discover: true }))[0].status).toBe('key');
  });

  // Breaks: importing a key after a "no key" answer still showed the recipient as keyless for an hour.
  it('an import clears the negative lookup memo', async () => {
    const { keyring, lookup } = setup();
    await keyring.resolveRecipients(['bob@example.org'], { discover: true });
    await keyring.importContactKeys(bob.armoredPublicKey);
    expect((await keyring.resolveRecipients(['bob@example.org'], { discover: true }))[0].status).toBe('key');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  // Breaks: the Sent copy was not encrypted to the sender (unreadable to them), or a keyless
  // recipient was silently dropped instead of blocking the send.
  it('encrypts to every recipient plus the sender, and lists who is missing', async () => {
    const { keyring } = setup();
    const me = await keyring.generateOwnKey({ name: 'Me', email: 'me@example.org' });
    await keyring.importContactKeys(bob.armoredPublicKey);
    const full = await keyring.encryptionKeysFor('me@example.org', ['Bob@example.org', 'bob@example.org']);
    expect(full.missing).toEqual([]);
    expect(full.keys.map((key) => key.getFingerprint().toUpperCase())).toEqual([bob.info.fingerprint, me.fingerprint]);
    const partial = await keyring.encryptionKeysFor('me@example.org', ['bob@example.org', 'carol@example.org']);
    expect(partial.missing).toEqual(['carol@example.org']);
    const noSelf = await keyring.encryptionKeysFor('other@example.org', ['me@example.org']);
    expect(noSelf.keys).toHaveLength(1);
  });

  // Breaks: a verifying reader lacked the sender's key, reporting every good signature as unknown.
  it('offers the sender\'s held keys for verification', async () => {
    const { keyring } = setup();
    await keyring.importContactKeys(bob.armoredPublicKey);
    expect((await keyring.openingKeys('bob@example.org')).verificationKeys).toHaveLength(1);
    expect((await keyring.openingKeys(null)).verificationKeys).toHaveLength(0);
  });
});
