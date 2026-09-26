// @vitest-environment happy-dom
import { converter, parse as parseColor, wcagContrast } from 'culori';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyEmailDarkMode,
  darkenColorToken,
  darkenLineColor,
  darkenShadowColor,
  darkenStyleAttribute,
  darkenStyleSheet,
  darkenSurfaceColor,
  darkenTextColor,
  darkenValue,
  splitCommentWrapper,
  textColorOn,
  textReadsOn,
} from '../../../../src/utils/email-dark-mode';

// This is an opt-in rewrite of SOMEONE ELSE'S markup. Two things can go wrong
// and neither of them throws:
//
//   1. The message becomes unreadable — grey text on the brand red it was
//      drawn white on, a divider dimmer than the page, a CTA that loses its
//      colour, a black newsletter turned light.
//   2. A reader who never enabled it, or a message the walker cannot handle,
//      stops getting the white page that ships today.
//
// Every test below pins one of those two.

const oklch = converter('oklch');
const lightnessOf = (css: string): number => oklch(parseColor(css)!)!.l;
const chromaOf = (css: string): number => oklch(parseColor(css)!)!.c ?? 0;

const WHITE = oklch(parseColor('#ffffff')!)!;
const BLACK = oklch(parseColor('#000000')!)!;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('darkenSurfaceColor', () => {
  // Regression: white paper is the whole point — if it does not come back dark
  // the feature does nothing at all.
  it('flips paper to a dark surface and calls it inverted', () => {
    const flipped = darkenSurfaceColor(WHITE);
    expect(flipped.surface).toBe('inverted');
    expect(flipped.color.l).toBeCloseTo(0.18, 2);
  });

  // Regression: the app's own chrome sits at OKLCH L 0.14. A message surface
  // BELOW that punches a blacker hole in the middle of the reading pane.
  it('never lands darker than the window around it', () => {
    for (const paper of ['#ffffff', '#fafafa', '#f5f5f5', '#eeeeee', '#dddddd']) {
      expect(darkenSurfaceColor(oklch(parseColor(paper)!)!).color.l).toBeGreaterThanOrEqual(0.14);
    }
  });

  // Regression: THE button bug. A brand red CTA that gets flipped comes back a
  // pale pink with grey text on it — the kept surface is what stops that, and
  // it is the signal the text pass reads.
  it('keeps a saturated brand colour, only pulling back a glaring one', () => {
    const cta = darkenSurfaceColor(oklch(parseColor('#d32f2f')!)!);
    expect(cta.surface).toBe('kept');
    expect(cta.color.h).toBeCloseTo(oklch(parseColor('#d32f2f')!)!.h!, 1);
    const glaring = darkenSurfaceColor(oklch(parseColor('#ff5252')!)!);
    expect(glaring.color.l).toBeLessThanOrEqual(0.58);
  });

  // Regression: a footer or hero the sender already drew dark must be left
  // exactly as it is — flipping it turns it LIGHT, the opposite of the ask.
  it('leaves an already-dark surface untouched, by identity', () => {
    const dark = oklch(parseColor('#111827')!)!;
    const kept = darkenSurfaceColor(dark);
    expect(kept.surface).toBe('kept');
    expect(kept.color).toBe(dark);
  });

  // Regression: a pale highlight band belongs to the page, not to the brand.
  // Kept as-is it stays a glaring yellow slab in a dark message.
  it('treats a pale tint as paper but carries a trace of the tint over', () => {
    const band = darkenSurfaceColor(oklch(parseColor('#fff9c4')!)!);
    expect(band.surface).toBe('inverted');
    expect(band.color.c!).toBeGreaterThan(0);
    expect(band.color.c!).toBeLessThanOrEqual(0.06);
  });
});

describe('darkenTextColor', () => {
  // Regression: the grey hierarchy. #999 is a caption and #333 is body copy;
  // clamp them both into one band and every message reads as one flat voice.
  it('keeps the sender ordering of greys and stops short of pure white', () => {
    const body = darkenTextColor(oklch(parseColor('#333333')!)!);
    const caption = darkenTextColor(oklch(parseColor('#999999')!)!);
    expect(caption.l).toBeLessThan(body.l);
    expect(darkenTextColor(BLACK).l).toBeCloseTo(0.93, 2);
    expect(darkenTextColor(WHITE).l).toBeCloseTo(0.62, 2);
    expect(darkenTextColor(BLACK).l).toBeLessThan(1);
  });

  // Regression: a link must stay recognisably its own colour and stay legible.
  // Full saturation at high lightness vibrates on near-black.
  it('lifts a coloured link without letting it vibrate', () => {
    const source = oklch(parseColor('#1a73e8')!)!;
    const link = darkenTextColor(source);
    expect(link.h).toBeCloseTo(source.h!, 1);
    expect(link.l).toBeGreaterThanOrEqual(0.72);
    expect(link.c!).toBeLessThanOrEqual(0.15);
  });
});

