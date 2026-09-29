// @vitest-environment happy-dom
// Regions are cut with the DOM (the library's boundary detector and slicer).
import { describe, expect, it, vi } from 'vitest';

import { regionMarker } from '../../../../../src/services/first-split/prompt';
import {
  chunkRegions,
  prepareDocument,
  splitRegions,
  withImageRefs,
  type SplitRegion,
} from '../../../../../src/services/first-split/regions';
import {
  ALICE_TEXT,
  BOB_TEXT,
  CAROL_TEXT,
  DAN_TEXT,
  LOOPED_AT,
  LOOPED_IN_BODY,
} from '../../components/email-detail/looped-in-fixture';

/** A region's text as the DOM reads it: tags gone, entities decoded once. */
const textOf = (html: string): string => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';

/**
 * The first email's body, cut into RAW regions at the library's quote
 * boundaries, and packed into chunks.
 *
 * What breaks if this file goes red: the AI stops seeing the history it is
 * meant to split. The old pipeline capped the body at ~30K characters and
 * SHRANK it by dropping the deepest quotes — the oldest messages of a
 * looped-in chain were simply never shown to the model — and fed it a body
 * already cleaned by rules that delete whatever follows a "--" or "Sent from
 * my iPhone" line, which on a mangled history is sometimes whole messages.
 */

const sentAt = new Date(LOOPED_AT * 1000);
const noImages = (dataUrl: string) => `sarv-image:${dataUrl.length.toString(16).padStart(8, '0')}`;
const regionsOf = (body: string) => splitRegions(body, { sentAt, registerImage: noImages })!;

