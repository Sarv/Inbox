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
  /** Set on `invalid`: always {@link PGP_SIGNATURE_FAILED_MESSAGE}, whatever the library said. */
  error?: string;
  /** The library's own reason for an `invalid` verdict — for the local log, never for the user. */
  detail?: string;
}

/**
 * What the user is told when decrypting a message fails — whatever the reason:
 * a session key that will not open, an integrity check that does not pass,
 * ciphertext that will not parse. One sentence for all of them (CASA 4.1.4):
 * a reply that differs by failure type tells whoever crafted the ciphertext
 * how far decryption got. The library's reason travels as `detail`, for the
 * local log only.
 *
 * Checks made BEFORE the cipher runs keep their own wording ("no-key",
 * "locked"): they are decided from key IDs alone and reveal nothing about it.
 */
export const PGP_DECRYPT_FAILED_MESSAGE = 'This message could not be decrypted. It may have been damaged or changed in transit.';

/** The same rule for a signature that does not verify or a signed block that will not parse. */
export const PGP_SIGNATURE_FAILED_MESSAGE = 'The signature could not be verified.';

/** An error's own text — the library's reason, for a log line or a `detail`, never for the user. */
export const pgpFailureDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  /** Structurally broken, not PGP at all, or the cipher failed (see PGP_DECRYPT_FAILED_MESSAGE). */
  | 'bad-data';

export class PgpOpenError extends Error {
  constructor(
    /** Safe to show: our own wording, never the library's. */
    message: string,
    readonly code: PgpOpenErrorCode,
    /** The library's reason, when it had one — for the local log only. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'PgpOpenError';
  }
}
