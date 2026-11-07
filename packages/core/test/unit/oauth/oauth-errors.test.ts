import { describe, it, expect } from 'vitest';

import {
  isOAuthServerUnreachableError,
  isOAuthTokenError,
  isTerminalOAuthError,
  oauthTokenErrorOf,
} from '../../../src/oauth/oauth-errors';
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

  // A bearer refused for the host it was about to be sent to. Breaks if
  // transient: the IMAP reconnect ladder redials the refused config forever.
  // Breaks if unrecognised: the auth latch never sees it at all.
  it('is terminal, and ours, for a token refused for its destination host', () => {
    expect(isTerminalOAuthError(new OAuthError('x', 'TOKEN_DESTINATION_REFUSED'))).toBe(true);
    expect(isTerminalOAuthError(coded('TOKEN_DESTINATION_REFUSED'))).toBe(true);
    expect(isOAuthTokenError(coded('TOKEN_DESTINATION_REFUSED'))).toBe(true);
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

  // A layer that re-throws a refresh failure under its own code (the IMAP
  // client's OAUTH_REFRESH_FAILED) is judged by the token error on its `cause`,
  // not by its own text. Breaks if the wrapper's text wins: the connect handler
  // misses a replayed REAUTH_REQUIRED whose reason carries no "(400)", or reads
  // a busy provider as a dead grant.
  const wrapped = (cause: unknown, message = 'OAuth token refresh failed') =>
    Object.assign(new Error(message), { code: 'OAUTH_REFRESH_FAILED', cause });

  it('judges a wrapped token error by its cause', () => {
    expect(isTerminalOAuthError(wrapped(new OAuthError('needs sign-in', 'REAUTH_REQUIRED')))).toBe(true);
    expect(isTerminalOAuthError(wrapped(coded('TOKEN_DESTINATION_REFUSED')))).toBe(true);
    expect(isTerminalOAuthError(wrapped(coded('TOKEN_REFRESH_TIMEOUT'), 'OAuth token refresh failed (400)'))).toBe(false);
    expect(isTerminalOAuthError(wrapped(coded('TOKEN_REFRESH_FAILED', 'Token refresh failed (503): unavailable')))).toBe(false);
  });

  // A wrapper with no token-layer cause keeps today's behaviour exactly.
  it('reads a wrapper without a token-layer cause as before', () => {
    expect(isTerminalOAuthError(wrapped(new Error('socket hang up'), 'Token refresh failed (400): invalid_grant'))).toBe(true);
    expect(isTerminalOAuthError(wrapped(undefined))).toBe(false);
  });
});

describe('oauthTokenErrorOf', () => {
  // The one place that decides which error a classifier should read. Breaks:
  // a wrapper hides the token layer's code and the auth latch never fires.
  it('returns a token error itself, or the token error a wrapper carries', () => {
    const own = coded('TOKEN_REFRESH_FAILED');
    expect(oauthTokenErrorOf(own)).toBe(own);
    expect(oauthTokenErrorOf(Object.assign(new Error('wrapped'), { cause: own }))).toBe(own);
  });

  // Only ONE level, and only a cause from the token layer. Breaks: an
  // arbitrary error chain is read through a classifier that matches "(400)".
  it('returns undefined for anything else', () => {
    expect(oauthTokenErrorOf(new Error('Command failed (400)'))).toBeUndefined();
    expect(oauthTokenErrorOf(Object.assign(new Error('wrapped'), { cause: new Error('socket hang up') }))).toBeUndefined();
    expect(oauthTokenErrorOf(Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('middle'), { cause: coded('REAUTH_REQUIRED') }),
    }))).toBeUndefined();
    expect(oauthTokenErrorOf(null)).toBeUndefined();
    expect(oauthTokenErrorOf(undefined)).toBeUndefined();
  });
});

/**
 * Separating "the server said no" from "we never reached the server".
 *
 * THE incident (2026-09-09): a dark-waking laptop retried refreshes before
 * Wi-Fi had reassociated. Every attempt failed with `getaddrinfo ENOTFOUND
 * oauth.sarv.com` — 81 in one session — and because the scheduler counted an
 * unreachable server as a transient FAILURE, five in a row latched a healthy
 * session into REAUTH_REQUIRED while the server was up and answering throughout.
 *
 * The scheduler routes on this predicate to decide whether a failure may count
 * toward that give-up threshold, so both edges matter: too broad and a genuinely
 * dead grant retries forever in silence; too narrow and a Wi-Fi blip signs the
 * user out again.
 */
describe('isOAuthServerUnreachableError', () => {
  // The exact shape the token-refresher throws when fetch cannot connect.
  it('recognises a token-endpoint network failure', () => {
    expect(isOAuthServerUnreachableError(
      new OAuthError('Cannot reach OAuth server [ENOTFOUND] at https://oauth.sarv.com/api/oauth/token',
        'TOKEN_REFRESH_NETWORK_ERROR'),
    )).toBe(true);
  });

  // These reached the server, or say something about the grant. Excusing them
  // from the failure budget would let a real problem retry forever unnoticed.
  it('does not claim errors the server actually answered', () => {
    expect(isOAuthServerUnreachableError(new OAuthError('bad grant', 'TOKEN_REFRESH_FAILED'))).toBe(false);
    expect(isOAuthServerUnreachableError(new OAuthError('nope', 'REAUTH_REQUIRED'))).toBe(false);
    expect(isOAuthServerUnreachableError(new OAuthError('gone', 'EMPTY_REFRESH_TOKEN'))).toBe(false);
  });

  // Timeout and abort are their own cases with their own handling (the request
  // may have been received, so the token state is unknown) — not unreachable.
  it('does not claim a timeout or an abort', () => {
    expect(isOAuthServerUnreachableError(new OAuthError('slow', 'TOKEN_REFRESH_TIMEOUT'))).toBe(false);
    expect(isOAuthServerUnreachableError(new OAuthError('cancelled', 'TOKEN_REFRESH_ABORTED'))).toBe(false);
  });

  // It keys on the CODE, never the text: a raw socket error that happens to
  // mention DNS must not be excused from the budget.
  it('keys on the code, not the message', () => {
    expect(isOAuthServerUnreachableError(new Error('getaddrinfo ENOTFOUND oauth.sarv.com'))).toBe(false);
    expect(isOAuthServerUnreachableError(new Error('TOKEN_REFRESH_NETWORK_ERROR'))).toBe(false);
  });

  // Unreachable is a strict SUBSET of non-terminal; the two must agree, or the
  // scheduler could both give up and excuse the same error.
  it('is never terminal', () => {
    const err = new OAuthError('unreachable', 'TOKEN_REFRESH_NETWORK_ERROR');
    expect(isOAuthServerUnreachableError(err)).toBe(true);
    expect(isTerminalOAuthError(err)).toBe(false);
  });

  it('survives a non-error value', () => {
    expect(isOAuthServerUnreachableError(null)).toBe(false);
    expect(isOAuthServerUnreachableError(undefined)).toBe(false);
    expect(isOAuthServerUnreachableError('TOKEN_REFRESH_NETWORK_ERROR')).toBe(false);
  });
});
