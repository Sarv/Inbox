// AIRepository — the READ side: category listings and the counts behind the
// category chips.
//
// Every one of these queries is a bare `instr(tags, '|slug|')` predicate over the
// emails table, so the two things that can silently break are (a) the pipe
// anchoring — a slug that is a PREFIX of another must not match it — and (b) the
// special-folder exclusions, which are what keeps trashed/spam mail out of the
// chips. Both are asserted against a hand-seeded mailbox whose expected numbers
// are derived from the seeded rows themselves.
//
// Write-side behaviour lives in ai-repository.test.ts.

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newMigratedDb } from '../../../src/test-support/test-db';

import { AIRepository } from '../../../src/repositories/ai-repository';
import { EmailRepository } from '../../../src/repositories/email-repository';

const FIXED_NOW_MS = Date.UTC(2026, 7, 18, 12, 0, 0);

type EmailSeed = {
  id: string;
  tags: string;
  date?: number;
  threadId?: string;
  folderId?: string;
  aiProcessedAt?: number | null;
};

function insertEmail(db: Database.Database, seed: EmailSeed): void {
  const threadId = seed.threadId ?? `t-${seed.id}`;
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(threadId, `subject ${threadId}`, `<${seed.id}@x>`, `<${seed.id}@x>`);

  db.prepare(
    `INSERT INTO emails (
       id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
       clean_body, raw_body, content_type, content_hash, ai_processed_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, 'sender@example.com', ?, 'body', 'raw', 'text', ?, ?)`,
  ).run(
    seed.id,
    `<${seed.id}@x>`,
    threadId,
    seed.folderId ?? 'f-inbox',
    seed.tags,
    `subject ${seed.id}`,
    seed.date ?? 1000,
    `hash-${seed.id}`,
    seed.aiProcessedAt ?? null,
  );
}

