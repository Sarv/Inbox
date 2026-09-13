/**
 * Splitting a thread for the chat view BEFORE the reader asks for it.
 *
 * The chat view is mounted only while it is the view on screen, so the click
 * that switches to it pays for the whole thread at once: every body parsed,
 * swept for quote boundaries and cleaned, synchronously, inside one React
 * render. On a long thread that is a visible freeze — the same one the AI view
 * avoids by doing its work in the background while the reader is still reading.
 *
 * This does the deterministic half of that for the standard view: it walks the
 * open thread a few mails at a time during idle time and leaves the results in
 * the caches the chat view reads, so the toggle finds the work already done.
 * Nothing here changes what is rendered — every function is a pure warm of a
 * memo, and a thread that is never switched to simply loses some idle time.
 */
import type { EmailRecord } from '@sarvinbox/core';
import { useEffect } from 'react';

import { populateCacheFromHtml } from '../../services/image-cache';

import { bodyOf, isThreadSegmentWarm, warmThreadSegments } from './chat-message-adapter';

/**
 * How many mails one idle slice splits before handing the thread back.
 *
 * Small on purpose: a slice runs to completion once started, so the chunk size
 * is the longest the UI can be held. Three mails is comfortably inside a frame
 * even for the long, quote-heavy replies that are the reason this exists.
 */
export const PREWARM_CHUNK_SIZE = 3;

/**
 * Give up waiting for a genuinely idle moment after this long and run anyway.
 *
 * Without a timeout `requestIdleCallback` can be starved indefinitely on a busy
 * window, which is precisely the case — a big thread still streaming bodies —
 * where the warm is worth the most.
 */
const PREWARM_IDLE_TIMEOUT_MS = 500;

/**
 * The thread's not-yet-split mails, in the slices the idle loop will walk.
 *
 * Two filters, both load-bearing. A mail with no body is skipped because there
 * is nothing to split and its body arriving is what re-runs this. A mail
 * already in the cache is skipped because the walk restarts from the top every
 * time a body lands, and re-splitting the thread on each arrival is the cost
 * this is here to remove, not to move.
 */
export function prewarmChunks(
  emails: readonly EmailRecord[],
  isWarm: (email: EmailRecord) => boolean = isThreadSegmentWarm,
  chunkSize: number = PREWARM_CHUNK_SIZE,
): EmailRecord[][] {
  const pending = emails.filter((email) => bodyOf(email) !== '' && !isWarm(email));
  const chunks: EmailRecord[][] = [];
  for (let start = 0; start < pending.length; start += chunkSize) {
    chunks.push(pending.slice(start, start + chunkSize));
  }
  return chunks;
}

/** Undo a scheduled slice, whichever way it was scheduled. */
export type CancelIdle = () => void;

/** Run a slice later and hand back how to call it off. */
export type IdleScheduler = (slice: () => void) => CancelIdle;

/**
 * Run `slice` when the window is next idle.
 *
 * `requestIdleCallback` is Chromium-native, so it is always there in the
 * renderer; the timer fallback is for the test environment and for any host
 * without it, where running slightly early is much better than not at all.
 */
function onIdle(slice: () => void): CancelIdle {
  const request = typeof window !== 'undefined' ? window.requestIdleCallback : undefined;
  if (typeof request === 'function') {
    const handle = request.call(window, () => slice(), { timeout: PREWARM_IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(slice, 0);
  return () => clearTimeout(timer);
}

/**
 * Everything the chat view would do for these mails on the click that opens it.
 *
 * Both halves are memo writes, so running them early is invisible except in
 * how long the click takes: the split lands in the library's segment cache and
 * the body's inline images land in the ref cache the view resolves `sarv-image:`
 * through — and the effect that normally fills THAT one is itself gated on the
 * chat view being open, so it is the second thing the click pays for.
 */
export function warmChatChunk(chunk: readonly EmailRecord[], currentUserEmail: string): void {
  warmThreadSegments(chunk, { currentUserEmail });
  for (const email of chunk) populateCacheFromHtml(email.rawBody);
}

/**
 * Walk the slices, one idle moment at a time, until they run out or it is
 * called off.
 *
 * A slice runs to completion once started — cancelling stops the walk, never a
 * split that is already under way — so the returned canceller guarantees only
 * that no FURTHER mail is touched. That is the guarantee that matters: the
 * reader has moved to another thread and this one's remaining mails must not
 * quietly hold the main thread behind the new one.
 *
 * The scheduler is a parameter so the walk can be driven step by step in a
 * test; nothing in it depends on React.
 */
export function walkChunks(
  chunks: readonly (readonly EmailRecord[])[],
  warmChunk: (chunk: readonly EmailRecord[]) => void,
  schedule: IdleScheduler = onIdle,
): CancelIdle {
  let stopped = false;
  let cancel: CancelIdle | null = null;
  let index = 0;

  const slice = (): void => {
    // Cancelled between this slice being scheduled and it firing: the thread on
    // screen is no longer the one these mails belong to.
    if (stopped) return;
    const chunk = chunks[index];
    index += 1;
    warmChunk(chunk);
    cancel = index < chunks.length ? schedule(slice) : null;
  };

  cancel = schedule(slice);
  return () => {
    stopped = true;
    cancel?.();
  };
}

export interface ChatPrewarmOptions {
  /** The open thread's mails. */
  emails: readonly EmailRecord[];
  /** The reader's own address — the transform takes it, so the warm must too. */
  currentUserEmail: string;
  /**
   * False whenever there is nothing to get ahead of: the chat view is already
   * the one on screen and doing the work itself, or the thread is not one the
   * view is offered for at all. Warming every single message the reader opens
   * would churn a cache shared by every thread, for a view they never opened.
   */
  enabled: boolean;
}

/**
 * Keep the open thread's chat-view data warm while the reader is elsewhere.
 *
 * Restarts whenever the thread changes — including a body arriving, which is a
 * new array — and cancels on unmount, so a reader moving quickly through mail
 * never leaves a walk running over a thread that is no longer open.
 */
export function useChatPrewarm({ emails, currentUserEmail, enabled }: ChatPrewarmOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const chunks = prewarmChunks(emails);
    if (chunks.length === 0) return;
    return walkChunks(chunks, (chunk) => warmChatChunk(chunk, currentUserEmail));
  }, [emails, currentUserEmail, enabled]);
}
