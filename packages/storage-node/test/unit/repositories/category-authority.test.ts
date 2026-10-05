import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRepository } from '../../../src/repositories/agent-repository';
import { AIRepository } from '../../../src/repositories/ai-repository';
import { EmailRepository } from '../../../src/repositories/email-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';

describe('persisted classification authority', () => {
  let db: Database.Database;
  let emails: EmailRepository;
  let ai: AIRepository;
  function seed(id: string): void {
    db.prepare('INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date) VALUES (?, ?, ?, ?, ?)').run(id, id, `<${id}@test>`, `<${id}@test>`, 1000);
    db.prepare(`INSERT INTO emails (id,message_id,thread_id,folder_id,uid,tags,subject,from_address,date,
      clean_body,raw_body,clean_body_len,raw_body_len,content_type,content_hash,extraction_status,agent_status)
      VALUES (?,?,?,'f',1,'|INBOX|starred|',?,?,1000,'body','body',4,4,'text',?,'done','pending')`)
      .run(id, `<${id}@test>`, id, id, 'sender@test', id);
  }
  const row = (id: string): any => db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
  const save = (id: string): number => ai.saveEmailCategoriesBatch([{ emailId: id, categories: [{ slug: 'important', confidence: 0.9 }], isSpam: false, reasoning: 'AI', processedAt: 2000, confidence: 0.9 }]);
  beforeEach(() => {
    db = newMigratedDb();
    db.prepare('INSERT INTO folders (id,name,path) VALUES (?,?,?)').run('f', 'INBOX', 'INBOX');
    emails = new EmailRepository(() => db);
    ai = new AIRepository(() => db, (record) => emails.rowToRecord(record));
  });
  afterEach(() => db.close());

  // Regression: existing provider Promotions/Important must appear locally without becoming an AI verdict.
  it('projects native categories and blocks AI selectors and stale writes', async () => {
    seed('gmail');
    emails.setServerCategories('gmail', ['promotions']);
    expect((await emails.get('gmail'))?.serverCategories).toEqual(['promotions']);
    expect(row('gmail').tags).toBe('|INBOX|starred|promotions|');
    expect(row('gmail').ai_categories).toBeNull();
    expect(ai.getEligibleEmailsForAI()).toEqual([]);
    expect(await ai.getUnprocessedEmailCount()).toBe(0);
    expect(save('gmail')).toBe(0);
    ai.saveEmailCategories('gmail', [{ slug: 'important', confidence: 1 }], false, 'stale request', 1, 1);
    expect(row('gmail').tags).toBe('|INBOX|starred|promotions|');
  });

  // Regression: server removal must clear the old badge and make truly unclassified mail eligible again.
  it('reconciles removal idempotently without changing folders or stars', () => {
    seed('sarv');
    emails.setServerCategories('sarv', ['important']);
    expect(row('sarv').importance_source).toBe('provider');
    emails.setServerCategories('sarv', []);
    expect(row('sarv').tags).toBe('|INBOX|starred|');
    expect(row('sarv').importance_source).toBe('none');
    expect(ai.getEligibleEmailsForAI().map((email) => email.id)).toEqual(['sarv']);
    save('sarv');
    const afterAI = row('sarv');
    emails.setServerCategories('sarv', []);
    expect(row('sarv')).toEqual(afterAI);
  });

  // Regression: Seen/Starred refresh cannot erase a real AI verdict on otherwise ordinary mail.
  it('records empty provider metadata without changing an AI classification', () => {
    seed('ordinary'); save('ordinary');
    const before = row('ordinary');
    emails.setServerCategories('ordinary', []);
    const after = row('ordinary');
    expect(after.server_categories).toBe('[]');
    expect({ ...after, server_categories: before.server_categories }).toEqual(before);
  });

  // Regression: offline manual selections and intentional remove-all must survive retries/restart and in-flight AI.
  it('persists user selections without creating a competing AI mirror, including empty selection', async () => {
    seed('manual');
    emails.setServerCategories('manual', ['promotions']);
    emails.setManualCategories('manual', ['finance']);
    expect((await emails.get('manual'))?.manualCategories).toEqual(['finance']);
    expect(row('manual').tags).toBe('|INBOX|starred|finance|');
    expect(row('manual').label_status).toBe('done');
    expect(save('manual')).toBe(0);
    const agent = new AgentRepository(() => db);
    agent.markAgentDone('manual', {});
    expect(agent.getEmailsPendingLabel()).toEqual([]);
    emails.setManualCategories('manual', []);
    expect(row('manual').tags).toBe('|INBOX|starred|');
    expect(save('manual')).toBe(0);
    emails.setManualCategories('manual', null);
    expect(row('manual').tags).toBe('|INBOX|starred|promotions|');
    expect(row('manual').manual_categories).toBeNull();
  });

  // Regression: a prior manual click must not permanently ignore later webmail/server changes after acknowledgement.
  it('accepts later server changes into the local user snapshot', () => {
    seed('webmail');
    emails.setManualCategories('webmail', ['important']);
    emails.setServerCategories('webmail', ['promotions']);
    expect(row('webmail').tags).toBe('|INBOX|starred|promotions|');
    expect(JSON.parse(row('webmail').manual_categories)).toEqual(['promotions']);
    expect(row('webmail').label_status).toBe('done');
    emails.setServerCategories('webmail', []);
    expect(row('webmail').tags).toBe('|INBOX|starred|');
    expect(JSON.parse(row('webmail').manual_categories)).toEqual([]);
  });

  // Regression: provider authority in one mailbox must not block unclassified copies elsewhere.
  it('only blocks the row with provider classification', () => {
    seed('classified'); seed('unclassified');
    emails.setServerCategories('classified', ['important']);
    expect(save('classified')).toBe(0);
    expect(save('unclassified')).toBe(1);
    expect(row('unclassified').tags).toContain('|important|');
  });

  // Regression: native categories must suppress AI even if the account has not configured that optional view yet.
  it('retains native provider classifications without a category definition', async () => {
    seed('native');
    db.prepare("DELETE FROM ai_category_definitions WHERE slug = 'forums'").run();
    emails.setServerCategories('native', ['forums']);
    expect((await emails.get('native'))?.serverCategories).toEqual(['forums']);
    expect(row('native').tags).toContain('|forums|');
    expect(save('native')).toBe(0);
    expect(ai.getEligibleEmailsForAI()).toEqual([]);
  });

  // Regression: toggling independent Important must not remove an existing native category whose optional definition was deleted.
  it('preserves a native category in a manual selection without its definition', () => {
    seed('native-manual');
    db.prepare("DELETE FROM ai_category_definitions WHERE slug = 'forums'").run();
    emails.setServerCategories('native-manual', ['forums']);
    emails.setManualCategories('native-manual', ['forums', 'important', 'unknown-keyword']);
    expect(row('native-manual').tags).toBe('|INBOX|starred|forums|important|');
    expect(JSON.parse(row('native-manual').manual_categories)).toEqual(['forums', 'important']);
    expect(row('native-manual').importance_source).toBe('user');
    expect(save('native-manual')).toBe(0);
  });

  // Regression: an offline category query failure must not incur AI cost and must resume after category discovery succeeds.
  it('persists discovery deferral, blocks stale AI writes, and resumes after successful sync', async () => {
    seed('unknown');
    await emails.update('unknown', { gmailCategoriesPending: true });
    expect((await emails.get('unknown'))?.gmailCategoriesPending).toBe(true);
    expect((await emails.getTagsInFolder('f'))[0]?.gmailCategoriesPending).toBe(true);
    expect(ai.getEligibleEmailsForAI()).toEqual([]);
    expect(await ai.getUnprocessedEmailCount()).toBe(0);
    expect(save('unknown')).toBe(0);
    await emails.update('unknown', { gmailCategoriesPending: false });
    expect(ai.getEligibleEmailsForAI().map((email) => email.id)).toEqual(['unknown']);
    expect(save('unknown')).toBe(1);
  });

  // Regression: initial IMAP insertion and later metadata patches must survive a database read with the same authority.
  it('round-trips classification metadata on insert and update', async () => {
    seed('template');
    const template = (await emails.get('template'))!;
    await emails.insert({ ...template, id: 'inserted', messageId: '<inserted@test>',
      serverCategories: ['promotions'], manualCategories: [], gmailCategoriesPending: true });
    expect(await emails.get('inserted')).toMatchObject({
      serverCategories: ['promotions'], manualCategories: [], gmailCategoriesPending: true,
    });
    await emails.update('inserted', { serverCategories: null, manualCategories: ['finance'], gmailCategoriesPending: false });
    expect(await emails.get('inserted')).toMatchObject({
      serverCategories: null, manualCategories: ['finance'], gmailCategoriesPending: false,
    });
    await emails.update('inserted', { subject: 'Refreshed subject' });
    expect((await emails.get('inserted'))?.manualCategories).toEqual(['finance']);
  });

  // Regression: releasing a user choice on ordinary mail must remove its category and reopen automatic categorization.
  it('releases an override without provider metadata and ignores obsolete message ids', () => {
    seed('released');
    emails.setManualCategories('released', ['finance']);
    emails.setManualCategories('released', null);
    expect(row('released').tags).toBe('|INBOX|starred|');
    expect(row('released').manual_categories).toBeNull();
    expect(ai.getEligibleEmailsForAI().map((email) => email.id)).toEqual(['released']);
    emails.setServerCategories('removed-message', ['promotions']);
    emails.setManualCategories('removed-message', []);
    expect(db.prepare('SELECT COUNT(*) AS n FROM emails').get()).toEqual({ n: 1 });
  });

  // Regression: unchanged webmail state can supersede a completed local selection without becoming a permanent manual lock.
  it('reconciles the same provider selection after a differing user snapshot', () => {
    seed('acknowledged');
    emails.setServerCategories('acknowledged', ['promotions']);
    emails.setManualCategories('acknowledged', ['finance']);
    emails.setServerCategories('acknowledged', ['promotions']);
    expect(row('acknowledged').tags).toBe('|INBOX|starred|promotions|');
    expect(JSON.parse(row('acknowledged').manual_categories)).toEqual(['promotions']);
    const acknowledged = row('acknowledged');
    emails.setServerCategories('acknowledged', ['promotions']);
    expect(row('acknowledged')).toEqual(acknowledged);
  });
});
