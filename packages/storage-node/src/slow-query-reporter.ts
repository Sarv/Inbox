// Injectable sink for slow-query telemetry.
//
// storage-node must NOT depend on Sentry (wrong layer — it also runs in tests
// and could run on mobile). So the DB layer just EMITS a structured slow-query
// event through this tiny registry, and the host app (Electron main) decides
// where it goes: console for local dev, and Sentry for field telemetry from
// real users' big mailboxes (the ones we can't see the logs of). No PII is
// carried — only a query label, timing, row/mailbox counts, and safe meta like
// the folder path.

export interface SlowQueryEvent {
  /** Stable query name, e.g. 'getSectionByThreads' — used to group in Sentry. */
  label: string;
  /** Wall-clock duration in ms. */
  ms: number;
  /** Rows returned (for SELECTs). */
  rows?: number;
  /** Total emails in the DB — captured only on the slow path, to correlate
   *  cost with mailbox size. */
  totalEmails?: number;
  /** Extra non-PII context (folder path, filter, etc.). */
  meta?: Record<string, unknown>;
}

let reporter: ((event: SlowQueryEvent) => void) | null = null;

/** Host app registers where slow-query events go (or null to disable). */
export function setSlowQueryReporter(fn: ((event: SlowQueryEvent) => void) | null): void {
  reporter = fn;
}

/** Emit a slow-query event. Never throws — diagnostics must not break a query. */
export function reportSlowQuery(event: SlowQueryEvent): void {
  if (!reporter) return;
  try {
    reporter(event);
  } catch {
    /* a reporter failure must never affect the caller */
  }
}
