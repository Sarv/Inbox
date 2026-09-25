/**
 * The appearance model — theme, accent colour, font, density and zoom.
 *
 * Pure and dependency-free ON PURPOSE: every rule about what a stored value
 * means, what a bad one falls back to, and which CSS custom properties a given
 * appearance produces lives here, so it is unit-testable without a DOM, a
 * store, or Electron. The DOM/Electron edge is `apply-appearance.ts`; the
 * persistence edge is `appearance-store.ts`.
 *
 * Why the accent is expressed as bare HSL triplets ("221.2 83.2% 53.3%"): that
 * is the format the Tailwind theme already uses for `--primary` and friends
 * (`hsl(var(--primary))` in tailwind.config.js). Emitting the same shape means
 * an accent is a one-variable override of the existing token, not a parallel
 * colour system.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type DensityId = 'comfortable' | 'cozy' | 'compact';
export type AccentId = 'sarv-blue' | 'ocean' | 'violet' | 'emerald' | 'sunset' | 'rose' | 'graphite';
export type FontId = 'system' | 'inter' | 'humanist' | 'serif' | 'mono';

export interface Appearance {
  /** 'system' follows the OS; 'light'/'dark' pin it regardless of the OS. */
  theme: ThemeMode;
  accent: AccentId;
  /** Paint the primary action (Compose) as a gradient instead of a flat fill. */
  gradientAccents: boolean;
  font: FontId;
  density: DensityId;
  /** UI scale in PERCENT (100 = native). Applied as an Electron zoom factor. */
  zoom: number;
  /**
   * Re-colour the MESSAGE BODY for dark mode instead of showing it on the white
   * page it was written for. Off by default, and deliberately so: email HTML is
   * only ever partially styled, so this can only ever be a best effort on
   * someone else's markup — everyone gets the faithful white canvas until they
   * ask for something else. Has no effect while the theme resolves to light.
   * The re-colouring itself lives in utils/email-dark-mode.ts.
   */
  darkenEmails: boolean;
}

/** One accent's tokens for a single resolved theme. */
export interface AccentTokens {
  /** HSL triplet for `--primary`. */
  primary: string;
  /** HSL triplet for `--primary-foreground` (text ON the accent). */
  foreground: string;
  /** HSL triplet the gradient runs TO, from `primary`. */
  gradientTo: string;
}

export interface AccentPreset {
  id: AccentId;
  label: string;
  light: AccentTokens;
  dark: AccentTokens;
}

/**
 * The accent palette. `sarv-blue` reproduces the tokens index.css already ships,
 * so the default appearance is a no-op against the current look — nobody's app
 * changes colour just because this feature landed.
 *
 * The dark variants are lighter and less saturated than their light twins:
 * a fully-saturated mid-tone accent that reads well on white vibrates against a
 * near-black surface. `ocean` and `sunset` are the Sarv design-system brand and
 * accent hues (sarv_theme/design-system.css), including its dark-flipped values.
 */
export const ACCENTS: readonly AccentPreset[] = [
  {
    id: 'sarv-blue',
    label: 'Sarv Blue',
    light: { primary: '221.2 83.2% 53.3%', foreground: '210 40% 98%', gradientTo: '199 89% 48%' },
    dark: { primary: '217.2 91.2% 59.8%', foreground: '222.2 47.4% 11.2%', gradientTo: '199 89% 58%' },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    light: { primary: '212 58% 44%', foreground: '210 40% 98%', gradientTo: '199 80% 42%' },
    dark: { primary: '212 57% 59%', foreground: '212 60% 12%', gradientTo: '199 70% 60%' },
  },
  {
    id: 'violet',
    label: 'Violet',
    light: { primary: '262 83% 58%', foreground: '210 40% 98%', gradientTo: '292 84% 61%' },
    dark: { primary: '263 70% 65%', foreground: '263 50% 12%', gradientTo: '292 70% 68%' },
  },
  {
    id: 'emerald',
    label: 'Emerald',
    light: { primary: '160 84% 32%', foreground: '160 60% 98%', gradientTo: '173 80% 36%' },
    dark: { primary: '158 64% 52%', foreground: '160 60% 10%', gradientTo: '173 66% 55%' },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    light: { primary: '25 87% 48%', foreground: '30 100% 98%', gradientTo: '13 88% 52%' },
    dark: { primary: '22 100% 60%', foreground: '24 60% 12%', gradientTo: '13 90% 62%' },
  },
  {
    id: 'rose',
    label: 'Rose',
    light: { primary: '347 77% 50%', foreground: '355 100% 98%', gradientTo: '330 81% 56%' },
    dark: { primary: '347 77% 62%', foreground: '347 50% 12%', gradientTo: '330 75% 66%' },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    light: { primary: '215 28% 27%', foreground: '210 40% 98%', gradientTo: '215 20% 40%' },
    dark: { primary: '215 20% 72%', foreground: '215 30% 12%', gradientTo: '215 16% 60%' },
  },
] as const;

