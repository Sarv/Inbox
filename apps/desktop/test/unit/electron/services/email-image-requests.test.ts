import { describe, it, expect } from 'vitest';

import {
  createRedirectedRequestTracker,
  installEmailImageRequestHandlers,
  PROXY_URL_FILTERS,
  redirectForImageRequest,
  refererHeadersFor,
  strippedResponseHeaders,
} from '../../../../electron/services/email-image-requests';

/**
 * The network-layer rules that decide whether the images in an email appear at
 * all. Every one of them is a workaround for a web-platform default that is
 * right for a website and wrong for a mailbox, so each is only ever one line
 * away from being "cleaned up" by someone who doesn't know what it protects.
 */

const PHOTON_AVATAR =
  'https://i0.wp.com/avatar-management--avatars.us-west-2.prod.public.atl-paas.net/initials/RG-1.png?ssl=1';
const DIRECT_AVATAR =
  'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/initials/RG-1.png';

describe('redirectForImageRequest', () => {
  // Regression: the reported broken avatar. The sender's mail routed the image
  // through WordPress's Photon proxy, which answers 429 to our request forever.
  // If this stops redirecting, that avatar (and every Photon-proxied image) is
  // a broken box again.
  it('sends a Photon-proxied image straight to its origin', () => {
    expect(redirectForImageRequest({ url: PHOTON_AVATAR, resourceType: 'image' })).toBe(
      DIRECT_AVATAR,
    );
  });

  // Regression: media (a <video>/<audio> poster or source) goes through the same
  // proxy and needs the same unwrapping.
  it('unwraps media requests too', () => {
    expect(redirectForImageRequest({ url: PHOTON_AVATAR, resourceType: 'media' })).toBe(
      DIRECT_AVATAR,
    );
  });

  // Regression: a redirect belongs to email CONTENT only. Rewriting a document,
  // script or XHR request would silently re-point app traffic.
  it('leaves non-image resource types alone', () => {
    expect(redirectForImageRequest({ url: PHOTON_AVATAR, resourceType: 'xhr' })).toBeNull();
    expect(redirectForImageRequest({ url: PHOTON_AVATAR })).toBeNull();
  });

  // Regression: an ordinary image URL must pass through untouched — returning a
  // redirect equal to the request URL would make Chromium loop.
  it('returns null for a URL that is not a proxy wrapper', () => {
    expect(
      redirectForImageRequest({ url: 'https://example.com/logo.png', resourceType: 'image' }),
    ).toBeNull();
  });

  // Regression: the filter list is what makes the hook cheap — it must cover
  // every edge host the unwrapper recognises, or some of them never reach it.
  it('filters exactly the proxy hosts the unwrapper handles', () => {
    expect(PROXY_URL_FILTERS).toEqual([
      '*://i0.wp.com/*',
      '*://i1.wp.com/*',
      '*://i2.wp.com/*',
      '*://i3.wp.com/*',
    ]);
    for (const host of ['i0', 'i1', 'i2', 'i3']) {
      expect(
        redirectForImageRequest({
          url: `https://${host}.wp.com/example.com/a.png?ssl=1`,
          resourceType: 'image',
        }),
      ).toBe('https://example.com/a.png');
    }
  });

  // Regression: the reported "invalid argument" failure. Chromium only lets a
  // listener change a redirect's target WITHIN the same origin; unwrapping is
  // cross-origin by definition, so doing it on a hop the server redirected us to
  // fails the whole load (net::ERR_INVALID_ARGUMENT) instead of loading either
  // URL. If this stops returning null, every proxied image reached via a
  // redirect is a hard-broken box.
  it('leaves a hop we were redirected to alone', () => {
    expect(redirectForImageRequest({ url: PHOTON_AVATAR, resourceType: 'image' }, true)).toBeNull();
    expect(redirectForImageRequest({ url: PHOTON_AVATAR, resourceType: 'image' }, false)).toBe(
      DIRECT_AVATAR,
    );
  });
});

