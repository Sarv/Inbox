import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  exchangeCodeForTokens,
  refreshAccessToken,
  TOKEN_EXCHANGE_TIMEOUT_MS,
  TOKEN_REQUEST_TIMEOUT_MS,
} from '../../../src/oauth/token-refresher';
import { OAuthError } from '../../../src/oauth/types';
import type { OAuthProviderConfig } from '../../../src/oauth/types';

// This module is the single point every signed-in account passes through on
// every token expiry. A regression here logs EVERY user out: a wrong
// Content-Type or a missing grant_type turns into invalid_request, a blanked
// refresh_token means the next refresh has nothing to send, and collapsing a
// 5xx/network blip into a terminal auth failure would wipe credentials that
// were actually still valid. All fetches are stubbed — no real network.

const FORM_PROVIDER: OAuthProviderConfig = {
  id: 'gmail',
  label: 'Gmail',
  purpose: 'email',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  scopes: ['https://mail.google.com/'],
  tokenBodyFormat: 'form',
};

// Sarv: OAuth 2.1 public client — JSON body, PKCE, NO client_secret.
const JSON_PROVIDER: OAuthProviderConfig = {
  id: 'sarv',
  label: 'Sarv',
  purpose: 'both',
  clientId: 'client_Z6sj',
  clientSecret: undefined,
  authEndpoint: 'https://oauth.sarv.com/api/oauth/authorize',
  tokenEndpoint: 'https://oauth.sarv.com/api/oauth/token',
  userInfoEndpoint: 'https://oauth.sarv.com/api/oauth/userinfo',
  scopes: ['openid', 'email:read'],
  tokenBodyFormat: 'json',
};

function okJson(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => payload),
    text: vi.fn(async () => JSON.stringify(payload)),
  } as unknown as Response;
}

function errorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    json: vi.fn(async () => JSON.parse(body)),
    text: vi.fn(async () => body),
  } as unknown as Response;
}

/** The single fetch stub; returns [url, init] of the one call that was made. */
function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: init.body as string };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // The module logs failures via the shared logger (console.error under the
  // hood); silence it so an expected-failure test doesn't look like a crash.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('refreshAccessToken — request shape', () => {
  // RFC 6749 §6: form-encoded body with grant_type=refresh_token. Google rejects
  // anything else, and it must include client_secret for a Desktop-app client.
  it("form format posts x-www-form-urlencoded grant_type=refresh_token with client_id AND client_secret", async () => {
    fetchMock.mockResolvedValue(okJson({ access_token: 'new', expires_in: 3599, token_type: 'Bearer' }));

    await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt-1' });

    const { url, init, headers, body } = lastCall(fetchMock);
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-abc',
      refresh_token: 'rt-1',
      client_secret: 'secret-xyz',
    });
  });

  // Sarv's OAuth 2.1 server accepts JSON; sending form-encoded there (or JSON
  // without the Content-Type) is a 400 invalid_request on every refresh.
  it('json format posts application/json + Accept: application/json', async () => {
    fetchMock.mockResolvedValue(okJson({ access_token: 'new', expires_in: 900, token_type: 'Bearer' }));

    await refreshAccessToken({ provider: JSON_PROVIDER, refreshToken: 'rt-2' });

    const { url, headers, body } = lastCall(fetchMock);
    expect(url).toBe('https://oauth.sarv.com/api/oauth/token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
    expect(JSON.parse(body)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client_Z6sj',
      refresh_token: 'rt-2',
    });
  });

  // A public client must NOT send the key at all — an empty-string
  // client_secret is treated as a bad secret and rejected with invalid_client.
  it('OMITS client_secret entirely when the provider has none (public client)', async () => {
    fetchMock.mockResolvedValue(okJson({ access_token: 'new', expires_in: 900, token_type: 'Bearer' }));

    await refreshAccessToken({ provider: JSON_PROVIDER, refreshToken: 'rt' });

    expect(Object.keys(JSON.parse(lastCall(fetchMock).body))).not.toContain('client_secret');
  });

  it('treats an empty-string client_secret as absent rather than sending client_secret=', async () => {
    fetchMock.mockResolvedValue(okJson({ access_token: 'new', expires_in: 900, token_type: 'Bearer' }));

    await refreshAccessToken({ provider: { ...FORM_PROVIDER, clientSecret: '' }, refreshToken: 'rt' });

    expect(new URLSearchParams(lastCall(fetchMock).body).has('client_secret')).toBe(false);
  });

  // tokenBodyFormat is optional and 'form' is the documented default; an
  // undefined value must not silently fall through to JSON.
  it('defaults to form encoding when tokenBodyFormat is unset', async () => {
    fetchMock.mockResolvedValue(okJson({ access_token: 'new', expires_in: 900, token_type: 'Bearer' }));

    await refreshAccessToken({ provider: { ...FORM_PROVIDER, tokenBodyFormat: undefined }, refreshToken: 'rt' });

    const { headers, body } = lastCall(fetchMock);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(body).get('grant_type')).toBe('refresh_token');
  });

  // Refresh tokens routinely contain '/', '+' and '=' — form encoding must
  // escape them, otherwise the server receives a truncated/garbled token.
  it('percent-encodes a refresh token containing form-hostile characters', async () => {
    fetchMock.mockResolvedValue(okJson({ access_token: 'new', expires_in: 900, token_type: 'Bearer' }));
    const gnarly = 'a/b+c=d&e f';

    await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: gnarly });

    const { body } = lastCall(fetchMock);
    expect(body).toContain('refresh_token=a%2Fb%2Bc%3Dd%26e+f');
    expect(new URLSearchParams(body).get('refresh_token')).toBe(gnarly); // round-trips intact
  });
});

