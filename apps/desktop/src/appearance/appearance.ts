/**
 * The appearance model — theme, accent colour, font, density, zoom, the
 * typography a MESSAGE BODY is drawn in, how much of one a list row
 * previews, whether the UI animates, and how its actions are labelled.
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
/**
 * The face message BODIES are drawn in. 'default' is the stack mail has always
 * been rendered in; the rest REUSE the interface font presets rather than
 * declaring a second set of stacks.
 */
export type ReadingFontId = 'default' | 'inter' | 'humanist' | 'serif' | 'mono';
/** Lines of body preview under a list row. 0 hides the preview entirely. */
export type SnippetLines = 0 | 1 | 2;
/** Whether the UI animates. 'system' defers to `prefers-reduced-motion`. */
export type MotionMode = 'system' | 'full' | 'reduced';
/** How a toolbar action is labelled. */
export type ButtonLabelMode = 'icons' | 'text' | 'both';

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
   * Message-body text size in PERCENT of the size mail has always been drawn at
   * (100 = unchanged).
   *
   * Deliberately NOT `zoom`: zoom is Chromium's page zoom, so it moves the
   * chrome and the message together. The size that makes a long message
   * comfortable is rarely the size that makes the list and sidebar comfortable,
   * and only the message is someone else's typography.
   */
  readingSize: number;
  /** The face message bodies are drawn in. 'default' leaves it as it was. */
  readingFont: ReadingFontId;
  /** Lines of body preview under a list row. */
  snippetLines: SnippetLines;
  /**
   * Whether the UI animates. 'system' honours the OS's reduced-motion
   * preference, and is the only value that can change without anyone touching
   * this setting.
   */
  motion: MotionMode;
  /** Reveal a list row's quick actions (archive/delete/…) on hover. */
  hoverActions: boolean;
  /** Whether a toolbar action shows its icon, its name, or both. */
  buttonLabels: ButtonLabelMode;
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

/**
 * One selectable face. Generic in its id so the interface list and the reading
 * list are the same shape with different id unions — the reading list reuses
 * these very objects, so a stack is never written down twice.
 */
export interface FontChoice<Id extends string> {
  id: Id;
  label: string;
  /** A full CSS font-family stack. Every entry degrades to an installed face. */
  stack: string;
  /** One-line description of who this suits, shown under the option. */
  hint: string;
}

export type FontPreset = FontChoice<FontId>;
export type ReadingFontPreset = FontChoice<ReadingFontId>;

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

/**
 * Declared here rather than beside the other finders because READING_FONTS is
 * built from it at module-evaluation time.
 */
export const findFont = (id: FontId): FontPreset => FONTS.find((font) => font.id === id) ?? FONTS[0]!;

/**
 * The stack message bodies have always been drawn in (SandboxedEmailBody).
 *
 * Kept as its own constant, and as the 'default' reading font, so that landing
 * this setting changes nothing for anyone who never opens it: the default is
 * not "the interface stack, near enough", it is the exact string the frame
 * already emitted.
 */
export const MAIL_SANS_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** The interface fonts a message body may ALSO be set in. 'system' is absent:
 *  it would be a second name for 'default' with a marginally different stack. */
const REUSED_READING_FONTS = ['inter', 'humanist', 'serif', 'mono'] as const satisfies readonly (FontId &
  ReadingFontId)[];

export const READING_FONTS: readonly ReadingFontPreset[] = [
  {
    id: 'default',
    label: 'Default',
    stack: MAIL_SANS_STACK,
    hint: 'The face mail is drawn in today.',
  },
  ...REUSED_READING_FONTS.map((id) => ({ ...findFont(id), id })),
] as const;

export const findReadingFont = (id: ReadingFontId): ReadingFontPreset =>
  READING_FONTS.find((font) => font.id === id) ?? READING_FONTS[0]!;

/** The CSS font-family a message body is drawn with. */
export const readingFontStack = (id: ReadingFontId): string => findReadingFont(id).stack;

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

/**
 * The message-body size scale. Narrower than zoom's at the bottom: shrinking
 * the chrome to 70% is a reasonable way to fit more list on screen, whereas
 * mail at 70% is simply mail nobody can read.
 */
export const READING_SIZE_MIN = 80;
export const READING_SIZE_MAX = 160;
export const READING_SIZE_STEP = 5;
export const READING_SIZE_DEFAULT = 100;

/**
 * Base body size in the Standard reading pane, and in a Chat View bubble,
 * BEFORE the reading size is applied. The bubble is a step down because its
 * shell already frames the message (see SandboxedEmailBody).
 */
export const READING_BASE_PX = 16;
export const CHAT_READING_BASE_PX = 15;

/**
 * Every default reproduces what the app did before the field existed, so an
 * install that never opens Appearance looks and behaves exactly as it did.
 */
