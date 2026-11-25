/**
 * Scrub personal data and secrets out of diagnostics: crash/error telemetry
 * before it leaves the device, and the local app.log before it is written.
 *
 * Crash reports (Sentry) carry a trail of log lines and SDK breadcrumbs, and
 * those lines name senders, recipients and fetch URLs. Email addresses taken
 * from a user's mailbox are mailbox data (Google's Limited Use policy covers
 * them for Gmail accounts), so they must not reach a crash-reporting vendor.
 * The shapes here are structural — no Sentry types — so both the Electron main
 * process and the renderer share ONE implementation. The renderer deep-imports
 * this file (`@sarvinbox/core/telemetry-scrub`), so it imports only modules
 * that import nothing themselves (`log-labels`, and its `fnv1a`).
 *
 * Why a regex and not a library: the job is to FIND addresses in free text, not
 * to parse an address header (`email-addresses` does that and can't scan
 * prose), and no maintained scanner is already in the stack. The pattern is
 * bounded — every quantifier has a ceiling and the label class excludes `.` —
 * so it can't backtrack catastrophically, and it errs toward over-matching:
 * redacting a false positive loses nothing, missing an address leaks it.
 */

import { redactAccountIds } from './log-labels';

const EMAIL_RE = /[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

export const REDACTED_EMAIL = '[email]';

/** Replace every email address in `text` with `[email]`. */
export function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL_RE, REDACTED_EMAIL);
}

// The credential names, as one alternation: config keys, OAuth fields (the PKCE
// verifier and a client assertion are as good as the secret they stand for),
// key material (`secretKey`, `privateKey`, a key's `passphrase`) and header
// names. Matched case-insensitively, `_`/`-` optional between words.
const SECRET_NAMES =
  'password|passwd|pass|passphrase|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|' +
  'api[_-]?key|client[_-]?secret|client[_-]?assertion|code[_-]?verifier|secret[_-]?key|private[_-]?key|secret';

// Credential-ish key/value pairs, matched in both JSON (`"password":"x"`) and
// util.inspect (`password: 'x'`) forms, so a stray console.log(config) or an
// error carrying a token can never land in app.log (or a crash report) in
// plaintext. Over-redaction is the safe side here — a log line is not worth a
// leaked secret.
//
// The value is: escaped pairs (`\\.`), any other character except the quote,
// a backslash or a line break, or a lone backslash right before the closing
// quote. The single-character branch must NOT also accept a backslash: when it
// did (`(?:\\.|(?!\2).)*`), every backslash could be read two ways, and an
// unterminated value full of backslashes (`"password":"\\a\\a…`) backtracked
// exponentially — about 3 s of main-thread stall at 40 of them. What matches is
// unchanged (fuzz-compared against the old pattern); only the blow-up is gone.
const SECRET_KV_RE = new RegExp(
  `(["']?(?:${SECRET_NAMES})["']?\\s*[:=]\\s*)(["'\`])(?:\\\\.|(?!\\2)[^\\\\\\n\\r\\u2028\\u2029]|\\\\(?=\\2))*\\2`,
  'gi',
);

// The same pairs inside JSON that was itself put in a JSON string, so every
// quote is escaped: `"body":"{\"access_token\":\"ya29…\"}"` (a provider's
// error body logged inside an object). Up to three backslashes before each
// quote cover one or two levels of nesting. The value is every character up
// to the next escaped quote; a backslash that does not start one (`\/`, as
// some encoders write a slash) stays part of the value. Each character can
// only be read one way and every lookahead is bounded, so it is linear.
const ESCAPED_SECRET_KV_RE = new RegExp(
  `(\\\\{1,3}"(?:${SECRET_NAMES})\\\\{1,3}"\\s*:\\s*\\\\{1,3}")(?:[^\\\\"\\n\\r]|\\\\(?!\\\\{0,3}"))*`,
  'gi',
);

