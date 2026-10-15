import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ContactType, ContactTypeSource } from '@sarvinbox/core';
import type Sqlite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRepository } from '../../../src/repositories/agent-repository';
import type { RelationshipEvidence } from '../../../src/repositories/contact-classification';
import { newMigratedDb } from '../../../src/test-support/test-db';

// Relationship labels must follow evidence in this contact's own mail. An
// unrelated sender, a person's title, or a pile of mail cannot make someone a
// customer; stale guesses must not become permanent facts in the shared book.
const NOW = 1_790_000_000;
const OWNER = 'me@our-company.example';
let db: Sqlite.Database;
let repo: AgentRepository;
let sequence = 0;
const sharedConnections: Sqlite.Database[] = [];
const sharedDirectories: string[] = [];

function contact(email: string, options: {
  name?: string;
  received?: number;
  sent?: number;
  type?: ContactType | null;
  source?: string;
  confidence?: number;
  title?: string;
  company?: string;
  enrichment?: string;
  enrichmentSource?: string;
} = {}, database = db) {
  database.prepare(`INSERT INTO shared.contacts (
    id, email, name, first_seen, last_seen, received_count, sent_count,
    contact_type, contact_type_source, contact_type_confidence,
    title, company, enrichment, enrichment_source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `contact-${email}`, email, options.name ?? null, NOW - 1000, NOW,
    options.received ?? 0, options.sent ?? 0,
    options.type === undefined ? 'unknown' : options.type,
    options.source ?? 'unset', options.confidence ?? 0,
    options.title ?? null, options.company ?? null,
    options.enrichment ?? null, options.enrichmentSource ?? null,
  );
}

function mail(options: {
  from: string;
  to?: string;
  subject: string;
  outgoing?: boolean;
  unsubscribe?: string;
  body?: string;
}, database = db) {
  const id = `message-${++sequence}`;
  const folder = options.outgoing ? 'sent' : 'inbox';
  database.prepare(`INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)`).run(
    folder, folder, options.outgoing ? 'Sent' : 'INBOX', options.outgoing ? '\\Sent' : '\\Inbox',
  );
  database.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
    VALUES (?, ?, ?, ?, ?)`).run(id, options.subject, `<${id}>`, `<${id}>`, NOW);
  database.prepare(`INSERT INTO emails (
    id, message_id, thread_id, folder_id, uid, tags, subject, from_address, to_address,
    date, clean_body, raw_body, clean_body_len, raw_body_len,
    content_type, content_hash, list_unsubscribe
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?)`).run(
    id, `<${id}>`, id, folder, sequence, options.outgoing ? '|Sent|' : '|INBOX|',
    options.subject, options.from, options.to ?? OWNER, NOW,
    options.body ?? '', options.body ?? '', options.body?.length ?? 0, options.body?.length ?? 0,
    `hash-${id}`, options.unsubscribe ?? null,
  );
}

