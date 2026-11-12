/**
 * What to do with a navigation the window is about to perform.
 *
 * Two Electron events ask the same question — `will-navigate` for the top-level
 * frame and `will-frame-navigate` for every frame, the top-level one included —
 * and they had two near-identical inline copies of the answer. They must not
 * drift: a rule added to one and forgotten in the other is either a hole (the
 * frame guard misses a scheme the top-level one blocks) or a broken feature
 * (the frame guard blocks something the app itself loads). One pure function,
 * decided in one place.
 */

import { ATTACHMENT_SCHEME, parsePanelUrl } from '@sarvinbox/core';

export type NavigationVerdict = 'allow' | 'external' | 'block';

/**
 * `top` is the window itself; `frame` is anything nested inside it (the email
 * body iframe, the attachment viewer's PDF frame, an extension panel).
 */
export type NavigationScope = 'top' | 'frame';

/**
 * Where a frame navigation comes from, as far as Electron can tell. Only the
 * extension-panel rule reads it. A field that could not be read is left out,
 * and a missing field never allows anything.
 */
export interface NavigationSource {
  /** What the navigating frame shows now (`''` before its first load). */
  frameUrl?: string;
  /** The document that started the navigation, when it came from one. */
  initiatorUrl?: string;
}

/**
 * Chromium's built-in PDF viewer, by its fixed extension id. Pointing an iframe
 * at a `application/pdf` response does not render the document directly: the
 * plugin paints its toolbar, then navigates the INNER content frame to its own
 * `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/<uuid>` URL to do the
 * actual drawing. Block that and you get exactly what we shipped — a viewer
 * chrome with a permanently blank page underneath.
 *
 * Only this one id is admitted, and only for frames. It is Chromium's own
 * bundled component, not a user-installable extension, and the app loads no
 * others — so this is not a general `chrome-extension:` hole.
 */
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

const EXTERNAL_PROTOCOLS = ['http://', 'https://', 'mailto:'];

/**
 * A `file:` path in the one form both sides can be compared in: the bytes it
 * names. Chromium reports the app's document URL in its canonical form; main
 * builds the entry with Node's pathToFileURL. The two percent-encode slightly
 * different sets of characters, and a `%` that starts no valid escape (an
 * install folder named "50% off") stays raw in one and becomes `%25` in the
 * other — so every valid `%XX` is read as its byte and anything else is kept
 * as it is (a parsed URL's pathname is ASCII: non-ASCII is always escaped). A
 * Windows drive letter is upper-cased: Chromium upper-cases it, a lower-case
 * `__dirname` would not.
 */
function comparableFilePath(pathname: string): string {
  let bytes = '';
  for (let i = 0; i < pathname.length; i++) {
    const escape = pathname.slice(i + 1, i + 3);
    if (pathname[i] === '%' && /^[0-9a-f]{2}$/i.test(escape)) {
      bytes += String.fromCharCode(parseInt(escape, 16));
      i += 2;
    } else {
      bytes += pathname[i];
    }
  }
  return /^\/[a-z]:/.test(bytes) ? `/${bytes[1].toUpperCase()}${bytes.slice(2)}` : bytes;
}

/**
 * Both guards used to answer this with `url.startsWith(appOrigin)`, which is a
 * prefix match on a string, not on an origin: with a dev origin of
 * `http://localhost:5173`, the host `localhost:5173.evil.example` starts with
 * it and was admitted. Compare the parsed protocol and host instead.
 *
 * In production the app is ONE file, the bundled `dist/index.html`, and only
 * that file counts (CASA M-6). Every `file:` URL used to: an email's image-map
 * link (`<area href>`) could load a saved HTML attachment into the reading
 * pane, outside the email CSP, and a top-level navigation to any local page
 * would have run it with the preload bridge. Query and fragment don't matter.
 */
