import { resolve } from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import renderer from 'vite-plugin-electron-renderer';


import { browserSafeBuiltinsPlugin } from './browser-safe-builtins';
import { buildDefines, loadBuildEnv } from './build-defines';
import { forbidNodeOnlyInRenderer } from './forbid-node-only-renderer';
import { forbidSecretsInRenderer, rendererForbiddenSecrets } from './forbid-secrets-in-renderer';
import { rendererAliases } from './renderer-aliases';

const desktop = resolve(__dirname, '..');

/**
 * A FAST, CI-friendly renderer-only build whose sole job is to run the renderer
 * guards against the real renderer graph and fail (non-zero exit) if:
 *  - any Node-only module (mailparser / imapflow / nodemailer / …) has leaked
 *    into it — the crash that took a shipped build's startup down; or
 *  - it carries a Google OAuth client secret (CASA I-3) — the configured value
 *    when this machine has one, and any "GOCSPX-" string always, which is all
 *    CI can check because the guard job runs without secrets.
 *
 * It deliberately OMITS vite-plugin-electron (no main/preload build) and
 * electron-builder (no packaging), so it needs only `pnpm install` and finishes
 * in a couple of seconds. The full `vite build` used for releases carries the
 * same guards; this just moves the tripwire earlier, onto every PR.
 *
 * Output goes to a throwaway, git-ignored dir; the artifact is never used.
 */
export default defineConfig(({ mode }) => {
  const env = loadBuildEnv(mode, resolve(desktop, '../..'));
  return {
    root: desktop,
    // browserSafeBuiltinsPlugin MUST precede renderer() — see browser-safe-builtins.ts.
    plugins: [
      react(),
      browserSafeBuiltinsPlugin(desktop),
      renderer(),
      forbidNodeOnlyInRenderer(),
      forbidSecretsInRenderer(rendererForbiddenSecrets(env)),
    ],
    // The release renderer's own define map, from the same table, so this build
    // inlines exactly what the real one would — and so the secret guard would
    // see it if that table ever handed the renderer a secret.
    define: buildDefines('renderer', { env, mode, appVersion: '0.0.0-bundle-check' }),
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
  };
});
