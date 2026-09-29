import { conversationMembers, type EmailRecord } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReadModelMaintainer } from '../../../src/read-model-maintainer';
import { EmailRepository } from '../../../src/repositories/email-repository';
import { SearchRepository } from '../../../src/repositories/search-repository';
import { conversationFoldersIn } from '../../../src/repositories/thread-sql';
import { newMigratedDb } from '../../../src/test-support/test-db';

// What breaks if this file fails: "a count that disagrees with the list". The
// list row's "(N)" is SQL (`threadMessageCountSql`); the thread the row opens
// is core's `conversationMembers` in JS. They are two implementations of one
// rule, so this holds them together on a real database, through every list
// and search query that carries the count.
//
// DELIBERATE BEHAVIOUR CHANGE pinned here: the count now follows the
// membership predicate — a Sent copy that kept a stale `|draft|` tag IS
// counted (it is the user's own reply), also in a provider Sent folder known
// only from the folders table (iCloud's `Sent Messages`), and a draft in the
// provider's Drafts folder (`INBOX.Drafts`, likewise) is NOT.

const NOW = 1_800_000_000;

type Seed = { id: string; thread: string; tags: string; date?: number; folderId?: string };

// Each thread is one shape the count used to get wrong, or a tier of the rule.
const FIXTURE: Seed[] = [
  // Sent copy with a stale |draft| — now COUNTED (was dropped).
  { id: 'sd1', thread: 'sentdraft', tags: 'INBOX', date: NOW },
  { id: 'sd2', thread: 'sentdraft', tags: 'Sent|draft', date: NOW + 1, folderId: 'f-sent' },
  // Stale-marker copy in a provider Sent folder — now COUNTED (was dropped).
  { id: 'ps1', thread: 'providersent', tags: 'INBOX', date: NOW },
  { id: 'ps2', thread: 'providersent', tags: 'Sent Messages|draft', date: NOW + 1, folderId: 'f-psent' },
  // Provider-path draft — now EXCLUDED (was counted).
  { id: 'pd1', thread: 'providerdraft', tags: 'INBOX', date: NOW },
  { id: 'pd2', thread: 'providerdraft', tags: 'INBOX.Drafts', date: NOW + 1, folderId: 'f-pdrafts' },
  // Trashed draft and a Trash copy — never counted.
  { id: 'td1', thread: 'trasheddraft', tags: 'INBOX', date: NOW },
  { id: 'td2', thread: 'trasheddraft', tags: 'Trash|draft', date: NOW + 1, folderId: 'f-trash' },
  { id: 'tc1', thread: 'trashcopy', tags: 'INBOX', date: NOW },
  { id: 'tc2', thread: 'trashcopy', tags: 'INBOX', date: NOW + 1 },
  { id: 'tc3', thread: 'trashcopy', tags: 'Trash', date: NOW + 2, folderId: 'f-trash' },
  // Local mirror and Gmail drafts beside real mail.
  { id: 'gm1', thread: 'gmail', tags: 'INBOX', date: NOW },
  { id: 'gm2', thread: 'gmail', tags: '[Gmail]/Drafts', date: NOW + 1 },
  { id: 'gm3', thread: 'gmail', tags: 'INBOX|draft', date: NOW + 2 },
  // A user folder whose name contains "draft" — ordinary mail.
  { id: 'uf1', thread: 'userfolder', tags: 'INBOX', date: NOW },
  { id: 'uf2', thread: 'userfolder', tags: 'Drafting', date: NOW + 1, folderId: 'f-drafting' },
  // All-junk conversation (tier 2): the non-draft rows, never the live draft.
  { id: 'aj1', thread: 'alljunk', tags: 'Junk', date: NOW, folderId: 'f-junk' },
  { id: 'aj2', thread: 'alljunk', tags: 'Junk', date: NOW + 1, folderId: 'f-junk' },
  { id: 'aj3', thread: 'alljunk', tags: 'INBOX|draft', date: NOW + 2 },
  // Drafts-only thread (tier 3, display-only).
  { id: 'do1', thread: 'draftsonly', tags: 'Drafts', date: NOW, folderId: 'f-drafts' },
  { id: 'do2', thread: 'draftsonly', tags: 'Drafts', date: NOW + 1, folderId: 'f-drafts' },
  // Plain conversation with a same-second pair.
  { id: 'pl1', thread: 'plain', tags: 'INBOX|read', date: NOW },
  { id: 'pl2', thread: 'plain', tags: 'INBOX', date: NOW },
  { id: 'pl3', thread: 'plain', tags: 'Sent', date: NOW + 5, folderId: 'f-sent' },
];

