import { describe, expect, it } from 'vitest';

import {
  INLINE_IMAGE_SCHEME,
  MIN_INLINE_IMAGE_CHARS,
  findDataImages,
  findInlineImageRefs,
  hasInlineImageRefs,
  makeInlineImageRef,
  replaceRanges,
  restoreInlineImages,
} from '../../../src/utils/inline-images';

// What breaks if this file fails: a mail's images. Every failure here is silent
// and visual rather than an exception —
//
//  * A pattern that matches one character too many eats the closing quote of the
//    attribute it lives in, so the ref is written into broken markup and the
//    image never renders again. The base64 it replaced is gone by then.
//  * A pattern that matches one character too few leaves a fragment of base64
//    behind: the body still holds megabytes, the cursor still selects it, and
//    the extraction pass never drains.
//  * A ref format that `hasInlineImageRefs` cannot recognise means the read path
//    hands `sarv-inline:<hash>` straight to the renderer as an image URL.
//  * `replaceRanges` producing overlapping or out-of-order output corrupts the
//    body outright.
//
// So the assertions are all about EXACT boundaries, and about round-tripping the
// original string back byte for byte.

/** A base64 payload long enough to clear MIN_INLINE_IMAGE_CHARS. */
const bigPayload = (fill = 'A'): string => fill.repeat(MIN_INLINE_IMAGE_CHARS + 64);

const dataUri = (mime: string, payload: string): string => `data:${mime};base64,${payload}`;

const HASH = 'a'.repeat(32);