describe('refreshAccessToken — success payloads', () => {
  it('returns the new access token and its lifetime', async () => {
    fetchMock.mockResolvedValue(
      okJson({ access_token: 'at-new', refresh_token: 'rt-same', expires_in: 3599, token_type: 'Bearer', scope: 'a b' }),
    );

    const res = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt-same' });

    expect(res).toEqual({
      access_token: 'at-new',
      refresh_token: 'rt-same',
      expires_in: 3599,
      token_type: 'Bearer',
      scope: 'a b',
    });
  });

  // Google AND Sarv omit refresh_token on a refresh grant. The response must
  // report "absent" (undefined / key missing) — never an empty string — so the
  // caller keeps the stored one instead of persisting a blank and permanently
  // un-refreshable account.
  it('reports an ABSENT refresh_token (not "") when the provider omits it — caller must reuse the old one', async () => {
    fetchMock.mockResolvedValue(okJson({ access_token: 'at-new', expires_in: 3599, token_type: 'Bearer' }));

    const res = await refreshAccessToken({ provider: JSON_PROVIDER, refreshToken: 'rt-stored' });

    expect(res.refresh_token).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(res, 'refresh_token')).toBe(false);
    expect(res.access_token).toBe('at-new');
    // Nothing in the response may be mistaken for a real (blank) rotation.
    expect(res.refresh_token ?? 'rt-stored').toBe('rt-stored');
  });

  // Rotating servers (OAuth 2.1 recommends it) return a NEW refresh_token that
  // MUST be persisted — dropping it means the old one is already revoked.
  it('surfaces a rotated refresh_token distinct from the one sent', async () => {
    fetchMock.mockResolvedValue(
      okJson({ access_token: 'at-new', refresh_token: 'rt-ROTATED', expires_in: 900, token_type: 'Bearer' }),
    );

    const res = await refreshAccessToken({ provider: JSON_PROVIDER, refreshToken: 'rt-old' });

    expect(res.refresh_token).toBe('rt-ROTATED');
    expect(res.refresh_token).not.toBe('rt-old');
  });

  // KNOWN GAP (documented, not endorsed): a 200 whose access_token is empty or
  // whitespace is passed straight through — this module does no validation, so
  // the *caller* is responsible for rejecting it before it is stored and used
  // as "user=…\x01auth=Bearer \x01\x01". Pinned here so anyone adding
  // validation sees which contract they are changing.
  // A 200 carrying an empty/whitespace access_token must NOT be handed back: the
  // caller would persist it and then send `auth=Bearer \x01\x01`, which the mail
  // server answers with AUTHENTICATIONFAILED — indistinguishable from an expired
  // token, so the app re-login-loops instead of surfacing the real server fault.
  it('rejects a 200 whose access_token is empty or whitespace', async () => {
    for (const token of ['', '   ']) {
      fetchMock.mockResolvedValue(okJson({ access_token: token, expires_in: 3599, token_type: 'Bearer' }));
      const err = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt' }).catch((e) => e);
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.code).toBe('TOKEN_REFRESH_EMPTY_ACCESS_TOKEN');
    }
  });

  // Same for a response with no access_token field at all.
  it('rejects a 200 with no access_token field', async () => {
    fetchMock.mockResolvedValue(okJson({ expires_in: 3599, token_type: 'Bearer' }));
    const err = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt' }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_EMPTY_ACCESS_TOKEN');
  });
});

