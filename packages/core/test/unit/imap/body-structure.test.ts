import { describe, expect, it } from 'vitest';

import {
  base64DecodeShort,
  countNonBase64Bytes,
  findAttachmentNodeByName,
  findAttachmentPartByName,
  misdeclaredBase64,
} from '../../../src/imap/body-structure';
import type { BodyStructure } from '../../../src/types/imap';

// Resolving the right MIME part number is what lets us fetch ONE attachment
// instead of the whole message. A wrong match downloads the wrong bytes; a miss
// falls back to the (correct but heavy) full-message path — so both the match and
// the null case are pinned here.

const node = (over: Partial<BodyStructure>): BodyStructure => ({
  type: 'text', subtype: 'plain', params: {}, id: null, description: null,
  encoding: '7bit', size: 0, disposition: null, ...over,
});

// multipart/mixed: [ text/plain (1), application/pdf "report.pdf" (2), image "logo.png" (3) ]
const tree = node({
  type: 'multipart', subtype: 'mixed',
  parts: [
    node({ part: '1', type: 'text', subtype: 'plain' }),
    node({ part: '2', type: 'application', subtype: 'pdf', disposition: { type: 'attachment', params: { filename: 'Report.pdf' } } }),
    node({ part: '3', type: 'image', subtype: 'png', params: { name: 'logo.png' } }), // name on Content-Type, no disposition
  ],
});

describe('findAttachmentPartByName', () => {
  it('finds an attachment by its disposition filename (case-insensitive)', () => {
    expect(findAttachmentPartByName(tree, 'report.pdf')).toBe('2');
    expect(findAttachmentPartByName(tree, 'REPORT.PDF')).toBe('2');
  });

  it('falls back to the Content-Type name when there is no disposition filename', () => {
    expect(findAttachmentPartByName(tree, 'logo.png')).toBe('3');
  });

  it('returns null when nothing matches (caller uses the whole-message fallback)', () => {
    expect(findAttachmentPartByName(tree, 'missing.zip')).toBeNull();
  });

  it('is null-safe for an empty tree or empty filename', () => {
    expect(findAttachmentPartByName(undefined, 'x')).toBeNull();
    expect(findAttachmentPartByName(tree, '')).toBeNull();
  });

  // A matching name with NO part number can't be fetched by part — must not
  // return a bogus part; the caller falls back to the full message.
  it('ignores a name match that has no part number', () => {
    const noPart = node({ parts: [node({ disposition: { type: 'attachment', params: { filename: 'a.txt' } } })] });
    expect(findAttachmentPartByName(noPart, 'a.txt')).toBeNull();
  });
});

describe('findAttachmentNodeByName', () => {
  // The NODE, not just its number: its declared `encoding` and `size` are the
  // only way a caller can tell that bytes it got back are implausible (the
  // base64-that-isn't case). Breaks if this ever narrows back to a part string.
  it('returns the node carrying the encoding and size the server declared', () => {
    const found = findAttachmentNodeByName(tree, 'report.pdf');
    expect(found?.part).toBe('2');
    expect(found?.encoding).toBe('7bit');
    expect(found?.size).toBe(0);
  });

  it('returns null on no match, matching the part lookup it backs', () => {
    expect(findAttachmentNodeByName(tree, 'missing.zip')).toBeNull();
    expect(findAttachmentNodeByName(undefined, 'x')).toBeNull();
  });
});