function classification(email: string, database = db) {
  return database.prepare(`SELECT contact_type AS type, contact_type_source AS source,
    contact_type_confidence AS confidence FROM shared.contacts WHERE email = ?`).get(email) as {
    type: ContactType | null; source: string; confidence: number;
  };
}
const typeOf = (email: string, database = db) => classification(email, database).type;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  sequence = 0;
  db = newMigratedDb();
  repo = new AgentRepository(() => db);
});
afterEach(() => {
  for (const connection of sharedConnections.splice(0)) connection.close();
  db.close();
  for (const directory of sharedDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('contact classification from owned identities and original subjects', () => {
  it.each([
    { subject: 'Invoice #304 for your subscription', outgoing: false, expected: 'vendor' },
    { subject: 'Bill for your hosting service', outgoing: false, expected: 'vendor' },
    { subject: 'Receipt for your payment', outgoing: false, expected: 'vendor' },
    { subject: 'Invoice #405 for our service', outgoing: true, expected: 'existing_customer' },
    { subject: 'Payment reminder for invoice #405', outgoing: true, expected: 'existing_customer' },
    { subject: 'Purchase order #509', outgoing: false, expected: 'existing_customer' },
    { subject: 'Request for quote', outgoing: false, expected: 'potential_customer' },
    { subject: 'Demo request', outgoing: false, expected: 'potential_customer' },
    { subject: 'Pricing inquiry', outgoing: false, expected: 'potential_customer' },
    { subject: 'Interview invitation', outgoing: false, expected: 'recruiter' },
    { subject: 'Job opportunity', outgoing: false, expected: 'recruiter' },
  ])('uses the direction of "$subject" (outgoing: $outgoing)', ({ subject, outgoing, expected }) => {
    const address = 'person@external-company.example';
    contact(address, { received: outgoing ? 0 : 1, sent: outgoing ? 1 : 0 });
    mail({ from: outgoing ? OWNER : address, to: outgoing ? address : OWNER, subject, outgoing });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf(address)).toBe(expected);
  });

  it('recognizes every owned identity and parses exact outbound recipients', () => {
    contact('teammate@second-company.example');
    contact('buyer@client.example', { sent: 1 });
    mail({
      from: 'alias@second-company.example',
      to: 'Other Person <other@elsewhere.example>, Buyer <BUYER@client.example>',
      subject: 'Invoice #409', outgoing: true,
    });
    repo.autoClassifyContacts([OWNER, 'alias@second-company.example']);
    expect(typeOf('teammate@second-company.example')).toBe('colleague');
    expect(typeOf('buyer@client.example')).toBe('existing_customer');
  });

  it.each([false, true])('does not borrow relationship evidence from another address (outgoing: %s)', (outgoing) => {
    const target = 'target@external-company.example';
    contact(target, { received: 20, sent: 10, title: 'Chief Executive Officer', company: 'External Company' });
    mail({
      from: outgoing ? OWNER : 'other@external-company.example',
      to: outgoing ? 'other@external-company.example' : OWNER,
      subject: 'Invoice #405', outgoing,
    });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf(target)).toBe('unknown');
  });

  it('does not treat an email address in a recipient display name as the recipient', () => {
    contact('buyer@client.example', { sent: 1 });
    mail({ from: OWNER, to: '"buyer@client.example" <other@client.example>', subject: 'Invoice #405', outgoing: true });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf('buyer@client.example')).toBe('unknown');
  });

  it('does not treat an invoice from a lookalike owned domain as our sale', () => {
    contact('buyer@client.example', { sent: 1 });
    mail({ from: 'me@our-company.example.evil', to: 'buyer@client.example', subject: 'Invoice #405', outgoing: true });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf('buyer@client.example')).toBe('unknown');
  });

  it('does not guess a business relationship from a job title, company, or body text', () => {
    contact('person@external-company.example', { received: 15, sent: 8, title: 'Customer Success Manager', company: 'Customer Company' });
    mail({ from: 'person@external-company.example', subject: 'Hello', body: 'Quoted old thread: Invoice #405. Purchase order #509. Demo request.' });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf('person@external-company.example')).toBe('unknown');
  });

  it.each(['Re: Invoice #405', 'Fw: Purchase order #509', 'Fwd: Demo request'])('does not infer a relationship from the quoted subject "%s"', (subject) => {
    contact('person@external-company.example', { received: 2, sent: 1 });
    mail({ from: 'person@external-company.example', subject });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf('person@external-company.example')).toBe('unknown');
  });

  it('leaves contradictory supplier and customer evidence unresolved', () => {
    const address = 'partner@external-company.example';
    contact(address, { received: 1, sent: 1 });
    mail({ from: address, subject: 'Invoice #100' });
    mail({ from: OWNER, to: address, subject: 'Invoice #200', outgoing: true });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf(address)).toBe('unknown');
  });
});

