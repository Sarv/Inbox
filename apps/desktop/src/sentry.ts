/**
 * Sentry initialization for the Electron RENDERER process.
 *
 * Errors & crashes only. Events are transported to the main process over the
 * IPC bridge set up by `@sentry/electron/preload` (imported in preload.ts) and
 * sent from there, so the DSN/network config in the main process governs
 * delivery. We still pass the DSN here so the renderer SDK enables itself.
 *
 * Privacy: the renderer filters too, so its own SDK breadcrumbs (console
 * lines, fetch URLs) are scrubbed before they cross to main, and nothing is
 * captured at all while the user has "Send crash reports" off.
 *
 * DSN and version are injected at build time by Vite's `define`
 * (see vite.config.ts). The DSN is public by design. With no DSN configured,
 * Sentry stays completely inert.
 */
import { scrubBreadcrumb, scrubEvent } from '@sarvinbox/core/telemetry-scrub';
import * as Sentry from '@sentry/electron/renderer';

/**
 * The "Send crash reports" setting as the renderer last saved it. Read per
 * event so a change applies at once. Only an explicit `false` opts out; an
 * unreadable blob keeps the default (on), matching the main process.
 */
export function crashReportsAllowed(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return JSON.parse(storage?.getItem('sarvinbox-settings') ?? 'null')?.crashReports !== false;
  } catch {
    return true;
  }
}

export function initSentryRenderer(): void {
  const dsn = process.env.SARVINBOX_SENTRY_DSN;
  if (!dsn) return; // inert without a DSN

  Sentry.init({
    dsn,
    environment: import.meta.env.DEV ? 'development' : 'production',
    release: `sarvinbox@${process.env.SARVINBOX_APP_VERSION}`,
    sendDefaultPii: false,
    beforeBreadcrumb: (crumb) => (crashReportsAllowed() ? scrubBreadcrumb(crumb) : null),
    beforeSend: (event) => (crashReportsAllowed() ? scrubEvent(event) : null),
  });
}
