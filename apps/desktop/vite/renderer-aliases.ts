import { resolve } from 'path';

import type { Alias } from 'vite';


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
function coreSubpathAliases(desktopDir: string): Record<string, string> {
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
    // Pure (zero imports) — the renderer draws registry icons and screenshots
    // from the same CDN mirror the main process fetches registry documents
    // through, so the rewrite rule has to be the one module, not two.
    '@sarvinbox/core/registry-mirror': resolve(
      desktopDir,
      '../../packages/core/src/extensions/registry-mirror.ts',
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
    // Pure (email-addresses + tldts, both browser-safe) — the remote-image
    // allowlist's normalisation and matching. The renderer decides block-vs-load
    // with the SAME module the Security page adds entries with, so an allowance
    // the reader can type is never one the body renderer fails to match.
    '@sarvinbox/core/image-allowlist': resolve(
      desktopDir,
      '../../packages/core/src/utils/image-allowlist.ts',
    ),
    // Pure — the renderer's Sentry filter scrubs with the SAME code as main's,
    // so neither side lets an address through that the other would catch.
    '@sarvinbox/core/telemetry-scrub': resolve(
      desktopDir,
      '../../packages/core/src/utils/telemetry-scrub.ts',
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
    // Pure (zero imports) — what a row in the outbox MEANS. The Outbox screen
    // labels a send with the SAME classifier the main process schedules and
    // cancels by, so "Scheduled" on screen can never be a row the drain treats
    // as an ordinary retry.
    '@sarvinbox/core/send-status': resolve(
      desktopDir,
      '../../packages/core/src/smtp/send-status.ts',
    ),
    // Pure (zero imports) — the List-Unsubscribe parser. The button the reader
    // clicks and the main-process handler that acts on it read the header with
    // the same module: one deciding a one-click POST is allowed while the other
    // disagrees is an unauthenticated write on the reader's behalf.
    '@sarvinbox/core/unsubscribe': resolve(
      desktopDir,
      '../../packages/core/src/utils/unsubscribe.ts',
    ),
    // Pure (zero imports) — the blocklist preferences, read by the Blocklists
    // tab with the SAME function main reads them with, so the ticks a user
    // sees are the lists that are actually queried.
    '@sarvinbox/core/blocklist-prefs': resolve(
      desktopDir,
      '../../packages/core/src/utils/blocklist-prefs.ts',
    ),
    // Pure (zero imports) — the sender-identity policy (BIMI logos, favicons,
    // Gravatar). The General tab's checkboxes and the policy pushed to main
    // are read with the SAME function main normalises with, so "on by
    // default" means on in the checkbox AND in the process doing the lookup.
    '@sarvinbox/core/sender-identity-policy': resolve(
      desktopDir,
      '../../packages/core/src/utils/sender-identity-policy.ts',
    ),
    // Pure (folder-mapping + message-id, both zero-import) — which rows of a
    // thread ARE the conversation, and in what order. The thread view, the
    // message list and the AI view must answer with the SAME predicate main
    // counts, drafts and schedules by, or a draft renders as a sent message in
    // one place and a list row's "(N)" disagrees with the thread it opens.
    '@sarvinbox/core/conversation-membership': resolve(
      desktopDir,
      '../../packages/core/src/utils/conversation-membership.ts',
    ),
    // Pure (fnv1a + message-id) — the first-email split cache's key, validity
    // and retry rules. Main writes the cache and the renderer reads and runs
    // it; two copies of "is this split still current?" would show a stale
    // split or re-run the AI on every open.
    '@sarvinbox/core/first-split': resolve(
      desktopDir,
      '../../packages/core/src/utils/first-split.ts',
    ),
    // Pure (mailguard/quote + html-to-text, both browser-safe, and already in
    // the renderer graph through bulk-mail) — the quote-marker corpus and the
    // marker count the chat view falls back to, shared with contact mining and
    // bulk classification so the corpus never has a second copy.
    '@sarvinbox/core/quoted-text': resolve(
      desktopDir,
      '../../packages/core/src/utils/quoted-text.ts',
    ),
    // Pure (html-to-text, browser-safe, and already in the renderer graph
    // through quoted-text) — the one HTML-to-plain-text conversion. The AI
    // split's no-loss check reads Standard's segments line by line with it.
    '@sarvinbox/core/html-text': resolve(
      desktopDir,
      '../../packages/core/src/utils/html-text.ts',
    ),
    // Pure (zero imports) — the one FNV-1a. The duplicate-message bucket key
    // and the split fingerprint must hash exactly like the read model's.
    '@sarvinbox/core/fnv1a': resolve(
      desktopDir,
      '../../packages/core/src/utils/fnv1a.ts',
    ),
    // Pure (imap-errors -> oauth-errors -> oauth/types; no transports) — the AI
    // failure classifier. A renderer-side AI run must classify transient vs
    // permanent failures exactly as main's categorizer does, or one retries
    // what the other gave up on.
    '@sarvinbox/core/ai-error': resolve(
      desktopDir,
      '../../packages/core/src/utils/ai-error.ts',
    ),
    // Pure (zero imports; guards `process`) — the structured logger, so
    // renderer lines reach app.log with the same `[ts] [LEVEL] [name]` shape as
    // main's instead of raw console output.
    '@sarvinbox/core/logger': resolve(
      desktopDir,
      '../../packages/core/src/utils/logger.ts',
    ),
    // Pure (zero imports) — the OpenPGP lookup / auto-encrypt preferences, read
    // by the Encryption tab with the same function main decides lookups with.
    '@sarvinbox/core/pgp-prefs': resolve(desktopDir, '../../packages/core/src/pgp/prefs.ts'),
  };
}

/**
 * The renderer's resolve aliases, in the order they are matched.
 *
 * Node builtins are NOT handled here. They are browserSafeBuiltinsPlugin()'s
 * job, because `vite-plugin-electron-renderer` resolves them in a `'pre'`
 * `resolveId` hook that outranks Vite's alias plugin outright — see
 * vite/browser-safe-builtins.ts for why an alias entry cannot win that race and
 * what losing it does to the window.
 *
 * @param desktopDir absolute path to apps/desktop (each config passes its own
 *   __dirname-derived location so the relative hops resolve correctly).
 */
export function rendererAliases(desktopDir: string): Alias[] {
  return Object.entries(coreSubpathAliases(desktopDir)).map(([find, replacement]) => ({
    find,
    replacement,
  }));
}
