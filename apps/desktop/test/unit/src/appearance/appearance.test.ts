import { describe, expect, it } from 'vitest';

import {
  ACCENTS,
  DENSITIES,
  FONTS,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  appearanceCssVars,
  clampZoom,
  defaultAppearance,
  normalizeAppearance,
  resolveTheme,
  stepZoom,
  zoomFactor,
  type Appearance,
} from '../../../../src/appearance/appearance';

// These guard the appearance model, which decides what the whole app looks
// like from values that arrive out of localStorage and off a menu accelerator.
// The failure this suite exists to prevent is an unreadable app: a zoom of 0 or
// 6000, a density that resolves to nothing so every row collapses, or a theme
// that never turns back off. None of those throw — they just render.

describe('clampZoom', () => {
  // Regression: a NaN/undefined/string zoom out of a corrupt settings blob must
  // land on 100, not propagate into `setZoomFactor(NaN)` and blank the window.
  it('falls back to the default for anything non-finite', () => {
    expect(clampZoom(undefined)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(null)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom('huge')).toBe(ZOOM_DEFAULT);
    expect(clampZoom({})).toBe(ZOOM_DEFAULT);
  });

  // Regression: an out-of-range zoom must be clamped, never honoured. A stored
  // 5 or 5000 is an app the user cannot read well enough to fix the setting in.
  it('clamps to the supported range', () => {
    expect(clampZoom(1)).toBe(ZOOM_MIN);
    expect(clampZoom(-400)).toBe(ZOOM_MIN);
    expect(clampZoom(5000)).toBe(ZOOM_MAX);
  });

  // Numeric strings are what a range <input> hands back; they must still work.
  it('accepts numeric strings and snaps to the slider grid', () => {
    expect(clampZoom('110')).toBe(110);
    expect(clampZoom(103)).toBe(105);
    expect(clampZoom(102)).toBe(100);
  });
});

describe('stepZoom', () => {
  it('moves by the menu step in each direction', () => {
    expect(stepZoom(100, 'in')).toBe(110);
    expect(stepZoom(100, 'out')).toBe(90);
  });

  // Regression: holding Cmd+- must stop at the floor rather than walking the
  // app down to an unusable size.
  it('stops at the range ends instead of running past them', () => {
    expect(stepZoom(ZOOM_MIN, 'out')).toBe(ZOOM_MIN);
    expect(stepZoom(ZOOM_MAX, 'in')).toBe(ZOOM_MAX);
  });

  it('reset always returns to 100 regardless of the current zoom', () => {
    expect(stepZoom(ZOOM_MIN, 'reset')).toBe(ZOOM_DEFAULT);
    expect(stepZoom(ZOOM_MAX, 'reset')).toBe(ZOOM_DEFAULT);
  });
});

describe('zoomFactor', () => {
  // Electron wants a factor, not a percentage. Send it 90 instead of 0.9 and
  // the window renders at 9000%.
  it('converts a clamped percentage to an Electron zoom factor', () => {
    expect(zoomFactor(100)).toBe(1);
    expect(zoomFactor(90)).toBeCloseTo(0.9);
    expect(zoomFactor(99999)).toBeCloseTo(ZOOM_MAX / 100);
  });
});

