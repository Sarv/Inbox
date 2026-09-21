/**
 * The user's verdict on a message — Report spam, Not spam — done ONE way.
 *
 * Three doors lead here: the message actions, the bulk action bar, and the
 * Security page's Spam tab. Each used to hand-roll the same tag surgery and
 * folder move; now they call this, so the local projection, the server-side
 * op, the spammer list, the stored verdict and the (opt-in) report to the Sarv
 * reputation service cannot drift apart.
 *
 * The stored verdict outranks every score the filter later computes: a 'ham'
 * message is never filed again whatever the reputation stages find, and a
 * 'spam' one stays filed however clean its headers looked.
 */
import {
  addTag,
  classifyFolder,
  computeFilterActionResult,
  createLogger,
  findFolderByType,
  removeTag,
  type EmailRecord,
  type FolderRecord,
  type SenderReport,
  type SpamUserVerdict,
} from '@sarvinbox/core';

const logger = createLogger('spam-verdict');

/** The storage surface a verdict needs — structural, so tests can fake it. */
export interface VerdictStorage {
  getEmail(id: string): Promise<EmailRecord | null>;
  getFolders(): Promise<FolderRecord[]>;
  updateEmail(id: string, updates: { tags?: string; folderId?: string }): Promise<void>;
  addSpammer(spammer: { email: string; name?: string; reason?: string }): Promise<void>;
  removeSpammer(email: string): Promise<void>;
  setSpamUserVerdict(id: string, verdict: SpamUserVerdict | null): Promise<void>;
  recalculateFolderCounts(): Promise<void>;
}

/** The server-side ops, from the account's OperationQueue. Null when offline with no queue. */
export interface VerdictQueue {
  moveToSpam(folderPath: string, uid: number): Promise<unknown>;
  move(sourcePath: string, uid: number, destPath: string): Promise<unknown>;
}

export interface VerdictDeps {
  storage: VerdictStorage;
  queue: VerdictQueue | null;
  /** Sends the verdict on to the reputation service when the user allows it. */
  report?: (report: SenderReport) => void;
}

export interface VerdictOutcome {
  success: boolean;
  error?: string;
  email?: EmailRecord;
  /** The message changed folder locally (and a server move was queued). */
  moved: boolean;
}

/** The domain of an address, for the report. */
export function senderDomainOf(address: string | null | undefined): string | null {
  const at = (address || '').lastIndexOf('@');
  if (at < 0) return null;
  const d = (address || '').slice(at + 1).trim().toLowerCase();
  return d.includes('.') ? d : null;
}

/**
 * Record the user's verdict and act on it. Local first, so the UI is right
 * immediately; the server op is queued regardless of connection state (the
 * queue persists and replays it); the report is fire-and-forget.
 */
export async function applyUserSpamVerdict(deps: VerdictDeps, emailId: string, verdict: SpamUserVerdict): Promise<VerdictOutcome> {
  const { storage } = deps;
  const email = await storage.getEmail(emailId);
  if (!email) return { success: false, error: 'Email not found', moved: false };
  const folders = await storage.getFolders();
  const source = folders.find((f) => f.id === email.folderId) ?? null;

  let tags = email.tags || '||';
  let folderId = email.folderId;
  let moved = false;
  let destPath: string | null = null;

  if (verdict === 'spam') {
    tags = addTag(tags, 'spam');
    const result = computeFilterActionResult({ tags, folderId }, [{ type: 'moveToSpam' }], folders);
    tags = result.tags;
    folderId = result.folderId;
    moved = result.changed && result.folderId !== email.folderId;
    if (moved) destPath = folders.find((f) => f.id === folderId)?.path ?? null;
  } else {
    tags = removeTag(tags, 'spam');
    // Out of the spam folder — but only if that is where it is: "not spam" on
    // a message already in INBOX must not move it anywhere.
    const inSpam = source ? classifyFolder(source) === 'spam' : false;
    const inbox = findFolderByType(folders, 'inbox') ?? folders.find((f) => f.path.toUpperCase() === 'INBOX') ?? null;
    if (inSpam && inbox) {
      const result = computeFilterActionResult({ tags, folderId }, [{ type: 'moveToFolder', value: inbox.path }], folders);
      tags = result.tags;
      folderId = result.folderId;
      moved = result.changed && result.folderId !== email.folderId;
      destPath = inbox.path;
    }
  }

  if (tags !== (email.tags || '||') || folderId !== email.folderId) {
    await storage.updateEmail(emailId, { tags, folderId });
  }
  try {
    await storage.setSpamUserVerdict(emailId, verdict);
  } catch (e) {
    logger.warn(`[SpamVerdict] could not store the verdict for ${emailId}: ${(e as Error).message}`);
  }
  // Awaited, so a follow-up folder reload reads fresh counts; a recount hiccup
  // never fails the action itself.
  try { await storage.recalculateFolderCounts(); } catch { /* ignore */ }

  if (email.fromAddress) {
    try {
      if (verdict === 'spam') await storage.addSpammer({ email: email.fromAddress, name: email.fromName || undefined, reason: 'Marked as spam by user' });
      else await storage.removeSpammer(email.fromAddress);
    } catch (e) {
      logger.warn(`[SpamVerdict] spammer list not updated for ${email.fromAddress}: ${(e as Error).message}`);
    }
  }

  // Server side: the source uid names the message until the move lands.
  if (moved && deps.queue && email.uid > 0 && source) {
    const op = verdict === 'spam'
      ? deps.queue.moveToSpam(source.path, email.uid)
      : deps.queue.move(source.path, email.uid, destPath ?? 'INBOX');
    op.catch((err: unknown) => logger.error(`[SpamVerdict] IMAP move (${verdict}) failed:`, err));
  }

  deps.report?.({ domain: senderDomainOf(email.fromAddress), ip: email.originIp ?? null, verdict });
  return { success: true, email, moved };
}
