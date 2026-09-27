import { describe, expect, it, vi } from 'vitest';

import { MAX_REDIRECTS, ONE_CLICK_TIMEOUT_MS, postOneClick, type FetchLike } from '../../../../electron/services/unsubscribe-service';

/**
 * What breaks if this suite goes red: the one-click unsubscribe POST. Every
 * failure here is a request that leaves the reader's machine differently from
 * how RFC 8058 says it should — or a click reported as successful that changed
 * nothing, which leaves them believing they have left a list they are still on.
 */

const BODY = 'List-Unsubscribe=One-Click';

/** A fetch that answers each call from a scripted list, recording what it got. */
function scriptedFetch(responses: Array<{ status: number; location?: string } | Error>) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses[calls.length - 1] ?? { status: 200 };
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? next.location ?? null : null) },
    };
  };
  return { impl, calls };
}

describe('postOneClick', () => {
  // The request RFC 8058 specifies, exactly: POST, form encoding, the fixed
  // token as the whole body. A sender's endpoint that receives anything else
  // is entitled to ignore it, and nothing tells the reader it did.
  it('sends the RFC 8058 request and reports the endpoint accepting it', async () => {
    const { impl, calls } = scriptedFetch([{ status: 200 }]);

    expect(await postOneClick('https://brand.example/u/abc', BODY, impl)).toEqual({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://brand.example/u/abc');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].init.body).toBe(BODY);
  });

  // Redirects are followed manually so the body is never handed onward to a
  // Location the caller has not inspected — see the http case below.
  it('follows an https redirect and posts the body again at the new address', async () => {
    const { impl, calls } = scriptedFetch([
      { status: 302, location: 'https://brand.example/confirm' },
      { status: 204 },
    ]);

    expect(await postOneClick('https://brand.example/u', BODY, impl)).toEqual({ ok: true, status: 204 });
    expect(calls.map((c) => c.url)).toEqual(['https://brand.example/u', 'https://brand.example/confirm']);
    expect(calls[1].init.body).toBe(BODY);
  });

  it('resolves a relative Location against the current address', async () => {
    const { impl, calls } = scriptedFetch([{ status: 301, location: '/u/v2' }, { status: 200 }]);

    await postOneClick('https://brand.example/u/abc', BODY, impl);
    expect(calls[1].url).toBe('https://brand.example/u/v2');
  });

  // THE regression: an http hop would replay the unsubscribe token in clear
  // text, handing anyone on the path the ability to unsubscribe this reader.
  it('refuses to follow a redirect off https', async () => {
    const { impl, calls } = scriptedFetch([{ status: 302, location: 'http://brand.example/u' }]);

    const result = await postOneClick('https://brand.example/u', BODY, impl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/will not follow/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a redirect with no Location, and one that will not parse', async () => {
    const noLocation = scriptedFetch([{ status: 302 }]);
    expect((await postOneClick('https://x.example/u', BODY, noLocation.impl)).ok).toBe(false);

    const unparseable = scriptedFetch([{ status: 302, location: 'http://[' }]);
    expect((await postOneClick('https://x.example/u', BODY, unparseable.impl)).ok).toBe(false);
  });

  // A sender whose endpoint loops must not keep the reader waiting forever,
  // nor keep re-posting the token to a chain of trackers.
  it('gives up after the redirect limit', async () => {
    const hops = Array.from({ length: MAX_REDIRECTS + 2 }, (_, i) => ({
      status: 302,
      location: `https://brand.example/u/${i + 1}`,
    }));
    const { impl, calls } = scriptedFetch(hops);

    const result = await postOneClick('https://brand.example/u/0', BODY, impl);
    expect(result).toEqual({ ok: false, status: null, error: 'Unsubscribe link redirected too many times' });
    expect(calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  // Permanent: the endpoint answered and said no. The reader is told, rather
  // than shown a success for a request the sender rejected.
  it('reports a non-2xx answer as a failure carrying the status', async () => {
    const { impl } = scriptedFetch([{ status: 410 }]);
    const result = await postOneClick('https://brand.example/u', BODY, impl);
    expect(result).toEqual({ ok: false, status: 410, error: "The sender's server answered 410" });
  });

  // Transient: a blip, a DNS failure, or the deadline. Nothing changed, so
  // clicking again is safe — and `status: null` is what says "never answered".
  it('reports a thrown request as a failure with no status', async () => {
    const { impl } = scriptedFetch([new Error('ETIMEDOUT')]);
    expect(await postOneClick('https://brand.example/u', BODY, impl)).toEqual({
      ok: false,
      status: null,
      error: 'ETIMEDOUT',
    });
  });

  // The request must be ABORTABLE, not merely un-awaited: a POST still running
  // after the reader was told it failed may yet unsubscribe them.
  it('arms an abort signal on every attempt', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { impl, calls } = scriptedFetch([{ status: 200 }]);

    await postOneClick('https://brand.example/u', BODY, impl);
    expect(timeout).toHaveBeenCalledWith(ONE_CLICK_TIMEOUT_MS);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });
});
