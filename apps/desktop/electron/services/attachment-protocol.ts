
import {
  ATTACHMENT_SCHEME,
  attachmentContentType,
  createLogger,
  isInlineRenderableAttachment,
  parseAttachmentUrl,
} from '@sarvinbox/core';
import { protocol } from 'electron';

import { AttachmentError, readCachedAttachment, resolveAttachmentFile } from './attachment-cache';
import { getAttachmentPreviewProtection } from './attachment-preview-protection';

const logger = createLogger('attachment-protocol');

/**
 * `sarv-attachment://` — the pipe that gets attachment BYTES into the renderer
 * so the in-app viewer can show a document without handing it to the OS.
 *
 * Why a custom scheme rather than base64 over IPC: a 30 MB PDF becomes a ~40 MB
 * string that has to be built, copied across the IPC boundary and held in the
 * renderer, all on the main thread. A scheme streams from disk and — crucially —
 * answers `Range` requests, which is what makes video seeking and Chromium's
 * PDF viewer (which fetches the file in pieces) work at all.
 */

/** Privileges the scheme needs. Registered from `main.ts` BEFORE `app.whenReady()`. */
export const ATTACHMENT_SCHEME_PRIVILEGES = {
  scheme: ATTACHMENT_SCHEME,
  privileges: {
    // `standard` gives the scheme a real origin (so it can be used in <img>,
    // <video>, fetch); `secure` keeps it out of Chromium's mixed-content blocking;
    // `stream` is what allows a 206 partial response (media seeking).
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true,
  },
} as const;

/**
 * The renderer's own origin — the ONLY origin allowed to read attachment bytes
 * with `fetch()`.
 *
 * `sarv-attachment://` is a standard scheme, so it has its own origin and every
 * request from the app's page is cross-origin: without an explicit allow, the
 * text pane's `fetch()` fails as a CORS error while `<img>`/`<video>`/the PDF
 * iframe (no-cors) still work — which is exactly how this shipped broken, with
 * text the one kind that could not be read. Set from `main.ts` so dev (the vite
 * server) and the packaged app (`file://`, whose documents send `Origin: null`)
 * agree with what the window actually loaded.
 */
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
 * A request with no `Origin` (an `<img>`/media load) needs no header at all, and
 * anything from another origin gets none - attachment bytes are private mail.
 */
function applyCors(headers: Headers, request: Request): Headers {
  const origin = request.headers.get('Origin');
  if (origin && appOrigin && origin === appOrigin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  } else if (origin) {
    // Loud, because the symptom downstream is a bare "could not be read" with no
    // status: the browser discards the response before the viewer sees it.
    logger.warn(
      `[attachment-protocol] no CORS allow for origin ${origin} (renderer origin is ${appOrigin})`
    );
  }
  return headers;
}

/**
 * Parse an HTTP `Range` header for the single-range form we support.
 *
 * Returns `null` when the header is absent or unparseable (answer 200 with the
 * whole file — the spec allows ignoring a Range we don't understand) and
 * `'unsatisfiable'` when the range is syntactically fine but outside the file,
 * which must be a 416 rather than a silent full-body response.
 */
export function parseRangeHeader(
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    // "bytes=-500" — the LAST 500 bytes. Chromium's media element uses this form.
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** A short plain-text error. Never includes a filesystem path or stack. */
function errorResponse(request: Request, status: number, message: string): Response {
  // Carries the CORS header too: without it a refusal reaches the renderer as an
  // opaque network error, so the viewer cannot tell "wrong type" from "offline".
  const headers = applyCors(
    new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }),
    request
  );
  return new Response(message, { status, headers });
}

/**
 * The last few cache entries opened for the viewer, held briefly. A viewer
 * asks for one attachment in many ranges (PDF pages, every media seek), and the
 * cache is sealed (CASA M-7), so without this each range would open the whole
 * file again. Erased when evicted or after the TTL — never handed to a response
 * (responses get their own slice copy).
 */
const RECENT_ENTRIES = 2;
const RECENT_TTL_MS = 30_000;
const recentEntries = new Map<string, { content: Buffer; timer: ReturnType<typeof setTimeout> }>();

function forgetRecentEntry(filePath: string): void {
  const entry = recentEntries.get(filePath);
  if (!entry) return;
  recentEntries.delete(filePath);
  clearTimeout(entry.timer);
  entry.content.fill(0);
}

/** Erase every held entry (tests; and a window that is going away). */
export function forgetRecentAttachmentEntries(): void {
  for (const filePath of [...recentEntries.keys()]) forgetRecentEntry(filePath);
}

async function openCachedForViewer(filePath: string): Promise<Buffer> {
  const held = recentEntries.get(filePath);
  if (held) return held.content;
  const content = await readCachedAttachment(filePath);
  forgetRecentEntry(filePath); // a concurrent request may have opened it too
  while (recentEntries.size >= RECENT_ENTRIES) forgetRecentEntry(recentEntries.keys().next().value!);
  const timer = setTimeout(() => forgetRecentEntry(filePath), RECENT_TTL_MS);
  timer.unref?.();
  recentEntries.set(filePath, { content, timer });
  return content;
}

