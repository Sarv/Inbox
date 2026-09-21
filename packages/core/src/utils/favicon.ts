/**
 * A sender domain's favicon — the fallback avatar when a sender has no photo
 * and the domain publishes no BIMI logo.
 *
 * Fetched ONCE per domain by the main process and cached as a `data:` URI;
 * the renderer never talks to the domain. Fetching a favicon tells the domain
 * that some client at this address looked it up, once — far less than the
 * per-message tracking pixel that remote images are, but not nothing, which is
 * why it sits behind a setting. Same injected-fetch shape as the BIMI lookup.
 *
 * Discovery order mirrors what browsers do: the icons the homepage declares
 * (`<link rel="icon">`, `apple-touch-icon`, …), best first, then
 * `/favicon.ico`. That, and the byte sniffing that keeps a 200-with-an-error-
 * page from becoming an avatar, live in `@sarv-in/email-spam-scan/brand`
 * alongside the BIMI lookup they share a fetch with; this module is the seam.
 */
export {
  FAVICON_MAX_BYTES,
  HOMEPAGE_MAX_BYTES,
  extractIconLinks,
  rankIconCandidates,
  sniffImageType,
  faviconHosts,
  discoverFavicon,
} from '@sarv-in/email-spam-scan/brand';

export type {
  IconCandidate,
  FaviconStatus,
  FaviconResult,
  FaviconOptions,
} from '@sarv-in/email-spam-scan/brand';