// A part whose Content-Transfer-Encoding header LIES is the reason this exists.
// A base64 decoder keeps only alphabet characters, so raw text claiming
// `base64` decodes to junk: `<p><span style=` decoded to SEVEN bytes under
// libbase64 1.3.0, which also stopped at the first `=`. libbase64 1.3.1 decodes
// every `=`-separated segment, and the same 64 bytes of HTML now come out as 34
// — just over half, so the old "under half" test went blind and the junk was
// cached, sized and served again. Every path (the per-part download against the
// server's declared size, the import and whole-message paths against the part's
// raw length in the source, the antivirus scan) keys off these predicates, so
// they are pinned here rather than in any one caller.
describe('base64DecodeShort', () => {
  /** The download path's call shape: a bodystructure node's declared encoding
   *  and size, against what the decode actually produced. */
  const short = (part: Partial<BodyStructure>, decodedLength: number) => {
    const n = node({ part: '2', encoding: 'base64', size: 400, ...part });
    return base64DecodeShort(n.encoding, n.size, decodedLength);
  };

  it('flags a base64 part that decoded to under half its declared size', () => {
    expect(short({}, 7)).toBe(true);
    expect(short({ encoding: 'BASE64' }, 7)).toBe(true);
  });

  // THE regression this predicate was retuned for. Breaks if the threshold slides
  // back to "under half": libbase64 1.3.1 decodes the reported HTML to 34 bytes
  // of 64, and text mislabelled base64 generally lands at 50-65% of its length.
  // 200 of 400 used to be pinned as "accepted" — it is exactly where such text
  // decodes now, and flagging it only triggers a look at the raw bytes.
  it('flags the just-over-half decode libbase64 1.3.1 makes of mislabelled text', () => {
    expect(base64DecodeShort('base64', 64, 34)).toBe(true);
    expect(short({}, 200)).toBe(true);
    expect(short({}, 250)).toBe(true);
  });

  it('accepts a genuine base64 decode (~73-75% of declared)', () => {
    expect(short({}, 300)).toBe(false);
    expect(short({}, 278)).toBe(false); // the boundary: 0.7 × 400 − 2
    expect(short({}, 277)).toBe(true);
  });

  // Breaks if the threshold is tightened past what real encoders produce: every
  // ordinary attachment would cost a second, raw fetch on open and be refused by
  // the antivirus scan. Checked against REAL encodings at every size up to 3000
  // bytes, including the tiny files whose padding drags the ratio down (a 1-byte
  // file is "AQ==", 25%, and used to trip the old test).
  it('never flags genuine base64 wrapped at 28 characters or more, at any size', () => {
    const wrap = (b64: string, width: number, eol: string) =>
      b64.match(new RegExp(`.{1,${width}}`, 'g'))?.join(eol) ?? '';
    const flagged: string[] = [];
    for (const eol of ['\r\n', '\n']) {
      for (const width of [28, 60, 64, 76, 100_000]) {
        for (let size = 0; size <= 3000; size++) {
          const encoded = wrap(Buffer.alloc(size, 0xa5).toString('base64'), width, eol);
          if (base64DecodeShort('base64', encoded.length, size)) flagged.push(`${size} B at ${width}`);
        }
      }
    }
    expect(flagged).toEqual([]);
  });

  it('never flags a part that did not claim base64, however short', () => {
    expect(short({ encoding: 'quoted-printable' }, 7)).toBe(false);
    expect(short({ encoding: '' }, 7)).toBe(false);
  });

  it('never flags without a pre-decode size to compare against, and is null-safe', () => {
    // The import path reaches this with 0 whenever the part could not be found
    // in the source at all. Breaks if an unknown pre-decode size is read as
    // "short" and every such attachment is re-labelled.
    expect(short({ size: 0 }, 7)).toBe(false);
    expect(base64DecodeShort(null, 400, 7)).toBe(false);
    expect(base64DecodeShort(undefined, 400, 7)).toBe(false);
  });
});

describe('countNonBase64Bytes', () => {
  // Breaks if line breaks or padding count as foreign: every genuine base64
  // part would read as part-text and be served still-encoded.
  it('counts nothing in genuine base64, line breaks and padding included', () => {
    const genuine = Buffer.from('%PDF-1.4 fake attachment bytes').toString('base64');
    expect(countNonBase64Bytes(Buffer.from(`${genuine}\r\n${genuine}\n==`))).toBe(0);
  });

  // Breaks if markup, punctuation or spaces slip through: the reported HTML
  // would read as base64 and its junk decode would be served again.
  it('counts the markup, punctuation and spaces of text', () => {
    // < > < ␠ " - : ␠ - ; " > ␠ < > < >  — 17 of 64.
    const html = '<p><span style="font-family: sans-serif;">Hello World</span></p>';
    expect(countNonBase64Bytes(Buffer.from(html))).toBe(17);
    expect(countNonBase64Bytes(Buffer.from('a\tb c'))).toBe(2);
    expect(countNonBase64Bytes(Buffer.from([0x00, 0xff, 0x41]))).toBe(2);
    expect(countNonBase64Bytes(Buffer.alloc(0))).toBe(0);
  });
});

