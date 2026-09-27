// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { getAppearance, resetAppearance, setAppearance } from '../../../../../src/appearance/appearance-store';
import { AppearanceTab } from '../../../../../src/components/settings/AppearanceTab';
import { act, render, toggle, typeInto, type Mounted } from '../../../../helpers/render';

/**
 * Settings → Appearance.
 *
 * The preview is the whole reason this tab can be used without saving and
 * navigating away to look: it must render BESIDE the controls and stay put
 * while they scroll. If it slides back under them, changing density means
 * scrolling to the bottom after every click to see what it did.
 */
describe('AppearanceTab', () => {
  let mounted: Mounted | undefined;
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    // The appearance store is module-scoped and persists across tests; a
    // left-over toggle would leak into every test that renders after it.
    resetAppearance();
  });

  const mount = () => { mounted = render(<AppearanceTab />); return mounted; };

  it('renders the live preview in its own column, not at the end of the controls', () => {
    const view = mount();

    const aside = view.container.querySelector('aside[aria-label="Appearance preview"]');
    expect(aside).not.toBeNull();
    // The preview miniature itself, built from the real list classes.
    expect(aside?.querySelector('.list-row')).not.toBeNull();
    // Sibling of the controls column, so the grid can place them side by side.
    expect(aside?.parentElement?.className).toContain('xl:grid-cols-');
  });

  // Sticky is what keeps it on screen while the controls scroll — without it the
  // side column is no better than the old bottom-of-page placement on a long tab.
  it('keeps the preview column sticky', () => {
    const view = mount();

    expect(view.container.querySelector('aside[aria-label="Appearance preview"]')?.className)
      .toContain('xl:sticky');
  });

  // Reset lives with the controls, not in the preview: it is an action on the
  // settings, and it must survive the move into two columns.
  it('keeps "Reset to defaults" in the controls column', () => {
    const view = mount();

    const reset = [...view.container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Reset to defaults'));
    expect(reset).toBeDefined();
    expect(reset?.closest('aside')).toBeNull();
  });

  describe('the dark email bodies switch', () => {
    // Regression: THE promise of this setting — it is opt-in. Ship it on and
    // every existing reader's mail is re-coloured without them asking.
    it('is off until the reader turns it on', () => {
      const view = mount();

      expect(view.byLabel('Dark email bodies')?.getAttribute('aria-checked')).toBe('false');
      expect(getAppearance().darkenEmails).toBe(false);
    });

    // Regression: the switch writes to the appearance store, which is what the
    // reading pane reads. Wire it anywhere else and the toggle moves but the
    // mail does not.
    it('writes the reader choice straight into the appearance store', () => {
      const view = mount();

      toggle(view.byLabel('Dark email bodies'));

      expect(getAppearance().darkenEmails).toBe(true);
      expect(view.byLabel('Dark email bodies')?.getAttribute('aria-checked')).toBe('true');
    });

    // Regression: the caveat is the honest part — this rewrites someone else's
    // markup and cannot be perfect. It must appear with the setting, not sit
    // there confusing readers who never turned it on.
    it('explains the limits only once it is on', () => {
      const view = mount();
      const caveat = () => view.container.textContent?.includes('best effort on their');

      expect(caveat()).toBe(false);
      toggle(view.byLabel('Dark email bodies'));
      expect(caveat()).toBe(true);
    });
  });
  /** The card labelled `option` inside the group labelled `group`. */
  const card = (view: Mounted, group: string, option: string) =>
    [...(view.container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.startsWith(option)) ?? null;

  /** Pick a value in a <select>, the way a change event reaches React. */
  const choose = (element: HTMLElement | null, value: string) => {
    if (!(element instanceof HTMLSelectElement)) throw new Error('no such select');
    act(() => {
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  const preview = (view: Mounted) => view.container.querySelector('aside[aria-label="Appearance preview"]');

  describe('message text size', () => {
    // THE REGRESSION: this is the whole point of the setting — body text that
    // scales WITHOUT dragging the list, sidebar and toolbar along with it.
    it('scales the message body and leaves the interface alone', () => {
      const view = mount();

      toggle(view.byLabel('Increase message text size'));

      expect(getAppearance().readingSize).toBe(105);
      expect(getAppearance().zoom).toBe(100);
    });

    // Regression: two steppers on one screen, each bound to its own field.
    // Cross them and zooming the app resizes the message instead.
    it('keeps the interface zoom on its own control', () => {
      const view = mount();

      toggle(view.byLabel('Decrease interface zoom'));

      expect(getAppearance().zoom).toBe(90);
      expect(getAppearance().readingSize).toBe(100);
    });

    it('takes a value dragged on the slider', () => {
      const view = mount();

      typeInto(view.byLabel('Message text size'), '130');

      expect(getAppearance().readingSize).toBe(130);
    });

    // Regression: Reset is the way back for someone who dragged the slider
    // somewhere unreadable. It appears only off the default, so it cannot be
    // mistaken for part of the control.
    it('offers Reset only once the size is off its default', () => {
      const view = mount();
      const reset = () =>
        [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Reset') ?? null;
      expect(reset()).toBeNull();

      toggle(view.byLabel('Increase message text size'));
      toggle(reset());

      expect(getAppearance().readingSize).toBe(100);
    });

    // The stepper must stop at the ends rather than storing a value the model
    // will silently clamp back on the next launch.
    it('cannot be stepped past its limits', () => {
      setAppearance({ readingSize: 160 });
      const view = mount();

      expect(view.byLabel('Increase message text size')?.hasAttribute('disabled')).toBe(true);
      expect(view.byLabel('Decrease message text size')?.hasAttribute('disabled')).toBe(false);
    });
  });

  describe('reading font', () => {
    // Regression: the reading font is separate from the interface font — a
    // serif for mail with the app still in its UI face.
    it('writes the reading font without touching the interface font', () => {
      const view = mount();

      choose(view.byLabel('Reading font'), 'serif');

      expect(getAppearance().readingFont).toBe('serif');
      expect(getAppearance().font).toBe('system');
    });

    it('leaves the interface font on its own control', () => {
      const view = mount();

      choose(view.byLabel('Interface font'), 'mono');

      expect(getAppearance().font).toBe('mono');
      expect(getAppearance().readingFont).toBe('default');
    });
  });

  describe('preview lines', () => {
    it('writes the chosen line count', () => {
      const view = mount();

      toggle(card(view, 'Preview lines', '2 lines'));

      expect(getAppearance().snippetLines).toBe(2);
    });

    // Regression: the miniature is the only way to see the effect without
    // leaving the screen — at "None" it must drop the preview line, exactly
    // as a real row does.
    it('shows the reader the effect in the miniature', () => {
      const view = mount();
      expect(preview(view)?.querySelector('.list-snippet')).not.toBeNull();

      toggle(card(view, 'Preview lines', 'None'));

      expect(preview(view)?.querySelector('.list-snippet')).toBeNull();
    });
  });

  describe('layout', () => {
    // Regression: hover actions shipped as a dead switch in General for a
    // long time. It is in Appearance now BECAUSE it does something.
    it('turns hover actions off from the store the list reads', () => {
      const view = mount();
      expect(view.byLabel('Hover actions')?.getAttribute('aria-checked')).toBe('true');

      toggle(view.byLabel('Hover actions'));

      expect(getAppearance().hoverActions).toBe(false);
    });

    it('writes the button-label mode', () => {
      const view = mount();

      toggle(card(view, 'Button labels', 'Both'));

      expect(getAppearance().buttonLabels).toBe('both');
    });

    // The miniature toolbar is built from the real `toolbarButtonClass`, so
    // the reader sees the actual widening before opening a message.
    it('draws the miniature toolbar in the chosen mode', () => {
      const view = mount();
      expect(preview(view)?.textContent).not.toContain('Archive');

      toggle(card(view, 'Button labels', 'Text'));

      expect(preview(view)?.textContent).toContain('Archive');
    });
  });

  describe('motion', () => {
    // Regression: "Off" is an accessibility setting. The CSS keys off the
    // stored value, so a card that does not write it does nothing at all.
    it('writes the chosen motion mode', () => {
      const view = mount();

      toggle(card(view, 'Motion', 'Off'));

      expect(getAppearance().motion).toBe('reduced');
    });

    it('starts on System, deferring to the OS', () => {
      const view = mount();

      expect(card(view, 'Motion', 'System')?.getAttribute('aria-checked')).toBe('true');
    });
  });

  // Regression: every new setting has to be reachable by Reset, or a reader
  // who dislikes what they picked has no way back to the shipped defaults.
  it('returns every new setting to its default on reset', () => {
    setAppearance({ readingSize: 140, readingFont: 'serif', snippetLines: 2, motion: 'reduced', hoverActions: false, buttonLabels: 'both' });
    const view = mount();

    toggle([...view.container.querySelectorAll('button')].find((b) => b.textContent?.includes('Reset to defaults')) ?? null);

    expect(getAppearance()).toMatchObject({
      readingSize: 100,
      readingFont: 'default',
      snippetLines: 1,
      motion: 'system',
      hoverActions: true,
      buttonLabels: 'icons',
    });
  });
});
