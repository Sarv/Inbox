// CASA 3.1.4 — the per-repository allow-lists behind `buildUpdateClauses`.
//
// The generic UPDATE builder interpolates the patch's KEYS into SQL as column
// names, and `contacts:update` takes those keys straight from the renderer. Each
// repository now names the only fields its `update` may write. These tests pin
// both halves of that contract against the REAL migrated schema:
// - the hostile half: an injection-shaped key throws and the row is untouched;
// - the compatibility half: every allowed field is a real column (a typo would
//   otherwise turn a legitimate write into a throw), and the writes the sync
//   engine really makes — including the `as any` ones — still land.

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTACT_UPDATE_FIELDS, ContactRepository } from '../../../src/repositories/contact-repository';
import { EMAIL_UPDATE_FIELDS, EmailRepository } from '../../../src/repositories/email-repository';
import { FOLDER_UPDATE_FIELDS, FolderRepository } from '../../../src/repositories/folder-repository';
import { THREAD_UPDATE_FIELDS, ThreadRepository } from '../../../src/repositories/thread-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';

const HOSTILE_KEYS = [
  "name = 'x', email",
  'x --',
  "subject = (SELECT group_concat(email) FROM contacts), subject",
];

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const columnsOf = (db: Database.Database, table: string, schema = 'main'): Set<string> =>
  new Set((db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

let db: Database.Database;

beforeEach(() => {
  db = newMigratedDb();
  db.exec(`
    INSERT INTO folders (id, name, path) VALUES ('f-inbox', 'INBOX', 'INBOX');
    INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
      VALUES ('t1', 'Plan', '<m1>', '<m1>', 100);
    INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
                        clean_body, raw_body, content_type, content_hash)
      VALUES ('e1', '<m1>', 't1', 'f-inbox', 7, '|INBOX|', 'Plan', 'a@b.com', 100, '', '', 'text', 'h1');
  `);
});

afterEach(() => { db.close(); });

// A field in an allow-list that is not a column of its table turns a
// legitimate write into a throw (or, if it was a typo for a real field, makes
// that field unwritable). Checked against the live schema, not a copy.
describe('every allowed field is a real column', () => {
  it.each([
    ['emails', EMAIL_UPDATE_FIELDS, 'main'],
    ['folders', FOLDER_UPDATE_FIELDS, 'main'],
    ['threads', THREAD_UPDATE_FIELDS, 'main'],
    ['contacts', CONTACT_UPDATE_FIELDS, 'shared'],
  ] as const)('%s', (table, fields, schema) => {
    const columns = columnsOf(db, table, schema);
    const missing = [...fields].filter((f) => !columns.has(snake(f)));
    expect(missing).toEqual([]);
  });

  // The deliberate exclusions: the primary key everywhere, the directory's
  // UNIQUE address (provenance joins on it), and the inline body columns the
  // email repository routes to email_bodies itself.
  it('never allows the identity columns or inline bodies', () => {
    for (const fields of [EMAIL_UPDATE_FIELDS, FOLDER_UPDATE_FIELDS, THREAD_UPDATE_FIELDS, CONTACT_UPDATE_FIELDS]) {
      expect(fields.has('id')).toBe(false);
    }
    expect(CONTACT_UPDATE_FIELDS.has('email')).toBe(false);
    expect(CONTACT_UPDATE_FIELDS.has('createdAt')).toBe(false);
    expect(EMAIL_UPDATE_FIELDS.has('cleanBody')).toBe(false);
    expect(EMAIL_UPDATE_FIELDS.has('rawBody')).toBe(false);
  });
});

// The renderer-reachable path (`contacts:update` -> storage.updateContact ->
// ContactRepository.update). If this fails, a compromised renderer can rewrite
// any column of the shared address book — or more — through a crafted key.
describe('ContactRepository.update rejects keys outside its allow-list', () => {
  it.each(HOSTILE_KEYS)('rejects %j and leaves the row untouched', async (key) => {
    const repo = new ContactRepository(() => db);
    const c = await repo.upsert({ email: 'victim@corp.io', name: 'Victim' });
    const before = db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id);

    await expect(repo.update(c.id, { [key]: 'pwned' } as never)).rejects.toThrow(/Refusing to update unknown field/);

    expect(db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id)).toEqual(before);
  });

  // `email` is a real column but not an editable one: rewriting it orphans the
  // contact_accounts provenance every account's counts are joined through.
  it('rejects rewriting the directory key (email) and the id', async () => {
    const repo = new ContactRepository(() => db);
    const c = await repo.upsert({ email: 'keep@corp.io' });
    await expect(repo.update(c.id, { email: 'other@corp.io' })).rejects.toThrow(/unknown field "email"/);
    await expect(repo.update(c.id, { id: 'hijacked' })).rejects.toThrow(/unknown field "id"/);
    expect((await repo.get(c.id))?.email).toBe('keep@corp.io');
  });

  // The two shapes that really reach this path must keep working: the
  // renderer's favourite toggle, and the sync upsert's counter merge (which
  // goes through updateSync). Breaking either silently stops contact upkeep.
  it('still accepts the favourite toggle and the upsert counter merge', async () => {
    const repo = new ContactRepository(() => db);
    const c = await repo.upsert({ email: 'fav@corp.io', receivedCount: 1 });
    await repo.update(c.id, { isFavorite: true });
    await repo.upsert({ email: 'fav@corp.io', name: 'Fav', firstSeen: 1, lastSeen: 2, sentCount: 1, receivedCount: 1 });
    expect(await repo.get(c.id)).toMatchObject({ isFavorite: true, name: 'Fav', sentCount: 1, receivedCount: 2 });
  });
});

