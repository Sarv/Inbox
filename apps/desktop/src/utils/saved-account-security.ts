import { resolveConnectionSecurity, type ConnectionSecurity, type SecurityResolvable } from '@sarvinbox/core/connection-security';

type AccountRef = SecurityResolvable & { username?: string; host?: string };

/**
 * The connection security to show for main's last-good saved config
 * (imap:getSavedConfig). Files written before CASA M-5 carry no `security`, so
 * an account the user set to None reads back as just `secure: false` — which
 * now means STARTTLS REQUIRED, and its server refuses that. The renderer's own
 * record of the SAME account (same user and host) kept the explicit choice, so
 * it wins while the file has none. Anything else resolves the file as stored.
 */
export function savedAccountSecurity(saved: AccountRef, known: AccountRef | null | undefined): ConnectionSecurity {
  const sameAccount = !!known && known.username === saved.username && known.host === saved.host;
  if (saved.security === undefined && sameAccount && known.security !== undefined) {
    return resolveConnectionSecurity({ ...saved, security: known.security });
  }
  return resolveConnectionSecurity(saved);
}
