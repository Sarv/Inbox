// Bounded, windowed incremental new-message fetch.
//
// Why this exists: the incremental "get mail newer than lastUid" step used to
// issue ONE unbounded `UID FETCH lastUid+1:*`. On a LARGE mailbox (tens of
// thousands of messages) or a slow server that single command routinely blew the
// 60s per-op timeout — the socket got recycled and the SAME unbounded fetch was
// retried on the next cycle, forever. New mail then only landed on the rare cycle
// the fetch happened to finish under 60s (observed: hours of "IMAP FETCH timed
// out — recycling the wedged connection" with the occasional "Added N new").
//
// The fix is the same discipline the historical backfill already uses: page the
// range `[sinceUid+1 .. uidNext-1]` in bounded UID windows via
// `fetchMessagesByUidRange`, so every FETCH is small enough to complete. This is
// the shared source used by BOTH the realtime IDLE path and the folder-syncer
// incremental path — never duplicate the windowing.

import type { FetchOptions, IIMAPClient, IMAPMessage } from '../types/imap';

/** Default UID span per bounded FETCH. Small enough that even a LARGE/slow
 *  mailbox returns one window well under the 60s per-op timeout, large enough
 *  that the common "a handful of new messages" case is still a single round-trip. */
export const NEW_MESSAGE_WINDOW = 500;

export interface WindowedFetchOptions {
  /** UID span per FETCH. Defaults to NEW_MESSAGE_WINDOW. */
  windowSize?: number;
  /** Stop after roughly this many messages have been collected, so a huge gap
   *  can't make a single call unbounded in time/memory — the caller advances
   *  lastSyncUid over what was fetched and the next cycle continues the drain.
   *  Undefined = drain the whole range. */
  maxMessages?: number;
}

/**
 * Fetch messages with UID strictly greater than `sinceUid`, up to (and including)
 * `uidNext - 1`, in bounded UID windows. Returns them in ascending UID order.
 *
 * - Never issues an unbounded `:*` fetch.
 * - Filters out UID <= sinceUid defensively (some servers echo the boundary
 *   message for an out-of-range low bound), so lastSyncUid can never regress.
 * - Falls back to the (unbounded) `getNewMessages` only when the client can't do
 *   bounded ranges (`fetchMessagesByUidRange` is optional on IIMAPClient) — a
 *   correctness floor for minimal fakes, not the hot path.
 */
export async function fetchNewMessagesWindowed(
  client: IIMAPClient,
  sinceUid: number,
  uidNext: number,
  options?: FetchOptions,
  windowOptions?: WindowedFetchOptions,
): Promise<IMAPMessage[]> {
  const hiEnd = uidNext - 1; // highest UID that can currently exist
  if (hiEnd <= sinceUid) return []; // nothing newer than what we already have

  // Client without bounded-range support: fall back to the legacy unbounded
  // fetch so behaviour is preserved for impls/fakes that only implement the
  // minimal interface. Still filter the boundary echo.
  if (typeof client.fetchMessagesByUidRange !== 'function') {
    const msgs = await client.getNewMessages(sinceUid, options);
    return msgs.filter((m) => m.uid > sinceUid);
  }

  const windowSize = Math.max(1, windowOptions?.windowSize ?? NEW_MESSAGE_WINDOW);
  const maxMessages = windowOptions?.maxMessages;
  const collected: IMAPMessage[] = [];

  for (let lo = sinceUid + 1; lo <= hiEnd; lo += windowSize) {
    const hi = Math.min(lo + windowSize - 1, hiEnd);
    const window = await client.fetchMessagesByUidRange(lo, hi, options);
    for (const m of window) {
      if (m.uid > sinceUid) collected.push(m);
    }
    if (maxMessages !== undefined && collected.length >= maxMessages) break;
  }

  // Ascending by UID — callers that want newest-first reverse it themselves.
  collected.sort((a, b) => a.uid - b.uid);
  return collected;
}
