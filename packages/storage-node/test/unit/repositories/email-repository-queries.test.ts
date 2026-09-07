// Read-path guards for EmailRepository.
//
// Every list/search/count in the app is an `instr(tags, '|x|')` predicate over
// one table. A predicate that matches a SUBSTRING (folder `Work` matching
// `Work/Projects`, flag `read` matching `unread-ish`) shows mail in the wrong
// mailbox; one that matches too little makes real mail invisible — which users
// report as data loss. Pagination is LIMIT/OFFSET over those predicates, so a
// wrong page window silently skips messages. And the sort column is
// INTERPOLATED into the SQL, so the whitelist is the only thing between a
// caller-supplied `sortBy` and SQL injection.
//
// Runs against the REAL production schema so a renamed column or a changed
// special-folder list fails here rather than in the app.

import { getLogLevel, setLogLevel, setLogSink, type LogLevel, type SearchQuery } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadModelMaintainer } from '../../../src/read-model-maintainer';
import { newMigratedDb } from '../../../src/test-support/test-db';

import { EmailRepository } from '../../../src/repositories/email-repository';

const FOLDERS: Array<[string, string]> = [
  ['f-inbox', 'INBOX'],
  ['f-trash', 'Trash'],
  ['f-spam', 'Spam'],
  ['f-sent', 'Sent'],
  ['f-drafts', 'Drafts'],
  ['f-junk', 'Junk'],
  ['f-work', 'Work'],
  ['f-workproj', 'Work/Projects'],
  ['f-inboxx', 'INBOXX'],
  ['f-starred', 'Starred'],
  ['f-gtrash', '[Gmail]/Trash'],
];

type Add = {
  id: string;
  tags: string;
  date?: number;
  thread?: string;
  folderId?: string;
  subject?: string | null;
  from?: string;
  to?: string;
  cc?: string;
  body?: string;
  raw?: string;
  uid?: number | null;
  attachments?: 0 | 1;
  priorityScore?: number | null;
  aiProcessedAt?: number | null;
  snoozeUntil?: number | null;
  receivedDate?: number | null;
};

function newDb(): Database.Database {
  const db = newMigratedDb();
  const folder = db.prepare('INSERT INTO folders (id, name, path) VALUES (?, ?, ?)');
  for (const [id, path] of FOLDERS) folder.run(id, path, path);
  return db;
}

function add(db: Database.Database, e: Add): string {
  const threadId = e.thread ?? e.id;
  db.prepare(`INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
              VALUES (?, 'T', '<a>', '<a>', 0)`).run(threadId);
  db.prepare(`
    INSERT INTO emails (
      id, message_id, thread_id, folder_id, uid, tags, subject, from_address, from_name,
      to_address, cc_address, date, received_date, clean_body, raw_body,
      clean_body_len, raw_body_len, content_type,
      content_hash, has_attachments, priority_score, ai_processed_at, snooze_until
    ) VALUES (
      @id, @mid, @tid, @fid, @uid, @tags, @subject, @from, 'Name',
      @to, @cc, @date, @received, @body, @raw,
      -- Written from the bodies in SQL, as every production writer does: the
      -- list query's has_body flag reads raw_body_len on a migrated DB, so a
      -- NULL here would tell the renderer no email has a body.
      LENGTH(TRIM(@body)), LENGTH(TRIM(@raw)), 'text',
      @hash, @att, @pri, @ai, @snooze
    )
  `).run({
    id: e.id,
    mid: `<${e.id}@x.com>`,
    tid: threadId,
    fid: e.folderId ?? 'f-inbox',
    uid: e.uid === undefined ? 1 : e.uid,
    tags: e.tags,
    subject: e.subject === undefined ? `Subject ${e.id}` : e.subject,
    from: e.from ?? `${e.id}@sender.com`,
    to: e.to ?? 'me@y.com',
    cc: e.cc ?? null,
    date: e.date ?? 1000,
    received: e.receivedDate ?? e.date ?? 1000,
    body: e.body ?? `body of ${e.id}`,
    raw: e.raw ?? `<p>${e.id}</p>`,
    hash: `h-${e.id}`,
    att: e.attachments ?? 0,
    pri: e.priorityScore ?? null,
    ai: e.aiProcessedAt ?? null,
    snooze: e.snoozeUntil ?? null,
  });
  return e.id;
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);
const idSet = (rows: Array<{ id: string }>): Set<string> => new Set(ids(rows));

const page = { limit: 50, offset: 0 };

