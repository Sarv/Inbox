// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render } from '../../../helpers/render';

const { UndoToastCard, useCountdownProgress } = await import('../../../../src/components/UndoToastCard');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => vi.useRealTimers());

const barWidth = (view: ReturnType<typeof render>): number => {
  const bar = view.container.querySelector<HTMLElement>('.bg-primary');
  return Number.parseFloat((bar?.style.width ?? '').replace('%', ''));
};

describe('UndoToastCard', () => {
  // Regression: the toast used bg-foreground/text-background, an inverted
  // palette that painted a white slab over the dark theme. It must sit on the
  // theme's card surface so it follows light/dark like every other popover.
  it('renders on the theme card surface, not an inverted one', () => {
    const view = render(<UndoToastCard message="Email deleted" progress={50} onUndo={() => {}} />);
    const card = view.container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('text-card-foreground');
    expect(view.container.innerHTML).not.toMatch(/bg-foreground|text-background|bg-background\//);
  });

  // Regression: the message and the progress are what the user reads; losing
  // either leaves a toast that doesn't say what it will undo or for how long.
  it('shows the message and sizes the bar from progress', () => {
    const view = render(<UndoToastCard message="Sending email..." progress={42} onUndo={() => {}} />);
    expect(view.container.textContent).toContain('Sending email...');
    expect(barWidth(view)).toBe(42);
  });

  // Regression: a dead Undo button means the send/delete can't be cancelled.
  it('calls onUndo when the button is clicked', () => {
    const onUndo = vi.fn();
    const view = render(<UndoToastCard message="x" progress={100} onUndo={onUndo} />);
    act(() => void view.container.querySelector('button')!.click());
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

function Probe({ durationMs, resetKey }: { durationMs: number; resetKey: unknown }) {
  const progress = useCountdownProgress(durationMs, resetKey);
  return <span data-progress={progress} />;
}

const probeValue = (view: ReturnType<typeof render>): number =>
  Number(view.container.querySelector('span')!.getAttribute('data-progress'));

describe('useCountdownProgress', () => {
  // Regression: with nothing pending the bar must not tick down in the
  // background, or the next toast would open already partly empty.
  it('stays full when there is no reset key', () => {
    const view = render(<Probe durationMs={5000} resetKey={null} />);
    act(() => void vi.advanceTimersByTime(3000));
    expect(probeValue(view)).toBe(100);
  });

  // Regression: the bar is the only cue for how long undo stays available.
  it('counts down to zero over the duration', () => {
    const view = render(<Probe durationMs={4000} resetKey="a" />);
    act(() => void vi.advanceTimersByTime(2000));
    expect(probeValue(view)).toBeGreaterThan(45);
    expect(probeValue(view)).toBeLessThan(55);
    act(() => void vi.advanceTimersByTime(2000));
    expect(probeValue(view)).toBe(0);
  });

  // Regression: a new pending item must restart the countdown from full,
  // not inherit the previous item's elapsed time.
  it('restarts from full when the reset key changes', () => {
    const view = render(<Probe durationMs={4000} resetKey="a" />);
    act(() => void vi.advanceTimersByTime(3000));
    view.rerender(<Probe durationMs={4000} resetKey="b" />);
    expect(probeValue(view)).toBe(100);
  });
});
