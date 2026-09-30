/**
 * Finding a recipient's public key on the network.
 *
 * Two places are asked, in this order, each only when its setting allows:
 *
 *   1. WKD — the recipient's own mail domain (advanced subdomain first, then
 *      the domain itself, as the draft specifies). That domain receives the
 *      mail anyway, so asking it tells nobody anything new.
 *   2. keys.openpgp.org — a third party. Off unless the user turned it on.
 *
 * A key is only accepted when one of its user IDs carries the address asked
 * about and it can encrypt: a directory that answers with somebody else's key
 * (or a key for a different address) must not become where this person's mail
 * is encrypted to.
 *
 * Every answer is size-bounded (a key server has no business sending a large
 * body) and time-bounded by the injected fetch.
 */
import { fetchBounded, type FetchLike } from '@sarvinbox/core';
import { keyserverUrl, pickEncryptionKey, readAllKeys, wkdUrls } from '@sarvinbox/core/pgp';
import type { PgpKeySource } from '@sarvinbox/core/pgp';

/** Largest key body accepted. Real keys are a few KB; certification-spam keys are not wanted. */
export const MAX_KEY_BYTES = 256 * 1024;

export interface KeyLookupPolicy {
  wkd: boolean;
  keyserver: boolean;
}

export interface DiscoveredKey {
  source: Extract<PgpKeySource, 'wkd' | 'keyserver'>;
  armoredPublicKey: string;
  fingerprint: string;
}

export interface KeyLookupResult {
  key: DiscoveredKey | null;
  /**
   * True when some place that was asked could not answer (network, timeout,
   * server error) — as opposed to answering "no key". A caller caching the
   * outcome keeps a failed lookup only briefly.
   */
  failed: boolean;
}

type Attempt = { key: DiscoveredKey | null; failed: boolean };

async function tryUrl(
  fetch: FetchLike,
  url: string,
  email: string,
  source: DiscoveredKey['source'],
): Promise<Attempt> {
  let body: Uint8Array | null;
  try {
    const fetched = await fetchBounded(fetch, url, MAX_KEY_BYTES);
    body = fetched?.bytes ?? null;
  } catch {
    return { key: null, failed: true };
  }
  if (!body || body.length === 0) return { key: null, failed: false };
  try {
    const keys = await readAllKeys(body);
    const picked = await pickEncryptionKey(keys, email);
    if (!picked) return { key: null, failed: false };
    return {
      key: { source, armoredPublicKey: picked.toPublic().armor(), fingerprint: picked.getFingerprint().toUpperCase() },
      failed: false,
    };
  } catch {
    // Not a key at all (an HTML 200 page from a catch-all host is common).
    return { key: null, failed: false };
  }
}

export async function lookupPublicKey(
  email: string,
  policy: KeyLookupPolicy,
  fetch: FetchLike,
): Promise<KeyLookupResult> {
  let failed = false;
  // [url, source, whether an unreachable host counts as a failure]. Most
  // domains have no `openpgpkey.` subdomain at all, so not reaching the
  // advanced WKD host is the ordinary case, not an outage.
  const attempts: Array<[string, DiscoveredKey['source'], boolean]> = [];
  const wkd = policy.wkd ? wkdUrls(email) : null;
  if (wkd) attempts.push([wkd.advanced, 'wkd', false], [wkd.direct, 'wkd', true]);
  if (policy.keyserver && email.includes('@')) attempts.push([keyserverUrl(email), 'keyserver', true]);
  for (const [url, source, countsFailure] of attempts) {
    const attempt = await tryUrl(fetch, url, email, source);
    failed ||= attempt.failed && countsFailure;
    if (attempt.key) return { key: attempt.key, failed: false };
  }
  return { key: null, failed };
}
