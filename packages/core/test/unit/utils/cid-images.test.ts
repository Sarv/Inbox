import { describe, expect, it, vi } from 'vitest';

import { hasCidRefs, resolveCidImages, type CidImagePart } from '../../../src/utils/cid-images';

// The user-visible bug this file protects: ONE broken image inside an email that
// renders perfectly in Gmail. mailparser rewrites `cid:` references to `data:`
// URIs for us, but only when the part's type matches its own `/^image\/[\w]+$/`
// — so `image/x-png`, `image/x-icon`, an octet-stream part with an image
// filename, and an unquoted `src=cid:x>` attribute are all left in the HTML.
// Nothing downstream can serve a `cid:` URL, so the body iframe's CSP drops it
// silently: no banner, no log line, no error. If these tests fail, that silent
// broken image is back.

/** Bytes of a 1x1 PNG — content is irrelevant, only that it round-trips. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B64 = PNG_BYTES.toString('base64');

/** A part the way `shapeParsedBody` hands them over. */
const part = (over: Partial<CidImagePart> = {}): CidImagePart => ({
  cid: 'logo@sender.example',
  contentType: 'image/png',
  filename: 'logo.png',
  toBase64: () => PNG_B64,
  ...over,
});

const img = (src: string) => `<p>hi</p><img src="${src}" width="40">`;

describe('hasCidRefs', () => {
  // Breaks: the cheap pre-test misses a reference, so resolveCidImages returns
  // early and the repair never runs at all — for EVERY form below.
  it('recognises every form a sender writes a cid reference in', () => {
    expect(hasCidRefs('<img src="cid:logo@x">')).toBe(true);
    expect(hasCidRefs("<img src='cid:logo@x'>")).toBe(true);
    expect(hasCidRefs('<img src=cid:logo@x>')).toBe(true);
    expect(hasCidRefs('<div style="background:url(cid:logo@x)">')).toBe(true);
    expect(hasCidRefs('<img SRC="CID:LOGO@X">')).toBe(true);
  });

  // Breaks: every plain mail pays for a pointless re-parse, and (via
  // email-handlers) re-downloads its whole source from IMAP on every open.
  it('is false for mail with no reference, and for null/empty bodies', () => {
    expect(hasCidRefs('<img src="https://cdn.example/logo.png">')).toBe(false);
    expect(hasCidRefs('<img src="data:image/png;base64,AAA">')).toBe(false);
    expect(hasCidRefs(null)).toBe(false);
    expect(hasCidRefs(undefined)).toBe(false);
    expect(hasCidRefs('')).toBe(false);
  });

  // Breaks: prose gets rewritten. A support mail explaining "use cid:something"
  // is not a reference, and turning its text into a data: URI corrupts the body.
  it('ignores a bare "cid:" written in prose', () => {
    expect(hasCidRefs('<p>Reference it as cid:logo@x in the HTML.</p>')).toBe(false);
  });

  // Breaks: the global regex carries lastIndex between calls, so the SECOND
  // identical question answers differently — the classic /g/ .test() bug.
  it('answers the same on repeated calls', () => {
    const html = '<img src="cid:logo@x">';
    expect(hasCidRefs(html)).toBe(true);
    expect(hasCidRefs(html)).toBe(true);
    expect(hasCidRefs(html)).toBe(true);
  });
});

describe('resolveCidImages — types mailparser refuses', () => {
  // Breaks: the exact reported symptom returns. Every one of these is a real
  // sender-declared type that mailparser's `image/[\w]+` test rejects, leaving
  // a broken image where Gmail shows the picture.
  it.each([
    ['image/x-png', 'logo.png'],
    ['image/x-icon', 'favicon.ico'],
    ['image/vnd.microsoft.icon', 'favicon.ico'],
    ['image/jpeg; name="avatar.jpg"', 'avatar.jpg'],
  ])('resolves a part declared %s', (contentType, filename) => {
    const html = img('cid:logo@sender.example');
    const out = resolveCidImages(html, [part({ contentType, filename })]);
    expect(out).toContain(`data:${contentType.split(';')[0]};base64,${PNG_B64}`);
    expect(out).not.toContain('cid:');
  });

  // Breaks: Outlook's habit of typing an inline image `application/octet-stream`
  // leaves it broken. The filename is the only remaining evidence of its type,
  // and it is checked against the app's own extension allow-list, not sniffed.
  it('falls back to the filename when the declared type is a container', () => {
    const out = resolveCidImages(img('cid:logo@sender.example'), [
      part({ contentType: 'application/octet-stream', filename: 'logo.png' }),
    ]);
    expect(out).toContain(`data:image/png;base64,${PNG_B64}`);
  });

  // Breaks: an SVG part becomes a data: URI inside the ONE frame that renders
  // sender-authored markup. DELIBERATE LIMITATION, not an oversight — an SVG is
  // an active-content document and mailparser already declined it. Remove this
  // only together with a decision about how to neutralise scripts in it.
  it('leaves image/svg+xml unresolved on purpose', () => {
    const html = img('cid:logo@sender.example');
    expect(resolveCidImages(html, [part({ contentType: 'image/svg+xml', filename: 'logo.svg' })])).toBe(html);
    // …including when only the filename says svg.
    expect(
      resolveCidImages(html, [part({ contentType: 'application/octet-stream', filename: 'logo.svg' })]),
    ).toBe(html);
  });
});

