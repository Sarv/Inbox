// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ViewModeToggle } from '../../../../../src/components/email-detail/ViewModeToggle';
import { act, render, toggle, type Mounted } from '../../../../helpers/render';

/**
 * The List / Chat switch above a conversation.
 *
 * What breaks if this file goes red: two icon-only buttons the reader cannot
 * name — they used a native `title`, which waits about half a second and gives
 * a screen reader nothing — or a switch that no longer says which view is on,
 * or flips the wrong way. (Its wiring into the reading pane is covered in
 * EmailDetail.composers.test.tsx.)
 */
describe('ViewModeToggle', () => {
  let mounted: Mounted | undefined;
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  // Regression: `title` only — no accessible name, no shared Tooltip.
  it('names both buttons and drops the native title', () => {
    mounted = render(<ViewModeToggle chatViewEnabled={false} onToggle={vi.fn()} />);
    for (const name of ['List view', 'Chat view']) {
      const button = mounted.byLabel(name)!;
      expect(button.tagName).toBe('BUTTON');
      expect(button.hasAttribute('title')).toBe(false);
    }
  });

  // The project rule for icon-only controls: the shared Tooltip, at 40ms —
  // not sooner (a flicker on every pass of the pointer) and not later.
  it('names each mode in a 40ms tooltip', () => {
    vi.useFakeTimers();
    mounted = render(<ViewModeToggle chatViewEnabled={false} onToggle={vi.fn()} />);
    const tipShown = () => mounted!.all('.fixed').some((el) => el.textContent === 'Chat view');
    act(() => {
      mounted!.byLabel('Chat view')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(39);
    });
    expect(tipShown()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tipShown()).toBe(true);
  });

  // The selected segment's own background is its state; a ghost hover
  // background on top would repaint it on hover (left to stylesheet order).
  it('draws the selected segment without a competing hover background', () => {
    mounted = render(<ViewModeToggle chatViewEnabled onToggle={vi.fn()} />);
    const classes = mounted.byLabel('Chat view')!.className.split(/\s+/);
    expect(classes).toContain('bg-background');
    expect(classes).not.toContain('hover:bg-accent');
  });

  // Which one is on, for a reader who cannot see the highlighted pill.
  it('marks the selected mode as pressed', () => {
    mounted = render(<ViewModeToggle chatViewEnabled onToggle={vi.fn()} />);
    expect(mounted.byLabel('Chat view')!.getAttribute('aria-pressed')).toBe('true');
    expect(mounted.byLabel('List view')!.getAttribute('aria-pressed')).toBe('false');
  });

  // Each button asks for its own mode.
  it('switches to the mode clicked', () => {
    const onToggle = vi.fn();
    mounted = render(<ViewModeToggle chatViewEnabled={false} onToggle={onToggle} />);
    toggle(mounted.byLabel('Chat view'));
    toggle(mounted.byLabel('List view'));
    expect(onToggle.mock.calls).toEqual([[true], [false]]);
  });
});
