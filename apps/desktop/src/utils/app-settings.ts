/**
 * Reading the persisted app settings from OUTSIDE React.
 *
 * The settings screen owns the blob through its own hook; everything else —
 * a Zustand slice, a bootstrap module, a plain function — has to read
 * localStorage itself. Doing that inline is how a setting ends up written by
 * the UI and read by nobody: `undoSendDelay` sat in the blob for months while
 * the send path used a hardcoded 5s, so choosing 30 seconds did nothing at all.
 *
 * One safe reader, one place to look for who consumes a setting.
 */
import { defaultSettings, type AppSettings } from '../components/settings/types';
import { SETTINGS_KEY } from '../config/inbox-types';

/**
 * The stored settings merged over the defaults. Never throws: a corrupt or
 * absent blob reads as the defaults, because this runs on paths (sending mail)
 * where a parse error must not become a lost message.
 */
export function readAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw) as Partial<AppSettings> | null;
    if (!parsed || typeof parsed !== 'object') return defaultSettings;
    return { ...defaultSettings, ...parsed };
  } catch {
    return defaultSettings;
  }
}

/**
 * Settings a settings screen carries a copy of but does NOT own. Each is
 * changed on its own surface and written the moment the reader chooses, so a
 * screen's copy — loaded when it opened — can be stale by the time its Save is
 * clicked, and writing it back would silently revert the reader's choice.
 *
 *  - `remoteImageMode`: Security → Remote images (`saveRemoteImageMode`).
 *  - `reputation`: Security → Blocklists (read by core's `readBlocklistPrefs`).
 */
export const SETTINGS_OWNED_ELSEWHERE = ['remoteImageMode', 'reputation'] as const satisfies readonly (keyof AppSettings)[];

/**
 * The blob a settings screen's Save writes: its working copy, with every
 * setting another surface owns taken from what is stored NOW. A setting that is
 * not stored at all stays out, rather than being written from the screen's
 * defaults: that would look like a choice, and hide a legacy value the real
 * setting is still read from (the old `autoLoadRemoteImages` boolean). Pure —
 * `stored` is the parsed blob, or anything unreadable.
 */
export function settingsForSave(screen: AppSettings, stored: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = { ...screen };
  const current = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
  for (const key of SETTINGS_OWNED_ELSEWHERE) {
    if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
    else delete next[key];
  }
  return next;
}

/**
 * Write a settings screen's working copy (Settings, AI Settings) without
 * reverting a setting another surface owns — see {@link settingsForSave}.
 * An unreadable stored blob is replaced, as before: the screen could not have
 * loaded it either, so its copy is the defaults plus the reader's edits.
 */
export function saveSettingsFromScreen(screen: AppSettings): void {
  let stored: unknown = null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForSave(screen, stored)));
}

/** Widest undo window we honour, in seconds (5 minutes). The UI offers 5s-5m.
 *  A long window costs nothing in risk: the mail is persisted in the outbox
 *  before the window starts, so it survives a crash or quit either way — the
 *  window only decides WHEN it is transmitted. */
const MAX_UNDO_SEND_SECONDS = 300;

/**
 * The undo-send window in milliseconds, from the stored `undoSendDelay`
 * (seconds). Pure, so the clamp is testable without localStorage.
 *
 * A non-numeric or out-of-range value falls back to the default rather than
 * to zero: the hold is what makes the send durable before transmission, and a
 * NaN timeout would fire immediately, which is the one behaviour the undo
 * window exists to prevent.
 */
export function undoSendDelayMs(seconds: unknown): number {
  const value = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : defaultSettings.undoSendDelay;
  return Math.min(Math.max(Math.round(value), 1), MAX_UNDO_SEND_SECONDS) * 1000;
}

/** The configured undo-send window, in milliseconds. */
export function readUndoSendDelayMs(): number {
  return undoSendDelayMs(readAppSettings().undoSendDelay);
}
