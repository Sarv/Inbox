/**
 * Which interactive sign-in attempt is the one we still care about.
 *
 * An OAuth flow settles when the browser redirects back, when it is cancelled,
 * or after the main process's five-minute timeout — and NOT when the user
 * closes the tab, which the app cannot observe at all. So a "signing in…" state
 * driven purely by awaiting the flow can sit there, disabled, for five minutes
 * with no way out.
 *
 * The fix is to let the UI abandon an attempt without waiting for it, which
 * needs one rule: a result must be ignored if it belongs to an attempt that has
 * since been abandoned or superseded. Kept here as a plain closure rather than
 * inside the hook so that rule is unit-testable without a DOM.
 */
export interface SignInTracker {
  /** Start an attempt and get its id. Supersedes any earlier attempt. */
  begin: () => number;
  /** Is this attempt still the one whose result should be applied? */
  isCurrent: (id: number) => boolean;
  /** Stop caring about whatever is in flight (user cancelled / gave up). */
  abandon: () => void;
}

export function createSignInTracker(): SignInTracker {
  let current = 0;
  return {
    begin: () => (current += 1),
    // A late result from an abandoned attempt must not flip the UI back to
    // "signing in", nor report an error the user already resolved by retrying.
    isCurrent: (id) => id === current,
    // Advancing past every live id is what makes the abandonment stick without
    // needing the in-flight promise to settle.
    abandon: () => { current += 1; },
  };
}
