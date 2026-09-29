/**
 * Spam verdict repair (main process) — drains the queue migration v96 left.
 *
 * Two bugs wrote verdicts that the fixes alone cannot take back, because the
 * fixes only change how NEW mail is judged:
 *
 *   - An IMAP server repeated each message's Message-ID in the ENVELOPE's
 *     In-Reply-To slot, so nearly every message was charged
 *     `in-reply-to-self`. v96 took the reason off and re-summed the score, but
 *     a migration cannot move mail, and some of it was filed on those points.
 *   - mailguard < 0.4.2 read numbers in link text (`₹3.2`) as domains and
 *     charged the SendClean click tracker as a disguised link. Only the
 *     content stage, re-run over the stored body, can correct those reasons —
 *     and that stage lives in core, not in the migration.
 *
 * Per queued message: re-run the content stage over the stored body when the
 * verdict carries a link-mismatch reason (keeping every other stage's reasons,
 * attachments included — their bytes are not to hand), then, if the message
 * was filed by the filter and no longer scores as spam, take it back out: the
 * `spam` tag off, the local folder back to INBOX and the server move queued,
 * exactly as "Not spam" does it, minus the user-verdict side effects — nobody
 * judged the sender, the filter was wrong.
 *
 * The content stage is NOT run on mail whose verdict has no link reason: that
 * would be judging it afresh (a 0 turning into a 2 for hidden text), not
 * repairing what the two bugs wrote.
 *
 * "Filed by the filter" is: tagged `spam`, no user verdict, and a score of at
 * least the spam line BEFORE v96 touched it. The tag alone cannot say — the AI
 * clears and rewrites it on every run, so on the reporting mailbox every
 * spam-tagged row had been through the AI. A tag on a row that never reached
 * the line is the AI's own call and is left to it. A user's "Report spam" is a
 * 'spam' verdict and is never touched.
 *
 * The queue only shrinks; nothing but v96 fills it, so a drained queue makes
 * every later launch a single empty SELECT.
 */
import {
  bodyStage,
  createLogger,
  hasTag,
  isSpamScore,
  recipientDomainsOf,
  rescoreContent,
  type EmailRecord,
  type FolderRecord,
} from '@sarvinbox/core';

import { getAllAccountRuntimes } from '../shared';

import { unfileFromSpam } from './spam-verdict-actions';

const logger = createLogger('spam-repair');

/** Let startup sync and the first folder loads settle first. */
export const REPAIR_FIRST_DELAY_MS = 60_000;
/** Messages per batch; each is a primary-key read, a pure re-score and at most one write. */
export const REPAIR_BATCH_SIZE = 100;

/** The storage surface the repair needs — structural, so tests can fake it. */
export interface RepairStorage {
  getSpamRepairQueue(limit: number): Array<{ emailId: string; scoreBefore: number | null }>;
  dequeueSpamRepair(emailIds: readonly string[]): void;
  getEmail(id: string): Promise<EmailRecord | null>;
  getFolders(): Promise<FolderRecord[]>;
  updateEmail(
    id: string,
    updates: { spamScore?: number; spamReasons?: string; tags?: string; folderId?: string },
  ): Promise<void>;
  recalculateFolderCounts(): Promise<void>;
}

/** The server-side move, from the account's OperationQueue. Null when there is none. */
export interface RepairQueue {
  move(sourcePath: string, uid: number, destPath: string): Promise<unknown>;
}

export interface RepairSummary {
  checked: number;
  rescored: number;
  unfiled: number;
}

/**
 * Re-derive one message's verdict and un-file it if it no longer holds.
 * Returns what changed. Throws only on a storage failure, which leaves the
 * message queued for the next launch.
 */
