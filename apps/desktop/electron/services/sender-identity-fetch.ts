/**
 * The network door for sender identity (BIMI logos and certificates, domain
 * favicons), and why it is Node's https rather than Chromium's.
 *
 * Every URL fetched here was named by a stranger: a `<link rel="icon">` on a
 * sender's homepage, or the `l=` / `a=` tags in the sender's DNS. With a plain
 * fetch that is a blind GET from inside the reader's network to wherever the
 * sender points: `https://127.0.0.1:<port>/…`, the router, or a cloud metadata
 * address (CASA audit L-6). The destination has to be checked where the
 * connection is made. A name checked ahead of time can resolve somewhere else a
 * moment later (DNS rebinding). Electron's `net` offers no hook at that point;
 * Node's `https.request` does, because its `lookup` option IS the resolution
 * the socket connects to. So this transport:
 *
 *   - refuses anything but https on the default port, an IP-literal host that
 *     is not public (Node skips `lookup` for a literal) and, when `site` is set,
 *     a host on another registrable domain. These are core's
 *     `checkPublicHttpsUrl` rules;
 *   - resolves every name through a lookup that refuses the WHOLE answer when
 *     any address in it is not public (core `isPublicAddress`);
 *   - follows at most {@link MAX_REDIRECTS} redirects itself, each one held to
 *     the same rules, and reports the final URL so relative icon links resolve;
 *   - reads at most {@link MAX_BODY_BYTES} of a body, and stops reading there;
 *   - gives the request {@link SenderIdentityFetchOptions.timeoutMs} to answer
 *     (redirects included) and the same again to deliver its body, as
 *     timed-fetch.ts does for Chromium.
 *
 * A REFUSED URL — plain http, another port, a private IP written into the URL,
 * too many redirects — answers like a server that said no (`ok: false`,
 * `status: 0`) instead of throwing: the sender chose it, so the library records
 * an ordinary negative answer (favicon "none" for a month, BIMI "invalid" for a
 * week) and does not ask again every hour. A NAME that resolves to a private
 * address throws instead, like a genuine network failure (DNS down, connection
 * reset, TLS failure, timeout): that is as often the reader's own network
 * rewriting every answer (a captive portal before sign-in) as a hostile sender,
 * so it is recorded as an error and retried in an hour. A hostile name costs
 * one refused DNS answer an hour, and is never connected to.
 *
 * Trade-off: this is Node's network stack, not Chromium's, so there is no
 * system proxy, no AIA intermediate fetching and only Node's CA bundle. On a
 * network that forces a proxy, logos and favicons do not load. That is
 * cosmetic, and it is the price of checking the address the socket really
 * connects to.
 *
 * Plain Node (no Electron import), so it runs and is tested outside the app.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';

import {
  BIMI_EVIDENCE_MAX_BYTES,
  BIMI_LOGO_MAX_BYTES,
  FAVICON_MAX_BYTES,
  HOMEPAGE_MAX_BYTES,
  checkPublicHttpsUrl,
  createLogger,
  isPublicAddress,
  withTimeout,
  type DestinationCheck,
  type DestinationRefusal,
  type FetchLike,
  type FetchResponse,
} from '@sarvinbox/core';

const logger = createLogger('sender-identity-fetch');

/** Lines for refusals that are routine rather than suspicious, such as an icon on a CDN. */
const DEBUG_SENDER_IDENTITY = process.env.SARV_DEBUG_SENDER_IDENTITY === '1';

/** Redirects followed per fetch. A homepage that bounces more than this has no icon worth it. */
export const MAX_REDIRECTS = 3;

/**
 * The most body read per request: the largest limit any of the brand readers
 * applies (the homepage scanned for icon links, 256 KB). A longer body is cut
 * at ONE byte past this, so each bounded reader still sees it as over its own
 * limit. It then refuses it (a logo, an icon) or keeps its own prefix (the
 * homepage), exactly as it would with the whole body.
 */
export const MAX_BODY_BYTES = Math.max(HOMEPAGE_MAX_BYTES, FAVICON_MAX_BYTES, BIMI_LOGO_MAX_BYTES, BIMI_EVIDENCE_MAX_BYTES);

/** Sent with every request. Some servers refuse a request that names no client at all. */
export const USER_AGENT = 'Mozilla/5.0 (compatible; SarvInbox)';

/** Why a request was refused: the URL rules, a name that resolves to a private address, or a redirect chain that would not end. */
export type SenderIdentityRefusal = DestinationRefusal | 'too-many-redirects';

/** `dns.lookup` in its `all: true` callback form, the injectable resolver behind the guarded lookup. */
export type Resolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** `https.request` in the one shape used here; injectable for tests. */
export type HttpsRequest = (options: RequestOptions) => ClientRequest;

/** Raised from the guarded lookup; turned into a refused response, never thrown to the caller. */
export class RefusedDestinationError extends Error {
  constructor(readonly reason: SenderIdentityRefusal, readonly host: string) {
    super(`Refused to connect to ${host}: ${reason}`);
    this.name = 'RefusedDestinationError';
  }
}

/**
 * A `lookup` for `https.request` that only ever lets the socket connect to
 * public addresses. It resolves EVERY address for the name and refuses the
 * whole answer when any one of them is not public. Otherwise an answer that
 * mixes a public address with 127.0.0.1 could win the race to the private one.
 * It answers in whichever form Node asked for (`all` or a single address).
 */
