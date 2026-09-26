import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emailTagsJoinTable } from '../../src/migrations';
import { EMAIL_TAGS_TABLE, EMAIL_TAGS_TAG_INDEX, hasTagClause } from '../../src/repositories/tag-membership';
import { openTestDb } from '../../src/test-support/test-db';

// v91 turns "which emails carry this tag" from a full scan of `emails` into a
// covering-index seek. `emails` stores message bodies INLINE (~88 KB a row on a
// real mailbox), so `instr(tags, '|X|') > 0` — a function on a column, which no
// index can serve — read the entire table every time. Measured on a 2.46 GB /
// 27,785-email store: one syncFlags pass across 22 folders spent 1,922 ms on
// nothing but those scans, and recalculateFolderCounts logged 795 calls totalling
// 147 SECONDS of main thread.
//
// The derived table is only as good as its maintenance, and THAT is what these
// tests are mostly about. A membership row that goes missing does not look like
// a bug: it looks like mail that quietly left a folder. A membership row that
// lingers looks like mail that is still there and cannot be opened. So every
// write shape the app actually uses is exercised here — the repository's own
// INSERT/UPDATE/DELETE, `INSERT OR REPLACE`, and the ad-hoc bulk
// `UPDATE emails SET tags = replace(tags, ...)` the tag-cleanup paths run.

/** An `emails` table as it exists before v91, with rows already in it. */
function legacyDb(): Database.Database {
  const db = openTestDb();
  db.exec("CREATE TABLE emails (id TEXT PRIMARY KEY, thread_id TEXT, tags TEXT NOT NULL DEFAULT '||')");
  return db;
}

const addEmail = (db: Database.Database, id: string, tags: string): void => {
  db.prepare('INSERT INTO emails (id, tags) VALUES (?,?)').run(id, tags);
};

const memberships = (db: Database.Database): Array<{ email_id: string; tag: string }> =>
  db.prepare(`SELECT email_id, tag FROM ${EMAIL_TAGS_TABLE} ORDER BY email_id, tag`).all() as
    Array<{ email_id: string; tag: string }>;

const membersOf = (db: Database.Database, tag: string): string[] =>
  (db.prepare(`SELECT id FROM emails WHERE ${hasTagClause()} ORDER BY id`).all(tag) as { id: string }[])
    .map((row) => row.id);

/** The predicate v91 replaces, kept here as the parity oracle. */
const membersByInstr = (db: Database.Database, tag: string): string[] =>
  (db.prepare("SELECT id FROM emails WHERE instr(tags, '|' || ? || '|') > 0 ORDER BY id").all(tag) as
    { id: string }[]).map((row) => row.id);