describe('refreshAccessToken — terminal auth failures', () => {
  // invalid_grant means the refresh token is dead (revoked / password changed):
  // the body must reach the UI verbatim, otherwise the user only sees "400" and
  // there is no way to tell "re-login" from "server hiccup".
  it('400 invalid_grant → OAuthError carrying the server body in message AND detail', async () => {
    const body = '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}';
    fetchMock.mockResolvedValue(errorResponse(400, body));

    const err = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt-dead' }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_FAILED');
    expect(err.detail).toBe(body); // raw response preserved for the renderer
    expect(err.message).toContain('400');
    expect(err.message).toContain('invalid_grant');
  });

  it('401 invalid_client → OAuthError carrying the server body (misconfigured client, not a dead token)', async () => {
    const body = '{"error":"invalid_client","error_description":"The OAuth client was not found."}';
    fetchMock.mockResolvedValue(errorResponse(401, body));

    const err = await refreshAccessToken({ provider: JSON_PROVIDER, refreshToken: 'rt' }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_FAILED');
    expect(err.detail).toBe(body);
    expect(err.message).toContain('invalid_client');
  });

  // An unreadable error body must not turn into a confusing "Token refresh
  // failed (400): " with a dangling colon, and must never throw a second error
  // over the first (res.text() rejecting is swallowed by design).
  it('falls back to "no body" when the error body cannot be read', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn(async () => {
        throw new Error('stream already consumed');
      }),
    } as unknown as Response);

    const err = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt' }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.message).toBe('Token refresh failed (400): no body');
    expect(err.detail).toBe('');
  });

  it('an empty error body also reports "no body" rather than an empty tail', async () => {
    fetchMock.mockResolvedValue(errorResponse(403, ''));

    const err = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt' }).catch((e) => e);

    expect(err.message).toBe('Token refresh failed (403): no body');
  });
});

describe('refreshAccessToken — retryable vs terminal', () => {
  // A 5xx is the provider being unwell. It arrives as TOKEN_REFRESH_FAILED with
  // the status in the message, so a caller CAN retry it — but it must never be
  // reported with the network code, and never as invalid_grant.
  it('5xx surfaces the status so it is not mistaken for a dead refresh token', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'upstream unavailable'));

    const err = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt' }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_FAILED');
    expect(err.code).not.toBe('TOKEN_REFRESH_NETWORK_ERROR');
    expect(err.message).toContain('503');
    expect(err.message).toContain('upstream unavailable');
    expect(err.message).not.toContain('invalid_grant');
  });

  // A thrown fetch (offline, DNS, ECONNREFUSED) is NOT an auth failure: it must
  // get its own code so credentials are never wiped, and it must name the host
  // + cause code, otherwise undici's bare "fetch failed" is undiagnosable.
  it('a network throw gets its own code and names the endpoint + cause', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8880' },
    });
    fetchMock.mockRejectedValue(netErr);

    const err = await refreshAccessToken({ provider: JSON_PROVIDER, refreshToken: 'rt' }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_NETWORK_ERROR'); // distinguishable from TOKEN_REFRESH_FAILED
    expect(err.message).toContain('[ECONNREFUSED]');
    expect(err.message).toContain('https://oauth.sarv.com/api/oauth/token');
    expect(err.message).toContain('connect ECONNREFUSED 127.0.0.1:8880');
    expect(err.detail).toBeUndefined(); // no server response exists to carry
  });

  it('a cause-less network throw still yields a clean message (no empty brackets)', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));

    const err = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt' }).catch((e) => e);

    expect(err.code).toBe('TOKEN_REFRESH_NETWORK_ERROR');
    expect(err.message).toBe('Cannot reach OAuth server at https://oauth2.googleapis.com/token');
    expect(err.message).not.toContain('[]');
    expect(err.message).not.toContain('undefined');
  });

  // An HTML error page / proxy interstitial on a 200: the JSON parse error
  // propagates as-is (a SyntaxError, not an OAuthError) — pinned so callers
  // know this path is NOT wrapped and must not be treated as invalid_grant.
  // A captive portal / proxy answering 200 with an HTML page must surface as a
  // CLASSIFIED OAuthError, not a raw SyntaxError: callers branch on `err.code`
  // (isTerminalOAuthError), and an unclassified throw reads as neither terminal
  // nor transient — so a network-level fault got treated as a dead token.
  it('a non-JSON 200 body rejects as a classified OAuthError carrying the body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      }),
      text: vi.fn(async () => '<html>captive portal</html>'),
    } as unknown as Response);

    const err = await refreshAccessToken({ provider: FORM_PROVIDER, refreshToken: 'rt' }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_INVALID_RESPONSE');
    expect(err.message).toContain('captive portal');
  });
});

