import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

const runtimes = new Map<string, { storage: unknown; syncEngine: unknown }>();
vi.mock('../../../../electron/shared', () => ({ getAllAccountRuntimes: () => runtimes }));

import { unfileFromSpam } from '../../../../electron/services/spam-verdict-actions';
import {
  REPAIR_BATCH_SIZE,
  REPAIR_FIRST_DELAY_MS,
  repairAccount,
  startSpamVerdictRepair,
  stopSpamVerdictRepair,
  repairMessage,
  type RepairStorage,
} from '../../../../electron/services/spam-verdict-repair';

/**
 * The one-shot repair of verdicts written by two fixed bugs (v96): the IMAP
 * server's self-referencing In-Reply-To, and mailguard < 0.4.2 reading prices
 * in link text as domains / charging the SendClean click tracker.
 *
 * What breaks if this file goes red: mail the filter filed on those bogus
 * points stays in Spam for good — the fixes only change how NEW mail is
 * judged — or, the expensive direction, the repair un-files mail the USER
 * reported, or mail that still scores as spam.
 */
const T0 = 1_760_000_000;
const folder = (id: string, path: string, specialUse: string | null): FolderRecord => ({
  id, name: path, path, parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
  totalCount: 0, unreadCount: 0, specialUse, subscribed: true, createdAt: T0, updatedAt: T0,
});
const INBOX = folder('f-inbox', 'INBOX', '\\Inbox');
const SPAM = folder('f-spam', 'Spam', '\\Junk');
const FOLDERS = [INBOX, SPAM];

const reasons = (...r: Array<[string, number]>) =>
  JSON.stringify(r.map(([id, points]) => ({ id, points, detail: id })));

// The invoice that started this: amounts linking to the biller.
const INVOICE_HTML = '<p>Total <a href="https://cii.in/i/1">₹3.2</a> and <a href="https://cii.in/i/2">136.25</a></p>';

const email = (over: Partial<EmailRecord> = {}): EmailRecord => ({
  id: 'e1', messageId: '<m@x>', threadId: 't1', folderId: 'f-spam', uid: 42, tags: '|Spam|spam|',
  subject: 'Invoice', fromAddress: 'billing@cii.in', fromName: 'CII', toAddress: 'rc@sarv.com', toNames: null,
  ccAddress: null, ccNames: null, bccAddress: null, bccNames: null, replyTo: null, date: T0, receivedDate: T0,
  cleanBody: 'Total', rawBody: INVOICE_HTML, contentType: 'html', contentHash: 'h', inReplyTo: null, references: null,
  priority: null, hasAttachments: false, attachmentCount: 0, attachmentNames: null, attachmentSizes: null,
  hasEmbedding: false, embeddingLastGenerated: null, createdAt: T0, updatedAt: T0,
  spamScore: 6, spamReasons: reasons(['link-display-mismatch', 2], ['link-display-mismatch', 2], ['link-display-mismatch', 2]),
  spamUserVerdict: null, aiProcessedAt: null,
  ...over,
});

function fakes() {
  const updates: Array<[string, Record<string, unknown>]> = [];
  const storage = { updateEmail: vi.fn(async (id: string, u: Record<string, unknown>) => { updates.push([id, u]); }) };
  const queue = { move: vi.fn<(s: string, uid: number, d: string) => Promise<unknown>>().mockResolvedValue(undefined) };
  return { storage, queue, updates };
}

