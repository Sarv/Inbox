/**
 * What remote images in email leave behind (CASA 6.6.1): cookies and the HTTP
 * cache.
 *
 * Email bodies render inside the main window, whose webContents has no
 * partition (main-window-preferences.ts), so they share Electron's DEFAULT
 * session. An image response can no longer set a cookie there, and a request no
 * longer sends one (email-image-requests.ts), but a jar written by an older
 * version still holds them, and every image that loads goes into the on-disk
 * HTTP cache under userData (measured on Electron 44: the bytes are in
 * `Cache/Cache_Data`). Nothing the app does relies on either:
 * - OAuth sign-in runs in the system browser; token and antivirus requests use
 *   Node's fetch, which has no Chromium cookie jar.
 * - Main-process `chromiumFetch` callers (AI providers, Sarv AI, the extension
 *   marketplace, update manifest, avatars, RDAP/reputation) authenticate with
 *   API keys or bearer tokens; any cookie they collect (a Cloudflare `__cf_bm`)
 *   is re-issued on the next response. Anything cached simply refetches.
 * - Extension panels are served on `sarv-extension:`, which is not a cookie
 *   scheme, and their CSP allows no network beyond their own origin.
 * - The app's own pages load from file:// (or the dev server), cookie-free.
 *
 * Neither can be attributed to an account — one jar and one cache serve every
 * mailbox, and a cached image's key names only its URL and the app's own page — so
 * removing ANY account clears both whole. The cost falls on the accounts that
 * stay: an image already seen refetches the next time its message is opened, which
 * its host sees as a fresh load (now without a cookie). Account removal is rare and
 * that cost is bounded; a removed mailbox's images staying on disk is neither.
 *
 * Blink also keeps decoded images in the renderer's memory until the renderer goes
 * away, which `clearCache` does not reach (measured): the same URL can still paint
 * in this run without a request. Nothing about it reaches the disk.
 */
import { createLogger, withTimeout } from '@sarvinbox/core';
import { session, type Session } from 'electron';

const logger = createLogger('email-content-cookies');

export type CookieJar = Pick<Session, 'clearStorageData'> & { cookies: Pick<Session['cookies'], 'flushStore'> };
export type HttpCache = Pick<Session, 'clearCache'>;

/**
 * How long removal waits for each clear. They measured instant on a small cache and
 * jar, but the removal is awaited behind the "Deleting…" state, and a session clear
 * that never settled is a real thing this app has seen (dev-session-reset.ts). A
 * clear that outlives this may still finish in the background; nothing waits for it.
 */
export const CONTENT_CLEAR_TIMEOUT_MS = 10_000;

/**
 * Clear every cookie in the session that renders email content, and flush the
 * deletion to disk (the cookie store otherwise persists lazily, so a crash
 * right after removal could leave the old file in place). Best effort: returns
 * false and logs on failure or a timeout, never throws — the account's data is
 * already gone by the time this runs, and failing the removal over cookies would
 * leave the user unable to finish it.
 */
export async function clearEmailContentCookies(
  jar: () => CookieJar = () => session.defaultSession,
): Promise<boolean> {
  try {
    const target = jar();
    const clearAndFlush = async (): Promise<void> => {
      await target.clearStorageData({ storages: ['cookies'] });
      await target.cookies.flushStore();
    };
    await withTimeout(clearAndFlush(), CONTENT_CLEAR_TIMEOUT_MS, 'timed out');
    return true;
  } catch (error) {
    logger.warn(`[Accounts] Could not clear email-content cookies after account removal: ${(error as Error)?.message ?? String(error)}`);
    return false;
  }
}

/**
 * Clear the HTTP cache of the session that renders email content. Best effort, for
 * the reason {@link clearEmailContentCookies} gives: returns false and logs on a
 * failure or a timeout, never throws.
 */
export async function clearEmailContentCache(
  cache: () => HttpCache = () => session.defaultSession,
): Promise<boolean> {
  try {
    await withTimeout(cache().clearCache(), CONTENT_CLEAR_TIMEOUT_MS, 'timed out');
    return true;
  } catch (error) {
    logger.warn(`[Accounts] Could not clear the email-content cache after account removal: ${(error as Error)?.message ?? String(error)}`);
    return false;
  }
}

/**
 * Everything remote images leave behind. Each is attempted whatever happens to the
 * other: a busy cookie store is no reason to leave a removed account's images on
 * disk, or the other way round. Run together, so the wait is the slower of the two
 * and at most {@link CONTENT_CLEAR_TIMEOUT_MS}. Never throws.
 */
export async function clearEmailContentData(
  target: () => CookieJar & HttpCache = () => session.defaultSession,
): Promise<{ cookies: boolean; cache: boolean }> {
  const [cookies, cache] = await Promise.all([clearEmailContentCookies(target), clearEmailContentCache(target)]);
  return { cookies, cache };
}
