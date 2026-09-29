// @vitest-environment happy-dom
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IconButton } from '../../../../src/components/Tooltip';
import { act, render, toggle, type Mounted } from '../../../helpers/render';

/**
 * The shared icon-only button: a glyph, the shared Tooltip, and an accessible
 * name, from one string.
 *
 * What breaks if this file goes red: an icon-only control the reader cannot
 * identify — a screen reader announcing "button", or a tooltip that takes a
 * noticeable beat to say what the glyph means. Both are project rules (every
 * icon-only control carries a Tooltip at 40ms AND an aria-label), and this is
 * the component that exists so a caller cannot forget either.
 */
describe('IconButton', () => {
  let mounted: Mounted | undefined;
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  const glyph = <svg className="glyph" />;
  const mount = (props: Partial<Parameters<typeof IconButton>[0]> = {}) => {
    mounted = render(<IconButton tooltip="Reply" icon={glyph} {...props} />);
    return mounted;
  };

  /** Hover the button, then let `ms` of the tooltip's delay elapse. */
  const hoverFor = (view: Mounted, ms: number) => {
    act(() => {
      view.byLabel('Reply')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  // Regression: the button had no aria-label, so the glyph was its only name.
  it('is named by its tooltip text', () => {
    const view = mount();
    const button = view.byLabel('Reply')!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.querySelector('.glyph')).not.toBeNull();
  });

  // Regression: it used the Tooltip's 150ms default, which reads as lag on a
  // control whose meaning is only in its tooltip. 40ms is the project's value.
  it('shows its tooltip after 40ms by default, not before', () => {
    vi.useFakeTimers();
    const view = mount();
    hoverFor(view, 39);
    expect(document.body.textContent).not.toContain('Reply');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.body.textContent).toContain('Reply');
  });

  it('honours an explicit delay', () => {
    vi.useFakeTimers();
    const view = mount({ delayMs: 300 });
    hoverFor(view, 299);
    expect(document.body.textContent).not.toContain('Reply');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.body.textContent).toContain('Reply');
  });

  // Regression: onClick received no event, so a button sitting on a clickable
  // surface (a reply card that collapses, a chat bubble) could not keep the
  // click to itself.
  it('hands the click event over, so the caller can stop it', () => {
    const outer = vi.fn();
    mounted = render(
      <div onClick={outer}>
        <IconButton tooltip="Reply" icon={glyph} onClick={(event) => event.stopPropagation()} />
      </div>,
    );
    toggle(mounted.byLabel('Reply'));
    expect(outer).not.toHaveBeenCalled();
  });

  it('does not fire while disabled', () => {
    const onClick = vi.fn();
    const view = mount({ onClick, disabled: true });
    toggle(view.byLabel('Reply'));
    expect(onClick).not.toHaveBeenCalled();
  });

  const classesOf = (view: Mounted) => view.byLabel('Reply')!.className.split(/\s+/);

  // One padding per size: two in one class list would leave the result to
  // stylesheet order. 'xs' sits on content (a chat bubble's corner), 'sm' on a
  // header line (the List/Chat switch), 'md' in a toolbar.
  it.each([
    ['xs', 'p-1'],
    ['sm', 'p-1.5'],
    ['md', 'p-2'],
  ] as const)('uses only the %s padding (%s)', (size, padding) => {
    const classes = classesOf(mount({ size }));
    expect(classes.filter((c) => /^p-/.test(c))).toEqual([padding]);
  });

  it('defaults to the toolbar size', () => {
    expect(classesOf(mount()).filter((c) => /^p-/.test(c))).toEqual(['p-2']);
  });

  // 'bare' leaves the look to the caller. A ghost hover background beside the
  // caller's own (a selected segment's, a warning tint's) would leave which
  // one shows to stylesheet order.
  it('draws no background of its own when bare', () => {
    const classes = classesOf(mount({ variant: 'bare', className: 'hover:bg-orange-500/10' }));
    expect(classes).not.toContain('hover:bg-accent');
    expect(classes).toContain('hover:bg-orange-500/10');
  });

  it('draws the ghost hover by default', () => {
    expect(classesOf(mount())).toContain('hover:bg-accent');
  });

  // A switch segment keeps its name and reports its state; a plain action
  // carries no pressed state at all (aria-pressed="false" would announce every
  // action button as a toggle).
  it('reports a toggle state only when given one', () => {
    expect(mount({ pressed: true }).byLabel('Reply')!.getAttribute('aria-pressed')).toBe('true');
    mounted!.unmount();
    expect(mount({ pressed: false }).byLabel('Reply')!.getAttribute('aria-pressed')).toBe('false');
    mounted!.unmount();
    expect(mount().byLabel('Reply')!.hasAttribute('aria-pressed')).toBe(false);
  });

  // A button, never a submit: one inside a form must not send it.
  it('is a plain button, not a submit', () => {
    expect(mount().byLabel('Reply')!.getAttribute('type')).toBe('button');
  });

  // A menu trigger measures its button and returns focus to it; without the
  // element it had to be hand-built beside a Tooltip — the pairing this
  // component exists to replace.
  it('hands its button element to a ref', () => {
    const ref = createRef<HTMLButtonElement>();
    const view = mount({ ref });
    expect(ref.current).toBe(view.byLabel('Reply'));
  });

  // Regression guard for a trigger: it says what it opens and whether that is
  // open, and carries none of it when it opens nothing.
  it('describes the popup it opens, only when it opens one', () => {
    const button = mount({ 'aria-haspopup': 'menu', 'aria-expanded': true, 'aria-controls': 'm-1' })
      .byLabel('Reply')!;
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe('m-1');
    mounted!.unmount();

    const plain = mount().byLabel('Reply')!;
    expect(plain.hasAttribute('aria-haspopup')).toBe(false);
    expect(plain.hasAttribute('aria-expanded')).toBe(false);
    expect(plain.hasAttribute('aria-controls')).toBe(false);
  });

  // A tooltip over the menu its button opened would cover the menu; hidden,
  // the button is still named for a screen reader.
  it('hides its tooltip on request, keeping its name', () => {
    vi.useFakeTimers();
    const view = mount({ tooltipHidden: true });
    hoverFor(view, 100);
    expect(view.all('.fixed')).toEqual([]);
    expect(view.byLabel('Reply')).not.toBeNull();
  });
});