function newDb(): Database.Database {
  const db = newMigratedDb();
  const folder = db.prepare('INSERT INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)');
  folder.run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
  folder.run('f-pdrafts', 'Drafts', 'INBOX.Drafts', '\\Drafts');
  folder.run('f-drafts', 'Drafts', 'Drafts', null);
  folder.run('f-drafting', 'Drafting', 'Drafting', null);
  folder.run('f-trash', 'Trash', 'Trash', '\\Trash');
  folder.run('f-junk', 'Junk', 'Junk', '\\Junk');
  folder.run('f-sent', 'Sent', 'Sent', '\\Sent');
  folder.run('f-psent', 'Sent Messages', 'Sent Messages', null);
  return db;
}

async function seed(repo: EmailRepository, db: Database.Database, rows: Seed[]): Promise<void> {
  for (const row of rows) {
    db.prepare(`INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
                VALUES (?, 's', '<a>', '<a>', 0)`).run(row.thread);
    await repo.insert({
      id: row.id, messageId: `<${row.id}@test>`, threadId: row.thread, folderId: row.folderId ?? 'f-inbox',
      uid: 1, subject: 'Parity', fromAddress: `${row.id}@x.test`, fromName: null, toAddress: 'me@x.test',
      toNames: null, ccAddress: null, ccNames: null, bccAddress: null, bccNames: null, replyTo: null,
      date: row.date ?? NOW, receivedDate: row.date ?? NOW, cleanBody: `parity body ${row.id}`,
      rawBody: `<p>${row.id}</p>`, contentType: 'html', contentHash: `h-${row.id}`, inReplyTo: null,
      references: null, priority: null, tags: `|${row.tags}|`, hasAttachments: false, attachmentCount: 0,
      attachmentNames: null, embeddingLastGenerated: null,
    } as unknown as EmailRecord);
  }
}

describe('list count == conversation members', () => {
  let db: Database.Database;
  let repo: EmailRepository;
  let search: SearchRepository;

  beforeEach(async () => {
    db = newDb();
    repo = new EmailRepository(() => db);
    search = new SearchRepository(() => db, (row) => repo.rowToRecord(row));
    await seed(repo, db, FIXTURE);
  });
  afterEach(() => db.close());

  /** The one sanctioned difference: a drafts-only thread shows every row, not 0. */
  const expectedCount = (threadId: string): number => {
    const members = repo.getConversationMembers(threadId).length;
    if (members > 0) return members;
    return FIXTURE.filter((s) => s.thread === threadId).length;
  };

  const assertParity = (rows: EmailRecord[], label: string): Set<string> => {
    expect(rows.length, `${label} returned rows`).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.threadId);
      expect([label, row.id, row.threadMessageCount]).toEqual([label, row.id, expectedCount(row.threadId)]);
    }
    return seen;
  };

  // Every list/search shape that carries thread_message_count, over the
  // folders the fixture threads list in.
  it('agrees on every list and search query', async () => {
    const page = { limit: 200, offset: 0 };
    const seen = new Set<string>();
    for (const folderId of ['f-inbox', 'f-junk', 'f-drafts', 'f-sent']) {
      for (const t of assertParity(await repo.getByFolder(folderId, page), `getByFolder ${folderId}`)) seen.add(t);
    }
    assertParity(await repo.search({ query: '', folderPath: 'INBOX', limit: 200 }), 'EmailRepository.search');
    assertParity(search.search({ query: 'parity', limit: 200 }), 'SearchRepository FTS');
    assertParity(search.search({ query: 'parity', folderPath: 'INBOX', limit: 200 }), 'SearchRepository FTS in INBOX');
    // Every fixture thread was checked through at least one list.
    expect([...seen].sort()).toEqual([...new Set(FIXTURE.map((s) => s.thread))].sort());
  });

  // Breaks: the list says (2) for a Junk thread with a live draft reply while
  // the thread view (`emails:thread` -> getByThread) opens only the draft —
  // every real message hidden. Holding the count to getConversationMembers
  // alone could not see it: this holds it to what the thread view OPENS.
  it('equals the members of what the thread view opens (getByThread)', async () => {
    const folders = conversationFoldersIn(db);
    const listed = new Map<string, number | undefined>();
    for (const folderId of ['f-inbox', 'f-junk', 'f-drafts', 'f-sent']) {
      for (const row of await repo.getByFolder(folderId, { limit: 200, offset: 0 })) {
        listed.set(row.threadId, row.threadMessageCount);
      }
    }
    for (const threadId of new Set(FIXTURE.map((s) => s.thread))) {
      const opened = await repo.getByThread(threadId);
      const members = conversationMembers(opened, folders);
      if (threadId === 'draftsonly') {
        // The display-only tier: no members, and the drafts stay for the compose box.
        expect(members).toHaveLength(0);
        expect(opened.map((r) => r.id).sort()).toEqual(['do1', 'do2']);
        continue;
      }
      expect([threadId, listed.get(threadId)]).toEqual([threadId, members.length]);
    }
    // The shape that was broken: the Junk messages AND the live draft (the
    // compose box still needs it) come back, not the draft alone.
    expect((await repo.getByThread('alljunk')).map((r) => r.id).sort()).toEqual(['aj1', 'aj2', 'aj3']);
  });

  // The read-model (thread-paginated) path hydrates through the same meta.
  it('agrees on the read-model list path', async () => {
    new ReadModelMaintainer(() => db).backfillNow();
    expect(repo.readModelReadsEnabled()).toBe(true);
    assertParity(await repo.getByFolder('f-inbox', { limit: 50, offset: 0, collapseThreads: true }), 'listFolderFast');
  });

  // DELIBERATE CHANGE, concretely. Breaks: the user's own replies drop out of
  // "(N)", or a provider-folder draft inflates it.
  it('pins the shapes that changed', async () => {
    const countOf = async (id: string): Promise<number | undefined> =>
      (await repo.search({ query: '', folderPath: 'INBOX', limit: 200 })).find((r) => r.id === id)?.threadMessageCount;
    expect(await countOf('sd1')).toBe(2);      // |Sent|draft| copy now counts
    expect(await countOf('ps1')).toBe(2);      // |Sent Messages|draft| (provider Sent) now counts
    expect(await countOf('pd1')).toBe(1);      // INBOX.Drafts draft no longer counts
    expect(await countOf('td1')).toBe(1);
    expect(await countOf('tc1')).toBe(2);
    expect(await countOf('gm1')).toBe(1);
    expect(await countOf('uf1')).toBe(2);      // "Drafting" is a user folder
    expect(await countOf('pl1')).toBe(3);
    const junk = await repo.getByFolder('f-junk', { limit: 50, offset: 0 });
    expect(junk.map((r) => r.threadMessageCount)).toEqual([2, 2]);
    const drafts = await repo.getByFolder('f-drafts', { limit: 50, offset: 0 });
    expect(drafts.map((r) => r.threadMessageCount)).toEqual([2, 2]); // display-only tier
  });

  // Idempotent: adding the account's Drafts folder later (a sync discovering
  // it) changes the count on the NEXT query, with no cached statement pinning
  // the old answer.
  it('picks up a Drafts folder that appears after the first query', async () => {
    const before = (await repo.search({ query: '', folderPath: 'INBOX', limit: 200 })).find((r) => r.id === 'uf1');
    expect(before?.threadMessageCount).toBe(2);
    db.prepare("UPDATE folders SET special_use = '\\Drafts' WHERE id = 'f-drafting'").run();
    const after = (await repo.search({ query: '', folderPath: 'INBOX', limit: 200 })).find((r) => r.id === 'uf1');
    expect(after?.threadMessageCount).toBe(1);
    expect(after?.threadMessageCount).toBe(repo.getConversationMembers('userfolder').length);
  });
});

