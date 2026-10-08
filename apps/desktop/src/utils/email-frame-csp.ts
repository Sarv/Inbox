/**
 * The Content-Security-Policy every rendered or printed email document carries,
 * and the ONE way it is put into that document.
 *
 * The policy blocks every remote fetch — scripts, stylesheets, fonts, frames,
 * and (unless the user chose to load them) images, the classic tracking pixel
 * that tells a sender you opened their mail, from where, and when.
 *
 * Placement is the whole defence. A `<meta>` CSP only applies if the parser
 * puts it in <head> and only to what comes after it. It used to be spliced in
 * at the email's own `</head>` — so an email with `<head` and no `</head>`, a
 * `</head>` inside a comment, or `<html` inside an attribute value got NO
 * policy, and the frame fell back to the app's, which allows https: images
 * (CASA M-4). Now it is the first thing in the document, before a single byte
 * of the email: the parser always places a leading <meta> in an implied
 * <head>, and nothing the email contains can come before it or wrap it.
 */

/** The CSP meta tag; remote http(s) images only when `allowRemoteImages`. */
export function emailFrameCsp(allowRemoteImages: boolean): string {
  const imgSrc = allowRemoteImages ? 'data: blob: https: http:' : 'data: blob:';
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:;">`;
}

/**
 * `html` with the email CSP (and optional `extraHead`, e.g. a theme <style>)
 * placed before any of its content.
 *
 * A leading `<!DOCTYPE …>` is kept first, so the document parses exactly as
 * the email wrote it. (An iframe `srcdoc` document always renders in
 * standards mode, so this is belt and braces there; it matters if the same
 * document is ever loaded any other way, where a <meta> ahead of the doctype
 * would force quirks mode.) Nothing else may precede the policy.
 */
export function withLeadingCsp(html: string, allowRemoteImages: boolean, extraHead = ''): string {
  const body = html.startsWith('﻿') ? html.slice(1) : html;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(body)?.[0] ?? '';
  return `${doctype}${emailFrameCsp(allowRemoteImages)}${extraHead}${body.slice(doctype.length)}`;
}