/**
 * Serve one attachment request. Exported for tests; `registerAttachmentProtocol`
 * is what wires it to the scheme.
 */
export async function handleAttachmentRequest(request: Request): Promise<Response> {
  const ref = parseAttachmentUrl(request.url);
  if (!ref) return errorResponse(request, 400, 'Bad attachment request');

  // SECURITY GATE. Everything the viewer can render is on an allow-list of
  // extensions Chromium draws with <img>/<video>/<audio>/<pre>/the PDF viewer.
  // An executable, installer, script or HTML file is refused here and never
  // becomes a URL the renderer can load — the user reaches it only through an
  // explicit "Save a copy" (writes where they chose, opens nothing). Checked
  // BEFORE any disk or IMAP work so a hostile name costs nothing.
  if (!isInlineRenderableAttachment(ref.filename)) {
    return errorResponse(request, 403, 'This file type cannot be shown in Sarv Inbox');
  }

  // Electron includes display fragments (for example PDF #toolbar=0) in a
  // custom-protocol Request.url. They do not identify attachment bytes; the
  // lease validator receives the same fragmentless URL the host prepared.
  const contentUrl = new URL(request.url);
  contentUrl.hash = '';

  let verified: Buffer | undefined;
  let cached: Buffer | undefined;
  let heldPath: string | undefined;
  let size: number;
  try {
    const previews = getAttachmentPreviewProtection();
    if (!previews) {
      return errorResponse(request, 503, 'Attachment preview is not ready. Try again.');
    }
    // With scanning enabled, only an opaque clean lease may supply bytes. The
    // receipt verifies the owning account, verdict, digest and current consent
    // on every request, including PDF/media ranges; cached files are irrelevant.
    verified = await previews.contentForRequest(ref, contentUrl.toString(), request.signal);
    if (verified !== undefined) {
      size = verified.length;
    } else {
      // The cache path remains available when scanning is disabled. It is
      // sealed (CASA M-7): opened once, held briefly for the viewer's further
      // ranges (openCachedForViewer), and each range cut from that.
      const { filePath } = await resolveAttachmentFile(ref);
      try {
        cached = await openCachedForViewer(filePath);
        heldPath = filePath;
      } catch (error) {
        if (error instanceof AttachmentError) throw error;
        return errorResponse(request, 404, 'Attachment not available');
      }
      size = cached.length;
      // Resolving an uncached attachment can await IMAP. Enabling the scanner
      // during that wait must not expose unchecked bytes when it completes.
      await previews.contentForRequest(ref, contentUrl.toString(), request.signal);
    }
  } catch (error) {
    // Opened, then refused (scanning was switched on meanwhile): hold nothing.
    if (heldPath) forgetRecentEntry(heldPath);
    if (error instanceof AttachmentError) {
      return errorResponse(request, error.status, error.message);
    }
    logger.error('[attachment-protocol] request failed:', error);
    return errorResponse(request, 500, 'Attachment could not be read');
  }
  const content = verified ?? cached!;

  const headers = new Headers({
    'Content-Type': attachmentContentType(ref.filename),
    // `inline`, because the whole point is that nothing is downloaded. The
    // filename is quoted and percent-escaped by `encodeURIComponent` so a name
    // containing a quote or newline can't inject another header.
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(ref.filename)}`,
    // The content type above is derived from the extension allow-list, not from
    // anything the sender said. `nosniff` stops Chromium second-guessing it and
    // re-discovering, say, HTML inside a file we typed as octet-stream.
    'X-Content-Type-Options': 'nosniff',
    // Attachment bytes are private mail content: never let them into a disk cache
    // that outlives the cache we already manage and prune ourselves.
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  });
  applyCors(headers, request);

  const range = parseRangeHeader(request.headers.get('Range'), size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, size - 1);
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);

  // Empty files and HEAD requests have no body to stream.
  if (size === 0 || request.method === 'HEAD') {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  logger.info(
    `[attachment-protocol] served ${ref.filename} ${start}-${end}/${size} ` +
      `type=${headers.get('Content-Type')} origin=${request.headers.get('Origin') ?? 'none'}`
  );
  // Copy before yielding: closing a viewer or revoking scanner consent erases
  // its retained receipt, and a held cache entry is erased when it expires. A
  // response owns only the exact byte slice it serves.
  const body = new Uint8Array(content.subarray(start, end + 1));
  return new Response(body, {
    status: range ? 206 : 200,
    headers,
  });
}

/**
 * Wire the scheme up. Call once, inside `app.whenReady()`, after storage init.
 *
 * `rendererUrl` is whatever the window loads (the vite dev server in dev, the
 * packaged `file://` page otherwise); its origin is the only one allowed to
 * `fetch()` attachment bytes.
 */
export function registerAttachmentProtocol(rendererUrl: string): void {
  appOrigin = toOrigin(rendererUrl);
  protocol.handle(ATTACHMENT_SCHEME, handleAttachmentRequest);
  logger.info(`[attachment-protocol] ${ATTACHMENT_SCHEME}:// registered`);
}
