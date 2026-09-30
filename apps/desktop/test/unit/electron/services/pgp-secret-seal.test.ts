import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((text: string) => Buffer.from(`sealed(${text})`)),
    decryptString: vi.fn((buf: Buffer) => buf.toString().replace(/^sealed\(|\)$/g, '')),
  },
}));
vi.mock('electron', () => ({ safeStorage: h.safeStorage }));

import {
  SealError,
  electronKeychain,
  protectionOf,
  sealWithKeychain,
  sealWithPassphrase,
  unseal,
  type Keychain,
} from '../../../../electron/services/pgp-secret-seal';

/**
 * Private keys at rest. What this protects: a key written in the clear on a
 * machine without a keychain (whoever copies the profile reads the mail), or
 * a keychain-sealed key read on a machine without one looking like "no key",
 * which would send the user off to generate a replacement.
 */
const fakeKeychain = (available = true): Keychain => ({
  isAvailable: () => available,
  encrypt: (text) => Buffer.from(text.split('').reverse().join('')),
  decrypt: (buf) => buf.toString().split('').reverse().join(''),
});

describe('pgp secret seal', () => {
  // Breaks: a keychain-sealed key could not be opened again, or its bytes were stored unencrypted.
  it('round-trips a keychain envelope, which does not contain the key in the clear', () => {
    const sealed = sealWithKeychain(fakeKeychain(), 'SECRET-KEY');
    expect(sealed.toString()).not.toContain('SECRET-KEY');
    expect(protectionOf(sealed)).toBe('keychain');
    expect(unseal(fakeKeychain(), sealed)).toEqual({ protection: 'keychain', armoredPrivateKey: 'SECRET-KEY' });
  });

  // Breaks: without a keychain the key would be written in the clear.
  it('refuses to seal with a keychain that is not there', () => {
    expect(() => sealWithKeychain(fakeKeychain(false), 'K')).toThrow(SealError);
  });

  // Breaks: a keychain-sealed key on a keyring-less machine read as "no key" instead of failing loudly.
  it('throws keychain-unavailable when opening a keychain envelope without one', () => {
    const sealed = sealWithKeychain(fakeKeychain(), 'K');
    try {
      unseal(fakeKeychain(false), sealed);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'keychain-unavailable' });
    }
  });

  // Breaks: the Linux-no-keyring path could not store or reopen its passphrase-protected key.
  it('round-trips a passphrase envelope with or without a keychain', () => {
    const sealed = sealWithPassphrase('-----BEGIN PGP PRIVATE KEY BLOCK-----');
    expect(protectionOf(sealed)).toBe('passphrase');
    expect(unseal(fakeKeychain(false), sealed)).toEqual({
      protection: 'passphrase',
      armoredProtectedKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    });
  });

  // Breaks: a corrupt or foreign blob was treated as one of our envelopes.
  it('rejects an unknown envelope', () => {
    expect(() => protectionOf(Buffer.from('PLAIN:key'))).toThrow(/Unknown/);
    expect(() => unseal(fakeKeychain(), Buffer.from(''))).toThrow(SealError);
  });

  // Breaks: the production keychain was not wired to Electron's safeStorage.
  it('electronKeychain delegates to safeStorage', () => {
    expect(electronKeychain.isAvailable()).toBe(true);
    const sealed = electronKeychain.encrypt('abc');
    expect(electronKeychain.decrypt(sealed)).toBe('abc');
    expect(h.safeStorage.encryptString).toHaveBeenCalledWith('abc');
  });
});
