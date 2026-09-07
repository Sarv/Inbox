// Write-path + tag-helper guards for EmailRepository.
//
// This is the layer where a wrong predicate or a dropped column silently LOSES
// MAIL: the tags string is the only folder-membership record we keep, so an
// off-by-one pipe in a tag helper unlinks a message from its mailbox, and an
// insert that forgets a column stores a permanently incomplete message (sync
// skips UIDs already in the DB, so it is never repaired). Everything here runs
// against the REAL production schema (schema.sql + every migration) so a column
// rename or a new NOT NULL constraint fails here instead of only in the app.

import type { EmailRecord } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newMigratedDb, openTestDb } from '../../../src/test-support/test-db';

import {
  EmailRepository,
  PRIMARY_FOLDER_WITH_UID_SQL,
  SENT_FOLDER_PATHS,
  addTag,
  buildTags,
  hasSentFolderTag,
  hasTag,
  imapFlagsToTags,
  parseTags,
  removeTag,
  tagsToImapFlags,
} from '../../../src/repositories/email-repository';

/** Insert the folders the repo resolves paths through, plus a parent thread row
 *  (emails.thread_id is a real FK — foreign_keys is ON in this suite). */
function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO folders (id, name, path) VALUES
      ('f-inbox','INBOX','INBOX'),
      ('f-trash','Trash','Trash'),
      ('f-sent','Sent','Sent'),
      ('f-sent-items','Sent Items','Sent Items'),
      ('f-gsent','Sent Mail','[Gmail]/Sent Mail'),
      ('f-work','Work','Work'),
      ('f-workproj','Projects','Work/Projects'),
      ('f-drafts','Drafts','Drafts');
  `);
}

function ensureThread(db: Database.Database, threadId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
    VALUES (?, 'S', '<a>', '<a>', 0)
  `).run(threadId);
}

let seq = 0;

/** A fully-populated EmailRecord — every column insert() writes gets a distinct,
 *  recognisable value so a swapped/dropped binding shows up as a wrong value. */