describe('conservative automatic labels', () => {
  it.each(['support', 'sales', 'accounts', 'hr'])('keeps internal human %s mailboxes as colleagues despite unsubscribe headers', (local) => {
    const address = `${local}@our-company.example`;
    const enrichment = JSON.stringify({ name: 'Abhishek S', designation: 'Support specialist' });
    contact(address, {
      name: 'Abhishek S', received: 12, type: 'newsletter', source: 'behavior', confidence: 0.9,
      enrichment, enrichmentSource: 'llm',
    });
    mail({ from: address, subject: 'Your support request', unsubscribe: '<mailto:unsubscribe@our-company.example>' });
    expect(repo.autoClassifyContacts(OWNER)).toBe(1);
    expect(typeOf(address)).toBe('colleague');
    expect((db.prepare('SELECT enrichment FROM shared.contacts WHERE email = ?').get(address) as { enrichment: string }).enrichment)
      .toBe(enrichment);
  });

  it.each(['newsletter', 'digest', 'newsletter-weekly'])('keeps an explicit internal %s mailbox as a newsletter', (local) => {
    const address = `${local}@our-company.example`;
    contact(address, { received: 3 });
    mail({ from: address, subject: 'Weekly update', unsubscribe: '<mailto:unsubscribe@our-company.example>' });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf(address)).toBe('newsletter');
  });

  it('preserves a manual internal mailbox label despite colleague evidence', () => {
    const address = 'support@our-company.example';
    contact(address, { received: 12, type: 'newsletter', source: 'user', confidence: 1 });
    mail({ from: address, subject: 'Your support request', unsubscribe: '<mailto:unsubscribe@our-company.example>' });
    expect(repo.autoClassifyContacts(OWNER)).toBe(0);
    expect(typeOf(address)).toBe('newsletter');
  });

  it('classifies automation before colleagues without treating every role mailbox as a bot', () => {
    for (const local of ['no-reply', 'no_reply', 'no.reply', 'donotreply', 'mailer-daemon', 'postmaster', 'notifications']) {
      contact(`${local}@our-company.example`);
    }
    for (const local of ['info', 'sales', 'hr', 'accounts']) contact(`${local}@external-company.example`);
    contact('Teammate@OUR-COMPANY.EXAMPLE');
    repo.autoClassifyContacts(OWNER);
    for (const local of ['no-reply', 'no_reply', 'no.reply', 'donotreply', 'mailer-daemon', 'postmaster', 'notifications']) {
      expect(typeOf(`${local}@our-company.example`)).toBe('automated');
    }
    for (const local of ['info', 'sales', 'hr', 'accounts']) expect(typeOf(`${local}@external-company.example`)).toBe('unknown');
    expect(typeOf('Teammate@OUR-COMPANY.EXAMPLE')).toBe('colleague');
  });

  it.each([
    { owner: 'me@gmail.com', address: 'stranger@gmail.com' },
    { owner: OWNER, address: 'person@our-company.example.evil' },
    { owner: OWNER, address: 'person@sub.our-company.example' },
    { owner: 'me@our_company.example', address: 'person@ourxcompany.example' },
    { owner: 'not-an-email', address: 'person@external-company.example' },
  ])('does not infer a colleague from $owner and $address', ({ owner, address }) => {
    contact(address);
    repo.autoClassifyContacts(owner);
    expect(typeOf(address)).toBe('unknown');
  });

  it('requires newsletter evidence and leaves human message volume unclassified', () => {
    contact('human@external-company.example', { received: 30 });
    contact('conversational@external-company.example', { received: 20, sent: 10 });
    contact('list@publisher.example', { received: 1 });
    contact('digest@publisher.example', { name: 'Weekly Digest', received: 12 });
    contact('small@publisher.example', { name: 'Weekly Newsletter', received: 1 });
    contact('replied@publisher.example', { received: 12, sent: 1 });
    for (const address of ['list@publisher.example', 'replied@publisher.example']) {
      mail({ from: address, subject: 'Weekly update', unsubscribe: '<mailto:unsubscribe@publisher.example>' });
    }
    repo.autoClassifyContacts(OWNER);
    expect(typeOf('list@publisher.example')).toBe('newsletter');
    expect(typeOf('digest@publisher.example')).toBe('newsletter');
    for (const address of ['human@external-company.example', 'conversational@external-company.example', 'small@publisher.example', 'replied@publisher.example']) {
      expect(typeOf(address)).toBe('unknown');
    }
  });

  it.each([
    { subject: 'Invoice #123', expected: 'vendor' },
    { subject: 'Demo request', expected: 'potential_customer' },
    { subject: 'Purchase order #456', expected: 'existing_customer' },
  ])('preserves the business relationship in "$subject" despite an unsubscribe header', ({ subject, expected }) => {
    const address = 'person@external-company.example';
    contact(address, { received: 12 });
    mail({ from: address, subject, unsubscribe: '<mailto:unsubscribe@external-company.example>' });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf(address)).toBe(expected);
  });
});

