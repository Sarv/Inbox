import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emailAiActions } from '../../../src/migrations';
import { AgentRepository } from '../../../src/repositories/agent-repository';
import { EmailRepository } from '../../../src/repositories/email-repository';
import { newMigratedDb, openTestDb } from '../../../src/test-support/test-db';

// What the AI did to an email lives on the email's own row (emails.ai_actions,
// v106). The list reads it to draw the AI icon and the AI section counts it. A
// regression here is an icon on the wrong mail, an icon that never goes away
// after Undo, or counts that disagree with the list.

function addEmail(db: Database.Database, id: string, extra: { aiProcessedAt?: number; folderId?: string } = {}): void {
  db.prepare(`INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
    VALUES (?, 'S', '<a>', '<a>', 0)`).run(`t-${id}`);
  db.prepare(`INSERT INTO emails (id, message_id, thread_id, folder_id, tags, subject, from_address, date, clean_body, raw_body, content_type, content_hash, ai_processed_at)
    VALUES (?, ?, ?, ?, '|INBOX|', 'Subject', 'a@example.test', 1000, 'body text', 'body text', 'text', ?, ?)`)
    .run(id, `<${id}@test>`, `t-${id}`, extra.folderId ?? 'f-inbox', `hash-${id}`, extra.aiProcessedAt ?? null);
}

describe('AI actions on the email row', () => {
  let db: Database.Database;
  let agent: AgentRepository;
  let emails: EmailRepository;

  beforeEach(() => {
    db = newMigratedDb();
    db.exec(`INSERT INTO folders (id, name, path) VALUES ('f-inbox','INBOX','INBOX');`);
    agent = new AgentRepository(() => db);
    emails = new EmailRepository(() => db);
    for (const id of ['e1', 'e2', 'e3']) addEmail(db, id);
  });
  afterEach(() => { db.close(); });

  // Breaks: an action is stamped on the wrong email, or a vanished id throws
  // and loses the stamp on the others in the same batch.
  it('records on the named emails only, skipping ids that are gone', () => {
    expect(agent.recordAiActions(['e1', 'gone', 'e2', 'e1'], { kind: 'read', at: 100, auto: true })).toEqual(['e1', 'e2']);
    expect(JSON.parse(agent.getAiActionsRaw('e1')!)).toEqual([{ kind: 'read', at: 100, auto: true }]);
    expect(agent.getAiActionsRaw('e3')).toBeNull();
  });

  // Breaks: the list never shows the AI icon because rows reach the renderer
  // without the record, or every untouched row carries an empty list.
  it('reaches the email list and the single-email read', async () => {
    agent.recordAiActions(['e2'], { kind: 'archive', at: 200, auto: false });
    const list = await emails.getByFolder('f-inbox', { limit: 10, offset: 0 });
    expect(list.find(row => row.id === 'e2')!.aiActions).toEqual([{ kind: 'archive', at: 200, auto: false }]);
    expect(list.find(row => row.id === 'e1')!.aiActions).toBeUndefined();
    expect((await emails.getByIds(['e2']))[0]!.aiActions).toEqual([{ kind: 'archive', at: 200, auto: false }]);
  });

  // Breaks: Undo leaves the icon on the email, or removes a different action.
  it('forgets the undone action and clears the row once nothing is left', () => {
    agent.recordAiActions(['e1'], { kind: 'read', at: 100, auto: true });
    agent.recordAiActions(['e1'], { kind: 'star', at: 110, auto: true });
    expect(agent.forgetAiActions(['e1', 'e2'], 'read')).toEqual(['e1']);
    expect(JSON.parse(agent.getAiActionsRaw('e1')!)).toEqual([{ kind: 'star', at: 110, auto: true }]);
    expect(agent.forgetAiActions(['e1'], 'star')).toEqual(['e1']);
    expect(agent.getAiActionsRaw('e1')).toBeNull();
    // Idempotent: undoing again changes nothing.
    expect(agent.forgetAiActions(['e1'], 'star')).toEqual([]);
  });

  // Breaks: the AI section's counts disagree with the list, or one damaged
  // row makes the whole count fail.
  it('counts by kind, emails touched and emails categorized, skipping a damaged record', () => {
    agent.recordAiActions(['e1', 'e2'], { kind: 'read', at: 100, auto: true });
    agent.recordAiActions(['e2'], { kind: 'draft', at: 120, auto: true });
    db.prepare("UPDATE emails SET ai_actions = '{broken' WHERE id = 'e3'").run();
    addEmail(db, 'e4', { aiProcessedAt: 50 });
    addEmail(db, 'e5', { aiProcessedAt: 60 });
    const counts = agent.getAiActionCounts();
    expect(counts.byKind.read).toBe(2);
    expect(counts.byKind.draft).toBe(1);
    expect(counts.byKind.archive).toBe(0);
    expect(counts.categorized).toBe(2);
    // e3's damaged value still marks it as touched; its actions just aren't counted.
    expect(counts.emails).toBe(3);
  });

  // Breaks: two accounts' databases share AI records (each account has its own file).
  it('keeps each account database to itself', () => {
    const other = newMigratedDb();
    try {
      other.exec(`INSERT INTO folders (id, name, path) VALUES ('f-inbox','INBOX','INBOX');`);
      addEmail(other, 'e1');
      agent.recordAiActions(['e1'], { kind: 'spam', at: 1, auto: true });
      expect(new AgentRepository(() => other).getAiActionsRaw('e1')).toBeNull();
    } finally { other.close(); }
  });

  // Breaks: writing the record re-indexes the email for search (a full-text
  // rewrite of its body for every AI action).
  it('does not touch the search index', () => {
    const before = db.prepare('SELECT rowid, * FROM emails_fts').all();
    agent.recordAiActions(['e1', 'e2', 'e3'], { kind: 'read', at: 1, auto: true });
    expect(db.prepare('SELECT rowid, * FROM emails_fts').all()).toEqual(before);
  });
});

describe('migration v106', () => {
  // Breaks: upgrading an existing mailbox fails, or running it twice (a retried
  // boot) throws on the column it already added.
  it('adds the column to an existing emails table, once', () => {
    const db = openTestDb();
    try {
      db.exec('CREATE TABLE emails (id TEXT PRIMARY KEY, subject TEXT);');
      emailAiActions.up(db);
      emailAiActions.up(db);
      expect((db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string }>).map(column => column.name)).toContain('ai_actions');
      emailAiActions.down!(db);
    } finally { db.close(); }
  });
});