// The same names written without quotes: `access_token=ya29…` in a URL or a
// form body, `password: hunter2` in a library's message. The value runs to the
// next space, separator or quote. A word we write ourselves in place of a
// value (`token=yes`, `password: set`) is not a secret and is left as is.
// An Authorization scheme word (`Bearer`, `Basic`) is not the credential
// either: the rules above already replaced what follows it.
const PLACEHOLDER = '(?:yes|no|true|false|null|undefined|none|set|unset|missing|present|absent|\\[REDACTED\\])(?![^\\s&,;"\'`<>)\\]}])';
const AUTH_SCHEME_WORD = '(?:bearer|basic|digest|ntlm|negotiate|token)\\s';
const UNQUOTED_SECRET_RE = new RegExp(
  `(\\b(?:${SECRET_NAMES})\\s*[:=]\\s*)(?![\\s"'\`]|${PLACEHOLDER}|${AUTH_SCHEME_WORD})[^\\s&,;"'\`<>)\\]}]+`,
  'gi',
);

// Names that are only secret in a URL's query or a form body, where they hold
// an OAuth authorization `code`, an API `key` (Gemini's `?key=`), a request
// `sig`nature or a client `assertion`. Not matched elsewhere: `code` is also
// every error code we log (`code: 'ETIMEDOUT'`).
const QUERY_SECRET_RE = /([?&;](?:code|key|sig|signature|x-amz-signature|x-goog-signature|assertion|state)=)[^&\s#"'`<>]+/gi;

const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
// Every other way an Authorization header carries a credential: `Basic`
// (base64 user:password), `Digest`, `NTLM`, `Negotiate`, a bare `Token`.
const AUTH_SCHEME_RE = /(\bauthorization\b["']?\s*[:=]\s*["']?(?:basic|digest|ntlm|negotiate|token)\s+)[^\s"',;]+/gi;

export const REDACTED_SECRET = '[REDACTED]';

/**
 * Replace secret values with [REDACTED]. The one secret policy for diagnostics:
 * every app.log line (desktop file-logger) and everything a crash report
 * carries (scrubEvent / scrubBreadcrumb, and main's log breadcrumbs) passes
 * through it, so the two can't drift.
 */
export function redactSecrets(s: string): string {
  return s
    .replace(SECRET_KV_RE, (_m, key: string, quote: string) => `${key}${quote}${REDACTED_SECRET}${quote}`)
    .replace(ESCAPED_SECRET_KV_RE, `$1${REDACTED_SECRET}`)
    .replace(AUTH_SCHEME_RE, `$1${REDACTED_SECRET}`)
    .replace(BEARER_RE, `$1${REDACTED_SECRET}`)
    .replace(UNQUOTED_SECRET_RE, `$1${REDACTED_SECRET}`)
    .replace(QUERY_SECRET_RE, `$1${REDACTED_SECRET}`);
}

/**
 * Secrets, then email addresses, then account ids (which spell out an
 * address, see accountLogLabel): what every text in a crash report gets.
 */
export function scrubText(text: string): string {
  return redactAccountIds(redactEmailAddresses(redactSecrets(text)));
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

// Fields holding a URL, by name: navigation breadcrumbs' `from`/`to`, fetch
// breadcrumbs' and the request's `url`, a context's `crashed_url`, a header's
// `Referer`. Their query string and fragment are dropped.
const URL_KEY_RE = /^(?:from|to|href|referr?er|location)$|url$/i;

// Fields whose value is a credential however it is written: config keys
// (password, apiKey, refresh_token, client_secret), header names
// (Authorization, X-Api-Key, Cookie), session ids. Matched anywhere in the
// name, case-insensitively — a false positive only costs a crash report one
// value; a miss sends the secret.
const SECRET_KEY_RE = /pass|token|secret|authori[sz]ation|api[_-]?key|cookie|credential|session[_-]?id/i;

// How deep scrubbing follows nested objects. Sentry has already normalised
// the event to depth 3 by the time beforeSend runs; anything deeper than this
// is replaced by a placeholder rather than sent unscrubbed.
const MAX_DEPTH = 4;

function scrubValue(key: string, value: unknown, depth: number): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (key && SECRET_KEY_RE.test(key)) return REDACTED_SECRET;
  if (typeof value === 'string') return scrubText(URL_KEY_RE.test(key) ? stripUrlQuery(value) : value);
  if (typeof value !== 'object') return value;
  if (depth <= 0) return Array.isArray(value) ? '[Array]' : '[Object]';
  if (Array.isArray(value)) return value.map((v) => scrubValue('', v, depth - 1));
  return scrubRecord(value as Record<string, unknown>, depth - 1);
}

// Fields that hold a URL's query string or fragment on their own, which no
// URL key above sees: Sentry's fetch and XHR breadcrumbs keep `http.query`
// (`?key=…&q=…`) and `http.fragment` beside a `url` it has already cut. They
// are dropped, as the request's `query_string` is: a query carries API keys,
// OAuth codes, search words and addresses, and triage needs the path only.
const QUERY_KEY_RE = /^(?:http\.)?(?:query|fragment)$|^query[_-]?string$/i;

function scrubRecord(record: Record<string, unknown>, depth = MAX_DEPTH): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (QUERY_KEY_RE.test(k)) continue;
    out[k] = scrubValue(k, v, depth);
  }
  return out;
}

export interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * A copy of the breadcrumb with addresses and secrets redacted (in its message
 * and, by value and by field name, all through its data) and URL queries
 * dropped — from its URL fields and as fields of their own (`http.query`).
 */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  const out: T = { ...crumb };
  if (typeof crumb.message === 'string') out.message = scrubText(crumb.message);
  if (crumb.data && typeof crumb.data === 'object') out.data = scrubRecord(crumb.data);
  return out;
}

/** The parts of a Sentry event that can carry personal data or secrets — structural, no Sentry types. */
export interface ScrubbableEvent {
  message?: string;
  logentry?: { message?: string; params?: unknown[] };
  exception?: { values?: Array<{ type?: string; value?: string }> };
  breadcrumbs?: ScrubbableBreadcrumb[];
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    env?: unknown;
    headers?: unknown;
    data?: unknown;
    method?: string;
  };
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  user?: Record<string, unknown>;
}

/**
 * A copy of the event safe to send (CASA L-8). Every text in it — the message
 * and logentry, each exception's type and value, breadcrumbs, the request,
 * contexts, tags and extras — has email addresses and secrets redacted; a
 * field NAMED like a credential (Authorization, Cookie, apiKey, …) loses its
 * value whatever it looks like; URLs lose their query and fragment; the
 * request's cookies, query string and environment are dropped; and the user
 * is reduced to its opaque `id` (no email, username or IP address).
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const out: T = { ...event };
  if (typeof event.message === 'string') out.message = scrubText(event.message);
  if (event.logentry) {
    const { message, params } = event.logentry;
    out.logentry = {
      ...event.logentry,
      ...(typeof message === 'string' ? { message: scrubText(message) } : {}),
      ...(Array.isArray(params) ? { params: params.map((p) => scrubValue('', p, MAX_DEPTH)) } : {}),
    };
  }
  if (event.exception?.values) {
    out.exception = {
      ...event.exception,
      values: event.exception.values.map((v) => ({
        ...v,
        ...(typeof v.type === 'string' ? { type: scrubText(v.type) } : {}),
        ...(typeof v.value === 'string' ? { value: scrubText(v.value) } : {}),
      })),
    };
  }
  if (event.breadcrumbs) out.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  if (event.request) {
    const { query_string: _query, cookies: _cookies, env: _env, ...request } = event.request;
    out.request = scrubRecord(request);
  }
  if (event.contexts) out.contexts = scrubRecord(event.contexts);
  if (event.tags) out.tags = scrubRecord(event.tags);
  if (event.extra) out.extra = scrubRecord(event.extra);
  if (event.user) out.user = typeof event.user.id === 'string' ? { id: event.user.id } : {};
  return out;
}
