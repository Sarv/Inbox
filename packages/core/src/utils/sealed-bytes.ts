import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

/**
 * Bytes sealed at rest: AES-256-GCM, Node's own implementation (no library
 * needed — the cipher IS the mature primitive; this only fixes the framing).
 *
 *   'SB1\0' (4) | IV (12, random per seal) | tag (16) | ciphertext
 *
 * `aad` binds the sealed bytes to where they belong (e.g. which email and
 * file name), so a sealed blob moved to another slot fails to open rather than
 * being served as the wrong content. Opening fails on any change to the bytes,
 * the key or the aad — never returns partial or wrong plaintext.
 */

const MAGIC = Buffer.from('SB1\0', 'latin1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Size added to the plaintext by sealBytes. */
export const SEALED_BYTES_OVERHEAD = MAGIC.length + IV_BYTES + TAG_BYTES;

/** Whether `data` starts like sealBytes output (not proof it opens). */
export function isSealedBytes(data: Buffer): boolean {
  return data.length >= SEALED_BYTES_OVERHEAD && data.subarray(0, MAGIC.length).equals(MAGIC);
}

export function sealBytes(key: Buffer, plaintext: Buffer, aad = ''): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

/** @throws when the blob is not sealed, or was sealed with another key or aad, or was altered. */
export function openSealedBytes(key: Buffer, sealed: Buffer, aad = ''): Buffer {
  if (!isSealedBytes(sealed)) {
    throw new Error('Not sealed data');
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(MAGIC.length + IV_BYTES, SEALED_BYTES_OVERHEAD);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(SEALED_BYTES_OVERHEAD)), decipher.final()]);
}

/**
 * A 32-byte key for one purpose, derived from a longer-lived secret (HKDF-SHA256),
 * so one root key can protect several stores without any two sharing a key.
 */
export function deriveSubkey(secret: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(purpose, 'utf8'), 32));
}
