// AIRepository — everything that WRITES (categories on tags, category
// definitions, spammers, thread summaries, conversation extractions, the
// parse-failure/eligibility pipeline).
//
// Runs against the REAL production schema (schema.sql + every migration), so the
// seeded category definitions, the spammers unique index and the AI columns are
// the same ones the app ships. A dropped column or a lost seed row fails here
// instead of only in the running app.
//
// Read-side counting lives in ai-repository-counts.test.ts.

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newMigratedDb } from '../../../src/test-support/test-db';

import { AIRepository } from '../../../src/repositories/ai-repository';
import { EmailRepository } from '../../../src/repositories/email-repository';

/** 2026-08-18T12:00:00Z — every timestamp the repo stamps itself is derived
 *  from this, so ids like `spam-<ms>` and `processedAt` defaults are stable. */
const FIXED_NOW_MS = Date.UTC(2026, 7, 18, 12, 0, 0);
const FIXED_NOW_S = Math.floor(FIXED_NOW_MS / 1000);

type EmailSeed = {
  id: string;
  tags?: string;
  date?: number;
  threadId?: string;
  folderId?: string;
  cleanBody?: string;
  rawBody?: string;
  aiProcessedAt?: number | null;
};

function insertEmail(db: Database.Database, seed: EmailSeed): void {
  const threadId = seed.threadId ?? `t-${seed.id}`;
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(threadId, `subject ${threadId}`, `<${seed.id}@x>`, `<${seed.id}@x>`, seed.date ?? FIXED_NOW_S);

  db.prepare(
    `INSERT INTO emails (
       id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
       clean_body, raw_body, clean_body_len, raw_body_len,
       content_type, content_hash, ai_processed_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?,
               LENGTH(TRIM(?)), LENGTH(TRIM(?)), 'text', ?, ?)`,
  ).run(
    seed.id,
    `<${seed.id}@x>`,
    threadId,
    seed.folderId ?? 'f-inbox',
    seed.tags ?? '|INBOX|',
    `subject ${seed.id}`,
    'sender@example.com',
    seed.date ?? FIXED_NOW_S,
    seed.cleanBody ?? 'body text',
    seed.rawBody ?? 'raw body text',
    // Lengths written from the bodies in SQL, as every production writer does:
    // the eligibility filter reads these on a migrated DB, so seeding them NULL
    // would make every row here look body-less.
    seed.cleanBody ?? 'body text',
    seed.rawBody ?? 'raw body text',
    `hash-${seed.id}`,
    seed.aiProcessedAt ?? null,
  );
}

const tagsOf = (db: Database.Database, id: string): string =>
  (db.prepare('SELECT tags FROM emails WHERE id = ?').get(id) as { tags: string }).tags;