export interface FontPreset {
  id: FontId;
  label: string;
  /** A full CSS font-family stack. Every entry degrades to an installed face. */
  stack: string;
  /** One-line description of who this suits, shown under the option. */
  hint: string;
}

/**
 * Font choices are STACKS of faces the OS already has, never a downloaded
 * webfont: this app must render identically offline, and a mail client that
 * blocks remote images has no business fetching remote fonts either.
 */
export const FONTS: readonly FontPreset[] = [
  {
    id: 'system',
    label: 'System',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    hint: 'Matches the rest of your desktop.',
  },
  {
    id: 'inter',
    label: 'Inter',
    stack: "Inter, 'Inter var', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    hint: 'Tall x-height; easiest to read at small sizes. Falls back to System if not installed.',
  },
  {
    id: 'humanist',
    label: 'Humanist',
    stack: "'Avenir Next', Avenir, 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif",
    hint: 'Rounder and wider — softer than the system face.',
  },
  {
    id: 'serif',
    label: 'Serif',
    stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
    hint: 'Book-like. Long messages read more slowly and more calmly.',
  },
  {
    id: 'mono',
    label: 'Monospace',
    stack: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
    hint: 'Fixed width. Useful when addresses and headers must line up.',
  },
] as const;

export interface DensityPreset {
  id: DensityId;
  label: string;
  hint: string;
  /** Height of one single-line list row. */
  rowHeight: string;
  /** Horizontal padding of a list row/card. */
  rowPaddingX: string;
  /** Vertical padding of a multi-line thread card. */
  cardPaddingY: string;
  /** Vertical padding of a sidebar navigation row. */
  navPaddingY: string;
}

/** `cozy` reproduces today's spacing (h-10 / px-4 / py-2), so it is the default. */
export const DENSITIES: readonly DensityPreset[] = [
  {
    id: 'comfortable',
    label: 'Comfortable',
    hint: 'Roomy rows. Easiest to hit with a trackpad.',
    rowHeight: '3rem',
    rowPaddingX: '1rem',
    cardPaddingY: '0.625rem',
    navPaddingY: '0.625rem',
  },
  {
    id: 'cozy',
    label: 'Cozy',
    hint: 'The default balance of rows-on-screen and breathing room.',
    rowHeight: '2.5rem',
    rowPaddingX: '1rem',
    cardPaddingY: '0.5rem',
    navPaddingY: '0.5rem',
  },
  {
    id: 'compact',
    label: 'Compact',
    hint: 'Maximum messages per screen.',
    rowHeight: '2.125rem',
    rowPaddingX: '0.75rem',
    cardPaddingY: '0.25rem',
    navPaddingY: '0.3125rem',
  },
] as const;

export const ZOOM_MIN = 70;
export const ZOOM_MAX = 160;
/** Slider granularity. The menu's Cmd +/- moves by `ZOOM_MENU_STEP` instead. */
export const ZOOM_STEP = 5;
export const ZOOM_MENU_STEP = 10;
export const ZOOM_DEFAULT = 100;

export const defaultAppearance: Appearance = {
  theme: 'system',
  accent: 'sarv-blue',
  gradientAccents: false,
  font: 'system',
  density: 'cozy',
  zoom: ZOOM_DEFAULT,
  darkenEmails: false,
};

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];
const ACCENT_IDS: readonly AccentId[] = ACCENTS.map((accent) => accent.id);
const FONT_IDS: readonly FontId[] = FONTS.map((font) => font.id);
const DENSITY_IDS: readonly DensityId[] = DENSITIES.map((density) => density.id);

/**
 * Snap a zoom to the slider's grid and the supported range.
 *
 * Total, by design: it is fed values from localStorage and from a menu
 * accelerator, either of which can be absent, a string, NaN or wildly out of
 * range. A zoom of 0 or 10000 is not a cosmetic bug — it is an app the user
 * cannot read well enough to fix the setting with.
 */
