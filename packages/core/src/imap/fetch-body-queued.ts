/**
 * The one place that decides how long a caller waits for a body fetch.
 *
 * `SyncEngine.fetchBody` QUEUES the request and drains it a few at a time, so a
 * plain `withTimeout` at the call site measures the wrong thing: submit a batch
 * and the tail's clock is spent watching the head download. On a slow server
 * every item past the first few expires before its FETCH is ever issued, the
 * caller cancels work the engine is about to do, and a caller that re-submits
 * the same newest-first batch each round never gets past the head — the
 * body-prefetch backlog stall.
 *
 * So the deadline is two-phase (see `withStartGatedTimeout`): a generous window
 * to reach the front of the queue, then a tight one once the fetch is actually
 * running. The engine signals the boundary via `onStart` at its dequeue point.
 *
 * Every batching body-fetch caller (prefetch scheduler, thread open, background
 * download) must go through this rather than hand-rolling a timeout, so they
 * share one policy and one place to tune it.
 */

import { withStartGatedTimeout } from '../utils/timeout';

export interface FetchedBody {
  rawBody: string;
  cleanBody: string;
  contentType: string;
  source: string;
}

/** The slice of SyncEngine this helper needs — keeps it trivially fake-able. */
export interface QueuedBodyFetcher {
  fetchBody(
    emailId: string,
    folderPath: string,
    uid: number,
    opts?: { onStart?: () => void },
  ): Promise<FetchedBody | null>;
}

/**
 * How long we'll wait for the engine to pick our item up. Sized for a full
 * caller batch to reach the front on a slow server (the engine drains 4-wide
 * with its own 30 s per-fetch cap), NOT for one message — this window is
 * queue-depth, and being generous here costs nothing when the server is fast.
 */
export const BODY_FETCH_QUEUE_WAIT_MS = 120_000;

/**
 * How long the fetch itself may take once it starts. Deliberately just above
 * the engine's internal 30 s body-fetch timeout so the ENGINE's verdict wins the
 * race: it knows whether the message is unavailable or the socket is sick, and
 * that distinction is what keeps good mail from being tagged `|nobody|`.
 */
export const BODY_FETCH_RUN_MS = 45_000;

/**
 * Fetch one body with a queue-aware deadline.
 *
 * Resolves to the parsed body, or `null` when the engine reached a verdict
 * (no such UID, unselectable folder, retries exhausted). Rejects with a
 * `TimeoutError` if the deadline passes, exactly like `withTimeout` did.
 */
export async function fetchBodyQueued(
  engine: QueuedBodyFetcher,
  emailId: string,
  folderPath: string,
  uid: number,
  overrides?: { queueMs?: number; runMs?: number },
): Promise<FetchedBody | null> {
  // The engine can dequeue SYNCHRONOUSLY inside fetchBody (an idle queue drains
  // immediately), i.e. before we've built the gate to hand the signal to. Latch
  // it and replay, or that fetch silently keeps the long queue-wait deadline.
  let gateStart: (() => void) | null = null;
  let startedEarly = false;
  const onStart = () => {
    if (gateStart) gateStart();
    else startedEarly = true;
  };

  const fetchPromise = engine.fetchBody(emailId, folderPath, uid, { onStart });
  const gated = withStartGatedTimeout<FetchedBody | null>(fetchPromise, {
    queueMs: overrides?.queueMs ?? BODY_FETCH_QUEUE_WAIT_MS,
    runMs: overrides?.runMs ?? BODY_FETCH_RUN_MS,
    message: 'Timeout',
  });
  gateStart = gated.start;
  if (startedEarly) gateStart();
  return gated.result;
}