describe('misdeclaredBase64', () => {
  const HTML = '<p><span style="font-family: sans-serif;">Hello World</span></p>';

  // THE reported bug under libbase64 1.3.1: 64 bytes of HTML declared base64,
  // decoded to 34. Breaks if the verdict misses it: the attachment is cached,
  // sized and opened as 34 bytes of binary instead of the text Gmail shows.
  it('flags text mislabelled base64, whichever decoder produced the decode', () => {
    const foreign = countNonBase64Bytes(Buffer.from(HTML));
    expect(misdeclaredBase64('base64', HTML.length, 34, foreign)).toBe(true); // libbase64 1.3.1
    expect(misdeclaredBase64('base64', HTML.length, 9, foreign)).toBe(true); // libbase64 1.3.0
  });

  // Breaks if prose is missed. It has no `=` for the old decoder to stop at, so
  // it never collapsed and was never repaired; its spaces give it away.
  it('flags prose mislabelled base64', () => {
    const prose = Buffer.from('Hello, this is a short note. Thanks!');
    expect(misdeclaredBase64('base64', prose.length, 20, countNonBase64Bytes(prose))).toBe(true);
  });

  // Breaks if a short decode alone is treated as proof: base64 wrapped at 16
  // characters spends a fifth of itself on line breaks and decodes to 67% of
  // its length, and serving its raw bytes would hand the user base64 text in
  // place of the file.
  it('keeps a short decode of a part that IS base64', () => {
    const file = Buffer.from('0123456789'.repeat(12));
    const raw = Buffer.from(file.toString('base64').match(/.{1,16}/g)!.join('\r\n'));
    expect(base64DecodeShort('base64', raw.length, file.length)).toBe(true);
    expect(misdeclaredBase64('base64', raw.length, file.length, countNonBase64Bytes(raw))).toBe(false);
  });

  // Breaks if the two-byte padding allowance is lost: a 10-byte file is 16
  // characters of which two are padding, 62% — and every tiny attachment would
  // be re-fetched raw on open and refused by the antivirus scan.
  it('does not even call a tiny single-line file short', () => {
    expect(base64DecodeShort('base64', 'MDEyMzQ1Njc4OQ=='.length, 10)).toBe(false);
    expect(base64DecodeShort('base64', 'AQ=='.length, 1)).toBe(false);
  });

  // Breaks if one stray byte condemns a part: a relay's trailing space on each
  // line (1 in 78) must not turn a genuine attachment into its base64 text.
  it('tolerates the odd stray byte in genuine base64', () => {
    // 3 foreign bytes in 40 is under one in ten.
    expect(misdeclaredBase64('base64', 40, 7, 3)).toBe(false);
    expect(misdeclaredBase64('base64', 40, 7, 5)).toBe(true);
  });

  // Breaks if a plausible decode is second-guessed on its bytes alone — the
  // decoder already ignored whatever stray bytes there were, so it is right.
  it('never flags a decode that is not short', () => {
    expect(misdeclaredBase64('base64', 400, 300, 400)).toBe(false);
  });

  it('never flags a part that did not claim base64, or has no known length', () => {
    expect(misdeclaredBase64('7bit', HTML.length, 7, 17)).toBe(false);
    expect(misdeclaredBase64(null, HTML.length, 7, 17)).toBe(false);
    expect(misdeclaredBase64('base64', 0, 0, 0)).toBe(false);
  });
});
