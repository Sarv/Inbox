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
    // Pure (zero imports) — the attachment allow-list and viewer classification.
    // The renderer MUST see the same module the `sarv-attachment://` handler
    // uses: if the two ever disagreed about what a file is, the renderer would
    // render something main typed as a different thing. That is the whole reason
    // it is a deep import rather than a renderer copy.
    '@sarvinbox/core/attachment-kind': resolve(
      desktopDir,
      '../../packages/core/src/utils/attachment-kind.ts',
    ),
    // Pure (one type-only import) — the panel bridge's wire format. The frame
    // relay in the renderer MUST parse requests with the same module main
    // validates them with, or a shape one accepts and the other rejects becomes
    // a panel that hangs on a reply that never comes.
    '@sarvinbox/core/panel-bridge': resolve(
      desktopDir,
      '../../packages/core/src/extensions/panel-bridge.ts',
    ),
    // Pure (html-to-text, which is browser-safe) — the chat view decides which
    // mail to render as sent with the SAME predicate the sync layer tags with,
    // so the two can never disagree about what a blast is.
    '@sarvinbox/core/bulk-mail': resolve(
      desktopDir,
      '../../packages/core/src/utils/bulk-mail.ts',
    ),
    // Pure (zero imports) — the catalogue's shelf vocabulary. The Browse tab
    // labels and filters by the SAME list the registry parser folds an author's
    // manifest onto, so a shelf the parser can produce is never one the filter
    // has no name for.
    '@sarvinbox/core/extension-categories': resolve(
      desktopDir,
      '../../packages/core/src/extensions/categories.ts',
    ),
  };
}