function makeEmail(over: Partial<EmailRecord> = {}): EmailRecord {
  seq += 1;
  return {
    id: `e${seq}`,
    messageId: `<m${seq}@x.com>`,
    threadId: `t${seq}`,
    folderId: 'f-inbox',
    uid: 100 + seq,
    tags: '|INBOX|',
    subject: `Subject ${seq}`,
    fromAddress: `sender${seq}@x.com`,
    fromName: `Sender ${seq}`,
    toAddress: `me${seq}@y.com`,
    toNames: `Me ${seq}`,
    ccAddress: `cc${seq}@y.com`,
    ccNames: `Cc ${seq}`,
    bccAddress: `bcc${seq}@y.com`,
    bccNames: `Bcc ${seq}`,
    replyTo: `reply${seq}@x.com`,
    date: 1_700_000_000 + seq,
    receivedDate: 1_700_000_500 + seq,
    cleanBody: `clean body ${seq}`,
    rawBody: `<p>raw body ${seq}</p>`,
    contentType: 'html',
    contentHash: `hash${seq}`,
    inReplyTo: `<parent${seq}@x.com>`,
    references: `<r1@x.com> <r2@x.com>`,
    priority: 'high',
    hasAttachments: true,
    attachmentCount: 2,
    attachmentNames: '["a.pdf","b.png"]',
    attachmentSizes: '[10,20]',
    calendarIcs: 'BEGIN:VCALENDAR',
    calendarAdded: true,
    importanceScore: 77,
    importanceSource: 'ai',
    aiProcessedAt: 1_700_001_000 + seq,
    aiConfidence: 0.5,
    aiReasoning: `because ${seq}`,
    snoozeUntil: 1_700_002_000 + seq,
    snoozeOriginalTags: '|INBOX|read|',
    hasEmbedding: true,
    embeddingLastGenerated: 1_700_003_000 + seq,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

async function insert(repo: EmailRepository, db: Database.Database, over: Partial<EmailRecord> = {}): Promise<EmailRecord> {
  const email = makeEmail(over);
  ensureThread(db, email.threadId);
  await repo.insert(email);
  return email;
}

const rawTags = (db: Database.Database, id: string): string =>
  (db.prepare('SELECT tags FROM emails WHERE id = ?').get(id) as { tags: string }).tags;

// ========================================================================
// Tag helpers — the tags string IS the folder membership record. A helper that
// drops a pipe or matches a substring silently moves mail between mailboxes.
// ========================================================================
describe('tag string helpers', () => {
  // '||' is the canonical "no tags" value stored in the column (NOT NULL DEFAULT
  // '||'); if buildTags([]) ever returned '' the instr(tags,'|x|') predicates
  // would start matching on an empty column.
  it('round-trips a tag list through buildTags/parseTags', () => {
    expect(buildTags([])).toBe('||');
    expect(buildTags(['INBOX'])).toBe('|INBOX|');
    expect(buildTags(['INBOX', 'read', 'important'])).toBe('|INBOX|read|important|');
    expect(parseTags('|INBOX|read|important|')).toEqual(['INBOX', 'read', 'important']);
    expect(parseTags(buildTags(['Work/Projects', 'read']))).toEqual(['Work/Projects', 'read']);
  });

  it('treats empty / sentinel tag strings as no tags', () => {
    expect(parseTags('||')).toEqual([]);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(undefined as unknown as string)).toEqual([]);
    expect(hasTag('', 'read')).toBe(false);
    expect(hasTag(undefined as unknown as string, 'read')).toBe(false);
  });

  // Order is preserved (tags are not sorted) and adding is idempotent — a
  // duplicated tag would make removeTag/instr counting ambiguous.
  it('adds tags idempotently, preserving insertion order', () => {
    const once = addTag('|INBOX|', 'read');
    expect(once).toBe('|INBOX|read|');
    expect(addTag(once, 'read')).toBe(once);
    expect(addTag('||', 'starred')).toBe('|starred|');
    expect(addTag('', 'starred')).toBe('|starred|');
  });

  // removeTag must strip only an EXACT tag: removing the folder 'Work' from a
  // Gmail-labelled mail must not also strip 'Work/Projects' (that would drop the
  // message out of a mailbox the server still lists it in).
  it('removes only the exact tag and collapses back to ||', () => {
    expect(removeTag('|INBOX|read|starred|', 'read')).toBe('|INBOX|starred|');
    expect(removeTag('|read|', 'read')).toBe('||');
    expect(removeTag('|INBOX|', 'missing')).toBe('|INBOX|');
    expect(removeTag('|Work|Work/Projects|', 'Work')).toBe('|Work/Projects|');
    expect(removeTag('|Work|Work/Projects|', 'Work/Projects')).toBe('|Work|');
  });

  // hasTag is the JS twin of instr(tags,'|x|') — it must never match a substring
  // of a tag, or a query for 'BOX' would return every INBOX message.
  it('never matches a partial tag name', () => {
    const tags = '|INBOX|unread-ish|Work/Projects|';
    expect(hasTag(tags, 'INBOX')).toBe(true);
    expect(hasTag(tags, 'BOX')).toBe(false);
    expect(hasTag(tags, 'INBO')).toBe(false);
    expect(hasTag(tags, 'read')).toBe(false);
    expect(hasTag(tags, 'unread-ish')).toBe(true);
    expect(hasTag(tags, 'Work')).toBe(false);
    expect(hasTag(tags, 'Work/Projects')).toBe(true);
  });

  // IMAP flag <-> tag mapping is how read/starred state survives a round trip to
  // the server; a missing entry silently un-reads or un-stars mail on sync.
  it('maps every IMAP system flag to a tag and back', () => {
    const flags = ['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '\\Deleted'];
    const tags = imapFlagsToTags(flags);
    expect(tags).toEqual(['read', 'starred', 'answered', 'draft', 'deleted']);
    expect(tagsToImapFlags(tags)).toEqual(flags);
  });

  it('lowercases unknown backslash flags and drops non-flag keywords', () => {
    expect(imapFlagsToTags(['\\Recent', '\\NonJunk'])).toEqual(['recent', 'nonjunk']);
    expect(imapFlagsToTags(['$Forwarded', 'Junk'])).toEqual([]);
    expect(imapFlagsToTags([])).toEqual([]);
  });

  // Folder and AI-category tags share the column with flag tags; converting back
  // to IMAP flags must skip them (sending 'INBOX' as a flag is a protocol error).
  it('skips folder and category tags when converting back to IMAP flags', () => {
    expect(tagsToImapFlags(['INBOX', 'read', 'important', 'Work/Projects'])).toEqual(['\\Seen']);
    expect(tagsToImapFlags([])).toEqual([]);
  });

  // hasSentFolderTag decides which mail is auto-marked read; it must accept every
  // provider's Sent path case-insensitively and never match a look-alike folder.
  it('recognises every provider sent-folder path, case-insensitively', () => {
    for (const path of SENT_FOLDER_PATHS) {
      expect(hasSentFolderTag(`|${path}|read|`)).toBe(true);
      expect(hasSentFolderTag(`|${path.toUpperCase()}|`)).toBe(true);
    }
    expect(hasSentFolderTag('|INBOX|')).toBe(false);
    expect(hasSentFolderTag('|Sentinel|')).toBe(false);
    expect(hasSentFolderTag('|Unsent|')).toBe(false);
    expect(hasSentFolderTag('')).toBe(false);
  });
});

// The UID/tag folder scans share this fragment so the two row sets can never
// drift; pinning the text keeps a future edit from re-introducing uid=0 rows
// (uid 0 is not a real IMAP UID and would be diffed as a server deletion).
describe('PRIMARY_FOLDER_WITH_UID_SQL', () => {
  it('requires a real (non-null, positive) UID in the primary folder', () => {
    expect(PRIMARY_FOLDER_WITH_UID_SQL).toBe('folder_id = ? AND uid IS NOT NULL AND uid > 0');
  });
});

describe('EmailRepository write paths', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newMigratedDb();
    seed(db);
    repo = new EmailRepository(() => db);
  });

  afterEach(() => {
    db.close();
  });

  // A repository whose accessor has no DB must fail LOUDLY. Silently returning
  // nothing would look like an empty mailbox — i.e. like data loss to the user.
  it('throws "Storage not initialized" when the accessor yields no database', async () => {
    const orphan = new EmailRepository(() => undefined as unknown as Database.Database);
    await expect(orphan.get('e1')).rejects.toThrow('Storage not initialized');
  });

  // ---------------- email_thread_keys (threading index) ----------------
  //
  // `email_thread_keys` is what the thread resolver SEEKS on. It is not part of
  // EmailRecord and nothing reads it back through the repository, which is
  // exactly why it needs pinning here: if a write path stops maintaining it the
  // app looks completely healthy and merely stops threading — replies quietly
  // start their own conversations, and nobody notices for days.

  const threadKey = (id: string): { subject_norm: string; date: number } | undefined =>
    db.prepare('SELECT subject_norm, date FROM email_thread_keys WHERE email_id = ?').get(id) as
      | { subject_norm: string; date: number }
      | undefined;

  it('records the normalized subject key on insert', async () => {
    const email = await insert(repo, db, { subject: 'RE: Fwd: Quarterly report', date: 1_700_000_000 });
    // Prefixes stripped and lower-cased: the reply and its parent must land on
    // the SAME key or the resolver's equality seek can never match them. The
    // date is copied so the resolver's window filter never touches `emails`.
    expect(threadKey(email.id)).toEqual({ subject_norm: 'quarterly report', date: 1_700_000_000 });
  });

  it('records an empty key, never NULL, for a missing subject', async () => {
    const blank = await insert(repo, db, { subject: '' });
    const missing = await insert(repo, db, { subject: null as unknown as string });
    // NULL would drop the row out of idx_email_thread_keys_lookup silently.
    expect(threadKey(blank.id)?.subject_norm).toBe('');
    expect(threadKey(missing.id)?.subject_norm).toBe('');
  });

  it('recomputes the key when a subject is updated', async () => {
    const email = await insert(repo, db, { subject: 'Placeholder' });
    // This is the envelope-repair path: rows stored with a blank/wrong subject
    // get the real one later via update(). A stale key here leaves the row
    // findable only under its OLD subject — the split-thread bug, invisibly.
    await repo.update(email.id, { subject: 'Re: Invoice 42' });
    expect(threadKey(email.id)?.subject_norm).toBe('invoice 42');
  });

  it('recomputes the key when only the date is repaired', async () => {
    const email = await insert(repo, db, { subject: 'Re: Invoice 42', date: 1_000 });
    // The envelope repair also fixes dates. The key carries its own copy, so a
    // date left stale here silently moves the mail outside the resolver's
    // candidate window and it stops being findable at all.
    await repo.update(email.id, { date: 1_700_000_000 });
    expect(threadKey(email.id)).toEqual({ subject_norm: 'invoice 42', date: 1_700_000_000 });
  });

  it('leaves the key alone when the update touches neither subject nor date', async () => {
    const email = await insert(repo, db, { subject: 'Re: Invoice 42', date: 500 });
    await repo.update(email.id, { tags: '|INBOX|read|' });
    expect(threadKey(email.id)).toEqual({ subject_norm: 'invoice 42', date: 500 });
  });

  // The insert statement is cached per database handle now (it used to be
  // recompiled for every row, tens of thousands of times on a first sync).
  // Re-using it must not leak state between rows.
  it('keeps every row correct across repeated inserts on the cached statement', async () => {
    const first = await insert(repo, db, { subject: 'Alpha' });
    const second = await insert(repo, db, { subject: 'Re: Beta' });
    const third = await insert(repo, db, { subject: 'Alpha' });

    expect(threadKey(first.id)?.subject_norm).toBe('alpha');
    expect(threadKey(second.id)?.subject_norm).toBe('beta');
    expect(threadKey(third.id)?.subject_norm).toBe('alpha');
    expect((await repo.get(second.id))!.subject).toBe('Re: Beta');
  });

  // ---------------- insert ----------------

  // Every column the caller supplies must come back out. This is the guard
  // against a silently-swapped or dropped binding in the 40-column INSERT — a
  // dropped body/hash means the message can never be deduped or re-read.
  it('round-trips every column of an inserted email', async () => {
    const email = await insert(repo, db);
    const got = await repo.get(email.id);
    expect(got).not.toBeNull();
    for (const key of Object.keys(email) as Array<keyof EmailRecord>) {
      if (key === 'createdAt' || key === 'updatedAt') continue; // DB-defaulted
      expect({ key, value: got![key] }).toEqual({ key, value: email[key] });
    }
    // Derived-at-read fields
    expect(got!.hasBody).toBe(true);
    expect(got!.isStarred).toBe(false);
    expect(got!.isImportant).toBe(false);
    expect(got!.labels).toEqual(['INBOX']);
    expect(got!.flags).toEqual([]);
  });

  // The falsy-coalescing defaults in insert() are load-bearing: tags '' would
  // break every instr() predicate, and a NULL clean_body/content_hash violates
  // NOT NULL. Also pins that booleans land as 0/1, not 'false'.
  it('applies the documented defaults for missing/falsy optional fields', async () => {
    const email = await insert(repo, db, {
      tags: '',
      hasAttachments: false,
      calendarAdded: false,
      hasEmbedding: false,
      importanceScore: 0,
      importanceSource: undefined,
      aiProcessedAt: undefined,
      aiConfidence: 0,
      aiReasoning: undefined,
      snoozeUntil: undefined,
      snoozeOriginalTags: undefined,
      attachmentSizes: undefined,
      calendarIcs: undefined,
      rawBody: '',
    });
    const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(email.id) as Record<string, unknown>;
    expect(row.tags).toBe('||');
    expect(row.has_attachments).toBe(0);
    expect(row.calendar_added).toBe(0);
    expect(row.has_embedding).toBe(0);
    expect(row.importance_score).toBe(0);
    expect(row.importance_source).toBe('none');
    expect(row.ai_processed_at).toBeNull();
    expect(row.ai_confidence).toBe(0);
    expect(row.snooze_until).toBeNull();
    expect(row.attachment_sizes).toBeNull();
    expect(row.calendar_ics).toBeNull();

    const got = await repo.get(email.id);
    expect(got!.tags).toBe('||');
    expect(got!.labels).toEqual([]);
    // raw_body '' must read back as "no body" so the renderer refetches instead
    // of rendering a blank message.
    expect(got!.hasBody).toBe(false);
  });

  // message_id is UNIQUE — the dedupe boundary. If a duplicate ever inserted
  // silently, the same message would appear twice in every thread.
  it('rejects a duplicate message_id instead of storing the message twice', async () => {
    await insert(repo, db, { messageId: '<dup@x.com>' });
    await expect(insert(repo, db, { messageId: '<dup@x.com>' })).rejects.toThrow(/UNIQUE|constraint/i);
    expect((await repo.getByMessageIds(['<dup@x.com>'])).length).toBe(1);
  });

  // The FTS index is a dependent of the row: an insert that skips it makes the
  // message unsearchable forever (search is index-backed, not a LIKE scan).
  it('indexes the inserted row in emails_fts', async () => {
    const email = await insert(repo, db, { subject: 'Quarterly budget review' });
    const hit = db.prepare('SELECT email_id FROM emails_fts WHERE email_id = ?').get(email.id);
    expect(hit).toEqual({ email_id: email.id });
  });

  // ---------------- update ----------------

  it('updates only the supplied fields and leaves the rest untouched', async () => {
    const email = await insert(repo, db);
    await repo.update(email.id, { subject: 'Changed', tags: '|INBOX|read|', aiReasoning: undefined });
    const got = await repo.get(email.id);
    expect(got!.subject).toBe('Changed');
    expect(got!.tags).toBe('|INBOX|read|');
    expect(got!.aiReasoning).toBe(email.aiReasoning); // undefined => not written
    expect(got!.fromAddress).toBe(email.fromAddress);
    expect(got!.cleanBody).toBe(email.cleanBody);
  });

  it('coerces boolean fields to 0/1 on update', async () => {
    const email = await insert(repo, db, { hasAttachments: true, hasEmbedding: false, calendarAdded: false });
    await repo.update(email.id, { hasAttachments: false, hasEmbedding: true, calendarAdded: true });
    const row = db.prepare('SELECT has_attachments, has_embedding, calendar_added FROM emails WHERE id = ?').get(email.id);
    expect(row).toEqual({ has_attachments: 0, has_embedding: 1, calendar_added: 1 });
  });

  // An all-undefined patch must not build `SET  WHERE id=?` (a SQL syntax error
  // that would abort a whole sync batch).
  it('is a no-op when the patch carries no defined fields', async () => {
    const email = await insert(repo, db);
    await expect(repo.update(email.id, {})).resolves.toBeUndefined();
    await expect(repo.update(email.id, { subject: undefined })).resolves.toBeUndefined();
    expect((await repo.get(email.id))!.subject).toBe(email.subject);
  });

  // Updating a row that no longer exists happens constantly (a concurrent
  // expunge); it must be a silent no-op, never a throw that kills the sync.
  it('silently ignores an update for an unknown id', async () => {
    await expect(repo.update('nope', { subject: 'x' })).resolves.toBeUndefined();
    expect(await repo.get('nope')).toBeNull();
  });

  // Complements email-move-uid.test.ts, which proves the folder-change UID clear
  // against a 4-column stand-in table. Here the same rule is checked on the REAL
  // schema (where uid participates in idx_emails_folder_uid and a NOT NULL could
  // be added by a future migration), plus the two edge inputs that test doesn't
  // reach: an explicitly-nulled UID and a folder change on a row that is gone.
  it('clears a stale UID on a real-schema folder change, and tolerates edge inputs', async () => {
    const moved = await insert(repo, db, { folderId: 'f-trash', uid: 42, tags: '|Trash|' });
    await repo.update(moved.id, { folderId: 'f-inbox', tags: '|INBOX|' });
    const after = await repo.get(moved.id);
    expect(after!.folderId).toBe('f-inbox');
    expect(after!.uid).toBeNull();

    const email = await insert(repo, db, { folderId: 'f-inbox', uid: 42 });
    await repo.update(email.id, { uid: null as unknown as number });
    expect((await repo.get(email.id))!.uid).toBeNull();
    await expect(repo.update('ghost', { folderId: 'f-trash' })).resolves.toBeUndefined();
  });

  // ---------------- delete ----------------

  // Deleting must take the row AND its dependents: a leftover FTS row keeps a
  // deleted message searchable (it would resurrect in results with no body).
  it('deletes the row together with its FTS and attachment dependents', async () => {
    const email = await insert(repo, db);
    db.prepare(`INSERT INTO attachments (id, email_id, filename, content_type, size, file_path)
                VALUES ('a1', ?, 'a.pdf', 'application/pdf', 10, '/tmp/a.pdf')`).run(email.id);

    await repo.delete(email.id);

    expect(await repo.get(email.id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM emails_fts WHERE email_id = ?').get(email.id)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM attachments WHERE email_id = ?').get(email.id)).toEqual({ c: 0 });
  });

  it('ignores a delete for an unknown id', async () => {
    await expect(repo.delete('nope')).resolves.toBeUndefined();
  });

  it('deletes nothing for an empty batch', async () => {
    const email = await insert(repo, db);
    await repo.deleteMany([]);
    expect(await repo.get(email.id)).not.toBeNull();
  });

  // deleteMany chunks at 500 and yields between chunks (a select-all permanent
  // delete must not hold the main-process loop). Crossing the boundary proves
  // NO row is skipped by the chunk arithmetic — a skipped row reappears in the
  // list after the user emptied the folder.
  it('deletes every id across the 500-row chunk boundary', async () => {
    ensureThread(db, 't-bulk');
    const ids = Array.from({ length: 501 }, (_, i) => `bulk-${i}`);
    const stmt = db.prepare(`
      INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address,
                          date, clean_body, raw_body, content_type, content_hash)
      VALUES (?, ?, 't-bulk', 'f-inbox', ?, '|INBOX|', 's', 'a@b.com', 1, '', '', 'text', 'h')
    `);
    db.transaction(() => ids.forEach((id, i) => stmt.run(id, `<${id}@x>`, i + 1)))();
    expect(db.prepare('SELECT COUNT(*) c FROM emails').get()).toEqual({ c: 501 });

    await repo.deleteMany(ids);

    expect(db.prepare('SELECT COUNT(*) c FROM emails').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM emails_fts').get()).toEqual({ c: 0 });
  });

  // deleteByFolder is a HARD delete, so it may only take rows that belong to
  // this folder and nothing else. It used to `DELETE WHERE instr(tags,'|Work|')`,
  // which also destroyed a message that was in INBOX *and* Work (a Gmail label,
  // or a reply in two folders) — that message then vanished from INBOX too, with
  // no server event to bring it back. Dropping just this folder's membership is
  // invalidateFolderMembership's job, not this one's.
  // It must also never match a folder whose path merely CONTAINS the target
  // ('Work' vs 'Work/Projects'), which would wipe a sibling mailbox.
  it('deleteByFolder deletes only rows in NO other folder, never a path prefix match', async () => {
    const inWork = await insert(repo, db, { tags: '|Work|read|' });
    const inSub = await insert(repo, db, { tags: '|Work/Projects|read|' });
    const both = await insert(repo, db, { tags: '|INBOX|Work|' });

    expect(await repo.deleteByFolder('f-work')).toBe(1);
    expect(await repo.get(inWork.id)).toBeNull();          // Work only → gone
    expect(await repo.get(both.id)).not.toBeNull();        // still lives in INBOX
    expect(rawTags(db, both.id)).toBe('|INBOX|Work|');     // untouched, not half-edited
    expect(await repo.get(inSub.id)).not.toBeNull();       // different mailbox
  });

  // Non-folder tags (read/starred/AI categories) are not membership — a row
  // tagged `|Work|read|important|` still belongs to Work alone.
  it('deleteByFolder ignores non-folder tags when deciding whether a row is orphaned', async () => {
    const only = await insert(repo, db, { tags: '|Work|read|starred|promotions|' });
    expect(await repo.deleteByFolder('f-work')).toBe(1);
    expect(await repo.get(only.id)).toBeNull();
  });

  it('deleteByFolder returns 0 for an unknown folder id and for an empty folder', async () => {
    expect(await repo.deleteByFolder('f-does-not-exist')).toBe(0);
    expect(await repo.deleteByFolder('f-drafts')).toBe(0);
  });

  // ---------------- tag mutation ----------------

  it('addTag / removeTag / setTags mutate the stored tags string', async () => {
    const email = await insert(repo, db, { tags: '|INBOX|' });
    await repo.addTag(email.id, 'read');
    expect(rawTags(db, email.id)).toBe('|INBOX|read|');
    await repo.addTag(email.id, 'read'); // idempotent — no rewrite
    expect(rawTags(db, email.id)).toBe('|INBOX|read|');
    await repo.removeTag(email.id, 'read');
    expect(rawTags(db, email.id)).toBe('|INBOX|');
    await repo.removeTag(email.id, 'read'); // absent — no rewrite
    expect(rawTags(db, email.id)).toBe('|INBOX|');
    await repo.setTags(email.id, '|Trash|deleted|');
    expect(rawTags(db, email.id)).toBe('|Trash|deleted|');
  });

  it('addTag / removeTag ignore an unknown email id', async () => {
    await expect(repo.addTag('nope', 'read')).resolves.toBeUndefined();
    await expect(repo.removeTag('nope', 'read')).resolves.toBeUndefined();
  });

  // THE Gmail-label data-loss case: a message labelled INBOX + Work must survive
  // being removed from ONE label. Only that membership tag goes; the row and its
  // other memberships stay, so the mail is still in the other mailboxes.
  it('a multi-folder (Gmail label) row keeps its other memberships when removed from one folder', async () => {
    const email = await insert(repo, db, { tags: '|INBOX|Work|Work/Projects|read|' });

    await repo.removeTag(email.id, 'Work');

    const after = await repo.get(email.id);
    expect(after).not.toBeNull();
    expect(after!.tags).toBe('|INBOX|Work/Projects|read|');
    expect(parseTags(after!.tags)).toContain('INBOX');
    expect(parseTags(after!.tags)).toContain('Work/Projects');
  });

  // ---------------- point / batch lookups ----------------

  it('getByMessageId finds by header id and returns null for an unknown one', async () => {
    const email = await insert(repo, db, { messageId: '<known@x.com>' });
    expect((await repo.getByMessageId('<known@x.com>'))!.id).toBe(email.id);
    expect(await repo.getByMessageId('<unknown@x.com>')).toBeNull();
  });

  // The chunked IN(...) batch lookups must return EVERY match — a chunk boundary
  // that drops ids makes sync re-download (or worse, re-insert) real messages.
  it('getByMessageIds / getByIds return every row across the 500-id chunk boundary', async () => {
    ensureThread(db, 't-batch');
    const ids = Array.from({ length: 501 }, (_, i) => `b-${i}`);
    const stmt = db.prepare(`
      INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address,
                          date, clean_body, raw_body, content_type, content_hash)
      VALUES (?, ?, 't-batch', 'f-inbox', ?, '|INBOX|', 's', 'a@b.com', 1, '', '', 'text', 'h')
    `);
    db.transaction(() => ids.forEach((id, i) => stmt.run(id, `<${id}@x>`, i + 1)))();

    const byIds = await repo.getByIds([...ids, 'missing']);
    expect(new Set(byIds.map((r) => r.id))).toEqual(new Set(ids));

    const byMsgIds = await repo.getByMessageIds([...ids.map((id) => `<${id}@x>`), '<missing@x>']);
    expect(new Set(byMsgIds.map((r) => r.id))).toEqual(new Set(ids));
  });

  it('getByMessageIds / getByIds / getIdsByFolderAndUids short-circuit on an empty list', async () => {
    await insert(repo, db);
    expect(await repo.getByMessageIds([])).toEqual([]);
    expect(await repo.getByIds([])).toEqual([]);
    expect(await repo.getIdsByFolderAndUids('f-inbox', [])).toEqual([]);
  });

  it('getByFolderAndUid / getIdsByFolderAndUids resolve within the primary folder only', async () => {
    const inbox = await insert(repo, db, { folderId: 'f-inbox', uid: 7 });
    await insert(repo, db, { folderId: 'f-trash', uid: 7, tags: '|Trash|' }); // same UID, other mailbox

    expect((await repo.getByFolderAndUid('f-inbox', 7))!.id).toBe(inbox.id);
    expect(await repo.getByFolderAndUid('f-inbox', 999)).toBeNull();
    expect(await repo.getIdsByFolderAndUids('f-inbox', [7, 999])).toEqual([{ id: inbox.id, uid: 7 }]);
  });

  // ---------------- folder UID/tag scans ----------------

  // These feed deletion reconcile: a row wrongly INCLUDED here (uid 0/NULL, or a
  // tag-only cross-folder copy whose primary folder is elsewhere) gets diffed
  // against the server's UID set, found absent, and DELETED. That is the
  // "restored mail vanishes" class of bug.
  it('getUidsInFolder / getTagsInFolder return only primary-folder rows with a real UID', async () => {
    const real = await insert(repo, db, { folderId: 'f-inbox', uid: 5, tags: '|INBOX|read|' });
    await insert(repo, db, { folderId: 'f-inbox', uid: null as unknown as number, tags: '|INBOX|' });
    await insert(repo, db, { folderId: 'f-inbox', uid: 0, tags: '|INBOX|' });
    await insert(repo, db, { folderId: 'f-trash', uid: 9, tags: '|Trash|INBOX|' }); // tagged INBOX, primary Trash

    expect(await repo.getUidsInFolder('f-inbox')).toEqual([{ id: real.id, uid: 5 }]);
    expect(await repo.getTagsInFolder('f-inbox')).toEqual([{ id: real.id, uid: 5, tags: '|INBOX|read|' }]);
    expect(await repo.getUidsInFolder('f-empty')).toEqual([]);
  });

  it('getMinUidInFolder returns the oldest real UID, or null when the folder has none', async () => {
    await insert(repo, db, { folderId: 'f-inbox', uid: 30 });
    await insert(repo, db, { folderId: 'f-inbox', uid: 12 });
    await insert(repo, db, { folderId: 'f-inbox', uid: 0 }); // not a real UID
    expect(await repo.getMinUidInFolder('f-inbox')).toBe(12);
    expect(await repo.getMinUidInFolder('f-drafts')).toBeNull();
  });

  // countByFolderTag drives "is this server message genuinely missing locally?".
  // A prefix false-match here makes the reconcile think mail exists and skip
  // downloading it (silently missing mail).
  it('countByFolderTag counts exact tag membership only', async () => {
    await insert(repo, db, { tags: '|Work|' });
    await insert(repo, db, { tags: '|Work|read|' });
    await insert(repo, db, { tags: '|Work/Projects|' });
    expect(repo.countByFolderTag('Work')).toBe(2);
    expect(repo.countByFolderTag('Work/Projects')).toBe(1);
    expect(repo.countByFolderTag('Wor')).toBe(0);
    expect(repo.countByFolderTag('ork')).toBe(0);
    expect(repo.countByFolderTag('nothing')).toBe(0);
  });

  // ---------------- repair / sender / sent ----------------

  // Incremental sync skips UIDs already in the DB, so a message stored with an
  // empty envelope stays broken forever unless the repair pass can find it.
  it('getIncomplete finds blank-envelope and synthesized-message-id rows, newest first', async () => {
    const noFrom = await insert(repo, db, { fromAddress: '', date: 400 });
    const noSubject = await insert(repo, db, { subject: '', date: 300 });
    const nullSubject = await insert(repo, db, { subject: null, date: 250 });
    const noTo = await insert(repo, db, { toAddress: '', date: 200 });
    const synth = await insert(repo, db, { messageId: '<missing-123@local>', date: 100 });
    await insert(repo, db, { date: 500 }); // complete — must not appear

    const found = await repo.getIncomplete(10);
    expect(found.map((r) => r.id)).toEqual([noFrom.id, noSubject.id, nullSubject.id, noTo.id, synth.id]);
    expect((await repo.getIncomplete(2)).map((r) => r.id)).toEqual([noFrom.id, noSubject.id]);
  });

  // read/deleted must be SUBSETS of received, so a ratio can never exceed 100%
  // (the running sender_stats counters drift; this is the live replacement).
  it('getSenderEngagement is case/whitespace-insensitive and self-consistent', async () => {
    await insert(repo, db, { fromAddress: 'Boss@Example.com', tags: '|INBOX|read|' });
    await insert(repo, db, { fromAddress: 'boss@example.com', tags: '|INBOX|' });
    await insert(repo, db, { fromAddress: 'boss@example.com', tags: '|Trash|read|' });
    await insert(repo, db, { fromAddress: 'other@example.com', tags: '|INBOX|read|' });

    const stats = await repo.getSenderEngagement('  BOSS@example.COM  ');
    expect(stats).toEqual({ received: 3, read: 2, deleted: 1 });
    expect(stats.read).toBeLessThanOrEqual(stats.received);
    expect(stats.deleted).toBeLessThanOrEqual(stats.received);
    expect(await repo.getSenderEngagement('nobody@example.com')).toEqual({ received: 0, read: 0, deleted: 0 });
  });

  // Your own sent mail must never show as unread. Matching is case-insensitive
  // across providers, and must not touch a look-alike folder name.
  it('markSentAsRead marks every provider sent folder read, and nothing else', async () => {
    const sent = await insert(repo, db, { tags: '|Sent|' });
    const sentItems = await insert(repo, db, { tags: '|Sent Items|' });
    const gmailSent = await insert(repo, db, { tags: '|[Gmail]/Sent Mail|' });
    const lowerCased = await insert(repo, db, { tags: '|sent|' });
    const alreadyRead = await insert(repo, db, { tags: '|Sent|read|' });
    const inbox = await insert(repo, db, { tags: '|INBOX|' });
    const lookalike = await insert(repo, db, { tags: '|Sentinel|' });

    expect(await repo.markSentAsRead()).toBe(4);
    for (const id of [sent.id, sentItems.id, gmailSent.id, lowerCased.id, alreadyRead.id]) {
      expect(hasTag(rawTags(db, id), 'read')).toBe(true);
    }
    expect(hasTag(rawTags(db, inbox.id), 'read')).toBe(false);
    expect(hasTag(rawTags(db, lookalike.id), 'read')).toBe(false);

    expect(await repo.markSentAsRead()).toBe(0); // nothing left to do
  });

  // ---------------- rowToRecord ----------------

  // rowToRecord is the only place tags become the booleans/arrays the UI reads.
  // Getting isStarred/labels wrong makes the list lie about a message's state.
  it('rowToRecord derives flags, labels and star/important state from tags', () => {
    const record = repo.rowToRecord({
      id: 'r1', tags: '|INBOX|read|starred|important|reminders|', raw_body: 'x',
    });
    expect(record.flags).toEqual(['\\Seen', '\\Flagged']);
    expect(record.labels).toEqual(['INBOX', 'important', 'reminders']);
    expect(record.isStarred).toBe(true);
    expect(record.isImportant).toBe(true);
    expect(record.hasBody).toBe(true);
  });

  it('rowToRecord treats a missing tags column as no tags', () => {
    const record = repo.rowToRecord({ id: 'r2' });
    expect(record.tags).toBe('||');
    expect(record.labels).toEqual([]);
    expect(record.isStarred).toBe(false);
    expect(record.hasBody).toBe(false);
  });

  // A LIST row has no raw_body column at all (excluded for weight) — hasBody must
  // come from the has_body flag there, so the renderer can tell "body is in the
  // DB, opening will load it" from "body genuinely missing".
  it('rowToRecord prefers the has_body flag over raw_body when present', () => {
    expect(repo.rowToRecord({ id: 'r3', has_body: 1 }).hasBody).toBe(true);
    expect(repo.rowToRecord({ id: 'r4', has_body: 0, raw_body: 'ignored' }).hasBody).toBe(false);
  });

  it('rowToRecord only sets thread metadata when the subqueries provided it', () => {
    const bare = repo.rowToRecord({ id: 'r5' });
    expect(bare.threadMessageCount).toBeUndefined();
    expect(bare.threadFirstSender).toBeUndefined();
    expect((bare as Record<string, unknown>).threadIsStarred).toBeUndefined();

    const withMeta = repo.rowToRecord({
      id: 'r6', thread_message_count: 3, thread_first_sender: 'A', thread_last_sender: 'B',
      thread_is_starred: 1, thread_is_important: 0, thread_has_draft: 1, priority_score: 0,
    });
    expect(withMeta.threadMessageCount).toBe(3);
    expect(withMeta.threadFirstSender).toBe('A');
    expect(withMeta.threadLastSender).toBe('B');
    expect((withMeta as Record<string, unknown>).threadIsStarred).toBe(true);
    expect((withMeta as Record<string, unknown>).threadIsImportant).toBe(false);
    expect((withMeta as Record<string, unknown>).threadHasDraft).toBe(true);
    expect(withMeta.priorityScore).toBeUndefined(); // 0 means "no agent score"
  });
});

// The folder scans page by KEYSET (uid > cursor) at 5000 rows and yield between
// pages. A cursor bug loses or repeats whole pages — and a lost page is read as
// "these UIDs are gone from the server", i.e. mail deleted locally. Uses a
// minimal table so 5001 rows stay fast and the paging is the only variable.
describe('folder UID scan keyset pagination', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = openTestDb();
    db.exec(`
      CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        uid INTEGER,
        tags TEXT NOT NULL DEFAULT '||'
      );
    `);
    repo = new EmailRepository(() => db);
  });

  afterEach(() => {
    db.close();
  });

  it('walks past the 5000-row page boundary returning every row exactly once', async () => {
    const total = 5001;
    const stmt = db.prepare('INSERT INTO emails (id, folder_id, uid, tags) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 1; i <= total; i += 1) stmt.run(`e${i}`, 'f-inbox', i, '|INBOX|');
      stmt.run('other', 'f-trash', 1, '|Trash|');
    })();

    const rows = await repo.getUidsInFolder('f-inbox');
    expect(rows.length).toBe(total);
    expect(new Set(rows.map((r) => r.id)).size).toBe(total);
    expect(rows.map((r) => r.uid)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });
});
