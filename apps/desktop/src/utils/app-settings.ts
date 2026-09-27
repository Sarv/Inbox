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
