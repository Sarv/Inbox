import { ATTACHMENT_SCHEME } from '@sarvinbox/core';
import { describe, it, expect } from 'vitest';

import { classifyNavigation } from '../../../../electron/utils/navigation-policy';

const DEV_ORIGIN = 'http://localhost:5173';
const PROD_ORIGIN = 'file://';

describe('classifyNavigation', () => {
  // Breaks: the app's own pages stop loading. `will-navigate` fires for the
  // renderer's own route changes too, so blocking the app origin bricks the
  // window entirely.
  it.each([
    [DEV_ORIGIN, `${DEV_ORIGIN}/index.html`],
    [PROD_ORIGIN, 'file:///Applications/Sarv.app/dist/index.html'],
  ])('allows the app origin %s at both scopes', (origin, url) => {
    expect(classifyNavigation(url, origin, 'top')).toBe('allow');
    expect(classifyNavigation(url, origin, 'frame')).toBe('allow');
  });

  // Breaks: the email body iframe is built with srcdoc, so every rebuild of it
  // is an about: navigation. Blocking those blanks the reading pane.
  it.each(['about:blank', 'about:srcdoc'])('allows %s', (url) => {
    expect(classifyNavigation(url, DEV_ORIGIN, 'frame')).toBe('allow');
  });

  // Breaks: an email's links would render inside the reading pane instead of
  // opening in the user's browser — the phishing surface that the frame guard
  // exists to close.
  it.each(['https://evil.example/login', 'http://evil.example', 'mailto:a@b.com'])(
    'sends %s out to the browser rather than rendering it',
    (url) => {
      expect(classifyNavigation(url, DEV_ORIGIN, 'top')).toBe('external');
      expect(classifyNavigation(url, DEV_ORIGIN, 'frame')).toBe('external');
    }
  );

  // Breaks: the in-app attachment viewer. Its PDF frame points at
  // `sarv-attachment://`, and the frame guard refusing that scheme leaves the
  // user staring at a blank panel with only a line in the log to explain it.
  it('lets the attachment scheme load inside a frame', () => {
    const url = `${ATTACHMENT_SCHEME}://attachment/email-1/report.pdf?account=acct-2`;
    expect(classifyNavigation(url, DEV_ORIGIN, 'frame')).toBe('allow');
  });

  // Breaks: the containment on that same scheme. A top-level navigation would
  // replace the whole app window with a document that came out of a mail
  // message — the viewer never needs this, so only the frame scope gets it.
  it('still refuses the attachment scheme at the top level', () => {
    const url = `${ATTACHMENT_SCHEME}://attachment/email-1/report.pdf`;
    expect(classifyNavigation(url, DEV_ORIGIN, 'top')).toBe('block');
  });

  // Breaks: a hostile scheme reaching the OS. `block` must not fall through to
  // shell.openExternal, which would hand file:// or a registered custom scheme
  // to the system handler on a click inside an email.
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:/id', 'data:text/html,<b>'])(
    'blocks %s outright instead of handing it to the OS',
    (url) => {
      expect(classifyNavigation(url, DEV_ORIGIN, 'top')).toBe('block');
      expect(classifyNavigation(url, DEV_ORIGIN, 'frame')).toBe('block');
    }
  );

  // Breaks: a prefix-match hole. `http://localhost:5173` as the dev origin must
  // not accidentally admit a lookalike host.
  it('does not treat a lookalike origin as the app', () => {
    expect(classifyNavigation('http://localhost:5173.evil.example', DEV_ORIGIN, 'top')).toBe(
      'external'
    );
  });

  // Breaks: PDFs render as a viewer toolbar over a permanently blank page.
  // Chromium's PDF plugin navigates its INNER content frame to its own
  // chrome-extension:// URL; blocking that leaves the document undrawn.
  it('lets the Chromium PDF plugin navigate its own render frame', () => {
    const pdfFrame = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/f219866c-87ea';
    expect(classifyNavigation(pdfFrame, DEV_ORIGIN, 'frame')).toBe('allow');
  });

  // Breaks: a general `chrome-extension:` hole. Only the one bundled PDF
  // component is admitted, and only in a frame -- never the whole window.
  it('blocks any other extension, and the PDF one at the top level', () => {
    expect(
      classifyNavigation('chrome-extension://someotherextensionidgoeshere/x', DEV_ORIGIN, 'frame')
    ).toBe('block');
    expect(
      classifyNavigation(
        'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/f219866c-87ea',
        DEV_ORIGIN,
        'top'
      )
    ).toBe('block');
  });
});
