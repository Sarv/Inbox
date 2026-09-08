import { describe, it, expect } from 'vitest';

import {
  describeNetworkError,
  extractOpFailureDetail,
  getSuggestedBackoffMs,
  isAuthError,
  isConnectionError,
  isConnectTimeoutError,
  isQuotaError,
  isRateLimited,
  isUpstreamError,
} from '../../../src/imap/imap-errors';

// These classifiers decide whether a failure is RETRIED, RECONNECTED, BACKED OFF
// or dead-lettered — every past misclassification here turned into either a
// reconnect storm or a pile of "Failed actions" for perfectly valid ops. So each
// test pins both what MUST match and what must NOT.

/** An error shaped like a real ImapFlow/undici rejection. */
function err(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe('isConnectionError', () => {
  // A dead socket must be reconnected, so every shape ImapFlow/Node use for one
  // has to be recognised — including the wrapper ImapFlow uses mid-command.
  it.each([
    'Connection ended unexpectedly',
    'Connection closed by server',
    'Not connected to IMAP server',
    'Connection not available', // ImapFlow NoConnection mid-command
    'socket hang up',
    'write EPIPE',
    'read ECONNRESET',
    'connect ECONNREFUSED 1.2.3.4:993',
    'connect ETIMEDOUT',
    'getaddrinfo ENOTFOUND imap.gmail.com',
    'getaddrinfo EAI_AGAIN imap.gmail.com',
    'connect EHOSTUNREACH',
    'connect ENETUNREACH',
    'ENETDOWN',
    'ENOTCONN',
    'fetch failed',
  ])('treats %s as a connection error', (message) => {
    expect(isConnectionError(err(message))).toBe(true);
  });

  // Our own withTimeout messages: a hung command means the CONNECTION is wedged,
  // so the op-queue must RE-QUEUE it instead of dead-lettering a valid move/read.
  it('treats our own op/connect timeouts as connection errors (re-queue, not dead-letter)', () => {
    expect(isConnectionError(err('IMAP STORE 3085 +FLAGS timed out after 60000ms'))).toBe(true);
    expect(isConnectionError(err('Health-check NOOP timeout'))).toBe(true);
  });

  // Regression: ImapFlow's connect-phase timeout ("... in required time") matched
  // NONE of the substrings below and no isTimeout flag, so it classified as
  // nothing — the pool's shared quota gate never engaged and the backfill drain
  // re-hammered the saturated Gmail cap. It IS a connection-establishment failure.
  it('treats ImapFlow connect-phase timeouts (post-toImapError, code rewritten) as connection errors', () => {
    // Shape after toImapError: code rewritten to CONNECTION_ERROR, message kept.
    expect(isConnectionError(err('Failed to establish connection in required time', { code: 'CONNECTION_ERROR' }))).toBe(true);
    // Raw ImapFlow shape (before wrapping), matched by code.
    expect(isConnectionError(err('Failed to upgrade connection in required time', { code: 'UPGRADE_TIMEOUT' }))).toBe(true);
    expect(isConnectionError(err('Failed to receive greeting from server in required time', { code: 'GREETING_TIMEOUT' }))).toBe(true);
  });

  // undici hides the real reason on .cause — without unwrapping it, every HTTP
  // network failure read as "unknown" and was retried with the wrong policy.
  it('unwraps error.cause (undici "fetch failed") to find the real network reason', () => {
    const cause = Object.assign(new Error('some inner failure'), { code: 'ECONNREFUSED' });
    // Neither the message nor the cause MESSAGE says ECONNREFUSED — only cause.code does.
    expect(isConnectionError(err('request to server failed', { cause }))).toBe(true);
    expect(isConnectionError(err('outer', { cause: 'read ECONNRESET' }))).toBe(true);
  });

  // A server NO/BAD is a COMMAND-level rejection: the socket is healthy. Poisoning
  // / reconnecting on these churns sockets in a tight retry loop.
  it.each([
    "Mailbox doesn't exist: Archive",
    'NO [TRYCREATE] no such mailbox',
    'Invalid credentials (Failure)',
    'Sync already in progress',
    'Too many simultaneous connections',
    'Command is not valid in this state',
  ])('does NOT treat %s as a connection error', (message) => {
    expect(isConnectionError(err(message))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isConnectionError('Connection ended')).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });
});

describe('isConnectTimeoutError', () => {
  // This is the classifier the pool's shared quota back-off checks: if it doesn't
  // recognise ImapFlow's connect-phase timeout, parkOnError returns NOT_PARKED,
  // the connect gate never closes, and the drain re-hammers the cap.
  it.each([
    ['CONNECT_TIMEOUT', 'Failed to establish connection in required time'],
    ['UPGRADE_TIMEOUT', 'Failed to upgrade connection in required time'],
    ['GREETING_TIMEOUT', 'Failed to receive greeting from server in required time'],
  ])('matches ImapFlow %s by code', (code, message) => {
    expect(isConnectTimeoutError(err(message, { code }))).toBe(true);
  });

  it('matches by the surviving "in required time" message when toImapError has rewritten the code', () => {
    // toImapError sets code=CONNECTION_ERROR and drops CONNECT_TIMEOUT; only the
    // message survives, so the message match is what actually fires in production.
    expect(isConnectTimeoutError(err('Failed to establish connection in required time', { code: 'CONNECTION_ERROR' }))).toBe(true);
  });

  it('does NOT match ordinary command/quota/blip failures', () => {
    // A quota rejection or a plain socket blip must NOT be treated as a connect
    // timeout — they have their own (escalating vs reconnect) handling.
    expect(isConnectTimeoutError(err('Too many simultaneous connections'))).toBe(false);
    expect(isConnectTimeoutError(err('read ECONNRESET'))).toBe(false);
    expect(isConnectTimeoutError(err('IMAP STORE timed out after 60000ms'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isConnectTimeoutError('in required time')).toBe(false);
    expect(isConnectTimeoutError(undefined)).toBe(false);
    expect(isConnectTimeoutError(null)).toBe(false);
  });
});

describe('isUpstreamError', () => {
  // The HTTP round-trip SUCCEEDED — a gateway just couldn't reach the backend.
  // Retry next cycle; do not treat as a dead socket.
  it('classifies 502/503/504 from the attached status', () => {
    expect(isUpstreamError(err('Bad Gateway', { status: 502 }))).toBe(true);
    expect(isUpstreamError(err('Service Unavailable', { status: 503 }))).toBe(true);
    expect(isUpstreamError(err('Gateway Timeout', { status: 504 }))).toBe(true);
  });

  it('falls back to the message/body when no status was attached', () => {
    expect(isUpstreamError(err('upstream said 503'))).toBe(true);
    expect(isUpstreamError(err('bad gateway'))).toBe(true);
    expect(isUpstreamError(err('boom', { responseText: 'Service Unavailable' }))).toBe(true);
  });

  it('does not fire on unrelated failures or non-Errors', () => {
    expect(isUpstreamError(err('Unauthorized', { status: 401 }))).toBe(false);
    expect(isUpstreamError(err('connect ECONNREFUSED'))).toBe(false);
    expect(isUpstreamError('503')).toBe(false);
  });
});

describe('isAuthError', () => {
  // Terminal: retrying re-hammers the server's brute-force lockout, which then
  // rejects even a CORRECT password. Must be recognised from every shape.
  it('classifies structured ImapFlow auth rejections', () => {
    expect(isAuthError(err('nope', { textCode: 'AUTHENTICATIONFAILED' }))).toBe(true);
    expect(isAuthError(err('nope', { source: 'authentication' }))).toBe(true);
  });

  it.each([
    'Invalid credentials (Failure)',
    'Authentication failed',
    'NO [AUTHENTICATIONFAILED] Invalid login',
    'LOGIN failed',
    'bad credentials',
    'Application-specific password required: use an App Password',
    // No agreeable SASL mechanism is just as terminal — retrying re-runs the
    // identical capability check, so the ladder must stop, not spin.
    'Unsupported authentication mechanism',
  ])('classifies %s as an auth error', (message) => {
    expect(isAuthError(err(message))).toBe(true);
  });

  // These are the misclassifications that mattered: a network blip or a quota
  // response must NOT latch "credentials rejected" and demand re-authentication.
  it.each([
    'Connection ended unexpectedly',
    'Too many simultaneous connections',
    'socket hang up',
    'Throttled, try again later',
  ])('does NOT classify %s as an auth error', (message) => {
    expect(isAuthError(err(message))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isAuthError({ textCode: 'AUTHENTICATIONFAILED' })).toBe(false);
  });

  // THE reconnect storm (2026-09-08). A connect that cannot MINT a bearer
  // because the OAuth session is revoked never reaches the server, so none of
  // the substrings above appear — and the ladder, seeing no auth error, dialled
  // forever, replaying a dead refresh token at the token endpoint hundreds of
  // times a minute. It is terminal in exactly the sense this latch exists for.
  it('classifies a revoked OAuth session as an auth error', () => {
    const revoked = Object.assign(
      new Error('Token refresh failed (400): {"detail":"Refresh token reuse detected. This session has been revoked for security; the user must sign in again."}'),
      { code: 'TOKEN_REFRESH_FAILED' },
    );
    expect(isAuthError(revoked)).toBe(true);
    expect(isAuthError(Object.assign(new Error('needs sign-in'), { code: 'REAUTH_REQUIRED' }))).toBe(true);
  });

  // The other half of the same rule, and the one that costs more if it breaks:
  // a refresh cut short by a closing lid or a network blip says NOTHING about
  // the credentials. Latching here would stop a sleeping laptop from ever
  // reconnecting until the user signed in again.
  it.each([
    'REFRESH_DEFERRED_SUSPENDED',
    'TOKEN_REFRESH_ABORTED',
    'TOKEN_REFRESH_TIMEOUT',
    'TOKEN_REFRESH_NETWORK_ERROR',
  ])('does NOT latch on a transient token failure (%s)', (code) => {
    expect(isAuthError(Object.assign(new Error('refresh did not complete'), { code }))).toBe(false);
  });

  // The OAuth branch consults a classifier that falls back to matching "(400)"
  // in the message. Non-OAuth errors must never reach it, or an IMAP command
  // failure carrying those digits would stop the ladder for good.
  it('does not read an unrelated error through the OAuth classifier', () => {
    expect(isAuthError(err('Command failed (400) BAD invalid arguments'))).toBe(false);
    expect(isAuthError(err('invalid_grant', { code: 'ETHROTTLE' }))).toBe(false);
  });
});

describe('isQuotaError', () => {
  // The worst possible reaction is an immediate retry (another connect against a
  // saturated cap), so this must win over the generic connection classifier.
  it.each([
    'Too many simultaneous connections',
    'Maximum number of connections from user+IP exceeded',
    'connection limit exceeded',
    'NO [OVERQUOTA] mailbox is full',
  ])('classifies %s as a quota error', (message) => {
    expect(isQuotaError(err(message))).toBe(true);
  });

  it('is DISJOINT from isConnectionError for the Gmail cap message (order-of-checks safety)', () => {
    const capped = err('Too many simultaneous connections');
    expect(isQuotaError(capped)).toBe(true);
    // If this ever became true, a quota response would be "reconnected" instead
    // of backed off — the exact loop that kept Gmail accounts locked out.
    expect(isConnectionError(capped)).toBe(false);
  });

  it('does not fire on a dropped socket or a non-Error', () => {
    expect(isQuotaError(err('Connection not available'))).toBe(false);
    expect(isQuotaError('too many simultaneous connections')).toBe(false);
  });
});

describe('isRateLimited / getSuggestedBackoffMs', () => {
  // ImapFlow rejects with ETHROTTLE + throttleReset; we honor the server's delay
  // instead of retrying blindly.
  it('classifies the ETHROTTLE code and throttle wording', () => {
    expect(isRateLimited(err('slow down', { code: 'ETHROTTLE' }))).toBe(true);
    expect(isRateLimited(err('Request throttled'))).toBe(true);
    expect(isRateLimited(err('please backoff'))).toBe(true);
    expect(isRateLimited(err('rate limit exceeded'))).toBe(true);
    expect(isRateLimited(err('Try again later'))).toBe(true);
  });

  it('does not fire on auth or plain socket failures', () => {
    expect(isRateLimited(err('Invalid credentials'))).toBe(false);
    expect(isRateLimited(err('socket hang up'))).toBe(false);
    expect(isRateLimited('throttled')).toBe(false);
  });

  it('reads the server-suggested backoff only when it is a positive number', () => {
    expect(getSuggestedBackoffMs(err('t', { throttleReset: 4500 }))).toBe(4500);
    expect(getSuggestedBackoffMs(err('t', { throttleReset: 0 }))).toBeNull();
    expect(getSuggestedBackoffMs(err('t', { throttleReset: -1 }))).toBeNull();
    expect(getSuggestedBackoffMs(err('t', { throttleReset: '5000' }))).toBeNull();
    expect(getSuggestedBackoffMs(err('t'))).toBeNull();
    expect(getSuggestedBackoffMs('t')).toBeNull();
  });
});

describe('extractOpFailureDetail', () => {
  // Powers the Outbox "Failed actions" list: message + the command WE sent + the
  // SERVER's reply. A connection failure has no command/reply — those must stay
  // undefined so the UI falls back to describing the op.
  it('splits a server NO/BAD into message, attempted command and server response', () => {
    const detail = extractOpFailureDetail(err('Command failed', {
      executedCommand: 'UID STORE 3085 +FLAGS (\\Seen)',
      responseStatus: 'NO',
      responseText: "[TRYCREATE] Mailbox doesn't exist",
    }));

    expect(detail).toEqual({
      message: 'Command failed',
      attemptedCommand: 'UID STORE 3085 +FLAGS (\\Seen)',
      serverResponse: "NO [TRYCREATE] Mailbox doesn't exist",
    });
  });

  it('leaves command/response undefined for a pure connection failure', () => {
    expect(extractOpFailureDetail(err('Connection not available'))).toEqual({
      message: 'Connection not available',
      attemptedCommand: undefined,
      serverResponse: undefined,
    });
  });

  it('falls back to serverResponse and stringifies non-Errors', () => {
    expect(extractOpFailureDetail(err('x', { serverResponse: 'BAD syntax' })).serverResponse).toBe('BAD syntax');
    expect(extractOpFailureDetail('kaput').message).toBe('kaput');
    expect(extractOpFailureDetail(undefined).message).toBe('undefined');
  });
});

describe('describeNetworkError', () => {
  // A bare "fetch failed" is undiagnosable; the reason lives on .cause.
  it('appends the underlying code + cause message', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    expect(describeNetworkError(err('fetch failed', { cause })))
      .toBe('fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:443)');
  });

  it('uses the error\'s own code when there is no cause', () => {
    expect(describeNetworkError(err('boom', { code: 'ETIMEDOUT' }))).toBe('boom (ETIMEDOUT)');
  });

  it('does not duplicate the message when the detail IS the message', () => {
    expect(describeNetworkError(err('ENOTFOUND', { code: 'ENOTFOUND' }))).toBe('ENOTFOUND');
    expect(describeNetworkError(err('plain failure'))).toBe('plain failure');
  });

  it('stringifies non-Error values', () => {
    expect(describeNetworkError('nope')).toBe('nope');
  });
});