describe('getByFolder — folder membership is exact tag membership', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });

  afterEach(() => db.close());

  // The near-miss cases are the whole point: `instr(tags,'|INBOX|')` must not be
  // satisfied by a folder called `INBOXX`, and a Gmail label `Work` must not drag
  // in `Work/Projects`. A false match puts another mailbox's mail in this folder;
  // a missed match hides the user's mail.
  it('returns exactly the rows tagged with the folder path, never a substring match', async () => {
    add(db, { id: 'in1', tags: '|INBOX|' });
    add(db, { id: 'in2', tags: '|INBOX|read|' });
    add(db, { id: 'other', tags: '|INBOXX|' });
    add(db, { id: 'work', tags: '|Work|' });
    add(db, { id: 'sub', tags: '|Work/Projects|' });

    expect(idSet(await repo.getByFolder('f-inbox', page))).toEqual(new Set(['in1', 'in2']));
    expect(idSet(await repo.getByFolder('f-inboxx', page))).toEqual(new Set(['other']));
    expect(idSet(await repo.getByFolder('f-work', page))).toEqual(new Set(['work']));
    expect(idSet(await repo.getByFolder('f-workproj', page))).toEqual(new Set(['sub']));
  });

  // Gmail labels put ONE message in several mailboxes at once. It must be listed
  // in each of them — the multi-membership row is a single row, not a copy.
  it('lists a multi-folder (Gmail label) row in every folder it is tagged with', async () => {
    add(db, { id: 'multi', tags: '|INBOX|Work|Work/Projects|' });

    expect(ids(await repo.getByFolder('f-inbox', page))).toEqual(['multi']);
    expect(ids(await repo.getByFolder('f-work', page))).toEqual(['multi']);
    expect(ids(await repo.getByFolder('f-workproj', page))).toEqual(['multi']);
  });

  // A message moved to Trash keeps its INBOX label until sync reconciles; the
  // folder view must not show it in INBOX. But when the user is VIEWING Trash,
  // the current folder is exempt from its own exclusion or the folder is empty.
  it('hides special-folder copies from a normal folder but not from that folder itself', async () => {
    add(db, { id: 'trashed', tags: '|INBOX|Trash|' });
    add(db, { id: 'live', tags: '|INBOX|' });

    expect(ids(await repo.getByFolder('f-inbox', page))).toEqual(['live']);
    expect(ids(await repo.getByFolder('f-trash', page))).toEqual(['trashed']);
  });

  it('returns nothing for an unknown folder id', async () => {
    add(db, { id: 'in1', tags: '|INBOX|' });
    expect(await repo.getByFolder('f-nope', page)).toEqual([]);
  });

  // Pagination walk: every page must be a disjoint window and their union must be
  // the whole result set. An off-by-one in LIMIT/OFFSET silently skips a message
  // as the user scrolls — the user sees mail vanish between pages.
  it('paginates into stable, non-overlapping pages covering the whole result set', async () => {
    const all: string[] = [];
    for (let i = 1; i <= 7; i += 1) all.push(add(db, { id: `p${i}`, tags: '|INBOX|', date: 1000 + i }));
    const expectedOrder = [...all].reverse(); // date DESC

    const seen: string[] = [];
    for (let offset = 0; offset < 12; offset += 3) {
      seen.push(...ids(await repo.getByFolder('f-inbox', { limit: 3, offset })));
    }
    expect(seen).toEqual(expectedOrder);            // ordered, complete
    expect(new Set(seen).size).toBe(seen.length);   // and no row on two pages
  });

  it('orders by the requested whitelisted column and direction', async () => {
    add(db, { id: 'a', tags: '|INBOX|', date: 10, subject: 'Zebra' });
    add(db, { id: 'b', tags: '|INBOX|', date: 20, subject: 'Apple' });

    expect(ids(await repo.getByFolder('f-inbox', { ...page, sortOrder: 'asc' }))).toEqual(['a', 'b']);
    expect(ids(await repo.getByFolder('f-inbox', { ...page, sortBy: 'subject', sortOrder: 'asc' }))).toEqual(['b', 'a']);
    // camelCase inputs are snake_cased before the whitelist check
    expect(ids(await repo.getByFolder('f-inbox', { ...page, sortBy: 'receivedDate', sortOrder: 'asc' }))).toEqual(['a', 'b']);
  });

  // sortBy/sortOrder are INTERPOLATED into the SQL (they cannot be bound), so the
  // whitelist is the only injection barrier. An attacker-supplied column must
  // fall back to `date` and the statement must stay harmless.
  it('rejects a non-whitelisted / injecting sortBy and falls back to date DESC', async () => {
    add(db, { id: 'a', tags: '|INBOX|', date: 10 });
    add(db, { id: 'b', tags: '|INBOX|', date: 20 });

    const injected = await repo.getByFolder('f-inbox', {
      ...page,
      sortBy: 'date; DROP TABLE emails --',
      sortOrder: 'asc); DROP TABLE emails --' as unknown as 'asc',
    });
    expect(ids(injected)).toEqual(['b', 'a']); // default date DESC
    expect(db.prepare('SELECT COUNT(*) c FROM emails').get()).toEqual({ c: 2 }); // table intact
    // A plausible-but-unlisted column also falls back rather than erroring
    expect(ids(await repo.getByFolder('f-inbox', { ...page, sortBy: 'rawBody' }))).toEqual(['b', 'a']);
  });

  // List rows deliberately omit raw_body and truncate clean_body — the fix for
  // pulling both full bodies into JS for every row of every page. hasBody must
  // still tell the renderer the body IS in the DB.
  it('returns a bounded snippet plus a has_body flag instead of the full bodies', async () => {
    add(db, { id: 'big', tags: '|INBOX|', body: 'x'.repeat(1000), raw: 'y'.repeat(1000) });
    const [row] = await repo.getByFolder('f-inbox', page);
    expect(row.cleanBody.length).toBe(256);
    expect(row.rawBody).toBeUndefined();
    expect(row.hasBody).toBe(true);
  });

  // Quick filters are ANDed onto the list query. `|read|` must not be satisfied
  // by a tag that merely CONTAINS "read" — otherwise unread mail disappears from
  // the unread filter (and shows as read).
  it('applies unread/read/starred/attachment quick filters with exact tag matching', async () => {
    add(db, { id: 'unread', tags: '|INBOX|unread-ish|' });
    add(db, { id: 'read', tags: '|INBOX|read|' });
    add(db, { id: 'star', tags: '|INBOX|starred|' });
    add(db, { id: 'starfolder', tags: '|INBOX|Starred|' }); // a FOLDER named Starred
    add(db, { id: 'att', tags: '|INBOX|', attachments: 1 });

    expect(idSet(await repo.getByFolder('f-inbox', { ...page, filter: { isUnread: true } })))
      .toEqual(new Set(['unread', 'star', 'starfolder', 'att']));
    expect(idSet(await repo.getByFolder('f-inbox', { ...page, filter: { isUnread: false } })))
      .toEqual(new Set(['read']));
    expect(ids(await repo.getByFolder('f-inbox', { ...page, filter: { isFlagged: true } }))).toEqual(['star']);
    expect(ids(await repo.getByFolder('f-inbox', { ...page, filter: { hasAttachments: true } }))).toEqual(['att']);
  });

  it('filters by an AI category tag, exactly', async () => {
    add(db, { id: 'cat', tags: '|INBOX|reminders|' });
    add(db, { id: 'near', tags: '|INBOX|reminders-old|' });
    expect(ids(await repo.getByFolder('f-inbox', { ...page, categoryTag: 'reminders' }))).toEqual(['cat']);
  });

  // "Unlabelled" excludes every DEFINED category slug (a disabled-but-tagged
  // category still renders a badge, so it counts as labelled). Note the seeded
  // slug set includes `important`, which doubles as the importance FLAG tag —
  // pinned here as current behaviour: flagging a mail important also drops it out
  // of the unlabelled view.
  it('noCategory keeps only mail carrying none of the defined category slugs', async () => {
    add(db, { id: 'plain', tags: '|INBOX|read|' });
    add(db, { id: 'labelled', tags: '|INBOX|reminders|' });
    add(db, { id: 'flagged-important', tags: '|INBOX|important|' });

    const rows = await repo.getByFolder('f-inbox', { ...page, filter: { noCategory: true } });
    expect(ids(rows)).toEqual(['plain']);
  });
});

