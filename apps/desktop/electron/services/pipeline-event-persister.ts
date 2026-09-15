/**
 * Pipeline Event Persister
 *
 * Subscribes to the EventBus and persists events to the agent's pipeline_event_log table.
 * Uses a write buffer to batch inserts for performance.
 */

import { getEventBus, createLogger } from '@sarvinbox/core';
import type { PipelineEvent } from '@sarvinbox/core';

import { getStorage } from '../shared';
const logger = createLogger('pipeline-event-persister');

let unsubscribe: (() => void) | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
const buffer: Array<{
  id: string;
  eventType: string;
  emailId: string | null;
  threadId: string | null;
  data: string | null;
  timestamp: number;
  createdAt: number;
}> = [];

const MAX_BUFFER_SIZE = 50;
const FLUSH_INTERVAL_MS = 10_000; // 10 seconds
// Hard cap while storage is unavailable (early startup / shutdown) or
// writes keep failing — drop oldest instead of growing without bound.
const MAX_PENDING_BUFFER = 1000;

let flushing = false;
// The write currently in flight, so a caller (the shutdown path) can AWAIT it.
let inFlight: Promise<void> | null = null;

function capBuffer(): void {
  if (buffer.length > MAX_PENDING_BUFFER) {
    buffer.splice(0, buffer.length - MAX_PENDING_BUFFER);
  }
}

function generateId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function extractEmailId(event: PipelineEvent): string | null {
  return (event as any).emailId || (event as any).email?.id || null;
}

function extractThreadId(event: PipelineEvent): string | null {
  return (event as any).threadId || (event as any).email?.threadId || null;
}

function serializeEventData(event: PipelineEvent): string | null {
  try {
    // Strip non-serializable fields (Error objects, large content). `type` and
    // `timestamp` are destructured only to drop them from `rest` — they are
    // stored in their own columns — hence the underscore names, which is how
    // no-unused-vars is told a binding exists to be discarded.
    const { type: _type, timestamp: _timestamp, ...rest } = event as any;
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(rest)) {
      if (value instanceof Error) {
        sanitized[key] = { message: value.message, name: value.name };
      } else if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = value.substring(0, 500) + '...';
      } else if (typeof value !== 'function') {
        sanitized[key] = value;
      }
    }

    const json = JSON.stringify(sanitized);
    return json.length > 2 ? json : null; // Skip empty objects
  } catch {
    return null;
  }
}

function handleEvent(event: PipelineEvent): void {
  const now = Math.floor(Date.now() / 1000);
  buffer.push({
    id: generateId(),
    eventType: event.type,
    emailId: extractEmailId(event),
    threadId: extractThreadId(event),
    data: serializeEventData(event),
    timestamp: (event as any).timestamp ? Math.floor((event as any).timestamp / 1000) : now,
    createdAt: now,
  });

  capBuffer();

  if (buffer.length >= MAX_BUFFER_SIZE) {
    flush();
  }
}

/**
 * Write the buffered events. Returns a promise that settles when THIS flush's
 * write has finished (already-resolved when there was nothing to do), so the
 * shutdown path can await the last batch instead of racing the process exit.
 * Never rejects — failures are logged and the batch is kept for a retry.
 */
function flush(): Promise<void> {
  if (buffer.length === 0) return Promise.resolve();
  if (flushing) return inFlight ?? Promise.resolve(); // one write in flight at a time

  try {
    const storage = getStorage();
    if (!storage) { capBuffer(); return Promise.resolve(); }

    const repos = (storage as any).getRepositories();
    const agentRepo = repos?.agent;
    if (!agentRepo) { capBuffer(); return Promise.resolve(); }

    // Snapshot without draining — events are only removed after the write
    // succeeds, so a failed write retries on the next flush instead of
    // silently losing the batch. New events pushed mid-write stay behind
    // the snapshot and are untouched by the splice below.
    const events = buffer.slice(0);
    flushing = true;
    inFlight = Promise.resolve(agentRepo.logPipelineEventBatch(events))
      .then(() => {
        buffer.splice(0, events.length);
      })
      .catch((err: any) => {
        logger.error('[PipelineEventPersister] Failed to flush events (kept for retry):', err);
        capBuffer(); // bounded retention on repeated failures
      })
      .finally(() => {
        flushing = false;
        inFlight = null;
      });
    return inFlight;
  } catch (error) {
    flushing = false;
    inFlight = null;
    logger.error('[PipelineEventPersister] Flush error:', error);
    return Promise.resolve();
  }
}

/**
 * Start persisting pipeline events to the database
 */
export function startPipelineEventPersister(): void {
  if (unsubscribe) return; // Already running

  const eventBus = getEventBus();
  unsubscribe = eventBus.onAll(handleEvent);

  // Periodic flush
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  logger.info('[PipelineEventPersister] Started');
}

/**
 * Stop persisting and flush remaining events.
 *
 * AWAIT this on the shutdown path: the final flush is a DB write, and a
 * fire-and-forget call would let the process exit with the last batch still in
 * the buffer (silently losing it — there is no next tick to retry on).
 */
export function stopPipelineEventPersister(): Promise<void> {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Final flush. When a write is already in flight, wait it out first — the
  // buffer only drains once that write succeeds, so flushing before it settles
  // would either no-op or double-write the same events.
  const finalFlush = flushing && inFlight ? inFlight.then(() => flush()) : flush();

  return finalFlush
    .catch((err: unknown) => {
      logger.error('[PipelineEventPersister] Final flush failed:', err);
    })
    .then(() => {
      logger.info('[PipelineEventPersister] Stopped');
    });
}

/**
 * Clean up old events (older than N days)
 */
export async function cleanupOldPipelineEvents(days: number = 90): Promise<number> {
  try {
    const storage = getStorage();
    if (!storage) return 0;

    const repos = (storage as any).getRepositories();
    const agentRepo = repos?.agent;
    if (!agentRepo) return 0;

    const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
    const deleted = await agentRepo.cleanupOldEvents(cutoff);
    logger.info(`[PipelineEventPersister] Cleaned up ${deleted} old events`);
    return deleted;
  } catch (error) {
    logger.error('[PipelineEventPersister] Cleanup error:', error);
    return 0;
  }
}