const emailRow = (db: Database.Database, id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as Record<string, unknown>;

const slugsOf = (db: Database.Database): string[] =>
  (db.prepare('SELECT slug FROM ai_category_definitions ORDER BY slug').all() as { slug: string }[])
    .map((r) => r.slug);

describe('AIRepository', () => {
  let db: Database.Database;
  let repo: AIRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    db = newMigratedDb();
    db.pragma('foreign_keys = ON'); // production runs with FKs on
    db.prepare('INSERT INTO folders (id, name, path) VALUES (?, ?, ?)').run('f-inbox', 'INBOX', 'INBOX');
    db.prepare('INSERT INTO folders (id, name, path) VALUES (?, ?, ?)').run('f-trash', 'Trash', 'Trash');
    const emailRepo = new EmailRepository(() => db);
    repo = new AIRepository(() => db, (row) => emailRepo.rowToRecord(row));
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // ==========================================================================
  // Category definitions — the seed rows ARE the product's category taxonomy.
  // If a migration drops one, the app silently stops offering that category and
  // every already-applied tag becomes "uncategorized". Pin the shipped set.
  // ==========================================================================
  describe('category definitions', () => {
    it('ships the seeded system categories, all enabled, ordered by sort_order', () => {
      const defs = repo.getCategoryDefinitions();

      // Exact set on purpose: adding/removing a category is a product decision
      // that must be made deliberately (update this list with the migration).
      expect(defs.map((d) => d.slug)).toEqual([
        'important', 'needs_response', 'reminders', 'meeting', 'invoice', 'finance', 'promotions',
      ]);
      expect(defs.every((d) => d.isSystem)).toBe(true);
      expect(defs.every((d) => d.isEnabled)).toBe(true);
      expect(defs.every((d) => d.prompt.length > 0)).toBe(true);
      expect(repo.getEnabledCategoryDefinitions().map((d) => d.slug)).toEqual(defs.map((d) => d.slug));
    });

    it('inserts a new definition with the documented defaults and round-trips NULL description', () => {
      repo.upsertCategoryDefinition({ slug: 'travel' });

      const def = repo.getCategoryDefinitions().find((d) => d.slug === 'travel');
      expect(def).toMatchObject({
        slug: 'travel',
        name: 'travel',     // name falls back to the slug
        description: null,  // real SQL NULL, not the string "null"
        prompt: '',
        icon: 'Tag',
        color: 'blue',
        sortOrder: 0,
        isSystem: false,
        isEnabled: true,
      });
      expect(def!.description).toBeNull();
    });

    // A second upsert of the same slug must MERGE. If it inserted a duplicate
    // row the sidebar would render the category twice and instr(tags,'|slug|')
    // would count it twice.
    it('upserting an existing slug updates in place instead of duplicating', () => {
      repo.upsertCategoryDefinition({ slug: 'travel', name: 'Travel', color: 'blue' });
      repo.upsertCategoryDefinition({ slug: 'travel', name: 'Trips', color: 'red', sortOrder: 9, isEnabled: false });

      const rows = repo.getCategoryDefinitions().filter((d) => d.slug === 'travel');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'Trips', color: 'red', sortOrder: 9, isEnabled: false });
    });

    // is_system is deliberately NOT in the ON CONFLICT update list: a user (or a
    // renderer round-trip that forgot the flag) must not be able to turn a system
    // category into a deletable one, because deleting it would orphan its tags.
    it('cannot flip a system category to non-system through upsert', () => {
      repo.upsertCategoryDefinition({ slug: 'invoice', name: 'Invoice', isSystem: false });

      const def = repo.getCategoryDefinitions().find((d) => d.slug === 'invoice')!;
      expect(def.isSystem).toBe(true);
      expect(repo.deleteCategoryDefinition('invoice')).toBe(false);
      expect(slugsOf(db)).toContain('invoice');
    });

    // Documents a sharp edge: the upsert overwrites prompt/description from the
    // payload, so a PARTIAL upsert wipes the seeded LLM prompt. Callers must
    // always send the full definition.
    it('a partial upsert of a system category resets its prompt and description', () => {
      const before = repo.getCategoryDefinitions().find((d) => d.slug === 'meeting')!;
      expect(before.prompt.length).toBeGreaterThan(0);

      repo.upsertCategoryDefinition({ slug: 'meeting', name: 'Meeting' });

      const after = repo.getCategoryDefinitions().find((d) => d.slug === 'meeting')!;
      expect(after.prompt).toBe('');
      expect(after.description).toBeNull();
    });

    // Slugs are the tag text written into emails.tags, so a case/whitespace
    // variant creates a SECOND, separate category whose tag never matches the
    // first. Nothing normalises them today — pinned so a future normalisation
    // step is a conscious change.
    it('does not normalise slug case or whitespace — variants become separate rows', () => {
      repo.upsertCategoryDefinition({ slug: 'Travel', name: 'Travel upper' });
      repo.upsertCategoryDefinition({ slug: ' travel ', name: 'Travel padded' });

      const all = slugsOf(db);
      expect(all).toContain('Travel');
      expect(all).toContain(' travel ');
      expect(all.filter((s) => s.trim().toLowerCase() === 'travel')).toHaveLength(2);
    });

    it('deletes a user category, refuses a system one, and reports unknown slugs as not deleted', () => {
      repo.upsertCategoryDefinition({ slug: 'travel', name: 'Travel' });

      expect(repo.deleteCategoryDefinition('travel')).toBe(true);
      expect(slugsOf(db)).not.toContain('travel');
      expect(repo.deleteCategoryDefinition('important')).toBe(false);
      expect(repo.deleteCategoryDefinition('does-not-exist')).toBe(false);
    });

    it('toggling a definition off hides it from the enabled list but keeps the row', () => {
      repo.toggleCategoryDefinition('finance', false);

      expect(repo.getEnabledCategoryDefinitions().map((d) => d.slug)).not.toContain('finance');
      expect(repo.getCategoryDefinitions().map((d) => d.slug)).toContain('finance');

      repo.toggleCategoryDefinition('finance', true);
      expect(repo.getEnabledCategoryDefinitions().map((d) => d.slug)).toContain('finance');
    });

    // A definition inserted WITH is_system=1 (the migration/bootstrap path) must
    // be protected from deletion the same way the seeded ones are, otherwise a
    // future built-in category could be removed by the settings UI and leave its
    // tags orphaned on every email.
    it('a definition upserted as a system category cannot be deleted', () => {
      repo.upsertCategoryDefinition({ slug: 'builtin', name: 'Built in', isSystem: true });

      expect(repo.getCategoryDefinitions().find((d) => d.slug === 'builtin')!.isSystem).toBe(true);
      expect(repo.deleteCategoryDefinition('builtin')).toBe(false);
      expect(slugsOf(db)).toContain('builtin');
    });

    it('toggling an unknown slug is a silent no-op', () => {
      expect(() => repo.toggleCategoryDefinition('nope', false)).not.toThrow();
      expect(repo.getCategoryDefinitions()).toHaveLength(7);
    });
  });

  // ==========================================================================
  // saveEmailCategories — the single-email write path. Categories live in the
  // tags column alongside FOLDER and FLAG tags, so a sloppy rewrite here can
  // drop an email out of its folder or mark it unread: real data loss.
  // ==========================================================================
  describe('saveEmailCategories', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'e1', tags: '|INBOX|read|starred|' });
    });

    it('adds the category tags while preserving folder and flag tags', () => {
      repo.saveEmailCategories('e1', [{ slug: 'invoice', confidence: 0.9 }], false, 'looks like a bill', 1700000000, 0.9);

      const tags = tagsOf(db, 'e1');
      expect(tags).toContain('|INBOX|');
      expect(tags).toContain('|read|');
      expect(tags).toContain('|starred|');
      expect(tags).toContain('|invoice|');

      const row = emailRow(db, 'e1');
      expect(row.ai_reasoning).toBe('looks like a bill');
      expect(row.ai_confidence).toBe(0.9);
      expect(row.ai_processed_at).toBe(1700000000);
    });

    // Re-categorizing must REPLACE, not accumulate: otherwise an email the LLM
    // reclassified stays in its old category chip forever.
    it('re-categorizing removes the previously assigned category tags', () => {
      repo.saveEmailCategories('e1', [{ slug: 'invoice', confidence: 1 }], false, '', 1, 1);
      repo.saveEmailCategories('e1', [{ slug: 'meeting', confidence: 1 }], false, '', 2, 1);

      const tags = tagsOf(db, 'e1');
      expect(tags).toContain('|meeting|');
      expect(tags).not.toContain('|invoice|');
      expect(tags).toContain('|INBOX|');
    });

    it('sets and later clears the spam tag, and stores empty reasoning as NULL', () => {
      repo.saveEmailCategories('e1', [], true, '', 10, 0.5);
      expect(tagsOf(db, 'e1')).toContain('|spam|');
      expect(emailRow(db, 'e1').ai_reasoning).toBeNull();

      repo.saveEmailCategories('e1', [{ slug: 'important', confidence: 1 }], false, 'ok', 11, 1);
      expect(tagsOf(db, 'e1')).not.toContain('|spam|');
    });

    it('is a silent no-op for an unknown email id', () => {
      expect(() => repo.saveEmailCategories('missing', [{ slug: 'invoice', confidence: 1 }], false, 'x', 1, 1)).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS n FROM emails').get()).toEqual({ n: 1 });
    });

    // The single-email path (used by interactive re-categorization) does NOT
    // stamp label_status, unlike the batch path. Pinning the difference keeps the
    // "categories mirrored to the provider" gap visible.
    it('leaves label_status untouched (only the batch path queues a label mirror)', () => {
      repo.saveEmailCategories('e1', [{ slug: 'invoice', confidence: 1 }], false, '', 1, 1);
      expect(emailRow(db, 'e1').label_status).toBeNull();
    });
  });

  // ==========================================================================
  // saveEmailCategoriesBatch — the bulk path. It must be all-or-nothing: a
  // half-applied batch leaves emails categorized but NOT marked done, so the
  // next poll re-sends them to the LLM (double spend) or loses categories.
  // ==========================================================================
  describe('saveEmailCategoriesBatch', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'e1', tags: '|INBOX|' });
      insertEmail(db, { id: 'e2', tags: '|INBOX|invoice|' });
    });

    it('writes every item and returns the number of rows changed', () => {
      const updated = repo.saveEmailCategoriesBatch([
        { emailId: 'e1', categories: [{ slug: 'meeting', confidence: 0.8 }], isSpam: false, reasoning: 'invite', processedAt: 500, confidence: 0.8 },
        { emailId: 'e2', categories: [{ slug: 'finance', confidence: 0.7 }], isSpam: false, reasoning: '', processedAt: 600, confidence: 0.7 },
      ]);

      expect(updated).toBe(2);
      expect(tagsOf(db, 'e1')).toContain('|meeting|');
      // e2's stale `invoice` tag is replaced, not accumulated
      expect(tagsOf(db, 'e2')).toContain('|finance|');
      expect(tagsOf(db, 'e2')).not.toContain('|invoice|');
    });

    // agent_status='done' stops the unified pipeline re-sending these to the LLM
    // within 30s; label_status='pending' is what makes the category actually
    // appear as a label in Gmail/IMAP.
    it('stamps agent_status=done, agent_at and label_status=pending for the mirror drain', () => {
      repo.saveEmailCategoriesBatch([
        { emailId: 'e1', categories: [{ slug: 'meeting', confidence: 1 }], isSpam: false, reasoning: '', processedAt: 777, confidence: 1 },
      ]);

      expect(emailRow(db, 'e1')).toMatchObject({
        agent_status: 'done',
        agent_at: 777,
        label_status: 'pending',
        ai_processed_at: 777,
      });
    });

    it('skips unknown ids without failing the rest of the batch', () => {
      const updated = repo.saveEmailCategoriesBatch([
        { emailId: 'ghost', categories: [{ slug: 'meeting', confidence: 1 }], isSpam: false, reasoning: '', processedAt: 1, confidence: 1 },
        { emailId: 'e1', categories: [{ slug: 'meeting', confidence: 1 }], isSpam: false, reasoning: '', processedAt: 1, confidence: 1 },
      ]);

      expect(updated).toBe(1);
      expect(tagsOf(db, 'e1')).toContain('|meeting|');
    });

    it('an empty batch is a no-op that changes nothing', () => {
      const before = db.prepare('SELECT id, tags, ai_processed_at FROM emails ORDER BY id').all();
      expect(repo.saveEmailCategoriesBatch([])).toBe(0);
      expect(db.prepare('SELECT id, tags, ai_processed_at FROM emails ORDER BY id').all()).toEqual(before);
    });

    // The whole point of the transaction: one bad item must not leave the
    // earlier items half-written, because their agent_status='done' stamp would
    // then be missing while their tags were already rewritten (or vice versa).
    it('rolls the WHOLE batch back when one item fails, and rethrows', () => {
      const bad = { processedAt: {} as unknown as number };

      expect(() =>
        repo.saveEmailCategoriesBatch([
          { emailId: 'e1', categories: [{ slug: 'meeting', confidence: 1 }], isSpam: false, reasoning: '', processedAt: 1, confidence: 1 },
          { emailId: 'e2', categories: [{ slug: 'finance', confidence: 1 }], isSpam: false, reasoning: '', confidence: 1, ...bad },
        ]),
      ).toThrow();

      // NO partial write: e1 never got its category, its done-stamp, or its
      // pending label.
      expect(tagsOf(db, 'e1')).toBe('|INBOX|');
      expect(emailRow(db, 'e1')).toMatchObject({ ai_processed_at: null, label_status: null });
      expect(tagsOf(db, 'e2')).toBe('|INBOX|invoice|');
    });
  });

  // ==========================================================================
  // Rows whose tags column is an EMPTY STRING instead of the '||' sentinel (an
  // old row, or any writer that forgot the pipes). Every tag query is
  // instr(tags, '|slug|'), so if the writers appended to '' the result would be
  // `invoice|` — unanchored and permanently invisible to every category query.
  // ==========================================================================
  describe('rows with an empty tags string', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'e1', tags: '|INBOX|' });
      db.prepare("UPDATE emails SET tags = '' WHERE id = 'e1'").run();
    });

    it('saveEmailCategories rebuilds a properly pipe-anchored tag string', () => {
      repo.saveEmailCategories('e1', [{ slug: 'invoice', confidence: 1 }], false, '', 1, 1);
      expect(tagsOf(db, 'e1')).toBe('|invoice|');
    });

    it('the batch writer anchors the tags the same way', () => {
      repo.saveEmailCategoriesBatch([
        { emailId: 'e1', categories: [{ slug: 'meeting', confidence: 1 }], isSpam: true, reasoning: '', processedAt: 1, confidence: 1 },
      ]);
      expect(tagsOf(db, 'e1')).toBe('|meeting|spam|');
    });

    it('getCategory reads it as "no categories" and removeCategory normalises it', async () => {
      db.prepare('UPDATE emails SET ai_processed_at = 5 WHERE id = ?').run('e1');

      const cat = (await repo.getCategory('e1'))!;
      expect(cat).toMatchObject({ isImportant: false, isSpam: false, isInvoiceBilling: false });

      await repo.removeCategory('e1');
      expect(tagsOf(db, 'e1')).toBe('||');
    });
  });

  // ==========================================================================
  // Legacy boolean-flag API (upsertCategory / upsertCategoryBatch / getCategory).
  // Still used by older call sites; it must translate to the SAME tag encoding
  // the tags-based readers use, or the two APIs disagree about one email.
  // ==========================================================================
  describe('legacy boolean category API', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'e1', tags: '|INBOX|' });
    });

    it('round-trips the boolean flags through tags', async () => {
      await repo.upsertCategory({
        emailId: 'e1',
        isImportant: true,
        isSpam: false,
        isReminder: false,
        isWaitingReply: false,
        isNeedsResponse: true,
        isMeetingRelated: false,
        isInvoiceBilling: true,
        reasoning: 'why',
        confidence: 0.42,
        processedAt: 12345,
      });

      const cat = await repo.getCategory('e1');
      expect(cat).toMatchObject({
        id: 'ai-cat-e1',
        emailId: 'e1',
        threadId: 't-e1',
        isImportant: true,
        isSpam: false,
        isReminder: false,
        isNeedsResponse: true,
        isMeetingRelated: false,
        isInvoiceBilling: true,
        reasoning: 'why',
        confidence: 0.42,
        processedAt: 12345,
      });
    });

    it('returns null for an unknown email and for one the AI never processed', async () => {
      expect(await repo.getCategory('missing')).toBeNull();
      expect(await repo.getCategory('e1')).toBeNull(); // ai_processed_at IS NULL
    });

    // KNOWN SHARP EDGE: `waiting_reply` was removed from the definitions table
    // (migration v35) but the legacy mapper still writes the tag. Because the
    // "clear old categories" loop only removes slugs that EXIST in the
    // definitions table, the tag can never be cleared again.
    it('a legacy waiting_reply tag survives every later re-categorization', async () => {
      await repo.upsertCategory({
        emailId: 'e1',
        isImportant: false, isSpam: false, isReminder: false,
        isWaitingReply: true, isNeedsResponse: false,
        isMeetingRelated: false, isInvoiceBilling: false,
        confidence: 1, processedAt: 1,
      });
      expect(tagsOf(db, 'e1')).toContain('|waiting_reply|');

      repo.saveEmailCategories('e1', [{ slug: 'meeting', confidence: 1 }], false, '', 2, 1);
      expect(tagsOf(db, 'e1')).toContain('|waiting_reply|');
      expect((await repo.getCategory('e1'))!.isWaitingReply).toBe(true);
    });

    it('upsertCategoryBatch accepts 0/1 integers as booleans and marks spam', async () => {
      insertEmail(db, { id: 'e2', tags: '|INBOX|' });

      const updated = repo.upsertCategoryBatch([
        {
          emailId: 'e1', isImportant: 1, isSpam: 0, isReminder: 0, isWaitingReply: 0,
          isNeedsResponse: 0, isMeetingRelated: 1, isInvoiceBilling: 0,
          reasoning: null, confidence: 0.5, processedAt: 900,
        },
        {
          emailId: 'e2', isImportant: false, isSpam: 1, isReminder: true, isWaitingReply: false,
          isNeedsResponse: false, isMeetingRelated: false, isInvoiceBilling: false,
          confidence: 0.1, processedAt: 901,
        },
      ]);

      expect(updated).toBe(2);
      const first = (await repo.getCategory('e1'))!;
      expect(first).toMatchObject({ isImportant: true, isMeetingRelated: true, isSpam: false, reasoning: null });
      const second = (await repo.getCategory('e2'))!;
      expect(second).toMatchObject({ isSpam: true, isReminder: true, isImportant: false });
      // the boolean mapper never emits a `spam` *category* tag — spam is its own flag
      expect(tagsOf(db, 'e2')).toContain('|reminders|');
    });

    it('removeCategory clears the AI metadata, keeps folder/flag tags and queues a label reconcile', async () => {
      repo.saveEmailCategories('e1', [{ slug: 'invoice', confidence: 1 }], true, 'because', 55, 0.8);
      db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|read|invoice|spam|', 'e1');

      await repo.removeCategory('e1');

      expect(tagsOf(db, 'e1')).toBe('|INBOX|read|');
      expect(emailRow(db, 'e1')).toMatchObject({
        ai_reasoning: null,
        ai_confidence: 0,
        ai_processed_at: null,
        label_status: 'pending', // strips the label on the server too
      });
      expect(await repo.getCategory('e1')).toBeNull();
    });

    it('removeCategory on an unknown email is a silent no-op', async () => {
      await expect(repo.removeCategory('ghost')).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // Spammers — a blocklist. Wrong normalisation here means either a blocked
  // sender still lands in the inbox, or a duplicate row per report.
  // ==========================================================================
  describe('spammers', () => {
    it('lowercases the stored address, derives the domain and generates a stable id', async () => {
      await repo.addSpammer({ email: 'Bad.Guy@Spam.com', name: 'Bad Guy' });

      const row = db.prepare('SELECT * FROM spammers').get() as Record<string, unknown>;
      expect(row.email).toBe('bad.guy@spam.com');
      expect(row.name).toBe('Bad Guy');
      expect(row.reason).toBe('Marked as spam by user'); // default reason
      expect(row.reported_count).toBe(1);
      expect(String(row.id)).toContain(`spam-${FIXED_NOW_MS}-`);

      expect(await repo.isSpammer('BAD.GUY@spam.com')).toBe(true);
      expect(await repo.isSpammer('someone@else.com')).toBe(false);
    });

    // Reporting the same sender twice must bump the counter on ONE row, not
    // insert a second — the settings list would otherwise show duplicates and
    // the domain heuristic would trip on a single sender.
    it('re-reporting the same address is idempotent and increments reported_count', async () => {
      await repo.addSpammer({ email: 'dup@spam.com' });
      await repo.addSpammer({ email: 'DUP@spam.com', reason: 'reported again' });

      const rows = db.prepare('SELECT email, reported_count, reason FROM spammers').all();
      expect(rows).toEqual([{ email: 'dup@spam.com', reported_count: 2, reason: 'reported again' }]);
    });

    // Documents that the re-report ALWAYS overwrites `reason`: addSpammer
    // substitutes a default for a missing reason, so the COALESCE(excluded.reason,
    // reason) guard can never keep the older, more specific reason.
    it('a re-report without a reason overwrites a custom reason with the default', async () => {
      await repo.addSpammer({ email: 'r@spam.com', reason: 'phishing attempt' });
      await repo.addSpammer({ email: 'r@spam.com' });

      const row = db.prepare('SELECT reason FROM spammers WHERE email = ?').get('r@spam.com');
      expect(row).toEqual({ reason: 'Marked as spam by user' });
    });

    it('honours a caller-supplied id and NULL-able columns round-trip as null', async () => {
      await repo.addSpammer({ id: 'fixed-id', email: 'plain@spam.com' });

      const [spammer] = await repo.getSpammers();
      expect(spammer.id).toBe('fixed-id');
      expect(spammer.name).toBeNull();
      expect(spammer.domain).toBe('spam.com');
    });

    // An address with no `@` has no domain — it must store SQL NULL so the
    // domain heuristic ignores it rather than grouping on the string "undefined".
    it('stores a NULL domain for an address without an @', async () => {
      await repo.addSpammer({ email: 'not-an-address' });
      const [spammer] = await repo.getSpammers();
      expect(spammer.domain).toBeNull();
    });

    it('isSpammerDomain only trips at 3 or more reported senders on the domain', async () => {
      await repo.addSpammer({ email: 'a@bulk.com' });
      await repo.addSpammer({ email: 'b@bulk.com' });
      expect(await repo.isSpammerDomain('bulk.com')).toBe(false);

      await repo.addSpammer({ email: 'c@bulk.com' });
      expect(await repo.isSpammerDomain('bulk.com')).toBe(true);
      expect(await repo.isSpammerDomain('unknown.com')).toBe(false);
    });

    // KNOWN SHARP EDGE: the stored domain is sliced off the RAW address (not the
    // lowercased one) while every lookup lowercases its argument — so a
    // mixed-case sender's domain is UNREACHABLE by isSpammerDomain, whatever the
    // caller passes.
    it('a mixed-case sender domain is stored unnormalised and can never match the domain lookup', async () => {
      await repo.addSpammer({ email: 'a@Bulk.COM' });
      await repo.addSpammer({ email: 'b@Bulk.COM' });
      await repo.addSpammer({ email: 'c@Bulk.COM' });

      expect(db.prepare('SELECT DISTINCT domain FROM spammers').all()).toEqual([{ domain: 'Bulk.COM' }]);
      expect(await repo.isSpammerDomain('bulk.com')).toBe(false);
      expect(await repo.isSpammerDomain('Bulk.COM')).toBe(false);
    });

    // Addresses arrive padded from header parses. Nothing used to trim them, so
    // the padded value was STORED with its spaces and every clean lookup missed
    // it — the sender stayed un-blocked. Both sides now go through the same
    // normalizer (trim + lowercase), so either spelling finds the row.
    it('trims whitespace around the address on both write and read', async () => {
      await repo.addSpammer({ email: '  padded@spam.com  ' });
      expect(await repo.isSpammer('padded@spam.com')).toBe(true);
      expect(await repo.isSpammer('  padded@spam.com  ')).toBe(true);
      expect(await repo.isSpammer(' PADDED@Spam.com ')).toBe(true);
      expect(db.prepare('SELECT email FROM spammers').all()).toEqual([{ email: 'padded@spam.com' }]);
    });

    it('removeSpammer deletes case-insensitively and unknown removals are no-ops', async () => {
      await repo.addSpammer({ email: 'gone@spam.com' });
      await repo.removeSpammer('GONE@Spam.com');
      expect(await repo.isSpammer('gone@spam.com')).toBe(false);
      await expect(repo.removeSpammer('never@there.com')).resolves.toBeUndefined();
    });

    describe('listing and search', () => {
      beforeEach(async () => {
        await repo.addSpammer({ email: 'newest@one.com', name: 'Newest' });
        await repo.addSpammer({ email: 'middle@two.com', name: 'Middle' });
        await repo.addSpammer({ email: 'oldest@three.com', name: 'Oldest' });
        // strftime('%s','now') gives all three the same second — stamp explicit
        // report times so ordering is deterministic rather than insert-order luck.
        const stamp = db.prepare('UPDATE spammers SET last_reported_at = ? WHERE email = ?');
        stamp.run(300, 'newest@one.com');
        stamp.run(200, 'middle@two.com');
        stamp.run(100, 'oldest@three.com');
      });

      it('lists newest-reported first and pages with limit/offset', async () => {
        expect((await repo.getSpammers()).map((s) => s.email)).toEqual([
          'newest@one.com', 'middle@two.com', 'oldest@three.com',
        ]);
        expect((await repo.getSpammers({ limit: 2 })).map((s) => s.email)).toEqual([
          'newest@one.com', 'middle@two.com',
        ]);
        expect((await repo.getSpammers({ limit: 2, offset: 2 })).map((s) => s.email)).toEqual([
          'oldest@three.com',
        ]);
      });

      it('searches address, name and domain, and the count honours the same filter', async () => {
        expect((await repo.getSpammers({ search: 'two.com' })).map((s) => s.email)).toEqual(['middle@two.com']);
        expect((await repo.getSpammers({ search: 'Oldest' })).map((s) => s.email)).toEqual(['oldest@three.com']);
        expect(await repo.getSpammerCount()).toBe(3);
        expect(await repo.getSpammerCount('two.com')).toBe(1);
        // a blank/whitespace search must fall back to the unfiltered query
        expect(await repo.getSpammerCount('   ')).toBe(3);
        expect((await repo.getSpammers({ search: '   ' })).length).toBe(3);
      });

      // Quotes and SQL keywords are bound parameters, never concatenated: they
      // must be matched literally and must not execute.
      it('treats quotes and SQL syntax in the search as literal text', async () => {
        await repo.addSpammer({ email: "o'brien@spam.com", name: "'; DROP TABLE spammers; --" });

        expect((await repo.getSpammers({ search: "o'brien" })).map((s) => s.email)).toEqual(["o'brien@spam.com"]);
        expect((await repo.getSpammers({ search: 'DROP TABLE' })).map((s) => s.email)).toEqual(["o'brien@spam.com"]);
        expect(await repo.getSpammerCount()).toBe(4); // table intact
      });

      // KNOWN SHARP EDGE: the search is interpolated into LIKE '%…%' without
      // escaping, so `%` and `_` from the user act as WILDCARDS. Pinned so the
      // day someone adds ESCAPE handling, the change is deliberate.
      it('a % or _ in the search behaves as a LIKE wildcard, not literal text', async () => {
        expect(await repo.getSpammerCount('%')).toBe(3);      // matches everything
        expect(await repo.getSpammerCount('middl_')).toBe(1); // _ matches any char
        // and a literal percent that is genuinely in no row still matches all rows
        expect((await repo.getSpammers({ search: 'o%com' })).length).toBe(3);
      });
    });
  });

  // ==========================================================================
  // Thread summaries — cached LLM output. A duplicate row per re-summarise would
  // both waste tokens and let the UI show a stale summary; malformed cached JSON
  // must degrade to "no key points", never crash the thread view.
  // ==========================================================================
  describe('thread summaries', () => {
    const summary = {
      threadId: 't-1',
      summary: 'They agreed to ship on Friday.',
      keyPoints: ['ship friday', 'advik owns QA'],
      participants: ['a@x.com', 'b@y.com'],
      lastEmailDate: 1700,
      emailCount: 3,
      processedAt: 0,
      modelUsed: 'test-model',
    };

    it('round-trips the JSON columns and defaults the id to sum-<threadId>', async () => {
      await repo.upsertSummary({ ...summary, processedAt: 1234 });

      const got = await repo.getSummary('t-1');
      expect(got).toMatchObject({
        id: 'sum-t-1',
        threadId: 't-1',
        summary: 'They agreed to ship on Friday.',
        keyPoints: ['ship friday', 'advik owns QA'],
        participants: ['a@x.com', 'b@y.com'],
        lastEmailDate: 1700,
        emailCount: 3,
        processedAt: 1234,
        modelUsed: 'test-model',
      });
    });

    it('defaults processedAt to now (seconds) and modelUsed to real NULL', async () => {
      await repo.upsertSummary({ ...summary, processedAt: 0, modelUsed: undefined });

      const got = (await repo.getSummary('t-1'))!;
      expect(got.processedAt).toBe(FIXED_NOW_S);
      expect(got.modelUsed).toBeNull();
    });

    // A summariser that returned no key points must persist an empty JSON array,
    // not SQL NULL / the string "undefined" — the thread view JSON.parses these.
    it('stores missing keyPoints/participants as empty JSON arrays', async () => {
      await repo.upsertSummary({
        ...summary,
        processedAt: 1,
        keyPoints: undefined as unknown as string[],
        participants: undefined as unknown as string[],
      });

      expect(db.prepare('SELECT key_points, participants FROM thread_summaries WHERE thread_id = ?').get('t-1'))
        .toEqual({ key_points: '[]', participants: '[]' });
      const got = (await repo.getSummary('t-1'))!;
      expect(got.keyPoints).toEqual([]);
      expect(got.participants).toEqual([]);
    });

    it('re-summarising the same thread replaces the row instead of duplicating it', async () => {
      await repo.upsertSummary({ ...summary, summary: 'first', processedAt: 1 });
      await repo.upsertSummary({ ...summary, id: 'a-different-id', summary: 'second', processedAt: 2 });

      expect(db.prepare('SELECT COUNT(*) AS n FROM thread_summaries').get()).toEqual({ n: 1 });
      expect((await repo.getSummary('t-1'))!.summary).toBe('second');
    });

    it('falls back to empty arrays when the cached JSON is malformed or NULL', async () => {
      await repo.upsertSummary({ ...summary, processedAt: 1 });
      db.prepare('UPDATE thread_summaries SET key_points = ?, participants = NULL WHERE thread_id = ?')
        .run('{not json', 't-1');

      const got = (await repo.getSummary('t-1'))!;
      expect(got.keyPoints).toEqual([]);
      expect(got.participants).toEqual([]);
    });

    it('missing summaries read as null and deleting one is idempotent', async () => {
      expect(await repo.getSummary('nope')).toBeNull();
      await repo.upsertSummary({ ...summary, processedAt: 1 });
      await repo.deleteSummary('t-1');
      expect(await repo.getSummary('t-1')).toBeNull();
      await expect(repo.deleteSummary('t-1')).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // Conversation extractions — the chat view's parsed bodies, also reused by AI
  // categorization to avoid re-stripping quoted history. Every unhappy path must
  // return null so the caller falls back to cleanBody instead of throwing while
  // rendering a thread.
  // ==========================================================================
  describe('conversation extractions', () => {
    const messages = JSON.stringify([
      { sourceEmailId: 'e1', isExtracted: false, body: '<p>My own words</p>' },
      { sourceEmailId: 'e1', isExtracted: true, body: '<p>quoted history</p>' },
      { sourceEmailId: 'e2', isExtracted: false, body: '   <br/>  ' },
      { sourceEmailId: 'e3', isExtracted: false, body: 42 },
    ]);

    const record = {
      threadId: 't-1',
      messages,
      emailCount: 4,
      processedEmailIds: JSON.stringify(['e1', 'e2']),
      processedAt: 4242,
      modelUsed: 'chat-extractor',
    };

    it('round-trips the extraction and defaults id/processedAt/modelUsed', async () => {
      await repo.upsertConversation(record);
      expect(await repo.getConversation('t-1')).toEqual({
        id: 'conv-t-1',
        threadId: 't-1',
        messages,
        emailCount: 4,
        processedEmailIds: JSON.stringify(['e1', 'e2']),
        processedAt: 4242,
        modelUsed: 'chat-extractor',
      });

      await repo.upsertConversation({ ...record, threadId: 't-2', processedAt: 0, modelUsed: null });
      const second = (await repo.getConversation('t-2'))!;
      expect(second.processedAt).toBe(FIXED_NOW_S);
      expect(second.modelUsed).toBeNull();
    });

    it('re-extracting the same thread replaces rather than duplicating', async () => {
      await repo.upsertConversation(record);
      await repo.upsertConversation({ ...record, id: 'other-id', emailCount: 9 });

      expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_extractions').get()).toEqual({ n: 1 });
      expect((await repo.getConversation('t-1'))!.emailCount).toBe(9);
    });

    it('getChatViewBodyForEmail returns only the email\'s OWN (non-extracted) body', async () => {
      await repo.upsertConversation(record);

      expect(repo.getChatViewBodyForEmail('t-1', 'e1')).toBe('<p>My own words</p>');
      // e2's body is markup-only → stripped to empty → null so the caller falls back
      expect(repo.getChatViewBodyForEmail('t-1', 'e2')).toBeNull();
      // e3's body is not a string
      expect(repo.getChatViewBodyForEmail('t-1', 'e3')).toBeNull();
      // an email the extractor never saw
      expect(repo.getChatViewBodyForEmail('t-1', 'e9')).toBeNull();
      // a thread with no extraction at all
      expect(repo.getChatViewBodyForEmail('t-missing', 'e1')).toBeNull();
    });

    it('getChatViewBodyForEmail returns null for malformed, non-array or empty cached JSON', async () => {
      await repo.upsertConversation({ ...record, messages: '{not json' });
      expect(repo.getChatViewBodyForEmail('t-1', 'e1')).toBeNull();

      await repo.upsertConversation({ ...record, messages: '{"sourceEmailId":"e1"}' });
      expect(repo.getChatViewBodyForEmail('t-1', 'e1')).toBeNull();

      await repo.upsertConversation({ ...record, messages: '[null]' });
      expect(repo.getChatViewBodyForEmail('t-1', 'e1')).toBeNull();

      await repo.upsertConversation({ ...record, messages: '' });
      expect(repo.getChatViewBodyForEmail('t-1', 'e1')).toBeNull();
    });

    it('deletes one extraction and clears them all, reporting rows removed', async () => {
      await repo.upsertConversation(record);
      await repo.upsertConversation({ ...record, threadId: 't-2' });

      await repo.deleteConversation('t-1');
      expect(await repo.getConversation('t-1')).toBeNull();
      expect(await repo.getConversation('t-2')).not.toBeNull();

      expect(await repo.clearAllConversations()).toBe(1);
      expect(await repo.clearAllConversations()).toBe(0);
    });
  });

  // ==========================================================================
  // Categorization pipeline — which emails get sent to the LLM, in what order,
  // and how failures are remembered. Drift between the eligibility query and the
  // "X pending" count is what produced the permanent "10000 pending" badge, and a
  // non-persistent failure counter made bad emails loop forever across restarts.
  // ==========================================================================
  describe('eligibility + pending count', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'newest', tags: '|INBOX|', date: 3000 });
      insertEmail(db, { id: 'middle', tags: '|INBOX|', date: 2000 });
      insertEmail(db, { id: 'oldest', tags: '|INBOX|', date: 1000 });
      insertEmail(db, { id: 'read', tags: '|INBOX|read|', date: 4000 });
      insertEmail(db, { id: 'spam', tags: '|Spam|', date: 4000 });
      insertEmail(db, { id: 'junk', tags: '|Junk|', date: 4000 });
      insertEmail(db, { id: 'trash', tags: '|Trash|', date: 4000 });
      insertEmail(db, { id: 'gspam', tags: '|[Gmail]/Spam|', date: 4000 });
      insertEmail(db, { id: 'gtrash', tags: '|[Gmail]/Trash|', date: 4000 });
      insertEmail(db, { id: 'empty', tags: '|INBOX|', date: 4000, cleanBody: '', rawBody: '' });
      insertEmail(db, { id: 'done', tags: '|INBOX|', date: 4000, aiProcessedAt: 99 });
    });

    it('returns only unprocessed, unread, non-junk emails with a body — newest first', () => {
      expect(repo.getEligibleEmailsForAI(50).map((e) => e.id)).toEqual(['newest', 'middle', 'oldest']);
    });

    // skipRead is kept only for API compat; passing false must NOT sneak read
    // mail into the (paid) LLM pipeline.
    it('ignores skipRead=false — read mail is never eligible', () => {
      expect(repo.getEligibleEmailsForAI(50, false).map((e) => e.id)).toEqual(['newest', 'middle', 'oldest']);
    });

    // Batches must be stable and non-overlapping: the processor takes `limit`,
    // processes them (stamping ai_processed_at) and asks again.
    it('batches of `limit` are stable and do not overlap once processed', () => {
      const first = repo.getEligibleEmailsForAI(2).map((e) => e.id);
      expect(first).toEqual(['newest', 'middle']);

      repo.saveEmailCategoriesBatch(first.map((id) => ({
        emailId: id, categories: [], isSpam: false, reasoning: '', processedAt: 7, confidence: 1,
      })));

      expect(repo.getEligibleEmailsForAI(2).map((e) => e.id)).toEqual(['oldest']);
    });

    // The badge must report the real backlog with the SAME filter the processor
    // uses, and must ignore the (legacy) limit argument.
    it('getUnprocessedEmailCount matches the eligibility filter and ignores its limit', async () => {
      expect(await repo.getUnprocessedEmailCount()).toBe(repo.getEligibleEmailsForAI(1000).length);
      expect(await repo.getUnprocessedEmailCount(1)).toBe(3);
      expect(await repo.getUnprocessedEmailCount(1, false)).toBe(3);
    });

    // Whitespace is not content. The old filter was `clean_body != ''`, which
    // called a body of spaces real, sent it to the LLM and bought a guaranteed
    // parse failure plus its full retry budget per email. Both the count and
    // the selection now use the shared TRIM-based clause, so they agree on it.
    it('treats a whitespace-only body as no body, in the count and the selection', async () => {
      // Lengths move with the bodies — EmailRepository.update() does this for
      // real writes, and a hand-written UPDATE that skipped them would leave the
      // row still claiming a body it no longer has.
      db.prepare(
        `UPDATE emails SET clean_body = '   ', raw_body = '  ',
           clean_body_len = LENGTH(TRIM('   ')), raw_body_len = LENGTH(TRIM('  '))
         WHERE id = ?`,
      ).run('oldest');

      expect(repo.getEligibleEmailsForAI(50).map((e) => e.id)).toEqual(['newest', 'middle']);
      expect(await repo.getUnprocessedEmailCount()).toBe(2);
    });

    // getEmailsWithoutCategory is the broader "never touched by AI" query — it
    // deliberately still includes read and junk mail, unlike the eligibility one.
    it('getEmailsWithoutCategory includes read/junk mail but never bodyless rows', async () => {
      const ids = (await repo.getEmailsWithoutCategory(50)).map((e) => e.id);
      expect(ids).toContain('read');
      expect(ids).toContain('trash');
      expect(ids).not.toContain('empty');
      expect(ids).not.toContain('done');
      expect((await repo.getEmailsWithoutCategory(1)).map((e) => e.id)).toEqual(['read']); // date DESC, id tiebreak
    });
  });

  describe('parse-failure counters', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'e1', tags: '|INBOX|' });
      insertEmail(db, { id: 'e2', tags: '|INBOX|', aiProcessedAt: 500 });
    });

    // Persisted (not in-memory) so a problematic email stops being retried even
    // across app restarts.
    it('increments and returns the new count, and resets back to zero', () => {
      expect(repo.incrementParseFailureCount('e1')).toBe(1);
      expect(repo.incrementParseFailureCount('e1')).toBe(2);

      repo.resetParseFailureCount('e1');
      expect(emailRow(db, 'e1').ai_parse_failure_count).toBe(0);
    });

    it('returns 0 for an unknown email instead of throwing', () => {
      expect(repo.incrementParseFailureCount('ghost')).toBe(0);
      expect(() => repo.resetParseFailureCount('ghost')).not.toThrow();
    });

    // The attempted-call counter. Before it existed the "the call threw" branch
    // had NO give-up at all, so an email the provider always rejects stayed
    // agent_status='pending' for the life of the mailbox and held the AI
    // progress bar below 100% with nothing running and nothing logged.
    it('counts attempted-call failures separately from parse failures', () => {
      expect(repo.incrementAgentFailureCount('e1')).toBe(1);
      expect(repo.incrementAgentFailureCount('e1')).toBe(2);

      // The two budgets are different sizes, so sharing a column would make a
      // deterministic parse defect inherit the transient path's ten attempts.
      expect(emailRow(db, 'e1').ai_parse_failure_count).toBe(0);
    });

    // A formerly-flaky email must not carry strikes into its next outage, or it
    // gives up on the first failure and is silently left uncategorized.
    it('resets the attempted-call counter back to zero', () => {
      repo.incrementAgentFailureCount('e1');
      repo.resetAgentFailureCount('e1');
      expect(emailRow(db, 'e1').ai_agent_failure_count).toBe(0);
    });

    it('returns 0 for an unknown email instead of throwing on the agent counter', () => {
      expect(repo.incrementAgentFailureCount('ghost')).toBe(0);
      expect(() => repo.resetAgentFailureCount('ghost')).not.toThrow();
    });

    // pendingRetry = will be retried; givenUp = hit the retry cap and was marked
    // processed with no categories. Mixing the two would hide a stuck backlog.
    it('splits failures into pending-retry and given-up by the retry cap', () => {
      db.prepare('UPDATE emails SET ai_parse_failure_count = 2 WHERE id = ?').run('e1'); // unprocessed
      db.prepare('UPDATE emails SET ai_parse_failure_count = 3 WHERE id = ?').run('e2'); // processed

      expect(repo.getParseFailureCounts(3)).toEqual({ pendingRetry: 1, givenUp: 1 });
      expect(repo.getParseFailureCounts(4)).toEqual({ pendingRetry: 1, givenUp: 0 });
    });
  });

  describe('importance and auth status', () => {
    beforeEach(() => {
      insertEmail(db, { id: 'e1', tags: '|INBOX|', date: 2000 });
      insertEmail(db, { id: 'e2', tags: '|INBOX|', date: 1000 });
      insertEmail(db, { id: 'empty', tags: '|INBOX|', date: 3000, cleanBody: '', rawBody: '' });
    });

    // importance_source is the "already scored" marker: if the update didn't
    // stick, the scorer would re-score the same mail on every pass.
    it('updateImportance stamps the score and source, taking the row out of the queue', async () => {
      expect((await repo.getEmailsNeedingProcessing(10)).map((e) => e.id)).toEqual(['e1', 'e2']);

      await repo.updateImportance('e1', 87, 'ai');

      expect(emailRow(db, 'e1')).toMatchObject({ importance_score: 87, importance_source: 'ai' });
      expect((await repo.getEmailsNeedingProcessing(10)).map((e) => e.id)).toEqual(['e2']);
    });

    it('rows with a NULL importance_source still need processing; bodyless rows never do', async () => {
      db.prepare('UPDATE emails SET importance_source = NULL WHERE id = ?').run('e1');
      const ids = (await repo.getEmailsNeedingProcessing(10)).map((e) => e.id);
      expect(ids).toEqual(['e1', 'e2']);
      expect(ids).not.toContain('empty');
    });

    it('updateAuthStatus round-trips the SPF/DKIM verdict', async () => {
      await repo.updateAuthStatus('e1', 'spf=pass;dkim=fail');
      expect(emailRow(db, 'e1').auth_status).toBe('spf=pass;dkim=fail');
    });
  });
});