describe('createRedirectedRequestTracker', () => {
  // Regression: the id is what links a redirect to the hop that follows it.
  // Marking or reading the wrong one silently restores the broken-image bug.
  it('remembers only the ids that were redirected', () => {
    const tracker = createRedirectedRequestTracker();
    tracker.markRedirected(7);
    expect(tracker.hasRedirected(7)).toBe(true);
    expect(tracker.hasRedirected(8)).toBe(false);
  });

  // Regression: a request that finished must stop counting as redirected —
  // Chromium reuses ids, and a stale mark would suppress a legitimate unwrap.
  it('forgets an id once its request finishes', () => {
    const tracker = createRedirectedRequestTracker();
    tracker.markRedirected(7);
    tracker.forget(7);
    expect(tracker.hasRedirected(7)).toBe(false);
    expect(tracker.size).toBe(0);
  });

  // Regression: Electron omits `id` on some details. An undefined id must be a
  // no-op, never an entry that makes every other undefined-id request look
  // redirected.
  it('ignores details with no id', () => {
    const tracker = createRedirectedRequestTracker();
    tracker.markRedirected(undefined);
    tracker.forget(undefined);
    expect(tracker.hasRedirected(undefined)).toBe(false);
    expect(tracker.size).toBe(0);
  });

  // Regression: the set is fed by every redirect in the session. Without a cap
  // it is an unbounded leak in a long-running main process; the oldest id goes
  // first so live requests keep their mark.
  it('caps how many ids it holds, dropping the oldest', () => {
    const tracker = createRedirectedRequestTracker(2);
    tracker.markRedirected(1);
    tracker.markRedirected(2);
    tracker.markRedirected(3);
    expect(tracker.size).toBe(2);
    expect(tracker.hasRedirected(1)).toBe(false);
    expect(tracker.hasRedirected(2)).toBe(true);
    expect(tracker.hasRedirected(3)).toBe(true);
  });
});

describe('refererHeadersFor', () => {
  // Regression: the measured cause of the 429. Email images are loaded with
  // `referrerpolicy="no-referrer"`, and a packaged build serves from file:// and
  // sends no referer regardless; hosts that refuse an unattributable request
  // then answer 429/403 permanently. Dropping this header makes those images
  // fail again.
  it('adds the image its own origin as Referer', () => {
    const headers = refererHeadersFor({ url: DIRECT_AVATAR, resourceType: 'image' });
    expect(headers?.Referer).toBe(
      'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/',
    );
  });

  // Regression: the privacy property that makes sending a referer acceptable at
  // all. The value must name only the host being asked — never the user, the
  // message, or the app — so the host learns nothing it didn't already know.
  it('never leaks the app or the message in the referer', () => {
    const headers = refererHeadersFor({
      url: 'https://tracker.example.com/open/abc123.gif',
      resourceType: 'image',
    });
    expect(headers?.Referer).toBe('https://tracker.example.com/');
  });

  // Regression: existing headers must survive. Replacing the map instead of
  // extending it would strip User-Agent/Accept and break ordinary requests.
  it('keeps the headers already on the request', () => {
    const headers = refererHeadersFor({
      url: DIRECT_AVATAR,
      resourceType: 'image',
      requestHeaders: { Accept: 'image/webp', 'User-Agent': 'Sarv' },
    });
    expect(headers?.Accept).toBe('image/webp');
    expect(headers?.['User-Agent']).toBe('Sarv');
  });

  // Regression: a referer the page set for itself is intentional; overwriting it
  // would change what a first-party request tells its own server.
  it('never overrides a referer already present, whatever its casing', () => {
    expect(
      refererHeadersFor({
        url: DIRECT_AVATAR,
        resourceType: 'image',
        requestHeaders: { referer: 'https://mail.example.com/' },
      }),
    ).toBeNull();
  });

  // Regression: only pictures. A referer on a document/script/XHR request would
  // change what the app itself reports to every server it talks to.
  it('adds nothing to non-image requests', () => {
    expect(refererHeadersFor({ url: DIRECT_AVATAR, resourceType: 'script' })).toBeNull();
  });

  // Regression: local schemes have no origin worth sending, and a bogus value
  // here would be an invalid header on every inline image we serve ourselves.
  it('adds nothing for non-http URLs', () => {
    for (const url of ['data:image/png;base64,AAA', 'sarv-inline://x/y', 'not a url']) {
      expect(refererHeadersFor({ url, resourceType: 'image' })).toBeNull();
    }
  });
});

