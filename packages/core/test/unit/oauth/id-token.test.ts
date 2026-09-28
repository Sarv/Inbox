import { describe, it, expect } from 'vitest';

import { decodeJwtPayload, userInfoFromIdToken } from '../../../src/oauth/id-token';
import { OAuthError } from '../../../src/oauth/types';

// Microsoft sign-in takes the user's email from the id_token (its IMAP access
// token can't call a userinfo API). That email becomes the IMAP/SMTP login and
// the account key, so a wrong or empty value means a mailbox that never
// authenticates, or two sign-ins colliding on one key.

const jwt = (payload: unknown): string =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('decodeJwtPayload', () => {
  // Refresh scheduling reads exp/iat through this; a decode regression means
  // tokens are refreshed by guesswork instead of their real lifetime.
  it('returns the claims object of a three-part JWT', () => {
    expect(decodeJwtPayload(jwt({ exp: 10, iat: 5 }))).toEqual({ exp: 10, iat: 5 });
  });

  // Opaque (non-JWT) tokens, e.g. Microsoft personal-account access tokens,
  // must read as "no claims", never throw out of the refresh scheduler.
  it('returns null for non-JWT, bad base64/JSON, and non-object payloads', () => {
    expect(decodeJwtPayload('opaque-token')).toBeNull();
    expect(decodeJwtPayload('a.b')).toBeNull();
    expect(decodeJwtPayload('h.%%%.s')).toBeNull();
    expect(decodeJwtPayload(`h.${Buffer.from('not json').toString('base64url')}.s`)).toBeNull();
    expect(decodeJwtPayload(jwt([1, 2]))).toBeNull();
    expect(decodeJwtPayload(jwt(null))).toBeNull();
    expect(decodeJwtPayload(jwt('str'))).toBeNull();
  });
});

describe('userInfoFromIdToken', () => {
  // Outlook.com / personal accounts carry `email`.
  it('uses the email claim and name', () => {
    expect(userInfoFromIdToken(jwt({ email: 'a@outlook.com', name: 'A', preferred_username: 'x@y.com' })))
      .toEqual({ email: 'a@outlook.com', name: 'A' });
  });

  // Many Microsoft 365 work accounts omit `email`; the UPN is the mailbox login.
  it('falls back to preferred_username when email is absent, blank or not an address', () => {
    expect(userInfoFromIdToken(jwt({ preferred_username: 'u@corp.com' }))).toEqual({ email: 'u@corp.com', name: undefined });
    expect(userInfoFromIdToken(jwt({ email: '  ', preferred_username: 'u@corp.com' })).email).toBe('u@corp.com');
    expect(userInfoFromIdToken(jwt({ email: 'nope', preferred_username: 'u@corp.com' })).email).toBe('u@corp.com');
  });

  // A phone-number or bare-username login must not become the IMAP user.
  it('throws USERINFO_NO_EMAIL when no claim is an email address', () => {
    const fn = () => userInfoFromIdToken(jwt({ preferred_username: '+15551234', email: 42 }));
    expect(fn).toThrow(OAuthError);
    expect(fn).toThrow(expect.objectContaining({ code: 'USERINFO_NO_EMAIL' }));
  });

  // A token response without (or with a garbled) id_token must fail the
  // sign-in loudly rather than store an account keyed on "undefined".
  it('throws USERINFO_FAILED for a missing or unreadable id_token', () => {
    expect(() => userInfoFromIdToken(undefined)).toThrow(expect.objectContaining({ code: 'USERINFO_FAILED' }));
    expect(() => userInfoFromIdToken('opaque')).toThrow(expect.objectContaining({ code: 'USERINFO_FAILED' }));
  });
});
