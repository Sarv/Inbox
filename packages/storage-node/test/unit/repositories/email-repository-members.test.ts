import { conversationMembers, sourceFingerprintOf, type EmailRecord } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EmailRepository } from '../../../src/repositories/email-repository';
import { conversationFoldersIn } from '../../../src/repositories/thread-sql';
import { newMigratedDb } from '../../../src/test-support/test-db';

// What breaks if this file fails: main's answer to "which rows of this thread
// are the conversation". The first-email AI split takes its input from the
// FIRST member, and the reply drafter reads the members as its context — so a
// draft or a Trash copy slipping in becomes the email the AI splits or the
// message the drafter answers, and a wrong fingerprint refuses every cached
// split. Real SQLite, full production schema, the production write path.

const NOW = 1_800_000_000;

type Seed = {
  id: string;
  thread?: string;
  tags: string;
  date?: number;
  raw?: string;
  messageId?: string;
  folderId?: string;
  from?: string;
};

/** Folders: the provider's Drafts under INBOX (special-use), a user "Drafting" folder, Trash. */
function newDb(withProviderDrafts = true): Database.Database {
  const db = newMigratedDb();
  const folder = db.prepare('INSERT INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)');
  folder.run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
  if (withProviderDrafts) folder.run('f-pdrafts', 'Drafts', 'INBOX.Drafts', '\\Drafts');
  folder.run('f-drafting', 'Drafting', 'Drafting', null);
  folder.run('f-trash', 'Trash', 'Trash', '\\Trash');
  folder.run('f-sent', 'Sent', 'Sent', '\\Sent');
  folder.run('f-psent', 'Sent', 'INBOX.Sent', null);
  folder.run('f-junk', 'Junk', 'Junk', '\\Junk');
  return db;
}

