import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The main process must go through Chromium's network stack (OS trust store, AIA
 * intermediate fetching, system proxy) rather than Node's undici — otherwise
 * "renderer works, main fails" TLS mismatches appear. This pins the delegation.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  response: { ok: true } as unknown,
  throws: false,
}));

vi.mock('electron', () => ({
  net: {
    fetch: (input: string, init?: unknown) => {
      h.calls.push([input, init]);
      if (h.throws) return Promise.reject(new Error('net down'));
      return Promise.resolve(h.response);
    },
  },
}));

import { chromiumFetch } from '../../../../electron/services/net-fetch';

beforeEach(() => {
  h.calls.length = 0;
  h.throws = false;
  h.response = { ok: true };
});

describe('chromiumFetch', () => {
  it('delegates to electron net.fetch and returns its response', async () => {
    await expect(chromiumFetch('https://example.com/x')).resolves.toBe(h.response);
    expect(h.calls).toEqual([['https://example.com/x', undefined]]);
  });

  it('passes RequestInit through untouched', async () => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    await chromiumFetch('https://example.com/api', init);
    expect(h.calls[0][1]).toBe(init);
  });

  it('propagates a transport failure to the caller', async () => {
    h.throws = true;
    await expect(chromiumFetch('https://example.com')).rejects.toThrow('net down');
  });
});
