import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: h.fetch }));

import { timedChromiumFetch } from '../../../../electron/services/timed-fetch';

afterEach(() => {
  h.fetch.mockReset();
  vi.useRealTimers();
});

describe('timedChromiumFetch', () => {
  // Breaks: bounded readers (BIMI, favicon, key discovery) read status, final
  // URL, headers and body through this shape.
  it('adapts a Chromium response to FetchLike', async () => {
    h.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://final.example/k',
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    });
    const res = await timedChromiumFetch(1000)('https://a.example/k');
    expect(res).toMatchObject({ ok: true, status: 200, url: 'https://final.example/k' });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(h.fetch).toHaveBeenCalledWith('https://a.example/k');
  });

  // Breaks: a server that accepts the connection and never answers would hang
  // the caller (and, for key discovery, the compose window) indefinitely.
  it('times out a stalled connection and a stalled body', async () => {
    vi.useFakeTimers();
    h.fetch.mockReturnValue(new Promise(() => {}));
    const stalled = expect(timedChromiumFetch(50)('https://slow.example')).rejects.toThrow(/Timed out fetching/);
    await vi.advanceTimersByTimeAsync(60);
    await stalled;

    h.fetch.mockResolvedValue({ ok: true, status: 200, url: '', headers: new Headers(), arrayBuffer: () => new Promise(() => {}) });
    const res = await timedChromiumFetch(50)('https://slow.example');
    const body = expect(res.arrayBuffer()).rejects.toThrow(/Timed out reading/);
    await vi.advanceTimersByTimeAsync(60);
    await body;
  });
});
