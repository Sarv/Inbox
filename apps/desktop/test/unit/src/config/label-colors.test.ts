import { describe, it, expect } from 'vitest';

import { LABEL_COLORS, LABEL_COLOR_NAMES, readableTextColor } from '../../../../src/config/label-colors';

describe('LABEL_COLORS palette', () => {
  // One palette shared by the color picker, the Labels settings tab and the
  // sidebar quick-create. The first eight must stay first (and unchanged), or
  // every existing label — and the default color — silently shifts hue.
  it('keeps the original eight colors first, in order', () => {
    expect(LABEL_COLORS.slice(0, 8)).toEqual([
      '#2563eb', '#059669', '#d97706', '#dc2626',
      '#7c3aed', '#db2777', '#0891b2', '#4b5563',
    ]);
  });

  it('holds only lowercase 6-digit hex values with no duplicates', () => {
    for (const c of LABEL_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(LABEL_COLORS).size).toBe(LABEL_COLORS.length);
  });

  it('names every swatch (the names are the accessible labels on the picker)', () => {
    for (const c of LABEL_COLORS) expect(LABEL_COLOR_NAMES[c]).toBeTruthy();
    expect(Object.keys(LABEL_COLOR_NAMES)).toHaveLength(LABEL_COLORS.length);
    expect(new Set(Object.values(LABEL_COLOR_NAMES)).size).toBe(LABEL_COLORS.length);
  });
});

describe('readableTextColor', () => {
  // Solid label chips draw text ON the label color. A wrong pick here is an
  // unreadable chip (white on pale yellow), which is why the WCAG luminance
  // calculation exists instead of a naive brightness average.
  it('uses dark text on pale fills', () => {
    expect(readableTextColor('#ffffff')).toBe('#111827');
    expect(readableTextColor('#fef08a')).toBe('#111827'); // pale yellow
    expect(readableTextColor('#bbf7d0')).toBe('#111827'); // pale mint
  });

  it('uses white text on dark/saturated fills', () => {
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#2563eb')).toBe('#ffffff');
    expect(readableTextColor('#dc2626')).toBe('#ffffff');
  });

  it('picks white for every color in the shipped palette', () => {
    // The palette is documented as "medium/dark enough" — this pins that claim,
    // so adding a pale color to LABEL_COLORS trips this test rather than shipping
    // an unreadable chip.
    for (const c of LABEL_COLORS) expect(readableTextColor(c)).toBe('#ffffff');
  });

  it('accepts a 3-digit shorthand and expands it', () => {
    expect(readableTextColor('#fff')).toBe(readableTextColor('#ffffff'));
    expect(readableTextColor('#000')).toBe(readableTextColor('#000000'));
  });

  it('accepts the value with or without the leading # and around whitespace', () => {
    expect(readableTextColor('2563eb')).toBe('#ffffff');
    expect(readableTextColor('  #ffffff  ')).toBe('#111827');
  });

  it('is case-insensitive on the hex digits', () => {
    expect(readableTextColor('#FFFFFF')).toBe('#111827');
    expect(readableTextColor('#2563EB')).toBe('#ffffff');
  });

  it('falls back to white for an unparseable / missing color', () => {
    // A legacy label row could hold '', 'red', or an rgb() string; the chip must
    // still render rather than throwing during list paint.
    expect(readableTextColor('')).toBe('#ffffff');
    expect(readableTextColor('red')).toBe('#ffffff');
    expect(readableTextColor('#12345')).toBe('#ffffff');
    expect(readableTextColor('rgb(0,0,0)')).toBe('#ffffff');
    expect(readableTextColor(undefined as unknown as string)).toBe('#ffffff');
  });

  it('applies the sRGB linearisation to very dark channels (the c<=0.03928 branch)', () => {
    // #0a0a0a lands in the linear (divide-by-12.92) leg of the WCAG formula.
    expect(readableTextColor('#0a0a0a')).toBe('#ffffff');
  });
});