describe('splitRegions', () => {
  // N quoted messages → N+1 regions, and every quoted region OPENS with its
  // attribution line, from which the model reads that message's sender and
  // date.
  it('cuts a Gmail nest into one region per message, each opening with its attribution', () => {
    const regions = regionsOf(LOOPED_IN_BODY);
    expect(regions.map((region) => region.index)).toEqual([0, 1, 2, 3]);
    expect(regions[0]!.html).toContain(DAN_TEXT);
    expect(regions[0]!.html).not.toContain(CAROL_TEXT);
    const bodies = [CAROL_TEXT, BOB_TEXT, ALICE_TEXT];
    const senders = ['Carol Diaz', 'Bob Ray', 'Alice Chen'];
    regions.slice(1).forEach((region, index) => {
      expect(region.html).toContain(bodies[index]!);
      const text = textOf(region.html);
      expect(text.indexOf(`On `)).toBeLessThan(text.indexOf(bodies[index]!.slice(0, 20)));
      expect(region.attribution?.name).toBe(senders[index]);
      // Each region holds its own message only, not the ones quoted under it.
      for (const other of bodies.filter((_, at) => at !== index)) expect(region.html).not.toContain(other);
    });
    expect(regions[1]!.attribution?.email).toBe('carol@acme.example');
  });

  // RAW means raw: Standard's cleaning cuts after a signature delimiter or a
  // mobile footer; inside a region that text may be the rest of a message.
  it('preserves content after a "--" line or a "Sent from my iPhone" footer', () => {
    const body = [
      '<div>Own words here.<br>--<br>Dan<br>The review moved to Friday, see the agenda below.</div>',
      '<div class="gmail_quote"><div class="gmail_attr">On Tue, 3 Mar 2026 at 09:00, Carol Diaz &lt;carol@acme.example&gt; wrote:<br></div>',
      '<blockquote class="gmail_quote"><div>Carol text.<br>Sent from my iPhone<br>PS the budget line changed too.</div></blockquote></div>',
    ].join('');
    const regions = regionsOf(body);
    expect(regions[0]!.html).toContain('The review moved to Friday');
    expect(regions[1]!.html).toContain('PS the budget line changed too.');
  });

  // Only what carries no text goes; a data: image becomes a short ref the
  // model copies back verbatim (the renderer resolves it at display time).
  it('drops head, style, script and comments, and turns data: images into refs', () => {
    const body = [
      '<html><head><title>t</title><style>p{color:red}</style><meta charset="utf-8"></head><body>',
      '<!--[if gte mso 9]><xml>office</xml><![endif]-->',
      '<p>Hello <img src="data:image/png;base64,AAAA" alt="logo"> world</p>',
      '<script>alert(1)</script><!-- a comment -->',
      '</body></html>',
    ].join('');
    const [only] = regionsOf(body);
    const doc = new DOMParser().parseFromString(only!.html, 'text/html');
    expect(doc.querySelector('style, script, title, meta')).toBeNull();
    expect(doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT).nextNode()).toBeNull();
    expect(only!.html).not.toContain('office');
    expect(only!.html).toContain('src="sarv-image:');
    expect(only!.html).not.toContain('base64');
  });

  it('registers data: images through the image cache by default', async () => {
    vi.resetModules();
    const registerImage = vi.fn(() => 'sarv-image:0000abcd');
    vi.doMock('../../../../../src/services/image-cache', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../../../src/services/image-cache')>()),
      registerImage,
    }));
    const { splitRegions: fresh } = await import('../../../../../src/services/first-split/regions');
    const [only] = fresh('<p><img src="data:image/gif;base64,R0lG"></p>')!;
    expect(registerImage).toHaveBeenCalledWith('data:image/gif;base64,R0lG');
    expect(only!.html).toContain('sarv-image:0000abcd');
    vi.doUnmock('../../../../../src/services/image-cache');
  });

  // A body with no attribution at all is ONE region — the whole email.
  it('returns a body with no boundaries as a single region', () => {
    const regions = regionsOf('<p>Just a note, nothing quoted.</p>');
    expect(regions).toHaveLength(1);
    expect(regions[0]!.index).toBe(0);
    expect(regions[0]!.attribution).toBeNull();
  });

  it('cuts an Outlook header block', () => {
    const body = [
      '<div>Forwarding the chain below for context on the vendor contract.</div>',
      '<div id="divRplyFwdMsg"><b>From:</b> Alice Chen &lt;alice@acme.example&gt;<br>',
      '<b>Sent:</b> Monday, March 2, 2026 10:00 AM<br><b>To:</b> Dan Moss<br><b>Subject:</b> Vendor contract</div>',
      '<div>The vendor contract renewal needs legal review before the end of the month.</div>',
    ].join('');
    const regions = regionsOf(body);
    expect(regions).toHaveLength(2);
    expect(regions[1]!.html).toMatch(/From:/);
    expect(regions[1]!.html).toContain('legal review');
  });

  // The husk check measures a lone output against the message ALONE; with
  // the attribution counted, an Outlook header block made a short reply look
  // like a husk of its own region.
  it('measures each region\'s message without its attribution line', () => {
    const regions = regionsOf(LOOPED_IN_BODY);
    expect(regions[0]!.messageChars).toBe(regions[0]!.text.length);
    for (const region of regions.slice(1)) {
      expect(region.messageChars).toBeLessThan(region.text.length);
      expect(region.text).toMatch(/wrote/);
    }
    const carol = regions[1]!;
    expect(carol.messageChars).toBeGreaterThanOrEqual(CAROL_TEXT.replace(/[^a-z0-9]+/gi, '').length);
    expect(regions[3]!.messageChars).toBe(ALICE_TEXT.replace(/[^a-z0-9]+/gi, '').length);
  });

  it('is null for an empty body or one that cannot be parsed', () => {
    expect(splitRegions('', {})).toBeNull();
    expect(splitRegions('   ', {})).toBeNull();
    expect(splitRegions('<p>x</p>', { parser: () => { throw new Error('no DOM'); } })).toBeNull();
    expect(splitRegions('<p>x</p>', { parser: () => ({ body: null }) as unknown as Document })).toBeNull();
  });
});

