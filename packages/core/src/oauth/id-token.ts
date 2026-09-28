import { OAuthError, type OAuthUserInfo } from './types';

/**
 * Decode a JWT's payload WITHOUT verifying its signature. Returns null for
 * anything that isn't a three-part JWT with a JSON-object payload.
 *
 * Unverified decoding is only sound for tokens received directly from the
 * provider's token endpoint over TLS (OIDC Core §3.1.3.7 allows skipping
 * signature validation in that case) or for reading our own token's `exp`.
 * No JWT library: this is base64url + JSON.parse, and pulling one in only to
 * skip the part a library exists for (verification) buys nothing.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The signed-in user's identity from an OIDC id_token.
 *
 * `email` first, then `preferred_username`: Microsoft omits `email` for many
 * work/school accounts, where the UPN in `preferred_username` IS the mailbox
 * login. A value without an `@` is rejected — it would become the IMAP user.
 */
export function userInfoFromIdToken(idToken: string | undefined): OAuthUserInfo {
  if (!idToken) {
    throw new OAuthError('Token response missing id_token', 'USERINFO_FAILED');
  }
  const claims = decodeJwtPayload(idToken);
  if (!claims) {
    throw new OAuthError('id_token is not a readable JWT', 'USERINFO_FAILED');
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const email = [str(claims.email), str(claims.preferred_username)].find((v) => v?.includes('@'));
  if (!email) {
    throw new OAuthError('id_token has no email claim', 'USERINFO_NO_EMAIL');
  }
  return { email, name: str(claims.name) };
}
