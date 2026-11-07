/**
 * Closing an OAuth loopback listener without cutting off the page it just served.
 * The mail/Sarv sign-in listener (oauth-service.ts) and the antivirus scanner's
 * (antivirus-oauth-service.ts) both close from INSIDE a request handler, right
 * after `res.end()`.
 */

import type { Server, ServerResponse } from 'node:http';

/** How long a closing listener waits for a response it is still sending before dropping the connection anyway. */
export const RESPONSE_FLUSH_GRACE_MS = 2_000;

/** The answers a listener has started and not finished, each settling when its own does. */
export type AnsweringResponses = Map<ServerResponse, Promise<void>>;

/** Call first thing for every request, so {@link closeLoopbackServer} can wait for its answer. */
export function trackLoopbackResponse(answering: AnsweringResponses, response: ServerResponse): void {
  answering.set(response, new Promise<void>((resolve) => {
    const answered = () => {
      answering.delete(response);
      resolve();
    };
    response.once('finish', answered);
    response.once('close', answered);
  }));
}

/**
 * Free the port at once; drop every connection still open on it once each
 * response already written has reached the OS.
 *
 * `server.close()` stops accepting and drops idle connections (a browser's
 * speculative preconnect), but leaves one whose request is being answered.
 * Whatever it leaves — that response, or a request whose headers never
 * finished — would keep the old listener and its handler alive with no port
 * behind it, so `closeAllConnections()` follows. Not straight away: a listener
 * closes from INSIDE the request handler, right after `res.end()`. On POSIX the
 * page is already in the kernel then (the write is synchronous); on Windows it is
 * overlapped I/O, and closing the socket under it can cancel the write — the
 * browser would show a reset instead of the page. So the drop waits for every
 * answer in flight to finish (or its connection to go), and an unref'd timer
 * bounds the wait for a client that stops reading.
 */
export function closeLoopbackServer(server: Server, answering: AnsweringResponses): void {
  server.close();
  const inFlight = [...answering.values()];
  if (inFlight.length === 0) {
    server.closeAllConnections();
    return;
  }
  const backstop = setTimeout(() => server.closeAllConnections(), RESPONSE_FLUSH_GRACE_MS);
  backstop.unref();
  void Promise.all(inFlight).then(() => {
    clearTimeout(backstop);
    server.closeAllConnections();
  });
}
