// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNow } from '../../../../src/hooks/useNow';
import { act, cleanup, render } from '../../../helpers/render';

function Clock({ intervalMs }: { intervalMs: number }) {
  return <span>{useNow(intervalMs).toISOString()}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T09:00:00.000Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useNow', () => {
  // Regression: "today" and the now-line would freeze at mount time if the
  // hook stopped re-reading the clock.
  it('re-reads the clock every interval', () => {
    const mounted = render(<Clock intervalMs={60_000} />);
    expect(mounted.container.textContent).toBe('2026-10-15T09:00:00.000Z');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(mounted.container.textContent).toBe('2026-10-15T09:01:00.000Z');
  });

  // Regression: a timer left running after unmount leaks and sets state on a
  // dead component.
  it('stops its timer on unmount', () => {
    const mounted = render(<Clock intervalMs={1_000} />);
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
