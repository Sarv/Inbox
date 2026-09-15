/**
 * What to do with a navigation the window is about to perform.
 *
 * Two Electron events ask the same question — `will-navigate` for the top-level
 * frame and `will-frame-navigate` for any frame inside it — and they had two
 * near-identical inline copies of the answer. They must not drift: a rule added
 * to one and forgotten in the other is either a hole (the frame guard misses a
 * scheme the top-level one blocks) or a broken feature (the frame guard blocks
 * something the app itself loads). One pure function, decided in one place.
 */

import { ATTACHMENT_SCHEME } from '@sarvinbox/core';

export type NavigationVerdict = 'allow' | 'external' | 'block';

/**
 * `top` is the window itself; `frame` is anything nested inside it (the email
 * body iframe, the attachment viewer's PDF frame).
 */
export type NavigationScope = 'top' | 'frame';

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
 * Both guards used to answer this with `url.startsWith(appOrigin)`, which is a
 * prefix match on a string, not on an origin: with a dev origin of
 * `http://localhost:5173`, the host `localhost:5173.evil.example` starts with
 * it and was admitted. Compare the parsed protocol and host instead.
 *
 * `file:` is the production origin and carries no host, so every `file:` URL
 * counts as the app — the same reach the old `startsWith('file://')` had.
 */
function isAppUrl(url: string, appOrigin: string): boolean {
  try {
    const target = new URL(url);
    const app = new URL(appOrigin);
    if (target.protocol !== app.protocol) return false;
    return app.protocol === 'file:' || target.host === app.host;
  } catch {
    // An unparseable target is not the app, and falls through to be blocked.
    return false;
  }
}

/**
 * @param url       the navigation target, exactly as Electron reports it
 * @param appOrigin the dev server URL in development, `file://` in production
 * @param scope     which of the two guards is asking
 */
export function classifyNavigation(
  url: string,
  appOrigin: string,
  scope: NavigationScope
): NavigationVerdict {
  // The app's own pages, wherever they are served from.
  if (isAppUrl(url, appOrigin)) return 'allow';

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

  // Real web destinations leave for the user's browser rather than rendering
  // inside the inbox.
  if (EXTERNAL_PROTOCOLS.some((protocol) => url.startsWith(protocol))) return 'external';

  // Anything else — file://, custom app schemes, javascript: — is refused
  // outright rather than handed to the OS.
  return 'block';
}
