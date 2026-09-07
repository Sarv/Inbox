import { describe, expect, it } from 'vitest';

import { MessageProcessor } from '../../../src/imap/message-processor';

// The IMAP fetch preserves the raw MIME source losslessly as a latin1 string
// (one char per byte). parseBody must reconstruct those exact bytes and let
// mailparser decode the message's OWN declared charset — NOT assume UTF-8, which
// mangles non-UTF-8 bodies into mojibake (the reported garbled-body bug).
//
// Helper: build the latin1 string the fetch layer would hand parseBody, from the
// real bytes of a raw MIME message.
function asFetched(rawBytes: Buffer): string {
  return rawBytes.toString('latin1');
}

describe('parseBody charset decoding', () => {
  const mp = new MessageProcessor({ headersOnly: false });

  it('decodes an ISO-8859-1 quoted-printable body (not UTF-8)', async () => {
    const raw = Buffer.from(
      'Content-Type: text/plain; charset=ISO-8859-1\r\n' +
      'Content-Transfer-Encoding: quoted-printable\r\n' +
      '\r\n' +
      'Caf=E9 na=EFve r=E9sum=E9\r\n',
      'latin1',
    );
    const { cleanBody } = await mp.parseBody(asFetched(raw));
    expect(cleanBody).toContain('Café naïve résumé');
    expect(cleanBody).not.toContain('�'); // no replacement chars
  });

  it('decodes a Windows-1252 8-bit body with a smart quote', async () => {
    // 0x92 is a right single quote in Windows-1252 (invalid as UTF-8 → would be
    // mojibake under the old toString('utf8') path).
    const raw = Buffer.concat([
      Buffer.from('Content-Type: text/plain; charset=windows-1252\r\n\r\n', 'latin1'),
      Buffer.from([0x49, 0x74, 0x92, 0x73]), // "It’s"
      Buffer.from('\r\n', 'latin1'),
    ]);
    const { cleanBody } = await mp.parseBody(asFetched(raw));
    expect(cleanBody).toContain('It’s');
    expect(cleanBody).not.toContain('�');
  });

  it('still decodes a UTF-8 body correctly (no regression)', async () => {
    const raw = Buffer.from(
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      'Héllo — 日本語 😀\r\n',
      'utf8',
    );
    const { cleanBody } = await mp.parseBody(asFetched(raw));
    expect(cleanBody).toContain('Héllo — 日本語 😀');
    expect(cleanBody).not.toContain('�');
  });

  it('does not throw on an empty body', async () => {
    const { cleanBody } = await mp.parseBody('');
    expect(typeof cleanBody).toBe('string');
  });
});

