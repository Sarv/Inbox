import type { ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  LOOPBACK_CALLBACK_CSP,
  loopbackCallbackCsp,
  setLoopbackCallbackHeaders,
} from '../../../../electron/utils/loopback-callback-headers';

/**
 * The headers both OAuth loopback listeners (mail/Sarv and antivirus) answer the
 * browser with. The end-to-end suites check them on real sockets; these pin the
 * policy itself.
 */

/** A response that only records what was set on it. */
const recordingResponse = () => {
  const headers = new Map<string, string>();
  const response = { setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value) };
  return { response: response as unknown as ServerResponse, headers };
};

describe('loopbackCallbackCsp', () => {
  // Breaks: the default policy loosens — a callback page (reached with an
  // authorization code in its URL) can load, run, submit to or be framed by
  // something.
  it('denies everything by default and admits no style at all without one', () => {
    expect(LOOPBACK_CALLBACK_CSP).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(loopbackCallbackCsp()).toBe(LOOPBACK_CALLBACK_CSP);
  });

  // Breaks: the hash is computed differently from the browser's (wrong
  // algorithm, encoding or input) and the page's own style is blocked — or the
  // fix reaches for 'unsafe-inline'. Known vector: SHA-256 of the empty string.
  it('admits an inline style by the SHA-256 the browser computes, never unsafe-inline', () => {
    expect(loopbackCallbackCsp({ inlineStyle: '' })).toBe(
      `${LOOPBACK_CALLBACK_CSP}; style-src 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='`,
    );
    const styled = loopbackCallbackCsp({ inlineStyle: 'body{color:red}' });
    expect(styled).toMatch(/style-src 'sha256-[A-Za-z0-9+/]{43}='$/);
    expect(styled).not.toContain('unsafe-inline');
    expect(styled).not.toBe(loopbackCallbackCsp({ inlineStyle: 'body{color:blue}' }));
  });
});

describe('setLoopbackCallbackHeaders', () => {
  // Breaks: one of the headers is dropped, so a callback page can be cached,
  // leak its URL as a Referer, be sniffed into another type, or keep a socket
  // alive on a listener that is about to close.
  it('sets every callback header, with the default policy unless given one', () => {
    const plain = recordingResponse();
    setLoopbackCallbackHeaders(plain.response);
    expect(Object.fromEntries(plain.headers)).toEqual({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': LOOPBACK_CALLBACK_CSP,
      'x-content-type-options': 'nosniff',
      connection: 'close',
    });

    const styled = recordingResponse();
    const csp = loopbackCallbackCsp({ inlineStyle: 'p{}' });
    setLoopbackCallbackHeaders(styled.response, csp);
    expect(styled.headers.get('content-security-policy')).toBe(csp);
  });
});