describe('revisiting old guesses while preserving user work', () => {
  it('resets stale low-confidence behavior labels and synchronizes sender_stats back to unknown', () => {
    contact('person@external-company.example', { type: 'existing_customer', source: 'behavior', confidence: 0.65, received: 20, sent: 10 });
    db.prepare(`INSERT INTO sender_stats (id, email, domain, first_seen, contact_type)
      VALUES ('stats', 'person@external-company.example', 'external-company.example', ?, 'existing_customer')`).run(NOW);
    expect(repo.autoClassifyContacts(OWNER)).toBe(1);
    expect(typeOf('person@external-company.example')).toBe('unknown');
    expect(db.prepare("SELECT contact_type AS type FROM sender_stats WHERE id = 'stats'").get()).toEqual({ type: 'unknown' });
    expect(repo.autoClassifyContacts(OWNER)).toBe(0);
  });

  it('replaces stale low-confidence behavior with new evidence and remains idempotent', () => {
    contact('billing@supplier.example', { type: 'potential_customer', source: 'behavior', confidence: 0.6, received: 2, sent: 1 });
    mail({ from: 'billing@supplier.example', subject: 'Invoice #405' });
    expect(repo.autoClassifyContacts(OWNER)).toBe(1);
    expect(typeOf('billing@supplier.example')).toBe('vendor');
    const classified = classification('billing@supplier.example');
    expect(repo.autoClassifyContacts(OWNER)).toBe(0);
    expect(classification('billing@supplier.example')).toEqual(classified);
  });

  it.each(['personal', 'unknown'] as const)('preserves an explicit user choice of %s and user-edited profile fields', (type) => {
    const address = 'person@external-company.example';
    const enrichment = JSON.stringify({ jobTitle: 'My corrected title', companyName: 'My corrected company' });
    contact(address, { type, source: 'user', confidence: 0.2, title: 'My corrected title', company: 'My corrected company', enrichment, enrichmentSource: 'user' });
    mail({ from: address, subject: 'Invoice #405' });
    const before = db.prepare('SELECT * FROM shared.contacts WHERE email = ?').get(address);
    expect(repo.autoClassifyContacts(OWNER)).toBe(0);
    expect(db.prepare('SELECT * FROM shared.contacts WHERE email = ?').get(address)).toEqual(before);
  });

  it.each([0.85, 0.95])('preserves an AI classification at confidence %s despite a conflicting subject rule', (confidence) => {
    const address = 'partner@external-company.example';
    contact(address, { type: 'personal', source: 'ai', confidence });
    mail({ from: address, subject: 'Invoice #405' });
    expect(repo.autoClassifyContacts(OWNER)).toBe(0);
    expect(classification(address)).toEqual({ type: 'personal', source: 'ai', confidence });
  });

  it('can classify a relationship without changing user-edited profile data', () => {
    const address = 'supplier@external-company.example';
    const enrichment = JSON.stringify({ jobTitle: 'Corrected by me', companyName: 'Correct Company' });
    contact(address, { title: 'Corrected by me', company: 'Correct Company', enrichment, enrichmentSource: 'user' });
    mail({ from: address, subject: 'Invoice #405' });
    repo.autoClassifyContacts(OWNER);
    expect(typeOf(address)).toBe('vendor');
    expect(db.prepare(`SELECT title, company, enrichment, enrichment_source AS source
      FROM shared.contacts WHERE email = ?`).get(address)).toEqual({
      title: 'Corrected by me', company: 'Correct Company', enrichment, source: 'user',
    });
  });

  it('classifies legacy NULL types using the same evidence rules', () => {
    contact('person@external-company.example', { type: null });
    mail({ from: 'person@external-company.example', subject: 'Demo request' });
    expect(repo.autoClassifyContacts(OWNER)).toBe(1);
    expect(typeOf('person@external-company.example')).toBe('potential_customer');
  });

  it('combines NULL and literal unknown rows into one contact count', () => {
    contact('legacy@external-company.example', { type: null });
    contact('unclassified@external-company.example');
    contact('supplier@external-company.example', { type: 'vendor', source: 'user', confidence: 1 });
    expect(repo.getContactTypeCounts()).toEqual({ unknown: 2, vendor: 1 });
  });

  it.each(['|Junk|', '|Junk Email|', '|Deleted Items|', '|Drafts|'])('ignores transaction subjects filed in %s', (tags) => {
    const address = 'person@external-company.example';
    contact(address);
    mail({ from: address, subject: 'Invoice #123' });
    db.prepare('UPDATE emails SET tags = ?').run(tags);
    expect(repo.autoClassifyContacts(OWNER)).toBe(0);
    expect(typeOf(address)).toBe('unknown');
  });

  it('does not erase an established colleague when owned identities are temporarily unavailable', () => {
    const address = 'person@our-company.example';
    contact(address, { type: 'colleague', source: 'rule', confidence: 0.9 });
    expect(repo.autoClassifyContacts([])).toBe(0);
    expect(typeOf(address)).toBe('colleague');
  });
});