describe('strippedResponseHeaders', () => {
  // Regression: CORP is a site telling browsers not to let OTHER sites embed its
  // images — which is exactly what every image in every email is. Honouring it
  // renders broken pictures across whole newsletters.
  it('removes the cross-origin embedding blocks from image responses', () => {
    const headers = strippedResponseHeaders({
      url: 'https://cdn.example.com/a.png',
      resourceType: 'image',
      responseHeaders: {
        'Cross-Origin-Resource-Policy': ['same-origin'],
        'cross-origin-embedder-policy': ['require-corp'],
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Content-Type': ['image/png'],
      },
    });
    expect(Object.keys(headers || {})).toEqual(['Content-Type']);
  });

  // Regression: servers disagree on header casing; a case-sensitive match would
  // leave the block in place for half the web.
  it('matches the blocking headers case-insensitively', () => {
    const headers = strippedResponseHeaders({
      url: 'https://cdn.example.com/a.woff2',
      resourceType: 'font',
      responseHeaders: { 'CROSS-ORIGIN-RESOURCE-POLICY': ['same-site'] },
    });
    expect(headers).toEqual({});
  });

  // Regression: stripping these off a DOCUMENT or script response would weaken
  // the app's own isolation. Only email subresources are relaxed.
  it('leaves non-subresource responses untouched', () => {
    expect(
      strippedResponseHeaders({
        url: 'https://example.com/',
        resourceType: 'mainFrame',
        responseHeaders: { 'Cross-Origin-Opener-Policy': ['same-origin'] },
      }),
    ).toBeNull();
  });

  // Regression: returning a rebuilt header map for every response would make the
  // hook rewrite traffic it has no reason to touch. Null means "leave it".
  it('returns null when there was nothing to strip', () => {
    expect(
      strippedResponseHeaders({
        url: 'https://cdn.example.com/a.png',
        resourceType: 'image',
        responseHeaders: { 'Content-Type': ['image/png'] },
      }),
    ).toBeNull();
  });

  // Regression: Electron omits both fields on some requests. Reading them
  // unguarded throws inside the hook, which fails the request outright.
  it('survives details with no resource type and no headers', () => {
    expect(strippedResponseHeaders({ url: 'https://cdn.example.com/a.png' })).toBeNull();
    expect(
      strippedResponseHeaders({ url: 'https://cdn.example.com/a.png', resourceType: 'image' }),
    ).toBeNull();
  });
});

