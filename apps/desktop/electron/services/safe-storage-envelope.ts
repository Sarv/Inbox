/**
 * The at-rest envelope every main-process secret store uses.
 *
 *   ENC1:<safeStorage ciphertext>   sealed by the OS key store (Keychain, DPAPI,
 *                                   Secret Service / KWallet — or Linux
 *                                   `basic_text`, which is NOT protected at
 *                                   rest: see os-encryption.ts).
 *   PLAIN1:<utf-8 payload>          no safeStorage at all: a clearly MARKED
 *                                   plaintext fallback rather than silently
 *                                   dropping the secret.
 *
 * The single implementation of what the credential vault, AI key store, DB key
 * store, OAuth token store, last-good IMAP config and pipeline AI config each
 * used to hand-roll. The bytes are unchanged, so every existing store reads as
 * before. Callers keep their own failure semantics (some throw on an
 * unreadable blob, some degrade) and their own error wording, passed in here.
 */
import { safeStorage } from 'electron';

const MAGIC_ENC = 'ENC1:';
const MAGIC_PLAIN = 'PLAIN1:';

/** A store's own wording for the two ways opening can fail. */
export interface EnvelopeErrors {
  /** An ENC1 envelope while safeStorage can't decrypt (locked / missing keychain). */
  locked: string;
  /** Neither ENC1 nor PLAIN1. */
  unknownFormat: string;
}

const startsWith = (buf: Buffer, magic: string): boolean =>
  buf.subarray(0, magic.length).toString('utf8') === magic;

/** Seal a string: ENC1 when safeStorage can encrypt, else marked PLAIN1. */
export function sealString(payload: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return Buffer.concat([Buffer.from(MAGIC_ENC, 'utf8'), safeStorage.encryptString(payload)]);
  }
  return Buffer.from(MAGIC_PLAIN + payload, 'utf8');
}

/**
 * Open an envelope back to its string. THROWS — never returns empty — for an
 * ENC1 envelope safeStorage can't decrypt right now and for an unknown format:
 * an unreadable store and an empty one are different facts, and only the
 * caller knows which way to degrade.
 */
export function openString(buf: Buffer, errors: EnvelopeErrors): string {
  if (startsWith(buf, MAGIC_ENC)) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(errors.locked);
    return safeStorage.decryptString(buf.subarray(MAGIC_ENC.length));
  }
  if (startsWith(buf, MAGIC_PLAIN)) return buf.subarray(MAGIC_PLAIN.length).toString('utf8');
  throw new Error(errors.unknownFormat);
}

/** {@link sealString} of a JSON-serialisable value. */
export function sealJson(value: unknown): Buffer {
  return sealString(JSON.stringify(value));
}

/** {@link openString}, parsed as JSON. */
export function openJson<T>(buf: Buffer, errors: EnvelopeErrors): T {
  return JSON.parse(openString(buf, errors)) as T;
}

/** Whether a sealed buffer is the marked-plaintext form (for a caller's warning). */
export function isPlaintextEnvelope(buf: Buffer): boolean {
  return startsWith(buf, MAGIC_PLAIN);
}

/** Whether a sealed buffer is the safeStorage-encrypted form. */
export function isEncryptedEnvelope(buf: Buffer): boolean {
  return startsWith(buf, MAGIC_ENC);
}
