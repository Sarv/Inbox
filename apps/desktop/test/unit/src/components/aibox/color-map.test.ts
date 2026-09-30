import { describe, expect, it } from 'vitest';

import { COLOR_MAP } from '../../../../../src/components/aibox/types';

/**
 * COLOR_MAP tints the AI category cards, badges and filter chips. It once held
 * only light-mode classes, so in dark mode a non-empty category card kept its
 * pastel background while the title inherited the near-white foreground and
 * vanished. Every slot of every colour must carry a `dark:` override.
 */
describe('COLOR_MAP dark mode', () => {
  const entries = Object.entries(COLOR_MAP);

  // Fails if a colour is added (or edited) without dark-mode classes.
  it.each(entries)('%s has a dark: variant for text, bg and border', (_name, colorSet) => {
    expect(colorSet.text).toMatch(/(^|\s)dark:text-/);
    expect(colorSet.bg).toMatch(/(^|\s)dark:bg-/);
    expect(colorSet.border).toMatch(/(^|\s)dark:border-/);
  });

  // Fails if the dark bg goes opaque/light again: a translucent tint keeps the
  // dark surface underneath so the default foreground stays readable.
  it.each(entries)('%s dark background is a translucent tint', (_name, colorSet) => {
    expect(colorSet.bg).toMatch(/dark:bg-[a-z]+-\d+\/\d+/);
  });
});
