import { copyFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';


import { injectCspMeta } from './vite/app-csp';
import { browserSafeBuiltinsPlugin } from './vite/browser-safe-builtins';
import { forbidNodeOnlyInRenderer } from './vite/forbid-node-only-renderer';
import {
  linkedCjsDepsToPrebundle,
  linkedDepsToExclude,
  linkedDepsToWatch,
} from './vite/linked-packages';
import { rendererAliases } from './vite/renderer-aliases';

const isProduction = process.env.NODE_ENV === 'production';

const APP_VERSION: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version;
// Sentry groups events by release; keep this string identical in the main and
// renderer SDK config and in the source-map upload below.
const SENTRY_RELEASE = `sarvinbox@${APP_VERSION}`;

// Build-time string replacements shared by the main and renderer bundles.
//  - Google OAuth creds: inlined so a shipped app (which carries no .env) still
//    has Gmail sign-in. Non-confidential per Google's installed-app docs.
//  - Sentry DSN: public by design (safe to embed in a client). ALWAYS defined
//    (empty when unset) so renderer code can read process.env.* without a
//    ReferenceError in the browser, and Sentry stays inert without a DSN.
//  - App version: exposed so the renderer can tag the Sentry release.
// NOT inlined: the Sarv URLs/client, which dev.sh toggles to localhost at
// runtime and which already have hardcoded production defaults for distribution.
function buildDefines(mode: string): Record<string, string> {
  const env = loadEnv(mode, resolve(__dirname, '../..'), 'SARVINBOX');
  const defines: Record<string, string> = {};
  for (const key of ['SARVINBOX_GOOGLE_CLIENT_ID', 'SARVINBOX_GOOGLE_CLIENT_SECRET']) {
    if (env[key]) defines[`process.env.${key}`] = JSON.stringify(env[key]);
  }
  defines['process.env.SARVINBOX_SENTRY_DSN'] = JSON.stringify(env.SARVINBOX_SENTRY_DSN ?? '');
  defines['process.env.SARVINBOX_APP_VERSION'] = JSON.stringify(APP_VERSION);
  return defines;
}

// Upload renderer source maps to Sentry so minified stack traces symbolicate.
// Only runs when SENTRY_AUTH_TOKEN is set (release builds / CI) — a plain local
// build with no token is a no-op, so contributors aren't forced to configure
// Sentry. Requires SENTRY_ORG and SENTRY_PROJECT alongside the token. The maps
// are deleted after upload so they never ship inside the app.
function sentrySourceMapPlugins(): PluginOption[] {
  if (!process.env.SENTRY_AUTH_TOKEN) return [];
  return [
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: { name: SENTRY_RELEASE },
      sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
    }),
  ];
}