describe('FolderRepository.update allow-list', () => {
  // The folder syncer and the poller write these two watermarks through an
  // `as any` (columns that are not FolderRecord fields). Leaving them off the
  // list would throw out of syncFolder on EVERY sync, before any mail arrived.
  it('accepts the server-count watermarks the sync engine writes', async () => {
    const repo = new FolderRepository(() => db);
    await repo.update('f-inbox', { lastKnownMessageCount: 42, lastKnownUidnext: 99 } as never);
    expect(db.prepare('SELECT last_known_message_count AS c, last_known_uidnext AS n FROM folders WHERE id = ?').get('f-inbox'))
      .toEqual({ c: 42, n: 99 });
    expect((await repo.get('f-inbox'))?.serverMessageCount).toBe(42);
  });

  it.each(HOSTILE_KEYS)('rejects %j', async (key) => {
    const repo = new FolderRepository(() => db);
    await expect(repo.update('f-inbox', { [key]: 1 } as never)).rejects.toThrow(/Refusing to update unknown field/);
    expect((await repo.get('f-inbox'))?.name).toBe('INBOX');
  });
});

describe('ThreadRepository.update allow-list', () => {
  it.each(HOSTILE_KEYS)('rejects %j', async (key) => {
    const repo = new ThreadRepository(() => db);
    await expect(repo.update('t1', { [key]: 1 } as never)).rejects.toThrow(/Refusing to update unknown field/);
    expect((await repo.get('t1'))?.subject).toBe('Plan');
  });
});

describe('EmailRepository.update allow-list', () => {
  it.each(HOSTILE_KEYS)('rejects %j and leaves the row untouched', async (key) => {
    const repo = new EmailRepository(() => db);
    await expect(repo.update('e1', { [key]: 1 } as never)).rejects.toThrow(/Refusing to update unknown field/);
    expect(db.prepare('SELECT subject, tags FROM emails WHERE id = ?').get('e1')).toEqual({ subject: 'Plan', tags: '|INBOX|' });
  });

  // `references` is an SQLite keyword: unquoted, the SET clause was a syntax
  // error, so a header repair that wrote References could never succeed.
  it('writes the keyword column `references` now that columns are quoted', async () => {
    const repo = new EmailRepository(() => db);
    await repo.update('e1', { references: '<p@x> <q@x>', inReplyTo: '<q@x>' });
    expect(db.prepare('SELECT "references" AS r, in_reply_to AS i FROM emails WHERE id = ?').get('e1'))
      .toEqual({ r: '<p@x> <q@x>', i: '<q@x>' });
  });

  // The ordinary sync write (tags + primary folder + a nulled UID through an
  // `as any`) must keep landing, or every move/restore silently reverts.
  it('still accepts the move/restore patch shape', async () => {
    const repo = new EmailRepository(() => db);
    await repo.update('e1', { tags: '|INBOX|starred|', uid: null } as never);
    expect(db.prepare('SELECT tags, uid FROM emails WHERE id = ?').get('e1')).toEqual({ tags: '|INBOX|starred|', uid: null });
  });
});
