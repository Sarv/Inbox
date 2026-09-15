/**
 * "Is the network actually back?" — the gate between a wake and the first
 * outbound request.
 *
 * Waking a laptop does not wake its network: the interface associates and DNS
 * settles over the following 1-3 seconds. Anything fired into that window fails
 * with ENOTFOUND / EAI_AGAIN and burns a retry from whatever ladder it belongs
 * to. For an OAuth token refresh the cost is worse than a wasted retry — a
 * request that leaves during the cold window can still reach a rotating
 * provider, and losing its response costs the whole session.
 *
 * This is a WAIT, never a veto. `net.isOnline()` reports link state, not
 * reachability, so treating a `false` as "do not try" would let one false
 * negative silently stop mail forever. Callers proceed either way; the return
 * value is for logging what we saw.
 */

import { createLogger } from '@sarvinbox/core';
import { net } from 'electron';


const logger = createLogger('network-readiness');

/** How long to wait for the link to come back before giving up and trying anyway. */
export const NETWORK_SETTLE_TIMEOUT_MS = 5_000;
/** Gap between link-state polls. `net.isOnline()` is a cheap synchronous read. */
export const NETWORK_POLL_MS = 250;

/** Seams so the poll loop is testable without Electron or real time. */
export interface NetworkReadinessDeps {
  /** Link state, or null when Electron's net module isn't available. */
  isOnline: () => boolean | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Electron's `net` is absent outside a real Electron main process (unit tests,
 * headless tooling). Returning null means "unknown" — indistinguishable from
 * online for our purposes, so we never block on a missing API.
 */
const defaultIsOnline = (): boolean | null =>
  typeof net?.isOnline === 'function' ? net.isOnline() : null;

const defaultDeps: NetworkReadinessDeps = {
  isOnline: defaultIsOnline,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Resolve once the link reports up, or once `timeoutMs` has elapsed.
 *
 * Returns true if the network looked usable (or its state was unknowable),
 * false if we waited out the timeout still offline. Callers should proceed on
 * false — a genuine offline request fails fast at DNS with no server-side
 * effect, which is strictly safer than not refreshing at all.
 */
export async function waitForNetworkReady(
  timeoutMs: number = NETWORK_SETTLE_TIMEOUT_MS,
  deps: Partial<NetworkReadinessDeps> = {},
): Promise<boolean> {
  const { isOnline, sleep, now } = { ...defaultDeps, ...deps };

  const first = isOnline();
  // null = no API to ask. Unknown is not offline; never stall on it.
  if (first === null || first === true) return true;

  const startedAt = now();
  let waitedMs = 0;
  while (now() - startedAt < timeoutMs) {
    await sleep(NETWORK_POLL_MS);
    waitedMs = now() - startedAt;
    if (isOnline() !== false) {
      logger.info(`[Network] link came back after ${waitedMs}ms`);
      return true;
    }
  }

  logger.warn(
    `[Network] still offline after ${waitedMs}ms — proceeding anyway (link state is a hint, not a veto)`,
  );
  return false;
}