describe('installEmailImageRequestHandlers', () => {
  /** A webRequest double that records its listeners and lets tests drive them. */
  function fakeWebRequest() {
    const listeners: Record<string, any> = {};
    const filters: Record<string, string[]> = {};
    const record = (name: string) => (filter: any, listener: any) => {
      filters[name] = filter.urls;
      listeners[name] = listener;
    };
    return {
      onBeforeRequest: record('onBeforeRequest'),
      onBeforeSendHeaders: record('onBeforeSendHeaders'),
      onHeadersReceived: record('onHeadersReceived'),
      onBeforeRedirect: record('onBeforeRedirect'),
      onCompleted: record('onCompleted'),
      onErrorOccurred: record('onErrorOccurred'),
      listeners,
      filters,
    };
  }

  /** Run one recorded listener and return what it passed to `callback`. */
  function invoke(webRequest: ReturnType<typeof fakeWebRequest>, name: string, details: any) {
    let response: any;
    webRequest.listeners[name](details, (value: any) => {
      response = value;
    });
    return response;
  }

  // Regression: every hook must actually be installed. A silent failure to
  // register one is invisible until an email renders wrong. Changed: the three
  // redirect-tracking hooks joined the original three when the cross-origin
  // redirect rewrite was found to fail the load outright.
  it('installs every hook on the session', () => {
    const webRequest = fakeWebRequest();
    installEmailImageRequestHandlers(webRequest as any);
    expect(Object.keys(webRequest.listeners).sort()).toEqual([
      'onBeforeRedirect',
      'onBeforeRequest',
      'onBeforeSendHeaders',
      'onCompleted',
      'onErrorOccurred',
      'onHeadersReceived',
    ]);
    expect(webRequest.filters.onBeforeRedirect).toEqual(['*://*/*']);
    expect(webRequest.filters.onBeforeRequest).toEqual(PROXY_URL_FILTERS);
    expect(webRequest.filters.onHeadersReceived).toEqual(['*://*/*']);
  });

  // Regression: a webRequest listener that never calls its callback HANGS the
  // request — the image (or, for the catch-all hooks, every request in the app)
  // simply never loads. Each hook must answer on both branches.
  it('always answers the callback, redirect or not', () => {
    const webRequest = fakeWebRequest();
    installEmailImageRequestHandlers(webRequest as any);

    expect(invoke(webRequest, 'onBeforeRequest', { url: PHOTON_AVATAR, resourceType: 'image' }))
      .toEqual({ cancel: false, redirectURL: DIRECT_AVATAR });
    expect(
      invoke(webRequest, 'onBeforeRequest', { url: 'https://example.com/a.png', resourceType: 'image' }),
    ).toEqual({ cancel: false });

    expect(invoke(webRequest, 'onBeforeSendHeaders', { url: DIRECT_AVATAR, resourceType: 'image' }))
      .toEqual({ cancel: false, requestHeaders: expect.objectContaining({ Referer: expect.any(String) }) });
    expect(invoke(webRequest, 'onBeforeSendHeaders', { url: DIRECT_AVATAR, resourceType: 'script' }))
      .toEqual({ cancel: false });

    expect(
      invoke(webRequest, 'onHeadersReceived', {
        url: 'https://cdn.example.com/a.png',
        resourceType: 'image',
        responseHeaders: {
          'Cross-Origin-Resource-Policy': ['same-origin'],
          'Content-Type': ['image/png'],
        },
      }),
    ).toEqual({ cancel: false, responseHeaders: { 'Content-Type': ['image/png'] } });

    const untouched = { 'Content-Type': ['text/html'] };
    expect(
      invoke(webRequest, 'onHeadersReceived', {
        url: 'https://example.com/',
        resourceType: 'mainFrame',
        responseHeaders: untouched,
      }),
    ).toEqual({ cancel: false, responseHeaders: untouched });
  });

  // Regression: the hooks are independent. One unsupported API on some platform
  // must not cost the other two — a throwing onBeforeRequest used to be able to
  // take the CORP stripper down with it.
  it.each([
    ['onBeforeRequest', 5],
    ['onBeforeSendHeaders', 5],
    ['onHeadersReceived', 5],
    ['onCompleted', 5],
    ['onErrorOccurred', 5],
    // onBeforeRedirect also disarms the unwrapper that depends on it.
    ['onBeforeRedirect', 4],
  ])('installs the remaining hooks when %s throws', (failing, surviving) => {
    const webRequest = fakeWebRequest();
    const throwing = {
      ...webRequest,
      [failing]: () => {
        throw new Error('unsupported');
      },
    };
    expect(() => installEmailImageRequestHandlers(throwing as any)).not.toThrow();
    expect(Object.keys(webRequest.listeners)).not.toContain(failing);
    expect(Object.keys(webRequest.listeners)).toHaveLength(surviving);
  });

  // Regression: unwrapping without redirect tracking is WORSE than not
  // unwrapping — it turns every proxied image that arrives via a redirect into
  // net::ERR_INVALID_ARGUMENT. If tracking can't be installed, the unwrapper
  // must stay off rather than run blind.
  it('does not arm the unwrapper when redirect tracking fails to install', () => {
    const webRequest = fakeWebRequest();
    const throwing = {
      ...webRequest,
      onBeforeRedirect: () => {
        throw new Error('unsupported');
      },
    };
    installEmailImageRequestHandlers(throwing as any);
    expect(Object.keys(webRequest.listeners)).not.toContain('onBeforeRequest');
  });

  // Regression: the end-to-end shape of the reported bug. A Bitbucket avatar
  // 302s to the Photon URL; the unwrapper must rewrite the FIRST request and
  // keep its hands off the redirected one, or the image never loads at all.
  it('unwraps a proxy URL the mail named but not one a redirect landed on', () => {
    const webRequest = fakeWebRequest();
    installEmailImageRequestHandlers(webRequest as any);

    expect(invoke(webRequest, 'onBeforeRequest', { id: 1, url: PHOTON_AVATAR, resourceType: 'image' }))
      .toEqual({ cancel: false, redirectURL: DIRECT_AVATAR });

    webRequest.listeners.onBeforeRedirect({ id: 2, url: 'https://bitbucket.org/avatar/rg', resourceType: 'image' });
    expect(invoke(webRequest, 'onBeforeRequest', { id: 2, url: PHOTON_AVATAR, resourceType: 'image' }))
      .toEqual({ cancel: false });

    // ...and the referer that actually gets that hop past the proxy's 429.
    expect(invoke(webRequest, 'onBeforeSendHeaders', { id: 2, url: PHOTON_AVATAR, resourceType: 'image' }))
      .toEqual({ cancel: false, requestHeaders: { Referer: 'https://i0.wp.com/' } });

    // Once the request ends its id is released, so a reused id unwraps again.
    webRequest.listeners.onCompleted({ id: 2, url: PHOTON_AVATAR, resourceType: 'image' });
    expect(invoke(webRequest, 'onBeforeRequest', { id: 2, url: PHOTON_AVATAR, resourceType: 'image' }))
      .toEqual({ cancel: false, redirectURL: DIRECT_AVATAR });
  });

  // Regression: a request that errors out must release its id too, or a long
  // session slowly fills the tracker with dead ids.
  it('releases a redirected id when the request errors out', () => {
    const webRequest = fakeWebRequest();
    installEmailImageRequestHandlers(webRequest as any);

    webRequest.listeners.onBeforeRedirect({ id: 9, url: 'https://example.com/a', resourceType: 'image' });
    webRequest.listeners.onErrorOccurred({ id: 9, url: PHOTON_AVATAR, resourceType: 'image' });
    expect(invoke(webRequest, 'onBeforeRequest', { id: 9, url: PHOTON_AVATAR, resourceType: 'image' }))
      .toEqual({ cancel: false, redirectURL: DIRECT_AVATAR });
  });
});