describe('prepareDocument', () => {
  /** Data URLs the restart walk (populateCacheFromHtml) does NOT re-register. */
  const UNRESTORABLE = [
    'data:image/png;base64,iVBORw0K\nGgoAAAAN', // base64 wrapped across lines
    'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
    'data:image/png;charset=utf-8;base64,iVBORw0KGgo=', // a parameter before base64
  ];
  const RESTORABLE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const rawBodyOf = (srcs: readonly string[]) => srcs.map((src) => `<p>img <img src="${src}"></p>`).join('');

  // Regression: every `data:` src became a ref, but after a restart the cache
  // is refilled only from canonical base64 image URLs found in the rawBody. A
  // wrapped, utf8 or parameterised data URL turned into a ref in a PERSISTED
  // part that nothing resolves again — a broken image in the AI view.
  it('swaps only the data: images the image cache restores, leaving the rest inline', () => {
    const doc = new DOMParser().parseFromString(rawBodyOf([RESTORABLE, ...UNRESTORABLE]), 'text/html');
    const register = vi.fn(() => 'sarv-image:0000abcd');
    prepareDocument(doc, register);
    expect(register.mock.calls).toEqual([[RESTORABLE]]);
    const srcs = [...doc.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(srcs).toEqual(['sarv-image:0000abcd', ...UNRESTORABLE]);
  });

  // The same, end to end across a restart: every ref a split writes resolves
  // once the thread is reopened (the cache refilled from the rawBody alone).
  it('writes only refs that resolve after a restart', async () => {
    const rawBody = rawBodyOf([RESTORABLE, ...UNRESTORABLE]);
    vi.resetModules();
    const { splitRegions: session1 } = await import('../../../../../src/services/first-split/regions');
    const [region] = session1(rawBody)!;
    expect(region!.html).toContain('sarv-image:');

    vi.resetModules(); // a restart: the in-memory cache is empty
    const cache = await import('../../../../../src/services/image-cache');
    cache.populateCacheFromHtml(rawBody);
    const resolved = cache.resolveRefsInHtml(region!.html);
    expect(resolved).not.toContain('sarv-image:');
    expect(resolved).toContain(RESTORABLE);
  });

  it('leaves remote images and ordinary content alone', () => {
    const doc = new DOMParser().parseFromString('<p>a <img src="https://x.test/a.png"></p>', 'text/html');
    const register = vi.fn();
    prepareDocument(doc, register);
    expect(register).not.toHaveBeenCalled();
    expect(doc.body.innerHTML).toContain('https://x.test/a.png');
  });
});

describe('withImageRefs', () => {
  // A stored part must never carry base64: main returns bodies with inline
  // images inflated back to data: URIs, and the cache holds one row per thread.
  it('turns data: images into refs', () => {
    const html = '<div>chart <img src=" data:image/png;base64,iVBORw0KGgo= "></div>';
    const out = withImageRefs(html, { registerImage: () => 'sarv-image:chart' });
    expect(out).toContain('src="sarv-image:chart"');
    expect(out).not.toContain('base64');
  });

  it('returns the HTML untouched when it has no data: image', () => {
    const register = vi.fn();
    const html = '<div>plain <img src="https://x.test/a.png"></div>';
    expect(withImageRefs(html, { registerImage: register })).toBe(html);
    expect(register).not.toHaveBeenCalled();
  });

  // The fallback parts' bodies (Standard's segments) go through the same rule:
  // a canonical base64 image is stored as a ref (no megabytes of base64 in the
  // one-row-per-thread cache), anything the cache cannot restore stays inline.
  it('stores fallback bodies with restorable images as refs, the rest inline', () => {
    const wrapped = 'data:image/png;base64,iVBORw0K\nGgo=';
    const out = withImageRefs(
      `<div><img src="data:image/png;base64,iVBORw0KGgo="><img src="${wrapped}"></div>`,
      { registerImage: () => 'sarv-image:chart' },
    );
    expect(out).toContain('src="sarv-image:chart"');
    expect(out).toContain('iVBORw0K');
  });

  it('leaves a data: URL that is not an image source alone', () => {
    const register = vi.fn();
    withImageRefs('<a href="data:text/plain,hi">link</a>', { registerImage: register });
    expect(register).not.toHaveBeenCalled();
  });

  // A fat part beats a lost one: an unparseable body is stored as it is.
  it('returns the HTML untouched when it cannot be parsed', () => {
    const html = '<img src="data:image/png;base64,AAAA">';
    expect(withImageRefs(html, { parser: () => { throw new Error('no DOM'); } })).toBe(html);
    expect(withImageRefs(html, { parser: () => ({ body: null }) as unknown as Document })).toBe(html);
  });

  it('registers through the image cache by default', async () => {
    vi.resetModules();
    const registerImage = vi.fn(() => 'sarv-image:0000beef');
    vi.doMock('../../../../../src/services/image-cache', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../../../src/services/image-cache')>()),
      registerImage,
    }));
    const { withImageRefs: fresh } = await import('../../../../../src/services/first-split/regions');
    expect(fresh('<img src="data:image/png;base64,QkJCQg==">')).toContain('sarv-image:0000beef');
    expect(registerImage).toHaveBeenCalledWith('data:image/png;base64,QkJCQg==');
    vi.doUnmock('../../../../../src/services/image-cache');
  });
});

