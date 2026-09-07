import { describe, expect, it } from 'vitest';

import { findAttachmentPartByName } from '../../../src/imap/body-structure';
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
