import { describe, expect, it } from 'vitest';

import { CALENDAR_PALETTE_SIZE, resolveCalendarColor } from '../../../../../src/components/calendar/calendar-types';

// A stand-in for CSS.supports('color', …): the node test env has no CSS object.
const isColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value) || value === 'rebeccapurple';

describe('resolveCalendarColor', () => {
  // Regression: a calendar's own colour from the server must be used as-is.
  it('uses a server colour the browser accepts', () => {
    expect(resolveCalendarColor('#1a73e8', 0, isColor)).toBe('#1a73e8');
    expect(resolveCalendarColor('  rebeccapurple ', 3, isColor)).toBe('rebeccapurple');
  });

  // Regression: the colour lands in an inline style — a value that is not a
  // colour (an injected declaration, a url()) must never reach it.
  it('falls back to the palette for a value that is not a colour', () => {
    expect(resolveCalendarColor('red; background: url(https://x.invalid)', 0, isColor)).toBe('var(--cal-palette-1)');
  });

  // Regression: calendars without a colour must still be told apart, cycling
  // through the palette — including past its end and for a bad index.
  it('cycles the palette by position when there is no colour', () => {
    expect(resolveCalendarColor(null, 0, isColor)).toBe('var(--cal-palette-1)');
    expect(resolveCalendarColor(undefined, 1, isColor)).toBe('var(--cal-palette-2)');
    expect(resolveCalendarColor('', CALENDAR_PALETTE_SIZE, isColor)).toBe('var(--cal-palette-1)');
    expect(resolveCalendarColor(null, -1, isColor)).toBe(`var(--cal-palette-${CALENDAR_PALETTE_SIZE})`);
  });
});
