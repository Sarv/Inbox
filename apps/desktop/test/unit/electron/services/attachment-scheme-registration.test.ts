import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Where `registerSchemesAsPrivileged` sits in `main.ts` — a source-order guard.
 *
 * Electron does NOT merge repeated privileged-scheme registrations: each call
 * REPLACES the per-privilege scheme lists it names. `@sentry/electron` registers
 * its own `sentry-ipc` scheme during init and, knowing this, Proxies
 * `protocol.registerSchemesAsPrivileged` so every LATER call carries its scheme
 * along — but a call made BEFORE it is simply overwritten.
 *
 * Registering first shipped a renderer launched with
 * `--standard-schemes=sarv-attachment` but
 * `--secure-schemes/--cors-schemes/--fetch-schemes=sentry-ipc`: the attachment
 * scheme kept only the privileges nothing else claimed and lost `secure`,
 * `corsEnabled` and `supportFetchAPI`. `<img>`/`<video>`/the PDF viewer still
 * worked, so the bug looked like "text attachments are broken" — the text pane
 * is the only kind read with `fetch()`, and it failed with a bare
 * "Failed to fetch" before the protocol handler ever ran.
 *
 * There is no runtime assertion that can catch this (the privileges are applied
 * by Chromium at renderer launch, from a process we do not spawn in tests), so
 * the ordering is pinned here against the source itself.
 */

const source = readFileSync(new URL('../../../../electron/main.ts', import.meta.url), 'utf8');

/** The file with `//` and `/* *\/` comments removed, so prose can't match. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('main.ts privileged scheme registration order', () => {
  // Breaks: Sentry's init overwrites our registration, stripping secure /
  // corsEnabled / supportFetchAPI from sarv-attachment, and the viewer's text
  // pane fails with "Failed to fetch" while images and PDFs still work.
  it('registers the attachment scheme AFTER initSentryMain()', () => {
    const sentryAt = code.indexOf('initSentryMain()');
    const registerAt = code.indexOf('registerSchemesAsPrivileged');

    expect(sentryAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(sentryAt);
  });

  // Breaks: Electron only accepts privileged-scheme registration before
  // app.whenReady(), and a scheme registered late silently loses stream/secure —
  // a PDF that never paints and a video that cannot seek, with no error anywhere.
  it('still registers at module scope, before app.whenReady()', () => {
    const registerAt = code.indexOf('registerSchemesAsPrivileged');
    const readyAt = code.indexOf('whenReady()');

    expect(readyAt).toBeGreaterThan(-1);
    expect(registerAt).toBeLessThan(readyAt);
    // Module scope, not nested inside a callback or an if.
    expect(code).toMatch(/^protocol\.registerSchemesAsPrivileged\(/m);
  });

  // Breaks: only one call may name our scheme. A second one elsewhere would
  // replace the first (same Electron semantics as above) and silently drop
  // whichever privileges the other call omitted.
  it('registers privileged schemes exactly once, from the shared privileges object', () => {
    const calls = code.match(/registerSchemesAsPrivileged\(/g) ?? [];

    expect(calls).toHaveLength(1);
    expect(code).toContain('registerSchemesAsPrivileged([ATTACHMENT_SCHEME_PRIVILEGES])');
  });

  // Breaks: the reason for the ordering is invisible, so the next person moving
  // imports or "tidying" startup puts the registration back above Sentry and
  // reintroduces a bug that only shows up on one attachment kind.
  it('keeps the explanation for the ordering next to the call', () => {
    expect(source).toMatch(/AFTER initSentryMain\(\)/);
  });
});
