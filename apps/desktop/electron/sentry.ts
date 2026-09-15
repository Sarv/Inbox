/**
 * Sentry initialization for the Electron MAIN process.
 *
 * Errors & crashes only — no performance tracing, no session replay. Native
 * crashes (renderer/GPU process minidumps) are captured automatically by
 * @sentry/electron. Renderer-process JS errors are routed here over IPC (see
 * the `@sentry/electron/preload` import in preload.ts).
 *
 * All diagnostic context is set HERE in the main process. @sentry/electron
 * synchronizes scope (user, tags, breadcrumbs, contexts) between the main and
 * renderer processes, so identity/tags/breadcrumbs set here are attached to
 * renderer events too — we don't have to duplicate them in the renderer.
 *
 * The DSN comes from SARVINBOX_SENTRY_DSN, baked at build time by Vite's
 * `define` (see vite.config.ts) and also present in process.env in dev via the
 * repo-root .env. A Sentry DSN is public by design (safe to embed in a shipped
 * client). With no DSN configured, Sentry stays completely inert.
 */
import { createHash } from 'crypto';

import { setLogSink, type LogLevel } from '@sarvinbox/core';
import { setSlowQueryReporter, type SlowQueryEvent } from '@sarvinbox/storage-node';
import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';

import { redactSecrets } from './utils/file-logger';

let sentryEnabled = false;

// Slow-query telemetry → Sentry. The DB layer logs anything ≥ 40ms to the
// console (local dev); we only forward the genuinely-bad ones to Sentry, and
// throttle per query label so a heavy user can't flood the quota. captureMessage
// groups by the message, so all occurrences of "Slow query: getSectionByThreads"
// collapse into one issue whose events carry ms / rows / mailbox-size / folder.
const SENTRY_SLOW_QUERY_MS = 150;
const SLOW_QUERY_THROTTLE_MS = 10 * 60 * 1000; // at most once per label / 10 min
const lastSlowQueryReport = new Map<string, number>();

function reportSlowQueryToSentry(e: SlowQueryEvent): void {
  if (!sentryEnabled || e.ms < SENTRY_SLOW_QUERY_MS) return;
  const now = Date.now();
  if (now - (lastSlowQueryReport.get(e.label) ?? 0) < SLOW_QUERY_THROTTLE_MS) return;
  lastSlowQueryReport.set(e.label, now);
  Sentry.captureMessage(`Slow query: ${e.label}`, {
    level: 'warning',
    tags: { slow_query: e.label },
    // All non-PII: timing, counts, and the folder path / filter from meta.
    extra: { ms: e.ms, rows: e.rows, totalEmails: e.totalEmails, ...e.meta },
  });
}

// Transient network blips are logged as breadcrumbs (so the trail is kept) but
// are pure noise as standalone events — they self-heal via the reconnect
// ladder. Drop them from event delivery to keep the issue stream signal-heavy.
const TRANSIENT_ERROR_CODES = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'CONNECTION_ERROR'];

function isTransientConnectionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? '';
  return (
    (typeof code === 'string' && TRANSIENT_ERROR_CODES.includes(code)) ||
    TRANSIENT_ERROR_CODES.some((c) => message.includes(c))
  );
}

// Map our logger levels onto Sentry breadcrumb severities.
const LEVEL_TO_SEVERITY: Record<LogLevel, Sentry.SeverityLevel> = {
  trace: 'debug', // Sentry has no 'trace'; map to its lowest severity
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
};

// Compact, crash-safe stringify for the extra args passed to a log call. We
// never want breadcrumb serialization to throw or balloon, so cap the size.
function summarizeArgs(args: unknown[]): string | undefined {
  if (!args.length) return undefined;
  try {
    const parts = args.map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'object' && a !== null) return JSON.stringify(a);
      return String(a);
    });
    const joined = parts.join(' ');
    // Redact secrets (tokens/passwords/keys/Bearer) BEFORE the breadcrumb leaves
    // the machine — same policy as app.log, reused so the two can't drift.
    const safe = redactSecrets(joined);
    return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
  } catch {
    return undefined;
  }
}

