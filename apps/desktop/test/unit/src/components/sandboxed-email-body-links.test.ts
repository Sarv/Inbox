import { describe, expect, it } from 'vitest';

import { forceLinksExternal } from '../../../../src/components/SandboxedEmailBody';

/**
 * Links inside an email body must leave the app, not load inside it.
 *
 * THE incident: a hotel booking mail ("Your … token has been generated") whose
 * "Online Account" link loaded the remote page INSIDE the reading pane. The
 * iframe's sandbox is `allow-same-origin allow-popups` — no
 * `allow-top-navigation`, so a link cannot hijack the window, but nothing stops
 * it navigating the iframe itself and replacing the message with a live web
 * page in the user's inbox.
 *
 * The runtime click listener that was supposed to catch this attaches only once
 * the iframe document has parsed and gives up after ~1s of polling, so a large
 * marketing email — the kind full of links — loses that race silently. Rewriting
 * the markup removes the race: `target="_blank"` makes the click a window-open
 * request, which Electron hands to setWindowOpenHandler, which opens the real
 * browser and denies the popup. No JavaScript in the component has to run.
 */
describe('forceLinksExternal', () => {
  // THE regression: an ordinary http link must be forced out of the frame.
  it('forces a plain link to open outside the frame', () => {
    const out = forceLinksExternal('<a href="https://x.com">Online Account</a>');
    expect(out).toMatch(/target="_blank"/);
    expect(out).toMatch(/href="https:\/\/x\.com"/);
  });

  // The opened page must never get a handle back to the frame, and a mail's
  // link should not leak where it was clicked from.
  it('adds noopener and noreferrer', () => {
    const out = forceLinksExternal('<a href="https://x.com">X</a>');
    expect(out).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(out).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });

  // An earlier version matched only as far as `href=`, so this guard inspected a
  // string that stopped before the VALUE and never fired. Every `#anchor` got
  // target="_blank", became a window-open of a fragment, and was denied — which
  // silently broke jump links inside long emails.
  it('leaves an in-page #anchor completely alone', () => {
    const html = '<a href="#section">Jump</a>';
    expect(forceLinksExternal(html)).toBe(html);
  });

  // mailto belongs to the OS handler; making it a popup request routes it
  // through a path that was never meant to carry it.
  it('leaves a mailto link completely alone', () => {
    const html = '<a href="mailto:a@b.com">Mail</a>';
    expect(forceLinksExternal(html)).toBe(html);
  });

  // Same root cause as the #anchor bug: an attribute AFTER href was invisible,
  // so a second `target` was appended. Duplicate attributes are invalid and
  // leave the outcome to parser tie-breaking rather than to this function.
  it('replaces an existing target instead of emitting two', () => {
    const out = forceLinksExternal('<a href="https://x.com" target="_self">X</a>');
    expect(out.match(/target=/gi)).toHaveLength(1);
    expect(out).toMatch(/target="_blank"/);
  });

  // A mail that already carries rel="nofollow" must still get noopener — the
  // protection cannot be optional just because the sender set an unrelated rel.
  it('merges into an existing rel rather than skipping it', () => {
    const out = forceLinksExternal('<a href="https://x.com" rel="nofollow">X</a>');
    expect(out.match(/rel=/gi)).toHaveLength(1);
    expect(out).toMatch(/nofollow/);
    expect(out).toMatch(/noopener/);
  });

  // Real mail is not tidy: unquoted attribute values and uppercase tags are
  // both common from older senders and template engines.
  it('handles an unquoted href and an uppercase tag', () => {
    expect(forceLinksExternal('<a href=https://x.com class=b>X</a>')).toMatch(/target="_blank"/);
    expect(forceLinksExternal('<A HREF="https://x.com">X</A>')).toMatch(/target="_blank"/);
  });

  // An anchor used purely as a named destination has nothing to navigate to;
  // rewriting it would add attributes that mean nothing.
  it('leaves an anchor with no href untouched', () => {
    const html = '<a name="top">X</a>';
    expect(forceLinksExternal(html)).toBe(html);
  });

  it('rewrites every link in a message, not just the first', () => {
    const out = forceLinksExternal('<a href="https://a.com">A</a> and <a href="https://b.com">B</a>');
    expect(out.match(/target="_blank"/g)).toHaveLength(2);
  });

  // Non-link markup must survive untouched — this runs over the whole body.
  it('does not disturb surrounding markup', () => {
    const out = forceLinksExternal('<p>before</p><a href="https://x.com">X</a><img src="y.png">');
    expect(out).toContain('<p>before</p>');
    expect(out).toContain('<img src="y.png">');
  });
});
