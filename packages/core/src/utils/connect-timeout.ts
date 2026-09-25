/**
 * How long Node may spend on ONE address before it gives up on it and races
 * the next one (its "Happy Eyeballs" implementation, `autoSelectFamily`).
 *
 * Node's default is 250ms, and that default is what makes an OAuth refresh or
 * an IMAP connect fail as `ETIMEDOUT` on a perfectly working link: a host with
 * both an A and an AAAA record is tried address by address, and when the first
 * TCP handshake needs longer than the attempt window — a mobile hotspot, a VPN,
 * a distant endpoint, 300ms is ordinary — Node abandons it and moves on to an
 * IPv6 address that, on a v4-only network, nothing answers. The whole connect
 * then fails in under a second while `curl` to the same URL succeeds, because
 * curl's own attempt window is measured in seconds, not milliseconds.
 *
 * Measured on 2026-09-25 against `https://oauth2.googleapis.com/token`: every
 * request failed `[ETIMEDOUT]` in ~280ms at the 250ms default, and returned a
 * real HTTP response in ~960ms at 2000ms. The symptom in the log was Gmail
 * accounts unable to refresh their token for hours ("Cannot reach OAuth server
 * [ETIMEDOUT]") while mail to a v4-only host kept flowing.
 *
 * 2s is well inside the caller's own request timeouts (the token request
 * allows far more), so a genuinely dead address still loses no real time.
 */
export const AUTO_SELECT_FAMILY_ATTEMPT_MS = 2000;

/** The two `node:net` module functions this reads and writes, injected so the
 *  policy can be tested without touching the process-wide default. */
export interface AutoSelectFamilyControls {
  get: () => number;
  set: (ms: number) => void;
}

export interface AutoSelectFamilyOutcome {
  /** Whether the default was actually raised. */
  changed: boolean;
  from: number;
  to: number;
}

/**
 * Raise the per-address connect attempt window to `attemptMs`, process-wide.
 *
 * Only ever RAISES it: a runtime (or an operator, via `--network-family-
 * autoselection-attempt-timeout`) that already allows more time knows something
 * we do not, and lowering it back is how the ETIMEDOUT returns.
 */
export function raiseAutoSelectFamilyAttemptTimeout(
  controls: AutoSelectFamilyControls,
  attemptMs: number = AUTO_SELECT_FAMILY_ATTEMPT_MS,
): AutoSelectFamilyOutcome {
  const from = controls.get();
  if (!(attemptMs > from)) return { changed: false, from, to: from };
  controls.set(attemptMs);
  return { changed: true, from, to: attemptMs };
}