describe('exchangeCodeForTokens', () => {
  // The initial code→token swap. Missing code_verifier or a mismatched
  // redirect_uri are the two classic first-login failures; the PKCE verifier
  // must be sent under the RFC name `code_verifier`.
  it('form format posts grant_type=authorization_code with code, code_verifier, redirect_uri and client_secret', async () => {
    fetchMock.mockResolvedValue(
      okJson({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, token_type: 'Bearer' }),
    );

    const res = await exchangeCodeForTokens({
      provider: FORM_PROVIDER,
      code: 'auth-code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'http://127.0.0.1:41234/callback',
    });

    const { url, init, headers, body } = lastCall(fetchMock);
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-abc',
      code: 'auth-code-1',
      code_verifier: 'verifier-1',
      redirect_uri: 'http://127.0.0.1:41234/callback',
      client_secret: 'secret-xyz',
    });
    expect(res.refresh_token).toBe('rt');
  });

  it('json format posts the same params as JSON and omits client_secret for a public client', async () => {
    fetchMock.mockResolvedValue(
      okJson({ access_token: 'at', refresh_token: 'rt', expires_in: 900, token_type: 'Bearer' }),
    );

    await exchangeCodeForTokens({
      provider: JSON_PROVIDER,
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'sarvinbox://cb',
    });

    const { headers, body } = lastCall(fetchMock);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client_Z6sj',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'sarvinbox://cb',
    });
  });

  // Exchange failures must be tagged distinctly from refresh failures — the UI
  // shows "sign-in failed, try again" vs "session expired, re-authorize".
  it('a failed exchange raises TOKEN_EXCHANGE_FAILED with the provider error in message + detail', async () => {
    const body = '{"error":"redirect_uri_mismatch"}';
    fetchMock.mockResolvedValue(errorResponse(400, body));

    const err = await exchangeCodeForTokens({
      provider: FORM_PROVIDER,
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://localhost:1/cb',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_EXCHANGE_FAILED');
    expect(err.detail).toBe(body);
    expect(err.message).toContain('redirect_uri_mismatch');
  });

  it('a network throw during exchange raises TOKEN_EXCHANGE_NETWORK_ERROR naming the host', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    );

    const err = await exchangeCodeForTokens({
      provider: JSON_PROVIDER,
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'sarvinbox://cb',
    }).catch((e) => e);

    expect(err.code).toBe('TOKEN_EXCHANGE_NETWORK_ERROR');
    expect(err.message).toBe(
      'Cannot reach OAuth server [ENOTFOUND] at https://oauth.sarv.com/api/oauth/token',
    );
  });

  it('an unreadable exchange error body reports "no body"', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn(async () => {
        throw new Error('aborted');
      }),
    } as unknown as Response);

    const err = await exchangeCodeForTokens({
      provider: FORM_PROVIDER,
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://localhost:1/cb',
    }).catch((e) => e);

    expect(err.message).toBe('Token exchange failed (500): no body');
  });
});

