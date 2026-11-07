import { ATTACHMENT_SCHEME, PANEL_SCHEME, panelAssetUrl } from '@sarvinbox/core';
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

  // Extension panels: ExtensionPanelFrame points an iframe at
  // sarv-extension://<extension-id>/..., served by extension-panel-protocol.ts.
  describe('extension panels', () => {
    const PANEL = panelAssetUrl('clamav-scan', 'panel/index.html');
    const DETAILS = panelAssetUrl('clamav-scan', 'panel/details.html');
    /** The app setting a fresh iframe's src, as Electron 44 reports it. */
    const FROM_APP = { frameUrl: '', initiatorUrl: `${DEV_ORIGIN}/` };
    /** The panel following one of its own links. */
    const FROM_PANEL = { frameUrl: PANEL, initiatorUrl: PANEL };

    // Breaks: no extension panel can load. The frame guard refused the panel
    // iframe ("Blocked frame-level navigation") and the ClamAV panel stayed blank.
    it('lets the app load a panel into a frame', () => {
      expect(classifyNavigation(PANEL, DEV_ORIGIN, 'frame', FROM_APP)).toBe('allow');
      expect(
        classifyNavigation(PANEL, PROD_APP, 'frame', { frameUrl: '', initiatorUrl: `${PROD_APP}#/inbox` })
      ).toBe('allow');
    });

    // Breaks: a window-level navigation to a panel replaces the whole app with
    // an extension's page. Frame scope only, even when the app asks.
    it('refuses a panel at the top level', () => {
      expect(classifyNavigation(PANEL, DEV_ORIGIN, 'top', FROM_APP)).toBe('block');
      expect(classifyNavigation(PANEL, PROD_APP, 'top')).toBe('block');
    });

    // Breaks: a scheme that merely starts like the panel one rides its allowance.
    it.each([
      'sarv-extensions://clamav-scan/panel/index.html',
      'sarv-extension-evil://clamav-scan/panel/index.html',
      'xsarv-extension://clamav-scan/panel/index.html',
    ])('blocks the lookalike scheme %s', (url) => {
      expect(classifyNavigation(url, DEV_ORIGIN, 'frame', FROM_APP)).toBe('block');
    });

    // Breaks: a panel with more than one page cannot follow its own links.
    it('lets a panel move between its own pages', () => {
      expect(classifyNavigation(DETAILS, DEV_ORIGIN, 'frame', FROM_PANEL)).toBe('allow');
      // With no initiator to read, what the frame shows now decides alone.
      expect(classifyNavigation(PANEL, DEV_ORIGIN, 'frame', { frameUrl: DETAILS })).toBe('allow');
    });

    // Breaks: a panel navigates itself into another extension's page (Chromium
    // allows it), which then runs under the first extension's grants: the
    // renderer attributes the frame's requests to the extension it pointed it at.
    it.each([panelAssetUrl('other-ext', 'panel/index.html'), `${PANEL_SCHEME}://sdk/sarv.js`])(
      'refuses a panel navigating itself to %s',
      (url) => {
        expect(classifyNavigation(url, DEV_ORIGIN, 'frame', FROM_PANEL)).toBe('block');
      }
    );

    // Breaks: a link in an email body or an attachment frame loads an
    // extension's page into the reading pane. Only the app puts a panel in a frame.
    it.each(['about:srcdoc', `${ATTACHMENT_SCHEME}://attachment/email-1/report.pdf`])(
      'refuses a panel page in a %s frame',
      (frameUrl) => {
        expect(classifyNavigation(PANEL, DEV_ORIGIN, 'frame', { frameUrl, initiatorUrl: frameUrl })).toBe(
          'block'
        );
      }
    );

    // Breaks: a navigation whose source is unknown (a disposed frame) or only
    // looks like the app is treated as the app's own and admitted.
    it('refuses a panel when the source is unknown or only looks like the app', () => {
      expect(classifyNavigation(PANEL, DEV_ORIGIN, 'frame')).toBe('block');
      expect(
        classifyNavigation(PANEL, DEV_ORIGIN, 'frame', { initiatorUrl: 'http://localhost:5173.evil.example/' })
      ).toBe('block');
      expect(
        classifyNavigation(PANEL, PROD_APP, 'frame', { initiatorUrl: 'file:///Users/me/Downloads/invoice.html' })
      ).toBe('block');
    });

    // Breaks: the app can no longer re-point a frame that already shows a panel
    // (a re-render that reuses the iframe). The app chose the new extension.
    it('lets the app re-point a panel frame at another extension', () => {
      const other = panelAssetUrl('other-ext', 'panel/index.html');
      expect(
        classifyNavigation(other, DEV_ORIGIN, 'frame', { frameUrl: PANEL, initiatorUrl: `${DEV_ORIGIN}/` })
      ).toBe('allow');
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
