// @vitest-environment happy-dom
import { StrictMode, useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMountedTimeout, type MountedTimeout } from '../../../../src/hooks/useMountedTimeout';
import { cleanup, render } from '../../../helpers/render';

/**
 * What breaks if this file goes red: a delayed scroll or focus runs against a
 * pane that has closed — and, at the end of a test file, against a document
 * that is gone, failing a whole CI run whose assertions all passed — or, in
 * the other direction, the scroll a reader relies on when a thread opens is
 * silently dropped in development.
 */

/** Exposes the hook's function from the latest render. */
let later: MountedTimeout;
function Probe() {
  later = useMountedTimeout();
  return null;
}

/** Schedules once per mount from a ref-guarded effect, as the reading pane's auto-expand does. */
function OncePerMount({ fn }: { fn: () => void }) {
  const schedule = useMountedTimeout();
  const scheduled = useRef(false);
  useEffect(() => {
    if (scheduled.current) return;
    scheduled.current = true;
    schedule(fn, 100);
  }, [schedule, fn]);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useMountedTimeout', () => {
  // The delay itself: the card or composer it waits for has not rendered yet.
  it('runs the callback once the delay has passed, not before', () => {
    render(<Probe />);
    const fn = vi.fn();
    later(fn, 100);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  // THE regression: the timer outlived its component (main's CI, PR #54).
  it('drops a pending callback when the component unmounts first', () => {
    const mounted = render(<Probe />);
    const fn = vi.fn();
    later(fn, 100);
    mounted.unmount();
    vi.advanceTimersByTime(1_000);
    expect(fn).not.toHaveBeenCalled();
  });

  // A late caller (an IPC answer landing after the pane closed) must not reach
  // the DOM either.
  it('never runs a callback scheduled after the component unmounted', () => {
    const mounted = render(<Probe />);
    const stale = later;
    mounted.unmount();
    const fn = vi.fn();
    stale(fn, 0);
    vi.advanceTimersByTime(1_000);
    expect(fn).not.toHaveBeenCalled();
  });

  // StrictMode's dev-only unmount-and-remount must not cancel the scroll that a
  // run-once effect scheduled: that effect never schedules it again, so a
  // clear-on-unmount timer would drop it in every dev session.
  it('keeps a callback scheduled before StrictMode\'s remount', () => {
    const fn = vi.fn();
    render(
      <StrictMode>
        <OncePerMount fn={fn} />
      </StrictMode>,
    );
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
  });

  // Stable identity is what lets effects list it as a dependency without
  // re-running on every render.
  it('returns the same function on every render', () => {
    const mounted = render(<Probe />);
    const first = later;
    mounted.rerender(<Probe />);
    expect(later).toBe(first);
  });
});
