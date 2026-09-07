import { defineConfig } from 'vitest/config';

import { rendererAliases } from './vite/renderer-aliases';

/**
 * Dedicated test config so vitest does NOT load `vite.config.ts`.
 *
 * That config carries the Sentry source-map plugin, which initialises (and
 * emits telemetry) on every run — unwanted, and slow, for a unit-test pass that
 * needs none of the build pipeline.
 *
 * These are pure-function tests over strings; no DOM environment required.
 */
export default defineConfig({
  resolve: {
    // The SAME renderer aliases the real vite build uses, so a module that
    // deep-imports a core subpath resolves identically under test. Shared source:
    // vite/renderer-aliases.ts.
    alias: rendererAliases(__dirname),
  },
  test: {
    // Tests live under test/{unit,integration}/, mirroring the source tree
    // (test/unit/src/** = renderer, test/unit/electron/** = main-process helpers).
    // Keep electron tests to dependency-free logic — the node env has no `electron`.
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
});
