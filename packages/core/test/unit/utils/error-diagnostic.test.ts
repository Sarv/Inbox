import { describe, expect, it } from 'vitest';

import { errorDiagnostic, failureCause } from '../../../src/utils/error-diagnostic';
import { TimeoutError, withTimeout } from '../../../src/utils/timeout';

const CANARY = 'canary-invoice-4471';

// errorDiagnostic is what a saved diagnostics record or a log line keeps of a
// caught failure. Everything it returns must be safe to store in plaintext.
describe('errorDiagnostic', () => {
  // Breaks: an FTS, provider or parser error's message (query words, response
  // body, mail text) is written into app.log or a copied diagnostics report.
  it('never carries the message, whatever kind of error it is', () => {
    const errors: unknown[] = [
      new Error(`fts5: syntax error near "${CANARY}"`),
      Object.assign(new Error(CANARY), { code: 'SQLITE_ERROR' }),
      Object.assign(new Error(CANARY), { status: 429, code: 'rate_limit_exceeded' }),
      CANARY,
      { message: CANARY, detail: CANARY },
      [CANARY],
    ];
    for (const error of errors) expect(JSON.stringify(errorDiagnostic(error))).not.toContain(CANARY);
  });

  // Breaks: two different failures (a timeout, a rate limit, a busy database)
  // collapse into one indistinguishable "Error" in the saved record.
  it('keeps the class, machine code and HTTP status that tell failures apart', () => {
    class ProviderError extends Error { override name = 'AIProviderApiError'; }
    expect(errorDiagnostic(Object.assign(new ProviderError('x'), { status: 401, code: 'invalid_token' })))
      .toEqual({ name: 'AIProviderApiError', code: 'invalid_token', status: 401 });
    expect(errorDiagnostic(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toEqual({ name: 'Error', code: 'ETIMEDOUT' });
    expect(errorDiagnostic(Object.assign(new Error('x'), { statusCode: 503 }))).toEqual({ name: 'Error', status: 503 });
    expect(errorDiagnostic(Object.assign(new Error('x'), { code: 19 }))).toEqual({ name: 'Error', code: '19' });
    expect(errorDiagnostic(new TypeError('x'))).toEqual({ name: 'TypeError' });
  });

  // Breaks: a library that puts prose in `code`, or a hostile `name`, smuggles
  // content into the record through a field that was assumed to be an identifier.
  it('drops a code, name or status that is not a plain identifier or a real HTTP status', () => {
    expect(errorDiagnostic(Object.assign(new Error('x'), { code: `no such column: ${CANARY} in query` }))).toEqual({ name: 'Error' });
    expect(errorDiagnostic(Object.assign(new Error('x'), { code: 'x'.repeat(49) }))).toEqual({ name: 'Error' });
    expect(errorDiagnostic(Object.assign(new Error('x'), { code: { nested: CANARY } }))).toEqual({ name: 'Error' });
    expect(errorDiagnostic(Object.assign(new Error('x'), { status: 99 }))).toEqual({ name: 'Error' });
    expect(errorDiagnostic(Object.assign(new Error('x'), { status: 600 }))).toEqual({ name: 'Error' });
    expect(errorDiagnostic(Object.assign(new Error('x'), { status: 200.5 }))).toEqual({ name: 'Error' });
    expect(errorDiagnostic(Object.assign(new Error('x'), { status: '500' }))).toEqual({ name: 'Error' });
    const renamed = new Error('x');
    renamed.name = `Failed for ${CANARY}`;
    expect(errorDiagnostic(renamed)).toEqual({ name: 'Error' });
  });

  // Breaks: a native binding that throws a string, null or undefined crashes the
  // catch block that was only trying to record the failure.
  it('describes a non-Error throw by its type without throwing', () => {
    expect(errorDiagnostic('boom')).toEqual({ name: 'string' });
    expect(errorDiagnostic(undefined)).toEqual({ name: 'undefined' });
    expect(errorDiagnostic(null)).toEqual({ name: 'object' });
    expect(errorDiagnostic(42)).toEqual({ name: 'number' });
    expect(errorDiagnostic({ status: 500 })).toEqual({ name: 'object', status: 500 });
  });
});

// failureCause is the one-word form for a sentence: a breaker's warning, a
// Security-page note, "could not mark the file (darwin, EPERM)". It folds the
// reputation stage's and mark-downloaded's private copies into one rule.
describe('failureCause', () => {
  // Breaks: a resolver's message (a sender's reversed address, a domain from
  // the mail), a file error's path (an attachment's name) or a parse error's
  // quoted text reaches app.log through the one word meant to describe it.
  it('never returns any part of the message but Chromium\'s net::ERR_ token', () => {
    const errors: unknown[] = [
      Object.assign(new Error(`queryA ETIMEOUT 4.3.2.1.${CANARY}.zen.spamhaus.org`), { code: 'ETIMEOUT' }),
      Object.assign(new Error(`EBUSY: resource busy or locked, unlink 'C:\\Users\\me\\${CANARY}.pdf'`), { code: 'EBUSY' }),
      new SyntaxError(`Unexpected token < in JSON at position 0: <html>${CANARY}`),
      Object.assign(new Error(`Bad Gateway: ${CANARY}`), { status: 502 }),
      Object.assign(new Error('x'), { code: `no such column: ${CANARY}` }),
      new Error(`fetch to ${CANARY}.example failed: net::ERR_CONNECTION_REFUSED`),
      CANARY,
    ];
    for (const error of errors) expect(failureCause(error)).not.toContain(CANARY);
  });

  // Breaks: two different failures collapse into one word, or the precedence
  // changes (a real code must win over a token in the message, a status over
  // the bare class).
  it('prefers the machine code, then Chromium\'s token, then the status, then the class', () => {
    expect(failureCause(Object.assign(new Error('net::ERR_FAILED'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(failureCause(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('net::ERR_NAME_NOT_RESOLVED');
    expect(failureCause(Object.assign(new Error('x'), { status: 429 }))).toBe('status 429');
    expect(failureCause(Object.assign(new Error('x'), { statusCode: 503 }))).toBe('status 503');
    expect(failureCause(new RangeError('x'))).toBe('RangeError');
    // Lower case, or no name after the prefix, is not Chromium's.
    expect(failureCause(new Error('net::err_failed'))).toBe('Error');
    expect(failureCause(new Error('net::ERR_'))).toBe('Error');
  });

  // Breaks: a child process's exit status (xattr failing with 1) is dropped
  // for the bare class, so "could not mark the file" no longer says how.
  it('keeps a numeric code such as an exit status', () => {
    expect(failureCause(Object.assign(new Error('Command failed: xattr'), { code: 1 }))).toBe('1');
    expect(failureCause(Object.assign(new Error('spawn'), { code: 'EAGAIN' }))).toBe('EAGAIN');
  });

  // Breaks: an aborted or timed-out fetch reads as "20" or "23" (a DOMException's
  // legacy code) instead of saying it was an abort or a timeout.
  it('names a DOMException by its name, not its legacy numeric code', () => {
    expect(failureCause(new DOMException('This operation was aborted', 'AbortError'))).toBe('AbortError');
    expect(failureCause(new DOMException('The operation timed out', 'TimeoutError'))).toBe('TimeoutError');
  });

  // Breaks: a withTimeout that lost its race is logged as "TimeoutError" in one
  // place and "timeout" in another, or not recognised as a timeout at all.
  it('calls a lost withTimeout race "timeout"', async () => {
    const lost = await withTimeout(new Promise(() => {}), 1, `timed out on ${CANARY}`).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(TimeoutError);
    expect(failureCause(lost)).toBe('timeout');
    expect(failureCause({ isTimeout: true })).toBe('timeout');
  });

  // Breaks: a thrown string, null or undefined crashes the catch that only
  // wanted to say why.
  it('describes a non-Error throw by its type', () => {
    expect(failureCause('net::ERR_FAILED')).toBe('string');
    expect(failureCause(undefined)).toBe('undefined');
    expect(failureCause(null)).toBe('object');
  });
});
