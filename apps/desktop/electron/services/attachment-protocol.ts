import { protocol } from 'electron';
import * as fs from 'fs';
import { Readable } from 'stream';

import {
  ATTACHMENT_SCHEME,
  attachmentContentType,
  createLogger,
  isInlineRenderableAttachment,
  parseAttachmentUrl,
} from '@sarvinbox/core';

import { AttachmentError, resolveAttachmentFile } from './attachment-cache';

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
      `[attachment-protocol] no CORS allow for origin ${origin} (renderer origin is ${appOrigin})`,
    );
  }
  return headers;
}

/** Number of bytes served per streamed chunk. */
const STREAM_CHUNK_BYTES = 256 * 1024;

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
  size: number,
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

/** A file range as a web `ReadableStream`, so nothing is buffered whole in memory. */
function fileStream(filePath: string, start: number, end: number): ReadableStream<Uint8Array> {
  const nodeStream = fs.createReadStream(filePath, {
    start,
    end,
    highWaterMark: STREAM_CHUNK_BYTES,
  });
  // Node's own adapter — no hand-rolled pump, and it propagates backpressure,
  // errors and cancellation correctly.
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

/** A short plain-text error. Never includes a filesystem path or stack. */
function errorResponse(request: Request, status: number, message: string): Response {
  // Carries the CORS header too: without it a refusal reaches the renderer as an
  // opaque network error, so the viewer cannot tell "wrong type" from "offline".
  const headers = applyCors(
    new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }),
    request,
  );
  return new Response(message, { status, headers });
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

  let filePath: string;
  try {
    // Resolves the owning account, asserts the email really declares this
    // filename, and fetches from IMAP into the cache if needed.
    ({ filePath } = await resolveAttachmentFile(ref));
  } catch (error) {
    if (error instanceof AttachmentError) {
      return errorResponse(request, error.status, error.message);
    }
    logger.error('[attachment-protocol] request failed:', error);
    return errorResponse(request, 500, 'Attachment could not be read');
  }

  let size: number;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    return errorResponse(request, 404, 'Attachment not available');
  }

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

  // An empty file has no valid byte range to stream — answer an empty body.
  if (size === 0) return new Response(null, { status: range ? 206 : 200, headers });

  logger.info(
    `[attachment-protocol] served ${ref.filename} ${start}-${end}/${size} ` +
      `type=${headers.get('Content-Type')} origin=${request.headers.get('Origin') ?? 'none'}`,
  );
  return new Response(fileStream(filePath, start, end), {
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
