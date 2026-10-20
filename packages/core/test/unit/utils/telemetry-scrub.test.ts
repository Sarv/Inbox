import { describe, expect, it } from 'vitest';

import {
  redactEmailAddresses,
  redactSecrets,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  stripUrlQuery,
} from '../../../src/utils/telemetry-scrub';

// Crash reports go to a third party (Sentry). If these helpers stop working,
// sender/recipient addresses from users' mailboxes — Gmail data under Google's
// Limited Use policy — ship off-device in every crash report, which the privacy
// policy says never happens.

describe('redactEmailAddresses', () => {
  // The log lines that leaked: "[AutoSpam] Check failed for sender@test.local".
  it('redacts every address in free text, including plus/dot/quote locals and subdomains', () => {
    expect(redactEmailAddresses('Check failed for sender@test.local: db busy'))
      .toBe('Check failed for [email]: db busy');
    expect(redactEmailAddresses('a.b+tag@mail.example.co.uk, o\'neil@x.io'))
      .toBe('[email], [email]');
    expect(redactEmailAddresses('<Jane Doe> jane@corp.example.com replied'))
      .toBe('<Jane Doe> [email] replied');
  });

  // Over-redaction is fine; mangling non-address text is not.
  it('leaves text without addresses untouched', () => {
    expect(redactEmailAddresses('IMAP connect to imap.gmail.com:993 failed @ 12:00')).toBe(
      'IMAP connect to imap.gmail.com:993 failed @ 12:00',
    );
  });

  // Bounded pattern: a pathological line must not stall the crash path.
  it('stays fast on long pathological input', () => {
    const evil = `${'a'.repeat(50_000)}@${'b-'.repeat(20_000)}`;
    const t = performance.now();
    redactEmailAddresses(evil);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

// Changed deliberately (relocated, assertions unchanged): these six moved here
// from the desktop file-logger suite with redactSecrets itself (CASA L-7), so
// app.log and crash reports share ONE secret policy.
// Breaks if a password / token / bearer reaches app.log or a crash report.
describe('redactSecrets', () => {
  it('redacts credential-ish keys in JSON form', () => {
    const input = '{"password":"hunter2","host":"imap.example.com"}';
    expect(redactSecrets(input)).toBe('{"password":"[REDACTED]","host":"imap.example.com"}');
  });

  it('redacts credential-ish keys in util.inspect form', () => {
    expect(redactSecrets("{ password: 'hunter2', port: 993 }")).toBe(
      "{ password: '[REDACTED]', port: 993 }",
    );
  });

  it.each([
    'password', 'passwd', 'pass', 'access_token', 'accessToken', 'refresh-token',
    'refreshToken', 'id_token', 'token', 'authorization', 'api_key', 'apiKey',
    'client_secret', 'secret',
  ])('redacts the %s field', (key) => {
    expect(redactSecrets(`{"${key}":"leak-me"}`)).not.toContain('leak-me');
  });

  it('redacts a Bearer token anywhere in the line', () => {
    expect(redactSecrets('Authorization header: Bearer ya29.A0ARrdaM-abc_def=='))
      .toBe('Authorization header: Bearer [REDACTED]');
  });

  it('redacts EVERY occurrence, not just the first', () => {
    const out = redactSecrets('{"password":"a","token":"b","note":"keep"}');
    expect(out).not.toContain('"a"');
    expect(out).not.toContain('"b"');
    expect(out).toContain('keep');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Synced 42 emails for me@example.com in 1.2s';
    expect(redactSecrets(text)).toBe(text);
  });

  // Breaks if the value pattern can read a backslash two ways again: an
  // unterminated value full of backslashes backtracked exponentially (~3 s of
  // main-thread stall at 40), on every app.log line and crash report.
  it('stays fast on an unterminated value full of backslashes', () => {
    // 40 backslashes: the old pattern took ~3 s here (and doubled every 1.5
    // more), the bounded one microseconds — so the gap is unmistakable on any
    // machine without hanging the suite when it regresses.
    const t = performance.now();
    redactSecrets(`"password":"${'\\'.repeat(40)}`);
    expect(performance.now() - t).toBeLessThan(500);
  });

  // The ReDoS fix must not change what is redacted: escaped quotes stay inside
  // the value, and a trailing backslash before the quote still closes it.
  it('treats escaped quotes as part of the value', () => {
    expect(redactSecrets('{"password":"a\\"b","host":"h"}')).toBe('{"password":"[REDACTED]","host":"h"}');
    expect(redactSecrets('{"token":"abc\\"}')).toBe('{"token":"[REDACTED]"}');
    expect(redactSecrets('password: "unterminated')).toBe('password: "unterminated');
  });
});

describe('stripUrlQuery', () => {
  // Gemini puts the API key in ?key=; search URLs carry queries and addresses.
  it('drops the query string and fragment and redacts addresses in the path', () => {
    expect(stripUrlQuery('https://generativelanguage.googleapis.com/v1beta/models?key=SECRET'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(stripUrlQuery('https://x.test/a#frag')).toBe('https://x.test/a');
    expect(stripUrlQuery('https://www.gravatar.com/u/me@x.com')).toBe('https://www.gravatar.com/u/[email]');
  });
});

describe('scrubBreadcrumb', () => {
  // Log-line breadcrumbs: message and args both scrubbed; URL keys stripped;
  // nested objects/arrays reached; non-strings preserved.
  it('scrubs message and nested data, and strips URL keys', () => {
    const crumb = {
      category: 'fetch',
      message: 'moveToSpam for x@y.com',
      data: {
        args: 'uid 1 from a@b.com',
        url: 'https://api.test/q?key=k',
        to: '/inbox?q=a@b.com',
        nested: { list: ['c@d.com', 3], n: 5, ok: true, nil: null },
      },
    };
    expect(scrubBreadcrumb(crumb)).toEqual({
      category: 'fetch',
      message: 'moveToSpam for [email]',
      data: {
        args: 'uid 1 from [email]',
        url: 'https://api.test/q',
        to: '/inbox',
        nested: { list: ['[email]', 3], n: 5, ok: true, nil: null },
      },
    });
    expect(crumb.message).toBe('moveToSpam for x@y.com'); // input not mutated
  });

  it('passes through a breadcrumb with no message or data', () => {
    expect(scrubBreadcrumb({ category: 'ui' } as { category: string })).toEqual({ category: 'ui' });
  });
});

describe('scrubEvent', () => {
  // The whole event: message, exception texts, breadcrumbs, request, extras, user.
  it('redacts every text field and reduces the user to its opaque id', () => {
    const out = scrubEvent({
      message: 'failed for a@b.com',
      exception: { values: [{ type: 'Error', value: 'NO [x@y.com] denied' }, { type: 'E' }] },
      breadcrumbs: [{ message: 'from c@d.com' }],
      request: { url: 'app://index.html?u=e@f.com', query_string: 'u=e@f.com' },
      extra: { note: 'g@h.com', ms: 12 },
      user: { id: 'abc123', email: 'me@gmail.com', ip_address: '1.2.3.4' },
    });
    expect(out).toEqual({
      message: 'failed for [email]',
      exception: { values: [{ type: 'Error', value: 'NO [[email]] denied' }, { type: 'E' }] },
      breadcrumbs: [{ message: 'from [email]' }],
      request: { url: 'app://index.html' },
      extra: { note: '[email]', ms: 12 },
      user: { id: 'abc123' },
    });
  });

  it('drops a user with no id entirely and tolerates a minimal event', () => {
    expect(scrubEvent({ user: { email: 'me@x.com' } }).user).toEqual({});
    expect(scrubEvent({ request: {} })).toEqual({ request: {} });
    expect(scrubEvent({})).toEqual({});
  });
});

// CASA L-8: scrubEvent used to cover the message, exception values,
// breadcrumbs, request URL and extras for ADDRESSES only. Everything below is
// a part of a real Sentry event that went out as captured.
describe('scrubEvent — the whole event, addresses AND secrets', () => {
  // Breaks if secrets in the event's own texts reach Sentry: an error whose
  // message quotes a config, a Bearer header in an exception text.
  it('redacts secrets as well as addresses in every text', () => {
    const out = scrubEvent({
      message: 'login {"password":"hunter2"} for a@b.com',
      exception: { values: [{ type: 'AuthError a@b.com', value: 'Authorization: Bearer ya29.tok for c@d.com' }] },
      breadcrumbs: [{ message: "retry token: 'abc123' x@y.com" }],
    });
    expect(out.message).toBe('login {"password":"[REDACTED]"} for [email]');
    expect(out.exception?.values?.[0]).toEqual({ type: 'AuthError [email]', value: 'Authorization: Bearer [REDACTED] for [email]' });
    expect(out.breadcrumbs?.[0].message).toBe("retry token: '[REDACTED]' [email]");
  });

  // Breaks if a captureMessage-style logentry (message + params) is sent raw.
  it('scrubs the logentry message and its params', () => {
    const out = scrubEvent({ logentry: { message: 'sync failed for %s', params: ['jane@example.com', 3, { apiKey: 'k' }] } });
    expect(out.logentry).toEqual({ message: 'sync failed for %s', params: ['[email]', 3, { apiKey: '[REDACTED]' }] });
    expect(scrubEvent({ logentry: { message: 'a@b.com' } }).logentry).toEqual({ message: '[email]' });
    expect(scrubEvent({ logentry: {} }).logentry).toEqual({});
  });

  // Breaks if contexts and tags are copied through unchanged — e.g. a crashed
  // URL with a query, a tag or context value naming an account.
  it('scrubs contexts and tags', () => {
    const out = scrubEvent({
      contexts: {
        electron: { crashed_url: 'app://index.html?account=me@gmail.com#x', crashed_process: 'renderer' },
        imap: { host: 'imap.gmail.com', port: 993, account: 'me@gmail.com' },
        os: { name: 'macOS', version: '15.0' },
      },
      tags: { 'imap.host': 'imap.gmail.com', account: 'me@gmail.com', packaged: 'true', retries: 3 },
    });
    expect(out.contexts).toEqual({
      electron: { crashed_url: 'app://index.html', crashed_process: 'renderer' },
      imap: { host: 'imap.gmail.com', port: 993, account: '[email]' },
      os: { name: 'macOS', version: '15.0' },
    });
    expect(out.tags).toEqual({ 'imap.host': 'imap.gmail.com', account: '[email]', packaged: 'true', retries: 3 });
  });

  // Breaks if the request's headers, body or cookies leave with credentials,
  // or a header's URL keeps its query.
  it('scrubs the request: headers and data by name and value, cookies, query and env dropped', () => {
    const out = scrubEvent({
      request: {
        url: 'https://api.test/v1?key=SECRET',
        method: 'POST',
        headers: { Authorization: 'Basic dXNlcjpwYXNz', 'X-Api-Key': 'k-123', Cookie: 'sid=1', Referer: 'app://x?u=a@b.com', 'User-Agent': 'Electron' },
        data: { email: 'a@b.com', password: 'hunter2', nested: { refresh_token: 'r', note: 'from c@d.com' } },
        cookies: { sid: '1' },
        query_string: 'key=SECRET',
        env: { REMOTE_ADDR: '1.2.3.4' },
      },
    });
    expect(out.request).toEqual({
      url: 'https://api.test/v1',
      method: 'POST',
      headers: { Authorization: '[REDACTED]', 'X-Api-Key': '[REDACTED]', Cookie: '[REDACTED]', Referer: 'app://x', 'User-Agent': 'Electron' },
      data: { email: '[email]', password: '[REDACTED]', nested: { refresh_token: '[REDACTED]', note: 'from [email]' } },
    });
    expect(scrubEvent({ request: { data: 'grant_type=x {"client_secret":"s"} u=a@b.com' } }).request)
      .toEqual({ data: 'grant_type=x {"client_secret":"[REDACTED]"} u=[email]' });
  });

  // Breaks if a value is redacted only when it LOOKS like a secret: under a
  // credential-named field it goes whatever its shape — a number, an object.
  it('redacts any value under a credential-named field, keeping booleans and nulls', () => {
    const out = scrubEvent({ extra: { sessionId: 42, credentials: { user: 'u', pass: 'p' }, hasToken: true, apiKey: null, tokenizer: 'cl100k' } });
    expect(out.extra).toEqual({ sessionId: '[REDACTED]', credentials: '[REDACTED]', hasToken: true, apiKey: null, tokenizer: '[REDACTED]' });
  });

  // Breaks if an object nested deeper than the scrubber follows is sent as
  // is — unscrubbed — instead of being replaced.
  it('replaces what is nested too deep to scrub rather than sending it raw', () => {
    // Strings are scrubbed at any depth; objects four levels below a field are cut.
    const deep = { a: { b: { c: { d: { e: { f: 'x@y.com' } }, s: 'p@q.com' } } } };
    expect(scrubEvent({ extra: deep }).extra).toEqual({ a: { b: { c: { d: { e: '[Object]' }, s: '[email]' } } } });
    expect(scrubEvent({ extra: { a: { b: { c: { d: { e: ['x@y.com'] } } } } } }).extra)
      .toEqual({ a: { b: { c: { d: { e: '[Array]' } } } } });
  });

  // Breaks if scrubbing mutates the event Sentry still holds.
  it('does not mutate its input', () => {
    const event = { contexts: { imap: { account: 'me@gmail.com' } }, tags: { account: 'me@gmail.com' } };
    scrubEvent(event);
    expect(event).toEqual({ contexts: { imap: { account: 'me@gmail.com' } }, tags: { account: 'me@gmail.com' } });
  });
});

describe('scrubText', () => {
  // The one text redaction a crash report gets — both policies, in one call.
  it('redacts secrets and addresses together', () => {
    expect(scrubText('{"token":"t"} for a@b.com')).toBe('{"token":"[REDACTED]"} for [email]');
  });
});
