import { describe, expect, it } from 'vitest';

import {
  AUTO_SELECT_FAMILY_ATTEMPT_MS,
  raiseAutoSelectFamilyAttemptTimeout,
  type AutoSelectFamilyControls,
} from '../../../src/utils/connect-timeout';

/**
 * The per-address connect window.
 *
 * What breaks if this regresses: every connection to a host that publishes both
 * an A and an AAAA record — Google's OAuth endpoint, most large mail hosts —
 * fails as `ETIMEDOUT` in under a second on a v4-only network whose handshake
 * takes longer than Node's 250ms default. It looks like the server is down, and
 * it stays broken for hours: the observed symptom was a Gmail account unable to
 * refresh its token while mail from a v4-only host kept arriving.
 */
const controlsAt = (initial: number): AutoSelectFamilyControls & { value: number } => {
  const state = {
    value: initial,
    get: () => state.value,
    set: (ms: number) => { state.value = ms; },
  };
  return state;
};

describe('raiseAutoSelectFamilyAttemptTimeout', () => {
  it('raises Node\'s 250ms default to the window a real handshake needs', () => {
    const controls = controlsAt(250);

    const outcome = raiseAutoSelectFamilyAttemptTimeout(controls);

    expect(outcome).toEqual({ changed: true, from: 250, to: AUTO_SELECT_FAMILY_ATTEMPT_MS });
    expect(controls.value).toBe(AUTO_SELECT_FAMILY_ATTEMPT_MS);
  });

  // Measured: a ~300ms handshake is abandoned at 250ms, and the same request
  // succeeds at 2000ms. A window that no longer clears an ordinary handshake
  // puts the ETIMEDOUT back, so the constant itself is asserted.
  it('allows at least a full second per address', () => {
    expect(AUTO_SELECT_FAMILY_ATTEMPT_MS).toBeGreaterThanOrEqual(1000);
  });

  // An operator who passed --network-family-autoselection-attempt-timeout, or a
  // runtime with a larger default, knows something we do not. Lowering it back
  // is how the failure returns on exactly the slow links it was raised for.
  it('never lowers a window that is already longer', () => {
    const controls = controlsAt(5000);

    const outcome = raiseAutoSelectFamilyAttemptTimeout(controls);

    expect(outcome).toEqual({ changed: false, from: 5000, to: 5000 });
    expect(controls.value).toBe(5000);
  });

  // Equal is not "changed": re-running the bootstrap (a main-process restart in
  // dev) must not log a raise that did not happen.
  it('reports no change when the window is already exactly right', () => {
    const controls = controlsAt(AUTO_SELECT_FAMILY_ATTEMPT_MS);

    expect(raiseAutoSelectFamilyAttemptTimeout(controls).changed).toBe(false);
  });

  it('honours an explicit window', () => {
    const controls = controlsAt(250);

    expect(raiseAutoSelectFamilyAttemptTimeout(controls, 750)).toEqual({ changed: true, from: 250, to: 750 });
    expect(controls.value).toBe(750);
  });
});
