import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  THREAD_FIRST_SENDER_SQL,
  THREAD_LAST_SENDER_SQL,
  THREAD_MESSAGE_COUNT_SQL,
  THREAD_META_SHARED,
  THREAD_STATE_EXCLUDED_FOLDERS,
  LISTING_EXCLUDED_FOLDERS,
  draftExclusion,
  isShadowedInFolder,
  listingExclusion,
  liveUnreadSum,
  threadFolderExclusion,
  threadTagExists,
  unreadInFolderPredicate,
} from '../../../src/repositories/thread-sql';
import { openTestDb } from '../../../src/test-support/test-db';


// These fragments are the SINGLE definition of "what counts as part of a
// conversation" for the list views AND search. Every test here EXECUTES the
// fragment against real seeded rows, because the danger is never that the string
// looks wrong — it's that `instr(tags, '|Trash|')` silently swallows a user's
// folder called "Trash Archive", or that a `|drafting|` label is mistaken for a
// draft copy, which would hide real mail / deflate a thread's "(N)" count.

/**
 * Minimal shape the fragments correlate on. Only these columns are referenced,
 * and `thread_id` is nullable here so the fragments can be probed against a row
 * the read model would consider orphaned.
 */
function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      tags TEXT NOT NULL DEFAULT '||',
      from_name TEXT,
      from_address TEXT,
      date INTEGER NOT NULL
    );
  `);
  return db;
}

type Seed = {
  id: string;
  threadId: string;
  tags: string;
  date: number;
  fromName?: string | null;
  fromAddress?: string;
};

const add = (db: Database.Database, seed: Seed): void => {
  db.prepare(
    'INSERT INTO emails (id, thread_id, tags, from_name, from_address, date) VALUES (?,?,?,?,?,?)',
  ).run(
    seed.id,
    seed.threadId,
    `|${seed.tags}|`,
    seed.fromName === undefined ? `Name ${seed.id}` : seed.fromName,
    seed.fromAddress ?? `${seed.id}@example.com`,
    seed.date,
  );
};

const seedAll = (db: Database.Database, seeds: Seed[]): void => {
  for (const seed of seeds) add(db, seed);
};

// ---------------------------------------------------------------------------
// Independent "per-message truth" — deliberately computed in JS from the seed
// rows, NOT from SQL, so the SQL fragments are checked against a second opinion.
// ---------------------------------------------------------------------------
const DRAFT_TAGS = ['draft', 'Drafts', '[Gmail]/Drafts'];
const hasExactTag = (tags: string, tag: string): boolean => `|${tags}|`.includes(`|${tag}|`);
const isJunk = (seed: Seed): boolean => THREAD_STATE_EXCLUDED_FOLDERS.some((f) => hasExactTag(seed.tags, f));
const isDraft = (seed: Seed): boolean => DRAFT_TAGS.some((t) => hasExactTag(seed.tags, t));
const isUnread = (seed: Seed): boolean => !hasExactTag(seed.tags, 'read');
const senderOf = (seed: Seed): string =>
  seed.fromName === undefined ? `Name ${seed.id}` : (seed.fromName ?? (seed.fromAddress ?? `${seed.id}@example.com`));

describe('thread-sql fragment shape', () => {
  // One structural assertion: the exclusion list is what the rest of the app
  // (and every test below) assumes, and the fragments emit *delimited* tag
  // matches — the property that makes them exact-tag rather than substring.
  it('excludes exactly the deleted/junk folder set and emits delimited matches', () => {
    expect(THREAD_STATE_EXCLUDED_FOLDERS).toEqual([
      'Trash', 'Spam', '[Gmail]/Trash', '[Gmail]/Spam', 'Junk', 'Junk Email', 'Deleted Items',
    ]);
    expect(draftExclusion('x')).toContain("instr(x.tags, '|draft|') = 0");
    expect(threadFolderExclusion('tmc')).toContain("instr(tmc.tags, '|Trash|') = 0");
  });
});

describe('draftExclusion', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });
  afterEach(() => { db.close(); });

  // A draft is not a conversation message: counting the local `|draft|` mirror or
  // an IMAP-synced Drafts copy inflates the list row's "(N)" the moment a user
  // starts a reply. Near-misses must survive: a user label `drafting` and a
  // folder `Drafts Archive` are ordinary mail and must NOT be excluded.
  it('excludes local, IMAP and Gmail draft copies but not look-alike tags', () => {
    seedAll(db, [
      { id: 'plain', threadId: 't1', tags: 'INBOX', date: 1 },
      { id: 'localdraft', threadId: 't1', tags: 'INBOX|draft', date: 2 },
      { id: 'imapdraft', threadId: 't1', tags: 'Drafts', date: 3 },
      { id: 'gmaildraft', threadId: 't1', tags: '[Gmail]/Drafts', date: 4 },
      { id: 'drafting', threadId: 't1', tags: 'INBOX|drafting', date: 5 },
      { id: 'archive', threadId: 't1', tags: 'Drafts Archive', date: 6 },
      { id: 'gmailsub', threadId: 't1', tags: '[Gmail]/Drafts Old', date: 7 },
    ]);

    const kept = (db
      .prepare(`SELECT id FROM emails e WHERE e.thread_id = ? ${draftExclusion('e')} ORDER BY e.id`)
      .all('t1') as Array<{ id: string }>).map((r) => r.id);

    expect(kept).toEqual(['archive', 'drafting', 'gmailsub', 'plain']);
  });
});

describe('liveUnreadSum', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });
  afterEach(() => { db.close(); });

  const sumFor = (threadId: string, col?: string): number =>
    (db
      .prepare(`SELECT ${col ? liveUnreadSum(col) : liveUnreadSum()} AS n FROM emails WHERE thread_id = ?`)
      .get(threadId) as { n: number | null }).n ?? 0;

  // A thread whose ONLY unread copy sits in Trash/Spam (a spam reply, a trashed
  // message) must NOT light up the inbox as unread — that was inflating the
  // "All Inboxes" badge with mail the user can't even see.
  it('counts live unread copies only, ignoring read/trashed/spammed/deleted ones', () => {
    seedAll(db, [
      { id: 'u1', threadId: 'live', tags: 'INBOX', date: 1 },
      { id: 'r1', threadId: 'live', tags: 'INBOX|read', date: 2 },
      { id: 't1', threadId: 'trashed', tags: 'Trash', date: 3 },
      { id: 's1', threadId: 'spammed', tags: 'Spam', date: 4 },
      { id: 'g1', threadId: 'gmailtrash', tags: '[Gmail]/Trash', date: 5 },
      { id: 'g2', threadId: 'gmailspam', tags: '[Gmail]/Spam', date: 6 },
      { id: 'j1', threadId: 'junk', tags: 'Junk', date: 7 },
      { id: 'j2', threadId: 'junkemail', tags: 'Junk Email', date: 8 },
      { id: 'd1', threadId: 'deleteditems', tags: 'Deleted Items', date: 9 },
      { id: 'x1', threadId: 'flaggeddeleted', tags: 'INBOX|deleted', date: 10 },
    ]);

    expect(sumFor('live')).toBe(1);
    for (const dead of [
      'trashed', 'spammed', 'gmailtrash', 'gmailspam', 'junk', 'junkemail', 'deleteditems', 'flaggeddeleted',
    ]) {
      expect(sumFor(dead), `${dead} must not count as unread`).toBe(0);
    }
  });

  // The exclusions are substring matches on a delimited string: a user folder
  // named "Trash Archive"/"Spammers" or a custom `undeleted` tag must keep its
  // unread mail visible. Silently zeroing these hides real unread mail.
  it('does not swallow near-miss folder names or tags', () => {
    seedAll(db, [
      { id: 'n1', threadId: 'nearTrash', tags: 'Trash Archive', date: 1 },
      { id: 'n2', threadId: 'nearSpam', tags: 'Spammers', date: 2 },
      { id: 'n3', threadId: 'nearJunk', tags: 'Junkyard', date: 3 },
      { id: 'n4', threadId: 'nearDeleted', tags: 'INBOX|undeleted', date: 4 },
      { id: 'n5', threadId: 'nearRead', tags: 'INBOX|unread-later', date: 5 },
    ]);

    for (const near of ['nearTrash', 'nearSpam', 'nearJunk', 'nearDeleted', 'nearRead']) {
      expect(sumFor(near), `${near} must still count as unread`).toBe(1);
    }
  });

  // The fragment is used both bare (`tags`) in GROUP BY selects and qualified
  // (`e.tags`) in joined selects — both must compile and agree.
  it('works with the default column and with an explicit qualified column', () => {
    seedAll(db, [
      { id: 'a', threadId: 'tq', tags: 'INBOX', date: 1 },
      { id: 'b', threadId: 'tq', tags: 'INBOX', date: 2 },
      { id: 'c', threadId: 'tq', tags: 'Trash', date: 3 },
    ]);
    const qualified = (db
      .prepare(`SELECT ${liveUnreadSum('e.tags')} AS n FROM emails e WHERE e.thread_id = ?`)
      .get('tq') as { n: number }).n;
    expect(sumFor('tq')).toBe(2);
    expect(qualified).toBe(2);
  });
});

describe('threadFolderExclusion', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });
  afterEach(() => { db.close(); });

  // Single source of "trashed/junked" for every thread-scoped subquery. If it
  // over-matched, opening a thread would hide messages; if it under-matched, a
  // trashed reply would resurrect in the conversation.
  it('drops only exact junk-folder members, for any table alias', () => {
    seedAll(db, [
      { id: 'keep1', threadId: 't1', tags: 'INBOX', date: 1 },
      { id: 'keep2', threadId: 't1', tags: 'Trash Archive', date: 2 },
      { id: 'keep3', threadId: 't1', tags: 'Deleted Items Backup', date: 3 },
      { id: 'drop1', threadId: 't1', tags: 'Trash', date: 4 },
      { id: 'drop2', threadId: 't1', tags: 'INBOX|Junk Email', date: 5 },
      { id: 'drop3', threadId: 't1', tags: 'Deleted Items', date: 6 },
    ]);

    const kept = (db
      .prepare(`SELECT alias.id AS id FROM emails alias WHERE alias.thread_id = ? ${threadFolderExclusion('alias')} ORDER BY alias.id`)
      .all('t1') as Array<{ id: string }>).map((r) => r.id);

    expect(kept).toEqual(['keep1', 'keep2', 'keep3']);
  });
});

describe('threadTagExists', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });
  afterEach(() => { db.close(); });

  const existsFor = (id: string, cond: string): number =>
    (db
      .prepare(`SELECT ${threadTagExists('tte', cond)} AS hit FROM emails WHERE emails.id = ?`)
      .get(id) as { hit: number }).hit;

  // Conversation-wide "is this thread starred/important?" — but a star that only
  // exists on the TRASHED copy must not decorate the live thread, and the row's
  // own thread is the only one that may contribute (the correlated join is on
  // thread_id, and getting that wrong made the query a full table scan).
  it('is true only when a NON-trashed message in the SAME thread matches', () => {
    seedAll(db, [
      { id: 'live', threadId: 't1', tags: 'INBOX', date: 1 },
      { id: 'starredLive', threadId: 't1', tags: 'INBOX|starred', date: 2 },
      { id: 'other', threadId: 't2', tags: 'INBOX', date: 3 },
      { id: 'starredTrash', threadId: 't2', tags: 'Trash|starred', date: 4 },
    ]);

    const starred = "instr(tte.tags, '|starred|') > 0";
    expect(existsFor('live', starred)).toBe(1);   // sibling in the same thread is starred
    expect(existsFor('other', starred)).toBe(0);  // its only star is in Trash
  });

  // A tag that merely *contains* the searched tag ("starred_by_me") must not
  // satisfy the condition — the delimiters are what make it an exact match.
  it('does not match a longer tag that contains the searched one', () => {
    seedAll(db, [
      { id: 'near', threadId: 't3', tags: 'INBOX|starred_by_me', date: 1 },
    ]);
    expect(existsFor('near', "instr(tte.tags, '|starred|') > 0")).toBe(0);
    expect(existsFor('near', "instr(tte.tags, '|starred_by_me|') > 0")).toBe(1);
  });
});

describe('thread metadata SQL agrees with the per-message truth', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });
  afterEach(() => { db.close(); });

  // The whole point of these fragments: a list row's "(N) participants" must
  // equal what you get by counting the actual messages yourself. Any drift shows
  // up as a thread claiming more/fewer messages than it opens with, or the wrong
  // name in the sender column.
  const SEEDS: Seed[] = [
    // Real conversation across Inbox/Sent plus junk + draft noise.
    { id: 'm1', threadId: 'conv', tags: 'INBOX', date: 100, fromName: 'Alice' },
    { id: 'm2', threadId: 'conv', tags: 'Sent|read', date: 200, fromName: 'Me' },
    { id: 'm3', threadId: 'conv', tags: 'INBOX', date: 300, fromName: null, fromAddress: 'bob@example.com' },
    { id: 'm4', threadId: 'conv', tags: 'Trash', date: 350, fromName: 'Trashed Reply' },
    { id: 'm5', threadId: 'conv', tags: 'Spam', date: 360, fromName: 'Spammy' },
    { id: 'm6', threadId: 'conv', tags: 'INBOX|draft', date: 370, fromName: 'Draft Mirror' },
    { id: 'm7', threadId: 'conv', tags: 'Drafts', date: 380, fromName: 'Imap Draft' },
    // A user folder whose name merely LOOKS like Trash — a full member.
    { id: 'm8', threadId: 'conv', tags: 'Trash Archive', date: 390, fromName: 'Archived' },
    // Thread that lives entirely in junk (viewing the Junk folder).
    { id: 'j1', threadId: 'alljunk', tags: 'Junk', date: 400, fromName: 'Junk One' },
    { id: 'j2', threadId: 'alljunk', tags: 'Junk', date: 500, fromName: 'Junk Two' },
    // Thread that is nothing but drafts.
    { id: 'd1', threadId: 'alldraft', tags: 'Drafts', date: 600, fromName: 'Only Draft' },
    // Single live message.
    { id: 's1', threadId: 'solo', tags: 'INBOX', date: 700, fromName: 'Solo' },
  ];

  const liveRows = (threadId: string): Seed[] => SEEDS.filter((s) => s.threadId === threadId && !isJunk(s));

  const expectedCount = (threadId: string): number => {
    const all = SEEDS.filter((s) => s.threadId === threadId);
    const filtered = all.filter((s) => !isJunk(s) && !isDraft(s));
    return filtered.length > 0 ? filtered.length : all.length; // all-junk/all-draft fallback
  };

  const expectedFirstSender = (threadId: string): string | null => {
    const rows = [...liveRows(threadId)].sort((a, b) => a.date - b.date);
    return rows.length > 0 ? senderOf(rows[0]) : null;
  };

  const expectedLastSender = (threadId: string): string | null => {
    const rows = [...liveRows(threadId)].sort((a, b) => b.date - a.date);
    return rows.length > 0 ? senderOf(rows[0]) : null;
  };

  it('message count, first sender and last sender match a hand-computed rollup', () => {
    seedAll(db, SEEDS);

    const meta = db.prepare(`
      SELECT emails.id AS id, emails.thread_id AS threadId, ${THREAD_META_SHARED}
      FROM emails ORDER BY emails.id
    `).all() as Array<{
      id: string;
      threadId: string;
      thread_message_count: number;
      thread_first_sender: string | null;
      thread_last_sender: string | null;
    }>;

    expect(meta).toHaveLength(SEEDS.length);
    for (const row of meta) {
      expect(row.thread_message_count, `count for ${row.id}`).toBe(expectedCount(row.threadId));
      expect(row.thread_first_sender, `first sender for ${row.id}`).toBe(expectedFirstSender(row.threadId));
      expect(row.thread_last_sender, `last sender for ${row.id}`).toBe(expectedLastSender(row.threadId));
    }
  });

  it('pins the concrete expectations the rollup must produce', () => {
    seedAll(db, SEEDS);
    // conv: INBOX×2 + Sent + "Trash Archive" = 4 (Trash/Spam and both drafts out).
    expect(expectedCount('conv')).toBe(4);
    // First sender falls back to from_address when from_name is NULL...
    expect(expectedFirstSender('conv')).toBe('Alice');
    expect(expectedLastSender('conv')).toBe('Archived');
    const bob = db.prepare(`SELECT ${THREAD_FIRST_SENDER_SQL} AS s FROM emails WHERE emails.thread_id = 'conv' AND emails.id = 'm3'`).get() as { s: string };
    expect(bob.s).toBe('Alice');
    const solo = db.prepare(`SELECT ${THREAD_FIRST_SENDER_SQL} AS f, ${THREAD_LAST_SENDER_SQL} AS l FROM emails WHERE emails.id = 's1'`).get() as { f: string; l: string };
    expect(solo).toEqual({ f: 'Solo', l: 'Solo' });
  });

  it('falls back to the unfiltered count for all-junk and all-draft threads', () => {
    seedAll(db, SEEDS);
    const countFor = (id: string): number =>
      (db.prepare(`SELECT ${THREAD_MESSAGE_COUNT_SQL} AS n FROM emails WHERE emails.id = ?`).get(id) as { n: number }).n;

    // Without the COALESCE fallback these collapse to 0 and the Junk/Drafts
    // folder would show "(0)" rows.
    expect(countFor('j1')).toBe(2);
    expect(countFor('d1')).toBe(1);
  });

  it('reports NULL senders for a thread whose every copy is junk', () => {
    seedAll(db, SEEDS);
    // Current behaviour: the sender subqueries have no all-junk fallback, so a
    // Junk-folder row renders with no sender name. Pinned so a future change is
    // a deliberate one.
    const row = db.prepare(`SELECT ${THREAD_FIRST_SENDER_SQL} AS f, ${THREAD_LAST_SENDER_SQL} AS l FROM emails WHERE emails.id = 'j1'`).get() as { f: string | null; l: string | null };
    expect(row).toEqual({ f: null, l: null });
  });

  it('unread rollup from liveUnreadSum matches the per-message unread truth', () => {
    seedAll(db, SEEDS);
    const rows = db.prepare(`
      SELECT thread_id AS threadId, ${liveUnreadSum()} AS unread
      FROM emails GROUP BY thread_id ORDER BY thread_id
    `).all() as Array<{ threadId: string; unread: number }>;

    for (const row of rows) {
      const expected = SEEDS.filter(
        (s) => s.threadId === row.threadId && !isJunk(s) && isUnread(s) && !hasExactTag(s.tags, 'deleted'),
      ).length;
      expect(row.unread, `unread for ${row.threadId}`).toBe(expected);
    }
    // Concretely: the all-junk thread has two unread copies but zero LIVE ones.
    expect(rows.find((r) => r.threadId === 'alljunk')!.unread).toBe(0);
  });
});

describe('listing scope (listingExclusion / isShadowedInFolder / unreadInFolderPredicate)', () => {
  // These three are ONE definition of "does this copy list in folder F", shared
  // by the folder list queries, the read-model's per-folder rows and the sidebar
  // badge. If the SQL and the JS twin ever disagree, the badge (JS full-scan
  // recount) and the list (SQL) drift apart — the "11 unread, filter shows 0" bug.
  it('excludes every other special folder but never the folder being listed', () => {
    expect(LISTING_EXCLUDED_FOLDERS).toContain('Trash');
    expect(LISTING_EXCLUDED_FOLDERS).toContain('Sent');
    expect(listingExclusion('INBOX')).toContain("instr(tags, '|Trash|') = 0");
    expect(listingExclusion('Trash')).not.toContain("'|Trash|'");
    expect(listingExclusion('Trash')).toContain("instr(tags, '|Junk|') = 0");
    expect(listingExclusion(undefined, 'e.tags')).toContain("instr(e.tags, '|Sent|') = 0");
  });

  it('JS twin agrees with the SQL on shadowing, for Set and array inputs', () => {
    expect(isShadowedInFolder(new Set(['INBOX', 'Trash']), 'INBOX')).toBe(true);
    expect(isShadowedInFolder(['INBOX', 'Trash'], 'Trash')).toBe(false);
    expect(isShadowedInFolder(['INBOX', 'Sarv Inbox/Invoices'], 'INBOX')).toBe(false);
    expect(isShadowedInFolder(['Trash', 'Junk'], 'Trash')).toBe(true);
    expect(isShadowedInFolder(['INBOX', 'Trash Archive'], 'INBOX')).toBe(false); // exact token, not prefix
  });

  it('unreadInFolderPredicate executes: unread, not deleted, not shadowed', () => {
    const db = newDb();
    seedAll(db, [
      { id: 'a', threadId: 't', tags: 'INBOX', date: 1 },                 // yes
      { id: 'b', threadId: 't', tags: 'INBOX|read', date: 1 },            // read
      { id: 'c', threadId: 't', tags: 'INBOX|deleted', date: 1 },         // \\Deleted
      { id: 'd', threadId: 't', tags: 'INBOX|Trash', date: 1 },           // shadowed
      { id: 'e', threadId: 't', tags: 'INBOX|Sarv Inbox/Invoices', date: 1 }, // label ≠ shadow
      { id: 'f', threadId: 't', tags: 'Trash', date: 1 },                 // not in INBOX at all
    ]);
    const rows = db.prepare(
      `SELECT id FROM emails WHERE instr(tags, '|INBOX|') > 0 AND ${unreadInFolderPredicate('INBOX')} ORDER BY id`,
    ).all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['a', 'e']);
    // Listing Trash: its own copies count, the INBOX-only ones don't.
    const trash = db.prepare(
      `SELECT id FROM emails WHERE instr(tags, '|Trash|') > 0 AND ${unreadInFolderPredicate('Trash')} ORDER BY id`,
    ).all() as { id: string }[];
    expect(trash.map((r) => r.id)).toEqual(['d', 'f']);
    db.close();
  });
});
