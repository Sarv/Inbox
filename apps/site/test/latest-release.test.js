import { describe, expect, it, vi } from 'vitest';

import { LATEST_RELEASE_API } from '../src/download-view.js';
import { fetchLatestRelease } from '../src/latest-release.js';

import { releaseV122 } from './fixtures.js';

const respond = (body, { ok = true } = {}) => vi.fn(async () => ({ ok, json: async () => body }));

describe('fetchLatestRelease', () => {
  // Breaks if the page stops asking for the LATEST release, or serves a stale cached one.
  it('asks the /releases/latest endpoint, revalidating the cache', async () => {
    const fetchImpl = respond(releaseV122());
    await fetchLatestRelease(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(LATEST_RELEASE_API);
    expect(url.endsWith('/releases/latest')).toBe(true);
    expect(init.cache).toBe('no-cache');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // Breaks if a good response is not passed through.
  it('returns the release', async () => {
    expect(await fetchLatestRelease(respond(releaseV122()))).toEqual(releaseV122());
  });

  // Breaks if a rate-limited (403) or no-release (404) answer is treated as a release.
  it.each([403, 404, 500])('null on HTTP %i', async () => {
    expect(
      await fetchLatestRelease(respond({ message: 'API rate limit exceeded' }, { ok: false }))
    ).toBeNull();
  });

  // Breaks if an unexpected body (no assets array) reaches the view and crashes it.
  it.each([{}, null, { assets: 'nope' }])('null on unexpected body %j', async (body) => {
    expect(await fetchLatestRelease(respond(body))).toBeNull();
  });

  // Breaks if going offline throws out of the page instead of showing the fallback.
  it('null when the network fails', async () => {
    expect(
      await fetchLatestRelease(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    ).toBeNull();
  });

  // Breaks if a non-JSON body (captive portal page) throws.
  it('null when the body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    }));
    expect(await fetchLatestRelease(fetchImpl)).toBeNull();
  });

  // Breaks if a hung request leaves the page on "Finding the right download…" forever.
  it('gives up after the timeout', async () => {
    const hang = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason))
        )
    );
    expect(await fetchLatestRelease(hang, { timeoutMs: 10 })).toBeNull();
  });
});