describe('fixed-section list queries', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  // "All mail" must hide every provider's Trash/Spam/Sent/Drafts variant, while a
  // user folder whose name merely STARTS with one of them ('Trashcan') stays
  // visible — dropping it would hide a real mailbox from the unified list.
  it('getAll excludes every special-folder variant but keeps look-alike folder names', async () => {
    const special = ['Trash', 'Spam', 'Drafts', 'Sent', '[Gmail]/Trash', '[Gmail]/Spam',
      '[Gmail]/Drafts', '[Gmail]/Sent Mail', 'Junk', 'Junk Email', 'Deleted Items', 'Sent Items'];
    special.forEach((p, i) => add(db, { id: `s${i}`, tags: `|${p}|` }));
    add(db, { id: 'keep', tags: '|INBOX|' });
    add(db, { id: 'lookalike', tags: '|Trashcan|' });

    expect(idSet(await repo.getAll())).toEqual(new Set(['keep', 'lookalike']));
    expect(ids(await repo.getAll({ limit: 1, offset: 0 })).length).toBe(1);
  });

  // instr() is case-SENSITIVE on purpose: a mailbox literally named "Starred"
  // must not be read as the |starred| flag (and vice versa), or every message in
  // that folder would show a star.
  it('getStarred / getStarredCount match the flag tag case-sensitively and skip Trash/Spam', async () => {
    add(db, { id: 'star', tags: '|INBOX|starred|', date: 10 });
    add(db, { id: 'star2', tags: '|Work|starred|', date: 20 });
    add(db, { id: 'folder', tags: '|Starred|' });
    add(db, { id: 'trashed', tags: '|Trash|starred|' });
    add(db, { id: 'gspam', tags: '|[Gmail]/Spam|starred|' });

    expect(ids(await repo.getStarred())).toEqual(['star2', 'star']); // date DESC
    expect(await repo.getStarredCount()).toBe(2);
    expect(ids(await repo.getStarred({ limit: 1, offset: 1 }))).toEqual(['star']);
  });

  it('getImportant orders by priority score then date, excluding Trash/Spam', async () => {
    add(db, { id: 'lowpri', tags: '|INBOX|important|', date: 99, priorityScore: null });
    add(db, { id: 'highpri', tags: '|INBOX|important|', date: 1, priorityScore: 80 });
    add(db, { id: 'trashed', tags: '|Trash|important|' });

    expect(ids(await repo.getImportant())).toEqual(['highpri', 'lowpri']);
    expect(await repo.getImportantCount()).toBe(2);
    expect(ids(await repo.getImportant({ limit: 1, offset: 0 }))).toEqual(['highpri']);
  });

  // Trash/Spam copies are NOT excluded from this counter (unlike getImportantCount)
  // — pinned so a change to either is a deliberate decision, since this number
  // drives the unread-important badge.
  it('getUnreadImportantCount counts important mail with no |read| tag', async () => {
    add(db, { id: 'a', tags: '|INBOX|important|' });
    add(db, { id: 'b', tags: '|INBOX|important|read|' });
    add(db, { id: 'c', tags: '|Trash|important|' });
    expect(await repo.getUnreadImportantCount()).toBe(2);
  });

  // Snooze is a promise to resurface mail at a time; a row tagged |snoozed| with
  // no snooze_until would never resurface, so both are required.
  it('getSnoozed requires both the tag and a snooze_until, ordered soonest-first', async () => {
    add(db, { id: 'later', tags: '|INBOX|snoozed|', snoozeUntil: 5000 });
    add(db, { id: 'sooner', tags: '|INBOX|snoozed|', snoozeUntil: 1000 });
    add(db, { id: 'no-time', tags: '|INBOX|snoozed|', snoozeUntil: null });
    add(db, { id: 'not-snoozed', tags: '|INBOX|', snoozeUntil: 1000 });

    expect(ids(await repo.getSnoozed())).toEqual(['sooner', 'later']);
    expect(ids(await repo.getSnoozed({ limit: 1, offset: 1 }))).toEqual(['later']);
    expect(await repo.getSnoozedCount()).toBe(3); // tag-only count
  });

  // Deterministic clock: getDueSnoozed compares against now() in SECONDS, so a
  // seconds/millis mix-up would either resurface everything at once or nothing.
  it('getDueSnoozed returns only rows due at or before now (seconds)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000 * 1000));
    add(db, { id: 'due', tags: '|INBOX|snoozed|', snoozeUntil: 1_999_999 });
    add(db, { id: 'exact', tags: '|INBOX|snoozed|', snoozeUntil: 2_000_000 });
    add(db, { id: 'future', tags: '|INBOX|snoozed|', snoozeUntil: 2_000_001 });

    expect(idSet(await repo.getDueSnoozed())).toEqual(new Set(['due', 'exact']));
  });

  it('getRecent returns mail newer than the cutoff on either timestamp', async () => {
    add(db, { id: 'new', tags: '|INBOX|', date: 500, receivedDate: 500 });
    add(db, { id: 'late-arrival', tags: '|INBOX|', date: 100, receivedDate: 400 });
    add(db, { id: 'old', tags: '|INBOX|', date: 100, receivedDate: 100 });

    expect(ids(await repo.getRecent({ sinceTimestamp: 300 }))).toEqual(['new', 'late-arrival']);
    expect(ids(await repo.getRecent({ sinceTimestamp: 300, limit: 1 }))).toEqual(['new']);
  });
});

