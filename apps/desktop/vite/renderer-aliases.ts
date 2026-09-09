import { resolve } from 'path';

/**
 * The renderer's resolve aliases, in ONE place.
 *
 * `@sarvinbox/core` publishes no "./contact-enrichment" or "./folder-mapping"
 * export, and — more importantly — its package barrel re-exports Node-only
 * transports (imapflow / mailparser / nodemailer) that crash the renderer. So the
 * renderer deep-imports these two pure subpaths straight from core SRC instead of
 * the barrel. Every renderer build surface (the real vite build, the vitest run,
 * and the CI bundle-guard build) must agree on these aliases, so they live here
 * and are imported by all three rather than copied into each config.
 *
 * @param desktopDir absolute path to apps/desktop (each config passes its own
 *   __dirname-derived location so the relative hops resolve correctly).
 */
export function rendererAliases(desktopDir: string): Record<string, string> {
  return {
    '@': resolve(desktopDir, './src'),
    // Pure (libphonenumber-js only) — shared with core so the one implementation
    // doesn't drift into a second renderer copy.
    '@sarvinbox/core/contact-enrichment': resolve(
      desktopDir,
      '../../packages/core/src/contact-enrichment/index.ts',
    ),
    // Pure (zero imports) — same reasoning.
    '@sarvinbox/core/folder-mapping': resolve(
      desktopDir,
      '../../packages/core/src/config/folder-mapping.ts',
    ),
    // Pure (zero imports) — the renderer coalesces concurrent connects with the
    // same helper the main process uses, rather than a second copy of it.
    '@sarvinbox/core/single-flight': resolve(
      desktopDir,
      '../../packages/core/src/utils/single-flight.ts',
    ),
  };
}
