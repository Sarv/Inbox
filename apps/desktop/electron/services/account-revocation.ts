/**
 * What removing an account did about its sign-in grant at the provider — what
 * `accounts:remove` reports, so Settings can tell the user whether anything is
 * left for them to do (CASA audit I-6). Google and Sarv let an app revoke its own
 * access; for the others the tokens are deleted from this device and that is
 * all an app can do.
 */
import { createLogger, getOAuthProvider, withTimeout, type OAuthProviderId, type RevokeOutcome } from '@sarvinbox/core';

const logger = createLogger('account-revocation');

export type AccountRevocation =
  /** The provider confirmed, or the grant was already gone there. */
  | 'revoked'
  /**
   * Revocation did not complete — offline, a timeout, an error answer — or no
   * token was left on this device to revoke with. The grant may still be live.
   */
  | 'failed'
  /** The provider offers apps no way to revoke their own access (Microsoft, Yahoo). */
  | 'unsupported'
  /** Not attempted: another account still uses the grant, or the account list could not be read. */
  | 'skipped';

/** How long removal waits for the provider before reporting 'failed'. */
export const REVOCATION_WAIT_MS = 10_000;

/**
 * Wait (at most `ms`) for a sign-out's revocation and say what happened. Never
 * rejects: the account is already removed locally whatever the provider does.
 */
export async function settleRevocation(
  provider: OAuthProviderId,
  revocation: Promise<RevokeOutcome | 'no-account'>,
  ms: number = REVOCATION_WAIT_MS,
): Promise<AccountRevocation> {
  let outcome: RevokeOutcome | 'no-account';
  try {
    outcome = await withTimeout(revocation, ms, `no answer from ${provider} within ${Math.round(ms / 1000)}s`);
  } catch (error) {
    logger.warn(`[Accounts] ${provider} revocation after removal did not complete: ${(error as Error)?.message}`);
    return 'failed';
  }
  switch (outcome) {
    case 'revoked':
    case 'already-invalid':
      return 'revoked';
    case 'unsupported':
      return 'unsupported';
    case 'no-account':
      // Nothing on this device to revoke with. Where the provider supports
      // revocation the grant may still be live, so the user must be told.
      return revocationSupported(provider) ? 'failed' : 'unsupported';
    default:
      return 'failed';
  }
}

function revocationSupported(provider: OAuthProviderId): boolean {
  try {
    return !!getOAuthProvider(provider).revokeEndpoint;
  } catch {
    return false;
  }
}
