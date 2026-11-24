/**
 * The V8 flags the app runs with.
 *
 * `--js-flags` is not only main's: Chromium hands it on to every renderer it starts,
 * the extension sandboxes included. So this heap cap is also how much memory an
 * extension's code can take before it runs out and is stopped.
 *
 * One source for it, because the sandbox-escape harness must run extension code under
 * the same cap the app ships. Without it, the harness's out-of-memory probe filled the
 * default ~3.7 GB heap instead of 2 GB. On a 7 GB macOS CI runner that pushed the
 * machine into swap, and the next sandbox start overran its load timeout about one
 * run in six.
 */

/** Old-space heap limit, in MB, for main and every renderer. */
export const V8_MAX_OLD_SPACE_MB = 2048;

/**
 * The `--js-flags` value: the heap cap, plus anything a caller adds. `extra` must begin
 * with a space.
 */
export function appJsFlags(extra = ''): string {
  return `--max-old-space-size=${V8_MAX_OLD_SPACE_MB}${extra}`;
}
