import { describe, it, expect } from 'vitest';

import {
  BODY_FETCH_DEFERRED,
  createDeferredFetchError,
  isDeferredFetchError,
} from '../../../src/utils/deferred-fetch-error';

// The whole point of this signal is to keep "we never got an answer" out of the
// "the server has no such message" bucket. If these break, a transient IMAP
// condition starts retiring live mail as permanently body-less again.
describe('deferred-fetch-error', () => {
  it('tags the error with the deferred code so callers can branch on it', () => {
    // Breaks if the code is renamed on one side only — the recogniser would then
    // silently classify every defer as a verdict.
    const err = createDeferredFetchError('folder "INBOX" would not open');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(BODY_FETCH_DEFERRED);
    expect(isDeferredFetchError(err)).toBe(true);
  });

  it('carries the reason in the message for the log, after a fixed prefix', () => {
    // The prefix is what the renderer matches on to keep the email retryable.
    const err = createDeferredFetchError('3 consecutive timeouts');
    expect(err.message.toLowerCase()).toContain('body fetch deferred');
    expect(err.message).toContain('3 consecutive timeouts');
  });

  it('never contains a word the renderer reads as "gone from the server"', () => {
    // The renderer's `looksGoneFromServer` scans error text for these; a defer
    // that tripped it would ask the folder sync to reconcile a live message as
    // deleted. Guarded here because the wording is easy to "improve" later.
    const message = createDeferredFetchError('folder "INBOX" would not open').message.toLowerCase();
    for (const word of ['not found', 'deleted', 'moved', 'no such message', 'invalid uid']) {
      expect(message).not.toContain(word);
    }
  });

  it('does not mistake an ordinary error, null or undefined for a defer', () => {
    // A verdict/permanent failure must keep accruing strikes — treating
    // everything as deferred would mean dead rows are retried forever.
    expect(isDeferredFetchError(new Error('Body fetch timeout'))).toBe(false);
    expect(isDeferredFetchError({ code: 'AUTH_PAUSED' })).toBe(false);
    expect(isDeferredFetchError(null)).toBe(false);
    expect(isDeferredFetchError(undefined)).toBe(false);
    expect(isDeferredFetchError('BODY_FETCH_DEFERRED')).toBe(false);
  });
});
