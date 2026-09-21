import type { EmailRecord, FolderRecord, SenderReport } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { applyUserSpamVerdict, senderDomainOf, type VerdictStorage } from '../../../../electron/services/spam-verdict-actions';

/**
 * Report spam / Not spam, the one implementation behind three doors.
 *
 * What this protects: these are the two actions a user takes on a message they
 * have judged, and each has five consequences that must agree — the local
 * folder and tags, the server-side move, the spammer list, the stored verdict
 * the filter respects, and the (opt-in) report. Three call sites used to
 * hand-roll the first three; a drift between them showed as "I said not spam
 * and it came back".
 */
const T0 = 1_760_000_000;
const folder = (id: string, path: string, specialUse: string | null): FolderRecord => ({
  id, name: path, path, parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
  totalCount: 0, unreadCount: 0, specialUse, subscribed: true, createdAt: T0, updatedAt: T0,
});
const INBOX = folder('f-inbox', 'INBOX', '\\Inbox');
const SPAM = folder('f-spam', 'Spam', '\\Junk');
const ARCHIVE = folder('f-arch', 'Archive', null);

const email = (over: Partial<EmailRecord> = {}): EmailRecord => ({
  id: 'e1', messageId: '<m@x>', threadId: 't1', folderId: 'f-inbox', uid: 42, tags: '|INBOX|',
  subject: 's', fromAddress: 'spammer@evil.example', fromName: 'Evil', toAddress: 'me@x', toNames: null,
  ccAddress: null, ccNames: null, bccAddress: null, bccNames: null, replyTo: null, date: T0, receivedDate: T0,
  cleanBody: '', rawBody: '', contentType: 'text', contentHash: 'h', inReplyTo: null, references: null, priority: null,
  hasAttachments: false, attachmentCount: 0, attachmentNames: null, attachmentSizes: null, hasEmbedding: false,
  embeddingLastGenerated: null, createdAt: T0, updatedAt: T0, originIp: '5.6.7.8', ...over,
});

function harness(e: EmailRecord | null, folders: FolderRecord[] = [INBOX, SPAM, ARCHIVE]) {
  const calls: string[] = [];
  const storage: VerdictStorage = {
    getEmail: async () => e,
    getFolders: async () => folders,
    updateEmail: vi.fn(async (id, u) => { calls.push(`update ${id} ${u.folderId ?? '-'} ${u.tags ?? '-'}`); }),
    addSpammer: vi.fn(async (s) => { calls.push(`addSpammer ${s.email}`); }),
    removeSpammer: vi.fn(async (a) => { calls.push(`removeSpammer ${a}`); }),
    setSpamUserVerdict: vi.fn(async (id, v) => { calls.push(`verdict ${id} ${v}`); }),
    recalculateFolderCounts: vi.fn(async () => { calls.push('recount'); }),
  };
  const queue = {
    moveToSpam: vi.fn<[string, number], Promise<unknown>>().mockResolvedValue(undefined),
    move: vi.fn<[string, number, string], Promise<unknown>>().mockResolvedValue(undefined),
  };
  const reports: SenderReport[] = [];
  return { storage, queue, calls, reports, deps: { storage, queue, report: (r: SenderReport) => { reports.push(r); } } };
}

describe('applyUserSpamVerdict — spam', () => {
  it('tags, files locally, queues the server move, blocks the sender, stores the verdict and reports', async () => {
    const h = harness(email());
    const out = await applyUserSpamVerdict(h.deps, 'e1', 'spam');
    expect(out).toMatchObject({ success: true, moved: true });
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '|spam|Spam|', folderId: 'f-spam' });
    expect(h.queue.moveToSpam).toHaveBeenCalledWith('INBOX', 42);
    expect(h.calls).toContain('addSpammer spammer@evil.example');
    expect(h.calls).toContain('verdict e1 spam');
    expect(h.calls).toContain('recount');
    expect(h.reports).toEqual([{ domain: 'evil.example', ip: '5.6.7.8', verdict: 'spam' }]);
  });

  it('still records the verdict, tag and block when the account has no spam folder, without a server move', async () => {
    const h = harness(email(), [INBOX, ARCHIVE]);
    const out = await applyUserSpamVerdict(h.deps, 'e1', 'spam');
    expect(out.moved).toBe(false);
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '|INBOX|spam|', folderId: 'f-inbox' });
    expect(h.queue.moveToSpam).not.toHaveBeenCalled();
    expect(h.calls).toContain('verdict e1 spam');
  });
});

describe('applyUserSpamVerdict — not spam', () => {
  it('moves a message out of the spam folder to INBOX, drops the tag, unblocks the sender, stores ham and reports', async () => {
    const h = harness(email({ folderId: 'f-spam', tags: '|spam|Spam|read|' }));
    const out = await applyUserSpamVerdict(h.deps, 'e1', 'ham');
    expect(out.moved).toBe(true);
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '|read|INBOX|', folderId: 'f-inbox' });
    expect(h.queue.move).toHaveBeenCalledWith('Spam', 42, 'INBOX');
    expect(h.calls).toContain('removeSpammer spammer@evil.example');
    expect(h.calls).toContain('verdict e1 ham');
    expect(h.reports).toEqual([{ domain: 'evil.example', ip: '5.6.7.8', verdict: 'ham' }]);
  });

  // "Not spam" on a message that is NOT in the spam folder (the filter only
  // tagged it, or it sits in Archive) must not drag it into INBOX.
  it('only drops the tag and stores the verdict when the message is not in a spam folder', async () => {
    const h = harness(email({ folderId: 'f-arch', tags: '|Archive|spam|' }));
    const out = await applyUserSpamVerdict(h.deps, 'e1', 'ham');
    expect(out.moved).toBe(false);
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '|Archive|', folderId: 'f-arch' });
    expect(h.queue.move).not.toHaveBeenCalled();
    expect(h.calls).toContain('verdict e1 ham');
  });

  it('writes nothing to the row when neither tags nor folder change, but still stores the verdict', async () => {
    const h = harness(email({ folderId: 'f-inbox', tags: '|INBOX|' }));
    await applyUserSpamVerdict(h.deps, 'e1', 'ham');
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
    expect(h.calls).toContain('verdict e1 ham');
  });
});