describe('resolveTheme', () => {
  it('honours an explicit choice over the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  // Regression: 'system' is the default, so this branch is what most users get.
  it('follows the OS when set to system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('normalizeAppearance', () => {
  it('returns the defaults for nothing at all', () => {
    expect(normalizeAppearance(null)).toEqual(defaultAppearance);
    expect(normalizeAppearance(undefined)).toEqual(defaultAppearance);
    expect(normalizeAppearance({})).toEqual(defaultAppearance);
  });

  // Regression: this is the whole reason normalize is field-by-field rather
  // than a spread. A key with the right NAME and a nonsense value would survive
  // a spread and then resolve to no density preset at all — every list row
  // losing its height, with nothing logged.
  it('drops values that are not one of the known options', () => {
    const normalized = normalizeAppearance({
      theme: 'sepia',
      accent: 'chartreuse',
      font: 'comic',
      density: 'tiny',
      gradientAccents: 'yes',
      darkenEmails: 'sure',
      zoom: 'big',
    });
    expect(normalized).toEqual(defaultAppearance);
  });

  it('keeps every valid value it is given', () => {
    const stored: Appearance = {
      theme: 'dark',
      accent: 'violet',
      gradientAccents: true,
      font: 'serif',
      density: 'compact',
      zoom: 125,
      darkenEmails: true,
    };
    expect(normalizeAppearance(stored)).toEqual(stored);
  });

  // Partial blobs are the realistic shape: a build that adds a field reads back
  // settings written by the build before it.
  it('fills in fields missing from an older stored blob', () => {
    const normalized = normalizeAppearance({ theme: 'dark' });
    expect(normalized.theme).toBe('dark');
    expect(normalized.density).toBe(defaultAppearance.density);
    expect(normalized.zoom).toBe(ZOOM_DEFAULT);
  });
});

describe('appearanceCssVars', () => {
  // Regression: the accent must be emitted as the bare HSL triplet the Tailwind
  // theme wraps in hsl(). Emit "#3069B0" or "hsl(...)" here and every themed
  // colour in the app resolves to nothing — invisible text on invisible chips.
  it('emits --primary as a bare HSL triplet, not a colour function', () => {
    const vars = appearanceCssVars(defaultAppearance, 'light');
    expect(vars['--primary']).toBe('221.2 83.2% 53.3%');
    expect(vars['--primary']).not.toMatch(/hsl|#/);
    expect(vars['--ring']).toBe(vars['--primary']);
  });

  // Regression: the dark palette must actually be used. Reading the light
  // tokens in dark mode gives a saturated mid-tone accent on near-black, which
  // is the "dark mode was never looked at" tell.
  it('uses the dark tokens for a dark resolved theme', () => {
    const light = appearanceCssVars({ ...defaultAppearance, accent: 'violet' }, 'light');
    const dark = appearanceCssVars({ ...defaultAppearance, accent: 'violet' }, 'dark');
    expect(dark['--primary']).not.toBe(light['--primary']);
    expect(dark['--primary']).toBe(ACCENTS.find((a) => a.id === 'violet')!.dark.primary);
  });

  // Regression: with gradients off, the fill must stay a FLAT colour. A
  // gradient behind every primary button was an opt-in, not the default.
  it('only puts a gradient in --brand-fill when gradient accents are on', () => {
    expect(appearanceCssVars(defaultAppearance, 'light')['--brand-fill']).toMatch(/^hsl\(/);
    expect(
      appearanceCssVars({ ...defaultAppearance, gradientAccents: true }, 'light')['--brand-fill'],
    ).toMatch(/^linear-gradient\(/);
  });

  it('emits the chosen font stack and density metrics', () => {
    const vars = appearanceCssVars({ ...defaultAppearance, font: 'mono', density: 'compact' }, 'light');
    expect(vars['--app-font']).toBe(FONTS.find((f) => f.id === 'mono')!.stack);
    expect(vars['--row-h']).toBe(DENSITIES.find((d) => d.id === 'compact')!.rowHeight);
  });

  // Regression: a densities list that stops covering a DensityId, or an accent
  // list that stops covering an AccentId, resolves to `undefined` at runtime.
  // The fallbacks exist so that is a wrong colour, never an unstyled app.
  it('falls back to a real preset when an id is somehow unknown', () => {
    const vars = appearanceCssVars({ ...defaultAppearance, accent: 'nope' as never, density: 'nope' as never }, 'light');
    expect(vars['--primary']).toBe(ACCENTS[0]!.light.primary);
    expect(vars['--row-h']).toBe(DENSITIES.find((d) => d.id === 'cozy')!.rowHeight);
  });
});

describe('the shipped defaults', () => {
  // Regression: landing this feature must not change how an existing install
  // looks. `cozy` is today's spacing and `sarv-blue` is today's token, so an
  // app with nothing stored renders exactly as it did before.
  it('reproduce the pre-existing look', () => {
    expect(defaultAppearance.density).toBe('cozy');
    expect(defaultAppearance.zoom).toBe(100);
    expect(defaultAppearance.gradientAccents).toBe(false);
    const vars = appearanceCssVars(defaultAppearance, 'light');
    expect(vars['--primary']).toBe('221.2 83.2% 53.3%');
    expect(vars['--row-h']).toBe('2.5rem');
    expect(vars['--row-px']).toBe('1rem');
  });

  it('every preset id is unique', () => {
    const ids = [...ACCENTS.map((a) => a.id), ...FONTS.map((f) => f.id), ...DENSITIES.map((d) => d.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