describe('v91 email_tags — upgrading a mailbox that already has mail', () => {
  let db: Database.Database;

  beforeEach(() => { db = legacyDb(); });
  afterEach(() => db.close());

  // The upgrade path for every existing user. A row the backfill misses is a
  // message that vanishes from its folder the moment the counts are recomputed.
  it('backfills a membership row for every tag on every existing email', () => {
    addEmail(db, 'e1', '|INBOX|read|');
    addEmail(db, 'e2', '|INBOX|Work/Reports|');
    addEmail(db, 'e3', '||');              // no tags
    addEmail(db, 'e4', '|Trash|');

    emailTagsJoinTable.up(db, {});

    expect(memberships(db)).toEqual([
      { email_id: 'e1', tag: 'INBOX' },
      { email_id: 'e1', tag: 'read' },
      { email_id: 'e2', tag: 'INBOX' },
      { email_id: 'e2', tag: 'Work/Reports' },
      { email_id: 'e4', tag: 'Trash' },
    ]);
  });

  // Regression: an empty mailbox (fresh install) must still end with the table,
  // the index and the triggers in place — the app writes mail into it moments
  // later, and a missing trigger there is silent.
  it('creates the table, the covering index and all three triggers', () => {
    emailTagsJoinTable.up(db, {});

    const objects = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%email_tags%' ORDER BY name")
      .all() as { name: string }[]).map((row) => row.name);
    expect(objects).toEqual([
      EMAIL_TAGS_TABLE,
      EMAIL_TAGS_TAG_INDEX,
      'trg_email_tags_delete',
      'trg_email_tags_insert',
      'trg_email_tags_update',
    ]);
  });

  // Regression: an interrupted first run leaves the table PARTIALLY populated,
  // and a partial index of membership is the failure that looks like mail
  // vanishing from a folder. The backfill is unconditional and INSERT OR IGNORE
  // precisely so re-running repairs it instead of skipping it.
  it('repairs a partially-populated table on a re-run, and is otherwise idempotent', () => {
    addEmail(db, 'e1', '|INBOX|read|');
    addEmail(db, 'e2', '|Work|');
    emailTagsJoinTable.up(db, {});
    const complete = memberships(db);

    // Simulate the interrupted run: half the memberships were written.
    db.prepare(`DELETE FROM ${EMAIL_TAGS_TABLE} WHERE email_id = 'e2'`).run();
    db.prepare(`DELETE FROM ${EMAIL_TAGS_TABLE} WHERE email_id = 'e1' AND tag = 'read'`).run();

    emailTagsJoinTable.up(db, {});
    expect(memberships(db)).toEqual(complete);

    // And again with nothing missing: no duplicates, no primary-key failure.
    emailTagsJoinTable.up(db, {});
    expect(memberships(db)).toEqual(complete);
  });

  // Regression: `down` has to leave the triggers behind too. A dropped table
  // with a live trigger makes the very next INSERT into `emails` fail.
  it('down removes the triggers as well as the table', () => {
    addEmail(db, 'e1', '|INBOX|');
    emailTagsJoinTable.up(db, {});

    emailTagsJoinTable.down?.(db, {});

    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE '%email_tags%'").get())
      .toEqual({ c: 0 });
    expect(() => addEmail(db, 'e2', '|INBOX|')).not.toThrow();
  });
});

describe('v91 email_tags — the triggers that keep it true', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = legacyDb();
    emailTagsJoinTable.up(db, {});
  });
  afterEach(() => db.close());

  it('records memberships for a newly inserted email', () => {
    addEmail(db, 'e1', '|INBOX|starred|');
    expect(membersOf(db, 'INBOX')).toEqual(['e1']);
    expect(membersOf(db, 'starred')).toEqual(['e1']);
  });

  // Regression: syncFlags rewrites the whole tag string on every flag change.
  // The UPDATE trigger must REPLACE the set, not add to it — a lingering `|read|`
  // membership is a message the unread badge has already stopped counting.
  it('replaces the whole set when tags are rewritten', () => {
    addEmail(db, 'e1', '|INBOX|read|');
    db.prepare("UPDATE emails SET tags = '|INBOX|starred|' WHERE id = 'e1'").run();

    expect(memberships(db)).toEqual([
      { email_id: 'e1', tag: 'INBOX' },
      { email_id: 'e1', tag: 'starred' },
    ]);
  });

  it('drops every membership when the email is deleted', () => {
    addEmail(db, 'e1', '|INBOX|read|');
    db.prepare("DELETE FROM emails WHERE id = 'e1'").run();
    expect(memberships(db)).toEqual([]);
  });

  // Regression: SQLite does NOT fire DELETE triggers for a row removed by
  // REPLACE conflict resolution unless `PRAGMA recursive_triggers` is on. The
  // ingest path uses `INSERT OR REPLACE INTO emails`, so without the INSERT
  // trigger's own delete-before-insert the replaced row's OLD tags survive as
  // phantom memberships — a message counted in a folder it left.
  it('leaves no phantom memberships behind an INSERT OR REPLACE', () => {
    addEmail(db, 'e1', '|INBOX|Trash|read|');
    db.prepare("INSERT OR REPLACE INTO emails (id, tags) VALUES ('e1','|Archive|')").run();

    expect(memberships(db)).toEqual([{ email_id: 'e1', tag: 'Archive' }]);
  });

  // Regression: the reason maintenance lives in TRIGGERS and not in the
  // repository methods. Tag cleanup runs statements like this one directly
  // against `emails`; a TypeScript-side write path would never see them.
  it('follows an ad-hoc bulk UPDATE that rewrites tags in SQL', () => {
    addEmail(db, 'e1', '|INBOX|nobody|');
    addEmail(db, 'e2', '|Work|nobody|');
    addEmail(db, 'e3', '|INBOX|');

    db.prepare("UPDATE emails SET tags = replace(tags, '|nobody|', '|') WHERE instr(tags, '|nobody|') > 0").run();

    expect(membersOf(db, 'nobody')).toEqual([]);
    expect(membersOf(db, 'INBOX')).toEqual(['e1', 'e3']);
    expect(membersOf(db, 'Work')).toEqual(['e2']);
  });

  // Regression: an UPDATE that does not touch `tags` must not churn the table.
  // The trigger is AFTER UPDATE OF tags for exactly that reason.
  it('ignores an update to a column other than tags', () => {
    addEmail(db, 'e1', '|INBOX|');
    db.prepare("UPDATE emails SET thread_id = 't1' WHERE id = 'e1'").run();
    expect(memberships(db)).toEqual([{ email_id: 'e1', tag: 'INBOX' }]);
  });

  // Regression: a message moved to having no tags at all must lose every
  // membership rather than gain an empty-string one.
  it('clears memberships when tags become the empty sentinel', () => {
    addEmail(db, 'e1', '|INBOX|');
    db.prepare("UPDATE emails SET tags = '||' WHERE id = 'e1'").run();
    expect(memberships(db)).toEqual([]);
  });
});

