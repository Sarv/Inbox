// Contact repository — the "intelligence" half: enrichment candidates, applying
// LLM enrichment, identity resolution, company synthesis, confirm-gated avatars,
// and the deterministic phone/URL classifiers.
//
// This is the part of the address book that MUTATES identity, so its guards are
// the expensive ones to lose: a role mailbox (info@, hr@) must never acquire a
// person_id or a personal mobile — otherwise every colleague sharing the company
// switchboard merges into one "person"; a hallucinated companyDomain of
// "gmail.com" must never become a company all Gmail senders belong to; a job
// switch must close the previous history row instead of overwriting it; and the
// phone classifier must fully own its two fields so a stale wrong number can't
// linger. Each test seeds real rows and asserts the rows that come back out.

import type { ContactEnrichment } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newMigratedDb } from '../../../src/test-support/test-db';

import {
  ContactRepository,
  SQL_ENRICHMENT_CANDIDATES,
} from '../../../src/repositories/contact-repository';

const NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);
const DAY = 86400;

let db: Database.Database;
let repo: ContactRepository;

function seedFolderAndThread(threadId: string): void {
  db.prepare(`INSERT OR IGNORE INTO folders (id, name, path) VALUES ('f1', 'INBOX', 'INBOX')`).run();
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, ?)`,
  ).run(threadId, `<${threadId}>`, `<${threadId}>`, NOW);
}

function insertEmail(id: string, fromAddress: string, date: number, subject = 'subj'): void {
  const threadId = `t-${id}`;
  seedFolderAndThread(threadId);
  db.prepare(
    `INSERT INTO emails (
       id, message_id, thread_id, folder_id, tags, subject, from_address, date,
       clean_body, raw_body, content_type, content_hash
     ) VALUES (?, ?, ?, 'f1', '|INBOX|', ?, ?, ?, 'body', 'body', 'text', ?)`,
  ).run(id, `<${id}>`, threadId, subject, fromAddress, date, `h-${id}`);
}

const rowOf = (email: string): Record<string, any> =>
  db.prepare('SELECT * FROM contacts WHERE email = ?').get(email) as Record<string, any>;

const historyRows = (contactId: string): Record<string, any>[] =>
  db.prepare('SELECT * FROM contact_enrichment_history WHERE contact_id = ? ORDER BY effective_from DESC')
    .all(contactId) as Record<string, any>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  db = newMigratedDb();
  repo = new ContactRepository(() => db);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// The scheduler walks this list one contact at a time. If it returns contacts
// with no inbound mail, or re-returns ones already enriched through their newest
// email, every tick burns LLM calls on nothing.
describe('ContactRepository — enrichment candidates', () => {
  it('returns only individuals with inbound mail, reporting their newest email date', async () => {
    const withMail = await repo.upsert({ email: 'has@corp.io', receivedCount: 1 });
    await repo.upsert({ email: 'nomail@corp.io', sentCount: 1 }); // we wrote to them; nothing to mine
    insertEmail('e1', 'HAS@Corp.IO', NOW - 10 * DAY);
    insertEmail('e2', 'has@corp.io', NOW - 2 * DAY);
    insertEmail('e3', 'has@corp.io', NOW - 30 * DAY);
    // A synthesized company row has no signature to mine even with matching mail.
    const company = await repo.upsertCompany({ domain: 'corp.io', name: 'Corp' });
    insertEmail('e4', 'company@corp.io', NOW - DAY);

    const candidates = await repo.getEnrichmentCandidates();
    expect(candidates).toEqual([
      { id: withMail.id, email: 'has@corp.io', kind: 'individual', enrichedThroughEmailAt: null, newestEmailAt: NOW - 2 * DAY },
    ]);
    expect(candidates.map((c) => c.id)).not.toContain(company.id);
  });

  it('skips a contact already enriched through its newest email and re-includes it when newer mail arrives', async () => {
    const c = await repo.upsert({ email: 'water@corp.io', receivedCount: 1 });
    insertEmail('e1', 'water@corp.io', NOW - 5 * DAY);
    await repo.recordEnrichmentWatermark(c.id, NOW - 5 * DAY);

    expect(rowOf('water@corp.io').enriched_through_email_at).toBe(NOW - 5 * DAY);
    expect(await repo.getEnrichmentCandidates()).toEqual([]);

    insertEmail('e2', 'water@corp.io', NOW - 5 * DAY + 1); // one second newer → eligible
    const again = await repo.getEnrichmentCandidates();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      id: c.id, enrichedThroughEmailAt: NOW - 5 * DAY, newestEmailAt: NOW - 5 * DAY + 1,
    });
  });

  it('applies minAgeDays as a strict boundary on the newest-vs-watermark gap', async () => {
    const c = await repo.upsert({ email: 'aged@corp.io', receivedCount: 1 });
    await repo.recordEnrichmentWatermark(c.id, NOW - 100 * DAY);
    insertEmail('e1', 'aged@corp.io', NOW - 100 * DAY + 90 * DAY); // exactly watermark + 90d

    // Exactly on the boundary is NOT re-enriched (strict >) …
    expect(await repo.getEnrichmentCandidates({ minAgeDays: 90 })).toEqual([]);
    // …one second past it is.
    insertEmail('e2', 'aged@corp.io', NOW - 100 * DAY + 90 * DAY + 1);
    expect((await repo.getEnrichmentCandidates({ minAgeDays: 90 })).map((r) => r.id)).toEqual([c.id]);
  });

  it('orders newest-mail-first and honours the limit so a huge mailbox is walked in slices', async () => {
    for (const [i, email] of ['old@corp.io', 'mid@corp.io', 'new@corp.io'].entries()) {
      await repo.upsert({ email, receivedCount: 1 });
      insertEmail(`e${i}`, email, NOW - (10 - i * 4) * DAY);
    }
    expect((await repo.getEnrichmentCandidates()).map((c) => c.email))
      .toEqual(['new@corp.io', 'mid@corp.io', 'old@corp.io']);
    expect((await repo.getEnrichmentCandidates({ limit: 2 })).map((c) => c.email))
      .toEqual(['new@corp.io', 'mid@corp.io']);
  });

  it('returns an empty list on a mailbox with no mail at all', async () => {
    await repo.upsert({ email: 'lonely@corp.io' });
    expect(await repo.getEnrichmentCandidates()).toEqual([]);
  });

  // THE performance guard, asserted against the repository's REAL exported SQL
  // so the two cannot drift. Sender lookups are case-folded, which no plain
  // `from_address` index can serve — so before idx_emails_from_lower_date this
  // join scanned every email once per contact: 2,222.9ms of blocked main thread
  // on a 26k mailbox (profiled 2026-08-26), re-run 3 seconds after every
  // enrichment batch ack. If the LOWER() spelling here ever stops matching the
  // index's expression, or the index is dropped, the freeze comes straight back
  // and nothing else fails.
  it('seeks the sender index instead of scanning every email', () => {
    const plan = (db
      .prepare(`EXPLAIN QUERY PLAN ${SQL_ENRICHMENT_CANDIDATES}`)
      .all(0, 50) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(' | ');

    expect(plan).toContain('idx_emails_from_lower_date');
    expect(plan).toMatch(/SEARCH e /); // `e` is the emails alias — SEARCH, not SCAN
    expect(plan).not.toMatch(/SCAN e\b/);
    // Covering: `MAX(e.date)` is answered from the index, so the inline bodies
    // are never read. Losing `date` from the index would still pass the SEARCH
    // assertions above while re-introducing a row visit per email.
    expect(plan).toContain('COVERING INDEX idx_emails_from_lower_date');
  });
});

// Company rows are synthesized, keyed on the domain. Creating a second one for
// the same employer would split every colleague's "company" link in two.
describe('ContactRepository — company synthesis', () => {
  it('creates one company row per domain, keyed on the synthetic company@domain address', async () => {
    const created = await repo.upsertCompany({ domain: ' ACME.io ', name: 'Acme Inc', website: 'https://acme.io' });
    expect(created).toMatchObject({
      email: 'company@acme.io', name: 'Acme Inc', organization: 'Acme Inc', kind: 'company',
      emailCount: 0, sentCount: 0, receivedCount: 0, enrichmentSource: 'llm',
      enrichedThroughEmailAt: NOW,
    });
    expect(created.enrichment).toEqual({
      companyName: 'Acme Inc', companyDomain: 'acme.io', companyWebsite: 'https://acme.io',
    });

    const again = await repo.upsertCompany({ domain: 'acme.io', name: 'Acme Inc' });
    expect(again.id).toBe(created.id);
    expect((db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE kind = 'company'").get() as { c: number }).c).toBe(1);
  });

  it('falls back to the domain as the display name and leaves organization null when the LLM had no name', async () => {
    const created = await repo.upsertCompany({ domain: 'unknownco.io' });
    expect(created).toMatchObject({ name: 'unknownco.io', organization: null });
    expect(created.enrichment).toEqual({
      companyName: null, companyDomain: 'unknownco.io', companyWebsite: null,
    });
  });

  it('backfills organization on an existing company row but never overwrites one already set', async () => {
    const bare = await repo.upsertCompany({ domain: 'later.io' });
    const named = await repo.upsertCompany({ domain: 'later.io', name: 'Later Ltd' });
    expect(named.id).toBe(bare.id);
    expect(named.organization).toBe('Later Ltd');
    expect(rowOf('company@later.io').organization).toBe('Later Ltd');

    const renamed = await repo.upsertCompany({ domain: 'later.io', name: 'Renamed Ltd' });
    expect(renamed.organization).toBe('Later Ltd');
  });
});

// applyEnrichment is the one write that can corrupt identity. Every branch below
// corresponds to a real-world failure we must not regress into.
describe('ContactRepository — applyEnrichment', () => {
  const baseEnrichment = (over: Partial<ContactEnrichment> = {}): ContactEnrichment => ({
    fullName: 'Priya Sharma',
    designation: 'Head of Ops',
    companyName: 'Acme Inc',
    companyDomain: 'acme.io',
    companyWebsite: 'https://acme.io',
    companyPhone: '+911140001111',
    ...over,
  });

  it('throws when the contact no longer exists rather than writing an orphan history row', async () => {
    await expect(repo.applyEnrichment({
      contactId: 'ghost', enrichment: baseEnrichment(), enrichedThroughEmailAt: NOW,
    })).rejects.toThrow('Contact not found: ghost');
    expect(historyRows('ghost')).toEqual([]);
  });

  it('mirrors the blob onto the contact, links a company, and opens the first history row', async () => {
    const c = await repo.upsert({ email: 'priya@acme.io', receivedCount: 1 });

    const updated = await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment(), kind: 'individual',
      mobileE164: '+919812345678', enrichedThroughEmailAt: NOW - DAY,
      sourceEmailId: 'e-src', source: 'llm',
    });

    expect(updated).toMatchObject({
      email: 'priya@acme.io', kind: 'individual', title: 'Head of Ops', organization: 'Acme Inc',
      phone: '+911140001111', mobileE164: '+919812345678',
      enrichedThroughEmailAt: NOW - DAY, enrichmentSource: 'llm',
    });
    expect(updated.personId).toBeTruthy();
    expect(updated.enrichment?.companyDomain).toBe('acme.io');

    // The company row was synthesized and linked both ways.
    const company = await repo.getByEmail('company@acme.io');
    expect(updated.companyContactId).toBe(company!.id);

    const history = await repo.getEnrichmentHistory(c.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      contactId: c.id, personId: updated.personId, companyContactId: company!.id,
      designation: 'Head of Ops', organization: 'Acme Inc',
      effectiveFrom: NOW - DAY, effectiveTo: null, source: 'llm', sourceEmailId: 'e-src',
    });
    expect(history[0].enrichment.fullName).toBe('Priya Sharma');
  });

  it('never gives a role mailbox a person_id or a personal mobile, but still applies company enrichment', async () => {
    const hr = await repo.upsert({ email: 'hr@acme.io', receivedCount: 1 });
    const updated = await repo.applyEnrichment({
      contactId: hr.id, enrichment: baseEnrichment({ fullName: 'Whoever Answers' }),
      mobileE164: '+911140001111', // the company switchboard — must NOT bind
      enrichedThroughEmailAt: NOW,
    });

    expect(updated.personId).toBeNull();
    expect(updated.mobileE164).toBeNull();
    expect(rowOf('hr@acme.io').person_id).toBeNull();
    expect(rowOf('hr@acme.io').mobile_e164).toBeNull();
    // Company-level facts still land.
    expect(updated.organization).toBe('Acme Inc');
    expect(updated.companyContactId).toBe((await repo.getByEmail('company@acme.io'))!.id);
    expect(historyRows(hr.id)).toHaveLength(1);
  });

  it('strips a person_id a role mailbox picked up before role detection existed', async () => {
    const info = await repo.upsert({ email: 'info@acme.io', receivedCount: 1 });
    db.prepare("UPDATE contacts SET person_id = 'legacy-person', mobile_e164 = '+911140001111' WHERE id = ?")
      .run(info.id);

    const updated = await repo.applyEnrichment({
      contactId: info.id, enrichment: baseEnrichment(), enrichedThroughEmailAt: NOW,
    });
    expect(updated.personId).toBeNull();
    expect(updated.mobileE164).toBeNull();
  });

  it('refuses a public mail provider as a company domain, in the stored blob as well as the link', async () => {
    // An LLM returning companyDomain "gmail.com" would otherwise link every
    // Gmail sender into one synthetic company and mark them colleagues.
    const c = await repo.upsert({ email: 'friend@gmail.com', receivedCount: 1 });
    const updated = await repo.applyEnrichment({
      contactId: c.id,
      enrichment: baseEnrichment({ companyName: 'Gmail', companyDomain: 'GMAIL.com' }),
      enrichedThroughEmailAt: NOW,
    });

    expect(updated.companyContactId).toBeNull();
    expect(updated.enrichment?.companyDomain).toBeNull();
    expect(await repo.getByEmail('company@gmail.com')).toBeNull();
    // The history snapshot is sanitized too — it must not reintroduce it later.
    const history = await repo.getEnrichmentHistory(c.id);
    expect(history[0].enrichment.companyDomain).toBeNull();
    expect(history[0].companyContactId).toBeNull();
  });

  it('adopts the signature name only over a placeholder, never over a real display name', async () => {
    // Placeholder 1: no name at all.
    const empty = await repo.upsert({ email: 'pkh@acme.io', receivedCount: 1 });
    expect((await repo.applyEnrichment({
      contactId: empty.id, enrichment: baseEnrichment({ fullName: 'Pooja Khatri' }),
      enrichedThroughEmailAt: NOW,
    })).name).toBe('Pooja Khatri');

    // Placeholder 2: the name IS the local part (capitalised fallback).
    const localPart = await repo.upsert({ email: 'pkh2@acme.io', name: 'PKH2', receivedCount: 1 });
    expect((await repo.applyEnrichment({
      contactId: localPart.id, enrichment: baseEnrichment({ fullName: 'Pooja Khatri' }),
      enrichedThroughEmailAt: NOW,
    })).name).toBe('Pooja Khatri');

    // Placeholder 3: the name is the whole address.
    const whole = await repo.upsert({ email: 'pkh3@acme.io', name: 'PKH3@acme.io', receivedCount: 1 });
    expect((await repo.applyEnrichment({
      contactId: whole.id, enrichment: baseEnrichment({ fullName: 'Pooja Khatri' }),
      enrichedThroughEmailAt: NOW,
    })).name).toBe('Pooja Khatri');

    // A genuine display name the sender chose wins over the LLM's reading.
    const real = await repo.upsert({ email: 'pkh4@acme.io', name: 'Dr. P. Khatri', receivedCount: 1 });
    expect((await repo.applyEnrichment({
      contactId: real.id, enrichment: baseEnrichment({ fullName: 'Pooja Khatri' }),
      enrichedThroughEmailAt: NOW,
    })).name).toBe('Dr. P. Khatri');

    // No signature name at all → the placeholder is left as-is, not blanked.
    const noSig = await repo.upsert({ email: 'pkh5@acme.io', name: 'PKH5', receivedCount: 1 });
    expect((await repo.applyEnrichment({
      contactId: noSig.id, enrichment: baseEnrichment({ fullName: null }),
      enrichedThroughEmailAt: NOW,
    })).name).toBe('PKH5');
  });

  it('preserves existing title/organization/phone when the new enrichment has none (COALESCE, not clobber)', async () => {
    const c = await repo.upsert({
      email: 'keep@acme.io', name: 'Keep Me', title: 'Existing Title',
      organization: 'Existing Org', phone: '+1999', receivedCount: 1,
    });
    const updated = await repo.applyEnrichment({
      contactId: c.id,
      enrichment: { fullName: 'Keep Me', designation: null, companyName: null, companyDomain: null },
      enrichedThroughEmailAt: NOW,
    });
    expect(updated).toMatchObject({
      title: 'Existing Title', organization: 'Existing Org', phone: '+1999', companyContactId: null,
    });
    // The history snapshot falls back to the contact's current values.
    expect(historyRows(c.id)[0]).toMatchObject({
      designation: 'Existing Title', organization: 'Existing Org',
    });
  });

  it('groups two addresses of the same human when they share a mobile, adopting the existing person_id', async () => {
    const first = await repo.upsert({ email: 'p.sharma@old.io', receivedCount: 1 });
    await repo.applyEnrichment({
      contactId: first.id, enrichment: baseEnrichment({ companyDomain: 'old.io', companyName: 'Old Ltd' }),
      mobileE164: '+919812345678', enrichedThroughEmailAt: NOW - 10 * DAY,
    });
    const personId = (await repo.get(first.id))!.personId;
    expect(personId).toBeTruthy();

    const second = await repo.upsert({ email: 'priya@new.io', receivedCount: 1 });
    const updated = await repo.applyEnrichment({
      contactId: second.id, enrichment: baseEnrichment({ companyDomain: 'new.io', companyName: 'New Ltd' }),
      mobileE164: '+919812345678', enrichedThroughEmailAt: NOW,
    });

    expect(updated.personId).toBe(personId);
    expect((await repo.getRelatedByPerson(second.id)).map((c) => c.email)).toEqual(['p.sharma@old.io']);
    expect((await repo.getRelatedByPerson(first.id)).map((c) => c.email)).toEqual(['priya@new.io']);
  });

  it('backfills a fresh person_id onto older rows that share the mobile but have none', async () => {
    // The mobile was imported (or set by a pre-identity build) without a
    // person_id; enriching a sibling must reconverge the whole group.
    const legacy = await repo.upsert({ email: 'legacy@old.io', receivedCount: 1 });
    db.prepare('UPDATE contacts SET mobile_e164 = ? WHERE id = ?').run('+919800000000', legacy.id);

    const fresh = await repo.upsert({ email: 'fresh@new.io', receivedCount: 1 });
    const updated = await repo.applyEnrichment({
      contactId: fresh.id, enrichment: baseEnrichment({ companyDomain: 'new.io' }),
      mobileE164: '+919800000000', enrichedThroughEmailAt: NOW,
    });

    expect(updated.personId).toBeTruthy();
    expect(rowOf('legacy@old.io').person_id).toBe(updated.personId);
    expect(await repo.findContactsByMobile('+919800000000')).toHaveLength(2);
    expect((await repo.findContactsByMobile('+919800000000', legacy.id)).map((c) => c.email))
      .toEqual(['fresh@new.io']);
    expect(await repo.findContactsByMobile('+910000000000')).toEqual([]);
  });

  it('closes the open history row and opens a new one on a job switch, keeping the old employer readable', async () => {
    const c = await repo.upsert({ email: 'mover@old.io', name: 'Mover', receivedCount: 1 });
    await repo.applyEnrichment({
      contactId: c.id,
      enrichment: baseEnrichment({ companyName: 'Old Ltd', companyDomain: 'old.io', designation: 'Analyst' }),
      enrichedThroughEmailAt: NOW - 30 * DAY,
    });
    await repo.applyEnrichment({
      contactId: c.id,
      enrichment: baseEnrichment({ companyName: 'New Ltd', companyDomain: 'new.io', designation: 'Director' }),
      enrichedThroughEmailAt: NOW,
    });

    const history = await repo.getEnrichmentHistory(c.id);
    expect(history).toHaveLength(2);
    // Newest first: the open (current) row.
    expect(history[0]).toMatchObject({
      organization: 'New Ltd', designation: 'Director', effectiveFrom: NOW, effectiveTo: null,
    });
    // The previous stint is closed, not deleted — "previously at Old Ltd".
    expect(history[1]).toMatchObject({
      organization: 'Old Ltd', designation: 'Analyst', effectiveFrom: NOW - 30 * DAY, effectiveTo: NOW,
    });
    expect(history[0].companyContactId).not.toBe(history[1].companyContactId);
  });

  it('treats a designation change at the same employer as a switch (a promotion is history too)', async () => {
    const c = await repo.upsert({ email: 'promoted@acme.io', receivedCount: 1 });
    await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment({ designation: 'Manager' }),
      enrichedThroughEmailAt: NOW - 5 * DAY,
    });
    await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment({ designation: 'Senior Manager' }),
      enrichedThroughEmailAt: NOW,
    });

    const history = await repo.getEnrichmentHistory(c.id);
    expect(history.map((h) => h.designation)).toEqual(['Senior Manager', 'Manager']);
    expect(history[1].effectiveTo).toBe(NOW);
  });

  it('refreshes the open row in place when nothing about the job changed (no history spam)', async () => {
    const c = await repo.upsert({ email: 'same@acme.io', receivedCount: 1 });
    await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment(), enrichedThroughEmailAt: NOW - 5 * DAY,
    });
    const firstRowId = historyRows(c.id)[0].id;

    await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment({ location: 'Jaipur' }),
      enrichedThroughEmailAt: NOW,
    });

    const history = await repo.getEnrichmentHistory(c.id);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(firstRowId);
    expect(history[0].effectiveFrom).toBe(NOW);   // watermark refreshed
    expect(history[0].effectiveTo).toBeNull();    // still the open row
    expect(history[0].enrichment.location).toBe('Jaipur');
  });

  it('does not open a second history row when the LLM found no job facts at all, twice running', async () => {
    // Both snapshots are all-null: null must compare equal to null, or every
    // fruitless enrichment pass would append a bogus "job change" to the
    // timeline for contacts we know nothing about.
    const c = await repo.upsert({ email: 'blank@corp.io', receivedCount: 1 });
    const empty: ContactEnrichment = { fullName: 'Blank Person', designation: null, companyName: null, companyDomain: null };

    await repo.applyEnrichment({ contactId: c.id, enrichment: { ...empty }, enrichedThroughEmailAt: NOW - 2 * DAY });
    const firstRowId = historyRows(c.id)[0].id;
    await repo.applyEnrichment({ contactId: c.id, enrichment: { ...empty }, enrichedThroughEmailAt: NOW });

    const history = await repo.getEnrichmentHistory(c.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: firstRowId, designation: null, organization: null,
      companyContactId: null, effectiveFrom: NOW, effectiveTo: null,
    });
  });

  it('adopts a signature name for an address with no local part at all', async () => {
    // A malformed "@domain" address has an empty local part; the placeholder
    // test must not divide by it or decide the name is already real.
    const c = await repo.upsert({ email: '@corp.io', receivedCount: 1 });
    const updated = await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment({ fullName: 'Nameless Sender', companyDomain: null }),
      enrichedThroughEmailAt: NOW,
    });
    expect(updated.name).toBe('Nameless Sender');
  });

  it('records a user-sourced correction as source "user"', async () => {
    const c = await repo.upsert({ email: 'edited@acme.io', receivedCount: 1 });
    const updated = await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment(), enrichedThroughEmailAt: NOW, source: 'user',
    });
    expect(updated.enrichmentSource).toBe('user');
    expect((await repo.getEnrichmentHistory(c.id))[0].source).toBe('user');
  });

  it('prefers the personal phone over the company line for the contact.phone column', async () => {
    const c = await repo.upsert({ email: 'phones@acme.io', receivedCount: 1 });
    const updated = await repo.applyEnrichment({
      contactId: c.id,
      enrichment: baseEnrichment({ companyPhone: null, personalPhone: '+919888777666' }),
      enrichedThroughEmailAt: NOW,
    });
    expect(updated.phone).toBe('+919888777666');
  });

  it('promotes a contact to kind=company only when the caller asks, leaving kind alone otherwise', async () => {
    const c = await repo.upsert({ email: 'billing@vendor.io', receivedCount: 1 });
    expect((await repo.get(c.id))!.kind).toBe('individual');

    await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment({ companyDomain: 'vendor.io' }),
      enrichedThroughEmailAt: NOW,
    });
    expect((await repo.get(c.id))!.kind).toBe('individual'); // untouched

    await repo.applyEnrichment({
      contactId: c.id, enrichment: baseEnrichment({ companyDomain: 'vendor.io' }),
      kind: 'company', enrichedThroughEmailAt: NOW,
    });
    expect((await repo.get(c.id))!.kind).toBe('company');
  });
});

// History + person grouping back the contact detail view. Corrupt or absent
// rows must degrade to an empty timeline, never throw in the renderer path.
describe('ContactRepository — history and person grouping reads', () => {
  it('returns an empty timeline for a contact with no history and for an unknown id', async () => {
    const c = await repo.upsert({ email: 'nohist@corp.io' });
    expect(await repo.getEnrichmentHistory(c.id)).toEqual([]);
    expect(await repo.getEnrichmentHistory('ghost')).toEqual([]);
  });

  it('normalizes a nullable/garbled history row: unknown source reads as llm and bad JSON as {}', async () => {
    const c = await repo.upsert({ email: 'garbled@corp.io' });
    db.prepare(`
      INSERT INTO contact_enrichment_history
        (id, contact_id, person_id, enrichment, company_contact_id, designation,
         organization, effective_from, effective_to, source, source_email_id)
      VALUES ('h1', ?, NULL, '{not json', NULL, NULL, NULL, ?, NULL, 'weird', NULL)
    `).run(c.id, NOW);

    const [row] = await repo.getEnrichmentHistory(c.id);
    expect(row).toMatchObject({
      id: 'h1', personId: null, companyContactId: null, designation: null,
      organization: null, effectiveTo: null, source: 'llm', sourceEmailId: null,
    });
    expect(row.enrichment).toEqual({});
  });

  it('returns [] from getRelatedByPerson when the contact has no person_id or does not exist', async () => {
    const solo = await repo.upsert({ email: 'solo@corp.io' });
    expect(await repo.getRelatedByPerson(solo.id)).toEqual([]);
    expect(await repo.getRelatedByPerson('ghost')).toEqual([]);
  });

  it('groups all rows sharing a person_id and always excludes the contact itself', async () => {
    const a = await repo.upsert({ email: 'a@one.io' });
    const b = await repo.upsert({ email: 'b@two.io' });
    const c = await repo.upsert({ email: 'c@three.io' });
    for (const id of [a.id, b.id, c.id]) {
      db.prepare('UPDATE contacts SET person_id = ? WHERE id = ?').run('shared-person', id);
    }
    expect((await repo.getRelatedByPerson(a.id)).map((r) => r.email).sort()).toEqual(['b@two.io', 'c@three.io']);
  });
});

// Avatars are confirm-gated: a wrong photo shown without consent is a privacy
// problem, and a rejected photo re-suggested forever is a nuisance.
describe('ContactRepository — confirm-gated avatars', () => {
  it('walks a candidate through pending → confirmed and out of the discovery queue', async () => {
    const c = await repo.upsert({ email: 'ava@corp.io' });
    await repo.setAvatarCandidate(c.id, 'data:image/png;base64,AAA');
    let read = await repo.get(c.id);
    expect(read).toMatchObject({
      avatarUrl: 'data:image/png;base64,AAA', avatarStatus: 'pending', avatarCheckedAt: NOW,
    });
    expect(await repo.getContactsNeedingAvatar(10, NOW + 1)).toEqual([]);

    await repo.confirmAvatar(c.id);
    read = await repo.get(c.id);
    expect(read).toMatchObject({ avatarStatus: 'confirmed', avatarUrl: 'data:image/png;base64,AAA' });
  });

  it('drops the photo on rejection so initials return and the photo is never re-suggested', async () => {
    const c = await repo.upsert({ email: 'nope@corp.io' });
    await repo.setAvatarCandidate(c.id, 'data:image/png;base64,BBB');
    await repo.rejectAvatar(c.id);

    const read = await repo.get(c.id);
    expect(read?.avatarUrl).toBeNull();
    expect(read?.avatarStatus).toBe('rejected');
    expect(read?.avatarCheckedAt).toBe(NOW);
    expect(await repo.getContactsNeedingAvatar(10, NOW + 1)).toEqual([]);
  });

  it('stamps checked-at with no status when discovery found nothing, so it retries only once stale', async () => {
    const c = await repo.upsert({ email: 'miss@corp.io' });
    await repo.markAvatarChecked(c.id);
    const read = await repo.get(c.id);
    expect(read?.avatarStatus).toBeNull();
    expect(read?.avatarCheckedAt).toBe(NOW);

    // staleBefore is a strict <: a contact probed exactly at the cutoff waits.
    expect(await repo.getContactsNeedingAvatar(10, NOW)).toEqual([]);
    expect((await repo.getContactsNeedingAvatar(10, NOW + 1)).map((r) => r.email)).toEqual(['miss@corp.io']);
  });

  it('queues never-checked contacts newest-active first, honours the limit, and skips blank addresses', async () => {
    await repo.upsert({ email: 'oldest@corp.io', lastSeen: NOW - 10 * DAY });
    await repo.upsert({ email: 'newest@corp.io', lastSeen: NOW - DAY });
    await repo.upsert({ email: 'middle@corp.io', lastSeen: NOW - 5 * DAY });
    // A blank address can never resolve a photo — it must not consume a slot.
    db.prepare(`INSERT INTO contacts (id, email, first_seen, last_seen) VALUES ('blank', '', ?, ?)`)
      .run(NOW, NOW);

    const queue = await repo.getContactsNeedingAvatar(10, NOW + 1);
    expect(queue.map((r) => r.email)).toEqual(['newest@corp.io', 'middle@corp.io', 'oldest@corp.io']);
    expect((await repo.getContactsNeedingAvatar(2, NOW + 1)).map((r) => r.email))
      .toEqual(['newest@corp.io', 'middle@corp.io']);
  });
});

// The phone/URL classifiers run over a whole domain's mail. They are
// authoritative for the fields they own, which is exactly why the ownership
// boundaries (own both phones, only ADD social links) must stay pinned.
describe('ContactRepository — phone mining state', () => {
  it('round-trips the mined watermark and per-number counts, matching the email case-insensitively', async () => {
    await repo.upsert({ email: 'mined@corp.io' });
    repo.setPhoneMiningState('MINED@Corp.IO', NOW - DAY, { '+911140001111': 3, '+919812345678': 1 });

    const state = repo.getPhoneMiningState();
    expect(state.get('mined@corp.io')).toEqual({
      through: NOW - DAY, phones: { '+911140001111': 3, '+919812345678': 1 },
    });
  });

  it('omits contacts never mined, so an unmined contact is not mistaken for "mined, found nothing"', async () => {
    await repo.upsert({ email: 'unmined@corp.io' });
    await repo.upsert({ email: 'mined@corp.io' });
    repo.setPhoneMiningState('mined@corp.io', NOW, {});

    const state = repo.getPhoneMiningState();
    expect([...state.keys()]).toEqual(['mined@corp.io']);
    expect(state.get('mined@corp.io')).toEqual({ through: NOW, phones: {} });
  });

  it('falls back to an empty phone map when the stored JSON is corrupt instead of aborting the scan', async () => {
    await repo.upsert({ email: 'bad@corp.io' });
    repo.setPhoneMiningState('bad@corp.io', NOW, { '+1': 1 });
    db.prepare("UPDATE contacts SET phones_mined = '{oops' WHERE email = 'bad@corp.io'").run();
    expect(repo.getPhoneMiningState().get('bad@corp.io')).toEqual({ through: NOW, phones: {} });

    // A NULL blob with a watermark set is "mined, nothing found".
    db.prepare("UPDATE contacts SET phones_mined = NULL WHERE email = 'bad@corp.io'").run();
    expect(repo.getPhoneMiningState().get('bad@corp.io')).toEqual({ through: NOW, phones: {} });
  });

  it('is a silent no-op for an address with no contact row', () => {
    expect(() => repo.setPhoneMiningState('ghost@corp.io', NOW, {})).not.toThrow();
    expect(repo.getPhoneMiningState().size).toBe(0);
  });

  it('reports the newest mail date per sender, lowercased and grouped, for the incremental skip', () => {
    insertEmail('e1', 'Sender@Corp.IO', NOW - 10 * DAY);
    insertEmail('e2', 'sender@corp.io', NOW - 2 * DAY);
    insertEmail('e3', 'other@corp.io', NOW - 5 * DAY);

    const newest = repo.getNewestEmailDateBySender();
    expect(newest.get('sender@corp.io')).toBe(NOW - 2 * DAY);
    expect(newest.get('other@corp.io')).toBe(NOW - 5 * DAY);
    expect(newest.size).toBe(2);
  });

  it('reports a sender whose only mail carries a zero date as 0, not as missing', async () => {
    // A dateless header stored as 0 must still produce an entry, otherwise the
    // incremental skip reads "no mail" and re-mines the sender forever.
    insertEmail('e1', 'epoch@corp.io', 0);
    expect(repo.getNewestEmailDateBySender().get('epoch@corp.io')).toBe(0);
  });
});

describe('ContactRepository — deterministic phone and URL classification', () => {
  it('fully OWNS both phone fields, clearing a stale number when the new result is null', async () => {
    const c = await repo.upsert({ email: 'clash@corp.io' });
    await repo.applyEnrichment({
      contactId: c.id,
      enrichment: { companyDomain: 'corp.io', companyPhone: '+919999999999', personalPhone: '+918888888888' },
      enrichedThroughEmailAt: NOW,
    });
    expect((await repo.get(c.id))!.enrichment).toMatchObject({
      companyPhone: '+919999999999', personalPhone: '+918888888888',
    });

    // The scan is authoritative: an office line only, no direct number.
    repo.applyPhoneClassification('CLASH@Corp.IO', '+911140001111', null);
    let read = await repo.get(c.id);
    expect(read!.enrichment).toMatchObject({ companyPhone: '+911140001111', personalPhone: null });
    expect(read!.phone).toBe('+911140001111');
    // Untouched enrichment fields survive the merge.
    expect(read!.enrichment?.companyDomain).toBe('corp.io');

    // Nothing found at all — both fields clear rather than keeping a wrong number.
    repo.applyPhoneClassification('clash@corp.io', null, null);
    read = await repo.get(c.id);
    expect(read!.enrichment).toMatchObject({ companyPhone: null, personalPhone: null });
    expect(read!.phone).toBeNull();
  });

  it('prefers the direct number for contact.phone and adds LinkedIn without ever nulling it', async () => {
    const c = await repo.upsert({ email: 'direct@corp.io' });
    repo.applyPhoneClassification('direct@corp.io', '+911140001111', '+919812345678', 'https://linkedin.com/in/x');
    let read = await repo.get(c.id);
    expect(read!.phone).toBe('+919812345678');
    expect(read!.enrichment).toMatchObject({
      companyPhone: '+911140001111', personalPhone: '+919812345678', linkedinUrl: 'https://linkedin.com/in/x',
    });

    // A later pass with no LinkedIn must not wipe the one we already have.
    repo.applyPhoneClassification('direct@corp.io', '+911140001111', '+919812345678');
    read = await repo.get(c.id);
    expect(read!.enrichment?.linkedinUrl).toBe('https://linkedin.com/in/x');
  });

  it('starts from an empty blob when the stored enrichment JSON is corrupt', async () => {
    const c = await repo.upsert({ email: 'corrupt@corp.io' });
    db.prepare("UPDATE contacts SET enrichment = '{broken' WHERE id = ?").run(c.id);

    repo.applyPhoneClassification('corrupt@corp.io', '+911140001111', null);
    expect((await repo.get(c.id))!.enrichment).toEqual({
      companyPhone: '+911140001111', personalPhone: null,
    });
  });

  it('is a no-op for an unknown address in every classifier entry point', async () => {
    expect(() => repo.applyPhoneClassification('ghost@corp.io', '+1', '+2')).not.toThrow();
    expect(() => repo.applyLinkedInUrl('ghost@corp.io', 'https://linkedin.com/in/x')).not.toThrow();
    expect(() => repo.applyPersonalUrls('ghost@corp.io', { twitter: 'https://x.com/y' })).not.toThrow();
    expect(await repo.getCount()).toBe(0);
  });

  it('sets LinkedIn alone without disturbing already-classified phones', async () => {
    const c = await repo.upsert({ email: 'linked@corp.io' });
    repo.applyPhoneClassification('linked@corp.io', '+911140001111', '+919812345678');
    repo.applyLinkedInUrl('LINKED@corp.io', 'https://linkedin.com/in/priya');

    const read = await repo.get(c.id);
    expect(read!.enrichment).toMatchObject({
      companyPhone: '+911140001111', personalPhone: '+919812345678',
      linkedinUrl: 'https://linkedin.com/in/priya',
    });
    expect(read!.phone).toBe('+919812345678');
  });

  it('ignores an empty LinkedIn URL rather than writing a blank profile link', async () => {
    const c = await repo.upsert({ email: 'blanklink@corp.io' });
    repo.applyLinkedInUrl('blanklink@corp.io', '');
    expect((await repo.get(c.id))!.enrichment).toBeNull();
  });

  it('recovers from corrupt enrichment JSON on the LinkedIn-only path too', async () => {
    const c = await repo.upsert({ email: 'badlink@corp.io' });
    db.prepare("UPDATE contacts SET enrichment = 'nonsense' WHERE id = ?").run(c.id);
    repo.applyLinkedInUrl('badlink@corp.io', 'https://linkedin.com/in/z');
    expect((await repo.get(c.id))!.enrichment).toEqual({ linkedinUrl: 'https://linkedin.com/in/z' });
  });

  it('merges personal social URLs additively, labelling each platform and never duplicating one', async () => {
    const c = await repo.upsert({ email: 'social@corp.io' });
    repo.applyPersonalUrls('SOCIAL@Corp.IO', {
      twitter: 'https://twitter.com/priya',
      website: 'https://priya.dev',
      socials: [
        'https://www.facebook.com/priya',
        'https://fb.com/priya2',
        'https://instagram.com/priya',
        'https://youtu.be/abc',
        'https://www.youtube.com/@priya',
        'https://x.com/priya',
        'https://www.threads.net/@priya',
        'https://mastodon.social/@priya',
        'https://dribbble.com/priya',
        'not a url at all',
      ],
    });

    const first = (await repo.get(c.id))!.enrichment!;
    expect(first.twitterUrl).toBe('https://twitter.com/priya');
    expect(first.companyWebsite).toBe('https://priya.dev');
    expect(first.otherSocials).toEqual([
      { platform: 'facebook', url: 'https://www.facebook.com/priya' },
      { platform: 'facebook', url: 'https://fb.com/priya2' },
      { platform: 'instagram', url: 'https://instagram.com/priya' },
      { platform: 'youtube', url: 'https://youtu.be/abc' },
      { platform: 'youtube', url: 'https://www.youtube.com/@priya' },
      { platform: 'twitter', url: 'https://x.com/priya' },
      { platform: 'threads', url: 'https://www.threads.net/@priya' },
      { platform: 'mastodon', url: 'https://mastodon.social/@priya' },
      { platform: 'dribbble', url: 'https://dribbble.com/priya' },
      { platform: 'web', url: 'not a url at all' },
    ]);

    // Re-running the scan must not duplicate the known links, and must append
    // only what is genuinely new.
    repo.applyPersonalUrls('social@corp.io', {
      socials: ['https://instagram.com/priya', 'https://github.com/priya'],
    });
    const second = (await repo.get(c.id))!.enrichment!;
    expect(second.otherSocials).toHaveLength(11);
    expect(second.otherSocials?.at(-1)).toEqual({ platform: 'github', url: 'https://github.com/priya' });
    // Additive: the earlier twitter/website values are still there.
    expect(second.twitterUrl).toBe('https://twitter.com/priya');
    expect(second.companyWebsite).toBe('https://priya.dev');
  });

  it('labels an unparseable-hostname link as generic "web" rather than emitting a blank platform', async () => {
    const c = await repo.upsert({ email: 'oddhost@corp.io' });
    repo.applyPersonalUrls('oddhost@corp.io', { socials: ['https://.foo/page'] });
    expect((await repo.get(c.id))!.enrichment?.otherSocials).toEqual([
      { platform: 'web', url: 'https://.foo/page' },
    ]);
  });

  it('starts from an empty blob when the URL merge finds corrupt enrichment JSON', async () => {
    const c = await repo.upsert({ email: 'badurls@corp.io' });
    db.prepare("UPDATE contacts SET enrichment = '{{{' WHERE id = ?").run(c.id);
    repo.applyPersonalUrls('badurls@corp.io', { twitter: 'https://twitter.com/a' });
    expect((await repo.get(c.id))!.enrichment).toEqual({ twitterUrl: 'https://twitter.com/a' });
  });

  it('repairs a non-array otherSocials value instead of throwing on it', async () => {
    const c = await repo.upsert({ email: 'weird@corp.io' });
    db.prepare(`UPDATE contacts SET enrichment = '{"otherSocials":"oops"}' WHERE id = ?`).run(c.id);
    repo.applyPersonalUrls('weird@corp.io', { socials: ['https://instagram.com/x'] });
    expect((await repo.get(c.id))!.enrichment?.otherSocials).toEqual([
      { platform: 'instagram', url: 'https://instagram.com/x' },
    ]);
  });

  it('writes org-wide URLs onto the per-domain company row, creating it when needed', async () => {
    repo.applyCompanyUrls('ACME.io ', {
      twitter: 'https://twitter.com/acme',
      website: 'https://acme.io',
      socials: ['https://linkedin.com/company/acme'],
    });

    const company = await repo.getByEmail('company@acme.io');
    expect(company).not.toBeNull();
    expect(company!.kind).toBe('company');
    expect(company!.enrichment).toMatchObject({
      companyDomain: 'acme.io',
      twitterUrl: 'https://twitter.com/acme',
      companyWebsite: 'https://acme.io',
      otherSocials: [{ platform: 'linkedin', url: 'https://linkedin.com/company/acme' }],
    });
  });

  it('creates the company row from a twitter-only result, with no website to record', async () => {
    repo.applyCompanyUrls('twitteronly.io', { socials: ['https://twitter.com/tonly'] });
    const company = await repo.getByEmail('company@twitteronly.io');
    expect(company!.enrichment).toMatchObject({
      companyDomain: 'twitteronly.io', companyWebsite: null,
      otherSocials: [{ platform: 'twitter', url: 'https://twitter.com/tonly' }],
    });
  });

  it('does nothing for a blank domain or an empty URL set (never creating a stub company row)', async () => {
    repo.applyCompanyUrls('', { twitter: 'https://twitter.com/x' });
    repo.applyCompanyUrls('  ', { twitter: 'https://twitter.com/x' });
    repo.applyCompanyUrls('acme.io', {});
    repo.applyCompanyUrls('acme.io', { twitter: null, website: null, socials: [] });
    expect(await repo.getCount()).toBe(0);
  });
});

// The enrichment source of truth: the LLM reads these rows. Wrong ordering or a
// missing case-fold means it enriches from someone else's mail.
describe('ContactRepository — recent inbound emails', () => {
  it('returns the sender\'s newest mail first, case-insensitively, capped by the limit', async () => {
    insertEmail('e1', 'Sender@Corp.IO', NOW - 10 * DAY, 'oldest');
    insertEmail('e2', 'sender@corp.io', NOW - 2 * DAY, 'newest');
    insertEmail('e3', 'SENDER@CORP.IO', NOW - 5 * DAY, 'middle');
    insertEmail('e4', 'someone-else@corp.io', NOW - DAY, 'other person');

    const all = await repo.getRecentInboundEmails('sender@corp.io');
    expect(all.map((e) => (e as unknown as { subject: string }).subject))
      .toEqual(['newest', 'middle', 'oldest']);

    const capped = await repo.getRecentInboundEmails('SENDER@corp.io', 2);
    expect(capped.map((e) => (e as unknown as { subject: string }).subject)).toEqual(['newest', 'middle']);
  });

  it('returns an empty list for a sender with no inbound mail', async () => {
    expect(await repo.getRecentInboundEmails('nobody@corp.io')).toEqual([]);
  });
});
