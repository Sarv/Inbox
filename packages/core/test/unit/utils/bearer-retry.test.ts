import { describe, expect, it, vi } from 'vitest';

import {
  BearerUnavailableError,
  fetchWithBearerRetry,
  isBearerUnavailableError,
} from '../../../src/utils/bearer-retry';

/**
 * The one "send with a bearer, and on 401 force a fresh one and send again"
 * used by main's Sarv AI proxy and the Sarv catalog. What breaks if this file
 * fails: an expired token is no longer self-healed (AI fails ~15 minutes after
 * sign-in), a refused token is retried in a loop (one request becomes many,
 * each a forced refresh), a 403 or 5xx forces a refresh it cannot fix, or a
 * failure to MINT a token is mistaken for a failed request.
 */

const status = (code: number) => new Response(code === 204 ? null : 'x', { status: code });

describe('fetchWithBearerRetry', () => {
  // Breaks: every request pays a forced refresh, or the first bearer is not used.
  it('sends once with the current bearer when it is accepted', async () => {
    const resolve = vi.fn(async (force: boolean) => (force ? 'fresh' : 'current'));
    const send = vi.fn(async () => status(200));
    const res = await fetchWithBearerRetry(resolve, send);
    expect(res.status).toBe(200);
    expect(resolve.mock.calls).toEqual([[false]]);
    expect(send.mock.calls).toEqual([['current']]);
  });

  // THE self-heal: a token our clock still trusted was rejected.
  it('on 401 forces a fresh bearer and sends exactly once more', async () => {
    const resolve = vi.fn(async (force: boolean) => (force ? 'fresh' : 'stale'));
    const first = status(401);
    const cancel = vi.spyOn(first.body!, 'cancel');
    const send = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(status(200));
    const res = await fetchWithBearerRetry(resolve, send);
    expect(res.status).toBe(200);
    expect(resolve.mock.calls).toEqual([[false], [true]]);
    expect(send.mock.calls).toEqual([['stale'], ['fresh']]);
    // The refused response's connection is released before the retry.
    expect(cancel).toHaveBeenCalled();
  });

  // Breaks: a refused fresh token loops (and forces a refresh) forever.
  it('returns the second 401 as-is instead of retrying again', async () => {
    const resolve = vi.fn(async () => 'tok');
    const send = vi.fn(async () => status(401));
    expect((await fetchWithBearerRetry(resolve, send)).status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  // Breaks: a scope / CAI-account verdict or a server error forces a refresh
  // (org-less accounts get 403 from /oauth/v1/zones on every boot).
  it.each([403, 429, 500, 502, 204])('does not retry a %i', async (code) => {
    const resolve = vi.fn(async () => 'tok');
    const send = vi.fn(async () => status(code));
    expect((await fetchWithBearerRetry(resolve, send)).status).toBe(code);
    expect(send).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls).toEqual([[false]]);
  });

  // Breaks: "could not get a token" reads as a network failure of the request,
  // so the caller cannot tell sign-in-required from offline.
  it('wraps a token failure as BearerUnavailableError and sends nothing', async () => {
    const cause = Object.assign(new Error('Token refresh failed (400): invalid_grant'), { code: 'TOKEN_REFRESH_FAILED' });
    const send = vi.fn();
    const err = await fetchWithBearerRetry(async () => { throw cause; }, send).catch((e) => e);
    expect(isBearerUnavailableError(err)).toBe(true);
    expect(err).toBeInstanceOf(BearerUnavailableError);
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('Token refresh failed (400): invalid_grant');
    expect(send).not.toHaveBeenCalled();
  });

  // Breaks: a failed forced refresh after a 401 is reported as the 401 or a
  // network error instead of as a token failure.
  it('reports a failed forced refresh as BearerUnavailableError', async () => {
    const resolve = vi.fn(async (force: boolean) => {
      if (force) throw new Error('Cannot reach OAuth server');
      return 'stale';
    });
    const err = await fetchWithBearerRetry(resolve, async () => status(401)).catch((e) => e);
    expect(isBearerUnavailableError(err)).toBe(true);
    expect(err.message).toBe('Cannot reach OAuth server');
  });

  // Breaks: an empty token goes out as `Authorization: Bearer ` (the gateway
  // answers a generic 502 that looks like an outage).
  it.each(['', '   ', undefined])('refuses an empty bearer %j as needing sign-in', async (blank) => {
    const send = vi.fn();
    const err = await fetchWithBearerRetry(async () => blank as unknown as string, send).catch((e) => e);
    expect(isBearerUnavailableError(err)).toBe(true);
    expect(err.cause.code).toBe('EMPTY_STORED_TOKEN');
    expect(send).not.toHaveBeenCalled();
  });

  // Breaks: a network failure or an abort is swallowed or mislabelled.
  it('lets a send rejection propagate untouched', async () => {
    const netErr = new TypeError('fetch failed');
    const err = await fetchWithBearerRetry(async () => 'tok', async () => { throw netErr; }).catch((e) => e);
    expect(err).toBe(netErr);
    expect(isBearerUnavailableError(err)).toBe(false);
  });

  // Breaks: a non-Error thrown by the token layer crashes the wrapper.
  it('wraps a non-Error token failure too', async () => {
    const err = await fetchWithBearerRetry(async () => { throw 'nope'; }, vi.fn()).catch((e) => e);
    expect(err.message).toBe('nope');
    expect(isBearerUnavailableError(null)).toBe(false);
  });

  // Breaks: a 401 whose body was already read makes the retry throw.
  it('still retries when the refused body cannot be cancelled', async () => {
    const consumed = status(401);
    await consumed.text();
    const send = vi.fn().mockResolvedValueOnce(consumed).mockResolvedValueOnce(status(200));
    expect((await fetchWithBearerRetry(async () => 'tok', send)).status).toBe(200);
  });
});
