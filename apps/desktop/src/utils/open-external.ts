/**
 * The one rule for which links from a message leave the app, and the one way
 * they leave.
 *
 * Every surface that shows a message body needs this — the standard view's
 * framed body (SandboxedEmailBody), the chat view's link clicks, and the chat's
 * right-click "Open link". Each used to carry its own copy of the check, and
 * the copies drifted: one lower-cased the scheme and the other did not, so a
 * sender's `MAILTO:` link took the web-link path in one view and not the other.
 */

/**
 * Whether a link is a `mailto:` one — in any case. A URL scheme is
 * case-insensitive (RFC 3986 §3.1), so `MAILTO:` is the same link.
 */
export function isMailtoLink(url: string): boolean {
  return url.toLowerCase().startsWith('mailto:');
}

/**
 * Whether the app hands a link from a message to the browser.
 *
 * Not an in-document jump (`#…`), which has nowhere to go once the body is
 * framed, and not `mailto:`, which is never a web page. Where a `mailto:` goes
 * instead is each view's call: the standard view leaves it to the frame's
 * default action; the chat view does nothing with it.
 */
export function opensExternally(url: string): boolean {
  return !!url && !url.startsWith('#') && !isMailtoLink(url);
}

/**
 * Open a web link from a message outside the app: the system browser in
 * Electron (the main process re-checks the scheme against its allow-list), a
 * new tab anywhere else. A link `opensExternally` refuses opens nothing.
 *
 * A module-level function, so its identity never changes — the chat library
 * re-attaches its frame listeners only when a frame loads, and a link handler
 * whose identity changed after that would silently stop being called.
 */
export function openExternalLink(url: string): boolean {
  if (!opensExternally(url)) return false;
  if (window.electronAPI?.app?.openExternal) {
    void window.electronAPI.app.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
  return true;
}
