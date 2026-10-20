/**
 * Sentry initialization for the Electron RENDERER process.
 *
 * Errors only. Events are transported to the main process over the IPC
 * bridge set up by `@sentry/electron/preload` (imported in preload.ts) and
 * sent from there, so the DSN/network config in the main process governs
 * delivery. We still pass the DSN here so the renderer SDK enables itself.
 *
 * Privacy: crash reporting is off until the user says yes (CASA L-8), and the
 * MAIN process owns that answer. The renderer reads it over IPC at boot and
 * whenever it changes (services/crash-report-choice), and captures nothing —
 * no event, no breadcrumb — until main has said yes. Main's transport gate
 * would drop anything anyway; this keeps it from being captured at all. What
 * is captured is scrubbed (addresses, secrets, URL queries) before it
 * crosses to main.
 *
 * DSN and version are injected at build time by Vite's `define`
 * (see vite.config.ts). The DSN is public by design. With no DSN configured,
 * Sentry stays completely inert.
 */
import { scrubBreadcrumb, scrubEvent } from '@sarvinbox/core/telemetry-scrub';
import * as Sentry from '@sentry/electron/renderer';

import { crashReportChoice, loadCrashReportChoice } from './services/crash-report-choice';

/**
 * Whether the renderer may capture: only once main has reported a yes. Read
 * per event, so an answer given in the consent dialog or Settings applies at
 * once. Not yet read, unreadable, `no` and `unasked` all mean no.
 */
export function crashReportsAllowed(): boolean {
  return crashReportChoice() === 'yes';
}

export function initSentryRenderer(): void {
  const dsn = process.env.SARVINBOX_SENTRY_DSN;
  if (!dsn) return; // inert without a DSN

  // Fetch main's answer now; until it arrives (and unless it is yes) the
  // filters below drop everything.
  void loadCrashReportChoice();

  Sentry.init({
    dsn,
    environment: import.meta.env.DEV ? 'development' : 'production',
    release: `sarvinbox@${process.env.SARVINBOX_APP_VERSION}`,
    sendDefaultPii: false,
    beforeBreadcrumb: (crumb) => (crashReportsAllowed() ? scrubBreadcrumb(crumb) : null),
    beforeSend: (event) => (crashReportsAllowed() ? scrubEvent(event) : null),
  });
}