describe('darkenLineColor', () => {
  // Regression: a divider dimmer than the app's own borders (OKLCH L 0.28) is
  // a divider the reader cannot see, and a table loses its grid.
  it('lands a hairline in a band that is actually visible', () => {
    const line = darkenLineColor(oklch(parseColor('#dddddd')!)!);
    expect(line.l).toBeGreaterThanOrEqual(0.3);
    expect(line.l).toBeLessThanOrEqual(0.46);
  });

  it('leaves a rule that is already dark alone', () => {
    const dark = oklch(parseColor('#1a1a1a')!)!;
    expect(darkenLineColor(dark)).toBe(dark);
  });
});

describe('darkenShadowColor', () => {
  // Regression: a shadow lightened by a naive flip becomes a glow, and every
  // card in the message grows a halo.
  it('keeps a shadow dark', () => {
    expect(darkenShadowColor(oklch(parseColor('rgba(0, 0, 0, 0.2)')!)!).l).toBeLessThanOrEqual(0.2);
    expect(darkenShadowColor(oklch(parseColor('#cccccc')!)!).l).toBeLessThanOrEqual(0.2);
  });
});

describe('textReadsOn / textColorOn — text against the surface it was left on', () => {
  // Regression: the whole point of keeping a sender's surface is that the
  // pairing on it still works. White on a brand red does, and must be left
  // exactly as written or every CTA in the message loses its label colour.
  it('leaves a pairing that still meets AA alone', () => {
    expect(textReadsOn(WHITE, oklch(parseColor('#d32f2f')!)!)).toBe(true);
  });

  // Regression: THE kept-surface bug. A text colour that was written for the
  // white page further up the tree, or a surface that was dimmed to sit on a
  // dark one, leaves black on near-black — which the old rule froze in place
  // because the surface was "the sender's".
  it('reports a pairing that has stopped working', () => {
    expect(textReadsOn(BLACK, oklch(parseColor('#1a1a2e')!)!)).toBe(false);
    expect(textReadsOn(oklch(parseColor('#666666')!)!, oklch(parseColor('#d32f2f')!)!)).toBe(false);
  });

  // Regression: picking a fixed pole would put light ink on a pale kept tint
  // and dark ink on a dark one — the same failure with the colours swapped.
  it('moves the text to whichever end actually reads', () => {
    const dark = oklch(parseColor('#1a1a2e')!)!;
    expect(wcagContrast(textColorOn(BLACK, dark), dark)).toBeGreaterThanOrEqual(4.5);
    const pale = oklch(parseColor('#f0e68c')!)!;
    expect(wcagContrast(textColorOn(WHITE, pale), pale)).toBeGreaterThanOrEqual(4.5);
  });

  // Regression: a coloured heading that is only too dark must come back as the
  // SAME colour, lighter — not as plain white.
  it('keeps the hue it was given', () => {
    const lifted = textColorOn(oklch(parseColor('#1d4ed8')!)!, oklch(parseColor('#111827')!)!);
    expect(lifted.h).toBeCloseTo(oklch(parseColor('#1d4ed8')!)!.h!, 1);
    expect(lifted.c).toBeGreaterThan(0);
  });
});

