/**
 * How an own private key is kept at rest.
 *
 *   ENC1:<safeStorage bytes>   the armored, UNPROTECTED key, encrypted by the OS
 *                              keychain (macOS Keychain, Windows DPAPI, Linux
 *                              Secret Service). Opens without a prompt.
 *   LOCK1:<armored key>        the key as OpenPGP protects it itself, with a
 *                              passphrase. Used where there is no keychain —
 *                              Linux without a Secret Service — and opened once
 *                              per session with the user's passphrase.
 *
 * There is deliberately no PLAIN form. The credential vault falls back to a
 * marked plaintext blob when the keychain is missing; a private key must not,
 * because whoever copies the profile directory would then read the user's mail.
 */
import { safeStorage } from 'electron';

import { isOsBackedEncryption } from './os-encryption';
import type { OwnKeyProtection } from './pgp-key-store';

const MAGIC_KEYCHAIN = 'ENC1:';
const MAGIC_PASSPHRASE = 'LOCK1:';

/** The keychain operations sealing needs — injectable so tests run without Electron. */
export interface Keychain {
  /** A real OS key store protects what we seal now (never Linux `basic_text`). */
  isAvailable(): boolean;
  /**
   * Whether an EXISTING keychain envelope can be opened. Wider than
   * `isAvailable`: keys sealed under Linux `basic_text` before it stopped
   * counting as a keychain must keep opening. Defaults to `isAvailable`.
   */
  canOpen?(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(sealed: Buffer): string;
}

export const electronKeychain: Keychain = {
  // basic_text "encrypts" with a published key — sealing a private key with it
  // is the plaintext form this module refuses, so new keys take the
  // passphrase path there instead.
  isAvailable: () => isOsBackedEncryption(),
  canOpen: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (sealed) => safeStorage.decryptString(sealed),
};

export type SealedSecret =
  | { protection: 'keychain'; armoredPrivateKey: string }
  | { protection: 'passphrase'; armoredProtectedKey: string };

export class SealError extends Error {
  constructor(
    message: string,
    public readonly code: 'keychain-unavailable' | 'unknown-format',
  ) {
    super(message);
    this.name = 'SealError';
  }
}

/** Keychain-seal an UNPROTECTED armored key. Throws when there is no keychain. */
export function sealWithKeychain(keychain: Keychain, armoredPrivateKey: string): Buffer {
  if (!keychain.isAvailable()) throw new SealError('The OS keychain is not available', 'keychain-unavailable');
  return Buffer.concat([Buffer.from(MAGIC_KEYCHAIN, 'utf8'), keychain.encrypt(armoredPrivateKey)]);
}

/** Wrap an armored key that OpenPGP already protects with a passphrase. */
export function sealWithPassphrase(armoredProtectedKey: string): Buffer {
  return Buffer.from(MAGIC_PASSPHRASE + armoredProtectedKey, 'utf8');
}

const hasMagic = (sealed: Buffer, magic: string): boolean =>
  sealed.subarray(0, magic.length).toString('utf8') === magic;

/** Which protection an envelope uses, without opening it. */
export function protectionOf(sealed: Buffer): OwnKeyProtection {
  if (hasMagic(sealed, MAGIC_KEYCHAIN)) return 'keychain';
  if (hasMagic(sealed, MAGIC_PASSPHRASE)) return 'passphrase';
  throw new SealError('Unknown private-key envelope', 'unknown-format');
}

/**
 * Open an envelope. A keychain envelope needs the keychain; asking for one
 * without it (the profile moved to a machine without a Secret Service) THROWS
 * rather than reading as "no key" — an unreadable key and a missing key are
 * different facts, and only one of them may send the user to generate another.
 */
export function unseal(keychain: Keychain, sealed: Buffer): SealedSecret {
  if (protectionOf(sealed) === 'passphrase') {
    return { protection: 'passphrase', armoredProtectedKey: sealed.subarray(MAGIC_PASSPHRASE.length).toString('utf8') };
  }
  if (!(keychain.canOpen ? keychain.canOpen() : keychain.isAvailable())) {
    throw new SealError('This key is sealed by the OS keychain, which is not available', 'keychain-unavailable');
  }
  return { protection: 'keychain', armoredPrivateKey: keychain.decrypt(sealed.subarray(MAGIC_KEYCHAIN.length)) };
}
