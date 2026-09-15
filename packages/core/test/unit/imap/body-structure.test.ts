import { describe, expect, it } from 'vitest';

import {
  base64DecodeCollapsed,
  findAttachmentNodeByName,
  findAttachmentPartByName,
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
// A base64 decoder keeps only alphabet characters and stops at the first `=`, so
// raw text claiming `base64` collapses: `<p><span style=` decoded to SEVEN
// bytes, which is what got cached, stored as the attachment's size, and shown in
// the chip. Both the download path (against the size the server declared) and
// the import path (against the part's raw length in the message source) key off
// this ONE predicate, so it is pinned here rather than in either caller.
describe('base64DecodeCollapsed', () => {
  /** The download path's call shape: a bodystructure node's declared encoding
   *  and size, against what the decode actually produced. */
  const collapsed = (part: Partial<BodyStructure>, decodedLength: number) => {
    const n = node({ part: '2', encoding: 'base64', size: 400, ...part });
    return base64DecodeCollapsed(n.encoding, n.size, decodedLength);
  };

  it('flags a base64 part that decoded to under half its declared size', () => {
    expect(collapsed({}, 7)).toBe(true);
    expect(collapsed({ encoding: 'BASE64' }, 7)).toBe(true);
  });

  it('accepts a genuine base64 decode (~75% of declared, never under half)', () => {
    expect(collapsed({}, 300)).toBe(false);
    expect(collapsed({}, 200)).toBe(false); // exactly half
  });

  it('never flags a part that did not claim base64, however short', () => {
    expect(collapsed({ encoding: 'quoted-printable' }, 7)).toBe(false);
    expect(collapsed({ encoding: '' }, 7)).toBe(false);
  });

  it('never flags without a pre-decode size to compare against, and is null-safe', () => {
    // The import path reaches this with 0 whenever the part could not be found
    // in the source at all. Breaks if an unknown pre-decode size is read as
    // "collapsed" and every such attachment is re-labelled.
    expect(collapsed({ size: 0 }, 7)).toBe(false);
    expect(base64DecodeCollapsed(null, 400, 7)).toBe(false);
    expect(base64DecodeCollapsed(undefined, 400, 7)).toBe(false);
  });
});
