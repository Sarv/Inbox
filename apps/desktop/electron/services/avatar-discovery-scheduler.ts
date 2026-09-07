/**
 * Avatar discovery — the (only) network part of confirm-gated contact avatars.
 *
 * Runs in the MAIN process, in the background, throttled. For contacts that have
 * never been checked (avatar_status IS NULL), it asks Gravatar ONCE whether a
 * real photo exists (`d=404` → a real picture or an HTTP 404, never a generic
 * identicon). A found photo is downloaded, encoded as a `data:` URI, and stored
 * as a PENDING candidate — the user then approves/declines it in the contact
 * detail pane. A miss just stamps `avatar_checked_at` so we don't refetch until
 * it goes stale.
 *
 * This is the whole reason display can stay 100% offline: the one-time fetch +
 * local cache happens here, never at render time. Contacts with a confirmed
 * photo already have a cached `data:` URI, so they're never re-fetched.
 */
import { createHash } from 'crypto';

import { createLogger } from '@sarvinbox/core';

import { getStorage, getMainWindow } from '../shared';
import { chromiumFetch } from './net-fetch';

const logger = createLogger('avatar-discovery');

const BATCH = 15;                                 // contacts probed per tick
const FIRST_TICK_MS = 45_000;                     // let initial sync settle first
const TICK_MS = 5 * 60_000;                       // then every 5 minutes
const STALE_MS = 30 * 24 * 60 * 60_000;           // re-probe a "no photo" contact monthly
const MAX_BYTES = 256 * 1024;                     // cap a cached avatar (~256 KB)

let firstTimeout: ReturnType<typeof setTimeout> | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Gravatar URL that returns a real photo or HTTP 404 (never an identicon). */
function gravatarPhotoUrl(email: string): string {
  const hash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=160&d=404`;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const storage = getStorage() as any;
    if (!storage?.getContactsNeedingAvatar) return; // no active account yet
    const staleBefore = Date.now() - STALE_MS;
    const contacts = await storage.getContactsNeedingAvatar(BATCH, staleBefore);
    if (!contacts?.length) return;

    let found = 0;
    for (const c of contacts) {
      try {
        const res = await chromiumFetch(gravatarPhotoUrl(c.email));
        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.startsWith('image/')) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 0 && buf.length <= MAX_BYTES) {
            await storage.setContactAvatarCandidate(c.id, `data:${ct};base64,${buf.toString('base64')}`);
            found++;
            continue;
          }
        }
        // 404 / non-image / oversized → remember we looked, so we don't refetch.
        await storage.markContactAvatarChecked(c.id);
      } catch {
        // Network hiccup — stamp checked so a broken run doesn't loop hot; the
        // monthly staleness window gives it another chance later.
        try { await storage.markContactAvatarChecked(c.id); } catch { /* ignore */ }
      }
    }

    if (found > 0) {
      logger.info(`[AvatarDiscovery] cached ${found} candidate photo(s)`);
      // Nudge the Contacts view to refresh so the pending prompt appears live.
      try { getMainWindow()?.webContents.send('contacts:avatars-updated'); } catch { /* window gone */ }
    }
  } catch (e) {
    logger.warn('[AvatarDiscovery] tick failed:', (e as Error)?.message);
  } finally {
    running = false;
  }
}

export function startAvatarDiscoveryScheduler(): void {
  if (tickInterval) return;
  firstTimeout = setTimeout(() => void tick(), FIRST_TICK_MS);
  tickInterval = setInterval(() => void tick(), TICK_MS);
  // unref both, like every sibling scheduler: a pending timer must never be the
  // reason the process stays alive during teardown.
  firstTimeout.unref?.();
  tickInterval.unref?.();
  logger.info('[AvatarDiscovery] scheduler started');
}

export function stopAvatarDiscoveryScheduler(): void {
  if (firstTimeout) { clearTimeout(firstTimeout); firstTimeout = null; }
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}