export async function repairMessage(
  email: EmailRecord,
  scoreBefore: number | null,
  folders: FolderRecord[],
  storage: Pick<RepairStorage, 'updateEmail'>,
  queue: RepairQueue | null,
): Promise<{ rescored: boolean; unfiled: boolean }> {
  const update: { spamScore?: number; spamReasons?: string; tags?: string; folderId?: string } = {};
  let score = email.spamScore;

  const hasBody = Boolean(email.rawBody || email.cleanBody);
  const hasLinkReason = (email.spamReasons ?? '').includes('"link-display-mismatch"');
  if (hasBody && hasLinkReason && typeof score === 'number') {
    const scored = rescoreContent(
      email,
      bodyStage({
        subject: email.subject,
        cleanBody: email.cleanBody,
        rawBody: email.rawBody,
        contentType: email.contentType,
        recipientDomains: recipientDomainsOf(email.toAddress, email.ccAddress),
      }),
    );
    const reasons = scored ? JSON.stringify(scored.reasons) : null;
    if (scored && (scored.score !== score || reasons !== email.spamReasons)) {
      update.spamScore = scored.score;
      update.spamReasons = reasons!;
      score = scored.score;
    }
  }

  const filedByFilter = hasTag(email.tags, 'spam') && !email.spamUserVerdict && isSpamScore(scoreBefore);
  let moved: { sourcePath: string; destPath: string } | null = null;
  const unfiled = filedByFilter && typeof score === 'number' && !isSpamScore(score);
  if (unfiled) {
    const placement = unfileFromSpam(email, folders);
    update.tags = placement.tags;
    update.folderId = placement.folderId;
    const source = folders.find((f) => f.id === email.folderId);
    if (placement.moved && placement.destPath && source) {
      moved = { sourcePath: source.path, destPath: placement.destPath };
    }
  }

  if (Object.keys(update).length > 0) await storage.updateEmail(email.id, update);
  // Local first, then the server: the source uid names the message until the
  // move lands, and the queue persists it across a disconnect.
  if (moved && queue && email.uid > 0) {
    queue.move(moved.sourcePath, email.uid, moved.destPath).catch((err: unknown) => {
      logger.warn(`[SpamRepair] server move failed for uid ${email.uid} in ${moved!.sourcePath}: ${(err as Error)?.message ?? err}`);
    });
  }
  return { rescored: update.spamScore !== undefined, unfiled };
}

/** Drain one account's queue. One message's failure never stops the rest. */
export async function repairAccount(
  storage: RepairStorage,
  queue: RepairQueue | null,
  label: string,
): Promise<RepairSummary> {
  const summary: RepairSummary = { checked: 0, rescored: 0, unfiled: 0 };
  const folders = await storage.getFolders();
  for (;;) {
    const batch = storage.getSpamRepairQueue(REPAIR_BATCH_SIZE);
    if (batch.length === 0) break;
    const done: string[] = [];
    for (const { emailId: id, scoreBefore } of batch) {
      try {
        const email = await storage.getEmail(id);
        if (email) {
          const r = await repairMessage(email, scoreBefore, folders, storage, queue);
          summary.checked += 1;
          if (r.rescored) summary.rescored += 1;
          if (r.unfiled) summary.unfiled += 1;
        }
        // A message that no longer exists has nothing left to repair.
        done.push(id);
      } catch (e) {
        logger.warn(`[SpamRepair] ${label}: ${id} left queued: ${(e as Error).message}`);
      }
    }
    storage.dequeueSpamRepair(done);
    // Every id in the batch failed: the next SELECT would return the same
    // batch. Stop, and let the next launch try again.
    if (done.length === 0) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (summary.unfiled > 0) {
    try { await storage.recalculateFolderCounts(); } catch { /* a recount hiccup is not a failed repair */ }
  }
  if (summary.checked > 0) {
    logger.info(
      `[SpamRepair] ${label}: ${summary.checked} verdict(s) checked, ${summary.rescored} re-scored, `
        + `${summary.unfiled} taken back out of spam`,
    );
  }
  return summary;
}

let timer: NodeJS.Timeout | null = null;

async function run(): Promise<void> {
  timer = null;
  for (const [accountId, rt] of getAllAccountRuntimes()) {
    const storage = rt.storage as unknown as RepairStorage | null;
    if (typeof storage?.getSpamRepairQueue !== 'function') continue;
    const queue = (rt.syncEngine as unknown as { operationQueue?: RepairQueue } | null)?.operationQueue ?? null;
    try {
      await repairAccount(storage, queue, accountId);
    } catch (e) {
      logger.warn(`[SpamRepair] ${accountId}: repair failed (isolated): ${(e as Error).message}`);
    }
  }
}

/** Schedule the one-shot repair. Idempotent. Called from main.ts once accounts are wired. */
export function startSpamVerdictRepair(): void {
  if (timer) return;
  timer = setTimeout(() => { void run(); }, REPAIR_FIRST_DELAY_MS);
}

export function stopSpamVerdictRepair(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