describe('darkenColorToken', () => {
  // Regression: null means "leave the original bytes alone". Returning a
  // re-serialized copy of an unchanged colour would rewrite the whole message
  // for nothing and lose the sender's own notation.
  it('returns null for anything that is not a colour it should touch', () => {
    expect(darkenColorToken('12px', 'text', 'inverted')).toBeNull();
    expect(darkenColorToken('solid', 'line', 'inverted')).toBeNull();
    expect(darkenColorToken('transparent', 'surface', 'inverted')).toBeNull();
    expect(darkenColorToken('rgba(0, 0, 0, 0)', 'surface', 'inverted')).toBeNull();
    expect(darkenColorToken('#111827', 'surface', 'inverted')).toBeNull();
  });

  // Regression: THE button bug again, at the token level. Text, rules and
  // shadows on a surface the sender still owns must not move.
  it('leaves everything drawn on a kept surface to the sender', () => {
    expect(darkenColorToken('#ffffff', 'text', 'kept')).toBeNull();
    expect(darkenColorToken('#ffffff', 'line', 'kept')).toBeNull();
    expect(darkenColorToken('#000000', 'shadow', 'kept')).toBeNull();
    // A background is never "on" a surface — it IS one, so it still resolves.
    expect(darkenColorToken('#ffffff', 'surface', 'kept')).not.toBeNull();
  });

  // Regression: alpha is how a wash or a shadow is drawn at all; dropping it
  // turns a 20% shadow into an opaque black block.
  it('keeps alpha through the round trip', () => {
    expect(darkenColorToken('rgba(0, 0, 0, 0.5)', 'shadow', 'inverted')).toMatch(/^rgba\(.*0\.5\)$/);
  });

  // Regression: OKLCH can express colours sRGB cannot. Unclamped, a lifted
  // saturated colour formats to a channel outside 0-255 and the whole
  // declaration is dropped by the browser as invalid.
  it('always emits an in-gamut sRGB colour', () => {
    for (const source of ['#00ff00', '#ff00ff', '#1a73e8', '#d32f2f', '#ffffff']) {
      for (const role of ['text', 'surface', 'line'] as const) {
        const out = darkenColorToken(source, role, 'inverted');
        if (!out) continue;
        const channels = out.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        for (const channel of channels) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

describe('darkenValue', () => {
  // Regression: the value walker must only touch the parts that are colours.
  // Rewrite a length or a keyword and the declaration stops applying.
  it('re-colours a shorthand without disturbing its other parts', () => {
    const { value } = darkenValue('1px solid #dddddd', 'line', 'inverted');
    expect(value).toMatch(/^1px solid rgb\(/);
  });

  it('re-colours every stop of a gradient and keeps the direction', () => {
    const { value } = darkenValue('linear-gradient(to right, #ffffff, #eeeeee)', 'surface', 'inverted');
    expect(value).toContain('to right');
    expect(value).not.toContain('#ffffff');
    expect(value).not.toContain('#eeeeee');
    expect(value.match(/rgb\(/g)).toHaveLength(2);
  });

  // Regression: `url(…)` is opaque, and so is the NAME a `var()` references.
  // Descend into either and a tracking pixel's query string or a custom
  // property name gets "re-coloured" into garbage and stops resolving.
  it('never descends into url(), nor into the name a var() references', () => {
    const image = darkenValue('#ffffff url(https://x.test/p.png?bg=red) no-repeat', 'surface', 'inverted');
    expect(image.value).toContain('url(https://x.test/p.png?bg=red)');
    expect(image.value).not.toContain('#ffffff');
    expect(darkenValue('var(--brand-red)', 'text', 'inverted').value).toBe('var(--brand-red)');
  });

  // CHANGED BEHAVIOUR (was: `var()` was skipped whole, fallback included).
  // Regression: THE white-slab bug in a dark body. Mail composed in this app
  // carries `background-color: var(--compose-editor-bg, white)` on its text
  // runs; the frame never loads the stylesheet that declares that property, so
  // the browser paints the FALLBACK. Skip it and every run keeps a white slab
  // behind text we have just lightened for a dark page — white on white.
  it('re-colours the fallback a var() will actually paint with', () => {
    const { value, surface } = darkenValue('var(--compose-editor-bg, white)', 'surface', 'inverted');
    expect(value).toMatch(/^var\(--compose-editor-bg, rgb\([\d\s,]+\)\)$/);
    expect(value).not.toContain('white');
    // The fallback is what paints, so it is what the text pass must read.
    expect(surface).toBe('inverted');
  });

  // Regression: the fallback is a value in its own right — a colour function,
  // a second var(), or something with no colour in it at all.
  it('handles every shape a fallback comes in', () => {
    expect(darkenValue('var(--x, rgb(255, 255, 255))', 'surface', 'inverted').value)
      .toMatch(/^var\(--x, rgb\([\d\s,]+\)\)$/);
    expect(darkenValue('var(--a, var(--b, #ffffff))', 'surface', 'inverted').value)
      .toMatch(/^var\(--a, var\(--b, rgb\([\d\s,]+\)\)\)$/);
    expect(darkenValue('var(--gap, 8px)', 'surface', 'inverted').value).toBe('var(--gap, 8px)');
  });

  // Regression: a brand colour reached through a var() is still a brand
  // colour. Invert it and a red button comes back grey.
  it('keeps a brand fallback the way it keeps a literal one', () => {
    const { value, surface } = darkenValue('var(--brand, #d32f2f)', 'surface', 'inverted');
    // Same colour, re-emitted in the walker's notation — not inverted to a grey.
    expect(value).toBe(`var(--brand, ${darkenValue('#d32f2f', 'surface', 'inverted').value})`);
    expect(value).toContain('rgb(211, 47, 47)');
    expect(surface).toBe('kept');
  });

  // Regression: a colour function is collapsed into one word node. Leave its
  // arguments attached and the value re-emits as `rgb(30, 30, 30)0, 0, 0.5)`.
  it('collapses a colour function cleanly, leaving no arguments behind', () => {
    const { value } = darkenValue('rgba(0, 0, 0, 0.5)', 'text', 'inverted');
    expect(value).toMatch(/^rgba\([\d\s.,]+\)$/);
  });

  // Regression: an untouched value must come back byte-identical so the
  // rewrite never churns markup it had no opinion about.
  it('returns the original string when nothing changed', () => {
    const original = '  0   auto  ';
    expect(darkenValue(original, 'text', 'inverted').value).toBe(original);
  });

  // Regression: the surface a value establishes is what the text pass reads.
  // Get it from the wrong colour and white-on-red comes back grey-on-red.
  it('reports the surface established by the FIRST colour in the value', () => {
    expect(darkenValue('#ffffff url(x.png)', 'surface', 'inverted').surface).toBe('inverted');
    expect(darkenValue('#d32f2f', 'surface', 'inverted').surface).toBe('kept');
    expect(darkenValue('#111827', 'surface', 'inverted').surface).toBe('kept');
    // Transparent paints nothing, so it cannot claim the surface either way.
    expect(darkenValue('transparent', 'surface', 'inverted').surface).toBeNull();
    expect(darkenValue('1px solid #ccc', 'line', 'inverted').surface).toBeNull();
  });
});

describe('darkenStyleAttribute', () => {
  // Regression: the cheap pre-filter. Most inline styles are padding and
  // width; sending each of them through postcss costs a parse per element.
  it('declines a style attribute with no colour in it', () => {
    expect(darkenStyleAttribute('padding: 20px; font-size: 14px', 'inverted')).toBeNull();
  });

  // Regression: the two-pass order. Read the declarations in source order and
  // `color:#fff` is resolved against the INHERITED surface, before the
  // `background:#d32f2f` on the very same element has been seen.
  it('resolves the background first, whatever order it was written in', () => {
    const result = darkenStyleAttribute('color: #ffffff; background: #d32f2f', 'inverted')!;
    expect(result.surface).toBe('kept');
    expect(result.style).toContain('color: #ffffff');
  });

  it('re-colours text against an inverted surface', () => {
    const result = darkenStyleAttribute('background: #ffffff; color: #333333', 'inverted')!;
    expect(result.surface).toBe('inverted');
    expect(lightnessOf(/color: (rgb\([^)]*\))/.exec(result.style)![1]!)).toBeGreaterThan(0.6);
  });

  // Regression: dropping `!important` re-orders the cascade, and the sender's
  // own override stops winning against the frame's stylesheet.
  it('preserves !important', () => {
    expect(darkenStyleAttribute('color: #000000 !important', 'inverted')!.style)
      .toMatch(/!important$/);
  });

  // Regression: Outlook ships `mso-*` on nearly every paragraph. Losing the
  // properties postcss parses fine would rewrite far more than colour.
  it('keeps non-colour declarations, vendor ones included', () => {
    const result = darkenStyleAttribute('mso-line-height-rule: exactly; color: #000000', 'inverted')!;
    expect(result.style).toContain('mso-line-height-rule: exactly');
  });

  // Regression: a half-written style attribute is not worth failing a whole
  // message over — declining leaves it rendering exactly as it does today.
  it('declines anything postcss cannot parse', () => {
    expect(darkenStyleAttribute('color: #fff; }', 'inverted')).toBeNull();
  });
});

describe('darkenStyleSheet', () => {
  // Regression: a rule resolves its OWN surface. Share one across the sheet
  // and the first `background:#d32f2f` turns every later rule's text to stone.
  it('gives each rule its own surface', () => {
    const out = darkenStyleSheet('.btn{background:#d32f2f;color:#ffffff}.muted{color:#999999}');
    expect(out).toContain('color:#ffffff');
    expect(out).not.toContain('#999999');
  });

  // Regression: a rule inside @media (or any at-rule) still paints. Skipping
  // it leaves the mobile layout of a responsive newsletter on white.
  it('descends into at-rules', () => {
    expect(darkenStyleSheet('@media (max-width:600px){.a{color:#000000}}')).not.toContain('#000000');
  });

  // Regression: both failure paths have to hand the sheet back verbatim, or a
  // sender's stylesheet disappears and the message renders unstyled.
  it('returns the sheet untouched when it cannot or need not act', () => {
    const plain = '.a{padding:4px}';
    expect(darkenStyleSheet(plain)).toBe(plain);
    const broken = '.a{color:#fff';
    expect(darkenStyleSheet(broken)).toBe(broken);
  });

  // Regression: THE Outlook bug. Word and Outlook wrap every <style> block they
  // emit in `<!-- … -->`, postcss throws `Unknown word -->` on the closer, and
  // the whole sheet came back untouched — so `body{background:white}` painted a
  // white slab in the middle of the dark thread and `p.MsoNormal{color:black}`
  // left every paragraph black on it. Business mail is mostly Outlook, so this
  // was most of the mail the feature was supposed to handle.
  it("re-colours a stylesheet wrapped in Outlook's HTML comment", () => {
    const out = darkenStyleSheet('<!--\nbody{background:white}\np.MsoNormal{color:black}\n-->');
    expect(out).not.toContain('white');
    expect(out).not.toContain('black');
    // The wrapper itself is put back: it is what the sender sent, and a
    // stylesheet that leaves in a different shape is a second bug.
    expect(out.startsWith('<!--')).toBe(true);
    expect(out.trimEnd().endsWith('-->')).toBe(true);
  });

  // Regression: the closer is the token postcss chokes on, but an opener with
  // no closer is just as common — and postcss silently glues it onto the first
  // selector, so the rule is rewritten under a selector that matches nothing.
  it('handles a half-written wrapper from either end', () => {
    expect(darkenStyleSheet('<!--\np{color:black}')).toContain('<!--');
    expect(darkenStyleSheet('<!--\np{color:black}')).not.toContain('black');
    expect(darkenStyleSheet('p{color:black}\n-->')).not.toContain('black');
  });
});

describe('splitCommentWrapper', () => {
  // Regression: the wrapper has to come off EXACTLY, or postcss is handed a
  // sheet that still throws (too little) or the sender loses a rule (too much).
  it('splits a full wrapper into its three parts', () => {
    expect(splitCommentWrapper('<!--\na{color:red}\n-->')).toEqual({
      open: '<!--',
      body: '\na{color:red}\n',
      close: '-->',
    });
  });

  it('leaves a sheet with no wrapper entirely alone', () => {
    expect(splitCommentWrapper('a{color:red}')).toEqual({
      open: '',
      body: 'a{color:red}',
      close: '',
    });
  });

  // Regression: `-->` is only a CDC token at the END of the sheet. Strip one
  // out of the middle of a value or a selector and the rule is corrupted.
  it('does not strip a marker from the middle of the sheet', () => {
    const css = 'a{content:"-->"}b{color:red}';
    expect(splitCommentWrapper(css).body).toBe(css);
  });
});

describe('applyEmailDarkMode: the paths that decline', () => {
  const html = '<body style="background:#ffffff"><p style="color:#000000">hi</p></body>';

  // Regression: THE default. Every reader who never opened the setting must
  // keep the white page, byte for byte.
  it('does nothing at all when the setting is off', () => {
    const result = applyEmailDarkMode(html, { enabled: false, isDark: true });
    expect(result).toEqual({ html, darkCanvas: false, strategy: 'off' });
    expect(result.html).toBe(html);
  });

  // Regression: the setting has no meaning in the light theme — acting on it
  // there would put a dark message inside a light window.
  it('does nothing in the light theme', () => {
    expect(applyEmailDarkMode(html, { enabled: true, isDark: false }).strategy).toBe('off');
  });

  // Regression: this module is imported by a component that also renders under
  // the node test environment and (one day) SSR. No DOMParser must mean the
  // white page, not a thrown render.
  it('falls back to the white page where there is no DOM', () => {
    vi.stubGlobal('DOMParser', undefined);
    expect(applyEmailDarkMode(html, { enabled: true, isDark: true }).strategy).toBe('off');
  });

  it('falls back to the white page when parsing throws', () => {
    vi.stubGlobal('DOMParser', class { parseFromString(): never { throw new Error('boom'); } });
    expect(applyEmailDarkMode(html, { enabled: true, isDark: true }).strategy).toBe('off');
  });

  it('falls back to the white page when the parse yields no body', () => {
    vi.stubGlobal('DOMParser', class { parseFromString(): unknown { return { body: null }; } });
    expect(applyEmailDarkMode(html, { enabled: true, isDark: true }).strategy).toBe('off');
  });

  // Regression: the walk costs a visit per element on the render thread. A
  // 20,000-element newsletter must open on white rather than stall the pane.
  it('declines a message too large to walk', () => {
    const huge = `<body>${'<i>x</i>'.repeat(15001)}</body>`;
    expect(applyEmailDarkMode(huge, { enabled: true, isDark: true }).strategy).toBe('off');
  });
});

describe('applyEmailDarkMode: already-dark messages', () => {
  // Regression: a black-background newsletter is already designed for this.
  // Inverting it turns it WHITE, which is the loudest possible failure.
  it('leaves a message that already draws itself dark alone', () => {
    const html = '<body bgcolor="#111111"><p style="color:#ffffff">hi</p></body>';
    const result = applyEmailDarkMode(html, { enabled: true, isDark: true });
    expect(result.strategy).toBe('preserve');
    expect(result.html).toBe(html);
    // …but the canvas behind it still goes dark, or a dark design sits in a
    // white frame with a white gutter around it.
    expect(result.darkCanvas).toBe(true);
  });

  // Regression: the classic email shell puts the page colour on a full-width
  // table inside a body that declares nothing. Look only at <body> and every
  // one of those is misread as a light page.
  it('looks at the shell inside the body, not only the body', () => {
    const html = '<body><table style="background-color:#0b0b0b"><tr><td>hi</td></tr></table></body>';
    expect(applyEmailDarkMode(html, { enabled: true, isDark: true }).strategy).toBe('preserve');
  });

  // Regression: the already-dark probe reads the style attribute first and the
  // bgcolor only as a fallback. Let a half-written style attribute throw out of
  // the probe and a black newsletter is read as a light page and inverted.
  it('falls back to bgcolor when the inline style cannot be parsed', () => {
    const html = '<body style="background:#111;}" bgcolor="#0b0b0b"><p>hi</p></body>';
    expect(applyEmailDarkMode(html, { enabled: true, isDark: true }).strategy).toBe('preserve');
  });

  it('still inverts when the shell is light', () => {
    const html = '<body><table style="background-color:#ffffff"><tr><td>hi</td></tr></table></body>';
    expect(applyEmailDarkMode(html, { enabled: true, isDark: true }).strategy).toBe('invert');
  });
});

describe('applyEmailDarkMode: the inversion', () => {
  const invert = (html: string): string =>
    applyEmailDarkMode(html, { enabled: true, isDark: true }).html;

  // Regression: the surface has to travel DOWN the tree. Resolve each element
  // against the page instead and the white text inside a red CTA — which
  // declares no background of its own — comes back grey on red.
  it('carries a kept surface down to the children that sit on it', () => {
    const out = invert(
      '<body style="background:#ffffff">'
      + '<div style="background:#d32f2f"><span style="color:#ffffff">Buy</span></div>'
      + '</body>',
    );
    expect(out).toContain('color: #ffffff');
  });

  // Regression: a kept surface froze the text on it unconditionally, so a
  // colour written for the white page above — or one the sender only ever
  // inherited onto the block — stayed put and vanished into the surface. The
  // CTA's own white-on-red is the half that must NOT move; this is the half
  // that must.
  it('lifts text that no longer reads on a kept surface', () => {
    const out = invert(
      '<body style="background:#ffffff">'
      + '<div style="background:#d32f2f"><span style="color:#ffffff">Buy</span></div>'
      + '<div style="background:#1a1a2e"><span style="color:#111111">Small print</span></div>'
      + '</body>',
    );
    expect(out).toContain('color: #ffffff');
    const lifted = /color: ([^;"]+)">Small print/.exec(out);
    expect(lifted).not.toBeNull();
    expect(
      wcagContrast(parseColor(lifted![1]!)!, parseColor('#1a1a2e')!),
    ).toBeGreaterThanOrEqual(4.5);
  });

  // Regression: the same Outlook wrapper, end to end. The table's INLINE
  // `background:white` inverted correctly while the sheet's `body{background:
  // white}` did not — which is what put a white slab of black prose above a
  // correctly darkened table in a real thread.
  it("inverts a Word-authored message through its commented <style>", () => {
    const out = invert(
      '<html><head><style><!--\n'
      + 'body{background:white}\n'
      + 'p.MsoNormal{color:black}\n'
      + '--></style></head>'
      + '<body><p class="MsoNormal">Hi team</p></body></html>',
    );
    expect(out).not.toContain('background:white');
    expect(out).not.toContain('color:black');
    expect(lightnessOf(/background:([^;}]+)/.exec(out)![1]!.trim())).toBeLessThan(0.35);
    expect(lightnessOf(/color:([^;}]+)/.exec(out)![1]!.trim())).toBeGreaterThan(0.6);
  });

  // Regression: HTML4 presentational attributes are still how designed mail
  // paints its shell. Miss them and the message keeps a white table on a dark
  // page.
  it('re-colours the presentational colour attributes too', () => {
    const out = invert('<body text="#000000" link="#0000ee"><table bgcolor="#ffffff"><tr>'
      + '<td bgcolor="#d32f2f"><font color="#ffffff">Buy</font></td></tr></table></body>');
    expect(out).not.toContain('bgcolor="#ffffff"');
    expect(out).not.toContain('text="#000000"');
    expect(out).not.toContain('link="#0000ee"');
    // The font colour sits on the kept red cell, so it is left where it was.
    expect(out).toContain('color="#ffffff"');
  });

  // Regression: bgcolor is resolved BEFORE the style attribute, because in the
  // cascade the style attribute wins. Read them the other way round and a cell
  // with both loses its real background.
  it('lets a style attribute outrank the bgcolor beside it', () => {
    const out = invert('<body><table><tr><td bgcolor="#ffffff" style="background:#d32f2f">'
      + '<span style="color:#ffffff">Buy</span></td></tr></table></body>');
    expect(out).toContain('color: #ffffff');
  });

  // Regression: an embedded <style> is re-coloured as a sheet, not walked as
  // an element — walk it and its CSS text is treated as markup.
  it('re-colours an embedded stylesheet', () => {
    const out = invert('<body><style>.a{color:#000000}</style><p class="a">hi</p></body>');
    expect(out).toContain('<style>');
    expect(out).not.toContain('#000000');
  });

  // Regression: a message that declares nothing still has to go dark — the
  // frame's own canvas is what covers it, so the strategy must be `invert`
  // with `darkCanvas` on even when not one declaration changed.
  it('turns the canvas dark for a message that declares no colours', () => {
    const result = applyEmailDarkMode('<body><p>plain text</p></body>', { enabled: true, isDark: true });
    expect(result.strategy).toBe('invert');
    expect(result.darkCanvas).toBe(true);
  });
});

describe('applyEmailDarkMode: markup that is not well behaved', () => {
  const invert = (html: string): string =>
    applyEmailDarkMode(html, { enabled: true, isDark: true }).html;

  // Regression: senders write `bgcolor="white"`, `bgcolor=""` and worse. A
  // value culori cannot read must leave the inherited surface standing, not
  // reclassify the element onto a surface nobody declared.
  it('ignores a colour attribute it cannot read', () => {
    const out = invert('<body><table bgcolor="not-a-colour"><tr>'
      + '<td style="color:#333333">hi</td></tr></table></body>');
    expect(out).toContain('bgcolor="not-a-colour"');
    expect(out).not.toContain('#333333');
  });

  // Regression: a transparent bgcolor paints nothing, so it must not claim the
  // surface — and re-colouring it would defeat the reset it was written as.
  it('leaves a transparent background alone', () => {
    const out = invert('<body><table bgcolor="transparent"><tr>'
      + '<td style="color:#000000">hi</td></tr></table></body>');
    expect(out).toContain('bgcolor="transparent"');
    expect(out).not.toContain('#000000');
  });

  // Regression: an empty presentational attribute is common in generated mail.
  // Passing "" through the colour parser must be a no-op, not a rewrite.
  it('skips empty colour attributes', () => {
    expect(invert('<body text=""><p>hi</p></body>')).toContain('text=""');
  });

  // Regression: a body whose background is fully transparent declares nothing.
  // Read it as a colour and every such message is misjudged as light or dark
  // on the strength of a colour that never paints.
  it('looks past a fully transparent body background to the shell', () => {
    const html = '<body style="background:rgba(0,0,0,0)">'
      + '<div style="background:#0b0b0b">hi</div></body>';
    expect(applyEmailDarkMode(html, { enabled: true, isDark: true }).strategy).toBe('preserve');
  });

  // Regression: <script> never renders (the sandbox blocks it and the stripper
  // removes it) and its source is not markup — walking into it would rewrite
  // code as if it were colour.
  it('does not walk into script or style as elements', () => {
    const out = invert('<body><script>var color = "#000000";</script><p>hi</p></body>');
    expect(out).toContain('var color = "#000000"');
  });

  // Regression: a document with <html> but no doctype must not gain one — the
  // frame would then render in standards mode a message that was laid out in
  // quirks mode, moving every table.
  it('does not invent a doctype a message did not have', () => {
    const out = invert('<html><body style="background:#ffffff">hi</body></html>');
    expect(out.toLowerCase()).not.toContain('<!doctype');
    expect(out.startsWith('<html')).toBe(true);
  });
});

describe('applyEmailDarkMode: the shape it hands back', () => {
  // `buildSrcdoc` branches on whether the message is a full document, a bare
  // <body> or a fragment, and injects the CSP meta and the frame stylesheet
  // differently for each. Coming back in a different shape than it went in
  // sends that injection to the wrong place.
  const invert = (html: string): string =>
    applyEmailDarkMode(html, { enabled: true, isDark: true }).html;

  // Regression: lose the doctype and the frame re-renders the whole message in
  // quirks mode — every table width and vertical-align silently changes.
  it('keeps a full document a full document, doctype included', () => {
    const out = invert('<!DOCTYPE html><html><head></head><body style="background:#ffffff">hi</body></html>');
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain('<html');
    expect(out).toContain('</html>');
  });

  it('keeps a bare body a bare body', () => {
    const out = invert('<body style="background:#ffffff">hi</body>');
    expect(out.startsWith('<body')).toBe(true);
    expect(out).not.toContain('<html');
  });

  // Regression: the parser hoists a leading <style> into the head. Serialize
  // the body alone and the message loses its entire stylesheet.
  it('keeps a fragment a fragment, and keeps its hoisted stylesheet', () => {
    const out = invert('<style>.a{color:#000000}</style><div class="a">hi</div>');
    expect(out).not.toContain('<body');
    expect(out).toContain('<style>');
    expect(out).toContain('<div class="a">');
    expect(out).not.toContain('#000000');
  });
});

describe('the whole rewrite, on a message shaped like the real thing', () => {
  // One end-to-end pass over the shell every marketing template ships: a grey
  // page, a white card on it, body copy, a link, a brand CTA and a hairline.
  const source = '<!DOCTYPE html><html><head><style>.cta{background:#d32f2f;color:#ffffff}</style></head>'
    + '<body bgcolor="#f5f5f5" style="margin:0">'
    + '<table width="100%" style="background:#ffffff;border:1px solid #dddddd">'
    + '<tr><td style="color:#333333">Hello <a href="#" style="color:#1a73e8">link</a>'
    + '<div class="cta">Buy</div></td></tr></table></body></html>';
  const out = applyEmailDarkMode(source, { enabled: true, isDark: true }).html;
  const colorAt = (property: string): string =>
    new RegExp(`${property}: (rgb\\([^)]*\\))`).exec(out)![1]!;

  it('puts the page, the card and the rule at readable distances from each other', () => {
    const page = lightnessOf(/bgcolor="(rgb\([^)]*\))"/.exec(out)![1]!);
    const card = lightnessOf(colorAt('background'));
    const rule = lightnessOf(/border: 1px solid (rgb\([^)]*\))/.exec(out)![1]!);
    expect(page).toBeLessThan(0.35);
    expect(card).toBeLessThan(0.35);
    expect(rule).toBeGreaterThan(Math.max(page, card));
  });

  it('leaves the body copy and the link legible on it', () => {
    expect(lightnessOf(colorAt('color'))).toBeGreaterThan(0.7);
    const link = /color: (rgb\([^)]*\))">link/.exec(out);
    expect(chromaOf(link![1]!)).toBeGreaterThan(0.045);
  });

  // Regression: the whole reason surfaces are tracked at all.
  it('keeps the CTA white on red', () => {
    expect(out).toContain('color:#ffffff');
  });
});