describe('repairMessage', () => {
  // THE regression: re-running the content stage with mailguard 0.4.2 drops
  // the three price "domains", and the invoice comes back out of Spam —
  // locally and on the server.
  it('re-scores the stored body and un-files what no longer scores as spam', async () => {
    const { storage, queue, updates } = fakes();
    const r = await repairMessage(email(), 6, FOLDERS, storage, queue);
    expect(r).toEqual({ rescored: true, unfiled: true });
    expect(updates).toHaveLength(1);
    const [, u] = updates[0];
    expect(u.spamScore).toBe(0);
    expect(u.spamReasons).toBe('[]');
    expect(u.folderId).toBe('f-inbox');
    expect(u.tags).not.toContain('|spam|');
    expect(queue.move).toHaveBeenCalledWith('Spam', 42, 'INBOX');
  });

  // Attachment reasons cannot be recomputed (no bytes): they stay charged,
  // and if they still carry the message over the line it stays filed.
  it('keeps attachment reasons and leaves mail that still scores as spam filed', async () => {
    const { storage, queue, updates } = fakes();
    const r = await repairMessage(
      email({ spamScore: 7, spamReasons: reasons(['link-display-mismatch', 2], ['attachment-executable', 5]) }),
      7, FOLDERS, storage, queue,
    );
    expect(r).toEqual({ rescored: true, unfiled: false });
    expect(updates[0][1]).toEqual({
      spamScore: 5,
      spamReasons: JSON.stringify([{ id: 'attachment-executable', points: 5, detail: 'attachment-executable' }]),
    });
    expect(queue.move).not.toHaveBeenCalled();
  });

  // The expensive direction: the user's own "Report spam" outranks any score.
  it('never un-files mail the user reported', async () => {
    const { storage, queue } = fakes();
    const r = await repairMessage(email({ spamUserVerdict: 'spam' }), 6, FOLDERS, storage, queue);
    expect(r.unfiled).toBe(false);
    expect(queue.move).not.toHaveBeenCalled();
  });

  // The AI clears and rewrites the `spam` tag on every run, so the tag cannot
  // say who wrote it. A row that never reached the spam line was tagged by the
  // AI, and that call is the AI's to revisit.
  it('leaves a spam tag on mail that never scored as spam', async () => {
    const { storage, queue, updates } = fakes();
    const r = await repairMessage(email({ aiProcessedAt: T0 }), 4, FOLDERS, storage, queue);
    expect(r.unfiled).toBe(false);
    expect(updates[0][1].tags).toBeUndefined();
    expect(queue.move).not.toHaveBeenCalled();
  });

  // THE reporting mailbox's shape: the AI ran before the body re-score tagged
  // the row, so ai_processed_at is set on filter-filed mail too. It must still
  // come out when the filter's own score no longer holds.
  it('un-files filter-filed mail even after the AI has seen it', async () => {
    const { storage, queue } = fakes();
    const r = await repairMessage(email({ aiProcessedAt: T0 }), 6, FOLDERS, storage, queue);
    expect(r.unfiled).toBe(true);
    expect(queue.move).toHaveBeenCalledWith('Spam', 42, 'INBOX');
  });

  // A repair corrects what the two bugs wrote; it does not judge afresh. A
  // verdict with no link reason is not re-run through the content stage (it
  // would turn a 0 into a 2 for hidden text on ordinary mail).
  it('does not run the content stage on a verdict with no link reason', async () => {
    const { storage, updates } = fakes();
    const r = await repairMessage(
      email({ tags: '|INBOX|', folderId: 'f-inbox', spamScore: 0, spamReasons: '[]',
        rawBody: '<div style="display:none">' + 'hidden '.repeat(40) + '</div>' }),
      2, FOLDERS, storage, null,
    );
    expect(r).toEqual({ rescored: false, unfiled: false });
    expect(updates).toEqual([]);
  });

  // v96 already re-summed the score without the self-reply points; a message
  // with no body is un-filed on that alone.
  it('un-files on the migrated score when there is no body to re-run', async () => {
    const { storage, queue, updates } = fakes();
    const r = await repairMessage(
      email({ rawBody: '', cleanBody: '', spamScore: 4, spamReasons: reasons(['link-display-mismatch', 4]) }),
      6, FOLDERS, storage, queue,
    );
    expect(r).toEqual({ rescored: false, unfiled: true });
    expect(updates[0][1]).toMatchObject({ folderId: 'f-inbox' });
  });

  // Tagged but never moved (a mailbox with no spam folder): the tag comes off,
  // nothing moves on the server.
  it('drops the tag without a server move when the message is not in the spam folder', async () => {
    const { storage, queue, updates } = fakes();
    await repairMessage(email({ folderId: 'f-inbox', tags: '|INBOX|spam|' }), 6, FOLDERS, storage, queue);
    expect(updates[0][1]).toMatchObject({ folderId: 'f-inbox', tags: '|INBOX|' });
    expect(queue.move).not.toHaveBeenCalled();
  });

  // Nothing changed: no write at all, and a row with no uid is never moved.
  it('writes nothing for a clean untagged message', async () => {
    const { storage, queue, updates } = fakes();
    const r = await repairMessage(
      email({ tags: '|INBOX|', folderId: 'f-inbox', spamScore: 0, spamReasons: '[]' }),
      0, FOLDERS, storage, queue,
    );
    expect(r).toEqual({ rescored: false, unfiled: false });
    expect(updates).toEqual([]);
  });

  // Offline with no queue, or a local-only row: local repair still happens.
  it('repairs locally when there is no server queue or no uid', async () => {
    const { storage, updates } = fakes();
    await repairMessage(email(), 6, FOLDERS, storage, null);
    await repairMessage(email({ uid: 0 }), 6, FOLDERS, storage, fakes().queue);
    expect(updates).toHaveLength(2);
  });

  // A failed server move is logged, never thrown: the local repair stands.
  it('survives a failing server move', async () => {
    const { storage, updates } = fakes();
    const queue = { move: vi.fn().mockRejectedValue(new Error('offline')) };
    await expect(repairMessage(email(), 6, FOLDERS, storage, queue)).resolves.toMatchObject({ unfiled: true });
    await new Promise((r) => setImmediate(r));
    expect(updates).toHaveLength(1);
  });

  // Unreadable reasons: the content stage declines and the score stands.
  it('does not re-derive a verdict whose reasons cannot be read', async () => {
    const { storage, updates } = fakes();
    const r = await repairMessage(email({ spamScore: 6, spamReasons: '{bad' }), 6, FOLDERS, storage, null);
    expect(r).toEqual({ rescored: false, unfiled: false });
    expect(updates).toEqual([]);
  });
});

