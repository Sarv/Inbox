// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  inlineDocumentStyles,
  mediaAppliesToFrame,
} from '../../../../../src/components/email-detail/chat-body-styles';

/**
 * A mail's own stylesheet, on its way into the chat view's frame.
 *
 * What breaks if this file goes red: a designed mail reaches the reader with
 * the parts of itself that were sized or laid out by a class MISSING — not
 * restyled, gone — because the frame's sanitizer removes `<style>` and the
 * template wrapped every column in a `font-size:0px` cell.
 */

/** A template in the shape MJML emits: sizes in classes, a `font-size:0px`
 *  wrapper, and the wide layout behind a min-width query. */
const digest = (styles: string, body: string) =>
  `<!doctype html><html><head><style type="text/css">${styles}</style></head>` +
  `<body style="word-spacing:normal;"><table role="presentation"><tbody><tr>` +
  `<td style="font-size:0px;text-align:center;"><img src="https://cdn.test/logo.png" alt="">` +
  `${body}</td></tr></tbody></table></body></html>`;

/** The `style` attribute of the first element carrying `class`. */
const styleOf = (html: string, selector: string) =>
  new DOMParser().parseFromString(html, 'text/html').querySelector(selector)?.getAttribute('style') ??
  '';

describe('inlineDocumentStyles', () => {
  // Regression: the daily digest arrived with "Hello, Ankur Dubey" and "Work
  // Anniversaries Today" missing entirely. Their size lived in a class, the
  // frame's sanitizer had removed the stylesheet, and MJML's wrapper cell sets
  // `font-size:0px` — so they rendered at zero and simply were not there.
  it('writes a class rule onto the element it matches', () => {
    const html = inlineDocumentStyles(
      digest('.employee-name{font-size:28px}', '<div class="employee-name">Hello, Ankur Dubey</div>'),
    );
    expect(styleOf(html, '.employee-name')).toContain('font-size: 28px');
    expect(html).toContain('Hello, Ankur Dubey');
  });

  // Regression: "DAILY DIGEST" and "FRIDAY, 11 SEP" stacked one per line, and so
  // did the footer's logo, store badges and QR code. MJML ships every column at
  // an inline `width:100%` and narrows it in a min-width query; without the
  // query nothing is ever narrowed and every column takes the whole row.
  it('applies a min-width rule the frame is wide enough for', () => {
    const html = inlineDocumentStyles(
      digest(
        '@media only screen and (min-width:480px){.col{width:50%!important}}',
        '<div class="col" style="width:100%">Daily Digest</div>',
      ),
    );
    expect(styleOf(html, '.col')).toContain('width: 50%');
  });

  // The mirror of the rule above: a phone-only override must NOT win on a
  // reading pane, or the wide layout is thrown away for the narrow one.
  it('ignores a max-width rule meant for a phone', () => {
    const html = inlineDocumentStyles(
      digest(
        '@media only screen and (max-width:479px){.col{font-size:11px}}',
        '<div class="col">Daily Digest</div>',
      ),
    );
    expect(styleOf(html, '.col')).toBe('');
  });

  // The element's own attribute is what the sender wrote LAST, so it wins — the
  // order a browser would have used. Getting this backwards repaints a mail in
  // whatever its stylesheet said before the sender overrode it.
  it('leaves the element’s own inline style winning over a plain rule', () => {
    const html = inlineDocumentStyles(
      digest('.name{color:#000000}', '<div class="name" style="color:#ffffff">Ankur</div>'),
    );
    const style = styleOf(html, '.name');
    expect(style.indexOf('#000000')).toBeLessThan(style.indexOf('#ffffff'));
  });

  // Regression: the sanitizer does not merely drop a `<style>` element, it keeps
  // the CSS as TEXT — so a stylesheet left in place is PRINTED above the
  // message. It has to go, whether or not its rules could be read.
  it('takes the stylesheet out of the body it returns', () => {
    const html = inlineDocumentStyles(digest('.name{color:red}', '<div class="name">Ankur</div>'));
    expect(html).not.toContain('<style');
    expect(html).not.toContain('color:red');
  });

  // Two rules for one element apply in source order, so the later one wins —
  // and both still lose to the element's own attribute.
  it('applies two rules for one element in source order', () => {
    const html = inlineDocumentStyles(
      digest('.name{font-size:10px}.name{font-size:20px}', '<div class="name">Ankur</div>'),
    );
    const style = styleOf(html, '.name');
    expect(style.indexOf('10px')).toBeLessThan(style.indexOf('20px'));
  });

  // A body the view renders INLINE rather than framing has its `style`
  // attributes stripped as well, so there is nothing to win by rewriting it —
  // and the same string back means nothing downstream re-renders.
  it('hands back a plain typed mail as the very same string', () => {
    const plain = '<html><head><style>.x{color:red}</style></head><body><p>Hi there.</p></body></html>';
    expect(inlineDocumentStyles(plain)).toBe(plain);
  });

  // The cheap test that keeps this off the path of every ordinary mail.
  it('hands back a body with no stylesheet as the very same string', () => {
    const body = '<table><tbody><tr><td><img src="x.png"><p>Hi.</p></td></tr></tbody></table>';
    expect(inlineDocumentStyles(body)).toBe(body);
  });

  // A bare layout table is design in a one-sender thread and a sign-off wrapper
  // in a conversation — the view's own rule. Asking it the same way is what
  // stops this from rewriting a body the view then renders inline.
  it('follows the view’s reading of a bare layout table', () => {
    const wrapped =
      '<html><head><style>.name{font-size:28px}</style></head><body>' +
      '<table role="presentation"><tbody><tr><td><div class="name">Ankur</div></td></tr></tbody></table>' +
      '</body></html>';
    expect(inlineDocumentStyles(wrapped, false)).toContain('font-size: 28px');
    expect(inlineDocumentStyles(wrapped, true)).toBe(wrapped);
  });

  // A stylesheet is written by a stranger: one rule this browser cannot read
  // must not cost the mail every other rule in the file.
  it('keeps going past a rule the browser cannot read', () => {
    const html = inlineDocumentStyles(
      digest('@totally-unknown foo { .a { color: red } } .name{color:#111111}', '<div class="name">Ankur</div>'),
    );
    expect(styleOf(html, '.name')).toContain('#111111');
  });

  // An empty body must not throw on the way through.
  it('hands back an empty body untouched', () => {
    expect(inlineDocumentStyles('')).toBe('');
  });
});

