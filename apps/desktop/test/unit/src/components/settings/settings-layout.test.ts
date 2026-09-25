import { describe, expect, it } from 'vitest';

import { settingsContentWidthClass } from '../../../../../src/components/settings/settings-layout';
import type { SettingsTab } from '../../../../../src/components/settings/types';

/**
 * Settings → how wide the content column may grow.
 *
 * If Appearance loses its wider cap, its two-column layout collapses: the live
 * preview drops back under the controls and a wide window goes back to showing
 * a strip of settings against a screen of empty white — the thing this rule
 * exists to stop.
 */
describe('settingsContentWidthClass', () => {
  it('gives Appearance the room its side-by-side preview needs', () => {
    expect(settingsContentWidthClass('appearance')).toBe('max-w-6xl');
  });

  // Prose and label/control rows stay readable only up to a measure — every
  // other tab is deliberately narrow, and widening them all is not the fix.
  it('keeps every other tab at the readable single-column width', () => {
    const others: SettingsTab[] = [
      'general', 'inbox', 'accounts', 'folders', 'filters', 'advanced', 'keyboard-shortcuts',
    ];

    for (const tab of others) {
      expect(settingsContentWidthClass(tab)).toBe('max-w-3xl');
    }
  });
});
