/**
 * Cookies left by email content (CASA 6.6.1).
 *
 * Email bodies render inside the main window, whose webContents has no
 * partition (main-window-preferences.ts), so they share Electron's DEFAULT
 * session. Once the user clicks "Load images", every remote image, font or
 * media request in a message can set cookies there — trackers, mostly — and
 * that jar is persisted to disk under userData. Nothing the app does relies on
 * it:
 * - OAuth sign-in runs in the system browser; token and antivirus requests use
 *   Node's fetch, which has no Chromium cookie jar.
 * - Main-process `chromiumFetch` callers (AI providers, Sarv AI, the extension
 *   marketplace, update manifest, avatars, RDAP/reputation) authenticate with
 *   API keys or bearer tokens; any cookie they collect (a Cloudflare `__cf_bm`)
 *   is re-issued on the next response.
 * - Extension panels are served on `sarv-extension:`, which is not a cookie
 *   scheme, and their CSP allows no network beyond their own origin.
 * - The app's own pages load from file:// (or the dev server), cookie-free.
 *
 * Cookies cannot be attributed to an account — one jar serves every mailbox —
 * so removing ANY account clears the whole jar: what is in it was put there by
 * mail, and the removed mailbox's mail is part of it.
 */
import { createLogger } from '@sarvinbox/core';
import { session, type Session } from 'electron';

const logger = createLogger('email-content-cookies');

export type CookieJar = Pick<Session, 'clearStorageData'> & { cookies: Pick<Session['cookies'], 'flushStore'> };

/**
 * Clear every cookie in the session that renders email content, and flush the
 * deletion to disk (the cookie store otherwise persists lazily, so a crash
 * right after removal could leave the old file in place). Best effort: returns
 * false and logs on failure, never throws — the account's data is already gone
 * by the time this runs, and failing the removal over cookies would leave the
 * user unable to finish it.
 */
export async function clearEmailContentCookies(
  jar: () => CookieJar = () => session.defaultSession,
): Promise<boolean> {
  try {
    const target = jar();
    await target.clearStorageData({ storages: ['cookies'] });
    await target.cookies.flushStore();
    return true;
  } catch (error) {
    logger.warn(`[Accounts] Could not clear email-content cookies after account removal: ${(error as Error)?.message ?? String(error)}`);
    return false;
  }
}