async function add(repo: EmailRepository, db: Database.Database, seed: Seed): Promise<void> {
  const threadId = seed.thread ?? 't1';
  db.prepare(`INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
              VALUES (?, 's', '<a>', '<a>', 0)`).run(threadId);
  const record: Partial<EmailRecord> = {
    id: seed.id,
    messageId: seed.messageId ?? `<${seed.id}@test>`,
    threadId,
    folderId: seed.folderId ?? 'f-inbox',
    uid: 1,
    subject: 'Subject',
    fromAddress: seed.from ?? `${seed.id}@sender.test`,
    fromName: `Name ${seed.id}`,
    toAddress: 'me@test.example',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: seed.date ?? NOW,
    receivedDate: seed.date ?? NOW,
    cleanBody: `clean ${seed.id}`,
    rawBody: seed.raw ?? `<p>${seed.id}</p>`,
    contentType: 'html',
    contentHash: `h-${seed.id}`,
    inReplyTo: null,
    references: null,
    priority: null,
    tags: `|${seed.tags}|`,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    embeddingLastGenerated: null,
  };
  await repo.insert(record as EmailRecord);
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

describe('EmailRepository conversation members', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });
  afterEach(() => db.close());

  // Breaks: a draft of any shape becomes a message the AI splits or the
  // drafter answers.
  it('excludes drafts of every shape, including a provider Drafts path read from the folders table', async () => {
    await add(repo, db, { id: 'm1', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'marker', tags: 'INBOX|draft', date: NOW + 1 });
    await add(repo, db, { id: 'imap', tags: 'Drafts', date: NOW + 2 });
    await add(repo, db, { id: 'gmail', tags: '[Gmail]/Drafts', date: NOW + 3 });
    await add(repo, db, { id: 'provider', tags: 'INBOX.Drafts', date: NOW + 4, folderId: 'f-pdrafts' });
    await add(repo, db, { id: 'sent', tags: 'Sent|draft', date: NOW + 5, folderId: 'f-sent' });

    expect(ids(repo.getConversationMemberRowsSync('t1'))).toEqual(['m1', 'sent']);
    expect(ids(repo.getConversationMembers('t1'))).toEqual(['m1', 'sent']);
    // The light rows still carry every row — the live-draft gate needs them.
    expect(ids(repo.getThreadLightRowsSync('t1')).sort())
      .toEqual(['gmail', 'imap', 'm1', 'marker', 'provider', 'sent']);
  });

  // Breaks: real mail filed in a user folder whose name contains "draft"
  // silently vanishes from its conversation (the substring-rule regression).
  it("keeps mail in a user 'Drafting' folder", async () => {
    await add(repo, db, { id: 'm1', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'filed', tags: 'Drafting', date: NOW + 1, folderId: 'f-drafting' });
    expect(ids(repo.getConversationMembers('t1'))).toEqual(['m1', 'filed']);
  });

  // Breaks: a trashed copy resurrects in the thread; or reading the Trash
  // folder opens an empty conversation.
  it('excludes Trash copies, with the draft-free all-junk fallback', async () => {
    await add(repo, db, { id: 'live', thread: 'mixed', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'binned', thread: 'mixed', tags: 'Trash', date: NOW + 1, folderId: 'f-trash' });
    expect(ids(repo.getConversationMembers('mixed'))).toEqual(['live']);

    await add(repo, db, { id: 'j1', thread: 'junk', tags: 'Trash', date: NOW + 2, folderId: 'f-trash' });
    await add(repo, db, { id: 'j2', thread: 'junk', tags: 'Trash', date: NOW + 3, folderId: 'f-trash' });
    await add(repo, db, { id: 'jd', thread: 'junk', tags: 'INBOX|draft', date: NOW + 4 });
    // The fallback is every NON-draft row: the live draft must not become the
    // conversation just because it is the only non-Trash row.
    expect(ids(repo.getConversationMembers('junk'))).toEqual(['j1', 'j2']);
  });

  // Breaks: main and the renderer order a same-second pair differently, so
  // they disagree about which email is "first".
  it('orders by date, then id, with undated rows last', async () => {
    await add(repo, db, { id: 'b', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'a', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'undated', tags: 'INBOX', date: 0 });
    await add(repo, db, { id: 'early', tags: 'INBOX', date: NOW - 10 });
    expect(ids(repo.getConversationMembers('t1'))).toEqual(['early', 'a', 'b', 'undated']);
  });

  // Breaks: the membership answer drifts from core's (the renderer's) over
  // the same rows.
  it('is exactly core conversationMembers over the light rows', async () => {
    await add(repo, db, { id: 'x1', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'x2', tags: 'INBOX.Drafts', date: NOW + 1, folderId: 'f-pdrafts' });
    await add(repo, db, { id: 'x3', tags: 'Trash|draft', date: NOW + 2, folderId: 'f-trash' });
    expect(ids(repo.getConversationMemberRowsSync('t1')))
      .toEqual(ids(conversationMembers(repo.getThreadLightRowsSync('t1'), conversationFoldersIn(db))));
    expect(ids(repo.getConversationMemberRowsSync('t1'))).toEqual(['x1']);
  });

  // Breaks: the user's own reply in a provider Sent folder that kept a stale
  // |draft| tag drops out of the members — the drafter and the AI never see it.
  it("keeps a stale-marker copy in the account's own Sent folder", async () => {
    // 'INBOX.Sent' is not special-use here, but its last segment is not a Sent
    // name either — so the server must advertise it for this to apply.
    db.prepare("UPDATE folders SET special_use = '\\Sent' WHERE id = 'f-psent'").run();
    db.prepare("UPDATE folders SET special_use = NULL WHERE id = 'f-sent'").run();
    await add(repo, db, { id: 'm1', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'mine', tags: 'INBOX.Sent|draft', date: NOW + 1, folderId: 'f-psent' });
    expect(ids(repo.getConversationMembers('t1'))).toEqual(['m1', 'mine']);
  });

  it('answers empty for an unknown or drafts-only thread', async () => {
    expect(repo.getConversationMembers('nope')).toEqual([]);
    expect(repo.firstMemberKeySync('nope')).toBeNull();
    await add(repo, db, { id: 'd', thread: 'onlydraft', tags: 'Drafts' });
    expect(repo.getConversationMembers('onlydraft')).toEqual([]);
    expect(repo.firstMemberKeySync('onlydraft')).toBeNull();
  });

  // Breaks: the returned records are list rows (snippet, no raw body) — the
  // AI split and the drafter would get no body to work from.
  it('returns full records with their bodies', async () => {
    await add(repo, db, { id: 'full', tags: 'INBOX', raw: '<p>the whole body</p>' });
    const [record] = repo.getConversationMembers('t1');
    expect(record.rawBody).toBe('<p>the whole body</p>');
    expect(record.cleanBody).toBe('clean full');
  });

  it('light rows carry the membership fields and nothing heavy', async () => {
    await add(repo, db, { id: 'l1', tags: 'INBOX|read', date: NOW, messageId: '<L1@test>', from: 'l1@x.test' });
    expect(repo.getThreadLightRowsSync('t1')).toEqual([{
      id: 'l1', messageId: '<L1@test>', tags: '|INBOX|read|', date: NOW, fromAddress: 'l1@x.test', fromName: 'Name l1',
    }]);
  });
});

