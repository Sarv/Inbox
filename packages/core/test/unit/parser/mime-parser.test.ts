import { describe, expect, it } from 'vitest';

import { MimeParser, mimeParser, stringifyHeaderValue } from '../../../src/parser/mime-parser';

// The MIME parser is the front door for fully untrusted input: every byte comes
// from a remote sender. The invariants that matter are (a) the message's OWN
// declared charset/transfer-encoding is honoured so bodies aren't mojibake, (b)
// multipart structure is walked so the right body part wins, (c) inline images
// are distinguishable from real attachments, and (d) malformed/truncated MIME
// degrades gracefully instead of throwing and killing a whole sync batch.

/** Build a raw message from lines with CRLF endings, as it arrives over IMAP. */
const raw = (...lines: string[]): string => lines.join('\r\n');

const parser = new MimeParser();

describe('MimeParser.parse — headers', () => {
  it('decodes an RFC 2047 encoded subject and every address header', async () => {
    const parsed = await parser.parse(raw(
      'From: "Alice A" <alice@example.com>',
      'To: bob@example.com, "Doe, John" <john@example.com>',
      'Cc: cc@example.com',
      'Bcc: bcc@example.com',
      'Reply-To: Sales <sales@example.com>',
      'Subject: =?ISO-8859-1?Q?Caf=E9_meeting?=',
      'Message-ID: <orig@example.com>',
      'In-Reply-To: <parent@example.com>',
      'Date: Tue, 18 Aug 2026 10:00:00 +0000',
      '',
      'body',
    ));

    expect(parsed.subject).toBe('Café meeting');           // decoded, not raw =?ISO...
    expect(parsed.from).toEqual([{ name: 'Alice A', address: 'alice@example.com' }]);
    expect(parsed.to).toEqual([
      { name: null, address: 'bob@example.com' },
      { name: 'Doe, John', address: 'john@example.com' },  // display name with a comma
    ]);
    expect(parsed.cc).toEqual([{ name: null, address: 'cc@example.com' }]);
    expect(parsed.bcc).toEqual([{ name: null, address: 'bcc@example.com' }]);
    expect(parsed.replyTo).toEqual({ name: 'Sales', address: 'sales@example.com' });
    expect(parsed.messageId).toBe('<orig@example.com>');
    expect(parsed.inReplyTo).toBe('<parent@example.com>');
    expect(parsed.date.toISOString()).toBe('2026-08-18T10:00:00.000Z');
  });

  it('returns empty address arrays and nulls when the headers are absent', async () => {
    const parsed = await parser.parse(raw('Subject: bare', '', 'body'));
    expect(parsed.from).toEqual([]);
    expect(parsed.to).toEqual([]);
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.replyTo).toBeNull();
    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.references).toEqual([]);
  });

  // A message with no Message-ID must still get a stable identity — the storage
  // layer dedupes/threads on it, and `undefined` there corrupts the thread.
  it('synthesizes a fallback Message-ID when the sender omitted one', async () => {
    const parsed = await parser.parse(raw('Subject: no id', '', 'body'));
    expect(parsed.messageId).toMatch(/^<\d+\.[a-z0-9]+@sarvinbox\.local>$/);
  });

  it('defaults the date to now when the Date header is missing/unparseable', async () => {
    const before = Date.now();
    const parsed = await parser.parse(raw('Subject: no date', '', 'body'));
    expect(parsed.date.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('splits a whitespace-separated References header into individual ids', async () => {
    const parsed = await parser.parse(raw('References: <a@x>  <b@x>', '', 'hi'));
    expect(parsed.references).toEqual(['<a@x>', '<b@x>']);
  });

  it('flattens References that arrive as repeated headers', async () => {
    const parsed = await parser.parse(raw('References: <a@x>', 'References: <b@x> <c@x>', '', 'hi'));
    expect(parsed.references).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });
});

describe('MimeParser.parse — charset and transfer-encoding decoding', () => {
  // The raw source reaches us as bytes; decoding must follow the part's OWN
  // declared charset. Assuming UTF-8 is the classic garbled-body bug.
  it('decodes an ISO-8859-1 quoted-printable body', async () => {
    const parsed = await parser.parse(Buffer.from(raw(
      'Content-Type: text/plain; charset=ISO-8859-1',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=E9 na=EFve r=E9sum=E9',
      '',
    ), 'latin1'));

    expect(parsed.text).toContain('Café naïve résumé');
    expect(parsed.text).not.toContain('�');           // no replacement chars
  });

  it('decodes a base64 UTF-8 body', async () => {
    const parsed = await parser.parse(raw(
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('base64 decoded — ok').toString('base64'),
      '',
    ));
    expect(parsed.text?.trim()).toBe('base64 decoded — ok');
  });

  it('decodes an 8bit windows-1252 body (bytes invalid as UTF-8)', async () => {
    const parsed = await parser.parse(Buffer.concat([
      Buffer.from(raw('Content-Type: text/plain; charset=windows-1252', 'Content-Transfer-Encoding: 8bit', '', ''), 'latin1'),
      Buffer.from([0x49, 0x74, 0x92, 0x73]),               // "It’s" in cp1252
      Buffer.from('\r\n', 'latin1'),
    ]));
    expect(parsed.text).toContain('It’s');
    expect(parsed.text).not.toContain('�');
  });

  it('falls back gracefully on an unknown charset instead of throwing', async () => {
    const parsed = await parser.parse(Buffer.from(raw(
      'Content-Type: text/plain; charset=x-bogus-charset',
      '',
      'plain ascii text',
      '',
    ), 'latin1'));
    expect(parsed.text).toContain('plain ascii text');
  });
});

describe('MimeParser.parse — multipart structure', () => {
  const multipart = raw(
    'Subject: mixed',
    'Content-Type: multipart/mixed; boundary=OUTER',
    '',
    '--OUTER',
    'Content-Type: multipart/alternative; boundary=INNER',
    '',
    '--INNER',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain part',
    '--INNER',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>rich=20part</p>',
    '--INNER--',
    '--OUTER',
    'Content-Type: image/png; name="logo.png"',
    'Content-ID: <logo123>',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('PNGDATA').toString('base64'),
    '--OUTER',
    'Content-Type: application/pdf; name="doc.pdf"',
    'Content-Disposition: attachment; filename="doc.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('PDFDATA').toString('base64'),
    '--OUTER--',
    '',
  );

  it('exposes BOTH alternatives of a multipart/alternative so the caller can prefer HTML', async () => {
    const parsed = await parser.parse(multipart);
    expect(parsed.text?.trim()).toBe('plain part');
    expect(parsed.html).toContain('rich part');
    expect(parsed.textAsHtml).toContain('plain part');
    expect(parser.getBestContent(parsed)).toEqual({ type: 'html', content: parsed.html! });
  });

  // Inline images must be separable from real attachments — otherwise every
  // signature logo shows up as "this email has an attachment".
  it('keeps the Content-ID and inline flag of an inline image, and the bytes of a real attachment', async () => {
    const parsed = await parser.parse(multipart);
    expect(parsed.hasAttachments).toBe(true);
    expect(parsed.attachments).toHaveLength(2);

    const logo = parsed.attachments.find(a => a.filename === 'logo.png')!;
    expect(logo.contentId).toBe('logo123');   // bare, as `cid:` references it
    expect(logo.inline).toBe(true);
    expect(logo.contentType).toBe('image/png');
    expect(logo.content.toString('utf-8')).toBe('PNGDATA');   // base64 decoded once
    expect(logo.size).toBe(7);

    const pdf = parsed.attachments.find(a => a.filename === 'doc.pdf')!;
    expect(pdf.contentId).toBeNull();
    expect(pdf.inline).toBe(false);
    expect(pdf.content.toString('utf-8')).toBe('PDFDATA');
  });

  it('names an attachment that has no filename so downstream code always has one', async () => {
    const parsed = await parser.parse(raw(
      'Content-Type: multipart/mixed; boundary=B',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'body',
      '--B',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment',
      '',
      'ZZZ',
      '--B--',
      '',
    ));
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe('unnamed');
  });

  // `inline` used to be derived ONLY from Content-Disposition, so a
  // cid:-referenced image in a multipart/related that omits that header — very
  // common for signature logos — read as a normal attachment and the email
  // showed a bogus paperclip. Being referenced by the body IS being inline.
  it('treats a cid-referenced image with no Content-Disposition as inline', async () => {
    const parsed = await parser.parse(raw(
      'Content-Type: multipart/related; boundary=R',
      '',
      '--R',
      'Content-Type: text/html',
      '',
      '<img src="cid:x1">',
      '--R',
      'Content-Type: image/gif',
      'Content-ID: <x1>',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('GIF').toString('base64'),
      '--R--',
      '',
    ));
    expect(parsed.attachments[0].contentId).toBe('x1');
    expect(parsed.attachments[0].inline).toBe(true);
  });
});

describe('MimeParser.parse — malformed input', () => {
  // A single broken message must never abort the sync batch it arrived in.
  it('does not throw on a multipart truncated mid-part', async () => {
    const parsed = await parser.parse(raw(
      'Content-Type: multipart/mixed; boundary=X',
      '',
      '--X',
      'Content-Type: text/plain',
      '',
      'half a mes',
    ));
    expect(parsed.text).toContain('half a mes');
    expect(parsed.attachments).toEqual([]);
  });

  it('does not throw on a body that is not MIME at all', async () => {
    const parsed = await parser.parse('  not really an email at all ---- }{');
    expect(parsed.subject).toBeNull();
    expect(parsed.attachments).toEqual([]);
  });

  it('does not throw on an empty message', async () => {
    const parsed = await parser.parse('');
    expect(parsed.text).toBeNull();
    expect(parsed.html).toBeNull();
    expect(parsed.hasAttachments).toBe(false);
  });

  it('does not throw when a declared boundary never appears', async () => {
    const parsed = await parser.parse(raw(
      'Content-Type: multipart/mixed; boundary=MISSING',
      '',
      'orphan body with no boundary marker',
    ));
    expect(parsed.attachments).toEqual([]);
  });

  // The one case that DOES reject: a null/undefined input is a caller bug, and
  // the wrapped message must identify the parser as the source.
  it('rejects a null input with a clear wrapped error', async () => {
    await expect(parser.parse(null as unknown as string)).rejects.toThrow(/Failed to parse MIME message/);
  });
});

describe('MimeParser content helpers', () => {
  const parsedWith = (over: Record<string, unknown>) => ({
    text: null, html: null, textAsHtml: null, attachments: [], hasAttachments: false,
    ...over,
  } as any);

  it('extractAllText prefers the text part and falls back to HTML only when text is absent', () => {
    expect(parser.extractAllText(parsedWith({ text: 'plain' }))).toBe('plain');
    expect(parser.extractAllText(parsedWith({ html: '<p>rich</p>' }))).toBe('<p>rich</p>');
    // Both present → HTML is NOT appended (it would duplicate the same content).
    expect(parser.extractAllText(parsedWith({ text: 'plain', html: '<p>plain</p>' }))).toBe('plain');
    expect(parser.extractAllText(parsedWith({}))).toBe('');
  });

  it('getBestContent prefers HTML, then text, then an empty string', () => {
    expect(parser.getBestContent(parsedWith({ html: '<p>h</p>', text: 't' }))).toEqual({ type: 'html', content: '<p>h</p>' });
    expect(parser.getBestContent(parsedWith({ text: 't' }))).toEqual({ type: 'text', content: 't' });
    expect(parser.getBestContent(parsedWith({}))).toEqual({ type: 'text', content: '' });
  });

  it('normalizeHeaders lowercases keys, joins repeated values and ISO-formats dates', async () => {
    const parsed = await parser.parse(raw(
      'X-Custom: one',
      'X-Custom: two',
      'Subject: s',
      'Date: Tue, 18 Aug 2026 10:00:00 +0000',
      '',
      'body',
    ));
    const normalized = parser.normalizeHeaders(parsed);
    expect(normalized['x-custom']).toBe('one, two');       // array → joined
    expect(normalized['subject']).toBe('s');
    expect(normalized['date']).toBe('2026-08-18T10:00:00.000Z'); // Date → ISO
  });

  // mailparser hands back OBJECTS for from/to/cc and for parameterised headers
  // like Content-Type. String(value) turned every one of them into the literal
  // "[object Object]", so nothing could read a normalized header back.
  it('renders structured address headers as addresses, not "[object Object]"', async () => {
    const parsed = await parser.parse(raw(
      'From: "Alice A" <a@x.com>',
      'To: b@x.com, c@x.com',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
    ));
    const normalized = parser.normalizeHeaders(parsed);
    expect(normalized['from']).toBe('"Alice A" <a@x.com>');
    expect(normalized['to']).toBe('b@x.com, c@x.com');
    expect(normalized['content-type']).toBe('text/plain; charset=utf-8');
    expect(Object.values(normalized)).not.toContain('[object Object]');
  });
});

// The header union mailparser actually produces, shape by shape. Unit-tested
// directly because the shapes ARE the bug: one unhandled branch silently
// degrades a header to "[object Object]" for every message.
describe('stringifyHeaderValue', () => {
  it('passes strings through and ISO-formats dates', () => {
    expect(stringifyHeaderValue('plain')).toBe('plain');
    expect(stringifyHeaderValue(new Date('2026-08-18T10:00:00Z'))).toBe('2026-08-18T10:00:00.000Z');
  });

  it('joins repeated headers, dropping empties', () => {
    expect(stringifyHeaderValue(['one', 'two'])).toBe('one, two');
    expect(stringifyHeaderValue(['one', '', 'three'])).toBe('one, three');
    expect(stringifyHeaderValue([])).toBe('');
  });

  it('uses mailparser\'s own rendering for address objects', () => {
    expect(stringifyHeaderValue({ value: [{ address: 'a@x.com', name: 'A' }], text: 'A <a@x.com>' }))
      .toBe('A <a@x.com>');
  });

  it('renders a bare address object without `text`', () => {
    expect(stringifyHeaderValue({ address: 'a@x.com', name: 'Alice' })).toBe('Alice <a@x.com>');
    expect(stringifyHeaderValue({ address: 'a@x.com', name: '' })).toBe('a@x.com');
    expect(stringifyHeaderValue({ address: 'a@x.com' })).toBe('a@x.com');
  });

  it('rebuilds a structured header with its params', () => {
    expect(stringifyHeaderValue({ value: 'multipart/mixed', params: { boundary: 'B', charset: 'utf-8' } }))
      .toBe('multipart/mixed; boundary=B; charset=utf-8');
    expect(stringifyHeaderValue({ value: 'text/plain', params: {} })).toBe('text/plain');
    expect(stringifyHeaderValue({ value: 'attachment' })).toBe('attachment');
  });

  it('is empty for nothing, and JSON (never "[object Object]") for the unrecognised', () => {
    expect(stringifyHeaderValue(null)).toBe('');
    expect(stringifyHeaderValue(undefined)).toBe('');
    expect(stringifyHeaderValue({ unexpected: 1 })).toBe('{"unexpected":1}');
    // Circular input must not throw out of a header walk.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringifyHeaderValue(circular)).toBe('');
  });

  it('coerces primitives that are neither string nor object', () => {
    expect(stringifyHeaderValue(42)).toBe('42');
    expect(stringifyHeaderValue(false)).toBe('false');
  });
});

describe('mimeParser singleton', () => {
  it('is a ready MimeParser usable by the sync path', async () => {
    expect(mimeParser).toBeInstanceOf(MimeParser);
    const parsed = await mimeParser.parse(raw('Subject: via singleton', '', 'body'));
    expect(parsed.subject).toBe('via singleton');
  });
});
