// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { getAppearance, resetAppearance } from '../../../../../src/appearance/appearance-store';
import { AppearanceTab } from '../../../../../src/components/settings/AppearanceTab';
import { render, toggle, type Mounted } from '../../../../helpers/render';

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
});
