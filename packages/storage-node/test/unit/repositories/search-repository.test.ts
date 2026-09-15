import type { EmailRecord, SearchQuery } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';


import { SearchRepository } from '../../../src/repositories/search-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';

// Search is how users find mail they can't see in a list, so a wrong predicate
// here is indistinguishable from lost mail: the message exists but the app swears
// it doesn't. These tests run against the REAL migrated schema (real FTS5 table +
// sync triggers) so every filter is proven to return exactly the matching rows
// and exclude the near-misses, that combined filters AND (never OR), that the
// search box can't be used to inject SQL, and that a broken/missing FTS index
// still returns results through the LIKE fallback instead of an empty screen.

/** Only the columns the assertions read — search() maps rows through this. */
const rowToRecord = (row: any): EmailRecord =>
  ({
    id: row.id,
    subject: row.subject,
    tags: row.tags,
    date: row.date,
    fromAddress: row.from_address,
    threadId: row.thread_id,
    threadMessageCount: row.thread_message_count,
    relevanceScore: row.relevance_score,
  }) as unknown as EmailRecord;

const ids = (rows: EmailRecord[]): string[] => rows.map((r) => r.id);
const sortedIds = (rows: EmailRecord[]): string[] => ids(rows).sort();

interface EmailSeed {
  id: string;
  subject?: string | null;
  from?: string;
  fromName?: string | null;
  to?: string | null;
  cc?: string | null;
  body?: string;
  tags: string;
  date: number;
  hasAttachments?: boolean;
  attachmentNames?: string | null;
  rawBody?: string;
  threadId?: string;
  folderId?: string;
}

function addEmail(db: Database.Database, seed: EmailSeed): void {
  const threadId = seed.threadId ?? `t-${seed.id}`;
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(threadId, seed.subject ?? '', `<${seed.id}>`, `<${seed.id}>`, seed.date);

  db.prepare(
    // The length columns are populated here for the same reason every
    // production writer populates them: on a fresh (fully-migrated) database
    // they are the source the size filter reads, so a seeded row without them
    // is not a valid row and would prove nothing about the filter.
    `INSERT INTO emails (id, message_id, thread_id, folder_id, tags, subject, from_address, from_name,
                         to_address, cc_address, date, clean_body, raw_body,
                         clean_body_len, raw_body_len, content_type, content_hash,
                         has_attachments, attachment_names)
     VALUES (@id, @messageId, @threadId, @folderId, @tags, @subject, @fromAddress, @fromName,
             @toAddress, @ccAddress, @date, @cleanBody, @rawBody,
             LENGTH(TRIM(@cleanBody)), LENGTH(TRIM(@rawBody)), 'text', @contentHash,
             @hasAttachments, @attachmentNames)`,
  ).run({
    id: seed.id,
    messageId: `<${seed.id}@test>`,
    threadId,
    folderId: seed.folderId ?? 'f-inbox',
    tags: seed.tags,
    subject: seed.subject ?? null,
    fromAddress: seed.from ?? 'someone@example.test',
    fromName: seed.fromName ?? null,
    toAddress: seed.to ?? null,
    ccAddress: seed.cc ?? null,
    date: seed.date,
    cleanBody: seed.body ?? '',
    rawBody: seed.rawBody ?? 'x'.repeat(10),
    contentHash: `hash-${seed.id}`,
    hasAttachments: seed.hasAttachments ? 1 : 0,
    attachmentNames: seed.attachmentNames ?? null,
  });
}