describe('EmailRepository.firstMemberKeySync', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });
  afterEach(() => db.close());

  const storedRaw = (id: string): string =>
    (db.prepare('SELECT raw_body FROM email_bodies WHERE email_id = ?').get(id) as { raw_body: string }).raw_body;

  // Breaks: an earliest row that is a draft or a Trash copy becomes the AI
  // split's input.
  it('skips an earlier draft and an earlier Trash copy when picking the first member', async () => {
    await add(repo, db, { id: 'draft', tags: 'INBOX.Drafts', date: NOW - 20, folderId: 'f-pdrafts' });
    await add(repo, db, { id: 'binned', tags: 'Trash', date: NOW - 10, folderId: 'f-trash' });
    await add(repo, db, { id: 'real', tags: 'INBOX', date: NOW, messageId: '<Real@Host>' });
    await add(repo, db, { id: 'later', tags: 'INBOX', date: NOW + 10 });
    expect(repo.firstMemberKeySync('t1')).toEqual({
      threadId: 't1', firstKey: 'real@host', firstEmailId: 'real', fingerprint: sourceFingerprintOf(storedRaw('real')),
    });
  });

  // Breaks: two processes pick different first emails for a same-second pair.
  it('breaks a same-second tie by id', async () => {
    await add(repo, db, { id: 'zz', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'aa', tags: 'INBOX', date: NOW });
    expect(repo.firstMemberKeySync('t1')?.firstEmailId).toBe('aa');
  });

  // Breaks: the inline-image key mismatch — every save refused as stale,
  // because the fingerprint was taken over the INFLATED body (base64 put back)
  // on one side and the stored `sarv-inline:` form on the other.
  it('hashes the STORED body: stable across rowToRecord inflation, changes when the body does', async () => {
    const image = Buffer.from(Array.from({ length: 1500 }, (_, i) => i % 251));
    const body = `<p>hello</p><img src="data:image/png;base64,${image.toString('base64')}"><p>bye</p>`;
    await add(repo, db, { id: 'img', tags: 'INBOX', raw: body });

    const stored = storedRaw('img');
    expect(stored).toContain('sarv-inline:'); // the production write path relocated it
    const before = repo.firstMemberKeySync('t1');
    const inflated = (await repo.get('img'))?.rawBody ?? '';
    expect(inflated).toContain('data:image/png;base64,');
    const after = repo.firstMemberKeySync('t1');

    expect(after).toEqual(before);
    expect(before?.fingerprint).toBe(sourceFingerprintOf(stored));
    expect(before?.fingerprint).not.toBe(sourceFingerprintOf(inflated));

    // A re-healed body is a different input: the cached split must go stale.
    db.prepare('UPDATE email_bodies SET raw_body = ? WHERE email_id = ?').run('<p>re-healed</p>', 'img');
    expect(repo.firstMemberKeySync('t1')?.fingerprint).toBe(sourceFingerprintOf('<p>re-healed</p>'));
    expect(repo.firstMemberKeySync('t1')?.fingerprint).not.toBe(before?.fingerprint);
  });

  // Breaks: a first email deleted between the member read and the body read
  // gets a key for an EMPTY body, and a split could be saved against it.
  it('answers null when the first member vanishes between its two reads', () => {
    class Racing extends EmailRepository {
      override getConversationMemberRowsSync() {
        return [{ id: 'gone', messageId: '<gone@test>', tags: '|INBOX|', date: NOW, fromAddress: 'g@x.test', fromName: null }];
      }
    }
    expect(new Racing(() => db).firstMemberKeySync('t1')).toBeNull();
  });

  // Breaks: an earlier email arriving mid-run is not noticed, and a split of
  // the old first email is cached as the thread's.
  it('moves to an earlier email that arrives later', async () => {
    await add(repo, db, { id: 'second', tags: 'INBOX', date: NOW });
    expect(repo.firstMemberKeySync('t1')?.firstEmailId).toBe('second');
    await add(repo, db, { id: 'first', tags: 'INBOX', date: NOW - 100 });
    expect(repo.firstMemberKeySync('t1')?.firstEmailId).toBe('first');
  });
});

