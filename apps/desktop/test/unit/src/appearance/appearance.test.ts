import { describe, expect, it } from 'vitest';

import {
  ACCENTS,
  BUTTON_LABEL_CHOICES,
  CHAT_READING_BASE_PX,
  DENSITIES,
  FONTS,
  MAIL_SANS_STACK,
  MOTION_CHOICES,
  READING_BASE_PX,
  READING_FONTS,
  READING_SIZE_DEFAULT,
  READING_SIZE_MAX,
  READING_SIZE_MIN,
  SNIPPET_CHOICES,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  appearanceCssVars,
  clampReadingSize,
  clampZoom,
  defaultAppearance,
  defaultReadingTypography,
  findReadingFont,
  mergeLegacyLayout,
  normalizeAppearance,
  readingFontSize,
  readingFontStack,
  resolveTheme,
  stepReadingSize,
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
      readingSize: 'huge',
      readingFont: 'wingdings',
      snippetLines: 7,
      motion: 'slow',
      hoverActions: 'on',
      buttonLabels: 'emoji',
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
      readingSize: 120,
      readingFont: 'serif',
      snippetLines: 2,
      motion: 'reduced',
      hoverActions: false,
      buttonLabels: 'both',
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

describe('clampReadingSize', () => {
  // Regression: the same corrupt-blob path as zoom, on a scale that must never
  // reach 0 — a message body at 0px is a message that isn't there.
  it('falls back to the default for anything non-finite', () => {
    expect(clampReadingSize(undefined)).toBe(READING_SIZE_DEFAULT);
    expect(clampReadingSize(null)).toBe(READING_SIZE_DEFAULT);
    expect(clampReadingSize('')).toBe(READING_SIZE_DEFAULT);
    expect(clampReadingSize(true)).toBe(READING_SIZE_DEFAULT);
  });

  // Regression: reading text has a HIGHER floor than the chrome (80, not 70) —
  // shrinking the UI to fit more list is reasonable, unreadable mail is not.
  it('clamps to its own range, which is narrower than zoom at the bottom', () => {
    expect(clampReadingSize(10)).toBe(READING_SIZE_MIN);
    expect(clampReadingSize(9000)).toBe(READING_SIZE_MAX);
    expect(READING_SIZE_MIN).toBeGreaterThan(ZOOM_MIN);
  });

  it('accepts numeric strings and snaps to the slider grid', () => {
    expect(clampReadingSize('115')).toBe(115);
    expect(clampReadingSize(113)).toBe(115);
    expect(clampReadingSize(111)).toBe(110);
  });
});

describe('stepReadingSize', () => {
  it('moves one grid step in each direction and stops at the ends', () => {
    expect(stepReadingSize(100, 'in')).toBe(105);
    expect(stepReadingSize(100, 'out')).toBe(95);
    expect(stepReadingSize(READING_SIZE_MIN, 'out')).toBe(READING_SIZE_MIN);
    expect(stepReadingSize(READING_SIZE_MAX, 'in')).toBe(READING_SIZE_MAX);
    expect(stepReadingSize(READING_SIZE_MAX, 'reset')).toBe(READING_SIZE_DEFAULT);
  });

  // Regression: a stored-but-impossible value must be clamped BEFORE the step,
  // or one press walks it further out of range instead of back into it.
  it('pulls an out-of-range value back into the scale', () => {
    expect(stepReadingSize(9000, 'in')).toBe(READING_SIZE_MAX);
    expect(stepReadingSize(-40, 'out')).toBe(READING_SIZE_MIN);
  });
});

describe('readingFontSize', () => {
  // Regression: at 100% the frame must emit the sizes it always emitted (16px
  // standard, 15px in a chat bubble). Anything else is every message in every
  // install silently resizing on upgrade.
  it('is the untouched base size at 100%', () => {
    expect(readingFontSize(READING_BASE_PX, 100)).toBe(READING_BASE_PX);
    expect(readingFontSize(CHAT_READING_BASE_PX, 100)).toBe(CHAT_READING_BASE_PX);
    expect(defaultReadingTypography.size).toBe(100);
    expect(defaultReadingTypography.fontStack).toBe(MAIL_SANS_STACK);
  });

  it('scales to a whole number of pixels', () => {
    expect(readingFontSize(16, 150)).toBe(24);
    expect(readingFontSize(15, 130)).toBe(20); // 19.5 rounds, never lands on a half pixel
  });

  it('uses the clamped size for junk input', () => {
    expect(readingFontSize(16, 'nonsense')).toBe(16);
    expect(readingFontSize(16, 9000)).toBe(readingFontSize(16, READING_SIZE_MAX));
  });
});

describe('the reading font list', () => {
  // Regression: 'default' must resolve to the exact stack the message frame
  // already used, so a reader who never touches this setting sees no change.
  it('leaves the frame stack alone at Default', () => {
    expect(readingFontStack('default')).toBe(MAIL_SANS_STACK);
    expect(findReadingFont('default').id).toBe('default');
  });

  it('falls back to Default for an unknown id', () => {
    expect(findReadingFont('papyrus' as never).id).toBe('default');
    expect(readingFontStack('papyrus' as never)).toBe(MAIL_SANS_STACK);
  });

  // The reading list reuses the interface FONTS entries; a copy would drift.
  it('reuses the interface font stacks for the faces it shares', () => {
    for (const id of ['inter', 'humanist', 'serif', 'mono'] as const) {
      expect(readingFontStack(id)).toBe(FONTS.find((font) => font.id === id)!.stack);
    }
  });
});

describe('mergeLegacyLayout', () => {
  // Regression: both fields used to live in the settings blob, written by the
  // General tab and read by nothing. Someone who turned hover actions off was
  // asking for them off — dropping that on the way across looks like the app
  // reverting a preference the moment it finally started working.
  it('carries the old settings values across when the appearance has none', () => {
    const merged = normalizeAppearance(
      mergeLegacyLayout({ theme: 'dark' }, { hoverActions: false, buttonLabels: 'both' }),
    );
    expect(merged.hoverActions).toBe(false);
    expect(merged.buttonLabels).toBe('both');
    expect(merged.theme).toBe('dark');
  });

  // Regression: it runs on EVERY read, so a value already chosen here must win
  // — otherwise the stale settings blob resets the choice on the next launch.
  it('never overwrites a value the appearance already carries', () => {
    const appearance = { hoverActions: true, buttonLabels: 'text' };
    const settings = { hoverActions: false, buttonLabels: 'icons' };
    const once = mergeLegacyLayout(appearance, settings);
    expect(once).toMatchObject({ hoverActions: true, buttonLabels: 'text' });
    expect(mergeLegacyLayout(once, settings)).toEqual(once);
  });

  it('ignores a legacy value that is not a valid choice', () => {
    const merged = normalizeAppearance(
      mergeLegacyLayout(null, { hoverActions: 'no', buttonLabels: 'pictograms' }),
    );
    expect(merged.hoverActions).toBe(defaultAppearance.hoverActions);
    expect(merged.buttonLabels).toBe(defaultAppearance.buttonLabels);
  });

  // A missing/garbage blob on either side is the realistic first-launch shape.
  it('survives anything that is not an object on either side', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
      expect(() => normalizeAppearance(mergeLegacyLayout(junk, junk))).not.toThrow();
    }
    expect(normalizeAppearance(mergeLegacyLayout(null, null))).toEqual(defaultAppearance);
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

  // Regression: the list clamp and the message frame both read these. Emit a
  // wrong unit (or nothing) and either the preview prints the whole body into
  // the row, or the body renders at the browser default and ignores the setting.
  it('emits the reading typography and the snippet clamp', () => {
    const vars = appearanceCssVars(
      { ...defaultAppearance, readingFont: 'mono', readingSize: 150, snippetLines: 2 },
      'light',
    );
    expect(vars['--reading-font']).toBe(readingFontStack('mono'));
    expect(vars['--reading-size']).toBe('24px');
    expect(vars['--snippet-lines']).toBe('2');
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

  // Regression: every field added for this feature must default to what the app
  // already did — one line of mail preview, animations following the OS, hover
  // actions on, icon-only toolbar buttons, an unscaled body in the frame's own
  // face. A default that differs is a silent redesign on upgrade.
  it('reproduce the pre-existing behaviour for every new field', () => {
    expect(defaultAppearance.readingSize).toBe(100);
    expect(defaultAppearance.readingFont).toBe('default');
    expect(defaultAppearance.snippetLines).toBe(1);
    expect(defaultAppearance.motion).toBe('system');
    expect(defaultAppearance.hoverActions).toBe(true);
    expect(defaultAppearance.buttonLabels).toBe('icons');
    const vars = appearanceCssVars(defaultAppearance, 'light');
    expect(vars['--reading-font']).toBe(MAIL_SANS_STACK);
    expect(vars['--reading-size']).toBe('16px');
    expect(vars['--snippet-lines']).toBe('1');
  });

  it('every preset id is unique', () => {
    const ids = [
      ...ACCENTS.map((a) => a.id),
      ...FONTS.map((f) => f.id),
      ...DENSITIES.map((d) => d.id),
      ...READING_FONTS.map((f) => `reading:${f.id}`),
      ...MOTION_CHOICES.map((c) => `motion:${c.id}`),
      ...BUTTON_LABEL_CHOICES.map((c) => `labels:${c.id}`),
      ...SNIPPET_CHOICES.map((c) => `snippet:${c.id}`),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Regression: every choice the Settings screen offers must be one normalize
  // accepts. An option that normalizes away is a control that visibly does
  // nothing when clicked.
  it('offers only choices the model accepts', () => {
    for (const choice of MOTION_CHOICES) {
      expect(normalizeAppearance({ motion: choice.id }).motion).toBe(choice.id);
    }
    for (const choice of BUTTON_LABEL_CHOICES) {
      expect(normalizeAppearance({ buttonLabels: choice.id }).buttonLabels).toBe(choice.id);
    }
    for (const choice of SNIPPET_CHOICES) {
      expect(normalizeAppearance({ snippetLines: choice.id }).snippetLines).toBe(choice.id);
    }
    for (const font of READING_FONTS) {
      expect(normalizeAppearance({ readingFont: font.id }).readingFont).toBe(font.id);
    }
  });
});