export const defaultAppearance: Appearance = {
  theme: 'system',
  accent: 'sarv-blue',
  gradientAccents: false,
  font: 'system',
  density: 'cozy',
  zoom: ZOOM_DEFAULT,
  readingSize: READING_SIZE_DEFAULT,
  readingFont: 'default',
  snippetLines: 1,
  motion: 'system',
  hoverActions: true,
  buttonLabels: 'icons',
  darkenEmails: false,
};

/** A pickable option and the sentence the Settings screen explains it with. */
export interface AppearanceChoice<Id> {
  id: Id;
  label: string;
  hint: string;
}

export const MOTION_CHOICES: readonly AppearanceChoice<MotionMode>[] = [
  { id: 'system', label: 'System', hint: 'Follows your OS "reduce motion" setting.' },
  { id: 'full', label: 'Full', hint: 'Animate everything, whatever the OS asks for.' },
  { id: 'reduced', label: 'Off', hint: 'No animated transitions anywhere in the app.' },
];

export const SNIPPET_CHOICES: readonly AppearanceChoice<SnippetLines>[] = [
  { id: 0, label: 'None', hint: 'Sender and subject only — the most threads per screen.' },
  { id: 1, label: '1 line', hint: 'One line of the message under the subject.' },
  { id: 2, label: '2 lines', hint: 'Two lines. Single-line rows still show one.' },
];

export const BUTTON_LABEL_CHOICES: readonly AppearanceChoice<ButtonLabelMode>[] = [
  { id: 'icons', label: 'Icons', hint: 'Icon only; the name is in the tooltip.' },
  { id: 'text', label: 'Text', hint: "The action's name, without the icon." },
  { id: 'both', label: 'Both', hint: 'Icon and name together — widest, clearest.' },
];

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];
const ACCENT_IDS: readonly AccentId[] = ACCENTS.map((accent) => accent.id);
const FONT_IDS: readonly FontId[] = FONTS.map((font) => font.id);
const DENSITY_IDS: readonly DensityId[] = DENSITIES.map((density) => density.id);
const READING_FONT_IDS: readonly ReadingFontId[] = READING_FONTS.map((font) => font.id);
const MOTION_MODES: readonly MotionMode[] = MOTION_CHOICES.map((choice) => choice.id);
export const BUTTON_LABEL_MODES: readonly ButtonLabelMode[] = BUTTON_LABEL_CHOICES.map((choice) => choice.id);
export const SNIPPET_LINE_CHOICES: readonly SnippetLines[] = SNIPPET_CHOICES.map((choice) => choice.id);

const isSnippetLines = (value: unknown): value is SnippetLines =>
  typeof value === 'number' && (SNIPPET_LINE_CHOICES as readonly number[]).includes(value);

interface PercentScale {
  min: number;
  max: number;
  step: number;
  fallback: number;
}

const ZOOM_SCALE: PercentScale = { min: ZOOM_MIN, max: ZOOM_MAX, step: ZOOM_STEP, fallback: ZOOM_DEFAULT };
const READING_SIZE_SCALE: PercentScale = {
  min: READING_SIZE_MIN,
  max: READING_SIZE_MAX,
  step: READING_SIZE_STEP,
  fallback: READING_SIZE_DEFAULT,
};

/**
 * Snap a percentage to a scale's grid and range.
 *
 * Total, by design: it is fed values from localStorage, from a range <input>
 * and from a menu accelerator, any of which can be absent, a string, NaN or
 * wildly out of range. A zoom of 0 or 10000 is not a cosmetic bug — it is an
 * app the user cannot read well enough to fix the setting with.
 */
const clampPercent = (value: unknown, scale: PercentScale): number => {
  // Only a number, or a non-empty numeric string (what a range <input> hands
  // back), counts. Going through Number() alone would turn `null`, `''` and
  // `true` into finite values (0, 0, 1) and clamp them to the MINIMUM — an app
  // shrunk to 70% because a field was absent, rather than left at 100%.
  const asNumber =
    typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value)
    : NaN;
  if (!Number.isFinite(asNumber)) return scale.fallback;
  const snapped = Math.round(asNumber / scale.step) * scale.step;
  return Math.min(scale.max, Math.max(scale.min, snapped));
};

export const clampZoom = (zoom: unknown): number => clampPercent(zoom, ZOOM_SCALE);

export const clampReadingSize = (size: unknown): number => clampPercent(size, READING_SIZE_SCALE);

/** A base body size in px, scaled by the reading size, rounded to a whole px. */
export const readingFontSize = (basePx: number, readingSize: unknown): number =>
  Math.round((basePx * clampReadingSize(readingSize)) / 100);