describe('explicit classification writes', () => {
  function sender(email: string, type: ContactType) {
    db.prepare(`INSERT INTO sender_stats (id, email, domain, first_seen, contact_type)
      VALUES (?, ?, ?, ?, ?)`).run(`stats-${email}`, email, email.split('@')[1], NOW, type);
  }
  const senderType = (email: string) => (db.prepare('SELECT contact_type AS type FROM sender_stats WHERE email = ?')
    .get(email) as { type: ContactType }).type;

  it.each([
    { description: 'type', type: 'not-a-contact-type', source: 'user', confidence: 1 },
    { description: 'source', type: 'vendor', source: 'not-a-source', confidence: 1 },
    { description: 'negative confidence', type: 'vendor', source: 'user', confidence: -0.01 },
    { description: 'confidence above one', type: 'vendor', source: 'user', confidence: 1.01 },
    { description: 'NaN confidence', type: 'vendor', source: 'user', confidence: Number.NaN },
    { description: 'infinite confidence', type: 'vendor', source: 'user', confidence: Number.POSITIVE_INFINITY },
  ])('rejects an invalid $description without changing either record', ({ type, source, confidence }) => {
    const address = 'person@external-company.example';
    contact(address);
    sender(address, 'unknown');
    const before = db.prepare('SELECT * FROM shared.contacts WHERE email = ?').get(address);
    expect(() => repo.setContactType(address, type as ContactType, confidence, source as ContactTypeSource)).toThrow();
    expect(db.prepare('SELECT * FROM shared.contacts WHERE email = ?').get(address)).toEqual(before);
    expect(senderType(address)).toBe('unknown');
  });

  it.each(['personal', 'unknown'] as const)('blocks automatic writes over a manual %s choice', (type) => {
    const address = 'person@external-company.example';
    contact(address, { type, source: 'user', confidence: 0.2 });
    sender(address, type);
    const before = db.prepare('SELECT * FROM shared.contacts WHERE email = ?').get(address);
    repo.setContactType(address, 'vendor', 0.99, 'rule');
    expect(db.prepare('SELECT * FROM shared.contacts WHERE email = ?').get(address)).toEqual(before);
    expect(senderType(address)).toBe(type);
  });

  it('allows a new user choice, normalizes the email, and synchronizes its timestamp and sender type', () => {
    const address = 'person@external-company.example';
    contact(address, { type: 'personal', source: 'user', confidence: 1 });
    sender(address, 'personal');
    // The shared directory's update trigger uses SQLite's own clock.
    const before = db.prepare('SELECT unixepoch() AS now').get() as { now: number };
    repo.setContactType(address.toUpperCase(), 'vendor', 0.77, 'user');
    expect(classification(address)).toEqual({ type: 'vendor', source: 'user', confidence: 0.77 });
    expect(senderType(address)).toBe('vendor');
    const updated = db.prepare('SELECT updated_at AS updatedAt FROM shared.contacts WHERE email = ?').get(address) as { updatedAt: number };
    const after = db.prepare('SELECT unixepoch() AS now').get() as { now: number };
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before.now);
    expect(updated.updatedAt).toBeLessThanOrEqual(after.now);
  });
});

