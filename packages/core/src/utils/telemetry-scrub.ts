/**
 * Scrub personal data out of crash/error telemetry before it leaves the device.
 *
 * Crash reports (Sentry) carry a trail of log lines and SDK breadcrumbs, and
 * those lines name senders, recipients and fetch URLs. Email addresses taken
 * from a user's mailbox are mailbox data (Google's Limited Use policy covers
 * them for Gmail accounts), so they must not reach a crash-reporting vendor.
 * The shapes here are structural — no Sentry types — so both the Electron main
 * process and the renderer share ONE implementation.
 *
 * Why a regex and not a library: the job is to FIND addresses in free text, not
 * to parse an address header (`email-addresses` does that and can't scan
 * prose), and no maintained scanner is already in the stack. The pattern is
 * bounded — every quantifier has a ceiling and the label class excludes `.` —
 * so it can't backtrack catastrophically, and it errs toward over-matching:
 * redacting a false positive loses nothing, missing an address leaks it.
 */

const EMAIL_RE = /[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

export const REDACTED_EMAIL = '[email]';

/** Replace every email address in `text` with `[email]`. */
export function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL_RE, REDACTED_EMAIL);
}

/**
 * Drop a URL's query string and fragment. Query strings carry API keys
 * (Gemini's `?key=`), search terms and addresses; the path is what triage
 * needs. Non-URL input is returned with addresses redacted.
 */
export function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return redactEmailAddresses(cut === -1 ? url : url.slice(0, cut));
}

const URL_KEYS = new Set(['url', 'from', 'to']);

function scrubValue(key: string, value: unknown, depth: number): unknown {
  if (typeof value === 'string') return URL_KEYS.has(key) ? stripUrlQuery(value) : redactEmailAddresses(value);
  if (depth <= 0 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue('', v, depth - 1));
  return scrubRecord(value as Record<string, unknown>, depth - 1);
}

function scrubRecord(record: Record<string, unknown>, depth = 4): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) out[k] = scrubValue(k, v, depth);
  return out;
}

export interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

/** A copy of the breadcrumb with addresses redacted and URL queries dropped. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  const out: T = { ...crumb };
  if (typeof crumb.message === 'string') out.message = redactEmailAddresses(crumb.message);
  if (crumb.data && typeof crumb.data === 'object') out.data = scrubRecord(crumb.data);
  return out;
}

export interface ScrubbableEvent {
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: ScrubbableBreadcrumb[];
  request?: { url?: string; query_string?: unknown };
  extra?: Record<string, unknown>;
  user?: Record<string, unknown>;
}

/**
 * A copy of the event safe to send: addresses redacted from the message,
 * exception texts, breadcrumbs and extras; request URL without its query; and
 * the user reduced to its opaque `id` (no email, username or IP address).
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const out: T = { ...event };
  if (typeof event.message === 'string') out.message = redactEmailAddresses(event.message);
  if (event.exception?.values) {
    out.exception = {
      ...event.exception,
      values: event.exception.values.map((v) =>
        typeof v.value === 'string' ? { ...v, value: redactEmailAddresses(v.value) } : v),
    };
  }
  if (event.breadcrumbs) out.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  if (event.request) {
    const { query_string: _dropped, ...request } = event.request;
    out.request = typeof request.url === 'string' ? { ...request, url: stripUrlQuery(request.url) } : request;
  }
  if (event.extra) out.extra = scrubRecord(event.extra);
  if (event.user) out.user = typeof event.user.id === 'string' ? { id: event.user.id } : {};
  return out;
}
