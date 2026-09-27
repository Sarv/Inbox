// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ButtonLabelMode } from '../../../../../src/appearance';
import { resetAppearance, setAppearance } from '../../../../../src/appearance/appearance-store';
import { ToolbarButton } from '../../../../../src/components/email-detail/ToolbarButton';
import { act, render, toggle, type Mounted } from '../../../../helpers/render';

/**
 * One action in the message toolbar.
 *
 * What breaks if this suite goes red: an action the reader cannot identify —
 * a button with no glyph and no name, or one that loses its accessible name
 * the moment the label is hidden, leaving a screen reader with "button".
 */
describe('ToolbarButton', () => {
  let mounted: Mounted | undefined;
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    // The appearance store is module-scoped: a mode set here would leak on.
    resetAppearance();
  });

  const glyph = <svg className="glyph" />;

  const mount = (mode: ButtonLabelMode, props: Partial<Parameters<typeof ToolbarButton>[0]> = {}) => {
    setAppearance({ buttonLabels: mode });
    mounted = render(<ToolbarButton name="Archive" icon={glyph} onClick={() => {}} {...props} />);
    return mounted;
  };

  it('draws the glyph alone in icon mode', () => {
    const view = mount('icons');

    expect(view.find('.glyph')).not.toBeNull();
    expect(view.byLabel('Archive')?.textContent).toBe('');
  });

  it('draws the name alone in text mode', () => {
    const view = mount('text');

    expect(view.find('.glyph')).toBeNull();
    expect(view.byLabel('Archive')?.textContent).toBe('Archive');
  });

  it('draws both when the reader asks for both', () => {
    const view = mount('both');

    expect(view.find('.glyph')).not.toBeNull();
    expect(view.byLabel('Archive')?.textContent).toBe('Archive');
  });

  // THE REGRESSION: the visible label is a preference, the accessible name is
  // not. Hiding one must never take the other with it.
  it('keeps the accessible name in every mode', () => {
    for (const mode of ['icons', 'text', 'both'] as const) {
      const view = mount(mode);
      expect(view.byLabel('Archive')).not.toBeNull();
      view.unmount();
    }
  });

  // Regression: 'icons' is the default, and Reply has always been labelled.
  it('keeps a primary action labelled even in icon mode', () => {
    const view = mount('icons', { name: 'Reply', alwaysLabel: true });

    expect(view.byLabel('Reply')?.textContent).toBe('Reply');
    expect(view.find('.glyph')).not.toBeNull();
  });

  it('calls back on click, and not while disabled', () => {
    const onClick = vi.fn();
    const view = mount('icons', { onClick });
    toggle(view.byLabel('Archive'));
    expect(onClick).toHaveBeenCalledTimes(1);

    view.unmount();
    const disabled = mount('icons', { onClick, disabled: true });
    toggle(disabled.byLabel('Archive'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Regression: the snooze popover is positioned against this wrapper. Render
  // it outside one and it lands in the top-left corner of the window.
  it('anchors a dropdown in a positioned wrapper beside the button', () => {
    const view = mount('icons', { dropdown: <div className="popover" /> });

    const popover = view.find('.popover');
    expect(popover?.parentElement?.className).toContain('relative');
    expect(popover?.parentElement?.querySelector('button')).not.toBeNull();
  });

  describe('the hover hint', () => {
    // React synthesizes mouseenter from a delegated `mouseover`, and the hint
    // is on a delay — so both the pointer and the clock need flushing.
    const hover = (view: Mounted, label: string) => {
      vi.useFakeTimers();
      act(() => {
        view.byLabel(label)?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      vi.useRealTimers();
    };

    // Every icon-only control needs a tooltip; the name is the default text so
    // an action cannot ship without one.
    it('names the action by default', () => {
      const view = mount('icons');
      hover(view, 'Archive');
      expect(document.body.textContent).toContain('Archive');
    });

    // Regression: the hint may say MORE than the button does ("Back" /
    // "Back to list"), so an explicit tooltip must win over the name.
    it('prefers an explicit tooltip over the name', () => {
      const view = mount('icons', { name: 'Back', tooltip: 'Back to list' });
      hover(view, 'Back');
      expect(document.body.textContent).toContain('Back to list');
    });

    // Suppressed while this button's own dropdown is open, or the hint covers
    // the popover it just opened.
    it('stays away when suppressed', () => {
      const view = mount('icons', { tooltipHidden: true });
      hover(view, 'Archive');
      expect(document.body.textContent).not.toContain('Archive');
    });
  });
});