describe('list count per account (multi-account)', () => {
  // Breaks: one account's Drafts folder decides another account's "(N)". The
  // same thread id lives in two account databases; each count must come from
  // its OWN folders table — A has INBOX.Drafts as its \Drafts folder, B has no
  // such folder, so the same |INBOX.Drafts| row is a draft in A and a message
  // (in a folder merely called that) in B.
  it("counts the same thread id from each database's own Drafts folders", async () => {
    const accountDb = (withProviderDrafts: boolean): Database.Database => {
      const db = newMigratedDb();
      const folder = db.prepare('INSERT INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)');
      folder.run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
      if (withProviderDrafts) folder.run('f-pdrafts', 'Drafts', 'INBOX.Drafts', '\\Drafts');
      return db;
    };
    const a = accountDb(true);
    const b = accountDb(false);
    try {
      const counts: Record<string, number[]> = {};
      for (const [name, db] of [['A', a], ['B', b]] as const) {
        const repo = new EmailRepository(() => db);
        const search = new SearchRepository(() => db, (row) => repo.rowToRecord(row));
        await seed(repo, db, [
          { id: 'm', thread: 'shared', tags: 'INBOX', date: NOW },
          { id: 'p', thread: 'shared', tags: 'INBOX.Drafts', date: NOW + 1 },
        ]);
        const members = repo.getConversationMembers('shared').length;
        const listRow = (await repo.getByFolder('f-inbox', { limit: 50, offset: 0 })).find((r) => r.id === 'm');
        const searchRow = search.search({ query: 'parity', limit: 50 }).find((r) => r.id === 'm');
        const emailSearchRow = (await repo.search({ query: '', folderPath: 'INBOX', limit: 50 })).find((r) => r.id === 'm');
        counts[name] = [members, listRow?.threadMessageCount ?? -1, searchRow?.threadMessageCount ?? -1,
          emailSearchRow?.threadMessageCount ?? -1];
      }
      expect(counts).toEqual({ A: [1, 1, 1, 1], B: [2, 2, 2, 2] });
    } finally {
      a.close();
      b.close();
    }
  });
});
