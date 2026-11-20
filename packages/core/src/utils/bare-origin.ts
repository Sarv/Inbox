/**
 * A URL that is an origin and nothing else: no credentials, no path, no query,
 * no fragment.
 *
 * The check for an address a client appends its own paths to (the Sarv
 * reputation service, an antivirus scanner) and then compares or sends to by
 * origin. `URL.origin` drops the credentials, so `https://user:pw@<allowed>`
 * compares equal on origin alone; a path, query or fragment would be silently
 * thrown away by the same comparison. Both are refused here, before anything
 * is compared or sent.
 *
 * Pure (WHATWG `URL` only), so the renderer's copy of the provider registry
 * can use it too.
 */

/**
 * Whether a parsed `url` carries nothing but its origin. The URL parser has
 * already resolved dot segments (`/..`, `%2e%2e`), and an empty `?` or `#`
 * leaves `search` and `hash` empty, so they count as nothing.
 */
export function isBareOrigin(url: URL): boolean {
  return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
}

/**
 * `value` parsed, when it is an http(s) URL that {@link isBareOrigin}; null for
 * anything else (not a string, empty, not a URL, another scheme, or an origin
 * with credentials, a path, a query or a fragment). Leading and trailing white
 * space is ignored. The scheme rule beyond http(s) (https only, http only for
 * this computer) is the caller's.
 */
export function bareHttpOrigin(value: unknown): URL | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return isBareOrigin(parsed) ? parsed : null;
}