/**
 * The two things a message body's typography needs, as one value.
 *
 * Exists so `buildIframeCss` takes ONE argument for the reader's typography
 * rather than a sixth and seventh positional boolean-ish parameter, and so the
 * "no preference" case is a named constant that provably equals what the frame
 * emitted before this setting existed.
 */
export interface ReadingTypography {
  /** Percent of the base size. */
  size: number;
  fontStack: string;
}

export const defaultReadingTypography: ReadingTypography = {
  size: READING_SIZE_DEFAULT,
  fontStack: MAIL_SANS_STACK,
};

export type ZoomCommand = 'in' | 'out' | 'reset';

/**
 * One nudge along a percent scale, clamped to it. The current value is clamped
 * BEFORE the step so a stored-but-impossible value can't walk out of range one
 * press at a time.
 */
const stepPercent = (value: number, command: ZoomCommand, scale: PercentScale, nudge: number): number => {
  if (command === 'reset') return scale.fallback;
  const delta = command === 'in' ? nudge : -nudge;
  return clampPercent(clampPercent(value, scale) + delta, scale);
};

/** What the View menu's zoom items do to the CURRENT zoom. */
export const stepZoom = (zoom: number, command: ZoomCommand): number =>
  stepPercent(zoom, command, ZOOM_SCALE, ZOOM_MENU_STEP);

/** What the Appearance screen's −/+ do to the CURRENT message-body size. */
export const stepReadingSize = (size: number, command: ZoomCommand): number =>
  stepPercent(size, command, READING_SIZE_SCALE, READING_SIZE_STEP);

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
    readingSize: clampReadingSize(stored.readingSize),
    readingFont: isOneOf(READING_FONT_IDS, stored.readingFont) ? stored.readingFont : defaultAppearance.readingFont,
    snippetLines: isSnippetLines(stored.snippetLines) ? stored.snippetLines : defaultAppearance.snippetLines,
    motion: isOneOf(MOTION_MODES, stored.motion) ? stored.motion : defaultAppearance.motion,
    hoverActions: typeof stored.hoverActions === 'boolean' ? stored.hoverActions : defaultAppearance.hoverActions,
    buttonLabels:
      isOneOf(BUTTON_LABEL_MODES, stored.buttonLabels) ? stored.buttonLabels : defaultAppearance.buttonLabels,
    darkenEmails: typeof stored.darkenEmails === 'boolean' ? stored.darkenEmails : defaultAppearance.darkenEmails,
  };
};

/** Anything that is not a plain object carries no fields worth reading. */
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Carry `hoverActions` and `buttonLabels` over from the legacy settings blob.
 *
 * Both used to live in `sarvinbox-settings` (AppSettings), where they were
 * written by the General tab and read by NOTHING — two switches that changed
 * nothing at all. Now that they are wired up they belong with the rest of the
 * appearance, which applies live and has its own key.
 *
 * Their old values still have to be honoured on the way across. Someone who
 * turned hover actions off was asking for them off; the setting merely never
 * delivered. Dropping the value on the floor would look like the app reverting
 * a preference the moment it started working.
 *
 * Only ever fills a field the appearance blob does not already carry, so it is
 * idempotent: once the appearance has been written once, the legacy blob is
 * ignored for good and a later edit here is never overwritten.
 */
export const mergeLegacyLayout = (storedAppearance: unknown, storedSettings: unknown): unknown => {
  const appearance = asRecord(storedAppearance);
  const settings = asRecord(storedSettings);
  const legacy: Record<string, unknown> = {};
  if (appearance.hoverActions === undefined && typeof settings.hoverActions === 'boolean') {
    legacy.hoverActions = settings.hoverActions;
  }
  if (appearance.buttonLabels === undefined && isOneOf(BUTTON_LABEL_MODES, settings.buttonLabels)) {
    legacy.buttonLabels = settings.buttonLabels;
  }
  return { ...appearance, ...legacy };
};

/** 'system' asks the OS; anything else is the user's explicit choice. */
export const resolveTheme = (mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme => {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersDark ? 'dark' : 'light';
};

const findAccent = (id: AccentId): AccentPreset =>
  ACCENTS.find((accent) => accent.id === id) ?? ACCENTS[0]!;

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
    '--reading-font': readingFontStack(appearance.readingFont),
    '--reading-size': `${readingFontSize(READING_BASE_PX, appearance.readingSize)}px`,
    // A count, not a length: `-webkit-line-clamp` takes the number directly,
    // and `[data-snippet='0']` hides the line rather than clamping it to zero
    // (a 0 clamp means "no clamp" to the engine, i.e. the whole body).
    '--snippet-lines': String(appearance.snippetLines),
    '--row-h': density.rowHeight,
    '--row-px': density.rowPaddingX,
    '--card-py': density.cardPaddingY,
    '--nav-py': density.navPaddingY,
  };
};
