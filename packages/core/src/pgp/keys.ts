// OpenPGP key handling: generate, inspect, unlock, protect. Pure wrappers over
// openpgp.js — no storage, no I/O — so the keyring service that owns
// persistence can be tested against real keys without touching disk.

import * as openpgp from 'openpgp';

import type { PgpKeyInfo, PgpUserId } from './types';

export class PgpKeyError extends Error {
  constructor(
    message: string,
    readonly code: 'bad-key' | 'bad-passphrase' | 'not-private' | 'no-usable-key',
  ) {
    super(message);
    this.name = 'PgpKeyError';
  }
}

export interface GenerateKeyInput {
  name: string;
  email: string;
  /** Leave empty to create an unprotected key (the keychain protects it instead). */
  passphrase?: string;
}

export interface GeneratedKey {
  armoredPrivateKey: string;
  armoredPublicKey: string;
  info: PgpKeyInfo;
}

/**
 * A v4 Curve25519 key: signing primary + encryption subkey. v4 rather than the
 * newer RFC 9580 v6 format because v6 keys are still unreadable to much of the
 * installed base (older GnuPG, Mailvelope), and a key the other side cannot
 * import is a key nobody can encrypt to. No expiry: an expired key silently
 * stops working for correspondents, and revocation is the better control.
 */
export async function generateKeyPair(input: GenerateKeyInput): Promise<GeneratedKey> {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name: input.name.trim(), email: input.email.trim().toLowerCase() }],
    passphrase: input.passphrase || undefined,
    format: 'armored',
  });
  return {
    armoredPrivateKey: privateKey,
    armoredPublicKey: publicKey,
    info: await inspectKey(privateKey),
  };
}

/** Read one key from ASCII armor or binary. Throws `PgpKeyError('bad-key')`. */
export async function readAnyKey(source: string | Uint8Array): Promise<openpgp.Key> {
  try {
    return typeof source === 'string'
      ? await openpgp.readKey({ armoredKey: source })
      : await openpgp.readKey({ binaryKey: source });
  } catch (error) {
    throw new PgpKeyError(`Not a readable OpenPGP key: ${(error as Error).message}`, 'bad-key');
  }
}

const ARMOR_BEGIN = '-----BEGIN PGP ';

/**
 * Split text into its armor blocks. openpgp.js reads only the FIRST block of a
 * string, and a key file is often several exports pasted one after another.
 */
function armorBlocks(text: string): string[] {
  const starts: number[] = [];
  for (let at = text.indexOf(ARMOR_BEGIN); at >= 0; at = text.indexOf(ARMOR_BEGIN, at + 1)) starts.push(at);
  if (starts.length <= 1) return [text];
  return starts.map((start, index) => text.slice(start, starts[index + 1]));
}

/** Read every key: a keyring export may carry several per block, and a file several blocks. */
export async function readAllKeys(source: string | Uint8Array): Promise<openpgp.Key[]> {
  try {
    if (typeof source !== 'string') return await openpgp.readKeys({ binaryKeys: source });
    const perBlock = await Promise.all(armorBlocks(source).map((block) => openpgp.readKeys({ armoredKeys: block })));
    return perBlock.flat();
  } catch (error) {
    throw new PgpKeyError(`Not a readable OpenPGP key: ${(error as Error).message}`, 'bad-key');
  }
}

export async function inspectKey(source: string | Uint8Array | openpgp.Key): Promise<PgpKeyInfo> {
  const key = typeof source === 'object' && 'getFingerprint' in source ? source : await readAnyKey(source);
  const userIds = key.users
    .map((user) => user.userID)
    .filter((userId): userId is openpgp.UserIDPacket => userId !== null)
    .map((userId): PgpUserId => ({ name: userId.name ?? '', email: (userId.email ?? '').toLowerCase() }));
  const expiration = await key.getExpirationTime().catch(() => null);
  const expiresAt = expiration instanceof Date ? expiration.toISOString() : null;
  const isRevoked = await key.isRevoked().catch(() => false);
  return {
    fingerprint: key.getFingerprint().toUpperCase(),
    keyId: key.getKeyID().toHex().toUpperCase(),
    userIds,
    emails: [...new Set(userIds.map((userId) => userId.email).filter(Boolean))],
    algorithm: describeAlgorithm(key),
    createdAt: key.getCreationTime().toISOString(),
    expiresAt,
    isExpired: expiresAt !== null && Date.parse(expiresAt) <= Date.now(),
    isRevoked,
    isPrivate: key.isPrivate(),
    isPassphraseProtected: key.isPrivate() && !(key as openpgp.PrivateKey).isDecrypted(),
    canEncrypt: await hasUsableKey(() => key.getEncryptionKey()),
    canSign: key.isPrivate() ? await hasUsableKey(() => (key as openpgp.PrivateKey).getSigningKey()) : false,
  };
}

async function hasUsableKey(lookup: () => Promise<unknown>): Promise<boolean> {
  try {
    await lookup();
    return true;
  } catch {
    return false;
  }
}

function describeAlgorithm(key: openpgp.Key): string {
  const info = key.getAlgorithmInfo();
  if (info.curve) return `${info.algorithm} (${info.curve})`;
  return info.bits ? `${info.algorithm} ${info.bits}` : info.algorithm;
}

async function readPrivate(armored: string): Promise<openpgp.PrivateKey> {
  const key = await readAnyKey(armored);
  if (!key.isPrivate()) throw new PgpKeyError('This is a public key, not a private key', 'not-private');
  return key as openpgp.PrivateKey;
}

/** Remove the passphrase from a private key, returning it unprotected. */
export async function unlockPrivateKey(armored: string, passphrase: string): Promise<string> {
  const key = await readPrivate(armored);
  if (key.isDecrypted()) return key.armor();
  try {
    const unlocked = await openpgp.decryptKey({ privateKey: key, passphrase });
    return unlocked.armor();
  } catch {
    throw new PgpKeyError('Wrong passphrase for this key', 'bad-passphrase');
  }
}

/** Protect an unprotected private key with a passphrase (backups, Linux without a keyring). */
export async function protectPrivateKey(armored: string, passphrase: string): Promise<string> {
  const key = await readPrivate(armored);
  if (!key.isDecrypted()) return key.armor();
  const locked = await openpgp.encryptKey({ privateKey: key, passphrase });
  return locked.armor();
}

/** A private key ready for signing / decryption. Throws if it is still locked. */
export async function readUnlockedPrivateKey(armored: string): Promise<openpgp.PrivateKey> {
  const key = await readPrivate(armored);
  if (!key.isDecrypted()) throw new PgpKeyError('This key is locked by its passphrase', 'bad-passphrase');
  return key;
}

export async function publicKeyOf(armoredPrivate: string): Promise<string> {
  return (await readPrivate(armoredPrivate)).toPublic().armor();
}

/**
 * Of the keys that claim `email`, the one to encrypt to: not revoked, not
 * expired, with a usable encryption subkey — newest first, since a
 * correspondent who rotated keys wants the new one.
 */
export async function pickEncryptionKey(
  candidates: readonly openpgp.Key[],
  email: string,
): Promise<openpgp.Key | null> {
  const wanted = email.trim().toLowerCase();
  const usable = await Promise.all(
    candidates.map(async (key) => {
      const info = await inspectKey(key);
      const matches = info.emails.includes(wanted);
      return matches && info.canEncrypt && !info.isRevoked && !info.isExpired ? key : null;
    }),
  );
  const keys = usable.filter((key): key is openpgp.Key => key !== null);
  return keys.sort((a, b) => b.getCreationTime().getTime() - a.getCreationTime().getTime())[0] ?? null;
}
