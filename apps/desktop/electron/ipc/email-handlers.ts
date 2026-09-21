/**
 * Email IPC Handlers
 *
 * Handles email operations: listing, getting, searching, marking, moving, deleting.
 */

import * as fs from 'fs';

import { fetchBodyQueued, withFolderSelected, resolveWithinDir, sanitizeIcsText, createLogger, setEmailReadFlag, applyReadFlagCountDelta, hasCidRefs, isPreviewableAttachment, isTrashFolder, findFolderByType, buildImapSearchCriteria, hasServerSearchableCriteria, type ParsedSearchQuery } from '@sarvinbox/core';
import { ipcMain, dialog, shell } from 'electron';
import ICAL from 'ical.js';

import { resolveAccountTarget } from '../services/account-target';
import { attachmentCacheDir, attachmentErrorMessage, resolveAttachmentFile } from '../services/attachment-cache';
import {
  deferBodyPrefetch,
  startManualBodyDownload,
  stopManualBodyDownload,
  getManualBodyDownloadState,
} from '../services/body-prefetch-scheduler';
import { getHeaderBackfillState, kickHeaderBackfill } from '../services/header-backfill';
import { reportSenderVerdict } from '../services/spam-reputation-service';
import { applyUserSpamVerdict } from '../services/spam-verdict-actions';
import { getSyncEngine, getMainWindow, requireStorage, requireSyncEngine } from '../shared';

import { logUserAction } from './agent-handlers';

const logger = createLogger('email-handlers');


/**
 * Emails whose body was re-fetched this session to repair a `cid:` image.
 *
 * A `cid:` reference that survives a parse is usually unresolvable — the sender
 * referenced a part that isn't in the message — so without this the mail would
 * re-download its full source on EVERY open, forever, and never look different.
 * Session-scoped on purpose: a new launch runs new parsing code, which is the
 * only thing that could change the outcome.
 */
const cidRepairAttempts = new Set<string>();

/** Cap on the set above; a long session must not accumulate ids without bound. */
export const CID_REPAIR_MEMORY = 500;

/**
 * Decide whether this stored body is worth re-fetching to resolve a `cid:`
 * image, RECORDING the attempt so it is only ever made once per email.
 *
 * Mutates `attempted` — that bookkeeping is the point. Exported (with the set
 * passed in) so the once-only rule can be tested without a module singleton.
 */
export function claimCidRepairAttempt(
  rawBody: string | null | undefined,
  emailId: string,
  attempted: Set<string>,
): boolean {
  if (!hasCidRefs(rawBody)) return false;
  if (attempted.has(emailId)) return false;
  // Simplest bound that cannot leak: at the cap, forget everything. The cost of
  // being wrong is one extra re-fetch of a mail opened 500 opens ago.
  if (attempted.size >= CID_REPAIR_MEMORY) attempted.clear();
  attempted.add(emailId);
  return true;
}

// Sentinel stored in `emails.calendar_ics` meaning "inspected for a calendar
// invite, found none" — so a non-invite email is checked once, never refetched.
// A real invite stores its ICS text; null means "not yet checked".
const CALENDAR_CHECKED_NONE = '';

/**
 * Rewrite a meeting-invitation ICS into a PLAIN personal event for "Add to
 * calendar", so the OS calendar adds it directly (like Google) instead of
 * prompting Accept/Maybe/Decline.
 *
 * Three things make macOS Calendar treat this as an RSVP invitation (and NOT a
 * plain event), so we neutralize all three:
 *  1. METHOD:REQUEST — an invitation awaiting a reply. → set METHOD:PUBLISH.
 *  2. The user appearing in the ATTENDEE list ("an invite to ME"). This forces
 *     the Accept/Maybe/Decline prompt even with METHOD:PUBLISH. → drop the
 *     ORGANIZER and ATTENDEE properties, leaving a plain event (SUMMARY, times,
 *     location, description, UID) that imports silently.
 *  3. The UID matching an invitation Calendar ALREADY holds. Calendar keys
 *     events by UID and merges by it — so if you'd previously declined this
 *     invite, re-importing under the same UID just re-shows that greyed/declined
 *     event ("nothing was added"). → give the plain copy a distinct, STABLE UID
 *     (fixed prefix) so it lands as a fresh event, yet re-adds map to the same
 *     copy (no duplicates).
 *
 * Uses ical.js (isomorphic, already a dep) to parse → mutate → re-serialize,
 * rather than line regex + manual iCalendar unfolding: property removal is a
 * one-liner on the parsed tree, and toString() re-emits spec-correct CRLF-folded
 * output. Falls back to the original text if the ICS can't be parsed (so the OS
 * still gets something rather than nothing).
 */
function toPlainEventIcs(ics: string): string {
  try {
    const comp = new ICAL.Component(ICAL.parse(ics));
    // 1. Published event, not an RSVP request.
    comp.updatePropertyWithValue('method', 'PUBLISH');
    for (const vevent of comp.getAllSubcomponents('vevent')) {
      // 2. Drop the invitation participants so Calendar doesn't treat this as
      //    "an invite to me" and force the Accept/Maybe/Decline prompt.
      vevent.removeAllProperties('attendee');
      vevent.removeAllProperties('organizer');
      // 3. Distinct, STABLE uid so it never merges into a declined invitation
      //    Calendar already holds under the original uid (yet re-adds map to the
      //    same copy — no duplicates).
      const uidProp = vevent.getFirstProperty('uid');
      const uid = uidProp?.getFirstValue();
      if (uidProp && typeof uid === 'string' && !uid.startsWith('sarvinbox-')) {
        uidProp.setValue(`sarvinbox-${uid}`);
      }
    }
    return comp.toString();
  } catch {
    // Unparseable ICS — hand the original to the OS rather than nothing.
    return ics;
  }
}

// Reject a single attachment larger than this before writing it to disk. Guards
// against a malicious/oversized attachment exhausting disk (the 500 MB cache cap
// below only prunes AFTER the fact). Most providers cap sending well under this.
/**
 * The virtual lists that head themselves with an "of N", and the storage
 * counter behind each. One map so the IPC, its callers and the storage can't
 * drift on which count belongs to which view.
 */
const VIRTUAL_FOLDER_COUNTERS = {
  all: 'getAllCount',
  starred: 'getStarredCount',
  important: 'getImportantCount',
  snoozed: 'getSnoozedCount',
} as const;

type VirtualFolderCountKey = keyof typeof VIRTUAL_FOLDER_COUNTERS;

/**
 * Parse search operators from query string
 */