// Every repo query emits a TRACE line naming itself and its parameters — the
// diagnostic used to attribute a list-load stall to a specific query. It must be
// silent (and must not even build the string) at any normal level, because it
// fires on EVERY query and a synchronous write per query is itself a stall.
describe('query tracing', () => {
  let db: Database.Database;
  let repo: EmailRepository;
  const captured: Array<{ level: LogLevel; message: string }> = [];
  let previousLevel: LogLevel;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
    captured.length = 0;
    previousLevel = getLogLevel();
    setLogSink((level, _name, message) => captured.push({ level, message }));
  });

  afterEach(() => {
    setLogSink(null);
    setLogLevel(previousLevel);
    db.close();
  });

  it('emits the method and its defined parameters only when trace is enabled', async () => {
    await repo.getAll({ limit: 5, offset: 0 });
    expect(captured.filter((r) => r.level === 'trace')).toEqual([]);

    setLogLevel('trace');
    await repo.getByCategory('reminders', { limit: 5, offset: 0 });
    const traced = captured.filter((r) => r.level === 'trace').map((r) => r.message);
    expect(traced).toEqual(['getByCategory(categorySlug=reminders, limit=5, offset=0)']);
  });
});

describe('getByThread', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });

  afterEach(() => db.close());

  // A message the user deleted must not reappear in the conversation — a trashed
  // draft kept getting re-attached by subject+participants and showing up again
  // after every delete.
  it('excludes Trash/Spam/Junk copies and orders oldest-first', async () => {
    add(db, { id: 'm1', thread: 't', tags: '|INBOX|', date: 10 });
    add(db, { id: 'm2', thread: 't', tags: '|INBOX|read|', date: 20 });
    add(db, { id: 'm3', thread: 't', tags: '|Trash|', date: 30 });
    add(db, { id: 'm4', thread: 't', tags: '|Junk|', date: 40 });

    expect(ids(await repo.getByThread('t'))).toEqual(['m1', 'm2']);
  });

  // If the WHOLE conversation lives in Trash/Spam/Junk (the user is viewing Junk),
  // the exclusion must not make the thread un-openable — it would collapse to an
  // empty detail view.
  it('falls back to the unfiltered thread when every copy is trashed', async () => {
    add(db, { id: 'j1', thread: 'tj', tags: '|Junk|', date: 10 });
    add(db, { id: 'j2', thread: 'tj', tags: '|Trash|', date: 20 });

    expect(ids(await repo.getByThread('tj'))).toEqual(['j1', 'j2']);
    expect(await repo.getByThread('no-such-thread')).toEqual([]);
  });
});

describe('category listings', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });

  afterEach(() => db.close());

  it('getByCategory matches the slug exactly, optionally scoped to a folder', async () => {
    add(db, { id: 'a', tags: '|INBOX|reminders|', date: 10 });
    add(db, { id: 'b', tags: '|Work|reminders|', date: 20 });
    add(db, { id: 'near', tags: '|INBOX|reminders-old|' });

    expect(ids(await repo.getByCategory('reminders'))).toEqual(['b', 'a']);
    expect(ids(await repo.getByCategory('reminders', { folderId: 'f-inbox' }))).toEqual(['a']);
    expect(await repo.getByCategory('reminders', { folderId: 'f-nope' })).toEqual([]);
    expect(ids(await repo.getByCategory('reminders', { limit: 1, offset: 1 }))).toEqual(['a']);
  });

  // The quick filter for a category tab must be literal SQL (no bound params) or
  // it would shift the positional parameters and scope the query to the wrong
  // folder / limit.
  it('getByCategory honors a quick filter without disturbing parameter order', async () => {
    add(db, { id: 'unread', tags: '|INBOX|reminders|' });
    add(db, { id: 'read', tags: '|INBOX|reminders|read|' });

    expect(ids(await repo.getByCategory('reminders', { filter: { isUnread: true } }))).toEqual(['unread']);
    expect(ids(await repo.getByCategory('reminders', { folderId: 'f-inbox', filter: { isUnread: false } }))).toEqual(['read']);
  });

  // Uncategorized = AI has run but produced no label. Rows the AI never processed
  // must NOT appear (they'd look permanently uncategorized and re-queue forever).
  it('getUncategorized needs ai_processed_at and excludes every known slug', async () => {
    add(db, { id: 'plain', tags: '|INBOX|', aiProcessedAt: 5, date: 30 });
    add(db, { id: 'labelled', tags: '|INBOX|reminders|', aiProcessedAt: 5, date: 40 });
    add(db, { id: 'spam', tags: '|INBOX|spam|', aiProcessedAt: 5, date: 50 });
    add(db, { id: 'unprocessed', tags: '|INBOX|', aiProcessedAt: null, date: 60 });
    add(db, { id: 'other-folder', tags: '|Work|', aiProcessedAt: 5, date: 20 });

    expect(idSet(await repo.getUncategorized(['reminders', 'meeting']))).toEqual(new Set(['plain', 'other-folder']));
    expect(ids(await repo.getUncategorized(['reminders'], { folderId: 'f-inbox' }))).toEqual(['plain']);
    expect(await repo.getUncategorized(['reminders'], { folderId: 'f-nope' })).toEqual([]);
    // No exclusions at all => every AI-processed non-spam row, date DESC.
    expect(ids(await repo.getUncategorized([]))).toEqual(['labelled', 'plain', 'other-folder']);
    expect(ids(await repo.getUncategorized([], { limit: 1, offset: 1 }))).toEqual(['plain']);
  });
});