/** Removes the FTS index and its sync triggers, as a corrupt/partly-migrated DB would. */
function breakFtsIndex(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS emails_fts_insert;
    DROP TRIGGER IF EXISTS emails_fts_update;
    DROP TRIGGER IF EXISTS emails_fts_delete;
    DROP TABLE IF EXISTS emails_fts;
  `);
}

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(name);

describe('SearchRepository', () => {
  let db: Database.Database;
  let repo: SearchRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new SearchRepository(() => db, rowToRecord);

    db.exec(`
      INSERT INTO folders (id, name, path) VALUES
        ('f-inbox','INBOX','INBOX'),
        ('f-trash','Trash','Trash'),
        ('f-arch','Archive','Archive');
      -- 'finance' and friends are seeded by the real schema; add a DISABLED
      -- category too, because noCategory must still treat it as "labelled".
      INSERT OR IGNORE INTO ai_category_definitions (slug, name, prompt, is_enabled) VALUES
        ('travel','Travel','p',0);
    `);

    // e1 attachment + read + category | e2 unread | e3 starred+read+big
    // e4 lives in Trash (excluded by default) | e5 in Archive | e6 punctuation-only token
    addEmail(db, {
      id: 'e1', subject: 'Quarterly invoice from Acme', from: 'billing@acme.test', fromName: 'Acme Billing',
      to: 'me@my.test', cc: 'boss@my.test', body: 'Please find the invoice attached for Q3',
      tags: '|INBOX|read|finance|', date: 1000, hasAttachments: true, attachmentNames: 'invoice-q3.pdf',
      rawBody: 'x'.repeat(400),
    });
    addEmail(db, {
      id: 'e2', subject: 'Team lunch on Friday', from: 'sam@corp.test', fromName: 'Sam Jones',
      to: 'team@my.test', body: 'Lets grab lunch at noon', tags: '|INBOX|', date: 2000,
      rawBody: 'x'.repeat(80),
    });
    addEmail(db, {
      id: 'e3', subject: 'Receipt for your payment', from: 'noreply@shop.test', fromName: 'Shop Bot',
      to: 'me@my.test', body: 'Thanks for your payment', tags: '|INBOX|read|starred|', date: 3000,
      rawBody: 'x'.repeat(5000),
    });
    addEmail(db, {
      id: 'e4', subject: 'Old invoice', from: 'billing@acme.test', body: 'invoice from last year',
      tags: '|Trash|', date: 4000, folderId: 'f-trash',
    });
    addEmail(db, {
      id: 'e5', subject: 'Invoice reminder', from: 'ap@vendor.test', body: 'gentle reminder about the invoice',
      tags: '|Archive|', date: 5000, folderId: 'f-arch',
    });
    addEmail(db, {
      id: 'e6', subject: 'Build ###42 failed', from: 'ci@corp.test', body: 'pipeline broke',
      tags: '|INBOX|', date: 6000,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ── no-text (pure filter) searches ─────────────────────────────────────────
  describe('empty query', () => {
    it('returns every non-special-folder mail, newest first, and never touches Trash', () => {
      // The default scope hides Trash/Spam/Drafts/Sent — a trashed message
      // showing up in normal search results reads as "deleted mail came back".
      expect(ids(repo.search({ query: '' }))).toEqual(['e6', 'e5', 'e3', 'e2', 'e1']);
      expect(ids(repo.search({ query: '   ' }))).toEqual(['e6', 'e5', 'e3', 'e2', 'e1']);
    });

    it('scope: "all" keeps the same special-folder exclusions', () => {
      expect(ids(repo.search({ query: '', scope: 'all' }))).toEqual(['e6', 'e5', 'e3', 'e2', 'e1']);
    });

    it('hydrates shared thread metadata alongside the row', () => {
      const [newest] = repo.search({ query: '', limit: 1 });
      expect(newest.threadMessageCount).toBe(1);
    });
  });

  // ── one filter at a time ───────────────────────────────────────────────────
  describe('individual filters', () => {
    it('from matches EITHER the address or the display name', () => {
      expect(ids(repo.search({ query: '', from: 'acme' }))).toEqual(['e1']);       // address
      expect(ids(repo.search({ query: '', from: 'Sam Jones' }))).toEqual(['e2']);  // display name
      expect(repo.search({ query: '', from: 'nobody@nowhere.test' })).toEqual([]);
    });

    it('to matches only the To header, not From or Cc', () => {
      expect(ids(repo.search({ query: '', to: 'team@my.test' }))).toEqual(['e2']);
      expect(repo.search({ query: '', to: 'boss@my.test' })).toEqual([]);   // boss is only in Cc
      expect(repo.search({ query: '', to: 'billing@acme.test' })).toEqual([]);
    });

    it('cc matches only the Cc header', () => {
      expect(ids(repo.search({ query: '', cc: 'boss' }))).toEqual(['e1']);
      expect(repo.search({ query: '', cc: 'team@my.test' })).toEqual([]);
    });

    it('subject matches the subject only, not the body', () => {
      expect(ids(repo.search({ query: '', subject: 'invoice' }))).toEqual(['e5', 'e1']);
      // e2's body says "lunch at noon"; the SUBJECT filter must not see bodies.
      expect(ids(repo.search({ query: '', subject: 'noon' }))).toEqual([]);
    });

    it('hasAttachments splits both ways and false is NOT treated as "unset"', () => {
      expect(ids(repo.search({ query: '', hasAttachments: true }))).toEqual(['e1']);
      expect(ids(repo.search({ query: '', hasAttachments: false }))).toEqual(['e6', 'e5', 'e3', 'e2']);
    });

    it('isUnread splits unread from read (the tag is |read|, absence = unread)', () => {
      expect(ids(repo.search({ query: '', isUnread: true }))).toEqual(['e6', 'e5', 'e2']);
      expect(ids(repo.search({ query: '', isUnread: false }))).toEqual(['e3', 'e1']);
    });

    it('isFlagged splits starred from unstarred', () => {
      expect(ids(repo.search({ query: '', isFlagged: true }))).toEqual(['e3']);
      expect(ids(repo.search({ query: '', isFlagged: false }))).toEqual(['e6', 'e5', 'e2', 'e1']);
    });

    it('dateFrom/dateTo are INCLUSIVE bounds, and combine into a window', () => {
      expect(ids(repo.search({ query: '', dateFrom: 3000 }))).toEqual(['e6', 'e5', 'e3']);
      expect(ids(repo.search({ query: '', dateTo: 2000 }))).toEqual(['e2', 'e1']);
      expect(ids(repo.search({ query: '', dateFrom: 2000, dateTo: 3000 }))).toEqual(['e3', 'e2']);
      expect(repo.search({ query: '', dateFrom: 7000 })).toEqual([]);
    });

    it('sizeMin/sizeMax filter on raw_body length', () => {
      expect(ids(repo.search({ query: '', sizeMin: 5000 }))).toEqual(['e3']);
      expect(ids(repo.search({ query: '', sizeMax: 100 }))).toEqual(['e6', 'e5', 'e2']);
      expect(ids(repo.search({ query: '', sizeMin: 80, sizeMax: 400 }))).toEqual(['e2', 'e1']);
    });

    // The size filter reads the stored `raw_body_len` on a migrated DB and falls
    // back to `length(raw_body)` while the backfill is still running. Both forms
    // must select the same rows — otherwise a size-filtered search quietly
    // returns different mail depending on how far a background job has got.
    it('sizeMin/sizeMax agree whether or not the length columns are populated', () => {
      const withColumns = {
        min: ids(repo.search({ query: '', sizeMin: 5000 })),
        max: ids(repo.search({ query: '', sizeMax: 100 })),
        both: ids(repo.search({ query: '', sizeMin: 80, sizeMax: 400 })),
      };
      // Pretend this DB predates migration v72: no lengths, flag off.
      db.exec('UPDATE emails SET clean_body_len = NULL, raw_body_len = NULL');
      db.prepare("UPDATE email_body_metrics_state SET value = '0' WHERE key = 'lengths_backfilled'").run();
      expect(ids(repo.search({ query: '', sizeMin: 5000 }))).toEqual(withColumns.min);
      expect(ids(repo.search({ query: '', sizeMax: 100 }))).toEqual(withColumns.max);
      expect(ids(repo.search({ query: '', sizeMin: 80, sizeMax: 400 }))).toEqual(withColumns.both);
    });

    // A one-character query is prefix-matched no longer: `a*` matches nearly the
    // whole FTS vocabulary, so at 100k emails the first keystroke in the search
    // box hands back the entire mailbox as candidates, sorts it, then reads a
    // page of bodies off it — the one search shape whose cost scales with
    // mailbox size instead of with the number of matches.
    it('does not prefix-match a single character, but still does from two', () => {
      expect(ids(repo.search({ query: 'q' }))).toEqual([]);
      expect(ids(repo.search({ query: 'qu' }))).toEqual(['e1']); // "Quarterly"
      expect(ids(repo.search({ query: 'quarterly' }))).toEqual(['e1']);
    });

    it('aiCategory scopes to a category tag; noCategory returns only UNLABELLED mail', () => {
      expect(ids(repo.search({ query: '', aiCategory: 'finance' }))).toEqual(['e1']);
      // noCategory excludes every DEFINED slug — including the disabled one,
      // because a disabled-but-tagged category still renders a badge.
      expect(ids(repo.search({ query: '', noCategory: true }))).toEqual(['e6', 'e5', 'e3', 'e2']);
      db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|travel|', 'e2');
      expect(ids(repo.search({ query: '', noCategory: true }))).toEqual(['e6', 'e5', 'e3']);
    });

    it('threadIds scopes results to specific conversations', () => {
      expect(ids(repo.search({ query: '', threadIds: ['t-e3', 't-e2'] }))).toEqual(['e3', 'e2']);
      expect(repo.search({ query: '', threadIds: ['no-such-thread'] })).toEqual([]);
      // An empty array must not be read as "no thread matches" (that would blank
      // the results whenever the caller passes [] for "unscoped").
      expect(ids(repo.search({ query: '', threadIds: [] }))).toEqual(['e6', 'e5', 'e3', 'e2', 'e1']);
    });
  });

  describe('folder scoping', () => {
    it('folderPath scopes to that folder and STOPS excluding it when it is a special folder', () => {
      expect(ids(repo.search({ query: '', folderPath: 'INBOX' }))).toEqual(['e6', 'e3', 'e2', 'e1']);
      // Searching inside Trash must actually show trashed mail.
      expect(ids(repo.search({ query: '', folderPath: 'Trash' }))).toEqual(['e4']);
    });

    it('matches folder tags on whole segments, never a partial path', () => {
      addEmail(db, { id: 'e7', subject: 'Nested', tags: '|INBOX/Archive|', date: 7000, folderId: 'f-inbox' });
      // '|INBOX|' must not match '|INBOX/Archive|' — otherwise every subfolder's
      // mail leaks into the parent's search results.
      expect(ids(repo.search({ query: '', folderPath: 'INBOX' }))).toEqual(['e6', 'e3', 'e2', 'e1']);
      expect(ids(repo.search({ query: '', folderPath: 'INBOX/Archive' }))).toEqual(['e7']);
    });

    it('legacy folderIds resolve to paths, skip unknown ids, and skip the special-folder exclusion', () => {
      expect(ids(repo.search({ query: '', folderIds: ['f-arch'] }))).toEqual(['e5']);
      expect(ids(repo.search({ query: '', folderIds: ['f-arch', 'not-a-folder'] }))).toEqual(['e5']);
      // Without folderPath/scope the exclusion is skipped, so a Trash folderId
      // does return trashed mail.
      expect(ids(repo.search({ query: '', folderIds: ['f-trash'] }))).toEqual(['e4']);
      // ...but an explicit scope: 'all' re-applies the exclusion, so Trash empties.
      expect(repo.search({ query: '', folderIds: ['f-trash'], scope: 'all' })).toEqual([]);
    });
  });

  // ── combined filters ───────────────────────────────────────────────────────
  describe('combined filters', () => {
    it('ANDs every filter — a row matching only one of them is excluded', () => {
      // OR-ing these would show unrelated mail as if it matched the query.
      expect(repo.search({ query: '', from: 'acme', subject: 'lunch' })).toEqual([]);
      expect(repo.search({ query: '', from: 'acme', hasAttachments: false })).toEqual([]);
      expect(repo.search({ query: '', from: 'acme', isFlagged: true })).toEqual([]);
      expect(ids(repo.search({ query: '', from: 'acme', hasAttachments: true, isUnread: false, subject: 'invoice' })))
        .toEqual(['e1']);
    });

    it('ANDs a text query with structured filters', () => {
      expect(ids(repo.search({ query: 'invoice' }))).toEqual(['e5', 'e1']);
      expect(ids(repo.search({ query: 'invoice', folderPath: 'INBOX' }))).toEqual(['e1']);
      expect(ids(repo.search({ query: 'invoice', hasAttachments: true }))).toEqual(['e1']);
      expect(repo.search({ query: 'invoice', isFlagged: true })).toEqual([]);
      expect(ids(repo.search({ query: 'invoice', dateFrom: 4500 }))).toEqual(['e5']);
    });
  });

  // ── FTS5 text matching ─────────────────────────────────────────────────────
  describe('FTS5 text query', () => {
    it('matches subject and body, and PREFIX-matches partial words', () => {
      expect(sortedIds(repo.search({ query: 'invoice' }))).toEqual(['e1', 'e5']);
      expect(sortedIds(repo.search({ query: 'invo' }))).toEqual(['e1', 'e5']);   // term* prefix match
      expect(sortedIds(repo.search({ query: 'pipeline' }))).toEqual(['e6']);     // body only
    });

    it('indexes sender, recipients and ATTACHMENT NAMES, not just subject/body', () => {
      expect(ids(repo.search({ query: 'acme' })).includes('e1')).toBe(true);
      expect(sortedIds(repo.search({ query: 'team' }))).toEqual(['e2']);      // to_address
      expect(sortedIds(repo.search({ query: 'boss' }))).toEqual(['e1']);      // cc_address
      expect(sortedIds(repo.search({ query: 'pdf' }))).toEqual(['e1']);       // attachment_names
    });

    it('requires ALL tokens (implicit AND) so multi-word queries narrow, never widen', () => {
      expect(sortedIds(repo.search({ query: 'invoice acme' }))).toEqual(['e1']);
      expect(repo.search({ query: 'invoice lunch' })).toEqual([]);
    });

    it('strips FTS operator keywords — a typed OR/NOT/NEAR is dropped, not honoured', () => {
      // Pinning real behaviour: "lunch OR invoice" becomes `lunch* invoice*`,
      // i.e. AND — so it returns nothing rather than the union. Users get no
      // boolean syntax, but the query can never blow up the FTS parser either.
      expect(repo.search({ query: 'lunch OR invoice' })).toEqual([]);
      expect(sortedIds(repo.search({ query: 'invoice NEAR acme' }))).toEqual(['e1']);
      expect(sortedIds(repo.search({ query: 'NOT invoice' }))).toEqual(['e1', 'e5']);
    });

    it('treats FTS syntax characters as plain separators instead of crashing the query', () => {
      // These all reach FTS as bare tokens; before escaping, an unbalanced quote
      // or a bare `*`/`(` threw and the search box returned nothing.
      expect(sortedIds(repo.search({ query: '"invoice"' }))).toEqual(['e1', 'e5']);
      expect(sortedIds(repo.search({ query: 'invoice(' }))).toEqual(['e1', 'e5']);
      expect(sortedIds(repo.search({ query: 'invoice^~*' }))).toEqual(['e1', 'e5']);
      expect(sortedIds(repo.search({ query: 'billing@acme.test' }))).toEqual(['e1']);
    });

    it('honours limit and offset over the ranked result set', () => {
      expect(ids(repo.search({ query: 'invoice', limit: 1 }))).toEqual(['e5']);          // newest first
      expect(ids(repo.search({ query: 'invoice', limit: 1, offset: 1 }))).toEqual(['e1']);
      expect(repo.search({ query: 'invoice', limit: 1, offset: 5 })).toEqual([]);
      expect(ids(repo.search({ query: '', limit: 2, offset: 1 }))).toEqual(['e5', 'e3']);
    });
  });

  describe('doesntHave (exclusion terms)', () => {
    it('removes matches that also contain the excluded term', () => {
      expect(ids(repo.search({ query: 'invoice', doesntHave: 'acme' }))).toEqual(['e5']);
      expect(repo.search({ query: 'invoice', doesntHave: 'invoice' })).toEqual([]);
    });

    it('is ignored when it escapes to nothing (so it cannot silently blank results)', () => {
      expect(sortedIds(repo.search({ query: 'invoice', doesntHave: '***' }))).toEqual(['e1', 'e5']);
    });

    it('applies to filter-only searches too', () => {
      expect(ids(repo.search({ query: '', doesntHave: 'invoice' }))).toEqual(['e6', 'e3', 'e2']);
    });
  });

  // ── ordering ───────────────────────────────────────────────────────────────
  describe('ordering', () => {
    it('defaults to newest-first for both text and filter-only searches', () => {
      expect(ids(repo.search({ query: 'invoice' }))).toEqual(['e5', 'e1']);
      expect(ids(repo.search({ query: 'invoice', sortBy: 'date' }))).toEqual(['e5', 'e1']);
      expect(ids(repo.search({ query: 'invoice', sortBy: 'date', sortOrder: 'asc' }))).toEqual(['e5', 'e1']);
    });

    it('sorts by whitelisted columns when asked (non-relevance path)', () => {
      // Binary (case-sensitive) collation: Build < Invoice < Quarterly < Receipt < Team.
      expect(ids(repo.search({ query: '', sortBy: 'subject', sortOrder: 'asc' })))
        .toEqual(['e6', 'e5', 'e1', 'e3', 'e2']);
      expect(ids(repo.search({ query: '', sortBy: 'date', sortOrder: 'asc' })))
        .toEqual(['e1', 'e2', 'e3', 'e5', 'e6']);
    });

    // `sortBy: 'from'` is a documented option on SearchQuery, but it camel-maps to
    // the column `from`, which is NOT a column (`from_address` is) — so it fell
    // off the whitelist and "sort by sender" silently sorted by date. It is now
    // resolved through an alias before the whitelist check.
    it('sorts by SENDER for sortBy: "from"', () => {
      const bySender = repo.search({ query: '', sortBy: 'from', sortOrder: 'asc' });
      const senders = bySender.map((e) => e.from);
      expect(senders).toEqual([...senders].sort());
      // …and not merely the date order it used to produce.
      expect(ids(bySender)).not.toEqual(['e1', 'e2', 'e3', 'e5', 'e6']);
    });

    it('falls back to date for a sort key that is neither a column nor an alias', () => {
      expect(ids(repo.search({ query: '', sortBy: 'nonsense; DROP TABLE emails--' as SearchQuery['sortBy'] })))
        .toEqual(['e6', 'e5', 'e3', 'e2', 'e1']);
      expect(tableExists(db, 'emails')).toBe(true);
    });

    it('relevance sort pulls starred > important > unread matches above older-but-equal matches', () => {
      // Identical text in every indexed column, so bm25 is equal and ONLY the
      // importance boost can reorder them. Dates ascend in the opposite
      // direction, proving recency is just the tie-breaker.
      const shared = {
        subject: 'Sync status', from: 'bot@corp.test', fromName: 'Bot', to: 'me@my.test',
        body: 'the widget sync report',
      };
      addEmail(db, { ...shared, id: 'r-star', tags: '|INBOX|read|starred|', date: 100 });
      addEmail(db, { ...shared, id: 'r-important', tags: '|INBOX|read|important|', date: 200 });
      addEmail(db, { ...shared, id: 'r-unread', tags: '|INBOX|', date: 300 });
      addEmail(db, { ...shared, id: 'r-plain', tags: '|INBOX|read|', date: 400 });

      expect(ids(repo.search({ query: 'widget', sortBy: 'relevance' })))
        .toEqual(['r-star', 'r-important', 'r-unread', 'r-plain']);
      // Same rows under the default sort come back in the reverse (date) order.
      expect(ids(repo.search({ query: 'widget' })))
        .toEqual(['r-plain', 'r-unread', 'r-important', 'r-star']);
    });

    it('PINS that the importance boost is an unconditional constant, so a starred WEAK match can outrank a strong one', () => {
      // The code comment claims subtracting the boost "never overrides a much
      // stronger keyword match" — measured, it can: the boost is a flat -4.0 on
      // the bm25 score, not a proportional nudge. Pinned so the ranking is a
      // deliberate choice rather than an accident nobody measured.
      addEmail(db, {
        id: 'strong', subject: 'widget widget widget', from: 'a@corp.test',
        body: 'widget widget widget widget', tags: '|INBOX|', date: 100,
      });
      addEmail(db, {
        id: 'weak-starred', subject: 'Notes', from: 'b@corp.test',
        body: `widget ${'filler '.repeat(200)}`, tags: '|INBOX|read|starred|', date: 900,
      });
      expect(ids(repo.search({ query: 'widget', sortBy: 'relevance' })))
        .toEqual(['weak-starred', 'strong']);
      // Without the boost, the strong keyword match is the more relevant row.
      db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|read|', 'weak-starred');
      expect(ids(repo.search({ query: 'widget', sortBy: 'relevance' })))
        .toEqual(['strong', 'weak-starred']);
    });

    it('relevance sort on a filter-only search degrades to date order', () => {
      // No FTS query means no bm25 column to rank by; it must not throw.
      expect(ids(repo.search({ query: '', sortBy: 'relevance' }))).toEqual(['e6', 'e5', 'e3', 'e2', 'e1']);
    });
  });

  // ── injection / literal-text safety ────────────────────────────────────────
  describe('SQL injection and literal-text safety', () => {
    it("treats `');DROP TABLE emails;--` in the search box as ordinary text", () => {
      const hostile = "');DROP TABLE emails;--";
      expect(repo.search({ query: hostile })).toEqual([]);
      expect(repo.count({ query: hostile })).toBe(0);
      expect(tableExists(db, 'emails')).toBe(true);
      expect(tableExists(db, 'emails_fts')).toBe(true);
      expect(repo.search({ query: '' })).toHaveLength(5);   // the mailbox survived
    });

    it('treats injection payloads in every structured filter as literal values', () => {
      const hostile = "' OR 1=1 --";
      expect(repo.search({ query: '', from: hostile })).toEqual([]);
      expect(repo.search({ query: '', to: hostile })).toEqual([]);
      expect(repo.search({ query: '', cc: hostile })).toEqual([]);
      expect(repo.search({ query: '', subject: hostile })).toEqual([]);
      expect(repo.search({ query: '', aiCategory: "finance'; DELETE FROM emails; --" })).toEqual([]);
      expect(repo.search({ query: '', folderPath: "INBOX' OR '1'='1" })).toEqual([]);
      expect(repo.search({ query: '', threadIds: ["t-e1'); DROP TABLE emails; --"] })).toEqual([]);
      expect(repo.search({ query: '', doesntHave: "'; DROP TABLE emails; --" })).toHaveLength(5);
      expect(tableExists(db, 'emails')).toBe(true);
      expect(repo.search({ query: '' })).toHaveLength(5);
    });

    it('matches quotes, backslashes and semicolons in the FTS path as separators only', () => {
      addEmail(db, {
        id: 'lit', subject: `He said "hello" \\ goodbye; ok`, from: 'lit@corp.test',
        body: `path C:\\Users\\me and 'quoted'`, tags: '|INBOX|', date: 8000,
      });
      expect(ids(repo.search({ query: '"hello"' }))).toEqual(['lit']);
      expect(ids(repo.search({ query: `C:\\Users` }))).toEqual(['lit']);
      expect(ids(repo.search({ query: `'quoted'` }))).toEqual(['lit']);
      expect(tableExists(db, 'emails')).toBe(true);
    });

    // `%` and `_` typed into from/to/subject used to act as LIKE wildcards, so
    // `Dis%off` matched "Discount 50% off" even though that substring never
    // appears — the filter silently matched MORE than the user asked for. They
    // are now escaped and matched literally.
    it('treats %/_ typed into from/to/subject as LITERAL characters', () => {
      addEmail(db, {
        id: 'pct', subject: 'Discount 50% off', from: 'sale_s@shop.test',
        body: 'save now', tags: '|INBOX|', date: 9000,
      });
      expect(ids(repo.search({ query: '', subject: '50% off' }))).toEqual(['pct']);  // the literal % is there
      expect(repo.search({ query: '', subject: 'Dis%off' })).toEqual([]);            // no longer a wildcard
      expect(repo.search({ query: '', subject: 'Disc_unt' })).toEqual([]);           // _ is not "any char"
      expect(ids(repo.search({ query: '', from: 'sale_s' }))).toEqual(['pct']);      // literal _ still matches
      expect(repo.search({ query: '', from: 'salexs' })).toEqual([]);
    });

    it('keeps a %-containing FTS query literal (escaping strips the wildcard entirely)', () => {
      addEmail(db, {
        id: 'pct2', subject: 'Discount 50% off', from: 'sale@shop.test', body: 'save now',
        tags: '|INBOX|', date: 9500,
      });
      // In the FTS path `%` is stripped to whitespace, so `50%` searches for the
      // token "50" — never a wildcard match against unrelated mail.
      expect(ids(repo.search({ query: '50%' }))).toEqual(['pct2']);
      // A query of ONLY wildcards has no FTS tokens, so it drops into the LIKE
      // fallback — where it used to become `LIKE '%%%'` and return the WHOLE
      // mailbox, which reads as "results found" for a search that matched
      // nothing. The `%` is now literal, so it matches only text containing one.
      expect(sortedIds(repo.search({ query: '%' }))).toEqual(['pct2']);
    });
  });

  // ── LIKE fallback ──────────────────────────────────────────────────────────
  describe('LIKE fallback when the query escapes to nothing', () => {
    it('falls back so a punctuation-only query still finds a literal substring', () => {
      // '###42' has no FTS tokens at all; without the LIKE fallback the search
      // box would say "no results" for text plainly visible in the subject.
      expect(ids(repo.search({ query: '###42' }))).toEqual(['e6']);
      expect(repo.count({ query: '###42' })).toBe(1);
      // No alphanumerics at all: nothing survives escaping, so count() has to
      // fall back to counting LIKE rows rather than reporting 0.
      expect(ids(repo.search({ query: '###' }))).toEqual(['e6']);
      expect(repo.count({ query: '###' })).toBe(1);
      expect(repo.search({ query: '@@@' })).toEqual([]);
      expect(repo.count({ query: '@@@' })).toBe(0);
    });

    it('still applies structured filters, exclusions, ordering and paging in the fallback', () => {
      expect(ids(repo.search({ query: '###', folderPath: 'INBOX' }))).toEqual(['e6']);
      expect(repo.search({ query: '###', isFlagged: true })).toEqual([]);
      expect(repo.search({ query: '###', doesntHave: 'failed' })).toEqual([]);   // word-wise NOT LIKE
      expect(ids(repo.search({ query: '###', limit: 1 }))).toEqual(['e6']);
    });
  });

  describe('LIKE fallback when the FTS index is missing', () => {
    it('still returns matching mail instead of an empty result screen', () => {
      breakFtsIndex(db);
      // Every FTS-path query now throws inside search(); the catch must recover.
      expect(sortedIds(repo.search({ query: 'invoice' }))).toEqual(['e1', 'e5']);
      expect(ids(repo.search({ query: 'invoice', folderPath: 'INBOX', hasAttachments: true }))).toEqual(['e1']);
      expect(ids(repo.search({ query: 'invoice', doesntHave: 'acme' }))).toEqual(['e5']);
      expect(ids(repo.search({ query: 'payment', isFlagged: true }))).toEqual(['e3']);
      expect(ids(repo.search({ query: 'invoice', aiCategory: 'finance' }))).toEqual(['e1']);
    });

    it('the fallback honours from/to/subject/attachment/unread/starred filters too', () => {
      breakFtsIndex(db);
      expect(ids(repo.search({ query: 'invoice', from: 'Acme Billing' }))).toEqual(['e1']);
      expect(ids(repo.search({ query: 'invoice', to: 'me@my.test' }))).toEqual(['e1']);
      expect(ids(repo.search({ query: 'invoice', subject: 'reminder' }))).toEqual(['e5']);
      expect(ids(repo.search({ query: 'invoice', hasAttachments: true }))).toEqual(['e1']);
      expect(ids(repo.search({ query: 'invoice', hasAttachments: false }))).toEqual(['e5']);
      expect(ids(repo.search({ query: 'invoice', isUnread: true }))).toEqual(['e5']);
      expect(ids(repo.search({ query: 'invoice', isUnread: false }))).toEqual(['e1']);
      expect(ids(repo.search({ query: 'payment', isFlagged: true }))).toEqual(['e3']);
      expect(ids(repo.search({ query: 'invoice', isFlagged: false }))).toEqual(['e5', 'e1']);
      expect(ids(repo.search({ query: 'invoice', scope: 'all' }))).toEqual(['e5', 'e1']);   // Trash still hidden
    });

    // searchWithLike used to implement a SUBSET of appendFilters, so the moment
    // the FTS index was unavailable these four filters stopped narrowing
    // anything and the user silently got MORE rows than they asked for —
    // including, via the folderIds case, Trash mail the normal path hides. Both
    // paths now build their filters from the same method.
    it('applies cc / threadIds / noCategory / folderIds in the fallback too', () => {
      breakFtsIndex(db);
      const both = ids(repo.search({ query: 'invoice' }));
      expect(both).toEqual(['e5', 'e1']);   // the unfiltered baseline

      // Each filter must NARROW the baseline, exactly as the FTS path does.
      for (const narrowing of [
        { cc: 'boss' },
        { threadIds: ['t-e1'] },
        { noCategory: true },
        { folderIds: ['f-arch'] },
      ] as Array<Partial<SearchQuery>>) {
        const got = ids(repo.search({ query: 'invoice', ...narrowing }));
        expect(got.length).toBeLessThan(both.length);
        expect(got.every((id) => both.includes(id))).toBe(true);
      }
    });

    it('the fallback honours dates, size, sorting and paging', () => {
      breakFtsIndex(db);
      expect(ids(repo.search({ query: 'invoice', dateFrom: 4500 }))).toEqual(['e5']);
      expect(ids(repo.search({ query: 'invoice', dateTo: 2000 }))).toEqual(['e1']);
      expect(ids(repo.search({ query: 'invoice', sizeMin: 200 }))).toEqual(['e1']);
      expect(ids(repo.search({ query: 'invoice', sizeMax: 100 }))).toEqual(['e5']);
      expect(ids(repo.search({ query: 'invoice', sortBy: 'subject', sortOrder: 'asc' }))).toEqual(['e5', 'e1']);
      expect(ids(repo.search({ query: 'invoice', limit: 1, offset: 1 }))).toEqual(['e1']);
    });

    it('count() falls back to counting the LIKE results', () => {
      breakFtsIndex(db);
      expect(repo.count({ query: 'invoice' })).toBe(2);
      expect(repo.count({ query: 'invoice', folderPath: 'INBOX' })).toBe(1);
    });
  });

  // ── count() ────────────────────────────────────────────────────────────────
  describe('count', () => {
    it('counts the WHOLE match set, ignoring limit/offset (the paginator "of N")', () => {
      // A count that honoured LIMIT would render "1 of 1" on a 5-result search.
      expect(repo.count({ query: '', limit: 1, offset: 2 })).toBe(5);
      expect(repo.count({ query: 'invoice', limit: 1 })).toBe(2);
    });

    it('agrees exactly with search() for the same filters', () => {
      const queries: SearchQuery[] = [
        { query: '' },
        { query: 'invoice' },
        { query: 'invoice', folderPath: 'INBOX' },
        { query: '', isUnread: true },
        { query: '', hasAttachments: true, from: 'acme' },
        { query: '', noCategory: true },
        { query: '', folderPath: 'Trash' },
        { query: 'invoice', doesntHave: 'acme' },
        { query: '', dateFrom: 2000, dateTo: 5000 },
        { query: 'nothing-matches-this' },
      ];
      for (const q of queries) {
        expect(repo.count(q)).toBe(repo.search(q).length);
      }
    });
  });

  // ── FTS index lifecycle ────────────────────────────────────────────────────
  describe('FTS index lifecycle', () => {
    it('reports the index as populated only while it holds rows', () => {
      expect(repo.isFTSPopulated()).toBe(true);
      db.exec('DELETE FROM emails_fts');
      expect(repo.isFTSPopulated()).toBe(false);
      breakFtsIndex(db);
      expect(repo.isFTSPopulated()).toBe(false);   // missing table, not a throw
    });

    it('initializeFTS + rebuildIndex recover searchability after the index is lost', () => {
      breakFtsIndex(db);
      expect(repo.search({ query: 'lunch' }).length).toBe(1);   // LIKE fallback only

      repo.initializeFTS();
      expect(repo.isFTSPopulated()).toBe(false);   // table exists but is empty
      repo.rebuildIndex();
      expect(repo.isFTSPopulated()).toBe(true);
      expect(sortedIds(repo.search({ query: 'invoice' }))).toEqual(['e1', 'e5']);

      // ...and the recreated triggers keep new mail searchable.
      addEmail(db, { id: 'fresh', subject: 'Fresh invoice', from: 'x@corp.test', tags: '|INBOX|', date: 9900 });
      expect(sortedIds(repo.search({ query: 'invoice' }))).toEqual(['e1', 'e5', 'fresh']);
    });

    it('rebuildIndex needs the table to exist — it tolerates the missing DELETE but not the INSERT', () => {
      // Pinning the order-of-operations contract: callers must initializeFTS()
      // before rebuilding, which is what the migration does.
      breakFtsIndex(db);
      expect(() => repo.rebuildIndex()).toThrow();
      repo.initializeFTS();
      expect(() => repo.rebuildIndex()).not.toThrow();
      expect(repo.isFTSPopulated()).toBe(true);
    });

    it('rebuildIndex is idempotent and does not duplicate entries', () => {
      const countRows = () => (db.prepare('SELECT COUNT(*) AS c FROM emails_fts').get() as { c: number }).c;
      repo.rebuildIndex();
      const first = countRows();
      repo.rebuildIndex();
      expect(countRows()).toBe(first);
      expect(sortedIds(repo.search({ query: 'invoice' }))).toEqual(['e1', 'e5']);
    });

    it('initializeFTS is safe to re-run on an existing index (startup migration path)', () => {
      expect(() => repo.initializeFTS()).not.toThrow();
      expect(sortedIds(repo.search({ query: 'invoice' }))).toEqual(['e1', 'e5']);
    });

    it('keeps the index in step with edits and deletes via the sync triggers', () => {
      db.prepare('UPDATE emails SET subject = ?, clean_body = ? WHERE id = ?')
        .run('Renamed to widget', 'widget body', 'e2');
      expect(ids(repo.search({ query: 'widget' }))).toEqual(['e2']);
      expect(repo.search({ query: 'lunch' })).toEqual([]);

      db.prepare('DELETE FROM emails WHERE id = ?').run('e2');
      expect(repo.search({ query: 'widget' })).toEqual([]);
    });
  });

  // ── suggestTerms ───────────────────────────────────────────────────────────
  describe('suggestTerms', () => {
    it('needs at least 2 characters before suggesting anything', () => {
      expect(repo.suggestTerms('')).toEqual([]);
      expect(repo.suggestTerms('i')).toEqual([]);
    });

    it('prefix-matches indexed vocabulary, case-insensitively, and caps the list', () => {
      const terms = repo.suggestTerms('INV');
      expect(terms).toContain('invoice');
      expect(terms.every((t) => t.startsWith('inv'))).toBe(true);
      expect(terms.length).toBeLessThanOrEqual(10);
    });

    it('returns [] for a prefix nothing matches, and when the index is missing', () => {
      expect(repo.suggestTerms('zzzz')).toEqual([]);
      breakFtsIndex(db);
      expect(repo.suggestTerms('inv')).toEqual([]);
    });
  });

  it('throws Storage not initialized when the DB is not ready yet', () => {
    const detached = new SearchRepository(() => undefined as unknown as Database.Database, rowToRecord);
    expect(() => detached.search({ query: '' })).toThrow('Storage not initialized');
  });
});