function parseSearchOperators(query: string): {
  from?: string;
  to?: string;
  subject?: string;
  hasAttachments?: boolean;
  isUnread?: boolean;
  isFlagged?: boolean;
  folderIds?: string[];
  dateFrom?: number;
  dateTo?: number;
  sizeMin?: number;
  sizeMax?: number;
  doesntHave?: string;
  textQuery: string;
} {
  const result: ReturnType<typeof parseSearchOperators> = { textQuery: '' };
  let remaining = query;

  // Parse from:
  const fromMatch = remaining.match(/from:(?:"([^"]+)"|(\S+))/i);
  if (fromMatch) {
    result.from = fromMatch[1] || fromMatch[2];
    remaining = remaining.replace(fromMatch[0], '');
  }

  // Parse to:
  const toMatch = remaining.match(/to:(?:"([^"]+)"|(\S+))/i);
  if (toMatch) {
    result.to = toMatch[1] || toMatch[2];
    remaining = remaining.replace(toMatch[0], '');
  }

  // Parse subject:
  const subjectMatch = remaining.match(/subject:(?:"([^"]+)"|(\S+))/i);
  if (subjectMatch) {
    result.subject = subjectMatch[1] || subjectMatch[2];
    remaining = remaining.replace(subjectMatch[0], '');
  }

  // Parse has:attachment
  if (/has:attachment/i.test(remaining)) {
    result.hasAttachments = true;
    remaining = remaining.replace(/has:attachment/gi, '');
  }

  // Parse is:unread / is:read
  if (/is:unread/i.test(remaining)) {
    result.isUnread = true;
    remaining = remaining.replace(/is:unread/gi, '');
  }
  if (/is:read/i.test(remaining)) {
    result.isUnread = false;
    remaining = remaining.replace(/is:read/gi, '');
  }

  // Parse is:starred / is:flagged
  if (/is:starred/i.test(remaining) || /is:flagged/i.test(remaining)) {
    result.isFlagged = true;
    remaining = remaining.replace(/is:starred/gi, '').replace(/is:flagged/gi, '');
  }

  // Parse in:/label: (folder filter)
  const labelMatch = remaining.match(/(?:in:|label:)(?:"([^"]+)"|(\S+))/i);
  if (labelMatch) {
    const label = (labelMatch[1] || labelMatch[2]).toLowerCase();
    if (label === 'inbox') {
      result.folderIds = ['INBOX'];
    } else if (label === 'sent') {
      result.folderIds = ['Sent', '[Gmail]/Sent Mail', 'Sent Items'];
    } else if (label === 'starred') {
      result.isFlagged = true;
    } else if (label === 'unread') {
      result.isUnread = true;
    }
    remaining = remaining.replace(labelMatch[0], '');
  }

  // Parse after:/before: (date filters)
  const afterMatch = remaining.match(/after:(\d{4}-\d{2}-\d{2})/i);
  if (afterMatch) {
    result.dateFrom = Math.floor(new Date(afterMatch[1]).getTime() / 1000);
    remaining = remaining.replace(afterMatch[0], '');
  }

  const beforeMatch = remaining.match(/before:(\d{4}-\d{2}-\d{2})/i);
  if (beforeMatch) {
    result.dateTo = Math.floor(new Date(beforeMatch[1]).getTime() / 1000);
    remaining = remaining.replace(beforeMatch[0], '');
  }

  // Parse larger:/smaller: (size filters)
  const largerMatch = remaining.match(/larger:(\d+)([mk]?)/i);
  if (largerMatch) {
    let bytes = parseInt(largerMatch[1]);
    const unit = largerMatch[2]?.toLowerCase();
    if (unit === 'm') bytes *= 1024 * 1024;
    else if (unit === 'k') bytes *= 1024;
    result.sizeMin = bytes;
    remaining = remaining.replace(largerMatch[0], '');
  }

  const smallerMatch = remaining.match(/smaller:(\d+)([mk]?)/i);
  if (smallerMatch) {
    let bytes = parseInt(smallerMatch[1]);
    const unit = smallerMatch[2]?.toLowerCase();
    if (unit === 'm') bytes *= 1024 * 1024;
    else if (unit === 'k') bytes *= 1024;
    result.sizeMax = bytes;
    remaining = remaining.replace(smallerMatch[0], '');
  }

  // Parse negated terms (-word) as doesntHave
  const negatedTerms: string[] = [];
  remaining = remaining.replace(/-(\S+)/g, (_match, word) => {
    negatedTerms.push(word);
    return '';
  });
  if (negatedTerms.length > 0) {
    (result as any).doesntHave = negatedTerms.join(' ');
  }

  result.textQuery = remaining.replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Shared core for user-initiated Move / Copy to an ARBITRARY folder (the toolbar
 * and bulk-bar pickers). Single source of truth so move and copy — and their
 * single vs bulk callers — can't drift apart on the delicate tag/UID handling.
 *
 * - MOVE removes the source-folder tag and repoints `folderId` to the destination.
 * - COPY leaves the source untouched and just ADDS the destination tag, so the
 *   message ends up in BOTH folders (on Gmail this is "also apply this label").
 *
 * The local DB is updated synchronously (instant UI); the IMAP op is enqueued
 * fire-and-forget (persist-first, replays on reconnect) after resolving the real
 * UID by Message-ID. Caller is responsible for recounting folders once at the end.
 */
async function placeEmailInFolder(
  storage: ReturnType<typeof requireStorage>,
  syncEngine: ReturnType<typeof getSyncEngine>,
  email: any,
  sourceFolder: any,
  destFolder: any,
  mode: 'move' | 'copy',
): Promise<void> {
  // 1. Local DB (instant UI feedback).
  let tags = email.tags || '';
  if (mode === 'move' && sourceFolder?.path && tags.includes('|' + sourceFolder.path + '|')) {
    tags = tags.replace('|' + sourceFolder.path + '|', '|');
  }
  if (destFolder.path && !tags.includes('|' + destFolder.path + '|')) {
    const list = tags.split('|').filter(Boolean);
    list.push(destFolder.path);
    tags = '|' + list.join('|') + '|';
  }
  const patch: any = { tags };
  if (mode === 'move') patch.folderId = destFolder.id; // copy KEEPS the source placement
  await storage.updateEmail(email.id, patch);

  // 2. Background IMAP op — enqueue REGARDLESS of connection state (the queue
  //    persists it and replays on reconnect; gating on isConnected() would
  //    silently drop offline moves that a later resync then reverts). Resolve the
  //    real UID by Message-ID when connected (the stored UID can be stale after a
  //    prior move); offline, fall back to the stored uid so the op still queues.
  if (!sourceFolder) return;
  const pool = (syncEngine as any)?.connectionPool;
  const opQueue = (syncEngine as any)?.operationQueue;
  void (async () => {
    try {
      let uid = email.uid;
      if (syncEngine?.isConnected() && pool && email.messageId) {
        const { client: conn, release } = await pool.acquire();
        try {
          const msgId = email.messageId.replace(/^<|>$/g, '');
          const uids = await withFolderSelected<number[]>(conn, sourceFolder.path, () =>
            conn.search({ header: [{ name: 'Message-ID', value: msgId }] }));
          if (uids.length > 0) {
            uid = uids[0];
          } else {
            logger.warn(`[Main] Message-ID ${msgId} not found in ${sourceFolder.path}, skipping IMAP ${mode}`);
            return;
          }
        } finally {
          release();
        }
      }
      if (uid) {
        if (mode === 'move') await opQueue?.move(sourceFolder.path, uid, destFolder.path);
        else await opQueue?.copy(sourceFolder.path, uid, destFolder.path);
      }
    } catch (err) {
      logger.error(`[Main] IMAP ${mode} failed:`, err);
    }
  })();
}

/** Resolve + validate an email and a destination folder, then place it (move/copy). */
async function moveOrCopyOne(
  storage: ReturnType<typeof requireStorage>,
  syncEngine: ReturnType<typeof getSyncEngine>,
  emailId: string,
  destinationFolderId: string,
  mode: 'move' | 'copy',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = await storage.getEmail(emailId);
  if (!email) return { ok: false, error: 'Email not found' };
  const destFolder = await storage.getFolder(destinationFolderId);
  if (!destFolder) return { ok: false, error: 'Destination folder not found' };
  const sourceFolder = await storage.getFolder(email.folderId);
  await placeEmailInFolder(storage, syncEngine, email, sourceFolder, destFolder, mode);
  return { ok: true };
}

/**
 * Report a bulk verdict to the reputation service once per sender domain —
 * a thread of forty messages from one sender is one opinion, not forty.
 * Gated inside reportSenderVerdict by the user's opt-in.
 */
function reportVerdictsOnce(emails: Array<{ fromAddress?: string | null; originIp?: string | null }>, verdict: 'spam' | 'ham'): void {
  const seen = new Set<string>();
  for (const e of emails) {
    const at = (e.fromAddress || '').lastIndexOf('@');
    const domain = at >= 0 ? (e.fromAddress || '').slice(at + 1).trim().toLowerCase() : '';
    const key = domain || e.originIp || '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    reportSenderVerdict({ domain: domain || null, ip: e.originIp ?? null, verdict });
  }
}

export function registerEmailHandlers(): void {
  // Remote-image sender allowlist (per active account). The renderer caches the
  // full set for its synchronous block-vs-load decision, so this only needs an
  // "add" and a "list".
  ipcMain.handle('images:allowSender', async (_event, address: string) => {
    try { await requireStorage().allowSenderImages(address); return { success: true }; }
    catch (error) { return { success: false, error: (error as Error).message }; }
  });
  ipcMain.handle('images:getAllowedSenders', async () => {
    try { return { success: true, data: await requireStorage().getImageAllowedSenders() }; }
    catch (error) { return { success: false, error: (error as Error).message }; }
  });
  ipcMain.handle('images:disallowSender', async (_event, address: string) => {
    try { await requireStorage().disallowSenderImages(address); return { success: true }; }
    catch (error) { return { success: false, error: (error as Error).message }; }
  });

  // Link trust/block rules (per active account) — the security indicator and
  // the phishing banner consult these; the Security page lists and revokes them.
  ipcMain.handle('security:listLinkRules', async () => {
    try { return { success: true, data: await requireStorage().listLinkDomainRules() }; }
    catch (error) { return { success: false, error: (error as Error).message }; }
  });
  ipcMain.handle('security:addLinkRule', async (_event, rule: { senderDomain: string; shownDomain: string; actualDomain: string; verdict: 'trust' | 'block' }) => {
    try {
      if (rule?.verdict !== 'trust' && rule?.verdict !== 'block') return { success: false, error: 'verdict must be trust or block' };
      await requireStorage().addLinkDomainRule(rule);
      return { success: true };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });
  // Auth-header backfill: progress for the Security page, and a manual kick.
  ipcMain.handle('security:getHeaderBackfillState', async () => {
    try { return { success: true, data: getHeaderBackfillState() }; }
    catch (error) { return { success: false, error: (error as Error).message }; }
  });
  ipcMain.handle('security:kickHeaderBackfill', async () => {
    try { kickHeaderBackfill(); return { success: true, data: getHeaderBackfillState() }; }
    catch (error) { return { success: false, error: (error as Error).message }; }
  });
  ipcMain.handle('security:removeLinkRule', async (_event, id: number) => {
    try { await requireStorage().removeLinkDomainRule(Number(id)); return { success: true }; }
    catch (error) { return { success: false, error: (error as Error).message }; }
  });

  /**
   * Get emails from folder
   */
  ipcMain.handle('emails:list', async (_event, folderId: string, limit = 100, offset = 0) => {
    try {
      const storage = requireStorage();
      const syncEngine = getSyncEngine();

      const folder = await storage.getFolder(folderId);
      const folderPath = folder?.path?.toLowerCase() || '';

      // Handle virtual folders (Gmail's Starred)
      if (folderPath.includes('starred') || folderPath.includes('star')) {
        logger.info('[Main] Loading starred emails (virtual folder)');

        // Sync starred in background
        if (syncEngine && syncEngine.isConnected()) {
          (async () => {
            try {
              const client = (syncEngine as any).client;
              const folders = await storage.getFolders();
              let searchFolder = folders.find((f: any) =>
                f.path === '[Gmail]/Starred' || f.path.toLowerCase().includes('/starred')
              );
              if (!searchFolder) {
                searchFolder = folders.find((f: any) => f.path === 'INBOX');
              }

              if (searchFolder) {
                // SEARCH and the FETCH of its hits are one section — the UIDs it
                // returns are only meaningful in the mailbox that produced them.
                const messages = await withFolderSelected(client, searchFolder.path, async () => {
                  const isStarredFolder = searchFolder.path.toLowerCase().includes('starred');
                  const starredUIDs = isStarredFolder
                    ? await client.search({ all: true })
                    : await client.search({ flagged: true });
                  if (starredUIDs.length === 0) return [];
                  return client.fetchMessagesByUID(starredUIDs.slice(-100), { bodies: ['HEADER'] });
                });

                for (const msg of messages) {
                  if (msg.envelope?.messageId) {
                    const existing = await storage.getEmailByMessageId(msg.envelope.messageId);
                    if (existing && !(existing.flags || []).includes('\\Flagged')) {
                      await storage.updateEmail(existing.id, {
                        flags: [...(existing.flags || []), '\\Flagged']
                      });
                    }
                  }
                }
              }
            } catch (err) {
              logger.error('[Main] Background starred sync error:', err);
            }
          })();
        }

        const emails = await storage.searchEmails({
          query: '',
          isFlagged: true,
          limit,
          offset,
          sortBy: 'date',
          sortOrder: 'desc',
        });
        return { success: true, data: emails };
      }

      // Folder views (Sent, custom folders) show a FLAT per-message list — one row
      // per mail, with a message-level "of N" count that matches the server (and
      // webmail). Thread-collapsing here was confusing (a Sent folder read as
      // conversations, with a message-vs-thread "1-54 of 44" count). Collapsing is
      // kept only for the sectioned inbox, which is thread-based by design.
      const emails = await storage.getEmailsByFolder(folderId, { limit, offset });
      return { success: true, data: emails };
    } catch (error) {
      logger.error('List emails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get email by ID
   */
  ipcMain.handle('emails:get', async (_event, emailId: string) => {
    try {
      const storage = requireStorage();
      const syncEngine = getSyncEngine();

      let email = await storage.getEmail(emailId);

      // Fetch body from IMAP if empty
      if (email && !email.rawBody && syncEngine?.isConnected()) {
        try {
          const folder = await storage.getFolder(email.folderId);
          if (folder && email.uid) {
            await syncEngine.fetchBody(emailId, folder.path, email.uid);
            email = await storage.getEmail(emailId);
          }
        } catch (fetchError) {
          logger.error('[Main] Failed to fetch body from IMAP:', fetchError);
        }
      }

      return { success: true, data: email };
    } catch (error) {
      logger.error('Get email error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Start a manual body download over the unread backlog.
   *
   * The background prefetch already drains this queue, but at a cadence built
   * for not disturbing anyone — 200 bodies a minute when there is a backlog,
   * and a ten-minute sleep once it thinks it is done. A user looking at
   * "Unread + no body yet: 757" wants those bodies NOW so the AI can work on
   * them, and had no way to say so.
   *
   * `target` is a budget, not a promise: the run stops early if the backlog
   * drains, and a throttled server still backs the scheduler off.
   */
  ipcMain.handle('emails:startBodyDownload', async (_event, target: number) => {
    try {
      const state = startManualBodyDownload(target);
      if (!state.active) {
        // The scheduler is not running — almost always "no account connected
        // yet". Saying so beats a button that silently does nothing.
        return { success: false, error: 'Body download is not available yet — no connected account.' };
      }
      logger.info(`[Bodies] manual download started: target ${state.target}`);
      return { success: true, data: state };
    } catch (error) {
      logger.error('Start body download error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /** Cancel a manual body download. Background prefetch continues as normal. */
  ipcMain.handle('emails:stopBodyDownload', async () => {
    try {
      return { success: true, data: stopManualBodyDownload() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Progress of a manual body download, for a renderer that just mounted. */
  ipcMain.handle('emails:getBodyDownloadState', async () => {
    try {
      return { success: true, data: getManualBodyDownloadState() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Fetch email body on-demand
   */
  ipcMain.handle('emails:fetchBody', async (_event, emailId: string, accountId?: string) => {
    try {
      // User is actively opening/reading this email — pause background body
      // prefetch briefly so its download gets IMAP connection priority.
      deferBodyPrefetch();

      // Unified view: read/fetch from the email's own account (DB + engine).
      const { storage, syncEngine } = await resolveAccountTarget(accountId);

      const email = await storage.getEmail(emailId);
      if (!email) {
        return { success: false, error: 'Email not found' };
      }

      // Re-fetch the source even when the body is cached if we still owe this
      // email accurate attachment metadata. Keyed on attachmentSizes (null
      // until the source has been parsed by the current code) so legacy rows
      // whose filename is the bogus "SIZE" still refresh and downloads match.
      const needsAttachmentMeta = email.hasAttachments && !email.attachmentSizes;

      // A stored body still carrying `cid:` references was parsed before cid
      // resolution existed, or by a mailparser that declined the part (see
      // cid-images.ts). The raw source is not kept, so the substitution can only
      // happen on a fresh parse — which means a re-fetch is the only repair.
      const repairingCid =
        !!email.rawBody &&
        !needsAttachmentMeta &&
        claimCidRepairAttempt(email.rawBody, emailId, cidRepairAttempts);

      if (email.rawBody && !needsAttachmentMeta && !repairingCid) {
        return { success: true, data: email };
      }

      // When the re-fetch exists ONLY to repair an image, its failure must never
      // take away a body the user already has: fall back to the stored one, with
      // one broken image, rather than an error where the mail used to be.
      const failed = (error: string) =>
        repairingCid ? { success: true, data: email } : { success: false, error };

      if (!syncEngine || !syncEngine.isConnected()) {
        return failed('Not connected to IMAP');
      }

      const folder = await storage.getFolder(email.folderId);
      if (!folder || !email.uid) {
        return failed('Cannot determine folder/UID');
      }

      const fetchResult = await syncEngine.fetchBody(emailId, folder.path, email.uid);
      if (fetchResult === null) {
        // Don't use "not found" / "deleted" / "moved" in error — the store interprets
        // those keywords as "deleted on server" and removes the email locally.
        // A null result could be a transient fetch issue, not necessarily deletion.
        return failed('Body fetch returned empty result');
      }

      const updatedEmail = await storage.getEmail(emailId);
      return { success: true, data: updatedEmail };
    } catch (error) {
      logger.error('[Main] Fetch email body error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Fetch the full raw RFC822 source of one message for "Show Original".
   * The app discards the true source at import (keeps only the HTML body), so
   * this re-fetches it from the server on demand. Returns success:false with a
   * reason when it can't (offline / no UID) so the UI falls back to the
   * enriched local reconstruction.
   */
  ipcMain.handle('emails:getRawSource', async (_event, emailId: string) => {
    try {
      deferBodyPrefetch();

      const storage = requireStorage();
      const syncEngine = requireSyncEngine();

      const email = await storage.getEmail(emailId);
      if (!email) {
        return { success: false, error: 'Email not found' };
      }
      if (!syncEngine.isConnected()) {
        return { success: false, error: 'Not connected to IMAP' };
      }
      const folder = await storage.getFolder(email.folderId);
      if (!folder || !email.uid) {
        return { success: false, error: 'Cannot determine folder/UID' };
      }

      const source = await syncEngine.getRawSource(emailId, folder.path, email.uid);
      return { success: true, data: source };
    } catch (error) {
      logger.error('[Main] Get raw source error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Fetch bodies for multiple emails in batch
   * Fires all fetches concurrently and sends progressive IPC updates
   */
  ipcMain.handle('emails:fetchBodiesBatch', async (_event, emailIds: string[]) => {
    try {
      const storage = requireStorage();
      const syncEngine = requireSyncEngine();
      const mainWindow = getMainWindow();

      if (!syncEngine.isConnected()) {
        return { success: false, error: 'Not connected to IMAP' };
      }

      // When the connection drops mid-batch (a reconnect during a heavy sync),
      // EVERY in-flight fetchBody rejects at the same instant. Without a guard
      // that produced hundreds of identical ERROR lines and swallowed the reason.
      // Once we see a connection-level failure, short-circuit the rest of the
      // batch (they'd all fail too) and surface ONE aggregated reason. The
      // skipped bodies stay header-only and are re-fetched lazily on open.
      let connectionLost = false;
      const failures: string[] = [];
      const isConnectionError = (msg: string): boolean =>
        /not connected|connection (not available|closed|lost)|econnreset|socket|ended|closed unexpectedly/i.test(msg);

      // Prepare all fetch promises concurrently
      const fetchPromises = emailIds.map(async (emailId) => {
        try {
          if (connectionLost) return null;
          const email = await storage.getEmail(emailId);
          if (!email) return null;
          if (email.rawBody) return email;

          const folder = await storage.getFolder(email.folderId);
          if (!folder || !email.uid) return null;

          if (connectionLost) return null;
          // fetchBody resolves with the parsed body fields; reuse them instead
          // of re-reading the full row from the DB right after persisting it.
          // Queue-aware deadline (see `fetchBodyQueued`): this is a BATCH, so a
          // flat timeout from enqueue expires the tail while the head downloads
          // — every thread open past the first few bodies logged "N/N failed:
          // Timeout" on a slow server even though the fetches were fine.
          const fetchResult = await fetchBodyQueued(syncEngine, emailId, folder.path, email.uid);
          if (!fetchResult) return null;

          const updatedEmail = {
            ...email,
            rawBody: fetchResult.rawBody,
            cleanBody: fetchResult.cleanBody,
            contentType: fetchResult.contentType,
          };

          // Send progressive update to renderer immediately
          if (mainWindow) {
            mainWindow.webContents.send('body:fetched', updatedEmail);
          }

          return updatedEmail;
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          if (isConnectionError(msg)) connectionLost = true;
          failures.push(msg);
          return null;
        }
      });

      // Wait for all to settle. The renderer applies bodies from the streamed
      // `body:fetched` events above — it only reads `.length` off this reply —
      // so return ids/count instead of re-serializing every full HTML body a
      // second time.
      const results = await Promise.allSettled(fetchPromises);
      // One aggregated line per batch instead of N per-item ERRORs. A connection
      // drop mid-download is transient (a reconnect follows), so it's a WARN, not
      // an ERROR — the bodies just load on open.
      if (failures.length > 0) {
        const [firstReason] = failures;
        logger.warn(
          `[Main] fetchBodiesBatch: ${failures.length}/${emailIds.length} body fetch(es) failed` +
          `${connectionLost ? ' (connection lost mid-batch — remaining skipped, will load on open)' : ''}: ${firstReason}`
        );
      }
      const fetchedIds = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value.id);

      return { success: true, data: fetchedIds };
    } catch (error) {
      logger.error('[Main] Batch fetch bodies error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Download bodies for latest N emails that are missing bodies (background, latest first)
   */
  ipcMain.handle('emails:downloadBodies', async (_event, limit: number = 500, opts?: { unreadOnly?: boolean }) => {
    try {
      const storage = requireStorage();
      const syncEngine = requireSyncEngine();
      const mainWindow = getMainWindow();

      if (!syncEngine.isConnected()) {
        return { success: false, error: 'Not connected to IMAP' };
      }

      const unreadOnly = opts?.unreadOnly === true;
      const ids = unreadOnly
        ? (storage as any).getUnreadEmailIdsWithoutBody(limit)
        : storage.getEmailIdsWithoutBody(limit);
      if (ids.length === 0) {
        return { success: true, data: { downloaded: 0 } };
      }

      logger.info(`[Main] Background body download: ${ids.length} emails (limit=${limit})`);

      // Process in batches of 50 to avoid overwhelming IMAP
      const BATCH = 50;
      let downloaded = 0;

      for (let i = 0; i < ids.length; i += BATCH) {
        const batch: string[] = ids.slice(i, i + BATCH);

        const promises = batch.map(async (emailId: string) => {
          try {
            const email = await storage.getEmail(emailId);
            if (!email || email.rawBody) return null;

            const folder = await storage.getFolder(email.folderId);
            if (!folder || !email.uid) return null;

            // Same queue-aware deadline as the batch above — this path submits
            // 50 at a time, so it is the worst offender for enqueue-time clocks.
            const fetchResult = await fetchBodyQueued(syncEngine, emailId, folder.path, email.uid);
            if (!fetchResult) return null;

            // Reuse the freshly-parsed body fields rather than re-reading the
            // full row we just wrote.
            const updated = {
              ...email,
              rawBody: fetchResult.rawBody,
              cleanBody: fetchResult.cleanBody,
              contentType: fetchResult.contentType,
            };
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('body:fetched', updated);
            }
            return updated;
          } catch {
            return null;
          }
        });

        const results = await Promise.allSettled(promises);
        downloaded += results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
      }

      logger.info(`[Main] Background body download complete: ${downloaded}/${ids.length}`);
      return { success: true, data: { downloaded } };
    } catch (error) {
      logger.error('[Main] Background body download error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get thread emails
   */
  ipcMain.handle('emails:thread', async (_event, threadId: string, accountId?: string) => {
    try {
      // Unified view: read the thread from the row's own account DB.
      const { storage } = await resolveAccountTarget(accountId);
      const emails = await storage.getEmailsByThread(threadId);
      return { success: true, data: emails };
    } catch (error) {
      logger.error('Get thread error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Rebuild threads
   */
  ipcMain.handle('threads:rebuild', async () => {
    try {
      const storage = requireStorage();
      const result = await storage.rebuildThreads();
      return { success: true, data: result };
    } catch (error) {
      logger.error('Rebuild threads error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Repair broken thread_ids by walking in_reply_to / references chains
   * and falling back to subject + participant + time-window matching
   * (Gmail-style). Pass { dryRun: true } to see the diff without
   * touching data.
   */
  ipcMain.handle('threads:repair', async (_event, options: { dryRun?: boolean } = {}) => {
    try {
      const storage = requireStorage();
      const result = await storage.repairThreading({ dryRun: options.dryRun !== false });
      return { success: true, data: result };
    } catch (error) {
      logger.error('Repair threads error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get all emails
   */
  ipcMain.handle('emails:getAll', async (_event, limit = 100, offset = 0) => {
    try {
      const storage = requireStorage();
      const emails = await storage.getAllEmails({ limit, offset });
      return { success: true, data: emails };
    } catch (error) {
      logger.error('Get all emails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get important emails
   */
  ipcMain.handle('emails:getImportant', async (_event, limit = 100, offset = 0) => {
    try {
      const storage = requireStorage();
      const emails = await storage.getImportantEmails({ limit, offset });
      return { success: true, data: emails };
    } catch (error) {
      logger.error('Get important emails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get starred emails
   */
  ipcMain.handle('emails:getStarred', async (_event, limit = 100, offset = 0) => {
    try {
      const storage = requireStorage();
      const emails = await storage.getStarredEmails({ limit, offset });
      return { success: true, data: emails };
    } catch (error) {
      logger.error('Get starred emails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get virtual folder counts
   */
  ipcMain.handle('emails:getVirtualFolderCounts', async (_event, keys?: VirtualFolderCountKey[]) => {
    try {
      const storage = requireStorage() as any;
      // COUNT(*) instead of materializing up to 1000 rows each just to read
      // `.length` (which also silently capped the counts at 1000).
      // `all` and `snoozed` are the "of N" denominators for the All Email and
      // Snoozed listings, which otherwise page with no total at all.
      //
      // `keys` narrows the work: each of these is an unindexable instr(tags)
      // scan, and a paginator asking for ONE total must not pay for four. Omit
      // it (the sidebar) to get them all.
      const wanted = keys?.length ? keys : (Object.keys(VIRTUAL_FOLDER_COUNTERS) as VirtualFolderCountKey[]);
      const counted = await Promise.all(
        wanted.map(async (key) => [key, await storage[VIRTUAL_FOLDER_COUNTERS[key]]()] as const),
      );
      return {
        success: true,
        data: Object.fromEntries(counted) as Partial<Record<VirtualFolderCountKey, number>>,
      };
    } catch (error) {
      logger.error('Get virtual folder counts error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get emails by section filter (per-section independent pagination)
   */
  ipcMain.handle('emails:listBySection', async (_event, filter: string, limit: number, offset: number, folderPath?: string, viewFilter?: any) => {
    try {
      const storage = requireStorage() as any;
      const emails = await storage.getEmailsBySection(filter, { limit, offset, folderPath, viewFilter });
      return { success: true, data: emails };
    } catch (error) {
      logger.error('List by section error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get counts for multiple section filters
   */
  ipcMain.handle('emails:sectionCounts', async (_event, filters: string[], folderPath?: string, viewFilter?: any) => {
    try {
      const storage = requireStorage() as any;
      const counts = await storage.getSectionCounts(filters, folderPath, viewFilter);
      return { success: true, data: counts };
    } catch (error) {
      logger.error('Section counts error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Thread-grained "of N" total for a plain folder view — matches getByFolder's
  // read-model (thread) pagination. data is null when the read-model isn't ready
  // (getByFolder then paginates by message, so the renderer keeps the legacy
  // message-count total).
  ipcMain.handle('emails:folderThreadCount', async (_event, folderPath?: string, viewFilter?: any) => {
    try {
      const storage = requireStorage() as any;
      const count = await storage.getFolderThreadCount(folderPath, viewFilter);
      return { success: true, data: count };
    } catch (error) {
      logger.error('Folder thread count error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Search emails
   */
  ipcMain.handle('emails:search', async (_event, query: string) => {
    try {
      const storage = requireStorage();
      const parsed = parseSearchOperators(query);

      const emails = await storage.searchEmails({
        query: parsed.textQuery,
        from: parsed.from,
        to: parsed.to,
        subject: parsed.subject,
        hasAttachments: parsed.hasAttachments,
        isUnread: parsed.isUnread,
        isFlagged: parsed.isFlagged,
        dateFrom: parsed.dateFrom,
        dateTo: parsed.dateTo,
        doesntHave: parsed.doesntHave,
        sizeMin: parsed.sizeMin,
        sizeMax: parsed.sizeMax,
        limit: 100,
        offset: 0,
        sortBy: parsed.textQuery ? 'relevance' : 'date',
        sortOrder: 'desc',
      });

      return { success: true, data: emails };
    } catch (error) {
      logger.error('Search emails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Server-side search escalation. The renderer searches the LOCAL index first;
   * when that's thin (or the user explicitly asks), it calls here to run an IMAP
   * UID SEARCH on the server and pull the newest missing matches into the local
   * DB — after which the renderer just re-runs its normal local search and the
   * new rows appear. Returns a summary so the UI can report what turned up.
   *
   * Scoped to one folder (defaults to INBOX): imapflow's SEARCH acts on the
   * selected mailbox. `skipped:true` means the query had nothing the server can
   * act on (e.g. a pure has:attachment / category filter) — no round-trip made.
   */
  ipcMain.handle(
    'emails:searchServer',
    async (
      _event,
      params: { query: ParsedSearchQuery; folderId?: string; accountId?: string; maxFetch?: number },
    ) => {
      try {
        const { storage, syncEngine } = await resolveAccountTarget(params.accountId);
        if (!syncEngine) return { success: false, error: 'No sync engine for account' };
        if (typeof (syncEngine as any).serverSearch !== 'function') {
          return { success: false, error: 'Server search unsupported' };
        }

        let folderPath = 'INBOX';
        if (params.folderId) {
          const folder = await storage.getFolder(params.folderId);
          if (folder?.path) folderPath = folder.path;
        }

        const criteria = buildImapSearchCriteria(params.query ?? {});
        if (!hasServerSearchableCriteria(criteria)) {
          return { success: true, data: { skipped: true, matched: 0, alreadyLocal: 0, inserted: 0, folderPath } };
        }

        const result = await (syncEngine as any).serverSearch(folderPath, criteria, { maxFetch: params.maxFetch });
        if (!result) {
          return { success: false, error: 'Server search unavailable (offline or busy)' };
        }
        return { success: true, data: { skipped: false, ...result, folderPath } };
      } catch (error) {
        logger.error('Server search error:', error);
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /**
   * Mark email as read/unread
   */
  ipcMain.handle('emails:markRead', async (_event, emailId: string, read: boolean, accountId?: string) => {
    try {
      // Route to the row's own account (unified view) or the active one.
      const { storage, syncEngine } = await resolveAccountTarget(accountId);

      const email = await storage.getEmail(emailId);
      if (!email) {
        return { success: false, error: 'Email not found' };
      }

      // Flip the tag AND maintain the folder unread badge in one shared step: a
      // read toggle only moves this email's thread in/out of the unread set of
      // the folders it's tagged in, and never changes a message count, so the
      // helper adjusts just those folders' unread_count by +/-1 (indexed,
      // thread-scoped) instead of a full-table recount — and only when the flag
      // actually flipped. Awaited so the renderer's follow-up loadFolders()
      // reads the fresh counts. The full recount on sync stays the backstop.
      await setEmailReadFlag(storage, emailId, read, 'markRead IPC');

      // Log action for agent learning
      logUserAction(emailId, read ? 'read' : 'unread', {
        threadId: email.threadId,
        senderAddress: email.fromAddress,
      });

      // Sync to IMAP via the operation queue. Enqueue REGARDLESS of connection
      // state — the queue persists the op (savePendingOperation) and executes it
      // on reconnect. Gating on isConnected() silently dropped read/unread
      // changes made while offline, so the flag never reached the server
      // (matching the markStarred path below).
      if (syncEngine) {
        try {
          const folder = await storage.getFolder(email.folderId);
          if (folder && email.uid) {
            if (read) {
              syncEngine.markAsRead(folder.path, email.uid).catch(console.error);
            } else {
              syncEngine.markAsUnread(folder.path, email.uid).catch(console.error);
            }
          }
        } catch (syncError) {
          logger.error('[Main] Failed to queue read state:', syncError);
        }
      }

      return { success: true };
    } catch (error) {
      logger.error('Mark read error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Mark email as starred/unstarred
   */
  ipcMain.handle('emails:markStarred', async (_event, emailId: string, starred: boolean, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);

      const email = await storage.getEmail(emailId);
      if (!email) {
        return { success: false, error: 'Email not found' };
      }

      const tags = email.tags || '||';
      const isCurrentlyStarred = tags.includes('|starred|');

      if (starred && !isCurrentlyStarred) {
        const tagList = tags.split('|').filter((t: string) => t.length > 0);
        tagList.push('starred');
        await storage.updateEmail(emailId, { tags: '|' + tagList.join('|') + '|' });
      } else if (!starred && isCurrentlyStarred) {
        const tagList = tags.split('|').filter((t: string) => t.length > 0 && t !== 'starred');
        await storage.updateEmail(emailId, { tags: tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||' });
      }

      // Log action for agent learning
      logUserAction(emailId, starred ? 'star' : 'unstar', {
        threadId: email.threadId,
        senderAddress: email.fromAddress,
      });

      // Sync to IMAP via the operation queue. NOTE: enqueue REGARDLESS of
      // connection state — the queue persists the op (savePendingOperation)
      // and executes it on reconnect. Gating on isConnected() silently
      // dropped star/unstar changes made while offline (or during the brief
      // reconnect windows), so the flag never reached the server.
      if (syncEngine) {
        try {
          const folder = await storage.getFolder(email.folderId);
          if (folder && email.uid) {
            syncEngine.markAsStarred(folder.path, email.uid, starred).catch(console.error);
          }
        } catch (syncError) {
          logger.error('[Main] Failed to queue starred state:', syncError);
        }
      }

      return { success: true };
    } catch (error) {
      logger.error('Mark starred error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Mark email as important/not important (local tag only, no IMAP sync)
   */
  ipcMain.handle('emails:markImportant', async (_event, emailId: string, important: boolean) => {
    try {
      const storage = requireStorage();

      const email = await storage.getEmail(emailId);
      if (!email) {
        return { success: false, error: 'Email not found' };
      }

      const tags = email.tags || '||';
      const isCurrentlyImportant = tags.includes('|important|');

      if (important && !isCurrentlyImportant) {
        const tagList = tags.split('|').filter((t: string) => t.length > 0);
        tagList.push('important');
        await storage.updateEmail(emailId, { tags: '|' + tagList.join('|') + '|' });
      } else if (!important && isCurrentlyImportant) {
        const tagList = tags.split('|').filter((t: string) => t.length > 0 && t !== 'important');
        await storage.updateEmail(emailId, { tags: tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||' });
      }

      // Log action for agent learning
      logUserAction(emailId, important ? 'important' : 'unimportant', {
        threadId: email.threadId,
        senderAddress: email.fromAddress,
      });

      return { success: true };
    } catch (error) {
      logger.error('Mark important error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Sync starred emails from server
   */
  ipcMain.handle('emails:syncStarred', async () => {
    try {
      const storage = requireStorage();
      const syncEngine = requireSyncEngine();

      if (!syncEngine.isConnected()) {
        return { success: false, error: 'Not connected to IMAP' };
      }

      const client = (syncEngine as any).client;
      const folders = await storage.getFolders();

      let searchFolder = folders.find((f: any) =>
        f.path === '[Gmail]/Starred' || f.path.toLowerCase().includes('/starred')
      );
      if (!searchFolder) {
        searchFolder = folders.find((f: any) =>
          f.path.toLowerCase().includes('all mail') || f.path === '[Gmail]/All Mail'
        );
      }
      if (!searchFolder) {
        searchFolder = folders.find((f: any) => f.path === 'INBOX');
      }

      if (!searchFolder) {
        return { success: false, error: 'No suitable folder found for starred sync' };
      }

      // SEARCH and the FETCH of its hits are one section — the UIDs it returns
      // are only meaningful in the mailbox that produced them.
      const { starredUIDs, messages } = await withFolderSelected(client, searchFolder.path, async () => {
        const isStarredFolder = searchFolder.path.toLowerCase().includes('starred');
        const uids: number[] = isStarredFolder
          ? await client.search({ all: true })
          : await client.search({ flagged: true });
        return {
          starredUIDs: uids,
          messages: uids.length > 0
            ? await client.fetchMessagesByUID(uids, { bodies: ['HEADER'] })
            : [],
        };
      });

      let updatedCount = 0;
      for (const msg of messages) {
        if (msg.envelope?.messageId) {
          const existing = await storage.getEmailByMessageId(msg.envelope.messageId);
          if (existing && !(existing.flags || []).includes('\\Flagged')) {
            await storage.updateEmail(existing.id, {
              flags: [...(existing.flags || []), '\\Flagged']
            });
            updatedCount++;
          }
        }
      }

      return { success: true, data: { synced: starredUIDs.length, updated: updatedCount } };
    } catch (error) {
      logger.error('Sync starred error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Move email to folder
   * Local-first: update DB immediately for instant UI, then queue IMAP in background.
   */
  ipcMain.handle('emails:moveToFolder', async (_event, emailId: string, destinationFolderId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      const res = await moveOrCopyOne(storage, syncEngine, emailId, destinationFolderId, 'move');
      if (!res.ok) return { success: false, error: res.error };
      // Recount once. Await so the renderer's follow-up loadFolders() reads fresh
      // counts instead of racing this recompute; errors swallowed (a recount
      // hiccup must never fail the operation).
      try { await storage.recalculateFolderCounts(); } catch (err) { logger.error('[email-handlers] recalculateFolderCounts failed:', err); }
      return { success: true };
    } catch (error) {
      logger.error('Move to folder error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Copy email to an arbitrary folder — the message stays in its current folder
   * AND appears in the destination (on Gmail: also applies that label).
   */
  ipcMain.handle('emails:copyToFolder', async (_event, emailId: string, destinationFolderId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      const res = await moveOrCopyOne(storage, syncEngine, emailId, destinationFolderId, 'copy');
      if (!res.ok) return { success: false, error: res.error };
      try { await storage.recalculateFolderCounts(); } catch (err) { logger.error('[email-handlers] recalculateFolderCounts failed:', err); }
      return { success: true };
    } catch (error) {
      logger.error('Copy to folder error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /** Bulk Move / Copy many emails to one destination folder (toolbar/bulk-bar picker). */
  ipcMain.handle('emails:bulkMoveToFolder', async (_event, emailIds: string[], destinationFolderId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      let moved = 0;
      for (const id of emailIds) {
        const res = await moveOrCopyOne(storage, syncEngine, id, destinationFolderId, 'move');
        if (res.ok) moved++;
      }
      try { await storage.recalculateFolderCounts(); } catch (err) { logger.error('[email-handlers] recalculateFolderCounts failed:', err); }
      return { success: true, data: { moved } };
    } catch (error) {
      logger.error('Bulk move to folder error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('emails:bulkCopyToFolder', async (_event, emailIds: string[], destinationFolderId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      let copied = 0;
      for (const id of emailIds) {
        const res = await moveOrCopyOne(storage, syncEngine, id, destinationFolderId, 'copy');
        if (res.ok) copied++;
      }
      try { await storage.recalculateFolderCounts(); } catch (err) { logger.error('[email-handlers] recalculateFolderCounts failed:', err); }
      return { success: true, data: { copied } };
    } catch (error) {
      logger.error('Bulk copy to folder error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /** Mailbox storage quota (bytes) for the account, or null when unavailable. */
  ipcMain.handle('account:getQuota', async (_event, accountId?: string) => {
    try {
      const { syncEngine } = await resolveAccountTarget(accountId);
      const quota = syncEngine ? await syncEngine.getQuota() : null;
      return { success: true, data: quota };
    } catch (error) {
      logger.error('getQuota error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Move email to trash
   */
  ipcMain.handle('emails:moveToTrash', async (_event, emailId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);

      const email = await storage.getEmail(emailId);
      if (!email) {
        return { success: false, error: 'Email not found' };
      }

      // Find trash folder (exact classification, not a path substring).
      const folders = await storage.getFolders();
      const trashFolder = findFolderByType(folders as any, 'trash') as any;

      if (!trashFolder) {
        return { success: false, error: 'Trash folder not found' };
      }

      // 1. Update local DB immediately (instant UI feedback)
      const sourceFolder = await storage.getFolder(email.folderId);
      let tags = email.tags || '';
      if (sourceFolder?.path && tags.includes('|' + sourceFolder.path + '|')) {
        tags = tags.replace('|' + sourceFolder.path + '|', '|');
      }
      if (!tags.includes('|' + trashFolder.path + '|')) {
        const list = tags.split('|').filter(Boolean);
        list.push(trashFolder.path);
        tags = '|' + list.join('|') + '|';
      }

      await storage.updateEmail(emailId, { folderId: trashFolder.id, tags });

      // Recount folder unread (thread-based)
      // Await so the renderer's follow-up loadFolders() reads the fresh counts
      // instead of racing this recompute (fire-and-forget could be read stale,
      // stranding the sidebar badge). Errors are swallowed — a recount hiccup
      // must never fail the operation itself.
      try {
        await storage.recalculateFolderCounts();
      } catch (err) {
        logger.error('[email-handlers] recalculateFolderCounts failed:', err);
      }

      // Track deletion in sender stats for engagement metrics
      if (email.fromAddress) {
        storage.upsertSenderStats({ email: email.fromAddress, deletedCount: 1 }).catch(() => { });
      }

      // Log action for agent learning
      logUserAction(emailId, 'delete', {
        threadId: email.threadId,
        senderAddress: email.fromAddress,
        actionValue: JSON.stringify({ destination: trashFolder.path }),
      });

      // 2. Queue IMAP operation in background (fire-and-forget). Enqueue
      // REGARDLESS of connection state — the operationQueue persists the op and
      // replays it on reconnect (gating on isConnected() dropped offline
      // actions). Source folder + source uid are captured above, before the
      // updateEmail() that changed folderId.
      if (email.uid && sourceFolder) {
        const opQueue = (syncEngine as any)?.operationQueue;
        opQueue?.moveToTrash(sourceFolder.path, email.uid).catch((err: any) => {
          logger.error('[Main] IMAP trash move failed:', err);
        });
      }

      return { success: true };
    } catch (error) {
      logger.error('Move to trash error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Move email to spam — the user's verdict. The local re-file, the queued
   * server move, the spammer list, the stored verdict and the (opt-in) report
   * all live in applyUserSpamVerdict, shared with Not spam and the Spam tab.
   */
  ipcMain.handle('emails:moveToSpam', async (_event, emailId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      const outcome = await applyUserSpamVerdict({
        storage,
        queue: (syncEngine as any)?.operationQueue ?? null,
        report: (r) => reportSenderVerdict(r),
      }, emailId, 'spam');
      if (!outcome.success || !outcome.email) return { success: false, error: outcome.error ?? 'Email not found' };

      // Log action for agent learning
      logUserAction(emailId, 'spam', {
        threadId: outcome.email.threadId,
        senderAddress: outcome.email.fromAddress,
      });
      return { success: true };
    } catch (error) {
      logger.error('Move to spam error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Move email from spam back to inbox — "Not spam". Same shared action; the
   * stored 'ham' verdict keeps the filter from ever filing it again.
   */
  ipcMain.handle('emails:moveFromSpam', async (_event, emailId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      const outcome = await applyUserSpamVerdict({
        storage,
        queue: (syncEngine as any)?.operationQueue ?? null,
        report: (r) => reportSenderVerdict(r),
      }, emailId, 'ham');
      return outcome.success ? { success: true } : { success: false, error: outcome.error ?? 'Email not found' };
    } catch (error) {
      logger.error('Move from spam error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Archive email
   */
  ipcMain.handle('emails:archive', async (_event, emailId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);

      const email = await storage.getEmail(emailId);
      if (!email) {
        return { success: false, error: 'Email not found' };
      }

      const folders = await storage.getFolders();
      const archiveFolder = findFolderByType(folders as any, 'archive') as any;

      if (!archiveFolder) {
        return { success: false, error: 'Archive folder not found' };
      }

      // 1. Update local DB immediately (instant UI feedback)
      const srcFolder = await storage.getFolder(email.folderId);
      let tags = email.tags || '';
      if (srcFolder?.path && tags.includes('|' + srcFolder.path + '|')) {
        tags = tags.replace('|' + srcFolder.path + '|', '|');
      }
      if (!tags.includes('|' + archiveFolder.path + '|')) {
        const list = tags.split('|').filter(Boolean);
        list.push(archiveFolder.path);
        tags = '|' + list.join('|') + '|';
      }

      await storage.updateEmail(emailId, { folderId: archiveFolder.id, tags });

      // Recount folder unread (thread-based)
      // Await so the renderer's follow-up loadFolders() reads the fresh counts
      // instead of racing this recompute (fire-and-forget could be read stale,
      // stranding the sidebar badge). Errors are swallowed — a recount hiccup
      // must never fail the operation itself.
      try {
        await storage.recalculateFolderCounts();
      } catch (err) {
        logger.error('[email-handlers] recalculateFolderCounts failed:', err);
      }

      // Log action for agent learning
      logUserAction(emailId, 'archive', {
        threadId: email.threadId,
        senderAddress: email.fromAddress,
      });

      // 2. Queue IMAP operation in background (fire-and-forget). Enqueue
      // REGARDLESS of connection state — the operationQueue persists the op and
      // replays it on reconnect (gating on isConnected() dropped offline
      // actions). Source folder + source uid are captured above, before the
      // updateEmail() that changed folderId.
      if (email.uid && srcFolder) {
        const opQueue = (syncEngine as any)?.operationQueue;
        opQueue?.archive(srcFolder.path, email.uid).catch((err: any) => {
          logger.error('[Main] IMAP archive move failed:', err);
        });
      }

      return { success: true };
    } catch (error) {
      logger.error('Archive email error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Permanently delete email
   */
  ipcMain.handle('emails:delete', async (_event, emailId: string, accountId?: string) => {
    try {
      const { storage, syncEngine } = await resolveAccountTarget(accountId);

      const email = await storage.getEmail(emailId);
      if (!email) {
        return { success: false, error: 'Email not found' };
      }

      // Track deletion in sender stats for engagement metrics
      if (email.fromAddress) {
        storage.upsertSenderStats({ email: email.fromAddress, deletedCount: 1 }).catch(() => { });
      }

      // Log action for agent learning (before deletion removes the record)
      logUserAction(emailId, 'delete', {
        threadId: email.threadId,
        senderAddress: email.fromAddress,
      });

      // 1. Delete from local storage immediately (instant UI feedback)
      await storage.deleteEmail(emailId);

      // Recount folder unread (thread-based)
      // Await so the renderer's follow-up loadFolders() reads the fresh counts
      // instead of racing this recompute (fire-and-forget could be read stale,
      // stranding the sidebar badge). Errors are swallowed — a recount hiccup
      // must never fail the operation itself.
      try {
        await storage.recalculateFolderCounts();
      } catch (err) {
        logger.error('[email-handlers] recalculateFolderCounts failed:', err);
      }

      // 2. Queue IMAP delete in background (fire-and-forget). Enqueue REGARDLESS
      // of connection state — the operationQueue persists the expunge and
      // replays it on reconnect. Gating on isConnected() destroyed the local row
      // offline while never queuing the server-side delete, so a full resync
      // re-created the message. `email` was read before deleteEmail(), so
      // email.folderId + email.uid are the source location.
      if (email.uid) {
        const folder = await storage.getFolder(email.folderId);
        if (folder) {
          const opQueue = (syncEngine as any)?.operationQueue;
          opQueue?.delete(folder.path, email.uid).catch((err: any) => {
            logger.error('[Main] IMAP delete failed:', err);
          });
        }
      }

      return { success: true };
    } catch (error) {
      logger.error('Delete email error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get recent emails (for signature detection)
   */
  ipcMain.handle('emails:getRecent', async (_event, options: { minutes?: number; limit?: number } = {}) => {
    try {
      const storage = requireStorage();
      const minutes = options.minutes || 60;
      const limit = options.limit || 50;
      const sinceTimestamp = Math.floor(Date.now() / 1000) - minutes * 60;

      const emails = await storage.getRecentEmails({ sinceTimestamp, limit });
      return { success: true, data: emails };
    } catch (error) {
      logger.error('Get recent emails error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Download an email attachment — cache on disk, then show save dialog
   */
  ipcMain.handle(
    'emails:downloadAttachment',
    async (_event, emailId: string, filename: string, accountId?: string) => {
    try {
      const mainWindow = getMainWindow();

      const { filePath: cachedPath } = await resolveAttachmentFile({ emailId, filename, accountId });

      // Show save dialog and copy from cache
      const dialogOptions: Electron.SaveDialogOptions = {
        defaultPath: filename,
        filters: [{ name: 'All Files', extensions: ['*'] }],
      };

      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Save cancelled' };
      }

      await fs.promises.copyFile(cachedPath, result.filePath);

      return { success: true, filePath: result.filePath };
    } catch (error) {
      logger.error('[Main] Download attachment error:', error);
      return { success: false, error: attachmentErrorMessage(error) };
    }
  },
  );

  /**
   * Get attachment as base64 string for forwarding
   */
  ipcMain.handle(
    'emails:getAttachmentBase64',
    async (_event, emailId: string, filename: string, accountId?: string) => {
      try {
        const { filePath } = await resolveAttachmentFile({ emailId, filename, accountId });
        const buffer = await fs.promises.readFile(filePath);

        return { success: true, base64: buffer.toString('base64') };
      } catch (error) {
        logger.error('Get attachment base64 error:', error);
        return { success: false, error: attachmentErrorMessage(error) };
      }
    },
  );

  /**
   * Get the raw iCalendar (.ics) text for an email's calendar invite, so the
   * detail view can render a Gmail-style event card.
   *
   * Fast path: the invite is already captured on the email row (populated at
   * body-fetch) — return it straight from the DB, no IMAP. Fallback (legacy mail
   * whose body was cached before this feature): re-fetch the named `.ics`
   * attachment from IMAP, sanity-check, and backfill the row so subsequent opens
   * are offline. Returns `{ ics: null }` (not an error) when the email has no
   * invite.
   */
  ipcMain.handle('emails:getCalendarInvite', async (_event, emailId: string, accountId?: string) => {
    try {
      if (typeof emailId !== 'string' || !emailId) {
        return { success: false, error: 'Invalid emailId' };
      }
      // Route to the email's OWNING account (falls back to active). In All
      // Inboxes the opened mail can belong to a non-active account, so
      // requireStorage() (active account) missed it → "Email not found".
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      const email = await storage.getEmail(emailId);
      if (!email) return { success: false, error: 'Email not found' };

      // Already captured — parse from DB (no IMAP round-trip, works offline).
      const stored = sanitizeIcsText(email.calendarIcs);
      if (stored) return { success: true, ics: stored };

      // Empty-string sentinel = "already checked, no invite". Set below so a
      // non-invite email is inspected once and never re-fetched.
      if (email.calendarIcs === CALENDAR_CHECKED_NONE) return { success: true, ics: null };

      // Legacy fallback (mail synced before capture landed): extract the calendar
      // part from the message SOURCE. This catches both a named .ics AND the
      // unnamed inline text/calendar part (which has no filename, so an
      // attachment-name/flag check misses it entirely). Source is served from the
      // raw-source cache when the email is on screen. Then persist the result —
      // the real ICS on a hit, the sentinel on a miss — so the next open needs no
      // fetch either way.
      const folder = await storage.getFolder(email.folderId);
      if (!folder || !email.uid || !syncEngine) return { success: true, ics: null };

      const ics = sanitizeIcsText(await syncEngine.getCalendarIcs(emailId, folder.path, email.uid));
      try {
        await storage.updateEmail(emailId, { calendarIcs: ics ?? CALENDAR_CHECKED_NONE });
      } catch (err) {
        logger.warn('[Main] getCalendarInvite: backfill failed (non-fatal):', err);
      }
      return { success: true, ics: ics ?? null };
    } catch (error) {
      logger.error('[Main] getCalendarInvite error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * "Add to calendar": hand the invite's .ics to the OS default calendar app via
   * shell.openPath. Prefers a real named .ics attachment (cached file); falls
   * back to writing the captured ICS text to a temp .ics in the attachment cache.
   *
   * shell.openPath resolves with '' on success, or an error string when the OS
   * has no handler registered for .ics (common on headless/minimal Linux, and
   * possible on Windows without a calendar app). That is surfaced as
   * `{ success: false, noHandler: true }` so the renderer can offer to save the
   * .ics instead — never assume the macOS "Calendar.app always present" path.
   */
  ipcMain.handle('emails:openCalendarInvite', async (_event, emailId: string, accountId?: string) => {
    try {
      if (typeof emailId !== 'string' || !emailId) {
        return { success: false, error: 'Invalid emailId' };
      }
      // Owning-account routing — otherwise "Add to calendar" on an All-Inboxes
      // mail from a non-active account failed with "Email not found".
      const { storage, syncEngine } = await resolveAccountTarget(accountId);
      const email = await storage.getEmail(emailId);
      if (!email) return { success: false, error: 'Email not found' };

      // Write the SAME validated ICS text the banner renders from — never the
      // re-fetched attachment bytes. Re-fetching a named .ics can return a
      // corrupt/partial blob (seen: a 207-byte binary garbage invite during a
      // connection drop), and getOrCacheAttachment then serves that garbage from
      // cache on every click → macOS Calendar "can't read this calendar file".
      let ics = sanitizeIcsText(email.calendarIcs);
      if (!ics) {
        // Not captured on the row — extract from the message source (+ backfill).
        const folder = await storage.getFolder(email.folderId);
        if (folder && email.uid && syncEngine) {
          ics = sanitizeIcsText(await syncEngine.getCalendarIcs(emailId, folder.path, email.uid));
          if (ics) {
            try {
              await storage.updateEmail(emailId, { calendarIcs: ics });
            } catch {
              /* backfill is best-effort */
            }
          }
        }
      }
      if (!ics) return { success: false, error: 'No calendar invite found for this email' };

      // Import as a plain event, not an RSVP invitation (see toPlainEventIcs),
      // then normalize line endings to CRLF with a trailing CRLF. RFC 5545
      // mandates CRLF; strict importers (macOS Calendar) reject bare-LF files
      // and rely on CRLF for line unfolding of long (folded) properties.
      const published = toPlainEventIcs(ics);
      const crlf = published.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      const body = crlf.endsWith('\r\n') ? crlf : `${crlf}\r\n`;

      const cacheDir = attachmentCacheDir(emailId);
      await fs.promises.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      // Dedicated filename (not the attachment's invite.ics) so a stale/corrupt
      // cached attachment is never reused; always overwrite with fresh text.
      const icsPath = resolveWithinDir(cacheDir, 'calendar-event.ics');
      await fs.promises.writeFile(icsPath, body, { mode: 0o600 });

      const errMsg = await shell.openPath(icsPath);
      if (errMsg) {
        return { success: false, error: errMsg, noHandler: true };
      }
      return { success: true };
    } catch (error) {
      logger.error('[Main] openCalendarInvite error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Persist whether the user has added this email's invite to their calendar.
   * Drives the banner's "Added to calendar" state across reopens / restarts.
   * (This is our own marker — it does NOT add to or remove from the OS calendar,
   * which we can't control; clearing it just resets the button.)
   */
  ipcMain.handle('emails:setCalendarAdded', async (_event, emailId: string, added: boolean, accountId?: string) => {
    try {
      if (typeof emailId !== 'string' || !emailId) {
        return { success: false, error: 'Invalid emailId' };
      }
      // Owning-account routing so the persisted flag lands in the RIGHT DB.
      const { storage } = await resolveAccountTarget(accountId);
      await storage.updateEmail(emailId, { calendarAdded: Boolean(added) });
      return { success: true };
    } catch (error) {
      logger.error('[Main] setCalendarAdded error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Bulk action on multiple emails
   * Groups emails by source folder, updates local DB in batch, fires single bulk IMAP call per folder group
   */
  ipcMain.handle('emails:bulkAction', async (_event, emailIds: string[], action: string, accountId?: string, allowPermanent?: boolean) => {
    try {
      // Route to the rows' OWNING account (unified "All Inboxes" groups its
      // selection by account and calls this once per account) so cross-account
      // bulk actions actually hit the right DB + IMAP engine, instead of only
      // ever the active account (which silently skipped other accounts' rows).
      const { storage, syncEngine } = await resolveAccountTarget(accountId);

      if (emailIds.length === 0) {
        return { success: true };
      }

      // Load the folder list ONCE and reuse it for every lookup below (per-email
      // folder resolution + the trash/archive/spam target lookups) instead of
      // refetching the whole folders table per email and per action group.
      const allFolders = await storage.getFolders();
      const folderById = new Map<string, any>(allFolders.map((f: any) => [f.id, f]));

      // Load all emails and group by source folder. Fetch every email in ONE
      // batched query indexed by id instead of a sequential getEmail per id
      // (N+1). Iterate emailIds so grouping order is preserved.
      const emailsByFolder = new Map<string, Array<{ id: string; uid?: number; folderId: string; folderPath: string; email: any }>>();

      const emails = await storage.getEmailsByIds(emailIds);
      const emailById = new Map(emails.map((e) => [e.id, e]));

      // Diagnostic: ids not found in THIS account's DB. bulkAction runs against
      // the active account only (no per-row accountId), so unified "All Inboxes"
      // rows owned by another account fall through here and are NOT processed —
      // a distinct failure mode from the uid-less one below.
      const missingIds = emailIds.filter((id) => !emailById.has(id));
      if (missingIds.length > 0) {
        logger.info(`[bulkAction] ${action}: ${missingIds.length} of ${emailIds.length} id(s) not in the active account DB (likely another account's rows — not processed)`);
      }

      for (const emailId of emailIds) {
        const email = emailById.get(emailId);
        // Do NOT skip rows without a server UID. Their LOCAL state (read/star/
        // folder tag) must still change — otherwise a bulk action silently
        // no-ops on them and they linger (e.g. "mark all read" leaving uid-less
        // rows unread forever, which then keep inflating the folder's recomputed
        // unread count). Only the per-folder IMAP op below is UID-gated. This
        // mirrors the single-email markRead handler, which already does this.
        if (!email) continue;

        const folder = folderById.get(email.folderId);
        if (!folder) continue;

        const key = folder.path;
        if (!emailsByFolder.has(key)) {
          emailsByFolder.set(key, []);
        }
        emailsByFolder.get(key)!.push({
          id: email.id,
          uid: email.uid,
          folderId: email.folderId,
          folderPath: folder.path,
          email,
        });
      }

      // Emails whose read flag actually FLIPPED this call (markRead/markUnread
      // only) — fed to the scan-free unread delta after the loop instead of a
      // full-table recount.
      const flippedReadIds: string[] = [];

      // Process each folder group
      for (const [folderPath, items] of emailsByFolder) {
        // Local ops below run over ALL items (including uid-less rows); the IMAP
        // ops take only real server UIDs, so a uid-less row updates locally but
        // isn't (can't be) pushed to the server.
        const uids = items.map(item => item.uid).filter((u): u is number => typeof u === 'number' && u > 0);

        // Update local DB based on action
        switch (action) {
          case 'delete': {
            // Only rows with a real server UID can be reflected to the server. Running
            // the LOCAL delete/trash over uid-less rows too (a mirror/label membership
            // not yet resynced, or a just-repointed primary whose uid was nulled) would
            // remove them locally while their server copy survives — the "delete did
            // nothing on the server" mismatch. Drive the local mutation from the SAME
            // uid-bearing set as the IMAP op (`uids`); leave uid-less rows in place so
            // they reconcile via sync, not a silent local-only delete.
            const deletable = items.filter((i) => typeof i.uid === 'number' && i.uid > 0);
            if (deletable.length < items.length) {
              logger.warn(`[bulkAction] ${folderPath}: ${items.length - deletable.length} uid-less row(s) left in place for delete (no server UID — avoids a local/server mismatch)`);
            }
            // Permanent expunge ONLY when the source folder truly IS Trash (exact
            // classification, never a `path.includes('trash')` substring that
            // mis-classifies a "Trash Pandas" label) AND the renderer explicitly
            // confirmed a permanent delete. Without that confirmed flag we move to
            // Trash instead — so a mis-detected row can never be silently expunged.
            const sourceFolder = allFolders.find((f: any) => f.path === folderPath);
            const isTrash = sourceFolder ? isTrashFolder(sourceFolder) : (folderPath === 'Deleted Items');
            if (isTrash && allowPermanent === true) {
              // Permanent delete from DB
              await storage.deleteEmails(deletable.map(i => i.id));
              // IMAP bulk delete. Enqueue REGARDLESS of connection state — the
              // operationQueue persists the expunge and replays it on reconnect
              // (gating on isConnected() dropped offline deletes, which a resync
              // then re-created). folderPath + uids are the source location,
              // captured before the local mutations above.
              if (syncEngine) {
                syncEngine.bulkDelete(folderPath, uids).catch((err: any) => {
                  logger.error('[Main] Bulk IMAP delete failed:', err);
                });
              }
            } else {
              if (isTrash && allowPermanent !== true) {
                logger.warn(`[bulkAction] delete in ${folderPath}: permanent expunge NOT confirmed by renderer — moving to Trash instead (no silent data loss)`);
              }
              // Find trash folder for local DB update (exact classification).
              const trashFolder = findFolderByType(allFolders as any, 'trash') as any;
              if (trashFolder) {
                for (const item of deletable) {
                  let tags = item.email.tags || '';
                  if (tags.includes('|' + folderPath + '|')) {
                    tags = tags.replace('|' + folderPath + '|', '|');
                  }
                  if (!tags.includes('|' + trashFolder.path + '|')) {
                    const list = tags.split('|').filter(Boolean);
                    list.push(trashFolder.path);
                    tags = '|' + list.join('|') + '|';
                  }
                  await storage.updateEmail(item.id, { folderId: trashFolder.id, tags });
                  // Track deletion in sender stats
                  if (item.email.fromAddress) {
                    storage.upsertSenderStats({ email: item.email.fromAddress, deletedCount: 1 }).catch(() => { });
                  }
                }
              }
              // IMAP bulk move to trash. Enqueue REGARDLESS of connection state
              // — the operationQueue persists the op and replays it on reconnect
              // (gating on isConnected() dropped offline actions). folderPath +
              // uids are the source location, captured before the mutations.
              if (syncEngine) {
                syncEngine.bulkMoveToTrash(folderPath, uids).catch((err: any) => {
                  logger.error('[Main] Bulk IMAP trash move failed:', err);
                });
              }
            }
            break;
          }

          case 'archive': {
            const archiveFolder = findFolderByType(allFolders as any, 'archive') as any;
            if (archiveFolder) {
              for (const item of items) {
                let tags = item.email.tags || '';
                if (tags.includes('|' + folderPath + '|')) {
                  tags = tags.replace('|' + folderPath + '|', '|');
                }
                if (!tags.includes('|' + archiveFolder.path + '|')) {
                  const list = tags.split('|').filter(Boolean);
                  list.push(archiveFolder.path);
                  tags = '|' + list.join('|') + '|';
                }
                await storage.updateEmail(item.id, { folderId: archiveFolder.id, tags });
              }
            }
            // Enqueue REGARDLESS of connection state — the operationQueue
            // persists the op and replays it on reconnect (gating on
            // isConnected() dropped offline actions). folderPath + uids are the
            // source location, captured before the mutations above.
            if (syncEngine) {
              syncEngine.bulkArchive(folderPath, uids).catch((err: any) => {
                logger.error('[Main] Bulk IMAP archive failed:', err);
              });
            }
            break;
          }

          case 'spam': {
            const spamFolder = findFolderByType(allFolders as any, 'spam') as any;
            if (spamFolder) {
              for (const item of items) {
                let tags = item.email.tags || '';
                if (tags.includes('|' + folderPath + '|')) {
                  tags = tags.replace('|' + folderPath + '|', '|');
                }
                if (!tags.includes('|' + spamFolder.path + '|')) {
                  const list = tags.split('|').filter(Boolean);
                  list.push(spamFolder.path);
                  tags = '|' + list.join('|') + '|';
                }
                await storage.updateEmail(item.id, { folderId: spamFolder.id, tags });
                // The user's word, stored: the filter never un-files a 'spam'.
                storage.setSpamUserVerdict(item.id, 'spam').catch(() => { });
                // Register sender as spammer
                if (item.email.fromAddress) {
                  storage.addSpammer({
                    email: item.email.fromAddress,
                    name: item.email.fromName || undefined,
                    reason: 'Marked as spam by user',
                  }).catch(() => { });
                }
              }
              reportVerdictsOnce(items.map((i) => i.email), 'spam');
            }
            // Enqueue REGARDLESS of connection state — the operationQueue
            // persists the op and replays it on reconnect (gating on
            // isConnected() dropped offline actions). folderPath + uids are the
            // source location, captured before the mutations above.
            if (syncEngine) {
              syncEngine.bulkMoveToSpam(folderPath, uids).catch((err: any) => {
                logger.error('[Main] Bulk IMAP spam move failed:', err);
              });
            }
            break;
          }

          case 'notspam': {
            // Move a whole thread OUT of spam back to Inbox in one action
            // (mirrors the single emails:moveFromSpam handler for each message).
            const folders = allFolders;
            const inboxFolder = folders.find((f: any) =>
              f.path === 'INBOX' || f.path?.toLowerCase() === 'inbox'
            );
            if (inboxFolder) {
              for (const item of items) {
                let tags = item.email.tags || '';
                if (tags.includes('|' + folderPath + '|')) {
                  tags = tags.replace('|' + folderPath + '|', '|');
                }
                if (!tags.includes('|' + inboxFolder.path + '|')) {
                  const list = tags.split('|').filter(Boolean);
                  list.push(inboxFolder.path);
                  tags = '|' + list.join('|') + '|';
                }
                await storage.updateEmail(item.id, { folderId: inboxFolder.id, tags });
                // The user's word, stored: the filter never files a 'ham' again.
                storage.setSpamUserVerdict(item.id, 'ham').catch(() => { });
                // Un-register the sender as a spammer (mirrors moveFromSpam).
                if (item.email.fromAddress) {
                  storage.removeSpammer(item.email.fromAddress).catch(() => { });
                }
              }
              reportVerdictsOnce(items.map((i) => i.email), 'ham');
              // ONE bulk IMAP move for the whole thread (moveMessages over all
              // UIDs). Per-UID move() calls drain ~1/sec and let a mid-move Spam
              // resync re-show the not-yet-moved messages ("moves one at a time").
              // Enqueue REGARDLESS of connection state — the operationQueue
              // persists the op and replays it on reconnect (gating on
              // isConnected() dropped offline actions). folderPath + uids are
              // the source location, captured before the mutations above.
              if (syncEngine) {
                syncEngine.bulkMove(folderPath, uids, inboxFolder.path).catch((err: any) => {
                  logger.error('[Main] Bulk IMAP move-from-spam failed:', err);
                });
              }
            }
            break;
          }

          case 'markRead': {
            const updates = items
              .filter((item: any) => !(item.email.tags || '||').includes('|read|'))
              .map((item: any) => {
                const tagList = (item.email.tags || '||').split('|').filter((t: string) => t.length > 0);
                tagList.push('read');
                return { id: item.id, tags: '|' + tagList.join('|') + '|', fromAddress: item.email.fromAddress, wasRead: false, nowRead: true };
              });
            await storage.bulkUpdateTags(updates);
            for (const u of updates) flippedReadIds.push(u.id);
            // Enqueue REGARDLESS of connection state — the operationQueue
            // persists the op and replays it on reconnect (gating on
            // isConnected() dropped offline actions). Worse here than for a
            // move: the local rows ARE marked read, but with no pending op the
            // flag never reaches the server AND syncFlags' pending-UID guard
            // never covers them, so the next server-wins reconcile flips every
            // one of them back to unread. Matches the single-email markRead
            // handler, which is already unconditional.
            if (syncEngine) {
              syncEngine.bulkMarkAsRead(folderPath, uids).catch((err: any) => {
                logger.error('[Main] Bulk IMAP markRead failed:', err);
              });
            }
            break;
          }

          case 'markUnread': {
            const updates = items
              .filter((item: any) => (item.email.tags || '||').includes('|read|'))
              .map((item: any) => {
                const tagList = (item.email.tags || '||').split('|').filter((t: string) => t.length > 0 && t !== 'read');
                return { id: item.id, tags: tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||', fromAddress: item.email.fromAddress, wasRead: true, nowRead: false };
              });
            await storage.bulkUpdateTags(updates);
            for (const u of updates) flippedReadIds.push(u.id);
            // Enqueue REGARDLESS of connection state — see the markRead case.
            if (syncEngine) {
              syncEngine.bulkMarkAsUnread(folderPath, uids).catch((err: any) => {
                logger.error('[Main] Bulk IMAP markUnread failed:', err);
              });
            }
            break;
          }

          case 'star': {
            const updates = items
              .filter((item: any) => !(item.email.tags || '||').includes('|starred|'))
              .map((item: any) => {
                const tagList = (item.email.tags || '||').split('|').filter((t: string) => t.length > 0);
                tagList.push('starred');
                return { id: item.id, tags: '|' + tagList.join('|') + '|' };
              });
            await storage.bulkUpdateTags(updates);
            // Enqueue REGARDLESS of connection state — see the markRead case.
            // A dropped star reverts the same way a dropped read does.
            if (syncEngine) {
              syncEngine.bulkStar(folderPath, uids).catch((err: any) => {
                logger.error('[Main] Bulk IMAP star failed:', err);
              });
            }
            break;
          }

          case 'unstar': {
            const updates = items
              .filter((item: any) => (item.email.tags || '||').includes('|starred|'))
              .map((item: any) => {
                const tagList = (item.email.tags || '||').split('|').filter((t: string) => t.length > 0 && t !== 'starred');
                return { id: item.id, tags: tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||' };
              });
            await storage.bulkUpdateTags(updates);
            // Enqueue REGARDLESS of connection state — see the markRead case.
            if (syncEngine) {
              syncEngine.bulkUnstar(folderPath, uids).catch((err: any) => {
                logger.error('[Main] Bulk IMAP unstar failed:', err);
              });
            }
            break;
          }
        }
      }

      // Diagnostic: rows with no server UID are handled locally only (no IMAP
      // op). Historically these were skipped entirely, so "mark all read" left
      // them unread forever and the folder badge never dropped.
      const uidlessCount = [...emailsByFolder.values()].reduce((n, items) => n + items.filter((i) => !i.uid).length, 0);
      if (uidlessCount > 0) {
        logger.info(`[bulkAction] ${action}: ${uidlessCount} row(s) had no server UID — updated locally only`);
      }

      // Fix folder unread counts.
      // Await so the renderer's follow-up loadFolders() reads the fresh counts
      // instead of racing this recompute (fire-and-forget could be read stale,
      // stranding the sidebar badge). Errors are swallowed — a recount hiccup
      // must never fail the operation itself.
      const MOVE_ACTIONS = new Set(['delete', 'archive', 'spam', 'notspam', 'trash']);
      const isReadAction = action === 'markRead' || action === 'markUnread';
      try {
        if (isReadAction && flippedReadIds.length > 0) {
          // Read flips change only unread_count (never a message count) — apply a
          // precise, scan-free ±1 delta per affected folder instead of a
          // full-table recount. Same shared helper the single-email path uses, so
          // there is one place that decides delta-vs-recount; the batch method
          // itself falls back to a full recount above its threshold.
          const nowRead = action === 'markRead';
          await applyReadFlagCountDelta(
            storage,
            flippedReadIds.map((emailId) => ({ emailId, nowRead })),
            'bulk markRead',
          );
        } else if (isReadAction && flippedReadIds.length === 0) {
          // Nothing actually flipped → no count change; skip the recount.
        } else {
          // Star (no unread change, but cheap + harmless to recount its folders)
          // and move actions (source + target folders) → full recount. Move
          // touches two folders, so recount everything for them.
          const affectedPaths = MOVE_ACTIONS.has(action) ? undefined : [...emailsByFolder.keys()];
          await storage.recalculateFolderCounts(affectedPaths);
        }
      } catch (err) {
        logger.error('[email-handlers] folder unread recount failed:', err);
      }

      return { success: true };
    } catch (error) {
      logger.error('Bulk action error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Preview an email attachment — cache on disk, then open with OS default viewer
   */
  ipcMain.handle(
    'emails:previewAttachment',
    async (_event, emailId: string, filename: string, accountId?: string) => {
      try {
        // SECURITY: handing a path to `shell.openPath` asks the OS to LAUNCH it,
        // so an executable, installer or script would run with the user's
        // privileges on a single click. The renderer already only offers this for
        // allow-listed types; re-check it here, because the main process must not
        // trust the renderer to be the only gate. Anything else can still be
        // saved by the user to a location they chose — saving opens nothing.
        if (!isPreviewableAttachment(filename)) {
          return { success: false, error: 'This file type cannot be opened from Sarv Inbox' };
        }

        const { filePath } = await resolveAttachmentFile({ emailId, filename, accountId });
        const errorMessage = await shell.openPath(filePath);
        if (errorMessage) {
          return { success: false, error: errorMessage };
        }

        return { success: true };
      } catch (error) {
        logger.error('[Main] Preview attachment error:', error);
        return { success: false, error: attachmentErrorMessage(error) };
      }
    },
  );
}
