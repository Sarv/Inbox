/**
 * What a user may read about an OpenPGP failure, and what only the log may.
 *
 * CASA 4.1.4: the user-facing message of a cryptographic failure is vague and
 * the same whatever went wrong, so whoever crafted a ciphertext or a key
 * learns nothing from the reply about how far the operation got.
 *
 * Our own typed errors are fixed sentences — "no key", "locked", "the keychain
 * is not available", PGP_DECRYPT_FAILED_MESSAGE — and keep their wording; the
 * library reason some of them carry (`detail`) is logged here, locally. Any
 * other error is the library's (or the platform's) own account of the failure:
 * it is logged, and the user reads `fallback` instead.
 *
 * Never pass an error whose text could hold plaintext or key material: what
 * is logged is the error's message as the library wrote it.
 */
import type { Logger } from '@sarvinbox/core';
import { PgpKeyError, PgpOpenError, pgpFailureDetail } from '@sarvinbox/core/pgp';

import { PgpKeyringError } from './pgp-keyring';
import { SealError } from './pgp-secret-seal';

type OwnPgpError = PgpOpenError | PgpKeyError | PgpKeyringError | SealError;

/** One of our own OpenPGP errors, whose message is ours and safe to show. */
export const isOwnPgpError = (error: unknown): error is OwnPgpError =>
  error instanceof PgpOpenError ||
  error instanceof PgpKeyError ||
  error instanceof PgpKeyringError ||
  error instanceof SealError;

/**
 * The text a user may read for `error`. Logs the library's reason under
 * `context` (one warn line, nothing when an own error carries no detail).
 */
export function pgpUserMessage(error: unknown, fallback: string, log: Pick<Logger, 'warn'>, context: string): string {
  if (isOwnPgpError(error)) {
    const detail = error instanceof PgpOpenError || error instanceof PgpKeyError ? error.detail : undefined;
    if (detail) log.warn(`${context}: ${detail}`);
    return error.message;
  }
  log.warn(`${context}: ${pgpFailureDetail(error)}`);
  return fallback;
}
