/**
 * Sentry initialization for the Electron RENDERER process.
 *
 * Errors & crashes only. Events are transported to the main process over the
 * IPC bridge set up by `@sentry/electron/preload` (imported in preload.ts) and
 * sent from there, so the DSN/network config in the main process governs
 * delivery. We still pass the DSN here so the renderer SDK enables itself.
 *
 * DSN and version are injected at build time by Vite's `define`
 * (see vite.config.ts). The DSN is public by design. With no DSN configured,
 * Sentry stays completely inert.
 */
import * as Sentry from '@sentry/electron/renderer';

export function initSentryRenderer(): void {
  const dsn = process.env.SARVINBOX_SENTRY_DSN;
  if (!dsn) return; // inert without a DSN

  Sentry.init({
    dsn,
    environment: import.meta.env.DEV ? 'development' : 'production',
    release: `sarvinbox@${process.env.SARVINBOX_APP_VERSION}`,
  });
}
