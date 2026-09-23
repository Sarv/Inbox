import * as fs from 'fs';

import {
  createLogger,
  PANEL_SCHEME,
  panelAssetContentType,
  parsePanelUrl,
  resolveWithinDir,
  SDK_HOST,
} from '@sarvinbox/core';
import { protocol } from 'electron';

import { PANEL_SDK_FILENAME, PANEL_SDK_SOURCE } from './extension-panel-sdk';

const logger = createLogger('extension-panel-protocol');

/**
 * `sarv-extension://` — serves an extension's own panel pages to the renderer.
 *
 * Every extension gets its own origin (`sarv-extension://<extension-id>`),
 * which is what keeps one extension's panel out of another's storage and out
 * of the app's. The scheme serves files from that extension's install folder
 * and nothing else: not another extension's folder, not the app's, not the
 * user's mail store.
 *
 * Three gates, in order, before a single byte is read:
 *   1. the extension is installed, enabled, and was granted `ui:panel`;
 *   2. the resolved path is inside that extension's folder;
 *   3. the file's extension is one panels are allowed to load.
 */

/** Privileges the scheme needs. Registered from `main.ts` BEFORE `app.whenReady()`. */
export const PANEL_SCHEME_PRIVILEGES = {
  scheme: PANEL_SCHEME,
  privileges: {
    // `standard` is the load-bearing one: it gives each extension id a real,
    // separate origin, so same-origin policy does the isolation between
    // extensions for us. `secure` keeps panels out of mixed-content blocking,
    // and `supportFetchAPI` lets a panel fetch its own data files.
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
} as const;

/** What the protocol needs to know about an installed extension. */
export interface PanelExtensionLookup {
  /**
   * The folder to serve from, or undefined when the extension may not serve
   * panels at all — not installed, disabled, or never granted `ui:panel`.
   */
  (extensionId: string): string | undefined;
}

let lookupExtension: PanelExtensionLookup = () => undefined;

/**
 * The Content-Security-Policy every panel page is served with.
 *
 * `default-src 'none'` then allow back only what a panel legitimately needs,
 * all of it from its own origin. The two that matter most:
 *
 *  - no `connect-src` beyond `'self'`, so a panel cannot phone home with the
 *    mail it was shown. An extension that needs the network asks for
 *    `network:fetch` and does it in its module, where the host can see it.
 *  - `frame-ancestors 'self'` plus the app's own origin, so a panel page cannot
 *    be framed by anything else even if its URL leaks.
 *
 * `style-src` allows inline styles because a no-build panel is one HTML file
 * with a `<style>` block in it; `script-src` deliberately does not.
 *
 * `script-src` also names the SDK origin. `standard: true` gives every host on
 * this scheme its own origin, so `sarv-extension://sdk` is NOT covered by the
 * panel's `'self'` and the documented `<script src="sarv-extension://sdk/sarv.js">`
 * would be blocked without this. It is an app-owned host — the id `sdk` is
 * reserved at load and the only thing served there is the SDK, from memory —
 * so naming it grants a panel nothing an extension could supply itself.
 */
function panelContentSecurityPolicy(): string {
  const frameAncestors = appOrigin && appOrigin !== 'null' ? `'self' ${appOrigin}` : `'self'`;
  return [
    "default-src 'none'",
    `script-src 'self' ${PANEL_SCHEME}://${SDK_HOST}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

/** The renderer's own origin — the only one allowed to fetch panel assets. */
let appOrigin: string | null = null;

/** Reduce a loaded URL to the origin its documents will send. */
function toOrigin(url: string): string | null {
  try {
    return new URL(url).origin; // `file://...` normalises to the string "null"
  } catch {
    return null;
  }
}

/**
 * Echo the allow-origin header, and only for our own renderer.
 *
 * A panel's own fetches come from its own origin, so they are same-origin and
 * need no header; this covers the app frame reading a panel asset directly.
 */
function applyCors(headers: Headers, request: Request): Headers {
  const origin = request.headers.get('Origin');
  if (origin && appOrigin && origin === appOrigin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return headers;
}

/** A short plain-text refusal. Never includes a filesystem path or a stack. */
function errorResponse(request: Request, status: number, message: string): Response {
  const headers = applyCors(
    new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }),
    request
  );
  return new Response(message, { status, headers });
}

