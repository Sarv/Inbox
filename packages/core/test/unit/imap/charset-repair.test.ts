import { describe, expect, it } from 'vitest';

import {
  REPLACEMENT_CHAR,
  countReplacementChars,
  hasReplacementChar,
  preservesDecodedText,
  transcodeDetectedCharset,
} from '../../../src/imap/charset-repair';

// A body long enough for chardet to have a real opinion, carrying bytes that
// are legal Windows-1252 and illegal UTF-8 (0x92, 0xe9, 0xef).
const WINDOWS_1252_SOURCE = Buffer.concat([
  Buffer.from('Dear customer, we couldn', 'latin1'),
  Buffer.from([0x92]),
  Buffer.from('t process your order because the caf', 'latin1'),
  Buffer.from([0xe9]),
  Buffer.from(' was closed. Please r', 'latin1'),
  Buffer.from([0xe9]),
  Buffer.from('sum', 'latin1'),
  Buffer.from([0xe9]),
  Buffer.from(' the na', 'latin1'),
  Buffer.from([0xef]),
  Buffer.from('ve request at your earliest convenience.', 'latin1'),
]);

describe('hasReplacementChar / countReplacementChars', () => {
  // Breaks: the repair either never triggers (a corrupted body is passed over)
  // or triggers on every clean body (needless detection work on the hot path).
  it('detects the replacement character and nothing else', () => {
    expect(REPLACEMENT_CHAR).toBe('�');
    expect(hasReplacementChar(`caf${REPLACEMENT_CHAR}`)).toBe(true);
    expect(hasReplacementChar('café')).toBe(false);
  });

  // Breaks: a null/empty body from a headers-only row throws on the parse path.
  it('treats null, undefined and empty as clean', () => {
    expect(hasReplacementChar(null)).toBe(false);
    expect(hasReplacementChar(undefined)).toBe(false);
    expect(hasReplacementChar('')).toBe(false);
    expect(countReplacementChars(null)).toBe(0);
    expect(countReplacementChars(undefined)).toBe(0);
    expect(countReplacementChars('')).toBe(0);
  });

  // Breaks: the adoption rule compares a boolean instead of a count, so a
  // partial repair (one mislabelled part of several) is rejected outright.
  it('counts every occurrence, not just the first', () => {
    expect(countReplacementChars(`${REPLACEMENT_CHAR}a${REPLACEMENT_CHAR}b${REPLACEMENT_CHAR}`)).toBe(3);
    expect(countReplacementChars('no damage here')).toBe(0);
  });
});

describe('preservesDecodedText', () => {
  // Breaks: the repair is accepted on its damage score alone, and text the
  // first parse decoded CORRECTLY is allowed to change underneath it.
  it('accepts a re-parse that only fills in the damaged spots', () => {
    expect(preservesDecodedText(`the caf${REPLACEMENT_CHAR} is closed`, 'the café is closed')).toBe(true);
  });

  // Breaks: THE mixed-charset hole. A multipart with one honest UTF-8 part and
  // one mislabelled part gets whole-source transcoded, double-encoding the
  // honest half (`é` → `Ã©`) — which produces no `�` at all and so LOOKS like a
  // clean win to a counting check, while ruining text that was already right.
  it('rejects a re-parse that double-encodes text that was already correct', () => {
    const primary = `le café était fermé and the caf${REPLACEMENT_CHAR} note`;
    const candidate = 'le cafÃ© Ã©tait fermÃ© and the café note';
    expect(preservesDecodedText(primary, candidate)).toBe(false);
  });

  // Breaks: a re-parse that lost the body scores a perfect zero replacement
  // characters and wins. An empty body is worse than a garbled one.
  it('rejects a re-parse that dropped the body', () => {
    expect(preservesDecodedText(`Dear customer${REPLACEMENT_CHAR}`, '')).toBe(false);
  });

  // Breaks: text is matched as a set rather than a sequence, so a re-parse that
  // reordered or duplicated the message passes.
  it('requires the surviving segments in order, not merely present', () => {
    const primary = `first${REPLACEMENT_CHAR}second`;
    expect(preservesDecodedText(primary, 'first-X-second')).toBe(true);
    expect(preservesDecodedText(primary, 'second-X-first')).toBe(false);
  });

  // Breaks: a body that is nothing but damage (every byte undecodable), or an
  // empty one, is rejected outright and can never be repaired.
  it('has nothing to preserve when the primary decoded nothing', () => {
    expect(preservesDecodedText(REPLACEMENT_CHAR.repeat(4), 'anything at all')).toBe(true);
    expect(preservesDecodedText('', 'anything at all')).toBe(true);
  });
});

describe('transcodeDetectedCharset', () => {
  // Breaks: the reported bug — a mislabelled 8-bit body stays garbled because
  // nothing ever looks past what the message claims its charset is.
  it('detects Windows-1252 bytes and re-encodes them as real UTF-8', () => {
    const result = transcodeDetectedCharset(WINDOWS_1252_SOURCE);
    expect(result).not.toBeNull();
    expect(result!.charset.toLowerCase()).toContain('1252');
    const text = result!.bytes.toString('utf8');
    expect(text).toContain('café');
    expect(text).toContain('naïve');
    expect(text).toContain('couldn’t');
    expect(text).not.toContain(REPLACEMENT_CHAR);
  });

  // Breaks: THE dangerous case. A body that is genuinely UTF-8 and genuinely
  // contains a replacement character (a forward of something already mojibake)
  // gets re-decoded as a single-byte charset — which scores fewer `�` while
  // turning every correct accent into garbage. Valid UTF-8 must never be
  // second-guessed, no matter what the parsed body looks like.
  it('refuses to touch a source that is already well-formed UTF-8', () => {
    const source = Buffer.from(`le café était fermé — the note read "caf${REPLACEMENT_CHAR}"`, 'utf8');
    expect(transcodeDetectedCharset(source)).toBeNull();
  });

  // Breaks: the same guard, for the ordinary case — pure ASCII is valid UTF-8,
  // so a quoted-printable or base64 message body is never re-decoded.
  it('refuses a pure-ASCII source', () => {
    expect(transcodeDetectedCharset(Buffer.from('Plain ASCII, nothing to repair.', 'latin1'))).toBeNull();
  });

  // Breaks: an empty or truncated fetch throws instead of declining.
  it('declines an empty source without throwing', () => {
    expect(transcodeDetectedCharset(Buffer.alloc(0))).toBeNull();
  });

  // Breaks: a body chardet cannot identify (or identifies as a charset
  // iconv-lite has no decoder for) crashes the parse instead of leaving the
  // original result standing.
  it('never throws on bytes it cannot identify', () => {
    const noise = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81, 0xff, 0x00, 0x9d, 0x8f]);
    expect(() => transcodeDetectedCharset(noise)).not.toThrow();
  });

  // Breaks: the returned buffer is not actually UTF-8, so the re-parse decodes
  // it a second time through the wrong lens and reintroduces the damage.
  it('returns bytes that survive a UTF-8 round trip', () => {
    const result = transcodeDetectedCharset(WINDOWS_1252_SOURCE);
    expect(result).not.toBeNull();
    expect(Buffer.from(result!.bytes.toString('utf8'), 'utf8').equals(result!.bytes)).toBe(true);
  });
});