describe('mediaAppliesToFrame', () => {
  // The frame is a desktop reading pane, so the wide half of a responsive
  // template is the half that applies.
  it('applies a query the frame is wide enough for', () => {
    expect(mediaAppliesToFrame('only screen and (min-width:480px)')).toBe(true);
    expect(mediaAppliesToFrame('screen and (max-width:900px)')).toBe(true);
  });

  it('does not apply a query written for a narrower screen', () => {
    expect(mediaAppliesToFrame('only screen and (max-width:479px)')).toBe(false);
    expect(mediaAppliesToFrame('screen and (min-width:1200px)')).toBe(false);
  });

  // A comma is an OR: one arm matching is enough, exactly as in a browser.
  it('applies a comma list when any one of its queries does', () => {
    expect(mediaAppliesToFrame('print, screen and (min-width:480px)')).toBe(true);
  });

  it('never applies print', () => {
    expect(mediaAppliesToFrame('print')).toBe(false);
  });

  // Regression: the frame inherits the OS colour-scheme preference, so a mail's
  // dark rules would fire while the app is in light mode and render the message
  // on a black card. The standard view refuses these for the same reason.
  it('never applies a dark-mode query', () => {
    expect(mediaAppliesToFrame('(prefers-color-scheme: dark)')).toBe(false);
  });

  // Anything unmodelled applies, so an unfamiliar condition can only leave the
  // mail looking the way its own fallback intended.
  it('applies a condition it does not model', () => {
    expect(mediaAppliesToFrame('screen and (orientation: landscape)')).toBe(true);
    expect(mediaAppliesToFrame('')).toBe(true);
  });
});
