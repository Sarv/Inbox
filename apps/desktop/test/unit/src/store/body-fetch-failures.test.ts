import { describe, expect, it } from 'vitest';

import {
  MAX_FAILED_BODIES,
  isRetryableBodyFetchError,
  looksGoneFromServer,
  withFailedBody,
} from '../../../../src/store/body-fetch-failures';

// `failedBodies` is a permanent-for-the-session skip list: every later fetch
// attempt for an id in it is dropped. So a retryable error landing in there is
// exactly the "Unable to load email content" that only an app restart clears.
describe('isRetryableBodyFetchError', () => {
  it('treats the engine’s deferred signal as retryable', () => {
    // Breaks if the wording of createDeferredFetchError changes without this
    // matcher: a folder that would not open, or an email cooling down after
    // timeouts, would be parked instead of retried.
    expect(isRetryableBodyFetchError('Body fetch deferred (3 consecutive timeouts) — will retry')).toBe(true);
    expect(isRetryableBodyFetchError('Body fetch deferred (folder "INBOX" would not open) — will retry')).toBe(true);
  });

  it('treats a shed queue as retryable', () => {
    expect(isRetryableBodyFetchError('Queue full')).toBe(true);
  });

  it('does NOT treat a real failure as retryable', () => {
    // The skip list still has a job: an endless retry loop on a genuinely dead
    // row is what it was introduced to stop.
    expect(isRetryableBodyFetchError('No message found for UID 42')).toBe(false);
    expect(isRetryableBodyFetchError('IMAP authentication failed')).toBe(false);
    expect(isRetryableBodyFetchError(undefined)).toBe(false);
    expect(isRetryableBodyFetchError('')).toBe(false);
  });
});

describe('looksGoneFromServer', () => {
  it('recognises the wordings that ask for a reconcile', () => {
    for (const text of ['Not Found', 'message deleted', 'MOVED to Archive', 'no such message', 'Invalid UID']) {
      expect(looksGoneFromServer(text)).toBe(true);
    }
  });

  it('never fires on a deferred fetch', () => {
    // A defer that read as "gone" would hand a live message to the deletion
    // reconcile. The two classifications must not overlap.
    const deferred = 'Body fetch deferred (folder "INBOX" would not open) — will retry';
    expect(looksGoneFromServer(deferred)).toBe(false);
    expect(isRetryableBodyFetchError(deferred)).toBe(true);
  });

  it('is false for an unrelated error and for no message at all', () => {
    expect(looksGoneFromServer('Body fetch timeout')).toBe(false);
    expect(looksGoneFromServer(undefined)).toBe(false);
  });
});

describe('withFailedBody', () => {
  it('returns a NEW set containing the id (zustand needs a fresh reference)', () => {
    // Mutating in place would leave the UI showing a stale spinner/error state.
    const before = new Set(['a']);
    const after = withFailedBody(before, 'b');
    expect(after).not.toBe(before);
    expect(before.has('b')).toBe(false);
    expect([...after]).toEqual(['a', 'b']);
  });

  it('drops the older half once the cap is reached, keeping the newest', () => {
    // Unbounded growth on a long session is a leak; evicting the OLDEST half is
    // also what lets a long-ago failure be retried again.
    const full = new Set(Array.from({ length: MAX_FAILED_BODIES }, (_, i) => `e${i}`));
    const after = withFailedBody(full, 'fresh');
    expect(after.size).toBe(MAX_FAILED_BODIES / 2 + 1);
    expect(after.has('fresh')).toBe(true);
    expect(after.has('e0')).toBe(false);                              // oldest evicted
    expect(after.has(`e${MAX_FAILED_BODIES - 1}`)).toBe(true);        // newest kept
  });

  it('is idempotent for an id already remembered', () => {
    const after = withFailedBody(new Set(['a']), 'a');
    expect([...after]).toEqual(['a']);
  });
});
