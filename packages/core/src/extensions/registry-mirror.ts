/**
 * The CDN mirror of a registry document, icon or screenshot.
 *
 * Registry documents and their images are plain files in a GitHub repository,
 * and the URLs baked into a registry point at `raw.githubusercontent.com`.
 * That host is not a CDN: it has no edge in much of the world, and a fetch from
 * it can sit until the 20s abort and leave the Extensions panel showing a
 * cached list with a timeout underneath it. jsDelivr serves the same bytes off
 * the same repository from a local point of presence.
 *
 * So this is a rewrite, not a redirect: the caller keeps the canonical URL as
 * the thing it is keyed on — its cache entry, its host allowlist check, its
 * status row — and only ASKS the mirror first, falling back to the canonical
 * host when the mirror does not answer. A mirror that is down, blocked or stale
 * then costs one retry and never a catalogue.
 *
 * Zero imports on purpose: the renderer deep-imports this module (it draws the
 * same icons the main process fetches documents from) and must not drag the
 * Node-only transports in the package barrel along with it.
 */

/** Where the mirror lives. Also in `TRUSTED_REGISTRY_HOSTS`, or nothing would accept it. */
export const REGISTRY_MIRROR_HOST = 'cdn.jsdelivr.net';

/** The host whose files the mirror can serve. */
const MIRRORED_HOST = 'raw.githubusercontent.com';

/**
 * `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>` for a
 * `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, or null when
 * there is no mirror for this URL — anything not on the raw host, and anything
 * missing one of the four parts. Null means "just use what you were given".
 *
 * Note that jsDelivr caches a BRANCH ref for twelve hours, so a registry that
 * publishes through this needs its CI to purge the mirror after it pushes.
 * Nothing here can detect that; the fallback only covers a mirror that fails,
 * not one that answers with yesterday's file.
 */
export function registryMirrorUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== MIRRORED_HOST) return null;

  // `/owner/repo/ref/path...` — the path needs at least one segment of its own,
  // so four parts minimum. A ref with a slash in it (`release/1.x`) cannot be
  // told apart from a path segment here, and would mirror to the wrong file;
  // registries are published from a single-segment ref, and a wrong guess falls
  // back to the canonical host anyway.
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 4) return null;

  const [owner, repo, ref, ...rest] = segments;
  return `https://${REGISTRY_MIRROR_HOST}/gh/${owner}/${repo}@${ref}/${rest.join('/')}`;
}