describe('resolveCidImages — reference forms', () => {
  // Breaks: mailparser's own `[^'"\s]{1,256}` swallows the closing `>` into the
  // reference, so an unquoted attribute matches no part. Ours must stop at it —
  // and must not eat the `>` either, or the tag is destroyed.
  it('handles the unquoted src=cid:x> form without eating the tag', () => {
    const out = resolveCidImages('<img src=cid:logo@sender.example><p>after</p>', [part()]);
    expect(out).toBe(`<img src=data:image/png;base64,${PNG_B64}><p>after</p>`);
  });

  // Breaks: half the forms in real mail go unrepaired. Each delimiter must be
  // preserved exactly — dropping a quote would break out of the attribute.
  it.each([
    ['double quotes', '<img src="cid:logo@sender.example">', '<img src="URI">'],
    ['single quotes', "<img src='cid:logo@sender.example'>", "<img src='URI'>"],
    ['a CSS url()', '<td background="x" style="background:url(cid:logo@sender.example)">', '<td background="x" style="background:url(URI)">'],
    ['a quoted CSS url()', '<div style=\'background:url("cid:logo@sender.example")\'>', '<div style=\'background:url("URI")\'>'],
  ])('rewrites %s in place', (_name, html, shape) => {
    expect(resolveCidImages(html, [part()])).toBe(
      shape.replace('URI', `data:image/png;base64,${PNG_B64}`),
    );
  });

  // Breaks: the common `Content-ID: <logo@x>` header form never matches, because
  // the angle brackets are part of the header syntax and not of the reference.
  it('matches a Content-ID wrapped in angle brackets, case-insensitively', () => {
    const out = resolveCidImages(img('cid:LOGO@Sender.Example'), [part({ cid: '<logo@sender.example>' })]);
    expect(out).toContain('data:image/png;base64,');
  });

  // Breaks: a reference carrying a stray `%` (not a valid escape) throws out of
  // decodeURIComponent and takes the whole parse down with it — losing the body,
  // not just the image.
  it('survives a reference with a malformed percent escape', () => {
    const html = img('cid:logo%zz@sender.example');
    expect(resolveCidImages(html, [part()])).toBe(html);
    expect(resolveCidImages(html, [part({ cid: 'logo%zz@sender.example' })])).toContain('data:image/png');
  });

  // Breaks: RFC 2392 allows percent-encoding in a cid URL, and a sender that
  // escapes the `@` gets a broken image.
  it('matches a percent-encoded reference', () => {
    const out = resolveCidImages(img('cid:logo%40sender.example'), [part()]);
    expect(out).toContain('data:image/png;base64,');
  });
});

describe('resolveCidImages — what it must NOT touch', () => {
  // Breaks: a reference to a part that isn't in the message gets rewritten to
  // something bogus. Leaving it alone keeps a genuinely broken message looking
  // broken instead of hiding the sender's mistake behind our own.
  it('leaves a reference that names no part exactly as it was', () => {
    const html = img('cid:missing@sender.example');
    expect(resolveCidImages(html, [part()])).toBe(html);
  });

  // Breaks: a PDF or a calendar part gets inlined as if it were a picture.
  it('leaves a reference to a non-image part alone', () => {
    const html = img('cid:logo@sender.example');
    expect(resolveCidImages(html, [part({ contentType: 'application/pdf', filename: 'invoice.pdf' })])).toBe(html);
  });

  // Breaks: every body is rebuilt on every parse. The identity return is what
  // keeps this off the hot path for the ~99% of mail with no leftover refs.
  it('returns the very same string when there is nothing to do', () => {
    const html = '<p>plain</p>';
    expect(resolveCidImages(html, [part()])).toBe(html);
    expect(resolveCidImages(img('cid:logo@x'), [])).toBe(img('cid:logo@x'));
    expect(resolveCidImages('', [part()])).toBe('');
  });

  // Breaks: a signature logo quoted twenty deep in a thread base64s its part
  // twenty times — megabytes of copying on the sync path, per message.
  it('encodes a repeated reference only once', () => {
    const toBase64 = vi.fn(() => PNG_B64);
    const html = `${img('cid:logo@sender.example')}${img('cid:logo@sender.example')}${img('cid:logo@sender.example')}`;
    const out = resolveCidImages(html, [part({ toBase64 })]);
    expect(toBase64).toHaveBeenCalledTimes(1);
    expect(out.match(/data:image\/png;base64,/g)).toHaveLength(3);
  });

  // Breaks: one unreadable part throws out of parseBody, and the ENTIRE email
  // body falls back to the raw MIME source. A broken image must stay a broken
  // image, never a broken mail.
  it('keeps the reference when a part refuses to produce bytes', () => {
    const html = img('cid:logo@sender.example');
    const out = resolveCidImages(html, [
      part({
        toBase64: () => {
          throw new Error('detached buffer');
        },
      }),
    ]);
    expect(out).toBe(html);
  });

  // Breaks: a zero-byte part (a truncated download, a sender bug) becomes
  // `data:image/png;base64,` — a URI the browser reports as a decode failure,
  // which is a worse broken image than the reference we started with.
  it('keeps the reference when the part has no bytes', () => {
    const html = img('cid:logo@sender.example');
    expect(resolveCidImages(html, [part({ toBase64: () => '' })])).toBe(html);
  });

  // Breaks: a part with no Content-ID at all (every real attachment) is treated
  // as a candidate and can answer for a reference meant for another part.
  it('ignores parts with no Content-ID', () => {
    const html = img('cid:logo@sender.example');
    expect(resolveCidImages(html, [part({ cid: null }), part({ cid: '' })])).toBe(html);
  });

  // Breaks: duplicate Content-IDs (a sender bug) resolve unpredictably from one
  // parse to the next. First part wins, matching what mailparser itself does.
  it('takes the first part when two declare the same Content-ID', () => {
    const out = resolveCidImages(img('cid:logo@sender.example'), [
      part({ toBase64: () => 'RklSU1Q=' }),
      part({ toBase64: () => 'U0VDT05E' }),
    ]);
    expect(out).toContain('data:image/png;base64,RklSU1Q=');
  });
});