describe('v91 email_tags — parity with the predicate it replaces', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = legacyDb();
    emailTagsJoinTable.up(db, {});
  });
  afterEach(() => db.close());

  // The whole rewrite rests on this: `id IN (SELECT ... WHERE tag = ?)` must
  // select exactly what `instr(tags, '|'||?||'|') > 0` selected. Nested paths are
  // the case that would break first if either side matched a prefix.
  it.each([
    ['INBOX'],
    ['Work'],
    ['Work/Reports'],
    ['read'],
    ['Sarv Inbox/Invoices'],
    ['absent'],
  ])('agrees with instr(tags, ...) for tag %j', (tag) => {
    addEmail(db, 'e1', '|INBOX|read|');
    addEmail(db, 'e2', '|Work|');
    addEmail(db, 'e3', '|Work/Reports|');
    addEmail(db, 'e4', '|Work|Work/Reports|read|');
    addEmail(db, 'e5', '||');
    addEmail(db, 'e6', '|Sarv Inbox/Invoices|INBOX|');

    expect(membersOf(db, tag)).toEqual(membersByInstr(db, tag));
  });

  // DELIBERATE DIVERGENCE, not a parity gap. `instr(tags, '|' || '' || '|')`
  // is `instr(tags, '||')`, which matches the empty-tags SENTINEL — so the old
  // predicate reported every untagged message as a member of the tag named "".
  // The split drops that token on purpose, and no caller ever binds "".
  it('reports no members for the empty tag, where instr matched the sentinel', () => {
    addEmail(db, 'e5', '||');

    expect(membersByInstr(db, '')).toEqual(['e5']);
    expect(membersOf(db, '')).toEqual([]);
  });

  // Regression: SCAN here means the index is unusable and the 1,922 ms is back.
  // `SEARCH ... USING COVERING INDEX` is the whole point of the (tag, email_id)
  // column order — the seek must never touch an `emails` page.
  it('plans the membership sub-select as a covering-index seek', () => {
    addEmail(db, 'e1', '|INBOX|');
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${EMAIL_TAGS_TABLE} WHERE tag = ?`)
      .all('INBOX') as { detail: string }[];

    expect(plan.map((row) => row.detail).join(' ')).toContain(`COVERING INDEX ${EMAIL_TAGS_TAG_INDEX}`);
  });
});
