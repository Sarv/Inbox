import { resolve } from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import renderer from 'vite-plugin-electron-renderer';


import { forbidNodeOnlyInRenderer } from './forbid-node-only-renderer';
import { rendererAliases } from './renderer-aliases';

const desktop = resolve(__dirname, '..');

/**
 * A FAST, CI-friendly renderer-only build whose sole job is to run the
 * `forbid-node-only-in-renderer` guard against the real renderer graph and fail
 * (non-zero exit) if any Node-only module (mailparser / imapflow / nodemailer /
 * …) has leaked into it — the crash that took a shipped build's startup down.
 *
 * It deliberately OMITS vite-plugin-electron (no main/preload build) and
 * electron-builder (no packaging), so it needs only `pnpm install` and finishes
 * in a couple of seconds. The full `vite build` used for releases carries the
 * same guard; this just moves the tripwire earlier, onto every PR.
 *
 * Output goes to a throwaway, git-ignored dir; the artifact is never used.
 */
export default defineConfig({
  root: desktop,
  plugins: [react(), renderer(), forbidNodeOnlyInRenderer()],
  // Renderer code reads these at build time; define them (empty) so the build
  // doesn't error on an undefined replacement. Values are irrelevant to the guard.
  define: {
    'process.env.SARVINBOX_SENTRY_DSN': '""',
    'process.env.SARVINBOX_APP_VERSION': '"0.0.0-bundle-check"',
    'process.env.SARVINBOX_GOOGLE_CLIENT_ID': '""',
    'process.env.SARVINBOX_GOOGLE_CLIENT_SECRET': '""',
  },
  resolve: { alias: rendererAliases(desktop) },
  build: {
    outDir: resolve(desktop, 'node_modules/.renderer-bundle-check'),
    emptyOutDir: true,
    sourcemap: false,
    // Desktop bundle loads from disk; the size hint is noise here.
    chunkSizeWarningLimit: 5000,
    // No need to minify just to inspect the module graph — keeps the check fast.
    minify: false,
  },
});
