import { describe, expect, it } from 'vitest';

import {
  redactEmailAddresses,
  scrubBreadcrumb,
  scrubEvent,
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
