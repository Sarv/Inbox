import { describe, it, expect } from 'vitest';

import { isOAuthTokenError, isTerminalOAuthError } from '../../../src/oauth/oauth-errors';
import { OAuthError } from '../../../src/oauth/types';

/**
 * This classifier decides two things that used to be decided separately and
 * wrongly: whether the refresh scheduler gives up and asks the user to sign in,
 * and whether the IMAP reconnect ladder stops dialling. Getting it too EAGER
 * signs a user out over a closed laptop lid; too RELUCTANT and a revoked
 * session is replayed at the token endpoint hundreds of times a minute
 * (observed 2026-09-08). Every case below pins one of those two edges.
 */

/** An error carrying an OAuth code but NOT the OAuthError class — the shape an
 *  error takes after crossing the core/main-process bundle boundary. */
const coded = (code: string, message = 'boom'): Error =>
  Object.assign(new Error(message), { code });

describe('isOAuthTokenError', () => {
  // Recognition must not depend on `instanceof`: core and the Electron main
  // process are bundled separately, so the same logical OAuthError can be two
  // classes at runtime. If this regressed, the auth latch would silently never
  // fire and the reconnect storm would come straight back.
  it('recognises our errors by code, without the class', () => {
    expect(isOAuthTokenError(coded('TOKEN_REFRESH_FAILED'))).toBe(true);
    expect(isOAuthTokenError(coded('REAUTH_REQUIRED'))).toBe(true);
    expect(isOAuthTokenError(coded('REFRESH_DEFERRED_SUSPENDED'))).toBe(true);
  });

  it('recognises a real OAuthError instance', () => {
    expect(isOAuthTokenError(new OAuthError('nope', 'TOKEN_REFRESH_TIMEOUT'))).toBe(true);
  });

  // The guard exists so `isAuthError` can gate on it before consulting a
  // classifier that falls back to matching "(400)" in the message. An IMAP or
  // socket error carrying those digits must never be mistaken for ours.
  it('rejects errors from every other layer', () => {
    expect(isOAuthTokenError(coded('ETHROTTLE'))).toBe(false);
    expect(isOAuthTokenError(coded('ECONNRESET'))).toBe(false);
    expect(isOAuthTokenError(new Error('Command failed (400)'))).toBe(false);
    expect(isOAuthTokenError(null)).toBe(false);
    expect(isOAuthTokenError(undefined)).toBe(false);
    expect(isOAuthTokenError('TOKEN_REFRESH_FAILED')).toBe(false);
  });
});

describe('isTerminalOAuthError', () => {
  // A dead or absent credential: only an interactive sign-in fixes these, so
  // retrying is pure waste and — against a reuse detector — actively harmful.
  it('is terminal for a dead or missing credential', () => {
    expect(isTerminalOAuthError(new OAuthError('x', 'EMPTY_STORED_TOKEN'))).toBe(true);
    expect(isTerminalOAuthError(new OAuthError('x', 'EMPTY_REFRESH_TOKEN'))).toBe(true);
  });

  // The fast-fail gate REPLAYS an earlier terminal verdict. Were it classified
  // transient, the very gate that exists to stop the retry storm would be read
  // as "worth retrying" and would feed one.
  it('is terminal for the replayed re-auth requirement', () => {
    expect(isTerminalOAuthError(new OAuthError('x', 'REAUTH_REQUIRED'))).toBe(true);
    expect(isTerminalOAuthError(coded('REAUTH_REQUIRED'))).toBe(true);
  });

  // THE laptop-lid guarantee. A refresh we cut short or never started says
  // nothing about the credentials; marking it terminal signs the user out for
  // closing their laptop.
  it('is NOT terminal for a refresh that was deferred, aborted or timed out', () => {
    expect(isTerminalOAuthError(new OAuthError('x', 'REFRESH_DEFERRED_SUSPENDED'))).toBe(false);
    expect(isTerminalOAuthError(new OAuthError('x', 'TOKEN_REFRESH_ABORTED'))).toBe(false);
    expect(isTerminalOAuthError(new OAuthError('x', 'TOKEN_REFRESH_TIMEOUT'))).toBe(false);
    expect(isTerminalOAuthError(new OAuthError('x', 'TOKEN_REFRESH_NETWORK_ERROR'))).toBe(false);
  });

  // The code check must win over the message. These carry BOTH a transient
  // code and a "(400)"-shaped message; reading the message first would undo
  // the lid guarantee above.
  it('lets the code override a message that looks terminal', () => {
    const aborted = new OAuthError(
      'OAuth token request to https://oauth.sarv.com timed out (400)',
      'TOKEN_REFRESH_TIMEOUT',
    );
    expect(isTerminalOAuthError(aborted)).toBe(false);
  });

  // The real revoked-session rejection, verbatim from the incident log.
  it('is terminal for the provider rejecting the grant', () => {
    const revoked = new OAuthError(
      'Token refresh failed (400): {"detail":"Refresh token reuse detected. This session has been revoked for security; the user must sign in again."}',
      'TOKEN_REFRESH_FAILED',
    );
    expect(isTerminalOAuthError(revoked)).toBe(true);
    expect(isTerminalOAuthError(new Error('invalid_grant'))).toBe(true);
    expect(isTerminalOAuthError(new Error('unauthorized_client'))).toBe(true);
    expect(isTerminalOAuthError(new Error('Token refresh failed (401): no body'))).toBe(true);
  });

  // A 429 or 5xx is the server being busy, not the credential being dead —
  // giving up here would demand a sign-in for a rate limit.
  it('is NOT terminal for throttling or a server fault', () => {
    expect(isTerminalOAuthError(new Error('Token refresh failed (429): slow down'))).toBe(false);
    expect(isTerminalOAuthError(new Error('Token refresh failed (503): unavailable'))).toBe(false);
    expect(isTerminalOAuthError(new Error('Cannot reach OAuth server [ECONNREFUSED]'))).toBe(false);
  });

  // Reads the provider's raw body too — some responses put invalid_grant only
  // there, with a generic message.
  it('reads the provider body as well as the message', () => {
    const err = new OAuthError('Token refresh failed (200)', 'TOKEN_REFRESH_FAILED', '{"error":"invalid_grant"}');
    expect(isTerminalOAuthError(err)).toBe(true);
  });

  it('survives a non-error value', () => {
    expect(isTerminalOAuthError(null)).toBe(false);
    expect(isTerminalOAuthError(undefined)).toBe(false);
    expect(isTerminalOAuthError('invalid_grant')).toBe(false);
  });
});