describe('applyUserSpamVerdict — edges', () => {
  it('fails cleanly for an unknown message', async () => {
    const h = harness(null);
    expect(await applyUserSpamVerdict(h.deps, 'nope', 'spam')).toEqual({ success: false, error: 'Email not found', moved: false });
    expect(h.calls).toEqual([]);
  });

  it('queues no server op without a uid or a queue, and survives a spammer-list or verdict failure', async () => {
    const h = harness(email({ uid: 0 }));
    expect((await applyUserSpamVerdict({ ...h.deps, queue: null }, 'e1', 'spam')).success).toBe(true);
    expect(h.queue.moveToSpam).not.toHaveBeenCalled();
    const failing = harness(email());
    (failing.storage.addSpammer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db locked'));
    (failing.storage.setSpamUserVerdict as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db locked'));
    expect((await applyUserSpamVerdict(failing.deps, 'e1', 'spam')).success).toBe(true);
  });

  it('senderDomainOf reads the domain or nothing', () => {
    expect(senderDomainOf('A@Mail.Example')).toBe('mail.example');
    expect(senderDomainOf('nope')).toBeNull();
    expect(senderDomainOf('a@localhost')).toBeNull();
    expect(senderDomainOf(null)).toBeNull();
  });

  it('"not spam" on a message whose folder the account no longer lists changes tags only, and reports a null address', async () => {
    const h = harness(email({ folderId: 'f-gone', tags: '|spam|', originIp: undefined }));
    const out = await applyUserSpamVerdict(h.deps, 'e1', 'ham');
    expect(out.moved).toBe(false);
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '||', folderId: 'f-gone' });
    expect(h.reports).toEqual([{ domain: 'evil.example', ip: null, verdict: 'ham' }]);
  });
});

describe('applyUserSpamVerdict — remaining branches', () => {
  const PLAIN_INBOX = folder('f-inbox', 'INBOX', null); // no \\Inbox special-use: found by path

  it('finds INBOX by path when no folder carries the special-use, and reports through no channel when none is wired', async () => {
    const h = harness(email({ folderId: 'f-spam', tags: '|spam|Spam|', fromName: null }), [PLAIN_INBOX, SPAM]);
    const out = await applyUserSpamVerdict({ storage: h.storage, queue: h.queue }, 'e1', 'ham');
    expect(out.moved).toBe(true);
    expect(h.queue.move).toHaveBeenCalledWith('Spam', 42, 'INBOX');
    expect(h.reports).toEqual([]);
  });

  it('with no inbox at all, "not spam" on a spam-folder message drops the tag and stores the verdict but moves nothing', async () => {
    const h = harness(email({ folderId: 'f-spam', tags: '|spam|Spam|' }), [SPAM]);
    const out = await applyUserSpamVerdict(h.deps, 'e1', 'ham');
    expect(out.moved).toBe(false);
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '|Spam|', folderId: 'f-spam' });
    expect(h.queue.move).not.toHaveBeenCalled();
  });

  it('copes with empty tags and a folder the account no longer lists', async () => {
    const h = harness(email({ tags: '', folderId: 'f-gone' }));
    const out = await applyUserSpamVerdict(h.deps, 'e1', 'spam');
    expect(out).toMatchObject({ success: true, moved: true });
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '|spam|Spam|', folderId: 'f-spam' });
    // No source folder is known, so no server op can name the message.
    expect(h.queue.moveToSpam).not.toHaveBeenCalled();
    expect(h.calls).toContain('addSpammer spammer@evil.example');
  });

  it('survives a recount failure and a failing server op', async () => {
    const h = harness(email());
    (h.storage.recalculateFolderCounts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('busy'));
    h.queue.moveToSpam.mockRejectedValue(new Error('socket closed'));
    const out = await applyUserSpamVerdict(h.deps, 'e1', 'spam');
    await new Promise((r) => setTimeout(r, 0));
    expect(out.success).toBe(true);
  });
});

describe('applyUserSpamVerdict — spammer list details', () => {
  it('blocks a sender that has no display name, and does nothing to the list for a message with no sender', async () => {
    const named = harness(email({ fromName: null }));
    await applyUserSpamVerdict(named.deps, 'e1', 'spam');
    expect(named.storage.addSpammer).toHaveBeenCalledWith({ email: 'spammer@evil.example', name: undefined, reason: 'Marked as spam by user' });
    const anonymous = harness(email({ fromAddress: '' }));
    await applyUserSpamVerdict(anonymous.deps, 'e1', 'spam');
    expect(anonymous.storage.addSpammer).not.toHaveBeenCalled();
    expect(anonymous.reports).toEqual([{ domain: null, ip: '5.6.7.8', verdict: 'spam' }]);
  });
});
