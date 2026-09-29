import * as openpgp from 'openpgp';
import { describe, expect, it } from 'vitest';

import {
  generateKeyPair,
  inspectKey,
  PgpKeyError,
  pickEncryptionKey,
  protectPrivateKey,
  publicKeyOf,
  readAllKeys,
  readAnyKey,
  readUnlockedPrivateKey,
  unlockPrivateKey,
} from '../../../src/pgp/keys';

describe('generateKeyPair', () => {
  // Breaks: a generated key must be usable for BOTH jobs straight away, keyed to
  // the lower-cased address the keyring looks up by.
  it('creates an unprotected signing + encryption key for the address', async () => {
    const generated = await generateKeyPair({ name: ' Ann ', email: ' Ann@Example.COM ' });
    expect(generated.info).toMatchObject({
      emails: ['ann@example.com'],
      userIds: [{ name: 'Ann', email: 'ann@example.com' }],
      isPrivate: true,
      isPassphraseProtected: false,
      canEncrypt: true,
      canSign: true,
      isRevoked: false,
      isExpired: false,
      expiresAt: null,
    });
    expect(generated.info.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    const publicInfo = await inspectKey(generated.armoredPublicKey);
    expect(publicInfo.fingerprint).toBe(generated.info.fingerprint);
    expect(publicInfo.isPrivate).toBe(false);
    expect(publicInfo.canSign).toBe(false);
  });

  // Breaks: the Linux-without-keyring path relies on a passphrase actually locking the key.
  it('locks the key when a passphrase is given', async () => {
    const generated = await generateKeyPair({ name: 'Ann', email: 'ann@example.com', passphrase: 'pw' });
    expect(generated.info.isPassphraseProtected).toBe(true);
  });
});

describe('unlock / protect', () => {
  // Breaks: a wrong passphrase must be a distinct, user-explainable error, and the right one must unlock.
  it('unlocks with the right passphrase and rejects the wrong one', async () => {
    const { armoredPrivateKey } = await generateKeyPair({ name: 'A', email: 'a@x.com', passphrase: 'right' });
    await expect(unlockPrivateKey(armoredPrivateKey, 'wrong')).rejects.toMatchObject({ code: 'bad-passphrase' });
    const unlocked = await unlockPrivateKey(armoredPrivateKey, 'right');
    expect((await inspectKey(unlocked)).isPassphraseProtected).toBe(false);
    // Unlocking an already-open key is a no-op, not an error.
    expect((await inspectKey(await unlockPrivateKey(unlocked, 'anything'))).isPassphraseProtected).toBe(false);
  });

  // Breaks: a backup export would be written without its passphrase.
  it('protects an open key and leaves an already-protected one alone', async () => {
    const { armoredPrivateKey } = await generateKeyPair({ name: 'A', email: 'a@x.com' });
    const locked = await protectPrivateKey(armoredPrivateKey, 'pw');
    expect((await inspectKey(locked)).isPassphraseProtected).toBe(true);
    expect((await inspectKey(await protectPrivateKey(locked, 'other'))).isPassphraseProtected).toBe(true);
    await expect(unlockPrivateKey(locked, 'pw')).resolves.toContain('PRIVATE KEY');
  });

  // Breaks: signing/decrypting with a locked key would throw deep inside openpgp with no useful message.
  it('refuses a locked key where an unlocked one is required', async () => {
    const { armoredPrivateKey } = await generateKeyPair({ name: 'A', email: 'a@x.com', passphrase: 'pw' });
    await expect(readUnlockedPrivateKey(armoredPrivateKey)).rejects.toMatchObject({ code: 'bad-passphrase' });
  });

  // Breaks: importing a PUBLIC key as "my key" must fail clearly, not later at send time.
  it('rejects a public key where a private one is required', async () => {
    const { armoredPublicKey } = await generateKeyPair({ name: 'A', email: 'a@x.com' });
    await expect(unlockPrivateKey(armoredPublicKey, 'x')).rejects.toMatchObject({ code: 'not-private' });
  });
});

describe('reading keys', () => {
  // Breaks: pasting junk into "import key" must surface a clear error, not a crash.
  it('reports unreadable input as bad-key', async () => {
    await expect(readAnyKey('not a key')).rejects.toBeInstanceOf(PgpKeyError);
    await expect(readAnyKey(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'bad-key' });
    await expect(readAllKeys('junk')).rejects.toMatchObject({ code: 'bad-key' });
  });

  // Breaks: WKD/Autocrypt deliver BINARY keys; those must read the same as armored ones.
  it('reads binary keys and multi-key blocks', async () => {
    const a = await generateKeyPair({ name: 'A', email: 'a@x.com' });
    const b = await generateKeyPair({ name: 'B', email: 'b@x.com' });
    const binary = (await readAnyKey(a.armoredPublicKey)).write();
    expect((await inspectKey(binary)).fingerprint).toBe(a.info.fingerprint);
    const both = [(await readAnyKey(a.armoredPublicKey)).write(), (await readAnyKey(b.armoredPublicKey)).write()];
    const combined = new Uint8Array([...both[0], ...both[1]]);
    expect((await readAllKeys(combined)).length).toBe(2);
    expect((await readAllKeys(`${a.armoredPublicKey}\n`)).length).toBe(1);
  });

  // Breaks: a key file of several armor blocks pasted together imported only the first key.
  it('reads every armor block in a pasted file, public and private alike', async () => {
    const a = await generateKeyPair({ name: 'A', email: 'a@x.com' });
    const b = await generateKeyPair({ name: 'B', email: 'b@x.com' });
    const keys = await readAllKeys(`Here are our keys:\n${a.armoredPublicKey}\n\n${b.armoredPrivateKey}\nthanks`);
    expect(keys.map((key) => [key.getFingerprint().toUpperCase(), key.isPrivate()])).toEqual([
      [a.info.fingerprint, false],
      [b.info.fingerprint, true],
    ]);
    await expect(readAllKeys(`${a.armoredPublicKey}\n-----BEGIN PGP PUBLIC KEY BLOCK-----\njunk`)).rejects.toMatchObject({
      code: 'bad-key',
    });
  });

  // Breaks: the public half we publish (Autocrypt, export) must not carry secret material.
  it('derives the public key from a private one', async () => {
    const a = await generateKeyPair({ name: 'A', email: 'a@x.com' });
    const publicArmored = await publicKeyOf(a.armoredPrivateKey);
    expect(publicArmored).toContain('PUBLIC KEY');
    expect((await inspectKey(publicArmored)).isPrivate).toBe(false);
  });
});

describe('pickEncryptionKey', () => {
  const keyFor = async (email: string, date?: Date) =>
    readAnyKey(
      (
        await openpgp.generateKey({
          type: 'ecc',
          curve: 'curve25519Legacy',
          userIDs: [{ email }],
          date,
          format: 'armored',
        })
      ).publicKey,
    );

  // Breaks: after a correspondent rotates keys we would keep encrypting to the old one.
  it('prefers the newest usable key for the address, case-insensitively', async () => {
    const old = await keyFor('bob@x.com', new Date('2024-01-01T00:00:00Z'));
    const fresh = await keyFor('bob@x.com', new Date('2026-01-01T00:00:00Z'));
    const other = await keyFor('carol@x.com');
    const picked = await pickEncryptionKey([old, other, fresh], 'Bob@X.com');
    expect(picked?.getFingerprint()).toBe(fresh.getFingerprint());
  });

  // Breaks: mail would be encrypted to a key its owner revoked (or to the wrong person).
  it('skips revoked keys and returns null when nothing fits', async () => {
    const { privateKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ email: 'bob@x.com' }],
      format: 'object',
    });
    const { publicKey: revoked } = await openpgp.revokeKey({ key: privateKey, format: 'object' });
    expect(await pickEncryptionKey([revoked], 'bob@x.com')).toBeNull();
    expect(await pickEncryptionKey([await keyFor('carol@x.com')], 'bob@x.com')).toBeNull();
  });

  // Breaks: an expired key must never be chosen — the recipient can no longer be expected to hold it.
  it('skips expired keys', async () => {
    const { publicKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ email: 'bob@x.com' }],
      date: new Date('2020-01-01T00:00:00Z'),
      keyExpirationTime: 60,
      format: 'object',
    });
    expect((await inspectKey(publicKey)).isExpired).toBe(true);
    expect(await pickEncryptionKey([publicKey], 'bob@x.com')).toBeNull();
  });
});