export function publicOnlyLookup(resolve: Resolver = dnsLookup as unknown as Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, []);
        return;
      }
      if (addresses.length === 0) {
        // Never handed to Node empty: its multi-address connect reads the
        // first entry unconditionally.
        callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND', hostname }), []);
        return;
      }
      if (addresses.some((entry) => !isPublicAddress(entry.address))) {
        callback(new RefusedDestinationError('private-address', hostname), []);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface SenderIdentityFetchOptions {
  /** How long a request has to answer (redirects included), and then again to deliver its body. */
  timeoutMs: number;
  /**
   * Keep every request, redirects included, on this domain's registrable
   * domain. Favicons set it to the sender's domain. BIMI does not, because a
   * logo on a CDN is normal there.
   */
  site?: string;
  /** Test seam: the name resolver behind the guarded lookup (default `dns.lookup`). */
  resolve?: Resolver;
  /** Test seam: the request function (default `https.request`). */
  request?: HttpsRequest;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** One header from Node's lower-cased map, joined the way WHATWG `Headers.get` joins repeats. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}

function logRefusal(url: string, reason: SenderIdentityRefusal): void {
  let host = url;
  try { host = new URL(url).host; } catch { /* not a URL: say what it was */ }
  if (reason === 'private-address') logger.warn(`[SenderIdentity] refused a fetch to ${host}: it is not a public address`);
  else if (DEBUG_SENDER_IDENTITY) logger.debug(`[SenderIdentity] refused a fetch to ${host}: ${reason}`);
}

function refused(url: string, reason: SenderIdentityRefusal): FetchResponse {
  logRefusal(url, reason);
  return { ok: false, status: 0, url, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
}

/** Send one GET to an already-checked destination and wait for its status line and headers. */
function sendRequest(send: HttpsRequest, target: Extract<DestinationCheck, { ok: true }>, lookup: LookupFunction): {
  req: ClientRequest;
  response: Promise<IncomingMessage>;
} {
  const req = send({
    hostname: target.host,
    port: 443,
    path: `${target.url.pathname}${target.url.search}`,
    method: 'GET',
    headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
    lookup,
    // A private socket per request: a pooled one could have been connected by
    // some other code without this lookup.
    agent: false,
  });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.once('response', resolve);
    // `on`, not `once`: the listener stays for the request's whole life,
    // because an 'error' event with no listener would crash the main process.
    req.on('error', reject);
  });
  req.end();
  return { req, response };
}

/**
 * Read at most `cap + 1` bytes of `res`, then stop reading and close the
 * connection. A connection that closes before the body is complete is an
 * error, as it was through Chromium.
 */
function readCapped(res: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > cap) {
        resolve(Buffer.concat(chunks).subarray(0, cap + 1));
        res.destroy();
      }
    });
    res.once('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    res.once('close', () => reject(new Error('The connection closed before the body was complete')));
  });
}

/** Node's Buffer as the standalone ArrayBuffer FetchResponse promises. */
const toArrayBuffer = (bytes: Buffer): ArrayBuffer => Uint8Array.from(bytes).buffer;

/**
 * A FetchLike for the brand lookups that cannot be pointed at the reader's
 * own machine or network. Build one per lookup when `site` is set (favicons),
 * because the site rule is bound to the sender's domain.
 */
export function senderIdentityFetch(options: SenderIdentityFetchOptions): FetchLike {
  const lookup = publicOnlyLookup(options.resolve);
  const send = options.request ?? ((opts: RequestOptions) => httpsRequest(opts));
  const { timeoutMs, site } = options;

  return async (input) => {
    const answerBy = Date.now() + timeoutMs;
    let current = input;
    for (let redirects = 0; ; redirects += 1) {
      const target = checkPublicHttpsUrl(current, { site });
      if (!target.ok) return refused(current, target.reason);

      const { req, response } = sendRequest(send, target, lookup);
      let res: IncomingMessage;
      try {
        res = await withTimeout(response, Math.max(0, answerBy - Date.now()), `Timed out fetching ${input}`);
      } catch (e) {
        req.destroy();
        // A private DNS answer is not refused for good: see the header.
        if (e instanceof RefusedDestinationError) logRefusal(current, e.reason);
        throw e;
        throw e;
      }

      const status = res.statusCode ?? 0;
      const location = headerValue(res.headers, 'location');
      if (REDIRECTS.has(status) && location !== null) {
        req.destroy();
        if (redirects >= MAX_REDIRECTS) return refused(current, 'too-many-redirects');
        try {
          current = new URL(location, target.url).toString();
        } catch {
          return refused(location, 'invalid-url');
        }
        continue;
      }

      // A server that declares more than the cap is not read at all. Every
      // brand reader refuses such a response on the header alone.
      const declared = Number.parseInt(headerValue(res.headers, 'content-length') ?? '', 10);
      let body: Buffer | null = null;
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        req.destroy();
      } else {
        try {
          body = await withTimeout(readCapped(res, MAX_BODY_BYTES), timeoutMs, `Timed out reading ${input}`);
        } finally {
          req.destroy();
        }
      }

      const finalUrl = current;
      const kept = body;
      return {
        ok: status >= 200 && status < 300,
        status,
        url: finalUrl,
        headers: { get: (name: string) => headerValue(res.headers, name) },
        arrayBuffer: async () => {
          if (kept === null) throw new Error(`${finalUrl} declares a body larger than ${MAX_BODY_BYTES} bytes`);
          return toArrayBuffer(kept);
        },
      };
    }
  };
}
