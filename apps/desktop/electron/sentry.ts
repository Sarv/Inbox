/**
 * Sentry initialization for the Electron MAIN process.
 *
 * Errors only — no performance tracing, no session replay, and no native
 * crash dumps: the minidump integrations are removed (see withoutMinidumps),
 * because a minidump is a snapshot of process memory that can hold message
 * text and tokens, and no beforeSend can scrub it. Renderer-process JS errors
 * are routed here over IPC (see the `@sentry/electron/preload` import in
 * preload.ts).
 *
 * All diagnostic context is set HERE in the main process. @sentry/electron
 * synchronizes scope (user, tags, breadcrumbs, contexts) between the main and
 * renderer processes, so identity/tags/breadcrumbs set here are attached to
 * renderer events too — we don't have to duplicate them in the renderer.
 *
 * Consent (CASA L-8): crash reporting is OFF until the user says yes — asked
 * once on first launch (CrashReportConsentDialog), changeable in Settings →
 * General. Main owns that answer (crash-report-pref.ts). Sentry is still
 * initialised at module load whatever the answer (main.ts relies on it
 * registering its IPC scheme first, and a yes must apply without a restart),
 * but NOTHING leaves the device without a yes: the transport itself is gated
 * (gatedTransport), which also covers what never passes beforeSend — session
 * pings, renderer-forwarded envelopes, client reports, and anything queued
 * offline by an earlier version.
 *
 * Privacy: every event and breadcrumb also passes through filterEvent /
 * filterBreadcrumb — dropped without a yes, otherwise scrubbed of email
 * addresses, secrets and URL query strings everywhere in the event (see
 * telemetry-scrub in core). Mailbox data must never reach Sentry.
 *
 * The DSN comes from SARVINBOX_SENTRY_DSN, baked at build time by Vite's
 * `define` (see vite.config.ts) and also present in process.env in dev via the
 * repo-root .env. A Sentry DSN is public by design (safe to embed in a shipped
 * client). With no DSN configured, Sentry stays completely inert.
 */
import { createHash } from 'crypto';
import { rmSync } from 'fs';
import { join } from 'path';

import { redactSecrets, scrubBreadcrumb, scrubEvent, setLogSink, type LogLevel } from '@sarvinbox/core';
import { setSlowQueryReporter, type SlowQueryEvent } from '@sarvinbox/storage-node';
import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';

import { readCrashReportChoice, writeCrashReportChoice, type CrashReportChoice } from './services/crash-report-pref';

let sentryEnabled = false;
/**
 * The user's crash-report answer, read from disk at startup. Only `yes`
 * sends anything; `no` and `unasked` (never answered) both send nothing.
 */
let choice: CrashReportChoice = 'unasked';

/**
 * Apply and persist the user's answer. Written FIRST: a write that fails
 * throws before anything changes, so the running state never claims a choice
 * the next launch would not see (the caller reports the failure).
 */
export function setCrashReportsEnabled(enabled: boolean): void {
  const next = enabled ? 'yes' : 'no';
  writeCrashReportChoice(next);
  choice = next;
}

/** The user's answer, or `unasked` — what Settings and the consent dialog show. */
export function crashReportChoice(): CrashReportChoice {
  return choice;
}

/** Whether anything may be sent: only after an explicit yes. */
export function crashReportsEnabled(): boolean {
  return choice === 'yes';
}

/**
 * The single filter every outgoing breadcrumb passes through: dropped without
 * a yes, otherwise email addresses and secrets redacted and URL queries
 * stripped. Exported for tests.
 */
export function filterBreadcrumb<T extends Sentry.Breadcrumb>(crumb: T): T | null {
  return crashReportsEnabled() ? scrubBreadcrumb(crumb) : null;
}

/** The single filter every outgoing event passes through. Exported for tests. */
export function filterEvent<T extends Sentry.ErrorEvent>(event: T, originalException?: unknown): T | null {
  if (!crashReportsEnabled()) return null;
  if (isTransientConnectionError(originalException)) return null;
  return scrubEvent(event);
}

// The integrations that capture native crashes as minidumps. SentryMinidump is
// in the SDK's defaults (it starts Crashpad and uploads each dump as an event
// attachment); ElectronMinidump uploads straight from Crashpad, bypassing
// beforeSend entirely. A minidump is raw process memory — message text, tokens
// — that no scrubber can see into, so neither may run.
const MINIDUMP_INTEGRATIONS = new Set(['SentryMinidump', 'ElectronMinidump']);