/**
 * Report a FATAL error (uncaughtException / unhandledRejection) to Sentry, then
 * best-effort flush so the event is on its way BEFORE the process may die. Wrapped
 * in try/catch: a crash handler must never throw again. Inert without a DSN.
 * `Sentry.flush` returns a promise — we fire it but don't (can't) await inside a
 * synchronous crash handler; @sentry/electron also persists a native crash report.
 */
export function captureFatal(error: unknown, tag?: string): void {
  try {
    Sentry.captureException(error, tag ? { level: 'fatal', tags: { fatal: tag } } : { level: 'fatal' });
    void Sentry.flush(2000).catch(() => { /* transport may be mid-shutdown */ });
  } catch {
    // Reporting must never crash the crash handler.
  }
}

export function initSentryMain(): void {
  const dsn = process.env.SARVINBOX_SENTRY_DSN;
  if (!dsn) return; // inert without a DSN — nothing is sent

  Sentry.init({
    dsn,
    environment: app.isPackaged ? 'production' : 'development',
    release: `sarvinbox@${app.getVersion()}`,
    // Errors & crashes only.
    tracesSampleRate: 0,
    // Keep a long trail so the full reconnect ladder survives in breadcrumbs
    // (default 100 can be exhausted by a chatty sync burst before a crash).
    maxBreadcrumbs: 300,
    beforeSend(event, hint) {
      if (isTransientConnectionError(hint?.originalException)) return null;
      return event;
    },
  });

  sentryEnabled = true;

  // Tag runtime versions/platform so we can slice issues by build & OS. The
  // OS/device/electron contexts are added automatically by @sentry/electron;
  // these are the app-specific bits worth filtering on.
  Sentry.setTag('electron', process.versions.electron);
  Sentry.setTag('chrome', process.versions.chrome);
  Sentry.setTag('node', process.versions.node);
  Sentry.setTag('arch', process.arch);
  Sentry.setTag('packaged', String(app.isPackaged));
  Sentry.setContext('runtime', {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    packaged: app.isPackaged,
  });

  // Forward every log line into Sentry as a breadcrumb, so a captured error
  // carries the trail that led up to it (IMAP connect/reconnect, sync steps,
  // connection-state transitions, etc.).
  setLogSink((level, name, message, args) => {
    Sentry.addBreadcrumb({
      category: name, // logger name, e.g. 'sarvinbox'
      level: LEVEL_TO_SEVERITY[level],
      message,
      data: args.length ? { args: summarizeArgs(args) } : undefined,
    });
  });

  // Forward slow DB queries (from the storage layer) into Sentry so we get
  // field telemetry on real users' big-mailbox stalls — throttled + gated above.
  // Guarded: a stale/skewed build of the storage layer (dev bundle predating
  // this export) must never crash app STARTUP over a telemetry nicety.
  if (typeof setSlowQueryReporter === 'function') {
    setSlowQueryReporter(reportSlowQueryToSentry);
  }
}

/**
 * Identify which client an event came from, and tag the mailbox it was talking
 * to. Called on every successful IMAP connect. No-op when Sentry is disabled.
 *
 * We DON'T send the raw email address (PII). Instead the user id is a stable,
 * one-way hash of the email — it still groups a given client's events together
 * for support, but the address itself never leaves the machine. Provider + host
 * are infrastructure identifiers (not personal) and are kept for triage.
 */
export function identifyClient(params: {
  email?: string;
  provider?: string;
  host?: string;
  port?: number;
}): void {
  if (!sentryEnabled) return;
  const { email, provider, host, port } = params;

  if (email) {
    const id = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
    Sentry.setUser({ id });
  }
  if (provider) Sentry.setTag('imap.provider', provider);
  if (host) Sentry.setTag('imap.host', host);
  Sentry.setContext('imap', {
    provider: provider ?? 'unknown',
    host: host ?? 'unknown',
    port: port ?? null,
  });
}