describe('EmailRepository.hasNewerMember', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });
  afterEach(() => db.close());

  // Breaks: auto-draft answers an email somebody already replied to — or is
  // blocked forever by a newer draft or a newer trashed copy.
  it('counts a newer member but not a newer draft, Trash copy or undated row', async () => {
    await add(repo, db, { id: 'e', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'd', tags: 'INBOX.Drafts', date: NOW + 10, folderId: 'f-pdrafts' });
    await add(repo, db, { id: 't', tags: 'Trash', date: NOW + 20, folderId: 'f-trash' });
    await add(repo, db, { id: 'u', tags: 'INBOX', date: 0 });
    expect(repo.hasNewerMember('t1', 'e')).toBe(false);

    await add(repo, db, { id: 'reply', tags: 'Sent', date: NOW + 30, folderId: 'f-sent' });
    expect(repo.hasNewerMember('t1', 'e')).toBe(true);
    expect(repo.hasNewerMember('t1', 'reply')).toBe(false);
  });

  // Breaks: an undated email (no or unparseable Date:) in an already-answered
  // thread is auto-drafted — possibly auto-sent. The gate this replaces
  // (ORDER BY date DESC LIMIT 1) skipped it whenever another row existed.
  it('treats any other member as newer than an undated email', async () => {
    await add(repo, db, { id: 'u', tags: 'INBOX', date: 0 });
    await add(repo, db, { id: 'd', tags: 'INBOX.Drafts', date: NOW, folderId: 'f-pdrafts' });
    expect(repo.hasNewerMember('t1', 'u')).toBe(false); // only its own draft: not answered
    await add(repo, db, { id: 'reply', tags: 'Sent', date: NOW - 50, folderId: 'f-sent' });
    expect(repo.hasNewerMember('t1', 'u')).toBe(true);
  });

  // Breaks: an email whose thread_id no longer matches (re-threaded) is
  // compared against nothing, or throws.
  it('uses the email row when it is not in the named thread, and is false for a missing email', async () => {
    await add(repo, db, { id: 'moved', thread: 'elsewhere', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'newer', tags: 'INBOX', date: NOW + 5 });
    expect(repo.hasNewerMember('t1', 'moved')).toBe(true);
    expect(repo.hasNewerMember('t1', 'missing')).toBe(false);
  });
});

