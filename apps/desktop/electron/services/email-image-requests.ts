import { createLogger, selfRefererFor, unwrapProxiedImageUrl } from '@sarvinbox/core';

const logger = createLogger('email-image-requests');

/**
 * Everything that has to happen at the NETWORK layer for the images in an email
 * to appear, and to tell their hosts as little as possible. Every rule below is a
 * workaround for the same structural fact: a mail reader embeds other people's
 * images, and the web platform's defaults for embedded third-party content are
 * written for a website, not a mailbox.
 *
 * They live together, and outside `main.ts`, because each one is a rule about
 * one request and is worth testing as such.
 */

/** The shape of an Electron webRequest detail we actually read. */
interface RequestDetails {
  /** Stable for the whole load, redirect hops included. */
  id?: number;
  url: string;
  resourceType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string[]>;
}

/** Subresource kinds that are email CONTENT rather than app chrome. */
const CONTENT_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

/** Only these two are fetched as pictures, and only they need a referer. */
const IMAGE_RESOURCE_TYPES = new Set(['image', 'media']);

/**
 * Response headers a content response never gets to act on. See
 * {@link strippedResponseHeaders} for the first three and
 * {@link cookielessRequestHeaders} for the cookie pair. Lower case.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'set-cookie',
  'set-cookie2',
]);

/** Every request, for the hooks that have to see the whole session. */
const ALL_URL_FILTER = ['*://*/*'];

/** Image-proxy hosts worth intercepting. Keep in step with `unwrapProxiedImageUrl`. */
export const PROXY_URL_FILTERS = [
  '*://i0.wp.com/*',
  '*://i1.wp.com/*',
  '*://i2.wp.com/*',
  '*://i3.wp.com/*',
];

/**
 * Response headers with Chromium's cross-origin embedding blocks and any cookies
 * removed, or null to leave the response untouched.
 *
 * `Cross-Origin-Resource-Policy: same-origin`/`same-site` is a website telling
 * browsers not to let OTHER sites embed its images. Every image in every email
 * is exactly that embed, so honouring it renders broken pictures across whole
 * newsletters. Limited to the subresource kinds an email body can contain — a
 * document or script response keeps its policy.
 *
 * `Set-Cookie` goes for the reason {@link cookielessRequestHeaders} gives. It has
 * to go here rather than being left unsent later: Chromium saves a response's
 * cookies from the headers this hook returns, redirect hops included (measured on
 * Electron 44).
 */
export function strippedResponseHeaders(details: RequestDetails): Record<string, string[]> | null {
  if (!CONTENT_RESOURCE_TYPES.has(details.resourceType || '')) return null;

  const headers = { ...(details.responseHeaders || {}) };
  let changed = false;
  for (const key of Object.keys(headers)) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      delete headers[key];
      changed = true;
    }
  }
  return changed ? headers : null;
}

/**
 * Request headers with any `Cookie` removed, or null to send them unchanged.
 *
 * The main window has one session for every mailbox, so a `SameSite=None` cookie
 * set by a pixel in one message comes back on the next message from any sender
 * using that host, in any account: a read receipt with an identity attached.
 * Nothing an email is allowed to load needs one. Gmail fetches mail images through
 * a cookieless proxy, so senders' hosts already have to work without them.
 *
 * Limited to the same subresource kinds as {@link strippedResponseHeaders}: the
 * app's own requests keep whatever they are entitled to. There is no request flag
 * for this on an `<img>`, and `credentials` on `net.fetch` does not reach the
 * renderer's requests, so the header is removed here on the way out. That also
 * covers cookies an older version left in the jar.
 */
export function cookielessRequestHeaders(details: RequestDetails): Record<string, string> | null {
  if (!CONTENT_RESOURCE_TYPES.has(details.resourceType || '')) return null;

  const headers = { ...(details.requestHeaders || {}) };
  let changed = false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'cookie') {
      delete headers[key];
      changed = true;
    }
  }
  return changed ? headers : null;
}

