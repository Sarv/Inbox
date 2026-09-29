// SQLiteStorage facade — the first-email split cache (v97) and the auto-draft
// live-draft gate: the save's stale check against the LIVE thread, the
// scheduler's candidate scan, the cascade on the real thread-delete paths, and
// hasLiveUserDraft.
//
// Real SQLite, full production schema, the production insert path (thread
// resolution, orphan reattachment, recomputeThreadMeta).

/* eslint-disable import/order -- the facade import below is deliberately placed
   after the `Module._load` patch; see sqlite-storage-emails.test.ts. */
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FIRST_SPLIT_MAX_ATTEMPTS,
  FIRST_SPLIT_VERSION,
  type AgentDecision,
  type EmailRecord,
  type FirstSplitKey,
  type FirstSplitPart,
  type FirstSplitSaveRequest,
  type FolderRecord,
} from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as emailRepoModule from '../../src/repositories/email-repository';
import { FIRST_SPLIT_SCAN_ROWS_PER_SLOT } from '../../src/repositories/first-split-repository';
import { TestDatabaseCtor } from '../../src/test-support/test-db';

vi.mock('better-sqlite3', () => ({ default: TestDatabaseCtor }));

const nodeModule = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const originalModuleLoad = nodeModule._load;
nodeModule._load = function (request, parent, isMain) {
  if (request === './repositories/email-repository') return emailRepoModule;
  return originalModuleLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line import/first
import { SQLiteStorage } from '../../src/sqlite-storage';
/* eslint-enable import/order */

const T0 = 1_780_000_000;
const DAY = 86_400;

function makeFolder(id: string, path: string, specialUse: string | null): FolderRecord {
  return {
    id, name: path.split('/').pop()!, path, parentId: null,
    uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
    totalCount: 0, unreadCount: 0, specialUse, subscribed: true,
    createdAt: T0, updatedAt: T0,
  };
}

const FOLDERS = [
  makeFolder('f-inbox', 'INBOX', '\\Inbox'),
  makeFolder('f-sent', 'Sent', '\\Sent'),
  makeFolder('f-drafts', 'INBOX.Drafts', '\\Drafts'),
  makeFolder('f-trash', 'Trash', '\\Trash'),
];

function makeEmail(over: Partial<EmailRecord> & { id: string }): EmailRecord {
  return {
    messageId: `<${over.id}@example.test>`,
    threadId: `thread-${over.id}`,
    folderId: 'f-inbox',
    uid: 1,
    tags: '|INBOX|',
    subject: `Subject ${over.id}`,
    fromAddress: `${over.id}@sender.test`,
    fromName: `Sender ${over.id}`,
    toAddress: 'me@example.test',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: T0,
    receivedDate: T0,
    cleanBody: 'clean body text',
    rawBody: `<p>raw body of ${over.id}</p>`,
    contentType: 'html',
    contentHash: `hash-${over.id}`,
    inReplyTo: null,
    references: null,
    priority: null,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    attachmentSizes: null,
    hasEmbedding: false,
    embeddingLastGenerated: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const OWN: FirstSplitPart = {
  role: 'own', fromAddress: 'a@x.test', fromName: 'A', date: T0, dateApprox: false,
  body: '<p>Latest words</p>', fallback: false,
};
const QUOTE: FirstSplitPart = {
  role: 'quote', fromAddress: 'b@x.test', fromName: null, date: T0 - 500, dateApprox: false,
  body: '<p>Earlier words</p>', fallback: false,
};

let dir = '';
let storage: SQLiteStorage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-first-split-'));
  storage = new SQLiteStorage({ dbPath: join(dir, 'mail.db') });
  await storage.initialize();
  await storage.syncFolders(FOLDERS);
});

afterEach(async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const db = (): Database.Database => (storage as unknown as { db: Database.Database }).db;

/** Insert a row straight into a known thread (no resolution), as a sync writer would. */
async function addToThread(threadId: string, over: Partial<EmailRecord> & { id: string }): Promise<void> {
  await storage.getRepositories().email.insert(makeEmail({ threadId, ...over }));
}

const ok = (key: FirstSplitKey, over: Partial<FirstSplitSaveRequest> = {}): FirstSplitSaveRequest => ({
  key, status: 'ok', parts: [OWN, QUOTE], errorKind: null, quoteCount: 1, modelUsed: 'openai:gpt', ...over,
});

describe('saveFirstSplit — the stale check against the live thread', () => {
  // Breaks: nothing; the round trip every other case builds on — and the
  // written row carries main's recomputed key.
  it('writes a result for the current key and reads it back', async () => {
    await storage.insertEmail(makeEmail({ id: 'e1' }));
    const key = storage.firstMemberKeySync('thread-e1')!;

    expect(storage.saveFirstSplit(ok(key), T0)).toEqual({ applied: true, status: 'ok' });
    expect(storage.getFirstSplitSync('thread-e1')).toMatchObject({
      threadId: 'thread-e1', firstEmailId: 'e1', firstKey: 'e1@example.test',
      sourceFingerprint: key.fingerprint, splitVersion: FIRST_SPLIT_VERSION, status: 'ok',
    });
  });

  // Breaks: a raced run caches a split of an email that is no longer first —
  // the AI view then shows the wrong email's history in the first slot.
  it("returns 'stale' and writes nothing when an earlier email arrived mid-run", async () => {
    await storage.insertEmail(makeEmail({ id: 'e1', date: T0 }));
    const key = storage.firstMemberKeySync('thread-e1')!;
    // Clock skew: a mail dated BEFORE e1 that threads under it.
    await storage.insertEmail(makeEmail({ id: 'e0', date: T0 - 60, inReplyTo: '<e1@example.test>' }));
    expect(storage.firstMemberKeySync('thread-e1')!.firstEmailId).toBe('e0');

    expect(storage.saveFirstSplit(ok(key), T0)).toEqual({ applied: false, reason: 'stale' });
    expect(storage.getFirstSplitSync('thread-e1')).toBeNull();
  });

  // Breaks: a split computed from the body BEFORE a re-heal is cached against
  // the healed body — the mojibake the re-heal removed comes back in the AI view.
  it("returns 'stale' when the first email's stored body was re-healed mid-run", async () => {
    await storage.insertEmail(makeEmail({ id: 'e1' }));
    const key = storage.firstMemberKeySync('thread-e1')!;
    await storage.updateEmail('e1', { rawBody: '<p>healed body</p>' });

    expect(storage.saveFirstSplit(ok(key), T0)).toEqual({ applied: false, reason: 'stale' });
    expect(storage.getFirstSplitSync('thread-e1')).toBeNull();
    // ...and a run over the healed body saves.
    expect(storage.saveFirstSplit(ok(storage.firstMemberKeySync('thread-e1')!), T0).applied).toBe(true);
  });

  // Breaks: a thread that lost every member (only a draft left) accepts a
  // write for an email nobody can see.
  it("returns 'stale' for a thread with no member, and 'invalid' for a malformed payload", async () => {
    await storage.insertEmail(makeEmail({ id: 'e1' }));
    const key = storage.firstMemberKeySync('thread-e1')!;
    expect(storage.saveFirstSplit(ok({ ...key, threadId: 'no-such-thread' }), T0)).toEqual({ applied: false, reason: 'stale' });
    expect(storage.saveFirstSplit(ok(key, { parts: [] }), T0)).toEqual({ applied: false, reason: 'invalid' });
    expect(storage.saveFirstSplit({ ...ok(key), key: undefined as never }, T0)).toEqual({ applied: false, reason: 'invalid' });
  });

  // Breaks: a failed re-split destroys a good one (through the facade).
  it("returns 'kept' for a failure over a usable split, and stores a transient failure otherwise", async () => {
    await storage.insertEmail(makeEmail({ id: 'e1' }));
    const key = storage.firstMemberKeySync('thread-e1')!;
    storage.saveFirstSplit(ok(key), T0);
    const transient: FirstSplitSaveRequest = { key, status: 'transient', errorKind: 'timeout', parts: null };
    expect(storage.saveFirstSplit(transient, T0 + 1)).toEqual({ applied: false, reason: 'kept' });

    storage.deleteFirstSplit('thread-e1');
    expect(storage.saveFirstSplit(transient, T0 + 1)).toEqual({ applied: true, status: 'transient' });
    expect(storage.getFirstSplitSync('thread-e1')).toMatchObject({ attempts: 1, errorKind: 'timeout' });
  });

  // Breaks: a resync that re-created the first email's row under a new id
  // refuses every save for a message whose body never changed.
  it('stores the CURRENT row id when the message is the same', async () => {
    await storage.insertEmail(makeEmail({ id: 'e1' }));
    const key = storage.firstMemberKeySync('thread-e1')!;
    expect(storage.saveFirstSplit(ok({ ...key, firstEmailId: 'stale-row-id' }), T0).applied).toBe(true);
    expect(storage.getFirstSplitSync('thread-e1')!.firstEmailId).toBe('e1');
  });

  // Breaks: Settings -> Clear Cache leaving rows behind, or misreporting how
  // many went.
  it('clearAllFirstSplits empties the cache and reports the count', async () => {
    await storage.insertEmail(makeEmail({ id: 'e1' }));
    await storage.insertEmail(makeEmail({ id: 'e2', subject: 'Other subject entirely' }));
    storage.saveFirstSplit(ok(storage.firstMemberKeySync('thread-e1')!), T0);
    storage.saveFirstSplit(ok(storage.firstMemberKeySync('thread-e2')!), T0);
    expect(storage.clearAllFirstSplits()).toEqual({ removed: 2, splits: 2 });
    expect(storage.getFirstSplitSync('thread-e1')).toBeNull();
  });
});

describe('first_email_splits cascade on the real thread-delete paths', () => {
  // Breaks: orphan rows. A child that arrived before its parent lives in its
  // own thread; when the parent lands, the child is pulled under it and the
  // emptied thread is deleted by recomputeThreadMeta — its split must go too.
  it('drops the row when recomputeThreadMeta deletes the husk thread', async () => {
    await storage.insertEmail(makeEmail({ id: 'child', date: T0, inReplyTo: '<parent@example.test>' }));
    const key = storage.firstMemberKeySync('thread-child')!;
    expect(storage.saveFirstSplit(ok(key), T0).applied).toBe(true);

    await storage.insertEmail(makeEmail({ id: 'parent', date: T0 - 100 }));

    expect((await storage.getEmail('child'))!.threadId).toBe('thread-parent');
    expect(db().prepare("SELECT 1 FROM threads WHERE id = 'thread-child'").get()).toBeUndefined();
    expect(storage.getFirstSplitSync('thread-child')).toBeNull();
    expect((db().prepare('SELECT COUNT(*) AS c FROM first_email_splits').get() as { c: number }).c).toBe(0);
  });
});

describe('hasLiveUserDraft — the auto-draft gate', () => {
  const decision = (id: string, emailId: string, threadId: string): AgentDecision => ({
    id, emailId, threadId, senderAddress: null, proposedAction: 'reply', proposedValue: null,
    confidence: 0.9, reasoning: '', status: 'auto', actualAction: null, userFeedback: null,
    proposedAt: T0, resolvedAt: null, createdAt: T0,
  } as AgentDecision);

  beforeEach(async () => {
    await storage.insertEmail(makeEmail({ id: 'm1', date: T0 }));
    await addToThread('thread-m1', { id: 'm2', date: T0 + 100 });
  });

  // Breaks: auto-draft writes a reply over a draft the user started earlier —
  // the old gate only looked at the NEWEST row, so any later arrival hid it.
  it('is true for an OLDER live user draft, even with newer mail after it', async () => {
    await addToThread('thread-m1', { id: 'd1', date: T0 + 50, tags: '|Drafts|draft|' });
    expect(storage.hasLiveUserDraft('thread-m1')).toBe(true);
  });

  // Breaks: an IMAP-synced draft tagged only with the provider's Drafts path
  // (no local |draft| marker) is invisible to the gate.
  it("is true for a provider-path draft ('INBOX.Drafts' from the folders table)", async () => {
    await addToThread('thread-m1', { id: 'd1', date: T0 + 150, tags: '|INBOX.Drafts|', folderId: 'f-drafts' });
    expect(storage.hasLiveUserDraft('thread-m1')).toBe(true);
  });

  // Breaks: a discarded draft, or the sent copy of a finished reply, blocks
  // every auto-draft in the thread for ever.
  it('is false for a draft in Trash, a \\Deleted draft and a Sent copy that kept its draft tag', async () => {
    await addToThread('thread-m1', { id: 'd1', date: T0 + 150, tags: '|Trash|draft|', folderId: 'f-trash' });
    await addToThread('thread-m1', { id: 'd2', date: T0 + 160, tags: '|Drafts|draft|deleted|' });
    await addToThread('thread-m1', { id: 's1', date: T0 + 170, tags: '|Sent|draft|', folderId: 'f-sent' });
    expect(storage.hasLiveUserDraft('thread-m1')).toBe(false);
  });

  // Breaks: the agent's own saved draft blocks every later auto-draft.
  it("is false for the agent's own draft once its Message-ID is recorded", async () => {
    await addToThread('thread-m1', { id: 'agent', date: T0 + 150, tags: '|Drafts|draft|', messageId: '<Agent-Draft@Host>' });
    expect(storage.hasLiveUserDraft('thread-m1')).toBe(true); // unrecorded: conservatively the user's
    const agent = storage.getRepositories().agent;
    await agent.saveDecision(decision('dec1', 'm2', 'thread-m1'));
    agent.recordDecisionDraftMessageId('dec1', '<Agent-Draft@Host>');
    expect(storage.hasLiveUserDraft('thread-m1')).toBe(false);
  });

  // Breaks: a draft in ANOTHER thread (another account's same thread id lives
  // in another DB; this is the same-DB case) blocks this one.
  it('is false for a draft in another thread', async () => {
    await storage.insertEmail(makeEmail({ id: 'x1', subject: 'Unrelated subject line' }));
    await addToThread('thread-x1', { id: 'dx', date: T0 + 150, tags: '|Drafts|draft|' });
    expect(storage.hasLiveUserDraft('thread-m1')).toBe(false);
    expect(storage.hasLiveUserDraft('thread-x1')).toBe(true);
  });
});

describe('listFirstSplitCandidates — the background scheduler scan', () => {
  const NOW = T0 + DAY;
  const options = { since: NOW - 30 * DAY, scanLimit: 100, version: FIRST_SPLIT_VERSION, now: NOW, maxAttempts: FIRST_SPLIT_MAX_ATTEMPTS };
  const candidateIds = (): string[] => storage.listFirstSplitCandidates(options).map((c) => c.threadId).sort();

  async function threadWith(id: string, date = T0, over: Partial<EmailRecord> = {}): Promise<FirstSplitKey> {
    await storage.insertEmail(makeEmail({ id, date, subject: `Topic ${id} discussion`, ...over }));
    return storage.firstMemberKeySync(`thread-${id}`)!;
  }

  // Breaks: the scheduler never re-splits (nothing nominated), or re-queues
  // finished threads every 45 seconds (everything nominated).
  it('nominates only threads without a current, settled row', async () => {
    await threadWith('norow');
    const version = await threadWith('version');
    const due = await threadWith('due');
    const notDue = await threadWith('notdue');
    const spent = await threadWith('spent');
    const failed = await threadWith('failed');
    const skipped = await threadWith('skipped');
    const done = await threadWith('done');

    storage.saveFirstSplit(ok(version), NOW);
    db().prepare("UPDATE first_email_splits SET split_version = ? WHERE thread_id = 'thread-version'").run(FIRST_SPLIT_VERSION - 1);
    storage.saveFirstSplit({ key: due, status: 'transient', errorKind: 'timeout' }, NOW - 1000); // due at NOW - 700
    storage.saveFirstSplit({ key: notDue, status: 'transient', errorKind: 'timeout' }, NOW); // due at NOW + 300
    storage.saveFirstSplit({ key: spent, status: 'transient', errorKind: 'timeout' }, NOW - 1000);
    db().prepare("UPDATE first_email_splits SET attempts = ? WHERE thread_id = 'thread-spent'").run(FIRST_SPLIT_MAX_ATTEMPTS);
    storage.saveFirstSplit({ key: failed, status: 'failed', errorKind: 'client' }, NOW);
    storage.saveFirstSplit({ key: skipped, status: 'skipped', quoteCount: 0 }, NOW);
    storage.saveFirstSplit(ok(done), NOW);

    const found = storage.listFirstSplitCandidates(options);
    expect(found.map((c) => [c.threadId, c.reason]).sort()).toEqual([
      ['thread-due', 'due'],
      ['thread-norow', 'no-row'],
      ['thread-version', 'version'],
    ]);
    // The evidence the scheduler filters on travels with each candidate.
    expect(found.find((c) => c.threadId === 'thread-norow')).toMatchObject({
      subject: 'Topic norow discussion', inReplyTo: null, references: null, lastMessageDate: T0,
    });
  });

  // Breaks: a thread whose first email was deleted keeps its dead split, and
  // one that gained an EARLIER email is never re-split for its new first email.
  it('nominates a thread whose first email is gone or now has an earlier email in front of it', async () => {
    const gone = await threadWith('gone');
    await addToThread('thread-gone', { id: 'gone-2', date: T0 + 10 });
    const earlier = await threadWith('late', T0);
    storage.saveFirstSplit(ok(gone), NOW);
    storage.saveFirstSplit(ok(earlier), NOW);
    expect(candidateIds()).toEqual([]);

    await storage.deleteEmail('gone');
    await storage.insertEmail(makeEmail({ id: 'early', date: T0 - 60, inReplyTo: '<late@example.test>', subject: 'Re: Topic late discussion' }));

    expect(storage.listFirstSplitCandidates(options).map((c) => [c.threadId, c.reason]).sort()).toEqual([
      ['thread-gone', 'first-changed'],
      ['thread-late', 'first-changed'],
    ]);
  });

  // Breaks: a thread with an old draft (or a Trash copy, or an undated row) in
  // front of its first member is nominated on every tick for ever — the loose
  // SQL test must be confirmed by the membership predicate.
  it('does not nominate when only a draft, a Trash copy or an undated row sorts ahead', async () => {
    const key = await threadWith('first', T0);
    storage.saveFirstSplit(ok(key), NOW);
    await addToThread('thread-first', { id: 'draft', date: T0 - 50, tags: '|Drafts|draft|' });
    await addToThread('thread-first', { id: 'binned', date: T0 - 40, tags: '|Trash|', folderId: 'f-trash' });
    await addToThread('thread-first', { id: 'undated', date: 0 });
    // Force the thread row's pointer the way recomputeThreadMeta would (SQL date order).
    db().prepare("UPDATE threads SET first_message_id = 'undated' WHERE id = 'thread-first'").run();
    expect(candidateIds()).toEqual([]);
  });

  /** A thread with a settled ok split whose thread row points at an earlier DRAFT (a loose-test false positive). */
  async function settledWithDraftInFront(id: string, date: number): Promise<void> {
    const key = await threadWith(id, date);
    storage.saveFirstSplit(ok(key), NOW);
    await addToThread(`thread-${id}`, { id: `${id}-draft`, date: date - 50, tags: '|Drafts|draft|' });
    // The pointer recomputeThreadMeta's SQL date order would pick.
    db().prepare('UPDATE threads SET first_message_id = ? WHERE id = ?').run(`${id}-draft`, `thread-${id}`);
  }

  // Breaks: permanent, silent starvation of the background splitter. Threads
  // the SQL pre-selects only because a draft (or a Trash copy, an undated row,
  // a same-second tie) sorts in front of their first member come back on EVERY
  // tick; when they used up scan slots before the membership check rejected
  // them, enough of them newer than a real candidate stopped background splits
  // for good.
  it('rejected pre-selections take no slot: N settled threads with a draft in front + an older no-row thread at scanLimit N', async () => {
    const N = 3;
    for (let i = 0; i < N; i++) await settledWithDraftInFront(`settled${i}`, T0 + 100 + i);
    await threadWith('real', T0 - 1000);

    expect(storage.listFirstSplitCandidates({ ...options, scanLimit: N }).map((c) => [c.threadId, c.reason]))
      .toEqual([['thread-real', 'no-row']]);
    // Nothing about the settled rows changed (their key still matches).
    expect(storage.getFirstSplitSync('thread-settled0')).toMatchObject({ status: 'ok', firstEmailId: 'settled0' });
  });

  // Breaks: a thread holding nothing but a draft is nominated as 'no-row' on
  // every tick — main has no key for it, so the job can never settle it — and
  // takes the slot of a real candidate. DELIBERATE CHANGE: such threads were
  // nominated before; there is nothing in them to split.
  it('never nominates a thread with no member (only a draft), and it takes no slot', async () => {
    await storage.insertEmail(makeEmail({ id: 'lonedraft', date: T0 + 500, tags: '|Drafts|draft|', subject: 'Draft only' }));
    await threadWith('real', T0);
    expect(storage.listFirstSplitCandidates({ ...options, scanLimit: 1 }).map((c) => c.threadId)).toEqual(['thread-real']);
  });

  // Breaks: the scheduler's reply/forward filter reads a DRAFT's (or a Trash
  // copy's) subject and headers — the thread row's first_message_id — instead
  // of the first message's, so a looped-in forward is never nominated, or a
  // plain thread is nominated because of the user's own draft.
  it("takes the evidence from the first MEMBER, not from the thread row's first_message_id", async () => {
    await storage.insertEmail(makeEmail({
      id: 'fwd', date: T0, subject: 'Fwd: Budget', inReplyTo: null, references: '<older@x.test>',
    }));
    await addToThread('thread-fwd', {
      id: 'fwd-draft', date: T0 - 50, tags: '|Drafts|draft|', subject: 'My unsent note', inReplyTo: '<nothing@x.test>', references: null,
    });
    db().prepare("UPDATE threads SET first_message_id = 'fwd-draft' WHERE id = 'thread-fwd'").run();

    expect(storage.listFirstSplitCandidates(options)).toEqual([expect.objectContaining({
      threadId: 'thread-fwd', reason: 'no-row', subject: 'Fwd: Budget', inReplyTo: null, references: '<older@x.test>',
    })]);
  });

  // Breaks: a resync that re-created the first email under a new row id (same
  // Message-ID, same body) makes the loose test match on every tick for ever,
  // since nothing rewrote the row; the scan now repoints it and moves on.
  it('self-heals a row whose first email was re-created under a new id, and does not nominate it', async () => {
    const key = await threadWith('orig', T0);
    await addToThread('thread-orig', { id: 'orig-reply', date: T0 + 60 });
    expect(storage.saveFirstSplit(ok(key), NOW).applied).toBe(true);

    await storage.deleteEmail('orig');
    await addToThread('thread-orig', { id: 'orig-resynced', date: T0, messageId: '<orig@example.test>', rawBody: '<p>raw body of orig</p>' });

    expect(candidateIds()).toEqual([]);
    expect(storage.getFirstSplitSync('thread-orig')).toMatchObject({ status: 'ok', firstEmailId: 'orig-resynced' });
    // Idempotent: the healed row no longer matches, and nothing else moved.
    expect(candidateIds()).toEqual([]);
    expect(storage.getFirstSplitSync('thread-orig')).toMatchObject({ firstKey: key.firstKey, sourceFingerprint: key.fingerprint });
  });

  // Breaks: the per-tick cost on the main thread. KNOWN LIMIT, deliberate:
  // rejected pre-selections are bounded rather than free — one scan examines
  // at most scanLimit x FIRST_SPLIT_SCAN_ROWS_PER_SLOT threads, so more
  // permanent false positives than that, all newer than a real candidate,
  // still defer it. At the scheduler's scanLimit of 100 that takes 1000 such
  // threads inside the 30-day window.
  it('KNOWN LIMIT: examines at most scanLimit x FIRST_SPLIT_SCAN_ROWS_PER_SLOT pre-selected threads', async () => {
    expect(FIRST_SPLIT_SCAN_ROWS_PER_SLOT).toBe(10);
    for (let i = 0; i < FIRST_SPLIT_SCAN_ROWS_PER_SLOT; i++) await settledWithDraftInFront(`noise${i}`, T0 + 100 + i);
    await threadWith('real', T0 - 1000);
    expect(storage.listFirstSplitCandidates({ ...options, scanLimit: 1 })).toEqual([]);
    expect(storage.listFirstSplitCandidates({ ...options, scanLimit: 2 }).map((c) => c.threadId)).toEqual(['thread-real']);
  });

  // Breaks: the scan reaches into history (a paid split per ancient thread) or
  // reads the whole mailbox every 45 seconds.
  it('skips threads older than the window, honours the scan limit, newest first', async () => {
    await threadWith('old', NOW - 31 * DAY);
    await threadWith('a', T0 + 1);
    await threadWith('b', T0 + 2);
    await threadWith('c', T0 + 3);
    expect(storage.listFirstSplitCandidates({ ...options, scanLimit: 2 }).map((c) => c.threadId)).toEqual(['thread-c', 'thread-b']);
    expect(candidateIds()).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(storage.listFirstSplitCandidates({ ...options, scanLimit: 0 })).toEqual([]);
  });

  // Breaks: the scheduler's 30-day backlog pass. Its reply/forward filter used
  // to run AFTER the scan, so the 100 newest threads with no current row —
  // newsletters and notifications, which nothing ever settles — filled every
  // slot, and a looped-in 'Fwd:' older than them was never pre-split. With
  // `accept`, only threads the caller takes count against scanLimit.
  it('counts only ACCEPTED candidates against scanLimit: 150 newer non-replies + 1 older Fwd:', async () => {
    for (let i = 0; i < 150; i++) await threadWith(`news${i}`, T0 + 100 + i);
    await threadWith('fwd', T0 - 1000, { subject: 'Fwd: Budget from the partner' });
    const accept = vi.fn((c: { subject: string }) => c.subject.startsWith('Fwd:'));

    // Without the filter the slots fill with the newest non-replies (the old behaviour).
    expect(storage.listFirstSplitCandidates(options).map((c) => c.threadId)).not.toContain('thread-fwd');
    expect(storage.listFirstSplitCandidates({ ...options, accept }).map((c) => [c.threadId, c.reason]))
      .toEqual([['thread-fwd', 'no-row']]);
    // Asked once per confirmed candidate, newest first, the Fwd: last.
    expect(accept).toHaveBeenCalledTimes(151);
    expect(accept.mock.calls[0]![0]).toMatchObject({ threadId: 'thread-news149' });
    expect(accept.mock.calls[150]![0]).toMatchObject({ threadId: 'thread-fwd' });
  });

  // Breaks: scanLimit counting rejected candidates, or `accept` dropping ones it took.
  it('stops at scanLimit accepted candidates and keeps their order', async () => {
    for (let i = 0; i < 4; i++) await threadWith(`r${i}`, T0 + i, { subject: `Re: item ${i}` });
    await threadWith('plain', T0 + 10);
    const accept = (c: { subject: string }) => c.subject.startsWith('Re:');
    expect(storage.listFirstSplitCandidates({ ...options, scanLimit: 2, accept }).map((c) => c.threadId))
      .toEqual(['thread-r3', 'thread-r2']);
  });

  // Breaks: two accounts sharing one answer — each account DB scans its own threads.
  it('scans only its own database (multi-account)', async () => {
    await threadWith('mine');
    const otherDir = mkdtempSync(join(tmpdir(), 'sqlite-storage-first-split-b-'));
    const other = new SQLiteStorage({ dbPath: join(otherDir, 'mail.db') });
    await other.initialize();
    await other.syncFolders(FOLDERS);
    await other.insertEmail(makeEmail({ id: 'mine', subject: 'Topic mine discussion' }));
    const otherKey = other.firstMemberKeySync('thread-mine')!;
    other.saveFirstSplit(ok(otherKey), NOW);

    expect(other.listFirstSplitCandidates(options)).toEqual([]);
    expect(candidateIds()).toEqual(['thread-mine']);
    expect(storage.getFirstSplitSync('thread-mine')).toBeNull();

    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    await other.close();
    rmSync(otherDir, { recursive: true, force: true });
  });
});

describe('skipFirstSplits — the scheduler retiring threads it will never nominate', () => {
  const NOW = T0 + DAY;
  const options = { since: NOW - 30 * DAY, scanLimit: 100, version: FIRST_SPLIT_VERSION, now: NOW, maxAttempts: FIRST_SPLIT_MAX_ATTEMPTS };
  const candidateIds = (): string[] => storage.listFirstSplitCandidates(options).map((c) => c.threadId).sort();

  async function threadWith(id: string, date = T0): Promise<FirstSplitKey> {
    await storage.insertEmail(makeEmail({ id, date, subject: `Notice ${id}` }));
    return storage.firstMemberKeySync(`thread-${id}`)!;
  }

  // Breaks: the candidate set never shrinks — every non-reply thread in the
  // 30-day window is re-scanned (membership + evidence queries, main thread)
  // every 45 s per account, for ever, and keeps older threads out of reach.
  it('writes `skipped` under the current key, and the thread leaves the candidate set', async () => {
    const a = await threadWith('a');
    const b = await threadWith('b');
    expect(candidateIds()).toEqual(['thread-a', 'thread-b']);

    expect(storage.skipFirstSplits(['thread-a', 'thread-b'], NOW)).toBe(2);
    expect(candidateIds()).toEqual([]);
    expect(storage.getFirstSplitSync('thread-a')).toMatchObject({
      status: 'skipped', firstKey: a.firstKey, sourceFingerprint: a.fingerprint, quoteCount: null, parts: null, attempts: 0,
    });
    expect(storage.getFirstSplitSync('thread-b')).toMatchObject({ status: 'skipped', firstKey: b.firstKey });
  });

  // Breaks: a background retire destroying a split the renderer stored meanwhile (a raced run).
  it('keeps a usable split for the current key, and does not count it', async () => {
    const key = await threadWith('done');
    storage.saveFirstSplit(ok(key), NOW);
    expect(storage.skipFirstSplits(['thread-done'], NOW + 1)).toBe(0);
    expect(storage.getFirstSplitSync('thread-done')).toMatchObject({ status: 'ok', updatedAt: NOW });
  });

  // Breaks: a row written for a thread main has no key for (only a draft, or
  // deleted meanwhile) — a row nobody could ever match or settle.
  it('leaves a thread with no member, or no thread at all, alone', async () => {
    await storage.insertEmail(makeEmail({ id: 'lonedraft', tags: '|Drafts|draft|', subject: 'Draft only' }));
    expect(storage.skipFirstSplits(['thread-lonedraft', 'no-such-thread'], NOW)).toBe(0);
    expect(storage.getFirstSplitSync('thread-lonedraft')).toBeNull();
    expect(storage.getFirstSplitSync('no-such-thread')).toBeNull();
    expect(storage.skipFirstSplits([], NOW)).toBe(0);
  });

  // Breaks: an idempotent re-run (two passes racing, a retry after a partial
  // run) changing anything but the timestamp.
  it('is idempotent', async () => {
    await threadWith('a');
    storage.skipFirstSplits(['thread-a'], NOW);
    storage.skipFirstSplits(['thread-a'], NOW + 5);
    expect(storage.getFirstSplitSync('thread-a')).toMatchObject({ status: 'skipped', attempts: 0, nextRetryAt: null });
    expect(candidateIds()).toEqual([]);
  });

  // Breaks: a retired thread staying retired after its first email changed —
  // an earlier message arrived and may be the looped-in one.
  it('does not outlive its key: a new first email makes the thread a candidate again', async () => {
    await threadWith('late', T0);
    storage.skipFirstSplits(['thread-late'], NOW);
    await storage.insertEmail(makeEmail({ id: 'early', date: T0 - 60, inReplyTo: '<late@example.test>', subject: 'Re: Notice late' }));
    expect(storage.listFirstSplitCandidates(options).map((c) => [c.threadId, c.reason]))
      .toEqual([['thread-late', 'first-changed']]);
  });

  // Breaks: a retire in one account's database touching another's (the same thread id exists in both).
  it('writes only its own database (multi-account)', async () => {
    await threadWith('shared');
    const otherDir = mkdtempSync(join(tmpdir(), 'sqlite-storage-first-split-c-'));
    const other = new SQLiteStorage({ dbPath: join(otherDir, 'mail.db') });
    await other.initialize();
    await other.syncFolders(FOLDERS);
    await other.insertEmail(makeEmail({ id: 'shared', subject: 'Notice shared' }));

    expect(storage.skipFirstSplits(['thread-shared'], NOW)).toBe(1);
    expect(other.getFirstSplitSync('thread-shared')).toBeNull();
    expect(other.listFirstSplitCandidates(options).map((c) => c.threadId)).toEqual(['thread-shared']);

    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    await other.close();
    rmSync(otherDir, { recursive: true, force: true });
  });
});
