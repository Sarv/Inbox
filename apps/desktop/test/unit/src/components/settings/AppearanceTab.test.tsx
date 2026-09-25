// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { AppearanceTab } from '../../../../../src/components/settings/AppearanceTab';
import { render, type Mounted } from '../../../../helpers/render';

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
  afterEach(() => { mounted?.unmount(); mounted = undefined; });

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
});