describe('chunkRegions', () => {
  const region = (index: number, chars: number): SplitRegion => ({
    index,
    html: `<p>${'x'.repeat(Math.max(0, chars - 7))}</p>`,
    text: 'x'.repeat(chars),
    messageChars: chars,
    attribution: null,
  });
  const overhead = (index: number) => regionMarker(index).length + 2;

  // No size-driven loss, no shrink: consecutive regions share a chunk while
  // they fit, and no chunk is ever over budget.
  it('packs consecutive regions without ever exceeding the budget', () => {
    const regions = [0, 1, 2, 3, 4, 5].map((index) => region(index, 400));
    const plan = chunkRegions(regions, 1000);
    expect(plan.fallbackRegions).toEqual([]);
    for (const chunk of plan.chunks) expect(chunk.chars).toBeLessThanOrEqual(1000);
    expect(plan.chunks.flatMap((chunk) => chunk.regions.map((each) => each.index))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.chunks[0]!.includesOwnRegion).toBe(true);
    expect(plan.chunks[1]!.includesOwnRegion).toBe(false);
    expect(plan.chunks[0]!.chars).toBe(regions[0]!.html.length + overhead(0) + regions[1]!.html.length + overhead(1));
  });

  // A region that cannot fit on its own keeps Standard's rendering — it is
  // never shrunk, and the regions around it are still sent.
  it('marks a region over budget on its own as fallback and still sends the rest', () => {
    const regions = [region(0, 100), region(1, 5000), region(2, 100)];
    const plan = chunkRegions(regions, 1000);
    expect(plan.fallbackRegions.map((each) => each.index)).toEqual([1]);
    expect(plan.chunks.flatMap((chunk) => chunk.regions.map((each) => each.index))).toEqual([0, 2]);
    expect(plan.tooLarge).toBe(false);
  });

  // At most MAX_CHUNKS requests per email: what is left falls back.
  it('marks regions past the last chunk as fallback', () => {
    const regions = [0, 1, 2, 3, 4, 5].map((index) => region(index, 900));
    const plan = chunkRegions(regions, 1000, 4);
    expect(plan.chunks).toHaveLength(4);
    expect(plan.fallbackRegions.map((each) => each.index)).toEqual([4, 5]);
  });

  // Named limitation: with no boundary there is no cut point, so a body over
  // budget cannot be chunked — the split fails as too_large and Standard's
  // rendering stays.
  it('reports too_large for a single region over budget (known limitation)', () => {
    const plan = chunkRegions([region(0, 5000)], 1000);
    expect(plan).toMatchObject({ chunks: [], tooLarge: true });
    expect(plan.fallbackRegions).toHaveLength(1);
  });

  // An empty region 0 is a forward with no comment: nothing to send for it.
  it('skips regions with no visible content', () => {
    const empty: SplitRegion = { index: 0, html: '<div class="gmail_quote"></div>', text: '', messageChars: 0, attribution: null };
    const plan = chunkRegions([empty, region(1, 100)], 1000);
    expect(plan.chunks[0]!.regions.map((each) => each.index)).toEqual([1]);
    expect(plan.chunks[0]!.includesOwnRegion).toBe(false);
  });

  it('sends the looped-in fixture in one chunk under the real budget', () => {
    const plan = chunkRegions(regionsOf(LOOPED_IN_BODY));
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]!.regions).toHaveLength(4);
  });
});
