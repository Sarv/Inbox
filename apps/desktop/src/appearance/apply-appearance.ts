/**
 * The DOM/Electron edge of the appearance feature.
 *
 * Everything that DECIDES anything lives in `appearance.ts`; this module only
 * writes the decision somewhere. The write targets are injected (`target`,
 * `setZoomFactor`) so the whole thing is exercisable in the node-env test suite
 * with a recording fake — the desktop suites have no DOM by default.
 */
import {
  appearanceCssVars,
  resolveTheme,
  zoomFactor,
  type Appearance,
  type ResolvedTheme,
} from './appearance';

/** The slice of `HTMLElement` this module touches. */
export interface AppearanceTarget {
  classList: { toggle(token: string, force: boolean): unknown };
  style: { setProperty(property: string, value: string): unknown };
  setAttribute(name: string, value: string): unknown;
}

/** Electron's `webFrame.setZoomFactor`, or a no-op outside Electron. */
export type ZoomFactorSetter = (factor: number) => void;

/**
 * Paint one appearance onto a root element.
 *
 * Order does not matter — every write is idempotent and independent — but the
 * `color-scheme` write does: without it Chromium keeps painting the native
 * scrollbars, `<select>` popups and form controls in light colours on a dark
 * page, which is the single most obvious "dark mode is half-done" tell.
 */
export const applyAppearance = (
  appearance: Appearance,
  resolved: ResolvedTheme,
  target: AppearanceTarget,
  setZoomFactor?: ZoomFactorSetter,
): void => {
  target.classList.toggle('dark', resolved === 'dark');
  target.style.setProperty('color-scheme', resolved);
  target.setAttribute('data-density', appearance.density);

  const vars = appearanceCssVars(appearance, resolved);
  for (const [name, value] of Object.entries(vars)) {
    target.style.setProperty(name, value);
  }

  // Zoom is NOT a CSS variable: it is Chromium's page zoom, the same one the
  // View menu and Cmd +/- drive, so a 90% here and a 90% from the keyboard are
  // the same state rather than two scales multiplying together.
  setZoomFactor?.(zoomFactor(appearance.zoom));
};

/** Convenience wrapper binding `applyAppearance` to the real document + Electron. */
export const applyAppearanceToDocument = (appearance: Appearance, systemPrefersDark: boolean): void => {
  if (typeof document === 'undefined') return;
  const setZoom = (window as any)?.electronAPI?.appearance?.setZoomFactor as ZoomFactorSetter | undefined;
  applyAppearance(
    appearance,
    resolveTheme(appearance.theme, systemPrefersDark),
    document.documentElement,
    setZoom ? (factor) => setZoom(factor) : undefined,
  );
};

/** Whether the OS is currently asking for dark. False anywhere without matchMedia. */
export const systemPrefersDark = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};
