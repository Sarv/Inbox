// Shared OpenPGP shapes. Plain data only — safe to send over IPC and to import
// from the renderer, which never loads openpgp.js itself.

import type { PgpKind } from './mime-structure';

export type { PgpKind };

export interface PgpUserId {
  name: string;
  email: string;
}

export interface PgpKeyInfo {
  /** 40 upper-case hex characters. The identity of a key; key ids can collide. */
  fingerprint: string;
  keyId: string;
  userIds: PgpUserId[];
  /** Lower-cased, de-duplicated addresses from the user ids. */
  emails: string[];
  algorithm: string;
  /** UTC ISO-8601. */
  createdAt: string;
  expiresAt: string | null;
  isExpired: boolean;
  isRevoked: boolean;
  isPrivate: boolean;
  /** A private key still locked by its own passphrase. */
  isPassphraseProtected: boolean;
  canEncrypt: boolean;
  canSign: boolean;
}

/**
 * What an encrypted message's body reads as wherever plaintext is NOT allowed
 * to go: the local DB, full-text search, snippets, AI. Decryption happens on
 * view only.
 */
export const PGP_ENCRYPTED_PLACEHOLDER = 'Encrypted message';

/** Where a correspondent's public key came from — shown to the user, and the trust order. */
export type PgpKeySource = 'manual' | 'autocrypt' | 'wkd' | 'keyserver';

/**
 * - `valid`: a good signature from a key we hold.
 * - `invalid`: a signature that does not verify — the content was altered, or it is forged.
 * - `unknown-key`: signed, but by a key we do not have, so it cannot be checked.
 * - `none`: no signature at all.
 */
export type PgpSignatureStatus = 'valid' | 'invalid' | 'unknown-key' | 'none';

export interface PgpSignatureResult {
  status: PgpSignatureStatus;
  signerKeyId?: string;
  signerFingerprint?: string;
  /** Addresses on the signing key — the caller checks them against From. */
  signerEmails?: string[];
  /** UTC ISO-8601. */
  signedAt?: string;
  error?: string;
}

/** What opening a PGP message yields: MIME to parse, or bare text (inline PGP). */
export type PgpOpenedContent = { type: 'mime'; bytes: Buffer } | { type: 'text'; text: string };

export interface PgpOpenResult {
  kind: PgpKind;
  wasEncrypted: boolean;
  content: PgpOpenedContent;
  signature: PgpSignatureResult;
}

export type PgpOpenErrorCode =
  /** None of our private keys can decrypt it. */
  | 'no-key'
  /** The matching key is passphrase-protected and not unlocked this session. */
  | 'locked'
  /** Structurally broken or not PGP at all. */
  | 'bad-data';

export class PgpOpenError extends Error {
  constructor(
    message: string,
    readonly code: PgpOpenErrorCode,
  ) {
    super(message);
    this.name = 'PgpOpenError';
  }
}