/**
 * The direct URL to fetch instead of this one, or null to leave it alone.
 *
 * Mail arrives with images already routed through an image proxy the SENDER
 * chose; going straight to the origin the proxy URL names removes a third party
 * that would otherwise learn which message is open, and a hop we have measured
 * refusing the request. See `unwrapProxiedImageUrl` for what it will and won't
 * unwrap.
 *
 * `alreadyRedirected` says this URL came from a server's `Location` rather than
 * from the mail — see `createRedirectedRequestTracker` for why that has to
 * suppress the rewrite.
 */
export function redirectForImageRequest(
  details: RequestDetails,
  alreadyRedirected = false,
): string | null {
  if (alreadyRedirected) return null;
  if (!IMAGE_RESOURCE_TYPES.has(details.resourceType || '')) return null;
  const direct = unwrapProxiedImageUrl(details.url);
  return direct && direct !== details.url ? direct : null;
}

/** How many in-flight redirected request ids to remember at once. */
const REDIRECT_TRACKER_LIMIT = 512;

/**
 * Remembers which requests have already followed a server redirect.
 *
 * Chromium lets a webRequest listener rewrite a request's URL freely only on
 * the FIRST hop. Once a server has answered a redirect, the network service is
 * already committed to the URL that `Location` named and permits a listener to
 * change it only WITHIN THE SAME ORIGIN; a cross-origin rewrite does not fall
 * back to the server's URL, it fails the whole load with
 * `net::ERR_INVALID_ARGUMENT` — "invalid argument" in the network panel, and a
 * broken image in the mail.
 *
 * Unwrapping an image proxy is cross-origin by definition, so it is only ever
 * safe on a hop the mail itself asked for. Measured case: a Bitbucket avatar
 * 302s to `i0.wp.com/<atlassian-host>/initials/RG-1.png?ssl=1`, and rewriting
 * THAT hop to the Atlassian origin killed the image outright where leaving it
 * alone loads it — the referer rule above is what gets it past the proxy's 429.
 *
 * Ids are forgotten as their requests finish; the cap only bounds the damage if
 * a session somehow stops reporting completions, and dropping the oldest id
 * costs at most one unwrap that should have been skipped.
 */
export function createRedirectedRequestTracker(limit: number = REDIRECT_TRACKER_LIMIT) {
  const redirected = new Set<number>();
  return {
    markRedirected(id: number | undefined): void {
      if (typeof id !== 'number') return;
      if (redirected.size >= limit) {
        const oldest = redirected.values().next().value;
        if (oldest !== undefined) redirected.delete(oldest);
      }
      redirected.add(id);
    },
    hasRedirected(id: number | undefined): boolean {
      return typeof id === 'number' && redirected.has(id);
    },
    forget(id: number | undefined): void {
      if (typeof id === 'number') redirected.delete(id);
    },
    get size(): number {
      return redirected.size;
    },
  };
}

/**
 * Request headers with a `Referer` added, or null to send them unchanged.
 *
 * Email images are marked `referrerpolicy="no-referrer"`, and a packaged build
 * loads from `file://` and sends no referer regardless — and a host that cannot
 * attribute a request commonly refuses it (the reported case answered 429 to a
 * refererless request, permanently, and 200 to the same request carrying any
 * referer at all). The value sent is the image's OWN origin, so the header
 * satisfies that check while carrying nothing the host does not already know:
 * the user, the message and the app stay unnamed, which is what
 * `no-referrer` was there to protect.
 *
 * Never overrides a referer the page set for itself.
 */
export function refererHeadersFor(details: RequestDetails): Record<string, string> | null {
  if (!IMAGE_RESOURCE_TYPES.has(details.resourceType || '')) return null;

  const headers = { ...(details.requestHeaders || {}) };
  if (Object.keys(headers).some((key) => key.toLowerCase() === 'referer')) return null;

  const referer = selfRefererFor(details.url);
  if (!referer) return null;

  headers.Referer = referer;
  return headers;
}

