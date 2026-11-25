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

describe('redactSecrets — the forms it used to miss', () => {
  // Breaks if an OAuth token, code or key written WITHOUT quotes (a URL, a form
  // body, a library's message) reaches app.log or a crash report.
  it.each([
    ['https://oauth2.example.com/token?access_token=ya29.SECRET1&x=1', 'ya29.SECRET1'],
    ['grant_type=refresh_token&refresh_token=1//SECRET2&client_id=abc', '1//SECRET2'],
    ['client_secret=SECRET3&code_verifier=SECRET4', 'SECRET3'],
    ['client_secret=SECRET3&code_verifier=SECRET4', 'SECRET4'],
    ['http://127.0.0.1:53682/callback?code=4/0SECRET5&state=STATE6', '4/0SECRET5'],
    ['http://127.0.0.1:53682/callback?code=4/0SECRET5&state=STATE6', 'STATE6'],
    ['https://generativelanguage.googleapis.com/v1/models?key=AIzaSECRET7', 'AIzaSECRET7'],
    ['login failed: password: hunter2SECRET8 rejected', 'hunter2SECRET8'],
    ['Authorization: Basic dXNlcjpTRUNSRVQ5', 'dXNlcjpTRUNSRVQ5'],
    ['authorization=Digest SECRET10', 'SECRET10'],
    ['token=SECRET11; path=/', 'SECRET11'],
  ])('redacts the unquoted value in %s', (input, secret) => {
    expect(redactSecrets(input)).not.toContain(secret);
    expect(redactSecrets(input)).toContain('[REDACTED]');
  });

  // Breaks if key material or a PKCE verifier written as a config field leaks.
  it.each(['code_verifier', 'codeVerifier', 'secretKey', 'secret_key', 'privateKey', 'private-key', 'passphrase', 'client_assertion'])(
    'redacts the quoted %s field',
    (key) => {
      expect(redactSecrets(`{"${key}":"leak-me"}`)).toBe(`{"${key}":"[REDACTED]"}`);
      expect(redactSecrets(`{ ${key}: 'leak-me' }`)).toBe(`{ ${key}: '[REDACTED]' }`);
    },
  );

  // Breaks if a provider's error body logged inside an object (JSON within a
  // JSON string, so every quote is escaped) carries its token out.
  it('redacts credentials in escaped, nested JSON', () => {
    const once = '{"body":"{\\"access_token\\":\\"ya29.NESTED1\\",\\"expires_in\\":3599}"}';
    const out = redactSecrets(once);
    expect(out).not.toContain('NESTED1');
    expect(out).toContain('\\"expires_in\\":3599');
    const twice = '"{\\\\\\"refresh_token\\\\\\":\\\\\\"1//NESTED2\\\\\\"}"';
    expect(redactSecrets(twice)).not.toContain('NESTED2');
    // A slash some encoders escape stays inside the value, so the rest of it is redacted too.
    expect(redactSecrets('{\\"id_token\\":\\"abc\\/NESTED3\\"}')).not.toContain('NESTED3');
  });

  // Breaks if the wider rules eat the words our own lines write in place of a
  // secret, or an error code, making app.log useless for triage.
  it('keeps placeholders, error codes and ordinary words', () => {
    const text = 'mirror token=yes isGmail=true; token: no; password: set; { name: \'Error\', code: \'ETIMEDOUT\' } exit code=1 bypass=2 prompt_tokens=120';
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [REDACTED]');
  });

  // Breaks if a hostile line (a server's message, a long header) stalls the
  // main thread in the logger: every line of the app passes through here.
  it('stays linear on long adversarial input', () => {
    const inputs = [
      `\\"password\\":\\"${'\\'.repeat(100_000)}`,
      `password=${'a'.repeat(200_000)}`,
      `${'password: '.repeat(20_000)}x`,
      `?code=${'&code='.repeat(20_000)}`,
      `authorization: basic ${' '.repeat(100_000)}x`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      redactSecrets(input);
      expect(performance.now() - started).toBeLessThan(2000);
    }
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

  // Breaks if a fetch/XHR breadcrumb ships the query string Sentry keeps beside
  // the URL it already cut (`http.query`: API keys, OAuth codes, search words),
  // which the privacy policy says is stripped.
  it('drops http.query and http.fragment, which hold a URL query of their own', () => {
    const crumb = {
      category: 'fetch',
      data: {
        method: 'GET',
        url: 'https://generativelanguage.googleapis.com/v1/models',
        'http.query': '?key=AIzaSECRET&q=invoice%20acme',
        'http.fragment': '#access_token=ya29.SECRET',
        status_code: 200,
        nested: { query: 'from:boss@example.com', query_string: 'a=b' },
      },
    };
    const out = scrubBreadcrumb(crumb);
    expect(out.data).toEqual({
      method: 'GET',
      url: 'https://generativelanguage.googleapis.com/v1/models',
      status_code: 200,
      nested: {},
    });
    expect(JSON.stringify(out)).not.toContain('SECRET');
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

describe('scrubText — account ids', () => {
  // Breaks if a log-line breadcrumb carries an account id (acct-<local part>-
  // <domain>--<host>) to Sentry, spelling out the owner's address.
  it('replaces account ids with their label', () => {
    const out = scrubText('[Backfill] skipping acct-jane-doe-example-com--imap-example-com — churning');
    expect(out).not.toContain('jane-doe');
    expect(out).toMatch(/skipping acct#[0-9a-f]{8} — churning/);
  });
});

describe('scrubText', () => {
  // The one text redaction a crash report gets — both policies, in one call.
  it('redacts secrets and addresses together', () => {
    expect(scrubText('{"token":"t"} for a@b.com')).toBe('{"token":"[REDACTED]"} for [email]');
  });
});