/** The SDK's integrations minus the minidump ones. Exported for tests. */
export function withoutMinidumps<T extends { name: string }>(integrations: T[]): T[] {
  return integrations.filter((integration) => !MINIDUMP_INTEGRATIONS.has(integration.name));
}

type SentryTransport = ReturnType<typeof Sentry.makeElectronTransport>;

/**
 * Wrap a transport factory so nothing is sent unless `allowed()` says so at
 * send time. Everything the SDK sends — events, session pings, client
 * reports, envelopes forwarded from the renderer — ends in a transport's
 * `send`, which makes this the one gate that covers it all (beforeSend sees
 * events only).
 *
 * Wraps the BASE transport, inside the offline queue: a refused envelope
 * reads as sent, so it is never queued for later, and envelopes queued by an
 * earlier version (captured under its opt-out default) are drained and
 * dropped rather than delivered once the network returns. Exported for tests.
 */
export function gatedTransport<O>(make: (options: O) => SentryTransport, allowed: () => boolean): (options: O) => SentryTransport {
  return (options) => {
    const inner = make(options);
    return {
      ...inner,
      send: (envelope) => (allowed() ? inner.send(envelope) : Promise.resolve({})),
      flush: (timeout) => inner.flush(timeout),
    };
  };
}

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
    // Numbers and flags only: string meta can be a folder path, and folder
    // names are the user's own (often people's names).
    extra: { ms: e.ms, rows: e.rows, totalEmails: e.totalEmails, ...numericMeta(e.meta) },
  });
}

function numericMeta(meta: Record<string, unknown> | undefined): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
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
 * in try/catch: a crash handler must never throw again. Inert without a DSN,
 * and sends nothing without the user's yes (filterEvent + gatedTransport).
 * `Sentry.flush` returns a promise — we fire it but don't (can't) await inside a
 * synchronous crash handler.
 */
export function captureFatal(error: unknown, tag?: string): void {
  try {
    Sentry.captureException(error, tag ? { level: 'fatal', tags: { fatal: tag } } : { level: 'fatal' });
    void Sentry.flush(2000).catch(() => { /* transport may be mid-shutdown */ });
  } catch {
    // Reporting must never crash the crash handler.
  }
}

/**
 * Delete the scope snapshot older versions left behind. The native-crash
 * integration (now never started, see withoutMinidumps) rewrote
 * `userData/sentry/scope_v3.json` — breadcrumbs, tags and the hashed user — on
 * every scope change, readable by other local users (0644). Nothing writes it
 * any more, so nothing would ever remove it. Best-effort.
 */
export function removeStaleSentryScope(userData: string = app.getPath('userData')): void {
  try {
    rmSync(join(userData, 'sentry', 'scope_v3.json'), { force: true });
  } catch {
    // Unreadable folder or a locked file: it stays, as before.
  }
}

export function initSentryMain(): void {
  removeStaleSentryScope();
  // Read the answer even without a DSN, so Settings and the consent dialog
  // show what the user actually chose.
  choice = readCrashReportChoice();
  const dsn = process.env.SARVINBOX_SENTRY_DSN;
  if (!dsn) return; // inert without a DSN — nothing is sent

  Sentry.init({
    dsn,
    environment: app.isPackaged ? 'production' : 'development',
    release: `sarvinbox@${app.getVersion()}`,
    // Errors only.
    tracesSampleRate: 0,
    // No native crash dumps (process memory) — see withoutMinidumps.
    integrations: (defaults) => withoutMinidumps(defaults),
    // Nothing leaves the device without the user's yes — see gatedTransport.
    transport: Sentry.makeElectronOfflineTransport(gatedTransport(Sentry.makeElectronTransport, crashReportsEnabled)),
    // Keep a long trail so the full reconnect ladder survives in breadcrumbs
    // (default 100 can be exhausted by a chatty sync burst before a crash).
    maxBreadcrumbs: 300,
    // Never attach IP address, cookies or other default PII.
    sendDefaultPii: false,
    beforeBreadcrumb: (crumb) => filterBreadcrumb(crumb),
    beforeSend: (event, hint) => filterEvent(event, hint?.originalException),
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