// In dev: externalize all deps (fast rebuilds, node_modules accessible)
// In production: only externalize native/electron modules (bundle everything else into asar)
const mainExternals = isProduction
  ? ['electron', 'better-sqlite3']
  : [
      'electron',
      'better-sqlite3',
      '@sarvinbox/core',
      '@sarvinbox/storage-node',
      'imap',
      'mailparser',
      'turndown',
      'zod',
      'date-fns',
    ];

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    electron([
      {
        // Main process entry
        entry: 'electron/main.ts',
        onstart(options) {
          // `INBOX_DEBUG_PORT=9222 pnpm dev:desktop` opens the RENDERER's
          // inspector so a CPU profile can name the function behind a UI
          // stall. Electron only reads the switch from its own argv, and
          // vite-plugin-electron spawns it for us, so the flag has to be
          // threaded through here; `['.', '--no-sandbox']` is the plugin's
          // own default argv, repeated because passing any argv replaces it.
          // Unset, nothing changes: no port is opened in a normal dev run.
          const port = process.env.INBOX_DEBUG_PORT;
          options.startup(
            port ? ['.', '--no-sandbox', `--remote-debugging-port=${port}`] : undefined,
          );
        },
        vite: {
          define: buildDefines(mode),
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: mainExternals,
            },
          },
          plugins: [{
            name: 'copy-schema-sql',
            closeBundle() {
              mkdirSync(resolve(__dirname, 'dist-electron'), { recursive: true });
              copyFileSync(
                resolve(__dirname, '../../packages/storage-node/src/schema.sql'),
                resolve(__dirname, 'dist-electron/schema.sql')
              );
            },
          }],
        },
      },
      {
        // VACUUM worker. A separate entry because it runs on its own thread and
        // is loaded by path at runtime (`new Worker('db-compact.worker.js')`),
        // so it has to exist as its own file beside the main bundle rather than
        // be inlined into it. Same externals: it loads better-sqlite3's native
        // binding, which cannot be bundled.
        entry: 'electron/workers/db-compact.worker.ts',
        onstart() {
          // Deliberately no startup()/reload() — a worker entry rebuilding must
          // not restart the main process or reload the window.
        },
        vite: {
          define: buildDefines(mode),
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: mainExternals,
            },
          },
        },
      },
      {
        // Extension sandbox. Its own entry for the same reason as the VACUUM
        // worker: `utilityProcess.fork` loads it by path at runtime, so it has
        // to exist as its own file beside the main bundle. Same externals — it
        // must resolve `@sarvinbox/core` exactly as main does, or the two ends
        // of the extension protocol could drift apart.
        entry: 'electron/workers/extension-sandbox.worker.ts',
        onstart() {
          // Deliberately no startup()/reload() — this entry rebuilding must not
          // restart the main process or reload the window.
        },
        vite: {
          define: buildDefines(mode),
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: mainExternals,
            },
          },
        },
      },
      {
        // Preload script
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    // MUST precede renderer(): it gives postcss the empty `path`/`fs` its own
    // package.json asks for, beating the Electron plugin's require() shim, which
    // a sandboxed renderer cannot evaluate. See vite/browser-safe-builtins.ts.
    browserSafeBuiltinsPlugin(__dirname),
    renderer(),
    // HARD guard: fail the build if any Node-only module (mailparser / imapflow /
    // nodemailer / better-sqlite3 / …) is pulled into the renderer bundle. Top-
    // level plugins run for the renderer build ONLY, so the Electron main/preload
    // builds (which legitimately use these) are unaffected. This is what stops the
    // "Dynamic require of \"stream\" is not supported" startup crash from shipping.
    forbidNodeOnlyInRenderer(),
    // Inject the app document's Content-Security-Policy (production only).
    // Lives in vite/app-csp.ts — its img-src is load-bearing for the email body
    // iframe, which inherits this policy and can only narrow it.
    injectCspMeta(mode),
    // Keep the Sentry plugin last so it sees the final emitted bundle + maps.
    ...sentrySourceMapPlugins(),
  ],
  define: buildDefines(mode),
  resolve: {
    // Deep-import the renderer-safe SUBPATHS, never the '@sarvinbox/core' barrel
    // (which re-exports imapflow/mailparser/nodemailer and breaks the renderer).
    // Shared with the vitest run and the CI bundle-guard build — see
    // vite/renderer-aliases.ts.
    alias: rendererAliases(__dirname),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Emit renderer source maps so Sentry can symbolicate minified stack
    // traces. sentrySourceMapPlugins() deletes them after upload, so they only
    // ship when no upload happens (local builds without a token).
    sourcemap: true,
    // This is a desktop app — bundles load from local disk, not the network —
    // so the default 500 kB "large chunk" hint is noise. Raise it to keep the
    // build output clean.
    chunkSizeWarningLimit: 3000,
  },
  // Packages installed by `file:` path and edited alongside this app. Without
  // these two, a rebuild of the library is invisible to a running dev server —
  // see vite/linked-packages.ts for why, and why it fails silently.
  optimizeDeps: {
    exclude: linkedDepsToExclude(),
    // ...and the CommonJS packages those linked ones import, which the
    // exclusion above would otherwise leave for the browser to choke on.
    include: linkedCjsDepsToPrebundle(),
  },
  server: {
    port: 5173,
    watch: {
      ignored: linkedDepsToWatch(),
    },
  },
}));