// The other half of the garbled-body bug: the pipeline is correct but the
// SENDER lied. A part declares us-ascii/utf-8 and ships Windows-1252 bytes;
// mailparser builds no decoder for that charset family, so the bytes fall
// through a UTF-8 toString() and become `�`. Re-fetching cures nothing — the
// server's copy carries the same lie — so detection is the only repair.
describe('parseBody charset repair (sender declared the wrong charset)', () => {
  const mp = new MessageProcessor({ headersOnly: false });

  // Enough prose for chardet to have a statistical opinion; a two-word body is
  // genuinely undetectable and would be a test of luck, not of behaviour.
  const WINDOWS_1252_BODY = Buffer.concat([
    Buffer.from('Dear customer, we couldn', 'latin1'),
    Buffer.from([0x92]), // Windows-1252 right single quote
    Buffer.from('t process your order because the caf', 'latin1'),
    Buffer.from([0xe9]), // é
    Buffer.from(' was closed. Please r', 'latin1'),
    Buffer.from([0xe9]),
    Buffer.from('sum', 'latin1'),
    Buffer.from([0xe9]),
    Buffer.from(' the na', 'latin1'),
    Buffer.from([0xef]), // ï
    Buffer.from('ve request at your earliest convenience.\r\n', 'latin1'),
  ]);

  function declaredAs(charset: string): Buffer {
    return Buffer.concat([
      Buffer.from(`Content-Type: text/plain; charset=${charset}\r\n\r\n`, 'latin1'),
      WINDOWS_1252_BODY,
    ]);
  }

  // Breaks: the reported bug returns — a body renders as `caf�` in the app while
  // webmail shows it correctly, and no amount of re-syncing fixes it.
  it('repairs a body that declares us-ascii but carries Windows-1252 bytes', async () => {
    const { cleanBody } = await mp.parseBody(asFetched(declaredAs('us-ascii')));
    expect(cleanBody).toContain('café');
    expect(cleanBody).toContain('naïve');
    expect(cleanBody).not.toContain('�');
  });

  // Breaks: the same lie told as utf-8 instead of us-ascii goes unrepaired —
  // mailparser skips decoding for BOTH names, so both must be covered.
  it('repairs a body that declares utf-8 but carries Windows-1252 bytes', async () => {
    const { cleanBody } = await mp.parseBody(asFetched(declaredAs('utf-8')));
    expect(cleanBody).toContain('résumé');
    expect(cleanBody).not.toContain('�');
  });

  // Breaks: a correctly-declared non-UTF-8 body gets second-guessed by a
  // statistical detector and re-decoded as something else. The repair must be
  // unreachable whenever the declared charset already worked.
  it('leaves a correctly-declared Windows-1252 body exactly as parsed', async () => {
    const { cleanBody } = await mp.parseBody(asFetched(declaredAs('windows-1252')));
    expect(cleanBody).toContain('couldn’t');
    expect(cleanBody).toContain('café');
    expect(cleanBody).not.toContain('�');
  });

  // Breaks: a body whose sender genuinely TYPED a replacement character (a
  // forwarded mail that was already mojibake) gets "repaired" — the source is
  // valid UTF-8, so re-decoding it as a single-byte charset turns a correct
  // body into mojibake while honestly reporting fewer `�`. The worst outcome
  // this feature could have, and the reason for the well-formed-UTF-8 guard.
  it('does not re-decode a valid UTF-8 body that legitimately contains U+FFFD', async () => {
    const raw = Buffer.from(
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      'Fwd: the earlier note read "caf�" — le café était fermé aujourd’hui.\r\n',
      'utf8',
    );
    const { cleanBody } = await mp.parseBody(asFetched(raw));
    expect(cleanBody).toContain('le café était fermé');
    expect(cleanBody).toContain('caf�'); // the sender's own character, untouched
  });

  // Breaks: a body chardet cannot make sense of (arbitrary 8-bit noise, a
  // truncated fetch) throws out of parseBody or comes back EMPTY instead of
  // falling back to whatever the faithful parse managed. Mojibake is a bad
  // body; no body at all is a lost one.
  it('never loses the body when the bytes cannot be identified', async () => {
    const raw = Buffer.concat([
      Buffer.from('Content-Type: text/plain; charset=us-ascii\r\n\r\n', 'latin1'),
      Buffer.from([0x80, 0x9d, 0xff, 0xfe, 0x81, 0x8f, 0x90, 0xff]),
      Buffer.from('\r\n', 'latin1'),
    ]);
    const { cleanBody } = await mp.parseBody(asFetched(raw));
    expect(typeof cleanBody).toBe('string');
    expect(cleanBody.trim().length).toBeGreaterThan(0);
  });

  // Breaks: a message with no readable text at all (headers only) comes back
  // as something other than a string and blows up storage on write.
  it('survives a source with headers and no body', async () => {
    const raw = Buffer.from('Content-Type: text/plain; charset=us-ascii\r\n\r\n', 'latin1');
    const { cleanBody, rawBody } = await mp.parseBody(asFetched(raw));
    expect(typeof cleanBody).toBe('string');
    expect(typeof rawBody).toBe('string');
  });

  // Breaks: the repair reads only the plain part. An HTML-only mail declaring
  // the wrong charset is the common shape of this bug (marketing mail from
  // Outlook), and its `rawBody` — what the reading pane renders — must be the
  // repaired one, not just the derived snippet.
  it('repairs an HTML-only body and its derived plain text together', async () => {
    const raw = Buffer.concat([
      Buffer.from('Content-Type: text/html; charset=us-ascii\r\n\r\n<html><body><p>', 'latin1'),
      WINDOWS_1252_BODY,
      Buffer.from('</p></body></html>\r\n', 'latin1'),
    ]);
    const { rawBody, cleanBody, contentType } = await mp.parseBody(asFetched(raw));
    expect(contentType).toBe('html');
    expect(rawBody).toContain('café');
    expect(cleanBody).toContain('café');
    expect(rawBody).not.toContain('�');
    expect(cleanBody).not.toContain('�');
  });

  // Breaks: a multipart carrying one HONEST UTF-8 part and one mislabelled part
  // is whole-source transcoded, double-encoding the honest part (`é` → `Ã©`).
  // That scores as a win on replacement characters alone, so it is the one way
  // this repair could damage text that was already correct — the fix must
  // decline the repair entirely rather than trade one part for the other.
  it('declines to repair when doing so would double-encode an honest UTF-8 part', async () => {
    const boundary = 'mixed0';
    const raw = Buffer.concat([
      Buffer.from(
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\n` +
        'Content-Type: text/plain; charset=utf-8\r\n\r\n',
        'latin1',
      ),
      Buffer.from('Le café était fermé hier après-midi, désolé pour la gêne.\r\n', 'utf8'),
      Buffer.from(
        `--${boundary}\r\n` +
        'Content-Type: text/plain; charset=us-ascii\r\n\r\n',
        'latin1',
      ),
      WINDOWS_1252_BODY,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
    ]);
    const { cleanBody, rawBody } = await mp.parseBody(asFetched(raw));
    // The honest part keeps its real accents — never "cafÃ© Ã©tait".
    expect(`${cleanBody}${rawBody}`).toContain('Le café était fermé');
    expect(`${cleanBody}${rawBody}`).not.toContain('Ã©');
    // And the repair really was ATTEMPTED and declined, not skipped for some
    // unrelated reason: the mislabelled half is still visibly damaged.
    expect(`${cleanBody}${rawBody}`).toContain('�');
  });

  // Breaks: attachments come back from the RE-PARSE. Transcoding rewrites the
  // whole source — harmless to a base64 part's ASCII, ruinous to a binary one —
  // so every attachment must still be reported from the primary parse.
  it('reports attachments from the primary parse even when the body is repaired', async () => {
    const boundary = 'b0undary';
    const raw = Buffer.concat([
      Buffer.from(
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\n` +
        'Content-Type: text/plain; charset=us-ascii\r\n\r\n',
        'latin1',
      ),
      WINDOWS_1252_BODY,
      Buffer.from(
        `\r\n--${boundary}\r\n` +
        'Content-Type: application/pdf; name="report.pdf"\r\n' +
        'Content-Disposition: attachment; filename="report.pdf"\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        'JVBERi0xLjQK\r\n' +
        `--${boundary}--\r\n`,
        'latin1',
      ),
    ]);
    const { cleanBody, attachments } = await mp.parseBody(asFetched(raw));
    expect(cleanBody).toContain('café');
    expect(attachments.map((a) => a.name)).toContain('report.pdf');
  });
});