describe('EmailRepository.getByThread — what the thread view opens', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });
  afterEach(() => db.close());

  const opened = async (thread: string): Promise<string[]> => ids(await repo.getByThread(thread)).sort();

  // Breaks: a Junk (or Trash) thread with a live draft reply opens as the
  // draft ALONE — the Trash filter left one row, so the all-junk fallback never
  // ran — and every real message is hidden while the list row says (2).
  it('falls back to the whole thread when only drafts survive the Trash filter', async () => {
    await add(repo, db, { id: 'j1', thread: 'junk', tags: 'Junk', date: NOW, folderId: 'f-junk' });
    await add(repo, db, { id: 'j2', thread: 'junk', tags: 'Junk', date: NOW + 1, folderId: 'f-junk' });
    await add(repo, db, { id: 'd', thread: 'junk', tags: 'Drafts|draft', date: NOW + 2 });
    expect(await opened('junk')).toEqual(['d', 'j1', 'j2']);
    // A provider-path draft is a draft too — read from THIS database's folders.
    await add(repo, db, { id: 'p1', thread: 'junk2', tags: 'Trash', date: NOW, folderId: 'f-trash' });
    await add(repo, db, { id: 'p2', thread: 'junk2', tags: 'INBOX.Drafts', date: NOW + 1, folderId: 'f-pdrafts' });
    expect(await opened('junk2')).toEqual(['p1', 'p2']);
  });

  // Breaks: the existing fallbacks and filters regress — an all-Trash thread
  // stops opening, a trashed copy reappears in a live thread, or a drafts-only
  // thread starts showing its discarded (trashed) drafts.
  it('keeps the other shapes as they were', async () => {
    await add(repo, db, { id: 't1', thread: 'alltrash', tags: 'Trash', date: NOW, folderId: 'f-trash' });
    await add(repo, db, { id: 't2', thread: 'alltrash', tags: 'Trash', date: NOW + 1, folderId: 'f-trash' });
    expect(await opened('alltrash')).toEqual(['t1', 't2']);

    await add(repo, db, { id: 'live', thread: 'mixed', tags: 'INBOX', date: NOW });
    await add(repo, db, { id: 'binned', thread: 'mixed', tags: 'Trash', date: NOW + 1, folderId: 'f-trash' });
    await add(repo, db, { id: 'reply', thread: 'mixed', tags: 'INBOX|draft', date: NOW + 2 });
    expect(await opened('mixed')).toEqual(['live', 'reply']);

    await add(repo, db, { id: 'draft', thread: 'onlydrafts', tags: 'Drafts', date: NOW });
    await add(repo, db, { id: 'discarded', thread: 'onlydrafts', tags: 'Trash|draft', date: NOW + 1, folderId: 'f-trash' });
    expect(await opened('onlydrafts')).toEqual(['draft']);

    await add(repo, db, { id: 'gone', thread: 'binneddrafts', tags: 'Trash|draft', date: NOW, folderId: 'f-trash' });
    expect(await opened('binneddrafts')).toEqual(['gone']);
    expect(await opened('nope')).toEqual([]);
  });

  // Breaks: the fallback reads another account's folders — the same
  // |INBOX.Drafts| row is a draft where INBOX.Drafts is the \Drafts folder and
  // an ordinary message where it is not.
  it("decides 'draft' from this database's own folders (multi-account)", async () => {
    const other = newDb(false);
    const otherRepo = new EmailRepository(() => other);
    try {
      for (const [r, d] of [[repo, db], [otherRepo, other]] as const) {
        await add(r, d, { id: 'j', thread: 'shared', tags: 'Junk', date: NOW, folderId: 'f-junk' });
        await add(r, d, { id: 'p', thread: 'shared', tags: 'INBOX.Drafts', date: NOW + 1 });
      }
      expect(ids(await repo.getByThread('shared')).sort()).toEqual(['j', 'p']);
      // In the other account 'p' is a message, so the Junk copy stays hidden.
      expect(ids(await otherRepo.getByThread('shared'))).toEqual(['p']);
    } finally {
      other.close();
    }
  });
});

describe('conversation members across accounts', () => {
  // Breaks: one account's Drafts folder decides membership in another
  // account's database — the same thread id in two mailboxes must be answered
  // from each database's OWN folder list.
  it('reads each database’s own Drafts paths for the same thread id', async () => {
    const a = newDb(true);
    const b = newDb(false);
    const repoA = new EmailRepository(() => a);
    const repoB = new EmailRepository(() => b);
    try {
      for (const [repo, db] of [[repoA, a], [repoB, b]] as const) {
        await add(repo, db, { id: 'm', tags: 'INBOX', date: NOW });
        await add(repo, db, { id: 'p', tags: 'INBOX.Drafts', date: NOW + 1, folderId: 'f-inbox' });
      }
      // Account A has INBOX.Drafts as its \Drafts folder: that row is a draft.
      expect(ids(repoA.getConversationMembers('t1'))).toEqual(['m']);
      // Account B has no such folder: in B it is just a folder called that.
      expect(ids(repoB.getConversationMembers('t1'))).toEqual(['m', 'p']);
    } finally {
      a.close();
      b.close();
    }
  });
});
