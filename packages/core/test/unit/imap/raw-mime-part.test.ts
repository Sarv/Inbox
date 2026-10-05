import { simpleParser } from 'mailparser';
import { describe, expect, it, vi } from 'vitest';

import {
  attachmentBytesFromSource,
  attachmentSizesFromSource,
  readRawMimeParts,
} from '../../../src/imap/raw-mime-part';

// Why this module exists, and what breaks without it:
//
// A real mailbox returns BODYSTRUCTURE with every parameter VALUE missing —
// `("NAME" )`, `("FILENAME" )`, `("BOUNDARY" )` — so no lookup by filename can
// match and no declared size exists. Its .txt attachment declares `base64` while
// carrying raw HTML; a base64 decoder keeps only alphabet characters and stops
// at the first `=`, so `<p><span style=` collapses to SEVEN bytes. Those seven
// bytes were cached, stored as the attachment's size ("7 B" in the chip against
// Gmail's "1 KB"), and handed to the viewer as unreadable binary. The repair has
// to read the message SOURCE, because the server's own description of it is
// useless. Three earlier fixes went through BODYSTRUCTURE and silently did
// nothing.

/** Build a multipart message; each part is `[headers[], body]`. */
function message(parts: ReadonlyArray<[string[], string]>): Buffer {
  const lines = [
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BND"',
    '',
    ...parts.flatMap(([headers, body]) => ['--BND', ...headers, '', body]),
    '--BND--',
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

const LYING_BODY = '<p><span style="color:red">hello there</span></p>';

function attachmentHeaders(name: string, encoding: string): string[] {
  return [
    `Content-Type: text/plain; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    `Content-Transfer-Encoding: ${encoding}`,
  ];
}

const LYING_MESSAGE = message([
  [['Content-Type: text/html; charset=utf-8'], '<html>body</html>'],
  [attachmentHeaders('note.txt', 'base64'), LYING_BODY],
]);

describe('readRawMimeParts', () => {
  // Breaks if the walk stops describing parts the server's BODYSTRUCTURE cannot
  // name — every repair downstream is keyed off this list.
  it('names every leaf part that declares a filename, with its encoding', async () => {
    const parts = await readRawMimeParts(LYING_MESSAGE);

    expect(parts.map((p) => p.filename)).toEqual(['note.txt']);
    expect(parts[0].encoding).toBe('base64');
    expect(parts[0].encodedLength).toBe(LYING_BODY.length);
  });

  // Breaks if a part's pre-decode length silently includes the boundary that
  // follows it: every part then looks longer than it is and healthy attachments
  // start tripping the "collapsed" test.
  it('measures the body bytes only, excluding the boundary that follows', async () => {
    const parts = await readRawMimeParts(message([[attachmentHeaders('a.txt', '7bit'), 'abcdefg']]));
    expect(parts[0].encodedLength).toBe(7);
  });

  // Breaks if measuring a message also buffers it: a 20 MB attachment would be
  // held in memory just to read its length.
  it('keeps bytes only for the part it was asked to collect', async () => {
    const source = message([
      [attachmentHeaders('keep.txt', '7bit'), 'KEEP'],
      [attachmentHeaders('drop.txt', '7bit'), 'DROP'],
    ]);
    const parts = await readRawMimeParts(source, 'keep.txt');

    expect(parts.find((p) => p.filename === 'keep.txt')?.raw?.toString()).toBe('KEEP');
    expect(parts.find((p) => p.filename === 'drop.txt')?.raw).toBeNull();
  });

  // Breaks if the collected bytes are reset by each later part — the wanted
  // attachment is rarely the last one, so its content would come back empty.
  it('collects a part that is not the last one in the message', async () => {
    const source = message([
      [attachmentHeaders('first.txt', '7bit'), 'FIRST'],
      [attachmentHeaders('second.txt', '7bit'), 'SECOND'],
      [attachmentHeaders('third.txt', '7bit'), 'THIRD'],
    ]);
    const parts = await readRawMimeParts(source, 'second.txt');
    expect(parts.find((p) => p.filename === 'second.txt')?.raw?.toString()).toBe('SECOND');
  });

  it('matches the collected name case- and whitespace-insensitively', async () => {
    const parts = await readRawMimeParts(LYING_MESSAGE, '  NOTE.TXT ');
    expect(parts[0].raw?.toString()).toBe(LYING_BODY);
  });

  // Breaks if body chunks are attributed to the previous named part after an
  // unnamed one — an inline HTML body would be appended to an attachment.
  it('ignores parts that name no file', async () => {
    const parts = await readRawMimeParts(
      message([
        [attachmentHeaders('a.txt', '7bit'), 'A'],
        [['Content-Type: text/html'], '<html>lots of text here</html>'],
      ]),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].encodedLength).toBe(1);
  });

  it('returns an empty list for a message with no named parts', async () => {
    expect(await readRawMimeParts(Buffer.from('Subject: hi\r\n\r\nplain body\r\n'))).toEqual([]);
  });

  it('normalises a missing Content-Transfer-Encoding to an empty string', async () => {
    const parts = await readRawMimeParts(
      message([[['Content-Disposition: attachment; filename="a.txt"'], 'A']]),
    );
    expect(parts[0].encoding).toBe('');
  });

  // Breaks if the bytes that decide a lying part stop being counted: every repair
  // downstream then reads 0 and never fires — the junk decode is served again.
  it('counts the bytes of a base64 part that no base64 encoder writes', async () => {
    const parts = await readRawMimeParts(LYING_MESSAGE);
    // < > < ␠ " : " > ␠ < > < >  — 13 of the 49.
    expect(parts[0].nonBase64Bytes).toBe(13);
  });

  // Breaks if the count runs over every part: a large 7bit or quoted-printable
  // attachment would pay a byte scan on import that nothing ever reads.
  it('does not count the bytes of a part that does not declare base64', async () => {
    const parts = await readRawMimeParts(message([[attachmentHeaders('a.txt', '7bit'), LYING_BODY]]));
    expect(parts[0].nonBase64Bytes).toBe(0);
  });
});

/** What mailparser — the real decoder chain — makes of a named attachment. */
async function decodedBy(source: Buffer, filename: string): Promise<Buffer> {
  const parsed = await simpleParser(source);
  const attachment = parsed.attachments.find((a) => a.filename === filename);
  if (!attachment) throw new Error(`mailparser found no ${filename}`);
  return attachment.content;
}

// The cases below go through mailparser for the decode instead of stubbing a
// length, because a stubbed length is exactly how this broke unnoticed: every
// test here fed in the 7 bytes libbase64 1.3.0 produced, and libbase64 1.3.1
// produces 25.
describe('the repair, against the decode mailparser really produces', () => {
  // THE regression of the libbase64 1.3.1 bump. Breaks if the verdict ever keys
  // off one decoder's output again: the attachment is served as 25 junk bytes.
  it('serves the raw bytes of HTML mislabelled base64', async () => {
    const decoded = await decodedBy(LYING_MESSAGE, 'note.txt');
    expect(decoded.toString('utf8')).not.toBe(LYING_BODY); // the decode IS junk
    const bytes = await attachmentBytesFromSource(LYING_MESSAGE, 'note.txt', decoded);
    expect(bytes.toString('utf8')).toBe(LYING_BODY);
    expect(await attachmentSizesFromSource(LYING_MESSAGE, [{ name: 'note.txt', size: decoded.length }]))
      .toEqual([LYING_BODY.length]);
  });

  // Breaks if prose is missed: with no `=` in it, the old decoder never stopped
  // early and the old test never fired — its spaces are what give it away.
  it('serves the raw bytes of prose mislabelled base64', async () => {
    const prose = 'Hello, this is a short note. Thanks!';
    const source = message([[attachmentHeaders('note.txt', 'base64'), prose]]);
    const decoded = await decodedBy(source, 'note.txt');
    expect((await attachmentBytesFromSource(source, 'note.txt', decoded)).toString('utf8')).toBe(prose);
  });

  // Breaks if an `=` in the middle of a part reads as "not base64". Mail that
  // pads every line on its own is what libbase64 1.3.1 was fixed for; it now
  // decodes in full and must be served as decoded, not as its base64 text.
  it('leaves base64 padded line by line at its full decode', async () => {
    const lines = ['first line of the file\n', 'second line\n'];
    const body = lines.map((l) => Buffer.from(l).toString('base64')).join('\r\n');
    const source = message([[attachmentHeaders('lines.txt', 'base64'), body]]);
    const decoded = await decodedBy(source, 'lines.txt');
    expect(decoded.toString('utf8')).toBe(lines.join(''));
    expect(await attachmentBytesFromSource(source, 'lines.txt', decoded)).toBe(decoded);
    expect(await attachmentSizesFromSource(source, [{ name: 'lines.txt', size: decoded.length }]))
      .toEqual([decoded.length]);
  });

  // Breaks if a short decode alone convicts a part: base64 wrapped at 16
  // characters decodes to two thirds of its length, and the file would be
  // served — and sized — as its own base64 text.
  it('keeps the decode of genuine base64 whose decode is short', async () => {
    const file = Buffer.from('0123456789'.repeat(12));
    const body = file.toString('base64').match(/.{1,16}/g)!.join('\r\n');
    const source = message([[attachmentHeaders('digits.txt', 'base64'), body]]);
    const decoded = await decodedBy(source, 'digits.txt');
    expect(decoded).toEqual(file);
    expect(await attachmentBytesFromSource(source, 'digits.txt', decoded)).toBe(decoded);
    expect(await attachmentSizesFromSource(source, [{ name: 'digits.txt', size: decoded.length }]))
      .toEqual([file.length]);
  });
});

describe('attachmentBytesFromSource', () => {
  // THE reported bug. Breaks if the collapsed decode is ever served again: the
  // viewer shows "could not be read" and the OS app shows binary garbage for
  // content Gmail displays as text.
  it('serves the raw part bytes when a base64 part decoded to 7 bytes', async () => {
    const collapsed = Buffer.alloc(7); // what mailparser really produces here
    const bytes = await attachmentBytesFromSource(LYING_MESSAGE, 'note.txt', collapsed);
    expect(bytes.toString('utf8')).toBe(LYING_BODY);
  });

  // Breaks if the heuristic fires on healthy mail — every genuine base64
  // attachment would be served still-encoded, i.e. corrupted by the "fix".
  it('leaves a genuine base64 decode alone', async () => {
    const payload = Buffer.alloc(300, 0x61);
    const source = message([
      [attachmentHeaders('big.bin', 'base64'), payload.toString('base64')],
    ]);
    const decoded = payload;
    expect(await attachmentBytesFromSource(source, 'big.bin', decoded)).toBe(decoded);
  });

  // Breaks if a short quoted-printable or 7bit part is replaced by its raw form —
  // those bytes are already correct however few of them there are.
  it('never second-guesses a part that did not claim base64', async () => {
    const source = message([[attachmentHeaders('note.txt', 'quoted-printable'), LYING_BODY]]);
    const decoded = Buffer.alloc(7);
    expect(await attachmentBytesFromSource(source, 'note.txt', decoded)).toBe(decoded);
  });

  it('returns the decode untouched when no part carries that name', async () => {
    const decoded = Buffer.alloc(7);
    expect(await attachmentBytesFromSource(LYING_MESSAGE, 'other.txt', decoded)).toBe(decoded);
  });

  // Breaks if a repair that cannot be made fails the open instead: an attachment
  // that used to open (wrongly) would stop opening at all.
  it('returns the decode when the MIME walk itself fails', async () => {
    const decoded = Buffer.alloc(7);
    const source = { length: 1 } as unknown as Buffer; // not pipeable — the walk throws
    expect(await attachmentBytesFromSource(source, 'note.txt', decoded)).toBe(decoded);
  });

  // Breaks if a duplicate name makes the walk collect nothing: `raw` is null and
  // the collapsed decode is served anyway.
  it('repairs the first of two attachments sharing a name', async () => {
    const source = message([
      [attachmentHeaders('note.txt', 'base64'), LYING_BODY],
      [attachmentHeaders('note.txt', 'base64'), '<p>second one</p>'],
    ]);
    const bytes = await attachmentBytesFromSource(source, 'note.txt', Buffer.alloc(7));
    expect(bytes.toString('utf8')).toBe(LYING_BODY);
  });
});

describe('attachmentSizesFromSource', () => {
  // Breaks: the chip keeps showing "7 B" for a 1 KB attachment for as long as the
  // row lives, even once the content itself is repaired — the user-visible half
  // of the reported bug.
  it('stores the raw part length for an attachment whose decode collapsed', async () => {
    const sizes = await attachmentSizesFromSource(LYING_MESSAGE, [{ name: 'note.txt', size: 7 }]);
    expect(sizes).toEqual([LYING_BODY.length]);
  });

  it('keeps the decoded size for a healthy attachment', async () => {
    const payload = Buffer.alloc(300, 0x61);
    const source = message([[attachmentHeaders('big.bin', 'base64'), payload.toString('base64')]]);
    expect(await attachmentSizesFromSource(source, [{ name: 'big.bin', size: 300 }])).toEqual([300]);
  });

  // Breaks if duplicates all read the FIRST part's numbers — the second copy is
  // then sized as the first, which is wrong whenever they differ.
  it('pairs duplicate filenames with their own parts, in document order', async () => {
    const second = '<p>a rather longer second attachment body</p>';
    const source = message([
      [attachmentHeaders('note.txt', 'base64'), LYING_BODY],
      [attachmentHeaders('note.txt', 'base64'), second],
    ]);
    const sizes = await attachmentSizesFromSource(source, [
      { name: 'note.txt', size: 7 },
      { name: 'note.txt', size: 7 },
    ]);
    expect(sizes).toEqual([LYING_BODY.length, second.length]);
  });

  it('keeps the decoded size when no part carries that name', async () => {
    expect(await attachmentSizesFromSource(LYING_MESSAGE, [{ name: 'gone.txt', size: 7 }])).toEqual([7]);
  });

  // Breaks if a failed measurement takes the whole message import down with it:
  // mail stops arriving because one attachment could not be sized.
  it('falls back to the decoded sizes when the MIME walk fails', async () => {
    const source = { length: 1 } as unknown as Buffer;
    expect(await attachmentSizesFromSource(source, [{ name: 'note.txt', size: 7 }])).toEqual([7]);
  });

  it('walks nothing for a message with no attachments', async () => {
    expect(await attachmentSizesFromSource(LYING_MESSAGE, [])).toEqual([]);
  });

  // Breaks if the whole list costs one walk per attachment — an import-path hot
  // loop re-parsing a large message once per file it carries.
  it('reads the message once however many attachments it lists', async () => {
    const source = message([
      [attachmentHeaders('a.txt', '7bit'), 'A'],
      [attachmentHeaders('b.txt', '7bit'), 'B'],
      [attachmentHeaders('c.txt', '7bit'), 'C'],
    ]);
    const spy = vi.spyOn(source, 'subarray');
    await attachmentSizesFromSource(source, [
      { name: 'a.txt', size: 1 },
      { name: 'b.txt', size: 1 },
      { name: 'c.txt', size: 1 },
    ]);
    // One pass over the buffer, not three: the splitter slices as it reads.
    expect(spy.mock.calls.length).toBeLessThan(40);
    spy.mockRestore();
  });
});