/** Headers shared by every asset the scheme serves. */
function assetHeaders(request: Request, contentType: string): Headers {
  const headers = new Headers({
    'Content-Type': contentType,
    // The type comes from our own allow-list, keyed on the file extension. No
    // sniffing on top of it — a `.css` full of HTML stays a stylesheet.
    'X-Content-Type-Options': 'nosniff',
    // An extension can be updated in place under the same version while the app
    // is running. A cached panel would keep serving the old page with no way
    // for the user to force a reload.
    'Cache-Control': 'no-store',
  });
  if (contentType.startsWith('text/html')) {
    headers.set('Content-Security-Policy', panelContentSecurityPolicy());
  }
  applyCors(headers, request);
  return headers;
}

/**
 * Serve one panel request. Exported for tests; `registerPanelProtocol` is what
 * wires it to the scheme.
 */
export async function handlePanelRequest(request: Request): Promise<Response> {
  const ref = parsePanelUrl(request.url);
  if (!ref) return errorResponse(request, 400, 'Bad panel request');

  // The app's own SDK, served from memory rather than disk so there is no file
  // to copy at build time and none to tamper with at runtime.
  if (ref.host === SDK_HOST) {
    if (ref.assetPath !== PANEL_SDK_FILENAME) {
      return errorResponse(request, 404, 'No such SDK file');
    }
    return new Response(PANEL_SDK_SOURCE, {
      status: 200,
      headers: assetHeaders(request, 'text/javascript; charset=utf-8'),
    });
  }

  // GATE 1: may this extension serve panels at all?
  const extensionDir = lookupExtension(ref.host);
  if (!extensionDir) {
    return errorResponse(request, 403, 'This extension cannot show panels');
  }

  // GATE 2: is the file inside the extension's own folder? `resolveWithinDir`
  // throws on any path that escapes, including the encoded forms — the URL was
  // already percent-decoded before it got here, on purpose.
  let filePath: string;
  try {
    filePath = resolveWithinDir(extensionDir, ref.assetPath);
  } catch {
    logger.warn(`[panel-protocol] refused a path outside ${ref.host}'s folder`);
    return errorResponse(request, 403, 'Not part of this extension');
  }

  // GATE 3: is this a kind of file a panel may load? The extension folder also
  // holds its manifest and its Node module; neither belongs in the renderer.
  const contentType = panelAssetContentType(ref.assetPath);
  if (!contentType) {
    return errorResponse(request, 403, 'This file type cannot be loaded in a panel');
  }

  let body: Buffer;
  try {
    const stat = await fs.promises.stat(filePath);
    // A directory answers `readFile` with EISDIR on some platforms and an empty
    // read on others; refuse it the same way everywhere.
    if (!stat.isFile()) return errorResponse(request, 404, 'Panel file not found');
    body = await fs.promises.readFile(filePath);
  } catch {
    return errorResponse(request, 404, 'Panel file not found');
  }

  const headers = assetHeaders(request, contentType);
  headers.set('Content-Length', String(body.byteLength));
  // Copied into a plain Uint8Array: Node's Buffer can be a window into a
  // larger pooled ArrayBuffer, so the copy is what guarantees the response
  // carries this file's bytes and nothing that happened to share the pool.
  return new Response(new Uint8Array(body), { status: 200, headers });
}

/**
 * Wire the scheme up. Call once, inside `app.whenReady()`, after the extension
 * manager exists.
 *
 * `rendererUrl` is whatever the window loads; its origin is the only one
 * allowed to fetch panel assets and to frame a panel page.
 */
export function registerPanelProtocol(rendererUrl: string, lookup: PanelExtensionLookup): void {
  appOrigin = toOrigin(rendererUrl);
  lookupExtension = lookup;
  protocol.handle(PANEL_SCHEME, handlePanelRequest);
  logger.info(`[panel-protocol] ${PANEL_SCHEME}:// registered`);
}
