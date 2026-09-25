// Remembering which screen the app is on across a renderer reload.
//
// `activeSection` in App.tsx is plain component state whose default is 'mail',
// so ANY reload of the renderer used to drop the user back on the inbox — from
// the View menu's Reload (Cmd+R, one key away from the Cmd +/- zoom items right
// below it), from a dev-server full reload, or from the error boundary's
// "reload the app". Someone three tabs deep in Settings lost their place with
// no idea why.
//
// sessionStorage, deliberately NOT localStorage:
//   - a RELOAD keeps the session, so the screen comes back — the whole point;
//   - a cold launch starts a new session, so the app still opens on the mailbox
//     rather than dumping you into whatever settings tab you closed it on.
// It is also outside the localStorage mirror in bootstrap/app-settings-sync.ts,
// which is right: this is ephemeral window state, not a durable app setting, and
// it has no business in the core DB.
//
// The store is injected so the decision logic is exercisable without a DOM; the
// two bound wrappers at the bottom are what the app actually calls.

import { APP_SECTIONS, type AppSection } from '../components/app-sections';

export const ACTIVE_SECTION_KEY = 'sarvinbox-active-section';

/** Where the app opens with nothing remembered: the mailbox. */
export const DEFAULT_SECTION: AppSection = 'mail';

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(APP_SECTIONS);

/** Whether a stored string still names a section this build renders. */
export const isAppSection = (value: unknown): value is AppSection =>
  typeof value === 'string' && KNOWN_SECTIONS.has(value);

/** The slice of `Storage` this module touches. */
export interface SectionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The section to open on, from a previous render of this same window.
 *
 * Every failure falls back to the mailbox rather than throwing: this runs
 * during App's first render, where a throw is a white screen. A value written
 * by an older build whose section no longer exists is treated the same as no
 * value at all — `renderContent` would otherwise fall through to `null` and
 * show an empty pane with no way back.
 */
export const readActiveSection = (store: SectionStore | null | undefined): AppSection => {
  if (!store) return DEFAULT_SECTION;
  try {
    const stored = store.getItem(ACTIVE_SECTION_KEY);
    return isAppSection(stored) ? stored : DEFAULT_SECTION;
  } catch {
    // Storage denied (a hardened profile, a sandboxed frame) — not worth a log
    // line on every boot, and the app is fully usable without the restore.
    return DEFAULT_SECTION;
  }
};

/** Record the section. Best-effort: a failed write only costs the restore. */
export const writeActiveSection = (
  store: SectionStore | null | undefined,
  section: AppSection,
): void => {
  if (!store) return;
  try {
    store.setItem(ACTIVE_SECTION_KEY, section);
  } catch {
    /* out of quota / denied — the app carries on, just without the restore */
  }
};

/** The real session store, or null anywhere it is unavailable (SSR, tests). */
const sessionStore = (): SectionStore | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Accessing the property itself throws when site data is blocked.
    return null;
  }
};

export const restoreActiveSection = (): AppSection => readActiveSection(sessionStore());

export const persistActiveSection = (section: AppSection): void =>
  writeActiveSection(sessionStore(), section);