describe('search', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });

  afterEach(() => db.close());

  const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({ query: '', ...over });

  it('scopes to a folder path and hides that folder\'s Trash/Spam copies', async () => {
    add(db, { id: 'in', tags: '|INBOX|' });
    add(db, { id: 'trashed', tags: '|INBOX|Trash|' });
    add(db, { id: 'work', tags: '|Work|' });

    expect(ids(await repo.search(q({ folderPath: 'INBOX' })))).toEqual(['in']);
    expect(ids(await repo.search(q({ folderPath: 'Trash' })))).toEqual(['trashed']);
  });

  it('defaults to an "all mail" scope that excludes Trash/Spam/Sent/Drafts', async () => {
    add(db, { id: 'in', tags: '|INBOX|' });
    add(db, { id: 'sent', tags: '|Sent Items|' });
    add(db, { id: 'trash', tags: '|[Gmail]/Trash|' });

    expect(ids(await repo.search(q()))).toEqual(['in']);
    expect(ids(await repo.search(q({ scope: 'all' })))).toEqual(['in']);
  });

  // Legacy folderIds are ANDed (a row must be in ALL of them); an unknown id is
  // skipped rather than silently narrowing the search to nothing.
  it('supports legacy folderIds and skips unknown ones', async () => {
    add(db, { id: 'both', tags: '|INBOX|Work|' });
    add(db, { id: 'one', tags: '|INBOX|' });

    expect(ids(await repo.search(q({ folderIds: ['f-inbox', 'f-work'] })))).toEqual(['both']);
    expect(idSet(await repo.search(q({ folderIds: ['f-inbox', 'f-nope'] })))).toEqual(new Set(['both', 'one']));
  });

  it('filters by AI category and by "no category"', async () => {
    add(db, { id: 'cat', tags: '|INBOX|reminders|' });
    add(db, { id: 'plain', tags: '|INBOX|' });

    expect(ids(await repo.search(q({ aiCategory: 'reminders' })))).toEqual(['cat']);
    expect(ids(await repo.search(q({ noCategory: true })))).toEqual(['plain']);
  });

  it('filters by thread ids, flags, attachments and date range', async () => {
    add(db, { id: 'a', thread: 'ta', tags: '|INBOX|read|starred|', date: 100, attachments: 1 });
    add(db, { id: 'b', thread: 'tb', tags: '|INBOX|', date: 200 });

    expect(ids(await repo.search(q({ threadIds: ['ta'] })))).toEqual(['a']);
    expect(ids(await repo.search(q({ isUnread: true })))).toEqual(['b']);
    expect(ids(await repo.search(q({ isUnread: false })))).toEqual(['a']);
    expect(ids(await repo.search(q({ isFlagged: true })))).toEqual(['a']);
    expect(ids(await repo.search(q({ isFlagged: false })))).toEqual(['b']);
    expect(ids(await repo.search(q({ hasAttachments: true })))).toEqual(['a']);
    expect(ids(await repo.search(q({ hasAttachments: false })))).toEqual(['b']);
    expect(ids(await repo.search(q({ dateFrom: 150 })))).toEqual(['b']);
    expect(ids(await repo.search(q({ dateTo: 150 })))).toEqual(['a']);
    expect(ids(await repo.search(q({ dateFrom: 50, dateTo: 250 })))).toEqual(['b', 'a']);
  });

  it('matches from/to/subject and free text across subject and both bodies', async () => {
    add(db, { id: 'a', tags: '|INBOX|', from: 'alice@corp.com', to: 'bob@corp.com', subject: 'Budget', body: 'clean needle', raw: 'x' });
    add(db, { id: 'b', tags: '|INBOX|', from: 'carol@corp.com', to: 'dave@corp.com', subject: 'Other', body: 'y', raw: 'raw needle' });

    expect(ids(await repo.search(q({ from: 'alice' })))).toEqual(['a']);
    expect(ids(await repo.search(q({ to: 'dave' })))).toEqual(['b']);
    expect(ids(await repo.search(q({ subject: 'Budg' })))).toEqual(['a']);
    expect(idSet(await repo.search(q({ query: 'needle' })))).toEqual(new Set(['a', 'b']));
    expect(await repo.search(q({ query: '   ' }))).toHaveLength(2); // blank text ignored
  });

  // Free text is BOUND, never concatenated: a quote or a SQL fragment must be
  // treated as literal text (no error, no injection, no extra rows).
  it('treats quotes and SQL fragments in free text as literal characters', async () => {
    add(db, { id: 'quoted', tags: '|INBOX|', subject: "O'Brien said \"hi\"" });
    add(db, { id: 'other', tags: '|INBOX|', subject: 'nothing' });

    expect(ids(await repo.search(q({ subject: "O'Brien" })))).toEqual(['quoted']);
    expect(ids(await repo.search(q({ query: "'; DROP TABLE emails; --" })))).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM emails').get()).toEqual({ c: 2 });
  });

  // The term is wrapped in %...% for LIKE, so an unescaped `%` or `_` in the
  // user's own text acted as a wildcard: searching `a_c` also returned "abc".
  // Both are now escaped (`LIKE ? ESCAPE '\\'`) and matched literally.
  it('matches LIKE wildcards in user text LITERALLY', async () => {
    add(db, { id: 'abc', tags: '|INBOX|', subject: 'abc' });
    add(db, { id: 'a_c', tags: '|INBOX|', subject: 'a_c' });
    add(db, { id: 'pct', tags: '|INBOX|', subject: '50% off' });

    expect(idSet(await repo.search(q({ subject: 'a_c' })))).toEqual(new Set(['a_c']));
    expect(ids(await repo.search(q({ subject: '50% off' })))).toEqual(['pct']);
    expect(await repo.search(q({ subject: '50%off' }))).toEqual([]);   // % is not "anything"
  });

  it('whitelists the sort column and applies limit/offset', async () => {
    add(db, { id: 'a', tags: '|INBOX|', date: 10, subject: 'Zebra' });
    add(db, { id: 'b', tags: '|INBOX|', date: 20, subject: 'Apple' });

    expect(ids(await repo.search(q({ sortOrder: 'asc' })))).toEqual(['a', 'b']);
    expect(ids(await repo.search(q({ sortBy: 'subject', sortOrder: 'asc' })))).toEqual(['b', 'a']);
    // 'from' is not a real column — falls back to date, never breaks the query
    expect(ids(await repo.search(q({ sortBy: 'from' })))).toEqual(['b', 'a']);
    expect(ids(await repo.search(q({
      sortBy: 'date; DROP TABLE emails --' as unknown as SearchQuery['sortBy'],
    })))).toEqual(['b', 'a']);
    expect(db.prepare('SELECT COUNT(*) c FROM emails').get()).toEqual({ c: 2 });
    expect(ids(await repo.search(q({ limit: 1 })))).toEqual(['b']);
    expect(ids(await repo.search(q({ limit: 1, offset: 1 })))).toEqual(['a']);
  });

  // Search result rows carry the same thread metadata as list rows, so search and
  // the list can never disagree about a conversation's size or star state.
  it('carries thread metadata on search rows', async () => {
    add(db, { id: 'm1', thread: 't', tags: '|INBOX|', date: 10 });
    add(db, { id: 'm2', thread: 't', tags: '|INBOX|starred|', date: 20 });

    const [row] = await repo.search(q({ folderPath: 'INBOX', limit: 1 }));
    expect(row.threadMessageCount).toBe(2);
    expect((row as Record<string, unknown>).threadIsStarred).toBe(true);
  });
});

