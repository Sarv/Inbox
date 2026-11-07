/**
 * `context.network.fetch`: the one way out of the extension sandbox.
 *
 * An extension chooses the URL, so this holds it to the rules of any fetch whose
 * address the app did not pick: https on the default port, public addresses only,
 * checked at connect time so a name cannot rebind to the reader's router or to
 * 127.0.0.1 (core `checkPublicHttpsUrl`, and `publicOnlyLookup` from
 * sender-identity-fetch.ts, where the reasoning is). Node's https rather than
 * Chromium's stack for the same reason, and that also means no cookie jar: a
 * request here carries nothing of the app's sessions, and an extension cannot
 * borrow the sign-ins behind a remote image in an email.
 *
 * Every limit fails the call with a sentence the extension's author can act on.
 * Nothing here decides who may call: `context.network` has already checked
 * `network:fetch`, in main, before this is reached.
 */
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import {
  checkPublicHttpsUrl,
  createLogger,
  withTimeout,
  type ExtensionNetworkBackend,
  type ExtensionNetworkRequest,
  type ExtensionNetworkResult,
} from '@sarvinbox/core';

import {
  headerValue,
  publicOnlyLookup,
  readCapped,
  REDIRECT_STATUSES,
  USER_AGENT,
  type HttpsRequest,
  type Resolver,
} from './sender-identity-fetch';

const logger = createLogger('extension-network');

/** Redirects followed per request, each held to the same rules as the first URL. */
export const MAX_NETWORK_REDIRECTS = 5;

/** The most an extension may send, and the most it may be sent: 10 MB each way. */
export const MAX_NETWORK_BODY_BYTES = 10 * 1024 * 1024;

/** Used when a call names no timeout: for the answer, and again for its body. */
export const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;

/** The longest wait an extension may ask for. */
export const MAX_NETWORK_TIMEOUT_MS = 120_000;

/**
 * Requests one extension may have in flight. Beyond this it is told to wait its
 * turn, rather than queued in the process that holds everything else.
 */
export const MAX_CONCURRENT_REQUESTS = 16;

/** How many hosts each extension is remembered as having reached, for the log line. */
const MAX_HOSTS_LOGGED = 200;

/**
 * Headers that describe the connection, which are this client's to set. Refused
 * rather than dropped, so a request is never quietly other than what was asked.
 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers that say who the caller is, which must not follow a redirect to another site. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie']);

export interface ExtensionNetworkBackendDeps {
  /** Test seam: the name resolver behind the guarded lookup. */
  resolve?: Resolver;
  /** Test seam: the request function. */
  request?: HttpsRequest;
}

function requestHeaders(options: ExtensionNetworkRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) {
      throw new Error(`network.fetch: the ${name} header cannot be set`);
    }
    headers[lower] = value;
  }
  headers['user-agent'] ??= USER_AGENT;
  headers['accept'] ??= '*/*';
  // Node's https does not decompress, and handing back gzip nobody asked for
  // would be a stranger failure than an uncompressed body.
  headers['accept-encoding'] = 'identity';
  return headers;
}

/** What a redirect does to the request: the fetch standard's rules. */
function afterRedirect(status: number, method: string, body: Uint8Array | undefined): {
  method: string;
  body: Uint8Array | undefined;
} {
  const becomesGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
  if (becomesGet) return { method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined };
  return { method, body };
}

/** A request carried on one private socket, so nothing connected without the guarded lookup. */
function send(
  sendRequest: HttpsRequest,
  options: RequestOptions,
  body: Uint8Array | undefined
): { req: ClientRequest; response: Promise<IncomingMessage> } {
  const req = sendRequest(options);
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.once('response', resolve);
    // `on`, not `once`: an 'error' event with no listener would crash the main process.
    req.on('error', reject);
  });
  req.end(body);
  return { req, response };
}

