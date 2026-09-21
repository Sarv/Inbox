import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FORBIDDEN_RENDERER_PACKAGES,
  forbiddenPackageForId,
} from '../../../vite/forbid-node-only-renderer';

// Regression: the packaged app crashed on startup with "Dynamic require of
// \"stream\" is not supported" because a Node-only module (mailparser, via the
// core barrel) was bundled into the renderer. This guard's matcher is what the
// build-time plugin uses to catch that leak. If the matcher stops recognising a
// forbidden package's module id, the guard goes silent and the crash can ship
// again — so these pin exactly which ids do and do not trip it.

const forbidden = new Set(DEFAULT_FORBIDDEN_RENDERER_PACKAGES);

describe('forbiddenPackageForId — flags Node-only packages in a module id', () => {
  it('flags a flat node_modules path for a forbidden package', () => {
    // The direct case: a renderer chunk importing mailparser's entry.
    const id = '/repo/node_modules/mailparser/lib/mail-parser.js';
    expect(forbiddenPackageForId(id, forbidden)).toBe('mailparser');
  });

  it('flags a pnpm-nested path (last node_modules segment wins)', () => {
    // pnpm hoists into .pnpm/<pkg>@ver/node_modules/<pkg>; naive first-match
    // parsing would read ".pnpm" as the package and miss the leak entirely.
    const id =
      '/repo/node_modules/.pnpm/mailparser@3.7.4/node_modules/mailparser/lib/mail-parser.js';
    expect(forbiddenPackageForId(id, forbidden)).toBe('mailparser');
  });

  it('flags a scoped forbidden package (@zone-eu/mailsplit)', () => {
    // @zone-eu/mailsplit is the module that actually does the dynamic require;
    // scoped names must be reassembled as "@scope/name", not just "@scope".
    const id =
      '/repo/node_modules/.pnpm/@zone-eu+mailsplit@1.0.0/node_modules/@zone-eu/mailsplit/index.js';
    expect(forbiddenPackageForId(id, forbidden)).toBe('@zone-eu/mailsplit');
  });

  it('flags each of the other transport/parse packages', () => {
    // Each of these breaks the renderer the same way; none may slip through.
    for (const pkg of ['imapflow', 'nodemailer', 'better-sqlite3', 'email-reply-parser']) {
      const id = `/repo/node_modules/${pkg}/index.js`;
      expect(forbiddenPackageForId(id, forbidden)).toBe(pkg);
    }
  });

  it('flags the spam scorer\'s freemail corpus', () => {
    // Regression, 2026-09-19: core's bulk-mail.ts is aliased straight into the
    // renderer, and it was re-pointed at the ROOT entry of
    // `@sarv-in/email-spam-scan` — which reaches the header rules, and through
    // them `free-email-domains`, a CommonJS array with no default export. The
    // production build converted it silently; the dev server did not, and the
    // window came up blank. It is not Node-only, so nothing else in this repo
    // would have caught it. The renderer reads a score computed at ingest.
    const id = '/repo/node_modules/free-email-domains/index.js';
    expect(forbiddenPackageForId(id, forbidden)).toBe('free-email-domains');
  });

  it('strips a dev ?v= query before matching', () => {
    // In dev, ids carry an optimizeDeps cache-busting query; it must not defeat
    // the match (so the guard behaves identically on any id shape rollup hands it).
    const id = '/repo/node_modules/imapflow/lib/connection.js?v=abc123';
    expect(forbiddenPackageForId(id, forbidden)).toBe('imapflow');
  });
});

describe('forbiddenPackageForId — leaves renderer-safe ids alone', () => {
  it('does NOT flag an application source file', () => {
    // App code lives outside node_modules and must never trip the guard.
    const id = '/repo/apps/desktop/src/components/email-detail/ThreadChatView.tsx';
    expect(forbiddenPackageForId(id, forbidden)).toBeNull();
  });

  it('does NOT flag a permitted third-party package', () => {
    // libphonenumber-js is renderer-safe and shared with core on purpose.
    const id = '/repo/node_modules/libphonenumber-js/index.es6.js';
    expect(forbiddenPackageForId(id, forbidden)).toBeNull();
  });

  it('does NOT flag the mail-security library or the deps its narrow entries use', () => {
    // The whole point of the entry above: the library itself is renderer-safe,
    // and so is `tldts`, which is all its `/headers`, `/verdict`, `/identity`,
    // `/links` and `/security` entries cost. Only the root entry is off limits,
    // and it is off limits by way of the two packages it alone reaches.
    for (const id of [
      '/repo/node_modules/@sarv-in/email-spam-scan/dist/security.js',
      '/repo/node_modules/@sarv-in/email-spam-scan/dist/headers.js',
      '/repo/node_modules/tldts/dist/es6/index.js',
      // The scorer's OTHER root-only dep, which the renderer imports on
      // purpose in src/utils/email-address.ts. Forbidding it alongside
      // free-email-domains would have failed a build that was always correct.
      '/repo/node_modules/email-addresses/lib/parser.js',
    ]) {
      expect(forbiddenPackageForId(id, forbidden)).toBeNull();
    }
  });

  it('does NOT flag a rollup virtual module', () => {
    // Virtual/generated modules (\0-prefixed) map to no installed package.
    const id = '\0vite/preload-helper';
    expect(forbiddenPackageForId(id, forbidden)).toBeNull();
  });

  it('does NOT flag the renderer-safe contact-enrichment subpath (src, not the barrel)', () => {
    // The whole point of the deep-import alias: this resolves to core SRC, which
    // is pure — it must not look like a node_modules package to the guard.
    const id = '/repo/packages/core/src/contact-enrichment/index.ts';
    expect(forbiddenPackageForId(id, forbidden)).toBeNull();
  });
});
