// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { frameLinkToOpen } from '../../../../src/components/SandboxedEmailBody';

/**
 * Which link clicks inside the standard view's framed body the app opens
 * itself, and which it leaves to the frame's default action.
 *
 * What breaks if this file goes red: the standard view and the chat view
 * disagree about the same link again. The listener here kept its own copy of
 * the rule, checked `mailto:` in lower case only, and so sent a sender's
 * `MAILTO:` link down the web-link path that `mailto:` never takes. The rule
 * is shared now (utils/open-external); this pins that the listener uses it.
 */

/** An element inside a frame-like document, as a click would target it. */
const inBody = (html: string, selector: string) => {
  document.body.innerHTML = html;
  return document.querySelector(selector);
};

describe('frameLinkToOpen', () => {
  // The feature: a web link is the app's to open (in the system browser).
  it('opens a web link', () => {
    expect(frameLinkToOpen(inBody('<a href="https://example.test/plan">Plan</a>', 'a'))).toBe(
      'https://example.test/plan',
    );
  });

  // A click lands on whatever is inside the anchor — an image, a span.
  it('finds the link from an element inside it', () => {
    const img = inBody('<a href="https://example.test/"><span><img src="x.png"></span></a>', 'img');
    expect(frameLinkToOpen(img)).toBe('https://example.test/');
  });

  // Plaintext-converted mail wraps a bare address in an anchor with no href.
  it('takes a bare URL from an anchor with no href', () => {
    expect(frameLinkToOpen(inBody('<a> https://example.test/bare </a>', 'a'))).toBe(
      'https://example.test/bare',
    );
  });

  // THE regression: `MAILTO:` is the same link as `mailto:` — both are left to
  // the frame's default action, neither taken for a web link.
  it.each(['mailto:bob@acme.example', 'MAILTO:bob@acme.example', 'Mailto:bob@acme.example'])(
    'leaves %s to the default action',
    (href) => {
      expect(frameLinkToOpen(inBody(`<a href="${href}">Bob</a>`, 'a'))).toBeNull();
    },
  );

  // An in-page jump scrolls the body; it is not the browser's.
  it('leaves an in-page jump alone', () => {
    expect(frameLinkToOpen(inBody('<a href="#section-2">Jump</a>', 'a'))).toBeNull();
  });

  // Not a link at all, or an anchor with nothing to open.
  it('ignores a click on no link, or on an anchor with nothing to open', () => {
    expect(frameLinkToOpen(inBody('<p>Just text</p>', 'p'))).toBeNull();
    expect(frameLinkToOpen(inBody('<a>not a url</a>', 'a'))).toBeNull();
    expect(frameLinkToOpen(null)).toBeNull();
  });
});