/**
 * Cancellation. THE regression these guard is the one that revoked a live
 * session on 2026-09-08: a refresh POST left running after its caller gave up.
 * Against a provider that rotates refresh tokens, an orphaned request can be
 * processed server-side while we keep the token it just consumed — and the next
 * refresh looks exactly like a stolen-token replay, so the session is revoked.
 * The request must therefore be genuinely abortable, and a cancelled refresh
 * must never be reported as if it had definitely not happened.
 */
describe('refreshAccessToken — cancellation', () => {
  // If no signal reaches fetch, nothing can stop the request: it outlives its
  // caller and the orphaned-refresh bug is back exactly as it was.
  it('always passes an AbortSignal to fetch, even with no caller signal', async () => {
    fetchMock.mockResolvedValue(okJson({ access_token: 'a', expires_in: 900, token_type: 'Bearer' }));

    await refreshAccessToken({ provider: JSON_PROVIDER, refreshToken: 'rt' });

    const { init } = lastCall(fetchMock);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  // The caller's signal must actually reach the socket — this is what the
  // powerMonitor 'suspend' hook pulls to stop a refresh before sleep freezes it.
  it("aborts the request when the caller's signal fires, and names the reason", async () => {
    const controller = new AbortController();
    // Model undici: reject with the signal's reason the moment it aborts.
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
      }),
    );

    const pending = refreshAccessToken({
      provider: JSON_PROVIDER,
      refreshToken: 'rt',
      signal: controller.signal,
    }).catch((e) => e);
    controller.abort('system suspend');
    const err = await pending;

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_ABORTED');
    expect(err.message).toContain('system suspend');
    // The whole point: the caller must NOT conclude the refresh didn't happen.
    expect(err.message).toContain('the server may still have processed it');
  });

  // A non-string abort reason must not produce "[object Object]" in the log.
  it('falls back to a readable reason when the caller aborts without a string', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );

    const pending = refreshAccessToken({
      provider: FORM_PROVIDER,
      refreshToken: 'rt',
      signal: controller.signal,
    }).catch((e) => e);
    controller.abort();
    const err = await pending;

    expect(err.code).toBe('TOKEN_REFRESH_ABORTED');
    expect(err.message).toContain('cancelled by the caller');
    expect(err.message).not.toContain('[object Object]');
  });

  // A hung endpoint must self-cancel rather than wait on an outer race that
  // would reject the caller while leaving the request running.
  it('times out on its own deadline and reports the token state as unknown', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
      }),
    );

    const err = await refreshAccessToken({
      provider: JSON_PROVIDER,
      refreshToken: 'rt',
      timeoutMs: 10,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_TIMEOUT');
    expect(err.message).toContain('timed out after 10ms');
    expect(err.message).toContain('the server may still have processed it');
  });

  // Classification must come from the SIGNALS, not the thrown value: a genuine
  // network fault that happens to look like an abort must stay a network error,
  // or offline blips would be misreported as cancellations.
  it('keeps a real network failure classified as a network error', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    );

    const err = await refreshAccessToken({
      provider: JSON_PROVIDER,
      refreshToken: 'rt',
      signal: new AbortController().signal,
    }).catch((e) => e);

    expect(err.code).toBe('TOKEN_REFRESH_NETWORK_ERROR');
    expect(err.message).toContain('[ENOTFOUND]');
  });

  // The interactive exchange gets its own, longer budget: a human is waiting and
  // there is no stored refresh token to lose. Sharing the refresh deadline would
  // cut off slow-but-working sign-ins.
  it('the code exchange uses the longer interactive deadline, not the refresh one', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
      }),
    );

    const err = await exchangeCodeForTokens({
      provider: FORM_PROVIDER,
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://localhost:1/cb',
      timeoutMs: 10,
    }).catch((e) => e);

    expect(err.code).toBe('TOKEN_EXCHANGE_TIMEOUT');
    expect(TOKEN_EXCHANGE_TIMEOUT_MS).toBeGreaterThan(TOKEN_REQUEST_TIMEOUT_MS);
  });
});