export function isAppUrl(url: string, appUrl: string): boolean {
  try {
    const target = new URL(url);
    const app = new URL(appUrl);
    if (target.protocol !== app.protocol) return false;
    if (app.protocol !== 'file:') return target.host === app.host;
    return target.host === app.host && comparableFilePath(target.pathname) === comparableFilePath(app.pathname);
  } catch {
    // An unparseable target is not the app, and falls through to be blocked.
    return false;
  }
}

/**
 * May a frame load this extension's panel page? The app shows a panel by
 * pointing an iframe at `sarv-extension://<extension-id>/...`
 * (ExtensionPanelFrame), and the panel may then move between its own pages.
 * Nothing else may put a panel page in a frame:
 *
 *  - not another extension's panel. The renderer attributes every request a
 *    panel frame makes to the extension it pointed the frame at, so a frame
 *    that wandered into a second extension's page would run that code under
 *    the first one's grants, labelled with the first one's name.
 *  - not an email body or attachment frame, which a link in a message could
 *    otherwise turn into a panel page inside the reading pane.
 */
function isPanelNavigationAllowed(
  extensionId: string,
  appUrl: string,
  source: NavigationSource
): boolean {
  // The app set the frame's src: it chose the extension, and attributes the
  // frame to the one it chose.
  if (source.initiatorUrl !== undefined && isAppUrl(source.initiatorUrl, appUrl)) return true;

  // The panel moving to another page of its own extension. The id is the
  // URL's host, and `standard` makes it the page's origin too.
  return source.frameUrl !== undefined && parsePanelUrl(source.frameUrl)?.host === extensionId;
}

/**
 * @param url    the navigation target, exactly as Electron reports it
 * @param appUrl the dev server URL in development; in production the file URL
 *               of the bundled entry (`pathToFileURL(dist/index.html)`)
 * @param scope  which of the two guards is asking
 * @param source where a frame navigation comes from (frame scope only)
 *
 * Fails closed: anything that throws while deciding (a missing or non-string
 * URL from a changed Electron event) is blocked, never let through.
 */
export function classifyNavigation(
  url: string,
  appUrl: string,
  scope: NavigationScope,
  source: NavigationSource = {}
): NavigationVerdict {
  try {
    return classify(url, appUrl, scope, source);
  } catch {
    return 'block';
  }
}

function classify(
  url: string,
  appUrl: string,
  scope: NavigationScope,
  source: NavigationSource
): NavigationVerdict {
  // The app's own page, wherever it is served from.
  if (isAppUrl(url, appUrl)) return 'allow';

  // about:srcdoc / about:blank are the email iframe being (re)built by us.
  if (url.startsWith('about:')) return 'allow';

  // The attachment viewer renders a PDF by pointing an iframe at
  // `sarv-attachment://`, so the frame guard has to let that scheme through or
  // the viewer is a permanently blank panel. It stays blocked at the top level:
  // a window-level navigation to it would replace the whole app with a document
  // served from a mail message, and nothing the app does needs that.
  if (scope === 'frame' && url.startsWith(`${ATTACHMENT_SCHEME}:`)) return 'allow';

  // The PDF plugin's own render frame (see PDF_VIEWER_ORIGIN above).
  if (scope === 'frame' && url.startsWith(PDF_VIEWER_ORIGIN)) return 'allow';

  // Extension panels, frame scope only for the same reason as the attachment
  // scheme: a window-level navigation to a panel would replace the app with
  // an extension's page. Which frames may load one: isPanelNavigationAllowed.
  if (scope === 'frame') {
    const panel = parsePanelUrl(url);
    if (panel) return isPanelNavigationAllowed(panel.host, appUrl, source) ? 'allow' : 'block';
  }

  // Real web destinations leave for the user's browser rather than rendering
  // inside the inbox.
  if (EXTERNAL_PROTOCOLS.some((protocol) => url.startsWith(protocol))) return 'external';

  // Anything else — any other file:, custom app schemes, javascript: — is
  // refused outright rather than handed to the OS.
  return 'block';
}