export const clampZoom = (zoom: unknown): number => {
  // Only a number, or a non-empty numeric string (what a range <input> hands
  // back), counts. Going through Number() alone would turn `null`, `''` and
  // `true` into finite values (0, 0, 1) and clamp them to the MINIMUM — an app
  // shrunk to 70% because a field was absent, rather than left at 100%.
  const asNumber =
    typeof zoom === 'number' ? zoom
    : typeof zoom === 'string' && zoom.trim() !== '' ? Number(zoom)
    : NaN;
  if (!Number.isFinite(asNumber)) return ZOOM_DEFAULT;
  const snapped = Math.round(asNumber / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped));
};

export type ZoomCommand = 'in' | 'out' | 'reset';

/** What the View menu's zoom items do to the CURRENT zoom. */
export const stepZoom = (zoom: number, command: ZoomCommand): number => {
  if (command === 'reset') return ZOOM_DEFAULT;
  const delta = command === 'in' ? ZOOM_MENU_STEP : -ZOOM_MENU_STEP;
  return clampZoom(clampZoom(zoom) + delta);
};

/** Percent → the factor Electron's `setZoomFactor` wants. */
export const zoomFactor = (zoom: number): number => clampZoom(zoom) / 100;

/**
 * Fill in every field from a stored blob of unknown shape.
 *
 * Deliberately field-by-field rather than a spread over the defaults: a
 * half-written or hand-edited settings file can carry a key with the right name
 * and a nonsense value ("density": "tiny"), which a spread would keep and which
 * would then silently produce an unstyled row.
 */
export const normalizeAppearance = (raw: unknown): Appearance => {
  const stored = (raw ?? {}) as Partial<Record<keyof Appearance, unknown>>;
  return {
    theme: isOneOf(THEME_MODES, stored.theme) ? stored.theme : defaultAppearance.theme,
    accent: isOneOf(ACCENT_IDS, stored.accent) ? stored.accent : defaultAppearance.accent,
    gradientAccents: typeof stored.gradientAccents === 'boolean' ? stored.gradientAccents : defaultAppearance.gradientAccents,
    font: isOneOf(FONT_IDS, stored.font) ? stored.font : defaultAppearance.font,
    density: isOneOf(DENSITY_IDS, stored.density) ? stored.density : defaultAppearance.density,
    zoom: clampZoom(stored.zoom),
    darkenEmails: typeof stored.darkenEmails === 'boolean' ? stored.darkenEmails : defaultAppearance.darkenEmails,
  };
};

/** 'system' asks the OS; anything else is the user's explicit choice. */
export const resolveTheme = (mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme => {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersDark ? 'dark' : 'light';
};

const findAccent = (id: AccentId): AccentPreset =>
  ACCENTS.find((accent) => accent.id === id) ?? ACCENTS[0]!;

const findFont = (id: FontId): FontPreset => FONTS.find((font) => font.id === id) ?? FONTS[0]!;

const findDensity = (id: DensityId): DensityPreset =>
  DENSITIES.find((density) => density.id === id) ?? DENSITIES[1]!;

/**
 * The CSS custom properties that express an appearance.
 *
 * These are set INLINE on `<html>` on purpose. `--primary` is declared by both
 * `:root` and `.dark` in index.css; an inline declaration outranks both, so one
 * value per resolved theme is all that is needed — no extra `.dark` accent
 * rules to keep in sync.
 */
export const appearanceCssVars = (
  appearance: Appearance,
  resolved: ResolvedTheme,
): Record<string, string> => {
  const accent = findAccent(appearance.accent);
  const tokens = resolved === 'dark' ? accent.dark : accent.light;
  const density = findDensity(appearance.density);
  const gradient = `linear-gradient(135deg, hsl(${tokens.primary}) 0%, hsl(${tokens.gradientTo}) 100%)`;
  return {
    '--primary': tokens.primary,
    '--primary-foreground': tokens.foreground,
    // The focus ring is the accent too, or a violet app keeps blue focus rings.
    '--ring': tokens.primary,
    '--brand-gradient': gradient,
    // Read by `.brand-fill`, which falls back to the flat accent when off.
    '--brand-fill': appearance.gradientAccents ? gradient : `hsl(${tokens.primary})`,
    '--app-font': findFont(appearance.font).stack,
    '--row-h': density.rowHeight,
    '--row-px': density.rowPaddingX,
    '--card-py': density.cardPaddingY,
    '--nav-py': density.navPaddingY,
  };
};
