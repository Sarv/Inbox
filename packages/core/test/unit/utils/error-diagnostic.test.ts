import { describe, expect, it } from 'vitest';

import { errorDiagnostic } from '../../../src/utils/error-diagnostic';

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
