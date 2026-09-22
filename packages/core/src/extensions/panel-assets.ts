/**
 * What the panel scheme is allowed to serve, and how to address it.
 *
 * Panels are extension-authored HTML loaded into a sandboxed iframe. Unlike the
 * attachment scheme — which must never hand the renderer HTML or script — this
 * one exists precisely to serve an extension's own page, so the allow-list is
 * wider. What it is NOT allowed to do is serve anything outside the extension's
 * folder, or anything whose type would make the browser treat a file as
 * something it is not.
 *
 * Deliberately free of Node imports so the renderer can import the parser and
 * build the same URLs the main process resolves.
 */

/** URL scheme panel assets are served over. */
export const PANEL_SCHEME = 'sarv-extension';

/**
 * Host reserved for the SDK the app itself ships.
 *
 * An extension author writes `<script type="module" src="sarv-extension://sdk/
 * sdk.mjs">` and gets the API with no build step and no dependency to install.
 * No extension can ever be installed under this id — the loader rejects it.
 */
export const SDK_HOST = 'sdk';

/**
 * Content types the panel scheme will answer with, keyed by lowercase
 * extension.
 *
 * An explicit table rather than a MIME database, for the same reason the
 * attachment scheme uses one: a database answers for every extension that has
 * ever existed, including the ones we never meant to serve. Served with
 * `X-Content-Type-Options: nosniff`, so the browser cannot second-guess it.
 */
const PANEL_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',

  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',

  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/** Lowercase extension of a path, without the dot. Empty when there is none. */
function assetExtension(assetPath: string): string {
  const lastSlash = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
  const name = assetPath.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The `Content-Type` for a panel asset, or undefined when the scheme refuses
 * to serve it at all.
 *
 * Refusing outright rather than falling back to `application/octet-stream` is
 * the point: an extension folder also holds its manifest, its Node module and
 * whatever else the author left there, and none of that belongs in a page the
 * renderer loads.
 */
export function panelAssetContentType(assetPath: string): string | undefined {
  return PANEL_CONTENT_TYPES[assetExtension(assetPath)];
}

/** An address the panel scheme understands. */
export interface PanelAssetRequest {
  /** Extension the asset belongs to, or `sdk` for the app's own SDK. */
  host: string;
  /** Path within that extension's folder, with no leading slash. */
  assetPath: string;
}

/**
 * Parse a `sarv-extension://<id>/<path>` URL.
 *
 * Returns undefined for anything that is not addressable: a different scheme,
 * a missing host, or an empty path. Percent-escapes are decoded here so the
 * containment check downstream sees the real path — `%2e%2e%2f` must not be
 * able to slip past it by arriving encoded.
 */
export function parsePanelUrl(rawUrl: string): PanelAssetRequest | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== `${PANEL_SCHEME}:`) return undefined;

  const host = url.hostname.toLowerCase();
  if (!host) return undefined;

  let assetPath: string;
  try {
    assetPath = decodeURIComponent(url.pathname);
  } catch {
    // A malformed escape sequence. Nothing legitimate produces one.
    return undefined;
  }

  assetPath = assetPath.replace(/^\/+/, '');
  if (!assetPath) return undefined;

  return { host, assetPath };
}

/** Build the URL that serves `assetPath` from `extensionId`'s folder. */
export function panelAssetUrl(extensionId: string, assetPath: string): string {
  const cleaned = assetPath.replace(/^\.?\/+/, '');
  const encoded = cleaned
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${PANEL_SCHEME}://${extensionId}/${encoded}`;
}
