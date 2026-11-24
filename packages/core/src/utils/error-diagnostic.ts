import { errorClassName } from './error-class-name';
import { isTimeoutError } from './timeout';

/**
 * What a failure WAS, with nothing of what it was working on.
 *
 * A caught error's message is not safe to keep or log: an FTS error names the
 * query tokens, a provider error carries the endpoint's response body, and a
 * JSON.parse error quotes the text it choked on. Its class, its machine code and
 * its HTTP status are enough to tell failures apart and describe no mail.
 *
 * Use this at any `catch` that would otherwise swallow the error or record its
 * message, when the record outlives the request (a saved diagnostics object, a
 * log line). See also `errorClassName`, which this builds on.
 */
export interface ErrorDiagnostic {
  /** The error's class (`TypeError`, `SqliteError`), or the type of a non-Error throw. */
  name: string;
  /** A machine code (`ETIMEDOUT`, `SQLITE_BUSY`, `rate_limit_exceeded`), when the error carries one. */
  code?: string;
  /** An HTTP status, when the error carries one. */
  status?: number;
}

// A code is an identifier, not prose. Anything else is dropped rather than
// trusted, since `code` is just a property and a library may put text there.
const CODE = /^[A-Za-z0-9_.:-]{1,48}$/;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,59}$/;

export function errorDiagnostic(error: unknown): ErrorDiagnostic {
  const className = errorClassName(error);
  const name = NAME.test(className) ? className : 'Error';
  if (!error || typeof error !== 'object') return { name };
  const source = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  const rawCode = typeof source.code === 'number' && Number.isSafeInteger(source.code) ? String(source.code) : source.code;
  const rawStatus = source.status ?? source.statusCode;
  return {
    name,
    ...(typeof rawCode === 'string' && CODE.test(rawCode) ? { code: rawCode } : {}),
    ...(typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? { status: rawStatus } : {}),
  };
}

/**
 * Chromium's name for a network failure, as Electron's `net.fetch` reports it:
 * the whole message of a plain Error (`net::ERR_NAME_NOT_RESOLVED`), with no
 * `code` property. It names the failure, never the host.
 */
const CHROMIUM_NET_ERROR = /net::ERR_[A-Z0-9_]{1,64}/;

/**
 * A DOMException's numeric `code` is a legacy constant (an abort carries 20, a
 * timeout 23) that says less than its name (`AbortError`, `TimeoutError`) does.
 * Matched by its tag, which holds across realms where `instanceof` does not.
 */
const isDomException = (error: unknown): boolean => Object.prototype.toString.call(error) === '[object DOMException]';

/**
 * A failure as ONE token for a log line or a user-visible note, and nothing it
 * was working on: `timeout` for a `withTimeout` that lost its race, else the
 * error's machine code (`ETIMEOUT`, `EBUSY`, a child process's exit status),
 * else Chromium's `net::ERR_…` name, else `status <n>`, else its class.
 *
 * A resolver's message names the query (a sender's reversed address, a domain
 * from the mail), Node's file errors quote the path (an attachment's name), and
 * a parse error quotes the text it choked on, so the message is never read
 * beyond Chromium's token. Built on {@link errorDiagnostic}, so a `code` that is
 * prose rather than an identifier is dropped. Use it where a sentence wants one
 * word for why; use `errorDiagnostic` where a record can hold the fields.
 */
export function failureCause(error: unknown): string {
  if (isTimeoutError(error)) return 'timeout';
  const diagnostic = errorDiagnostic(error);
  if (diagnostic.code && !isDomException(error)) return diagnostic.code;
  // Only the token is kept: the rest of the message is not ours to log.
  const chromium = error instanceof Error ? CHROMIUM_NET_ERROR.exec(error.message)?.[0] : undefined;
  if (chromium) return chromium;
  return diagnostic.status !== undefined ? `status ${diagnostic.status}` : diagnostic.name;
}
