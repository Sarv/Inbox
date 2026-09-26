// Fetches the latest published release from the GitHub API. `fetchImpl` is
// injected so tests drive it without a network.
import { LATEST_RELEASE_API } from './download-view.js';

const RELEASE_TIMEOUT_MS = 8000;

/**
 * GitHub's /releases/latest payload, or null when it cannot be had (offline,
 * rate-limited, no published release yet, an unexpected body). Null is not an
 * error to hide: the page shows it as "couldn't reach GitHub" and links to the
 * latest release page instead.
 *
 * `cache: 'no-cache'` revalidates every visit, so a release published a minute
 * ago shows up at once instead of after the browser's cached copy expires.
 */
export const fetchLatestRelease = async (fetchImpl, { timeoutMs = RELEASE_TIMEOUT_MS } = {}) => {
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-cache',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const release = await response.json();
    return Array.isArray(release?.assets) ? release : null;
  } catch {
    // Network failure, timeout or a non-JSON body — all mean "no release to show".
    return null;
  }
};