describe('fullTextSearch', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });

  afterEach(() => db.close());

  it('matches subject, sender, recipient and body, newest first', async () => {
    add(db, { id: 'subj', tags: '|INBOX|', subject: 'needle here', date: 40 });
    add(db, { id: 'from', tags: '|INBOX|', from: 'needle@corp.com', date: 30 });
    add(db, { id: 'to', tags: '|INBOX|', to: 'needle@y.com', date: 20 });
    add(db, { id: 'body', tags: '|INBOX|', body: 'a needle in there', date: 10 });
    add(db, { id: 'none', tags: '|INBOX|', subject: 'nope', date: 50 });

    expect(ids(await repo.fullTextSearch('needle'))).toEqual(['subj', 'from', 'to', 'body']);
  });

  it('scopes to folder ids, skips unknown ones and honors the limit', async () => {
    add(db, { id: 'in', tags: '|INBOX|', subject: 'needle', date: 20 });
    add(db, { id: 'work', tags: '|Work|', subject: 'needle', date: 10 });

    expect(ids(await repo.fullTextSearch('needle', { query: '', folderIds: ['f-work'] }))).toEqual(['work']);
    expect(idSet(await repo.fullTextSearch('needle', { query: '', folderIds: ['f-nope'] }))).toEqual(new Set(['in', 'work']));
    expect(ids(await repo.fullTextSearch('needle', { query: '', limit: 1 }))).toEqual(['in']);
  });

  it('binds the term so quotes are literal', async () => {
    add(db, { id: 'q', tags: '|INBOX|', subject: "it's fine" });
    expect(ids(await repo.fullTextSearch("it's"))).toEqual(['q']);
    expect(await repo.fullTextSearch("' OR 1=1 --")).toEqual([]);
  });
});

