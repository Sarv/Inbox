/**
 * Persistence + subscription for the appearance settings.
 *
 * Appearance is deliberately NOT part of the `sarvinbox-settings` blob the
 * Settings screen saves behind its "Save Changes" button. Two reasons:
 *
 *   1. It applies LIVE. A theme or density you have to remember to save is a
 *      theme you preview and then lose; and the View menu's Cmd +/- writes zoom
 *      from outside the Settings screen entirely.
 *   2. Settings.tsx saves its whole in-memory blob at once. Sharing the key
 *      would mean a zoom changed after the Settings screen loaded gets written
 *      back to its stale value the next time anything else is saved.
 *
 * Its own key gets the same durability regardless: `sarvinbox-appearance` is
 * registered in bootstrap/app-settings-sync.ts, so every write is mirrored into
 * the main-owned core DB and restored from it on a cleared profile.
 *
 * The renderer logs through raw `console.*` on purpose here — see
 * bootstrap/renderer-logging.ts, which tees it into app.log. Importing the core
 * logger would pull Node-only modules into the renderer bundle.
 */
import {
  defaultAppearance,
  normalizeAppearance,
  resolveTheme,
  stepZoom,
  type Appearance,
  type ResolvedTheme,
  type ZoomCommand,
} from './appearance';
import { applyAppearanceToDocument, systemPrefersDark } from './apply-appearance';

export const APPEARANCE_KEY = 'sarvinbox-appearance';

let current: Appearance | null = null;
const listeners = new Set<() => void>();

const readStored = (): Appearance => {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    return normalizeAppearance(raw ? JSON.parse(raw) : null);
  } catch (error) {
    // A corrupt blob must not leave the app unstyled — fall back to defaults and
    // say so, rather than throwing out of a module that runs before render.
    console.warn('[Appearance] Failed to read stored appearance, using defaults:', error);
    return { ...defaultAppearance };
  }
};

/** The current appearance. Stable identity between changes (safe for useSyncExternalStore). */
export const getAppearance = (): Appearance => {
  if (current === null) current = readStored();
  return current;
};

/** The theme actually in effect right now, with 'system' already resolved. */
export const getResolvedTheme = (): ResolvedTheme =>
  resolveTheme(getAppearance().theme, systemPrefersDark());

const notify = (): void => {
  for (const listener of listeners) listener();
};

const persist = (appearance: Appearance): void => {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
  } catch (error) {
    // Out of quota / denied storage: the change still applies for this session.
    console.warn('[Appearance] Failed to persist appearance:', error);
  }
};

/** Merge a partial change in, then persist → apply → notify. */
export const setAppearance = (patch: Partial<Appearance>): Appearance => {
  const next = normalizeAppearance({ ...getAppearance(), ...patch });
  current = next;
  persist(next);
  applyAppearanceToDocument(next, systemPrefersDark());
  notify();
  return next;
};

/** Back to the shipped defaults — the "Reset to defaults" button. */
export const resetAppearance = (): Appearance => setAppearance({ ...defaultAppearance });

export const subscribeAppearance = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Apply the stored appearance and keep it applied. Call once, before render.
 *
 * Wires two outside sources of change:
 *   - the OS colour scheme, which only matters while `theme` is 'system';
 *   - the View menu's zoom items, so Cmd +/- edits the SAME persisted zoom the
 *     Appearance tab shows instead of a parallel, forgotten-on-restart one.
 *
 * Returns a disposer. Nothing in the app tears appearance down today, but a
 * listener with no way off is how a hot-reloaded module ends up stacking them.
 */
export const initAppearance = (): (() => void) => {
  applyAppearanceToDocument(getAppearance(), systemPrefersDark());

  const disposers: Array<() => void> = [];

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = (): void => {
      // Re-apply unconditionally: when the mode is pinned to light/dark this is
      // a no-op, and the branch it saves would have to be kept in sync with
      // resolveTheme's own rule.
      applyAppearanceToDocument(getAppearance(), systemPrefersDark());
      notify();
    };
    query.addEventListener('change', onSystemThemeChange);
    disposers.push(() => query.removeEventListener('change', onSystemThemeChange));
  }

  const onZoomCommand = (window as any)?.electronAPI?.appearance?.onZoomCommand as
    | ((callback: (command: ZoomCommand) => void) => (() => void) | void)
    | undefined;
  if (typeof onZoomCommand === 'function') {
    const dispose = onZoomCommand((command) => {
      setAppearance({ zoom: stepZoom(getAppearance().zoom, command) });
    });
    if (typeof dispose === 'function') disposers.push(dispose);
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
};

/** Test seam: drop the cached appearance so the next read hits storage again. */
export const resetAppearanceCacheForTests = (): void => {
  current = null;
  listeners.clear();
};