/** The slice of `session.webRequest` these handlers need. */
interface WebRequestLike {
  onBeforeRequest(
    filter: { urls: string[] },
    listener: (details: RequestDetails, callback: (response: { cancel?: boolean; redirectURL?: string }) => void) => void,
  ): void;
  onBeforeSendHeaders(
    filter: { urls: string[] },
    listener: (details: RequestDetails, callback: (response: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void) => void,
  ): void;
  onHeadersReceived(
    filter: { urls: string[] },
    listener: (details: RequestDetails, callback: (response: { cancel?: boolean; responseHeaders?: Record<string, string[]> }) => void) => void,
  ): void;
  onBeforeRedirect(filter: { urls: string[] }, listener: (details: RequestDetails) => void): void;
  onCompleted(filter: { urls: string[] }, listener: (details: RequestDetails) => void): void;
  onErrorOccurred(filter: { urls: string[] }, listener: (details: RequestDetails) => void): void;
}

/** Install one hook, reporting whether it took. A session that lacks an API must not cost the others. */
function tryInstall(label: string, install: () => void): boolean {
  try {
    install();
    return true;
  } catch (err) {
    logger.warn(`[Main] Failed to install ${label}:`, err);
    return false;
  }
}

/**
 * Install every rule on a session. Safe to call once at startup; each hook is
 * installed independently so one unsupported API cannot cost the others — with
 * one deliberate dependency: the proxy unwrapper is only armed when redirect
 * tracking is, because unwrapping without it turns proxied images that arrive
 * via a redirect into hard failures (see `createRedirectedRequestTracker`).
 */
export function installEmailImageRequestHandlers(webRequest: WebRequestLike): void {
  const tracker = createRedirectedRequestTracker();

  const tracking = tryInstall('redirect tracking', () => {
    webRequest.onBeforeRedirect({ urls: ALL_URL_FILTER }, (details) => {
      tracker.markRedirected(details.id);
    });
  });
  tryInstall('redirect tracking cleanup', () => {
    webRequest.onCompleted({ urls: ALL_URL_FILTER }, (details) => tracker.forget(details.id));
  });
  tryInstall('redirect tracking cleanup', () => {
    webRequest.onErrorOccurred({ urls: ALL_URL_FILTER }, (details) => tracker.forget(details.id));
  });

  if (tracking) {
    tryInstall('image-proxy unwrapper', () => {
      webRequest.onBeforeRequest({ urls: PROXY_URL_FILTERS }, (details, callback) => {
        const redirectURL = redirectForImageRequest(details, tracker.hasRedirected(details.id));
        callback(redirectURL ? { cancel: false, redirectURL } : { cancel: false });
      });
    });
  } else {
    logger.warn('[Main] Image-proxy unwrapper disabled: redirect tracking unavailable');
  }

  // Cookies only. An image host can still recognise a returning reader through the
  // HTTP cache's validators: a pixel answering `ETag: "user-42"` with `Cache-Control:
  // no-cache` gets `If-None-Match: "user-42"` back on the next message's load, in any
  // account, and `Last-Modified` works the same way (measured on Electron 44). That
  // lasts until the cache is cleared and the renderer has restarted, because Blink
  // keeps its own copy. Left alone deliberately: forcing no-cache to drop them would
  // refetch every image on every open, which shows the host each open instead.
  tryInstall('image referer and cookie remover', () => {
    webRequest.onBeforeSendHeaders({ urls: ALL_URL_FILTER }, (details, callback) => {
      const withoutCookies = cookielessRequestHeaders(details);
      const requestHeaders =
        refererHeadersFor(withoutCookies ? { ...details, requestHeaders: withoutCookies } : details) ?? withoutCookies;
      callback(requestHeaders ? { cancel: false, requestHeaders } : { cancel: false });
    });
  });

  tryInstall('CORP and Set-Cookie header stripper', () => {
    webRequest.onHeadersReceived({ urls: ALL_URL_FILTER }, (details, callback) => {
      const responseHeaders = strippedResponseHeaders(details);
      callback(
        responseHeaders
          ? { cancel: false, responseHeaders }
          : { cancel: false, responseHeaders: details.responseHeaders },
      );
    });
  });
}
