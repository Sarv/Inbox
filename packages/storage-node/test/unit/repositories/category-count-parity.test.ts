import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { AIRepository } from '../../../src/repositories/ai-repository';
import { openTestDb } from '../../../src/test-support/test-db';

// A category surfaces TWO deliberately different numbers, both from
// getDynamicCategoryCounts:
//   - CHIP badge  = getDynamicCategoryCounts(folderId)            → UNREAD threads.
//   - Pager "of N"= getDynamicCategoryCounts(folderId, 'total')  → ALL threads.
// The category list hydrates matching messages from a page of threads:
//   1. 'total' == the number of conversations the list pages over.
//   2. 'unread' == conversations with matching unread mail.
//   3. deleting the visible page drops BOTH correctly and the next page slides up.
// chip (unread) and pager (total) are intentionally distinct — never reconciled.

function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL);
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, thread_id TEXT, tags TEXT NOT NULL DEFAULT '||',
      date INTEGER NOT NULL DEFAULT 0, ai_processed_at INTEGER,
      -- Emptied since migration 73 but still the COALESCE fallback every body
      -- read names, so the columns have to exist even where no test sets them.
      clean_body TEXT NOT NULL DEFAULT '', raw_body TEXT NOT NULL DEFAULT ''
    );
    -- Where bodies live since migration 73; the has-body clause COALESCEs
    -- through it, so it has to exist even in this header-only fixture.
    CREATE TABLE email_bodies (email_id TEXT PRIMARY KEY, clean_body TEXT, raw_body TEXT);
    CREATE TABLE ai_category_definitions (slug TEXT PRIMARY KEY, is_enabled INTEGER NOT NULL DEFAULT 1);
    INSERT INTO folders (id, path) VALUES
      ('f-inbox','INBOX'), ('f-inv','Sarv Inbox/Invoices'), ('f-trash','Trash'), ('f-spam','Spam');
    INSERT INTO ai_category_definitions (slug, is_enabled) VALUES
      ('promotions', 1), ('finance', 1), ('social', 0);
  `);
  return db;
}

let dateSeq = 1000;
function add(db: Database.Database, id: string, tags: string, opts: { aiProcessed?: boolean; threadId?: string | null } = {}): void {
  const aiProcessed = opts.aiProcessed !== false;
  db.prepare('INSERT INTO emails (id, thread_id, tags, date, ai_processed_at) VALUES (?,?,?,?,?)')
    .run(id, opts.threadId === undefined ? `t-${id}` : opts.threadId, `|${tags}|`, dateSeq++, aiProcessed ? 1 : null);
}
/** Mark a mail read the same way the app does — append the `read` tag token. */
function markRead(db: Database.Database, id: string): void {
  db.prepare("UPDATE emails SET tags = tags || 'read|' WHERE id = ? AND instr(tags, '|read|') = 0").run(id);
}

async function collectAll(repo: AIRepository, slug: string, folderId: string | undefined, pageSize: number): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await repo.getEmailsByDynamicCategory(slug, { limit: pageSize, offset, folderId });
    ids.push(...rows.map((r: any) => r.id));
    if (rows.length < pageSize) break;
  }
  return ids;
}

describe('category counters — total (pager) vs unread (chip)', () => {
  let db: Database.Database;
  let repo: AIRepository;

  beforeEach(() => {
    db = newDb();
    dateSeq = 1000;
    repo = new AIRepository(() => db, (row: any) => row);

    // promotions in INBOX: p1 read, p2/p3/p4 unread (p3 also carries a disabled cat)
    add(db, 'p1', 'INBOX|promotions|read');
    add(db, 'p2', 'INBOX|promotions');
    add(db, 'p3', 'INBOX|promotions|social');
    add(db, 'p4', 'INBOX|promotions');
    add(db, 'p5', 'Sarv Inbox/Invoices|promotions'); // off-INBOX (unified/unscoped only)
    add(db, 'x1', 'Trash|promotions');               // special folder → excluded everywhere
    add(db, 'x2', 'Spam|finance');                   // special folder → excluded everywhere
    // finance: f1 read, f2 unread
    add(db, 'f1', 'INBOX|finance|read');
    add(db, 'f2', 'INBOX|finance');
    // uncategorized: u1 unread, u2 read
    add(db, 'u1', 'INBOX');
    add(db, 'u2', 'INBOX|read');
    add(db, 's1', 'INBOX|spam');                    // AI-spam tag → not uncategorized
    add(db, 'n1', 'INBOX', { aiProcessed: false }); // never processed → still uncategorized
    add(db, 'd1', 'INBOX|social');                  // disabled category → not uncategorized
  });

  const pageSizes = [1, 2, 3, 50];

  it("'total' equals the full list length for every category (pager can't overrun)", async () => {
    const total = repo.getDynamicCategoryCounts(undefined, 'total');
    for (const slug of ['promotions', 'finance']) {
      for (const ps of pageSizes) {
        const ids = await collectAll(repo, slug, undefined, ps);
        expect(new Set(ids).size).toBe(ids.length); // no dup rows across pages
        expect(ids.length).toBe(total[slug]);
      }
    }
  });

  it("'total' equals the list length when scoped to INBOX, and for uncategorized", async () => {
    const total = repo.getDynamicCategoryCounts('f-inbox', 'total');
    for (const ps of pageSizes) {
      expect((await collectAll(repo, 'promotions', 'f-inbox', ps)).length).toBe(total.promotions);
      expect((await collectAll(repo, 'uncategorized', 'f-inbox', ps)).length).toBe(total.uncategorized);
    }
  });

  it('hard-coded totals (read + unread, special folders excluded)', () => {
    const t = repo.getDynamicCategoryCounts(undefined, 'total');
    expect(t.promotions).toBe(5);   // p1..p4 + p5 (Invoices); x1 trashed
    expect(t.finance).toBe(2);      // f1, f2; x2 in Spam excluded
    expect(t.uncategorized).toBe(3); // u1, u2, n1

    const ti = repo.getDynamicCategoryCounts('f-inbox', 'total');
    expect(ti.promotions).toBe(4);  // INBOX drops p5
    expect(ti.finance).toBe(2);
    expect(ti.uncategorized).toBe(3);
  });

  it('the chip (default mode) counts UNREAD mails — a strict subset of total', () => {
    const u = repo.getDynamicCategoryCounts(); // default: unread
    expect(u.promotions).toBe(4);   // p2,p3,p4 (INBOX) + p5; p1 read
    expect(u.finance).toBe(1);      // f2; f1 read
    expect(u.uncategorized).toBe(2); // u1, n1; u2 read

    const ui = repo.getDynamicCategoryCounts('f-inbox'); // unread, INBOX-scoped
    expect(ui.promotions).toBe(3);  // p2,p3,p4
    expect(ui.finance).toBe(1);
    expect(ui.uncategorized).toBe(2);

    // unread can never exceed total for any category
    const ti = repo.getDynamicCategoryCounts('f-inbox', 'total');
    for (const k of Object.keys(ti)) expect(ui[k]).toBeLessThanOrEqual(ti[k]);
  });

  it('reading a mail drops the chip (unread) but NOT the pager (total)', () => {
    expect(repo.getDynamicCategoryCounts('f-inbox').promotions).toBe(3);
    markRead(db, 'p2');
    expect(repo.getDynamicCategoryCounts('f-inbox').promotions).toBe(2);            // unread 3 → 2
    expect(repo.getDynamicCategoryCounts('f-inbox', 'total').promotions).toBe(4);   // total unchanged
  });

  it('deleting the visible page drops BOTH counters and slides the next page up', async () => {
    // INBOX promotions: total 4 (p1..p4), unread 3 (p2,p3,p4). Newest-first: p4,p3,p2,p1.
    const beforeTotal = repo.getDynamicCategoryCounts('f-inbox', 'total').promotions;   // 4
    const beforeUnread = repo.getDynamicCategoryCounts('f-inbox').promotions;           // 3

    const firstPage = await repo.getEmailsByDynamicCategory('promotions', { limit: 2, offset: 0, folderId: 'f-inbox' });
    const removed = firstPage.map((r: any) => r.id); // p4, p3 — both unread
    db.prepare(`DELETE FROM emails WHERE id IN (${removed.map(() => '?').join(',')})`).run(...removed);

    const afterTotal = repo.getDynamicCategoryCounts('f-inbox', 'total').promotions;
    const afterUnread = repo.getDynamicCategoryCounts('f-inbox').promotions;
    expect(afterTotal).toBe(beforeTotal - 2);   // 4 → 2
    expect(afterUnread).toBe(beforeUnread - 2); // both deleted were unread: 3 → 1

    const nextPage = await collectAll(repo, 'promotions', 'f-inbox', 2);
    expect(nextPage.length).toBe(afterTotal);       // the following rows slid up
    expect(nextPage).not.toContain(removed[0]);     // deleted rows are gone
  });

  it('pages 33 matching messages as 31 conversations, with 25 visible threads then six', async () => {
    db.prepare('DELETE FROM emails').run();
    for (let i = 1; i <= 31; i++) add(db, `m${i}`, 'INBOX|promotions');
    add(db, 'reply31', 'INBOX|promotions', { threadId: 't-m31' });
    add(db, 'reply30', 'INBOX|promotions', { threadId: 't-m30' });
    // These newer copies cannot affect category order, page membership or totals.
    add(db, 'trashed31', 'Trash|promotions', { threadId: 't-m31' });
    add(db, 'other-category31', 'INBOX|finance', { threadId: 't-m31' });

    const first = await repo.getEmailsByDynamicCategory('promotions', { folderId: 'f-inbox', limit: 25 });
    const second = await repo.getEmailsByDynamicCategory('promotions', { folderId: 'f-inbox', limit: 25, offset: 25 });
    const threadIds = (rows: any[]) => new Set(rows.map(row => row.thread_id ?? row.id));
    expect(threadIds(first).size).toBe(25);
    expect(first).toHaveLength(27); // matching members retained for row aggregation
    expect(threadIds(second).size).toBe(6);
    expect(second).toHaveLength(6);
    for (const tid of threadIds(first)) expect(threadIds(second).has(tid)).toBe(false);
    expect(first.map(row => row.id)).not.toContain('trashed31');
    expect(first.map(row => row.id)).not.toContain('other-category31');
    expect(repo.getDynamicCategoryCounts('f-inbox').promotions).toBe(31);
    expect(repo.getDynamicCategoryCounts('f-inbox', 'total').promotions).toBe(31);
  });

  it('counts an unread thread once until its last unread category member is read', () => {
    add(db, 'reply4', 'INBOX|promotions', { threadId: 't-p4' });
    expect(repo.getDynamicCategoryCounts('f-inbox').promotions).toBe(3);
    markRead(db, 'p4');
    expect(repo.getDynamicCategoryCounts('f-inbox').promotions).toBe(3);
    markRead(db, 'reply4');
    expect(repo.getDynamicCategoryCounts('f-inbox').promotions).toBe(2);
    expect(repo.getDynamicCategoryCounts('f-inbox', 'total').promotions).toBe(4);
  });

  it('uses the same thread key for uncategorized pages, including standalone messages', async () => {
    db.prepare('DELETE FROM emails').run();
    add(db, 'u1', 'INBOX');
    add(db, 'u1-reply', 'INBOX', { threadId: 't-u1' });
    add(db, 'solo1', 'INBOX', { threadId: null });
    add(db, 'solo2', 'INBOX', { threadId: null });
    const first = await repo.getEmailsByDynamicCategory('uncategorized', { limit: 2 });
    const second = await repo.getEmailsByDynamicCategory('uncategorized', { limit: 2, offset: 2 });
    expect(first.map(row => row.id)).toEqual(['solo2', 'solo1']);
    expect(second.map(row => row.id)).toEqual(['u1-reply', 'u1']);
    expect(repo.getDynamicCategoryCounts().uncategorized).toBe(3);
    expect(repo.getDynamicCategoryCounts(undefined, 'total').uncategorized).toBe(3);
  });
});