describe('thread sections (legacy GROUP BY path)', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
    // One thread per section, plus a thread whose only unread copy is in Trash.
    add(db, { id: 'iu', thread: 't-impunread', tags: '|INBOX|important|', date: 50, priorityScore: 9 });
    add(db, { id: 'st', thread: 't-star', tags: '|INBOX|starred|read|', date: 40 });
    add(db, { id: 'ee', thread: 't-else', tags: '|INBOX|read|', date: 30 });
    add(db, { id: 'un', thread: 't-unread', tags: '|INBOX|', date: 20 });
    add(db, { id: 'tr', thread: 't-else2', tags: '|INBOX|read|', date: 10 });
    add(db, { id: 'tr2', thread: 't-else2', tags: '|Trash|', date: 15, folderId: 'f-trash' });
  });

  afterEach(() => db.close());

  const threads = (rows: Array<{ threadId: string }>): Set<string> => new Set(rows.map((r) => r.threadId));

  // The three inbox sections must PARTITION the folder: a thread showing up in
  // two of them renders twice in the list, and one showing up in none disappears
  // from the inbox entirely.
  it('important-unread / starred / everything-else partition the folder exactly once each', async () => {
    const opts = { limit: 50, offset: 0, folderPath: 'INBOX' };
    const impUnread = threads(await repo.getImportantUnread(opts));
    const starred = threads(await repo.getStarredNotImportantUnread(opts));
    const rest = threads(await repo.getEverythingElse(opts));

    expect(impUnread).toEqual(new Set(['t-impunread']));
    expect(starred).toEqual(new Set(['t-star']));
    expect(rest).toEqual(new Set(['t-else', 't-unread', 't-else2']));

    const all = [...impUnread, ...starred, ...rest];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(['t-impunread', 't-star', 't-else', 't-unread', 't-else2']));

    expect(await repo.getSectionCount('important_unread', 'INBOX')).toBe(1);
    expect(await repo.getSectionCount('starred', 'INBOX')).toBe(1);
    expect(await repo.getSectionCount('everything_else', 'INBOX')).toBe(3);
  });

  // A thread whose ONLY unread copy sits in Trash/Spam must not count as unread —
  // it was inflating the "All Inboxes" unread badge.
  it('unread / read sections split on LIVE unread only, and are complementary', async () => {
    const opts = { limit: 50, offset: 0, folderPath: 'INBOX' };
    expect(threads(await repo.getUnreadSection(opts))).toEqual(new Set(['t-impunread', 't-unread']));
    expect(threads(await repo.getReadSection(opts))).toEqual(new Set(['t-star', 't-else', 't-else2']));
    expect(await repo.getSectionCount('unread', 'INBOX')).toBe(2);
    expect(await repo.getSectionCount('read', 'INBOX')).toBe(3);
  });

  it('important / not-important sections are complementary', async () => {
    const opts = { limit: 50, offset: 0, folderPath: 'INBOX' };
    expect(threads(await repo.getImportantSection(opts))).toEqual(new Set(['t-impunread']));
    expect(threads(await repo.getNotImportantSection(opts)))
      .toEqual(new Set(['t-star', 't-else', 't-unread', 't-else2']));
    expect(await repo.getSectionCount('important', 'INBOX')).toBe(1);
    expect(await repo.getSectionCount('not_important', 'INBOX')).toBe(4);
  });

  // Sections paginate by THREAD, so a page must never split a conversation and
  // consecutive pages must not repeat one.
  it('paginates sections by whole threads without overlap', async () => {
    const opts = { limit: 2, offset: 0, folderPath: 'INBOX' };
    const first = threads(await repo.getEverythingElse(opts));
    const second = threads(await repo.getEverythingElse({ ...opts, offset: 2 }));
    expect(first.size).toBe(2);
    expect(second.size).toBe(1);
    expect([...first].filter((t) => second.has(t))).toEqual([]);
  });

  // A quick filter must be a THREAD-level condition: applied per-email it would
  // keep a thread that merely CONTAINS one matching mail and then render the
  // whole thread, including the mail the filter was meant to hide.
  it('applies quick filters at thread level inside a section', async () => {
    const opts = { limit: 50, offset: 0, folderPath: 'INBOX' };
    expect(await repo.getSectionCount('everything_else', 'INBOX', { isUnread: true })).toBe(1);
    expect(await repo.getSectionCount('everything_else', 'INBOX', { isUnread: false })).toBe(2);
    expect(await repo.getSectionCount('everything_else', 'INBOX', { isFlagged: true })).toBe(0);
    expect(await repo.getSectionCount('everything_else', 'INBOX', { hasAttachments: true })).toBe(0);
    expect(await repo.getSectionCount('everything_else', 'INBOX', { noCategory: true })).toBe(3);
    expect(threads(await repo.getEverythingElse(opts))).toContain('t-unread');
    // A filter object with nothing switched on must behave exactly like no filter
    // (an empty `AND` fragment would be a syntax error, a stray one would narrow
    // the section silently).
    expect(await repo.getSectionCount('everything_else', 'INBOX', {})).toBe(3);
    expect(await repo.getSectionCount('everything_else', 'INBOX', { isFlagged: false })).toBe(3);
  });

  it('counts across the whole mailbox when no folder is given, and 0 for an unknown section', async () => {
    expect(await repo.getSectionCount('important_unread')).toBe(1);
    expect(await repo.getSectionCount('nope', 'INBOX')).toBe(0);
  });
});