describe('AIRepository read side (listings + counts)', () => {
  let db: Database.Database;
  let repo: AIRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    db = newMigratedDb();
    db.pragma('foreign_keys = ON');
    const folder = db.prepare('INSERT INTO folders (id, name, path) VALUES (?, ?, ?)');
    folder.run('f-inbox', 'INBOX', 'INBOX');
    folder.run('f-trash', 'Trash', 'Trash');
    folder.run('f-spam', 'Spam', 'Spam');
    folder.run('f-sent', 'Sent', 'Sent');
    folder.run('f-drafts', 'Drafts', 'Drafts');
    folder.run('f-archive', 'Archive', 'Archive');
    const emailRepo = new EmailRepository(() => db);
    repo = new AIRepository(() => db, (row) => emailRepo.rowToRecord(row));
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // ==========================================================================
  // The `|tag|` predicate must be EXACT. Categories are user-creatable, so
  // `invoice` and `invoices` (or `invoice_paid`) can genuinely coexist; a
  // substring match would leak one category's mail into the other's list and
  // double-count both chips.
  // ==========================================================================
  describe('exact slug matching (no prefix/suffix bleed)', () => {
    beforeEach(() => {
      repo.upsertCategoryDefinition({ slug: 'invoices', name: 'Invoices (plural)' });
      repo.upsertCategoryDefinition({ slug: 'nvoice', name: 'Suffix overlap' });
      insertEmail(db, { id: 'singular', tags: '|INBOX|invoice|', date: 300, aiProcessedAt: 1 });
      insertEmail(db, { id: 'plural', tags: '|INBOX|invoices|', date: 200, aiProcessedAt: 1 });
      insertEmail(db, { id: 'suffix', tags: '|INBOX|nvoice|', date: 100, aiProcessedAt: 1 });
    });

    it('getEmailsByDynamicCategory never matches a longer or shorter neighbouring slug', async () => {
      expect((await repo.getEmailsByDynamicCategory('invoice')).map((e) => e.id)).toEqual(['singular']);
      expect((await repo.getEmailsByDynamicCategory('invoices')).map((e) => e.id)).toEqual(['plural']);
      expect((await repo.getEmailsByDynamicCategory('nvoice')).map((e) => e.id)).toEqual(['suffix']);
    });

    it('getEmailsByCategory (legacy reader) is equally exact', async () => {
      expect((await repo.getEmailsByCategory('invoice')).map((e) => e.id)).toEqual(['singular']);
      expect((await repo.getEmailsByCategory('invoices')).map((e) => e.id)).toEqual(['plural']);
    });

    it('the chip counts stay one-per-category instead of summing the neighbours', () => {
      const counts = repo.getDynamicCategoryCounts();
      expect(counts.invoice).toBe(1);
      expect(counts.invoices).toBe(1);
      expect(counts.nvoice).toBe(1);
    });

    it('getEmailCategoriesBatch reports each email under its own slug only', () => {
      expect(repo.getEmailCategoriesBatch(['singular', 'plural', 'suffix'])).toEqual({
        singular: ['invoice'],
        plural: ['invoices'],
        suffix: ['nvoice'],
      });
    });

    // A slug that exists in no definition (or a tag fragment) must simply return
    // nothing — never a partial match against a folder tag such as `|INBOX|`.
    it('an unknown or fragmentary slug returns nothing', async () => {
      expect(await repo.getEmailsByDynamicCategory('invoic')).toEqual([]);
      expect(await repo.getEmailsByDynamicCategory('INBO')).toEqual([]);
      expect(repo.getDynamicCategoryCounts()['invoic']).toBeUndefined();
    });

    // Category slugs reach these queries as bound parameters, so quote/wildcard
    // characters are matched LITERALLY — instr() has no wildcards at all and the
    // value is never concatenated into SQL.
    it('treats quotes and LIKE wildcards in a slug as literal text', async () => {
      repo.upsertCategoryDefinition({ slug: "o'_%weird", name: 'Weird' });
      insertEmail(db, { id: 'weird', tags: "|INBOX|o'_%weird|", date: 400, aiProcessedAt: 1 });

      expect((await repo.getEmailsByDynamicCategory("o'_%weird")).map((e) => e.id)).toEqual(['weird']);
      expect(await repo.getEmailsByDynamicCategory('%')).toEqual([]);
      expect(await repo.getEmailsByDynamicCategory('_')).toEqual([]);
      expect(repo.getDynamicCategoryCounts()["o'_%weird"]).toBe(1);
      // the table survived the quote
      expect(db.prepare('SELECT COUNT(*) AS n FROM emails').get()).toEqual({ n: 4 });
    });
  });

  // ==========================================================================
  // Special-folder exclusion. A mail the user trashed (or that landed in Spam,
  // or their own Sent copy) must not keep inflating a category chip — that was
  // the visible bug where chips out-counted the INBOX badge.
  // ==========================================================================
  describe('special-folder exclusion', () => {
    const excluded = [
      'Trash', 'Spam', 'Drafts', 'Sent',
      '[Gmail]/Trash', '[Gmail]/Spam', '[Gmail]/Drafts', '[Gmail]/Sent Mail',
      'Junk', 'Junk Email', 'Deleted Items', 'Sent Items',
    ];

    beforeEach(() => {
      insertEmail(db, { id: 'live', tags: '|INBOX|invoice|', date: 900, aiProcessedAt: 1 });
      excluded.forEach((folderTag, i) => {
        insertEmail(db, {
          id: `x-${i}`,
          tags: `|${folderTag}|invoice|`,
          date: 800 - i,
          aiProcessedAt: 1,
        });
      });
    });

    it('hides every excluded folder from listings and from the chip count', async () => {
      expect((await repo.getEmailsByDynamicCategory('invoice', { limit: 100 })).map((e) => e.id)).toEqual(['live']);
      expect((await repo.getEmailsByCategory('invoice', { limit: 100 })).map((e) => e.id)).toEqual(['live']);
      expect(repo.getDynamicCategoryCounts().invoice).toBe(1);
      expect((await repo.getCategoryCounts()).invoice).toBe(1);
    });

    // An email that is BOTH in INBOX and in Trash (a label-style multi-folder
    // membership mid-move) is excluded: the exclusion is a hard veto, not a
    // "primary folder" test.
    it('a mail carrying both INBOX and Trash tags is excluded, not counted once', async () => {
      insertEmail(db, { id: 'both', tags: '|INBOX|Trash|invoice|', date: 950, aiProcessedAt: 1 });
      expect((await repo.getEmailsByDynamicCategory('invoice', { limit: 100 })).map((e) => e.id)).toEqual(['live']);
      expect(repo.getDynamicCategoryCounts().invoice).toBe(1);
    });
  });

  // ==========================================================================
  // getDynamicCategoryCounts serves TWO numbers, by `mode`: the DEFAULT 'unread'
  // is the CHIP badge (unread mails, message-level), and 'total' is the pager
  // "1–N of total" denominator (all mails). They are intentionally different.
  // ==========================================================================
  describe('getDynamicCategoryCounts', () => {
    beforeEach(() => {
      // thread t-a: 3 unread messages, all `invoice` → ONE unread thread
      insertEmail(db, { id: 'a1', threadId: 't-a', tags: '|INBOX|invoice|', date: 500, aiProcessedAt: 1 });
      insertEmail(db, { id: 'a2', threadId: 't-a', tags: '|INBOX|invoice|', date: 501, aiProcessedAt: 1 });
      insertEmail(db, { id: 'a3', threadId: 't-a', tags: '|INBOX|invoice|', date: 502, aiProcessedAt: 1 });
      // thread t-b: read → counts for nothing
      insertEmail(db, { id: 'b1', threadId: 't-b', tags: '|INBOX|invoice|read|', date: 503, aiProcessedAt: 1 });
      // thread t-c: unread and in TWO categories → +1 to both chips
      insertEmail(db, { id: 'c1', threadId: 't-c', tags: '|INBOX|invoice|meeting|', date: 504, aiProcessedAt: 1 });
      // thread t-d: unread, AI-processed, no category → uncategorized
      insertEmail(db, { id: 'd1', threadId: 't-d', tags: '|INBOX|', date: 505, aiProcessedAt: 1 });
      // thread t-e: unread, never AI-processed → NOT uncategorized (unknown, not empty)
      insertEmail(db, { id: 'e1', threadId: 't-e', tags: '|INBOX|', date: 506, aiProcessedAt: null });
      // thread t-f: spam → excluded from uncategorized
      insertEmail(db, { id: 'f1', threadId: 't-f', tags: '|INBOX|spam|', date: 507, aiProcessedAt: 1 });
      // thread t-g: unread invoice but in Trash → excluded everywhere
      insertEmail(db, { id: 'g1', threadId: 't-g', tags: '|Trash|invoice|', date: 508, aiProcessedAt: 1 });
    });

    // Message-level counts (a 3-reply thread contributes 3), so the 'total' mode
    // equals the message list the view pages over. One mail can add to two chips.
    it('default mode counts UNREAD mails per category (the chip badge)', () => {
      const counts = repo.getDynamicCategoryCounts(); // default: unread

      expect(counts.invoice).toBe(4);       // a1,a2,a3 + c1 unread; b1 read, g1 trashed
      expect(counts.meeting).toBe(1);       // c1
      expect(counts.important).toBe(0);
      expect(counts.uncategorized).toBe(1); // d1: unread, processed, no category, not spam/trashed
    });

    it("'total' mode counts ALL mails per category (the pager denominator)", () => {
      const counts = repo.getDynamicCategoryCounts(undefined, 'total');

      expect(counts.invoice).toBe(5);       // a1,a2,a3 + b1 (read) + c1; g1 trashed
      expect(counts.meeting).toBe(1);       // c1
      expect(counts.uncategorized).toBe(1); // d1 only
    });

    // Disabling a category removes its chip; its mail is ALSO excluded from the
    // uncategorized count (uncategorized excludes EVERY defined slug, enabled or
    // not) — the mail still lives in its folder, just not surfaced under any chip.
    it('disabling a category removes its chip and keeps it out of uncategorized', () => {
      repo.toggleCategoryDefinition('invoice', false);

      const counts = repo.getDynamicCategoryCounts();
      expect(counts.invoice).toBeUndefined();
      expect(Object.keys(counts)).not.toContain('invoice');
      // a1/a2/a3/c1 carry the (now-disabled but still DEFINED) `invoice` tag, so
      // they're excluded from uncategorized. Only d1 (no category) remains.
      expect(counts.uncategorized).toBe(1);
      expect(counts.meeting).toBe(1);
    });

    it('scopes every count to a folder when a folderId is given', () => {
      insertEmail(db, { id: 'arch', threadId: 't-arch', tags: '|Archive|invoice|', date: 600, aiProcessedAt: 1 });

      const inbox = repo.getDynamicCategoryCounts('f-inbox'); // unread
      expect(inbox.invoice).toBe(4);       // a1,a2,a3,c1 — the Archive copy is out of scope
      expect(inbox.uncategorized).toBe(1);
      expect(repo.getDynamicCategoryCounts('f-inbox', 'total').invoice).toBe(5); // total, in scope

      const archive = repo.getDynamicCategoryCounts('f-archive');
      expect(archive.invoice).toBe(1);     // arch (unread)
      expect(archive.meeting).toBe(0);
      expect(archive.uncategorized).toBe(0);
    });

    // Pinned deliberately: an unknown folderId silently drops the folder filter
    // (unlike getEmailsByDynamicCategory, which returns an empty list). The chips
    // then show mailbox-wide numbers next to an empty list.
    it('an unknown folderId falls back to mailbox-wide counts instead of zero', () => {
      expect(repo.getDynamicCategoryCounts('f-does-not-exist')).toEqual(repo.getDynamicCategoryCounts());
    });

    it('returns zero for every category on an empty mailbox', () => {
      db.prepare('DELETE FROM emails').run();
      const counts = repo.getDynamicCategoryCounts();
      expect(counts.uncategorized).toBe(0);
      expect(Object.values(counts).every((n) => n === 0)).toBe(true);
      expect(Object.keys(counts)).toHaveLength(8); // 7 seeded categories + uncategorized
    });
  });

  // ==========================================================================
  // getCategoryCounts — the LEGACY fixed-section counts. They count MESSAGES,
  // not threads, so they intentionally disagree with the chip numbers above; the
  // divergence is pinned so nobody "fixes" one side and quietly changes the other.
  // ==========================================================================
  describe('getCategoryCounts (legacy, per-message)', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'a1', threadId: 't-a', tags: '|INBOX|important|', date: 1, aiProcessedAt: 1 });
      insertEmail(db, { id: 'a2', threadId: 't-a', tags: '|INBOX|important|', date: 2, aiProcessedAt: 1 });
      insertEmail(db, { id: 'a3', threadId: 't-a', tags: '|INBOX|important|read|', date: 3, aiProcessedAt: 1 });
      insertEmail(db, { id: 'r1', threadId: 't-r', tags: '|INBOX|reminders|meeting|', date: 4, aiProcessedAt: 1 });
      insertEmail(db, { id: 'n1', threadId: 't-n', tags: '|INBOX|needs_response|', date: 5, aiProcessedAt: 1 });
      insertEmail(db, { id: 'w1', threadId: 't-w', tags: '|INBOX|waiting_reply|', date: 6, aiProcessedAt: 1 });
      insertEmail(db, { id: 'i1', threadId: 't-i', tags: '|Trash|invoice|', date: 7, aiProcessedAt: 1 });
    });

    it('counts unread MESSAGES per fixed section, excluding read and special folders', async () => {
      expect(await repo.getCategoryCounts()).toEqual({
        important: 2,      // a1 + a2 (a3 is read) — per message, NOT per thread
        reminders: 1,
        waitingReply: 1,   // legacy tag still counted even though the definition was removed
        needsResponse: 1,
        meeting: 1,
        invoice: 0,        // trashed
      });
    });

    // The legacy per-message counter and the chip (DEFAULT mode) both count UNREAD
    // messages, so they agree for a shared slug (a1, a2 — a3 is read). The chip's
    // 'total' mode is the separate number that counts EVERY message (the pager
    // denominator). Pinned so nobody collapses the chip's two modes into one.
    it('legacy and the chip agree on unread; the chip total counts every message', async () => {
      expect((await repo.getCategoryCounts()).important).toBe(2);              // unread: a1, a2
      expect(repo.getDynamicCategoryCounts().important).toBe(2);              // chip (unread) agrees
      expect(repo.getDynamicCategoryCounts(undefined, 'total').important).toBe(3); // total: a1, a2, a3
    });

    it('returns zeroes (not NULLs) for an empty mailbox', async () => {
      db.prepare('DELETE FROM emails').run();
      expect(await repo.getCategoryCounts()).toEqual({
        important: 0, reminders: 0, waitingReply: 0, needsResponse: 0, meeting: 0, invoice: 0,
      });
    });
  });

  // ==========================================================================
  // Category listings — ordering, paging and the folder filter. Paging that
  // repeats or skips a row makes mail look duplicated or lost in a chip view.
  // ==========================================================================
  describe('getEmailsByDynamicCategory', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'd1', tags: '|INBOX|invoice|', date: 100, aiProcessedAt: 1 });
      insertEmail(db, { id: 'd2', tags: '|INBOX|invoice|', date: 200, aiProcessedAt: 1 });
      insertEmail(db, { id: 'd3', tags: '|Archive|invoice|', date: 300, folderId: 'f-archive', aiProcessedAt: 1 });
    });

    it('returns newest-first and pages without overlap or gaps', async () => {
      expect((await repo.getEmailsByDynamicCategory('invoice')).map((e) => e.id)).toEqual(['d3', 'd2', 'd1']);

      const page1 = await repo.getEmailsByDynamicCategory('invoice', { limit: 2 });
      const page2 = await repo.getEmailsByDynamicCategory('invoice', { limit: 2, offset: 2 });
      expect(page1.map((e) => e.id)).toEqual(['d3', 'd2']);
      expect(page2.map((e) => e.id)).toEqual(['d1']);
      expect(page1.map((e) => e.id)).not.toContain('d1');
    });

    it('restricts to a folder by its path tag, and returns nothing for an unknown folder', async () => {
      expect((await repo.getEmailsByDynamicCategory('invoice', { folderId: 'f-inbox' })).map((e) => e.id))
        .toEqual(['d2', 'd1']);
      expect(await repo.getEmailsByDynamicCategory('invoice', { folderId: 'f-nope' })).toEqual([]);
    });

    it('maps rows through the shared EmailRecord mapper (tags decoded, body present)', async () => {
      const [newest] = await repo.getEmailsByDynamicCategory('invoice', { limit: 1 });
      expect(newest).toMatchObject({ id: 'd3', threadId: 't-d3', folderId: 'f-archive', hasBody: true });
      expect(newest.labels).toContain('invoice');
    });
  });

  // ==========================================================================
  // The `uncategorized` pseudo-category: AI-processed mail that came back with NO
  // category. It must exclude spam and every real category tag, or the user sees
  // the same mail in two places.
  // ==========================================================================
  describe('getEmailsByDynamicCategory("uncategorized")', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'u1', tags: '|INBOX|', date: 100, aiProcessedAt: 1 });          // uncategorized
      insertEmail(db, { id: 'u2', tags: '|Archive|', date: 200, aiProcessedAt: 1 });        // uncategorized, other folder
      insertEmail(db, { id: 'cat', tags: '|INBOX|meeting|', date: 300, aiProcessedAt: 1 }); // has a category
      insertEmail(db, { id: 'spam', tags: '|INBOX|spam|', date: 400, aiProcessedAt: 1 });   // spam
      insertEmail(db, { id: 'raw', tags: '|INBOX|', date: 500, aiProcessedAt: null });      // never processed
      insertEmail(db, { id: 'trashed', tags: '|Trash|', date: 600, aiProcessedAt: 1 });     // special folder
    });

    it('lists only processed, non-spam, category-less mail outside special folders', async () => {
      expect((await repo.getEmailsByDynamicCategory('uncategorized', { limit: 100 })).map((e) => e.id))
        .toEqual(['u2', 'u1']);
    });

    it('honours the folder filter and pages like any other category', async () => {
      expect((await repo.getEmailsByDynamicCategory('uncategorized', { folderId: 'f-inbox' })).map((e) => e.id))
        .toEqual(['u1']);
      expect((await repo.getEmailsByDynamicCategory('uncategorized', { limit: 1 })).map((e) => e.id))
        .toEqual(['u2']);
      expect(await repo.getEmailsByDynamicCategory('uncategorized', { folderId: 'f-missing' })).toEqual([]);
    });

    // Disabling a category excludes its mail from BOTH the uncategorized LIST and
    // the uncategorized COUNT — they stay in lockstep (single source of truth).
    // The mail still lives in its folder; it's just not surfaced under any AI chip.
    // (Previously the COUNT excluded only ENABLED slugs, so a disabled category's
    // mail inflated the uncategorized chip above its list — the exact chip != list
    // divergence we now forbid.)
    it('excludes disabled categories from BOTH the uncategorized list and count', async () => {
      repo.toggleCategoryDefinition('meeting', false);

      expect((await repo.getEmailsByDynamicCategory('uncategorized', { limit: 100 })).map((e) => e.id))
        .toEqual(['u2', 'u1']);
      // `cat` (disabled `meeting`) is excluded from the count too, matching the list.
      expect(repo.getDynamicCategoryCounts().uncategorized).toBe(2); // u1, u2
    });
  });

  describe('getEmailsByCategory (legacy reader)', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'c1', tags: '|INBOX|meeting|', date: 100, aiProcessedAt: 1 });
      insertEmail(db, { id: 'c2', tags: '|INBOX|meeting|read|', date: 200, aiProcessedAt: 1 });
      insertEmail(db, { id: 'c3', tags: '|Sent|meeting|', date: 300, aiProcessedAt: 1 });
    });

    // Unlike the counts, the LISTING includes read mail — the section shows the
    // whole category, the badge only the unread part.
    it('lists read and unread mail newest-first, excluding special folders, and pages', async () => {
      expect((await repo.getEmailsByCategory('meeting')).map((e) => e.id)).toEqual(['c2', 'c1']);
      expect((await repo.getEmailsByCategory('meeting', { limit: 1 })).map((e) => e.id)).toEqual(['c2']);
      expect((await repo.getEmailsByCategory('meeting', { limit: 1, offset: 1 })).map((e) => e.id)).toEqual(['c1']);
      expect(await repo.getEmailsByCategory('nothing-here')).toEqual([]);
    });
  });

  // ==========================================================================
  // getEmailCategoriesBatch — powers the per-row category pills. It must return
  // ONLY defined category slugs, never folder names or flags, or the list would
  // render "INBOX" and "read" as AI categories.
  // ==========================================================================
  describe('getEmailCategoriesBatch', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'e1', tags: '|INBOX|read|starred|invoice|meeting|', date: 1, aiProcessedAt: 1 });
      insertEmail(db, { id: 'e2', tags: '|INBOX|', date: 2, aiProcessedAt: 1 });
    });

    it('filters tags down to known category slugs and keeps folder/flag tags out', () => {
      expect(repo.getEmailCategoriesBatch(['e1', 'e2'])).toEqual({
        e1: ['invoice', 'meeting'],
        e2: [],
      });
    });

    it('returns an empty map for an empty id list and omits unknown ids', () => {
      expect(repo.getEmailCategoriesBatch([])).toEqual({});
      expect(repo.getEmailCategoriesBatch(['ghost'])).toEqual({});
      expect(repo.getEmailCategoriesBatch(['ghost', 'e2'])).toEqual({ e2: [] });
    });

    // A tag left over from a deleted category definition must stop being shown as
    // a category — the pill would otherwise reference a category that no longer
    // exists anywhere in the UI.
    it('drops tags whose category definition no longer exists', () => {
      repo.upsertCategoryDefinition({ slug: 'temporary', name: 'Temporary' });
      db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|temporary|', 'e2');
      expect(repo.getEmailCategoriesBatch(['e2'])).toEqual({ e2: ['temporary'] });

      repo.deleteCategoryDefinition('temporary');
      expect(repo.getEmailCategoriesBatch(['e2'])).toEqual({ e2: [] });
    });
  });
});
