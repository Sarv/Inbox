import { describe, expect, it } from 'vitest';

import { createSignInTracker } from '../../../../src/utils/oauth-signin-tracker';

/**
 * The rule that lets the UI escape a sign-in the user abandoned. Each test
 * pins a way the button could get stuck, or un-stick itself wrongly.
 */
describe('sign-in tracker', () => {
  // The normal path: a flow that comes back is applied.
  it('treats the attempt it just started as current', () => {
    const tracker = createSignInTracker();
    expect(tracker.isCurrent(tracker.begin())).toBe(true);
  });

  // The bug this exists for: the user closed the OAuth tab, so the flow will
  // not settle for five minutes. Abandoning must free the UI immediately.
  it('stops caring about an attempt once abandoned', () => {
    const tracker = createSignInTracker();
    const attempt = tracker.begin();
    tracker.abandon();
    expect(tracker.isCurrent(attempt)).toBe(false);
  });

  // A five-minute-late FLOW_TIMEOUT from an abandoned attempt must not surface
  // as an error over whatever the user is doing by then.
  it('a late result from an abandoned attempt is never current again', () => {
    const tracker = createSignInTracker();
    const abandoned = tracker.begin();
    tracker.abandon();
    tracker.begin();
    expect(tracker.isCurrent(abandoned)).toBe(false);
  });

  // Clicking "Sign in" twice cancels the first flow in the main process. If the
  // first attempt still counted as current, its FLOW_CANCELLED rejection would
  // clear the spinner for the flow that IS running.
  it('a superseded attempt is not current, but the new one is', () => {
    const tracker = createSignInTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
  });

  // Abandoning when nothing is running must not make the next attempt stale.
  it('abandoning with nothing in flight leaves the next attempt usable', () => {
    const tracker = createSignInTracker();
    tracker.abandon();
    expect(tracker.isCurrent(tracker.begin())).toBe(true);
  });

  // Ids must never repeat, or an old result could be mistaken for a new one.
  it('never reissues an id', () => {
    const tracker = createSignInTracker();
    const ids = [tracker.begin(), tracker.begin()];
    tracker.abandon();
    ids.push(tracker.begin());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