describe('inline-images — finding data: URIs', () => {
  // The base case, and the boundary that matters most: the match must stop at
  // the closing quote. If it runs past it, the rewritten body loses the quote
  // and the <img> tag is malformed.
  it('matches the URI exactly, never the quote that closes the attribute', () => {
    const payload = bigPayload();
    const html = `<p>hi</p><img src="${dataUri('image/png', payload)}" width="10">`;
    const [found] = findDataImages(html);

    expect(found).toBeDefined();
    expect(html.slice(found.start, found.end)).toBe(dataUri('image/png', payload));
    expect(html[found.end]).toBe('"');
    expect(found.mime).toBe('image/png');
    expect(found.base64).toBe(payload);
  });

  // CSS backgrounds are the other place images hide, and there the terminator is
  // `)` rather than a quote. Missing this leaves half the images in a marketing
  // mail behind.
  it("stops at the ) of an unquoted CSS url(...)", () => {
    const payload = bigPayload('B');
    const html = `<div style="background:url(${dataUri('image/gif', payload)}) no-repeat">`;
    const [found] = findDataImages(html);

    expect(html.slice(found.start, found.end)).toBe(dataUri('image/gif', payload));
    expect(html[found.end]).toBe(')');
  });

  // Real senders wrap long attribute values. The whitespace is legal in the
  // attribute but not part of the payload, so it must be stripped from the bytes
  // we hash and excluded from the range we replace.
  it('folds whitespace out of a wrapped payload without widening the range', () => {
    const half = 'C'.repeat(MIN_INLINE_IMAGE_CHARS);
    const html = `<img src="data:image/jpeg;base64,${half}\n  ${half}">`;
    const [found] = findDataImages(html);

    expect(found.base64).toBe(half + half);
    expect(html[found.end]).toBe('"');
    // The trailing newline+spaces before the quote are inside the regex match
    // but must not be inside the replaced range.
    expect(html.slice(found.start, found.end).endsWith(half)).toBe(true);
  });

  // The 1 KB floor is deliberate: tracking pixels and spacer GIFs cost nothing
  // and rewriting them would touch nearly every marketing mail for no bytes.
  it('leaves a sub-threshold image (a tracking pixel) alone', () => {
    const html = `<img src="${dataUri('image/gif', 'R0lGODlhAQABAIAAAAAAAP')}">`;
    expect(findDataImages(html)).toEqual([]);
  });

  // A body with several images must yield disjoint, ascending ranges — that is
  // the precondition replaceRanges relies on.
  it('returns every image, in ascending disjoint ranges', () => {
    const html =
      `<img src="${dataUri('image/png', bigPayload('D'))}">` +
      `<img src="${dataUri('image/webp', bigPayload('E'))}">`;
    const found = findDataImages(html);

    expect(found).toHaveLength(2);
    expect(found[0].end).toBeLessThanOrEqual(found[1].start);
    expect(found.map((image) => image.mime)).toEqual(['image/png', 'image/webp']);
  });

  // A non-image data: URI (an attached PDF, a font) is not ours to move: the
  // renderer resolves it differently and the store is typed for images.
  it('ignores a non-image data: URI', () => {
    const html = `<a href="data:application/pdf;base64,${bigPayload()}">invoice</a>`;
    expect(findDataImages(html)).toEqual([]);
  });

  // The cheap pre-test that decides whether to run the regex at all. If it were
  // wrong in this direction, bodies would be scanned needlessly on every read.
  it('short-circuits a body with no base64 at all', () => {
    expect(findDataImages('<p>a perfectly ordinary mail</p>')).toEqual([]);
    expect(findDataImages('')).toEqual([]);
  });

  // THE regression this file exists for, and the one it originally missed. A
  // greedy character class over the payload is linear in TIME but not in STACK:
  // V8 matches a quantified class against the native stack, so `RegExp.exec`
  // itself throws `RangeError: Maximum call stack size exceeded` once the payload
  // is big enough. A synthetic 200 KB image passes; a production mailbox has images of
  // several MB, and every one of them threw — the extraction pass died on its
  // first chunk with 126 bodies pending. Sizes here bracket the real range.
  it.each([1, 4, 12])('finds a %d MB image without blowing the regex stack', (megabytes) => {
    const payload = 'QUJDRA'.repeat(Math.ceil((megabytes * 1024 * 1024) / 6));
    const html = `<p>big</p><img src="${dataUri('image/jpeg', payload)}" alt="x">`;

    const found = findDataImages(html);

    expect(found).toHaveLength(1);
    expect(found[0].base64).toBe(payload);
    expect(html[found[0].end]).toBe('"');
    expect(found[0].mime).toBe('image/jpeg');
  });

  // Several large images in one body: the scan must resume AFTER each payload,
  // not inside it — restarting inside would rescan megabytes per image and turn
  // a 40-image newsletter into quadratic work.
  it('finds every image in a body of several large ones', () => {
    const big = (fill: string): string => fill.repeat(200_000);
    const html = ['A', 'B', 'C']
      .map((fill) => `<img src="${dataUri('image/png', big(fill))}">`)
      .join('');

    const found = findDataImages(html);

    expect(found).toHaveLength(3);
    expect(found.map((image) => image.base64[0])).toEqual(['A', 'B', 'C']);
    for (const image of found) expect(html[image.end]).toBe('"');
  });

  // The input is attacker-controlled HTML up to 21 MB. A backtracking pattern
  // here is a hang, not a slow path — so a pathological body must still finish
  // in linear time. The assertion is a wall-clock ceiling, generous enough not
  // to be flaky but far below what catastrophic backtracking would take.
  it('does not backtrack on a pathological body', () => {
    const hostile = `<img src="data:image/png;base64,${'='.repeat(200_000)}`;
    const startedAt = Date.now();
    findDataImages(hostile);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('inline-images — refs', () => {
  it('recognises its own ref format and nothing else', () => {
    const html = `<img src="${makeInlineImageRef(HASH)}">`;

    expect(hasInlineImageRefs(html)).toBe(true);
    expect(findInlineImageRefs(html)).toEqual([HASH]);
    // The renderer's in-memory prompt cache uses `sarv-image:` for a different
    // job. Confusing the two hands a ref to a resolver that returns null for it.
    expect(hasInlineImageRefs('<img src="sarv-image:1a2b3c">')).toBe(false);
    expect(INLINE_IMAGE_SCHEME).toBe('sarv-inline');
  });

  it('reports each hash once however many times the body uses it', () => {
    const other = 'b'.repeat(32);
    const html = `${makeInlineImageRef(HASH)} ${makeInlineImageRef(other)} ${makeInlineImageRef(HASH)}`;
    expect(findInlineImageRefs(html)).toEqual([HASH, other]);
  });

  // A stateful global regex whose lastIndex is not reset returns different
  // results on the second call for the same input — the classic version of this
  // bug drops images from every body after the first.
  it('is not stateful across calls', () => {
    const html = `<img src="${makeInlineImageRef(HASH)}">`;
    expect(findInlineImageRefs(html)).toEqual(findInlineImageRefs(html));

    const withImage = `<img src="${dataUri('image/png', bigPayload('F'))}">`;
    expect(findDataImages(withImage)).toEqual(findDataImages(withImage));
  });

  it('costs nothing on an empty body', () => {
    expect(hasInlineImageRefs('')).toBe(false);
    expect(findInlineImageRefs('')).toEqual([]);
  });
});

describe('inline-images — replaceRanges', () => {
  it('replaces in one pass, preserving everything between the ranges', () => {
    const out = replaceRanges('0123456789', [
      { start: 2, end: 4, replacement: 'XX' },
      { start: 6, end: 8, replacement: 'Y' },
    ]);
    expect(out).toBe('01XX45Y89');
  });

  it('returns the source unchanged when there is nothing to replace', () => {
    expect(replaceRanges('abc', [])).toBe('abc');
  });

  // Defensive: an overlapping range would otherwise emit a duplicated fragment
  // into the middle of a body.
  it('skips a range that overlaps the previous one rather than duplicating text', () => {
    const out = replaceRanges('0123456789', [
      { start: 2, end: 6, replacement: 'X' },
      { start: 4, end: 8, replacement: 'Y' },
    ]);
    expect(out).toBe('01X6789');
  });
});

describe('inline-images — restoreInlineImages', () => {
  // The whole design rests on this: what comes out has to be byte-identical to
  // what went in, or we have silently degraded the user's mail.
  it('round-trips a body exactly', () => {
    const payload = bigPayload('G');
    const original = `<p>see</p><img src="${dataUri('image/png', payload)}" alt="x">`;
    const [found] = findDataImages(original);
    const stripped = replaceRanges(original, [
      { start: found.start, end: found.end, replacement: makeInlineImageRef(HASH) },
    ]);

    expect(stripped).not.toContain('base64');
    expect(restoreInlineImages(stripped, () => ({ mime: found.mime, base64: found.base64 }))).toBe(
      original,
    );
  });

  // A missing blob must stay VISIBLE. Substituting a transparent pixel would
  // make a lost image indistinguishable from a deliberate spacer, so nobody
  // would ever report it.
  it('leaves an unresolvable ref in place instead of hiding it', () => {
    const html = `<img src="${makeInlineImageRef(HASH)}">`;
    expect(restoreInlineImages(html, () => null)).toBe(html);
  });

  it('restores every occurrence of a repeated ref', () => {
    const ref = makeInlineImageRef(HASH);
    const html = `<img src="${ref}"><img src="${ref}">`;
    const out = restoreInlineImages(html, () => ({ mime: 'image/png', base64: 'AAAA' }));
    expect(out).toBe('<img src="data:image/png;base64,AAAA"><img src="data:image/png;base64,AAAA">');
  });

  it('is a no-op on a body with no refs', () => {
    const html = '<p>plain</p>';
    expect(restoreInlineImages(html, () => ({ mime: 'image/png', base64: 'AAAA' }))).toBe(html);
  });
});