describe('read-model fast paths (thread_folders)', () => {
  let db: Database.Database;
  let repo: EmailRepository;
  const originalEnv = process.env.SARVINBOX_READMODEL_READS;

  beforeEach(() => {
    delete process.env.SARVINBOX_READMODEL_READS;
    db = newDb();
    repo = new EmailRepository(() => db);
    add(db, { id: 'iu', thread: 't-impunread', tags: '|INBOX|important|', date: 50, priorityScore: 9 });
    add(db, { id: 'st', thread: 't-star', tags: '|INBOX|starred|read|', date: 40, attachments: 1 });
    add(db, { id: 'ee', thread: 't-else', tags: '|INBOX|read|reminders|', date: 30 });
    add(db, { id: 'un', thread: 't-unread', tags: '|INBOX|', date: 20 });
    new ReadModelMaintainer(() => db).backfillNow();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SARVINBOX_READMODEL_READS;
    else process.env.SARVINBOX_READMODEL_READS = originalEnv;
    db.close();
  });

  const threads = (rows: Array<{ threadId: string }>): Set<string> => new Set(rows.map((r) => r.threadId));

  it('turns on once the backfill reports complete, and the kill-switch forces legacy', () => {
    expect(repo.readModelReadsEnabled()).toBe(true);
    process.env.SARVINBOX_READMODEL_READS = '0';
    expect(repo.readModelReadsEnabled()).toBe(false);
    process.env.SARVINBOX_READMODEL_READS = '1';
    expect(repo.readModelReadsEnabled()).toBe(true);
  });

  it('resolves a folder path to its id, or null when absent', () => {
    expect(repo.folderIdForPath('INBOX')).toBe('f-inbox');
    expect(repo.folderIdForPath('No/Such')).toBeNull();
    expect(repo.folderIdForPath(undefined)).toBeNull();
  });

  // The fast path is only taken for a thread-collapsed, default-sorted,
  // uncategorized query — anything else must fall through to the legacy scan, or
  // a bulk per-message caller would get cross-folder hydrated rows.
  it('getByFolder serves the same threads from the read-model as the legacy scan', async () => {
    const fast = await repo.getByFolder('f-inbox', { ...page, collapseThreads: true });
    process.env.SARVINBOX_READMODEL_READS = '0';
    const legacy = await repo.getByFolder('f-inbox', { ...page, collapseThreads: true });
    expect(threads(fast)).toEqual(threads(legacy));
    expect(idSet(fast)).toEqual(idSet(legacy));
  });

  it('getByFolder keeps the legacy scan for a category filter or a non-default sort', async () => {
    // A per-slug filter has no thread_folders column, so it must NOT use the fast path.
    expect(ids(await repo.getByFolder('f-inbox', { ...page, collapseThreads: true, categoryTag: 'reminders' })))
      .toEqual(['ee']);
    expect(ids(await repo.getByFolder('f-inbox', { ...page, collapseThreads: true, sortOrder: 'asc' })))
      .toEqual(['un', 'ee', 'st', 'iu']);
    // Not opted into thread collapsing => per-message legacy rows.
    expect(idSet(await repo.getByFolder('f-inbox', page))).toEqual(new Set(['iu', 'st', 'ee', 'un']));
  });

  it('listFolderFast / countFolderFast agree with each other and honor quick filters', async () => {
    expect(repo.countFolderFast('f-inbox')).toBe(4);
    expect(threads(await repo.listFolderFast('f-inbox', page)))
      .toEqual(new Set(['t-impunread', 't-star', 't-else', 't-unread']));

    expect(repo.countFolderFast('f-inbox', { isUnread: true })).toBe(2);
    expect(repo.countFolderFast('f-inbox', { isUnread: false })).toBe(2);
    expect(repo.countFolderFast('f-inbox', { isFlagged: true })).toBe(1);
    expect(repo.countFolderFast('f-inbox', { hasAttachments: true })).toBe(1);
    // 2, not 3: the read-model counts `important` as a category slug as well as a
    // flag tag (it is a seeded ai_category_definitions row), so the
    // important-flagged thread is "labelled" — same collision the legacy
    // noCategory filter has.
    expect(repo.countFolderFast('f-inbox', { noCategory: true })).toBe(2);
    expect(threads(await repo.listFolderFast('f-inbox', { ...page, viewFilter: { isFlagged: true } })))
      .toEqual(new Set(['t-star']));
    expect(repo.countFolderFast('f-nope')).toBe(0);
    expect(await repo.listFolderFast('f-inbox', { limit: 10, offset: 99 })).toEqual([]);
  });

  // Section reads move to the read-model once backfill completes; an unknown
  // section name must return nothing rather than an unfiltered folder dump.
  it('listSectionFast / countSectionFast mirror the legacy sections and reject unknown filters', async () => {
    for (const [filter, expected] of [
      ['important_unread', ['t-impunread']],
      ['starred', ['t-star']],
      ['everything_else', ['t-else', 't-unread']],
      ['important', ['t-impunread']],
      ['unread', ['t-impunread', 't-unread']],
      ['not_important', ['t-star', 't-else', 't-unread']],
      ['read', ['t-star', 't-else']],
    ] as Array<[string, string[]]>) {
      expect(threads(await repo.listSectionFast(filter, 'f-inbox', page))).toEqual(new Set(expected));
      expect(repo.countSectionFast(filter, 'f-inbox')).toBe(expected.length);
      // getSectionCount routes here automatically once the read-model is ready.
      expect(await repo.getSectionCount(filter, 'INBOX')).toBe(expected.length);
    }

    expect(await repo.listSectionFast('made_up', 'f-inbox', page)).toEqual([]);
    expect(repo.countSectionFast('made_up', 'f-inbox')).toBe(0);
    expect(repo.countSectionFast('unread', 'f-inbox', { isFlagged: true })).toBe(0);
  });

  // An unknown folder path can't be resolved to a read-model key, so the count
  // must fall back to the legacy path instead of silently reporting 0.
  it('getSectionCount falls back to the legacy path when the folder path is unknown', async () => {
    expect(await repo.getSectionCount('unread', 'No/Such/Folder')).toBe(0);
    expect(await repo.getSectionCount('unread')).toBe(2);
  });
});
