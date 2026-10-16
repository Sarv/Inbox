import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { CALENDAR_PALETTE_SIZE } from '../../../../src/components/calendar/calendar-types';

/**
 * The Calendar screen's stylesheet carries copies of design-system components
 * (`.btn`, `.seg`, `.check`, `.cal-day` …) whose names are generic.
 */
const CSS = readFileSync(join(__dirname, '../../../../src/styles/calendar-view.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector in the file, split on commas. */
const selectors = [...CSS.matchAll(/([^{}]+)\{/g)]
  .flatMap((match) => match[1]!.split(','))
  .map((selector) => selector.trim())
  .filter(Boolean);

describe('calendar-view.css', () => {
  // Regression: an unscoped `.btn` / `.check` / `.seg` here would restyle every
  // control of that name across the whole app, not just the calendar.
  it('scopes every rule to the calendar screen', () => {
    expect(selectors.length).toBeGreaterThan(20);
    const unscoped = selectors.filter((selector) =>
      !/^(\.dark )?\.sarv-calendar\b/.test(selector) && !selector.startsWith('.calv-'));
    expect(unscoped).toEqual([]);
  });

  // Regression: `--border` and `--muted` are bare HSL triplets in this app, so
  // `var(--border)` as a colour is invalid and the line silently disappears.
  // The copied rules must read the bridged `--ds-border` / `--ds-muted`.
  it('never uses the app\'s triplet tokens as colours directly', () => {
    // The bridge itself wraps them in hsl(), which is the correct use.
    expect(CSS).not.toMatch(/(?<!hsl\()var\(--border\)/);
    expect(CSS).not.toMatch(/(?<!hsl\()var\(--muted\)/);
  });

  // Regression: resolveCalendarColor hands out --cal-palette-1..N; a slot
  // missing here draws that calendar with no colour at all.
  it('defines every palette slot the colour resolver can hand out, light and dark', () => {
    const blocks = CSS.split('.dark .sarv-calendar');
    for (let slot = 1; slot <= CALENDAR_PALETTE_SIZE; slot += 1) {
      expect(blocks[0]).toContain(`--cal-palette-${slot}:`);
      expect(blocks[1]).toContain(`--cal-palette-${slot}:`);
    }
  });
});