function queueStorage(ids: string[], emails: Record<string, EmailRecord | null | Error>) {
  const queue = [...ids];
  const storage: RepairStorage & { recount: number } = {
    recount: 0,
    getSpamRepairQueue: (limit) => queue.slice(0, limit).map((emailId) => ({ emailId, scoreBefore: 6 })),
    dequeueSpamRepair: (done) => { for (const id of done) queue.splice(queue.indexOf(id), 1); },
    getEmail: async (id) => {
      const e = emails[id];
      if (e instanceof Error) throw e;
      return e ?? null;
    },
    getFolders: async () => FOLDERS,
    updateEmail: async () => {},
    recalculateFolderCounts: async () => { storage.recount += 1; },
  };
  return { storage, queue };
}

describe('repairAccount', () => {
  // Drains in batches, dequeues vanished messages, recounts once.
  it('drains the whole queue across batches', async () => {
    const ids = Array.from({ length: REPAIR_BATCH_SIZE + 5 }, (_, i) => `e${i}`);
    const emails = Object.fromEntries(ids.map((id) => [id, email({ id })]));
    emails.e3 = null as unknown as EmailRecord;
    const { storage, queue } = queueStorage(ids, emails);
    const summary = await repairAccount(storage, null, 'acct');
    expect(queue).toEqual([]);
    expect(summary).toEqual({ checked: ids.length - 1, rescored: ids.length - 1, unfiled: ids.length - 1 });
    expect(storage.recount).toBe(1);
  });

  // A storage failure keeps THAT message queued for the next launch, and a
  // batch where everything failed stops rather than spinning on itself.
  it('leaves a failing message queued and does not spin', async () => {
    const { storage, queue } = queueStorage(['bad', 'ok'], { bad: new Error('disk'), ok: email({ id: 'ok' }) });
    await repairAccount(storage, null, 'acct');
    expect(queue).toEqual(['bad']);
    const again = await repairAccount(storage, null, 'acct');
    expect(again.checked).toBe(0);
    expect(queue).toEqual(['bad']);
  });

  // A drained queue is one empty SELECT: no recount, no log.
  it('does nothing on an empty queue', async () => {
    const { storage } = queueStorage([], {});
    expect(await repairAccount(storage, null, 'acct')).toEqual({ checked: 0, rescored: 0, unfiled: 0 });
    expect(storage.recount).toBe(0);
  });
});

describe('unfileFromSpam', () => {
  // Shared with "Not spam": the tag always goes, the folder only if it was Spam.
  it('moves out of the spam folder to INBOX and drops the tag', () => {
    expect(unfileFromSpam({ tags: '|Spam|spam|', folderId: 'f-spam' }, FOLDERS)).toMatchObject({
      folderId: 'f-inbox', moved: true, destPath: 'INBOX',
    });
    expect(unfileFromSpam({ tags: '|INBOX|spam|', folderId: 'f-inbox' }, FOLDERS)).toEqual({
      tags: '|INBOX|', folderId: 'f-inbox', moved: false, destPath: null,
    });
  });
});

describe('startSpamVerdictRepair', () => {
  // The wiring: once, after the startup delay, every account with a queue is
  // drained through its own OperationQueue; one account's failure is isolated;
  // a runtime on an older storage (no queue accessor) is skipped.
  it('drains every account once after the delay, isolating failures', async () => {
    vi.useFakeTimers();
    try {
      const good = queueStorage(['a'], { a: email({ id: 'a' }) });
      const move = vi.fn().mockResolvedValue(undefined);
      const broken = { ...queueStorage([], {}).storage, getFolders: async () => { throw new Error('closed'); } };
      runtimes.clear();
      runtimes.set('broken', { storage: broken, syncEngine: null });
      runtimes.set('old', { storage: {}, syncEngine: null });
      runtimes.set('good', { storage: good.storage, syncEngine: { operationQueue: { move } } });

      startSpamVerdictRepair();
      startSpamVerdictRepair(); // idempotent
      await vi.advanceTimersByTimeAsync(REPAIR_FIRST_DELAY_MS);

      expect(good.queue).toEqual([]);
      expect(move).toHaveBeenCalledTimes(1);
    } finally {
      stopSpamVerdictRepair();
      runtimes.clear();
      vi.useRealTimers();
    }
  });

  // Quitting before the delay: the repair never runs (the queue waits).
  it('does not run once stopped', async () => {
    vi.useFakeTimers();
    try {
      const good = queueStorage(['a'], { a: email({ id: 'a' }) });
      runtimes.set('good', { storage: good.storage, syncEngine: null });
      startSpamVerdictRepair();
      stopSpamVerdictRepair();
      stopSpamVerdictRepair();
      await vi.advanceTimersByTimeAsync(REPAIR_FIRST_DELAY_MS);
      expect(good.queue).toEqual(['a']);
    } finally {
      runtimes.clear();
      vi.useRealTimers();
    }
  });
});
