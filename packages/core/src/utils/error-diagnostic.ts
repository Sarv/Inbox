import { errorClassName } from './error-class-name';

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
