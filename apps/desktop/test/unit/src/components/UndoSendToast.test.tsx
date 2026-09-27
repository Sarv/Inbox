// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render } from '../../../helpers/render';

// What breaks if this suite goes red: the Undo bar empties on its own clock.
// With a 30s window the bar hit zero after 5 seconds, so the button looked
// dead while the mail was still cancellable — the user re-sends, or gives up.

const undoSend = vi.fn();
let pendingSend: Record<string, unknown> | null = null;

vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ pendingSend, undoSend }),
}));

const { UndoSendToast } = await import('../../../../src/components/UndoSendToast');

/** Width of THIS toast's progress bar, as the number in `width: NN%`. Scoped to
 *  the container: `find` also searches the document, where a previous test's
 *  un-unmounted toast still sits at 100%. */
const progress = (view: ReturnType<typeof render>): number => {
  const bar = view.container.querySelector<HTMLElement>('.bg-primary');
  return Number.parseFloat((bar?.style.width ?? '').replace('%', ''));
};

const held = (undoDelayMs: number) => ({ undoDelayMs, sendId: 1, optimisticEmailId: 'x' });

beforeEach(() => {
  // `Date` explicitly: the toast measures elapsed time with Date.now(), so a
  // clock that does not move leaves the bar at 100% however far the timers run.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  pendingSend = null;
  undoSend.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('UndoSendToast', () => {
  it('renders nothing when no send is pending', () => {
    const view = render(<UndoSendToast />);
    expect(view.container.textContent).toBe('');
  });

  it('shows the undo affordance while a send is held', () => {
    pendingSend = held(5000);
    const view = render(<UndoSendToast />);
    expect(view.container.textContent).toContain('Undo');
  });

  // Regression: the bar is the only indication of how long is left. Counting
  // down 5s of a 30s window is a lie in the direction that loses the mail.
  it('counts down against the window this send was held for', () => {
    pendingSend = held(30000);
    const view = render(<UndoSendToast />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(progress(view)).toBeGreaterThan(80);
    expect(progress(view)).toBeLessThan(85);
  });

  it('empties exactly at the end of a short window', () => {
    pendingSend = held(5000);
    const view = render(<UndoSendToast />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(progress(view)).toBe(0);
  });

  it('calls undoSend when the button is clicked', () => {
    pendingSend = held(5000);
    const view = render(<UndoSendToast />);
    const button = view.container.querySelector('button')!;
    act(() => void button.click());
    expect(undoSend).toHaveBeenCalledTimes(1);
  });
});
