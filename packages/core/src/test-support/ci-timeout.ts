/**
 * Explicit timeouts for heavy-but-linear tests, sized for the CI runner rather
 * than a laptop.
 *
 * vitest gives each test 5 s. CI runs every package's suite at once, with
 * coverage instrumentation, on a shared runner, and a test there takes many
 * times what it takes locally. Run 43089649771 (PR #116, 2026-11-11/12, both
 * attempts) against a local `pnpm test:coverage` of the same tests, over the
 * 525 that took 30 ms or more locally: median 5.8x slower, 99th percentile
 * 17x, at most 32x (a 34 ms test: on short tests a one-off stall dominates).
 * Over the 266 that took 100 ms or more: at most 15.6x. A test that takes
 * 540 ms locally hit the 5 s limit there.
 *
 * {@link CI_SLOWDOWN} is 25x: above every slowdown measured for a test long
 * enough to come near 5 s, with 1.6x to spare.
 *
 * Measure with `pnpm test:coverage`, not `pnpm test`. Coverage alone made some
 * tests 9x slower: `stripHtmlTags` on 5 MB took 29 ms plain, 260 ms covered,
 * and 2.4 s on CI.
 *
 * This is for work that is heavy because it is big, not for guarding against a
 * slow pattern: a test that exists to catch a quadratic or exponential
 * regression checks the shape of the cost instead (`complexity.ts`).
 */

/** How much slower CI runs a test than a local `pnpm test:coverage` does, at worst. */
export const CI_SLOWDOWN = 25;

/** vitest's own per-test timeout. */
export const DEFAULT_TEST_TIMEOUT_MS = 5_000;

/**
 * The timeout for a test measured at `localMs` under local coverage: that times
 * {@link CI_SLOWDOWN}, rounded up to a whole second and never below vitest's
 * default. Say beside the call what was measured and on what.
 */
export function ciTimeout(localMs: number): number {
  return Math.max(DEFAULT_TEST_TIMEOUT_MS, Math.ceil((localMs * CI_SLOWDOWN) / 1_000) * 1_000);
}