export function createExtensionNetworkBackend(deps: ExtensionNetworkBackendDeps = {}): ExtensionNetworkBackend {
  const lookup = publicOnlyLookup(deps.resolve);
  const sendRequest = deps.request ?? ((options: RequestOptions) => httpsRequest(options));
  const inFlight = new Map<string, number>();
  const reached = new Map<string, Set<string>>();

  /** First contact only: enough to answer "what has this reached?" without a line per call. */
  const noteHost = (extensionId: string, host: string): void => {
    let hosts = reached.get(extensionId);
    if (!hosts) reached.set(extensionId, (hosts = new Set()));
    if (hosts.has(host) || hosts.size >= MAX_HOSTS_LOGGED) return;
    hosts.add(host);
    logger.info(`Extension '${extensionId}' reached ${host}`);
  };

  async function run(
    extensionId: string,
    input: string,
    options: ExtensionNetworkRequest
  ): Promise<ExtensionNetworkResult> {
    let headers = requestHeaders(options);
    let method = options.method ?? 'GET';
    let body: Uint8Array | undefined =
      typeof options.body === 'string' ? new TextEncoder().encode(options.body) : options.body;
    if (body && body.byteLength > MAX_NETWORK_BODY_BYTES) {
      throw new Error(`network.fetch: a request body may be at most ${MAX_NETWORK_BODY_BYTES} bytes`);
    }

    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS, MAX_NETWORK_TIMEOUT_MS);
    const answerBy = Date.now() + timeoutMs;
    let current = input;

    for (let redirects = 0; ; redirects += 1) {
      const target = checkPublicHttpsUrl(current);
      if (!target.ok) throw new Error(`network.fetch refused ${current}: ${target.reason}`);

      const { req, response } = send(
        sendRequest,
        {
          hostname: target.host,
          port: 443,
          path: `${target.url.pathname}${target.url.search}`,
          method,
          headers: body ? { ...headers, 'content-length': String(body.byteLength) } : headers,
          lookup,
          agent: false,
        },
        body
      );

      let res: IncomingMessage;
      try {
        res = await withTimeout(
          response,
          Math.max(0, answerBy - Date.now()),
          `network.fetch timed out waiting for ${target.host}`
        );
      } catch (error) {
        req.destroy();
        throw error;
      }
      noteHost(extensionId, target.host);

      const status = res.statusCode ?? 0;
      const location = headerValue(res.headers, 'location');
      if (REDIRECT_STATUSES.has(status) && location !== null) {
        req.destroy();
        if (redirects >= MAX_NETWORK_REDIRECTS) throw new Error(`network.fetch: too many redirects from ${input}`);
        const next = new URL(location, target.url);
        if (next.origin !== target.url.origin) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name))
          );
        }
        ({ method, body } = afterRedirect(status, method, body) as { method: typeof method; body: typeof body });
        current = next.toString();
        continue;
      }

      const declared = Number.parseInt(headerValue(res.headers, 'content-length') ?? '', 10);
      const tooLarge = `network.fetch: the response from ${target.host} is over ${MAX_NETWORK_BODY_BYTES} bytes`;
      if (Number.isFinite(declared) && declared > MAX_NETWORK_BODY_BYTES) {
        req.destroy();
        throw new Error(tooLarge);
      }
      let bytes: Buffer;
      try {
        bytes = await withTimeout(
          readCapped(res, MAX_NETWORK_BODY_BYTES),
          timeoutMs,
          `network.fetch timed out reading from ${target.host}`
        );
      } finally {
        req.destroy();
      }
      if (bytes.byteLength > MAX_NETWORK_BODY_BYTES) throw new Error(tooLarge);

      const responseHeaders: Record<string, string> = {};
      for (const name of Object.keys(res.headers)) {
        const value = headerValue(res.headers, name);
        if (value !== null) responseHeaders[name] = value;
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: res.statusMessage ?? '',
        url: current,
        headers: responseHeaders,
        // A plain copy: a Buffer can be a window onto a larger pool, and all of
        // that pool would otherwise cross into the sandbox with it.
        body: Uint8Array.from(bytes),
      };
    }
  }

  return {
    async fetch(extensionId, url, options) {
      const active = inFlight.get(extensionId) ?? 0;
      if (active >= MAX_CONCURRENT_REQUESTS) {
        throw new Error(`network.fetch: at most ${MAX_CONCURRENT_REQUESTS} requests at a time`);
      }
      inFlight.set(extensionId, active + 1);
      try {
        return await run(extensionId, url, options);
      } finally {
        const left = (inFlight.get(extensionId) ?? 1) - 1;
        if (left === 0) inFlight.delete(extensionId);
        else inFlight.set(extensionId, left);
      }
    },
  };
}
