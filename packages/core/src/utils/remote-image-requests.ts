/**
 * Two repairs for remote images in an email body, both about the REQUEST we
 * make rather than the HTML we render.
 *
 * ## Why a refererless request is refused
 *
 * The email body iframe marks every image `referrerpolicy="no-referrer"`, and a
 * packaged build loads from `file://`, which sends no `Referer` at all whatever
 * that attribute says. A surprising number of image hosts answer a refererless
 * request with a refusal rather than the picture — measured on the URL from the
 * reported bug (a WordPress Photon proxy wrapping an Atlassian avatar):
 *
 *     no Referer                        → 429 Too Many Requests, every time
 *     Referer: https://bitbucket.org/   → 200
 *     Referer: http://localhost:5173/   → 200
 *     Referer: https://example.com/     → 200
 *
 * It is not a rate limit; the status code is simply what that host answers a
 * request it cannot attribute. ANY referer satisfies it — so the one we send is
 * the image's OWN origin, which tells the host nothing it does not already know
 * (it is answering a request for that origin) and leaks nothing about the user,
 * the mail, or the app. That is the whole point: the header is made
 * information-free rather than accurate. Gmail never hits this because it
 * fetches images server-side through its own proxy.
 *
 * ## Why we unwrap an image proxy
 *
 * The same URL showed the other half of the problem: mail arrives with images
 * already routed through a third-party proxy the SENDER chose. Every such load
 * tells that third party which message the reader has open. Where the proxy URL
 * plainly names the origin it wraps, fetching the origin directly is both
 * fewer moving parts and strictly less exposure.
 *
 * Pure string/URL work, no imports — usable from the renderer and the main
 * process alike.
 */

/** Photon's edge hosts. The proxy is `https://i0.wp.com/<origin-host>/<path>?ssl=1`. */
const PHOTON_HOST = /^i[0-3]\.wp\.com$/i;

/**
 * Query parameters Photon itself owns (resizing, quality, the scheme flag).
 * Anything else in the query belongs to the wrapped URL and must survive.
 */
const PHOTON_PARAMS = new Set([
  'ssl', 'w', 'h', 'fit', 'resize', 'crop', 'zoom', 'quality', 'strip', 'lossy',
]);

/** A hostname and nothing else — no port, no credentials, no path tricks. */
const PLAIN_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * The direct URL behind an image-proxy URL, or null when this isn't one (or
 * can't be unwrapped safely).
 *
 * Only unwraps when the proxy says the origin is https (`ssl=1`): without that
 * flag the origin is plain http, and turning an https request into an http one
 * to save a hop is a bad trade.
 */
export function unwrapProxiedImageUrl(url: string): string | null {
  let proxied: URL;
  try {
    proxied = new URL(url);
  } catch {
    return null;
  }
  if (!PHOTON_HOST.test(proxied.hostname)) return null;
  if (proxied.searchParams.get('ssl') !== '1') return null;

  const path = proxied.pathname.replace(/^\//, '');
  const firstSlash = path.indexOf('/');
  if (firstSlash <= 0) return null;

  const host = path.slice(0, firstSlash);
  const rest = path.slice(firstSlash + 1);
  // Rejects `evil.com@real.com`, a bare `localhost`, an embedded port, and an
  // encoded separator — anything that could make the unwrapped URL point
  // somewhere other than the host the proxy path names.
  if (!rest || !PLAIN_HOSTNAME.test(host)) return null;

  let direct: URL;
  try {
    direct = new URL(`https://${host}/${rest}`);
  } catch {
    return null;
  }
  if (direct.hostname.toLowerCase() !== host.toLowerCase()) return null;

  for (const [key, value] of proxied.searchParams) {
    if (!PHOTON_PARAMS.has(key.toLowerCase())) direct.searchParams.append(key, value);
  }
  return direct.toString();
}

/**
 * The `Referer` to send with a remote image request: the image's own origin.
 *
 * Null for anything that isn't an ordinary web URL — our own `sarv-attachment:`
 * and `sarv-inline:` bytes, `data:`, `blob:` — none of which are fetched over
 * the network or care about a referer.
 */
export function selfRefererFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}
