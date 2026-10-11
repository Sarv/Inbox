import { ATTACHMENT_SCHEME } from '@sarvinbox/core';
import { describe, it, expect } from 'vitest';

import { classifyNavigation } from '../../../../electron/utils/navigation-policy';

const DEV_ORIGIN = 'http://localhost:5173';
/** The production app: the bundled entry, as main builds it (pathToFileURL). */
const PROD_APP = 'file:///Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html';

describe('classifyNavigation', () => {
  // Breaks: the app's own pages stop loading. `will-navigate` fires for the
  // renderer's own route changes too, so blocking the app origin bricks the
  // window entirely.
  it.each([
    [DEV_ORIGIN, `${DEV_ORIGIN}/index.html`],
    [PROD_APP, PROD_APP],
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

  // CASA M-6. In production the app is ONE file. Changed deliberately: any
  // file: URL used to count as the app. Breaks: an email's image-map link
  // loads a saved HTML attachment into the reading pane outside the email CSP,
  // or a local page takes over the window with the preload bridge.
  describe('production: only the bundled entry is the app', () => {
    it.each([
      'file:///Users/me/Downloads/invoice.html',
      'file:///Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/other.html',
      'file:///Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html.evil',
      'file:///Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html/x',
      'file:///etc/passwd',
      'file://evil-host/Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html',
    ])('blocks %s at both scopes', (url) => {
      expect(classifyNavigation(url, PROD_APP, 'top')).toBe('block');
      expect(classifyNavigation(url, PROD_APP, 'frame')).toBe('block');
    });

    // Breaks: a reload that carries a query or fragment would be refused.
    it('ignores the query and fragment of the entry', () => {
      expect(classifyNavigation(`${PROD_APP}?t=1#inbox`, PROD_APP, 'top')).toBe('allow');
    });

    // Breaks: the app's own document is refused on an install path that
    // Chromium and Node spell differently: Chromium leaves some characters
    // raw that pathToFileURL percent-encodes, and upper-cases a Windows drive
    // letter that __dirname may carry in lower case.
    it('matches the entry however the path is spelled', () => {
      const pipe = 'file:///opt/Sarv%20Inbox%7Cbeta/resources/app.asar/dist/index.html';
      expect(classifyNavigation('file:///opt/Sarv%20Inbox|beta/resources/app.asar/dist/index.html', pipe, 'top')).toBe('allow');
      const lowerDrive = 'file:///c:/Program%20Files/Sarv%20Inbox/resources/app.asar/dist/index.html';
      expect(classifyNavigation('file:///C:/Program%20Files/Sarv%20Inbox/resources/app.asar/dist/index.html', lowerDrive, 'top')).toBe('allow');
      expect(classifyNavigation('file:///C:/Program%20Files/Sarv%20Inbox/resources/app.asar/dist/other.html', lowerDrive, 'top')).toBe('block');
    });

    // A '%' that starts no valid escape stays raw in Chromium's URL but is
    // %25 in pathToFileURL's. Breaks: on an install path like "50% off" the
    // app's own reload (the crash screen's Reload button, the reload after
    // Re-thread) is blocked as a foreign page.
    it('matches the entry when the install path holds a stray %', () => {
      const entry = 'file:///Users/me/50%25%20off/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html';
      const chromium = 'file:///Users/me/50%%20off/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html';
      expect(classifyNavigation(chromium, entry, 'top')).toBe('allow');
      expect(classifyNavigation(chromium.replace('index.html', 'other.html'), entry, 'top')).toBe('block');
      // Non-ASCII, raw on one side and escaped on the other, is the same path.
      expect(classifyNavigation('file:///opt/Inb%C3%B4x/dist/index.html', 'file:///opt/Inbôx/dist/index.html', 'top')).toBe('allow');
    });

    // Breaks: the old prod origin ('file://', no path) would count nothing as
    // the app, or everything. Neither: only the entry itself.
    it('does not let the dev rule (same host) admit files', () => {
      expect(classifyNavigation('file:///Users/me/x.html', 'file:///', 'top')).toBe('block');
    });
  });

  // A changed Electron event (no url, or not a string) must never let a
  // navigation through. Breaks: the guard throws before it can preventDefault,
  // and the navigation proceeds.
  it.each([undefined, null, 42, {}])('fails closed on a url of %s', (url) => {
    expect(classifyNavigation(url as never, PROD_APP, 'top')).toBe('block');
    expect(classifyNavigation(url as never, DEV_ORIGIN, 'frame')).toBe('block');
  });
});