describe('relationship evidence across accounts sharing one contact directory', () => {
  const SECOND_OWNER = 'me@second-company.example';
  const OWNERS = [OWNER, SECOND_OWNER];
  const ADDRESS = 'partner@external-company.example';

  function accounts() {
    db.close();
    const directory = mkdtempSync(join(tmpdir(), 'contact-classification-'));
    sharedDirectories.push(directory);
    const sharedPath = join(directory, 'contacts.sqlite');
    db = newMigratedDb(':memory:', sharedPath);
    repo = new AgentRepository(() => db);
    const secondDb = newMigratedDb(':memory:', sharedPath);
    sharedConnections.push(secondDb);
    const secondRepo = new AgentRepository(() => secondDb);
    return [{ db, repo }, { db: secondDb, repo: secondRepo }];
  }

  function combinedEvidence(accountRepos: AgentRepository[]) {
    const merged = new Map<string, RelationshipEvidence>();
    for (const account of accountRepos) {
      for (const [address, next] of account.getContactClassificationEvidence(OWNERS)) {
        const previous = merged.get(address);
        if (!previous) merged.set(address, { ...next });
        else for (const field of Object.keys(next) as Array<keyof RelationshipEvidence>) previous[field] ||= next[field];
      }
    }
    return merged;
  }

  it('keeps an invoice-backed vendor when the other account has no mail from that contact', () => {
    const [first, second] = accounts();
    contact(ADDRESS);
    mail({ from: ADDRESS, subject: 'Invoice #123' }, first.db);
    const evidence = combinedEvidence([first.repo, second.repo]);
    expect(evidence.get(ADDRESS)).toMatchObject({ vendor: true, customer: false });
    expect(first.repo.autoClassifyContacts(OWNERS, evidence)).toBe(1);
    expect(second.repo.autoClassifyContacts(OWNERS, combinedEvidence([first.repo, second.repo]))).toBe(0);
    expect(typeOf(ADDRESS, first.db)).toBe('vendor');
    expect(typeOf(ADDRESS, second.db)).toBe('vendor');
  });

  it('revisits a vendor when a second account gains contradictory customer evidence', () => {
    const [first, second] = accounts();
    contact(ADDRESS);
    mail({ from: ADDRESS, subject: 'Invoice #123' }, first.db);
    first.repo.autoClassifyContacts(OWNERS, combinedEvidence([first.repo, second.repo]));
    expect(typeOf(ADDRESS)).toBe('vendor');

    mail({ from: SECOND_OWNER, to: ADDRESS, subject: 'Invoice #456', outgoing: true }, second.db);
    const evidence = combinedEvidence([first.repo, second.repo]);
    expect(evidence.get(ADDRESS)).toMatchObject({ vendor: true, customer: true });
    second.repo.autoClassifyContacts(OWNERS, evidence);
    first.repo.autoClassifyContacts(OWNERS, evidence);
    expect(typeOf(ADDRESS, first.db)).toBe('unknown');
    expect(typeOf(ADDRESS, second.db)).toBe('unknown');
  });

  it('uses another account invoice to refresh a stale low-confidence vendor label', () => {
    const [first, second] = accounts();
    contact(ADDRESS, { type: 'vendor', source: 'behavior', confidence: 0.6 });
    mail({ from: ADDRESS, subject: 'Invoice #123' }, first.db);
    const evidence = combinedEvidence([first.repo, second.repo]);
    second.repo.autoClassifyContacts(OWNERS, evidence);
    expect(classification(ADDRESS, second.db)).toEqual({ type: 'vendor', source: 'behavior', confidence: 0.9 });
    first.repo.autoClassifyContacts(OWNERS, evidence);
    expect(typeOf(ADDRESS, first.db)).toBe('vendor');
  });

  it.each(['personal', 'unknown'] as const)('preserves the shared manual %s choice across both evidence sources', (type) => {
    const [first, second] = accounts();
    contact(ADDRESS, { type, source: 'user', confidence: 0.2 });
    mail({ from: ADDRESS, subject: 'Invoice #123' }, first.db);
    mail({ from: SECOND_OWNER, to: ADDRESS, subject: 'Invoice #456', outgoing: true }, second.db);
    const before = db.prepare('SELECT * FROM shared.contacts WHERE email = ?').get(ADDRESS);
    const evidence = combinedEvidence([first.repo, second.repo]);
    expect(first.repo.autoClassifyContacts(OWNERS, evidence)).toBe(0);
    expect(second.repo.autoClassifyContacts(OWNERS, evidence)).toBe(0);
    expect(second.db.prepare('SELECT * FROM shared.contacts WHERE email = ?').get(ADDRESS)).toEqual(before);
  });
});
