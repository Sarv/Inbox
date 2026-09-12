// Contact repository — core CRUD, sender stats, signature patterns and the
// SenderContext read model, all against the REAL production schema.
//
// These paths own the address book: every counter the categorization prompt
// reads (tier, replied/read/deleted counts) and every row the Contacts view
// renders comes from here. The bugs this file guards against are the expensive
// kind — a duplicated contact row per casing of an address, an emailCount that
// inflates on metadata-only upserts, a re-scan that stacks counters until
// read_count exceeds received_count, or a windowed query that silently swings a
// sender's tier at midnight.

import type { EmailRecord } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newMigratedDb } from '../../../src/test-support/test-db';

import { ContactRepository } from '../../../src/repositories/contact-repository';

// Frozen clock. The repository stamps first_seen/last_seen/last_received from
// Date.now() and computes the 90-day SenderContext window from it, so every
// boundary assertion below is exact instead of "flaky near midnight".
const NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);
const DAY = 86400;

let db: Database.Database;
let repo: ContactRepository;

/** Minimal parents so the emails FK (folder_id / thread_id) is satisfiable. */
function seedFolderAndThread(threadId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO folders (id, name, path) VALUES ('f1', 'INBOX', 'INBOX')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, ?)`,
  ).run(threadId, `<${threadId}>`, `<${threadId}>`, NOW);
}

/** Insert a real emails row (used by the windowed SenderContext queries). */
function insertEmail(id: string, fromAddress: string, date: number): void {
  const threadId = `t-${id}`;
  seedFolderAndThread(threadId);
  db.prepare(
    `INSERT INTO emails (
       id, message_id, thread_id, folder_id, tags, subject, from_address, date,
       clean_body, raw_body, content_type, content_hash
     ) VALUES (?, ?, ?, 'f1', '|INBOX|', 'subj', ?, ?, 'body', 'body', 'text', ?)`,
  ).run(id, `<${id}>`, threadId, fromAddress, date, `h-${id}`);
}

function logAction(id: string, emailId: string, sender: string, action: string, ts: number): void {
  db.prepare(
    `INSERT INTO user_action_log (id, email_id, action_type, sender_address, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, emailId, action, sender, ts);
}

const contactRow = (email: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM contacts WHERE email = ?').get(email) as Record<string, unknown>;

beforeEach(() => {
  // Only Date is faked: setSenderStatsCounts yields via setImmediate between
  // chunks, and a faked setImmediate would deadlock that await.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  db = newMigratedDb();
  repo = new ContactRepository(() => db);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// A contact row is keyed by email UNIQUE. If the layer above stops normalizing
// casing/whitespace, "Bob@X.com" and "bob@x.com" become two people: the address
// book doubles, counters split across the twins, and VIP/blocked decisions read
// the wrong half.
describe('ContactRepository — contact identity and normalization', () => {
  it('lowercases and trims the email on insert and on every lookup path', async () => {
    const created = await repo.upsert({ email: '  Bob@Example.COM ' });
    expect(created.email).toBe('bob@example.com');

    // Same human, three spellings — one row, found by any of them.
    await repo.upsert({ email: 'BOB@example.com', receivedCount: 1 });
    await repo.upsert({ email: 'bob@EXAMPLE.com ', receivedCount: 1 });

    expect((db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number }).c).toBe(1);
    const fetched = await repo.getByEmail(' BoB@Example.Com  ');
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.receivedCount).toBe(2);
  });

  it('round-trips every persisted field, with NULLable columns coming back as real null', async () => {
    const created = await repo.upsert({
      email: 'ann@corp.io',
      name: 'Ann',
      displayName: 'Annie',
      avatarUrl: 'data:image/png;base64,AAA',
      organization: 'Corp',
      title: 'CTO',
      phone: '+1 555',
      firstSeen: NOW - 500,
      lastSeen: NOW - 100,
      isFavorite: true,
      notes: 'met at conf',
      tags: ['work', 'india'],
      metadata: { source: 'import' },
    });

    const read = await repo.get(created.id);
    expect(read).toMatchObject({
      id: created.id,
      email: 'ann@corp.io',
      name: 'Ann',
      displayName: 'Annie',
      avatarUrl: 'data:image/png;base64,AAA',
      organization: 'Corp',
      title: 'CTO',
      phone: '+1 555',
      firstSeen: NOW - 500,
      lastSeen: NOW - 100,
      emailCount: 1,
      sentCount: 0,
      receivedCount: 0,
      isFavorite: true,
      notes: 'met at conf',
      tags: ['work', 'india'],
      metadata: { source: 'import' },
      kind: 'individual',
    });

    // Untouched nullable columns must be null — never the string "null",
    // which would render as literal text in the contact card.
    const bare = await repo.upsert({ email: 'bare@corp.io' });
    const bareRead = await repo.get(bare.id);
    expect(bareRead?.name).toBeNull();
    expect(bareRead?.displayName).toBeNull();
    expect(bareRead?.notes).toBeNull();
    expect(bareRead?.phone).toBeNull();
    expect(bareRead?.avatarStatus).toBeNull();
    expect(bareRead?.avatarCheckedAt).toBeNull();
    expect(bareRead?.mobileE164).toBeNull();
    expect(bareRead?.enrichment).toBeNull();
    expect(bareRead?.enrichedThroughEmailAt).toBeNull();
    expect(bareRead?.contactType).toBeNull();
    expect(bareRead?.tags).toEqual([]);
    expect(bareRead?.metadata).toEqual({});
  });

  it('types a role/generic mailbox as automated at creation, and a human address not at all', async () => {
    // info@/no-reply@ are an org's functional mailbox. Typing them up front is
    // what stops enrichment giving a switchboard a person identity later.
    await repo.upsert({ email: 'info@acme.com' });
    await repo.upsert({ email: 'no-reply@acme.com' });
    await repo.upsert({ email: 'priya@acme.com' });

    expect(contactRow('info@acme.com').contact_type).toBe('automated');
    expect(contactRow('info@acme.com').contact_type_source).toBe('heuristic');
    expect(contactRow('no-reply@acme.com').contact_type).toBe('automated');
    expect(contactRow('priya@acme.com').contact_type).toBeNull();
    expect(contactRow('priya@acme.com').contact_type_source).toBeNull();
  });

  it('returns null for an unknown id and an unknown email instead of throwing', async () => {
    expect(await repo.get('does-not-exist')).toBeNull();
    expect(await repo.getByEmail('nobody@nowhere.test')).toBeNull();
    expect(repo.getByEmailSync('nobody@nowhere.test')).toBeNull();
  });

  it('reads a NULL classification confidence as null rather than passing NULL through as a number', async () => {
    // Rows predating the classifier have no confidence; the contact card must
    // show "unclassified", not NaN.
    const c = await repo.upsert({ email: 'noconf@corp.io' });
    db.prepare('UPDATE contacts SET contact_type = ?, contact_type_confidence = NULL WHERE id = ?')
      .run('vendor', c.id);
    let read = await repo.get(c.id);
    expect(read?.contactType).toBe('vendor');
    expect(read?.contactTypeConfidence).toBeNull();

    db.prepare('UPDATE contacts SET contact_type_confidence = 0.75 WHERE id = ?').run(c.id);
    read = await repo.get(c.id);
    expect(read?.contactTypeConfidence).toBe(0.75);
  });

  it('falls back to the default when a JSON column holds malformed JSON', async () => {
    // Hand-edited/partially-written rows must not crash the contacts list.
    const c = await repo.upsert({ email: 'broken@corp.io' });
    db.prepare('UPDATE contacts SET tags = ?, metadata = ? WHERE id = ?')
      .run('[not json', '{also not', c.id);

    const read = await repo.get(c.id);
    expect(read?.tags).toEqual([]);
    expect(read?.metadata).toEqual({});
  });
});

// upsert is called once per address per synced email. Its merge rules are the
// only thing keeping the counters honest while folders sync out of order.
describe('ContactRepository — upsert merge semantics', () => {
  it('counts an email only when the caller records one; metadata-only upserts never inflate emailCount', async () => {
    await repo.upsert({ email: 'sam@corp.io', receivedCount: 1 }); // create → 1
    await repo.upsert({ email: 'sam@corp.io', name: 'Sam' });      // metadata only
    await repo.upsert({ email: 'sam@corp.io', organization: 'X' }); // metadata only

    let read = await repo.getByEmail('sam@corp.io');
    expect(read?.emailCount).toBe(1);
    expect(read?.receivedCount).toBe(1);

    await repo.upsert({ email: 'sam@corp.io', sentCount: 1 });
    await repo.upsert({ email: 'sam@corp.io', receivedCount: 1 });
    read = await repo.getByEmail('sam@corp.io');
    expect(read?.emailCount).toBe(3); // one per recorded email, not per upsert
    expect(read?.sentCount).toBe(1);
    expect(read?.receivedCount).toBe(2);
  });

  it('keeps lastSeen at the MAX and firstSeen at the MIN when older folders sync later', async () => {
    await repo.upsert({ email: 'hist@corp.io', firstSeen: NOW - 10 * DAY, lastSeen: NOW - 10 * DAY, receivedCount: 1 });

    // Newer mail moves lastSeen forward but leaves firstSeen alone.
    await repo.upsert({ email: 'hist@corp.io', firstSeen: NOW - DAY, lastSeen: NOW - DAY, receivedCount: 1 });
    let read = await repo.getByEmail('hist@corp.io');
    expect(read?.lastSeen).toBe(NOW - DAY);
    expect(read?.firstSeen).toBe(NOW - 10 * DAY);

    // An OLD archive folder syncing last must not regress lastSeen, and must
    // pull firstSeen back to the genuinely-oldest mail.
    await repo.upsert({ email: 'hist@corp.io', firstSeen: NOW - 400 * DAY, lastSeen: NOW - 400 * DAY, receivedCount: 1 });
    read = await repo.getByEmail('hist@corp.io');
    expect(read?.lastSeen).toBe(NOW - DAY);
    expect(read?.firstSeen).toBe(NOW - 400 * DAY);
  });

  it('adopts a name only when the contact has none, so a real display name is never overwritten', async () => {
    await repo.upsert({ email: 'named@corp.io', name: 'Real Name', receivedCount: 1 });
    await repo.upsert({ email: 'named@corp.io', name: 'ROBOT HEADER', receivedCount: 1 });
    expect((await repo.getByEmail('named@corp.io'))?.name).toBe('Real Name');

    await repo.upsert({ email: 'anon@corp.io', receivedCount: 1 });
    await repo.upsert({ email: 'anon@corp.io', name: 'Found Later', receivedCount: 1 });
    expect((await repo.getByEmail('anon@corp.io'))?.name).toBe('Found Later');
  });

  it('defaults firstSeen/lastSeen to now when the caller omits them', async () => {
    const created = await repo.upsert({ email: 'nodate@corp.io' });
    expect(created.firstSeen).toBe(NOW);
    expect(created.lastSeen).toBe(NOW);
    expect((await repo.getByEmail('nodate@corp.io'))?.lastSeen).toBe(NOW);
  });

  it('heals a row whose activity counters were zeroed or NULLed by an old import', async () => {
    // A last_seen of 0 renders as 1970 and sorts the contact off the bottom of
    // every list; a NULL email_count must not make the next merge write NULL+1.
    const c = await repo.upsert({ email: 'zeroed@corp.io', receivedCount: 1 });
    db.prepare('UPDATE contacts SET first_seen = 0, last_seen = 0, email_count = NULL WHERE id = ?')
      .run(c.id);

    await repo.upsert({
      email: 'zeroed@corp.io', firstSeen: NOW - DAY, lastSeen: NOW - 2 * DAY, receivedCount: 1,
    });
    const read = await repo.getByEmail('zeroed@corp.io');
    expect(read?.lastSeen).toBe(NOW - 2 * DAY); // real date wins over the bogus 0
    expect(read?.firstSeen).toBe(NOW - DAY);
    expect(read?.emailCount).toBe(1);           // NULL treated as 0, not NULL+1
    expect(read?.receivedCount).toBe(2);
  });

  it('does NOT persist avatar fields passed to upsert even though it echoes them back', async () => {
    // Documents current behaviour: the INSERT omits avatar_status /
    // avatar_checked_at, so the returned record disagrees with the row.
    // Avatars are owned by the confirm-gated setters instead.
    const created = await repo.upsert({
      email: 'av@corp.io', avatarStatus: 'confirmed', avatarCheckedAt: NOW - 5,
    });
    expect(created.avatarStatus).toBe('confirmed');

    const read = await repo.get(created.id);
    expect(read?.avatarStatus).toBeNull();
    expect(read?.avatarCheckedAt).toBeNull();
  });
});

// update/delete back the Contacts editor. A silent no-op on an empty patch
// matters: the UI sends whatever changed, sometimes nothing.
describe('ContactRepository — update and delete', () => {
  it('writes scalar, boolean and JSON columns, and treats an all-undefined patch as a no-op', async () => {
    const c = await repo.upsert({ email: 'edit@corp.io', name: 'Edit', isFavorite: false });

    await repo.update(c.id, {
      displayName: 'Edited',
      isFavorite: true,
      tags: ['a', 'b'],
      metadata: { k: 'v' },
      notes: 'note',
    });
    let read = await repo.get(c.id);
    expect(read).toMatchObject({
      displayName: 'Edited', isFavorite: true, tags: ['a', 'b'], metadata: { k: 'v' }, notes: 'note',
    });

    await repo.update(c.id, { name: undefined, title: undefined });
    read = await repo.get(c.id);
    expect(read?.name).toBe('Edit'); // untouched
    expect(read?.displayName).toBe('Edited');

    // Explicit null clears a column back to real NULL.
    await repo.update(c.id, { notes: null, isFavorite: false });
    read = await repo.get(c.id);
    expect(read?.notes).toBeNull();
    expect(read?.isFavorite).toBe(false);
  });

  it('deletes only the targeted contact and ignores an unknown id', async () => {
    const a = await repo.upsert({ email: 'a@corp.io' });
    await repo.upsert({ email: 'b@corp.io' });

    await repo.delete(a.id);
    expect(await repo.get(a.id)).toBeNull();
    expect(await repo.getByEmail('b@corp.io')).not.toBeNull();

    await expect(repo.delete('ghost')).resolves.toBeUndefined();
    expect(await repo.getCount()).toBe(1);
  });
});

// getAll/getCount share buildListWhere on purpose: a page whose count and rows
// disagree shows "12 contacts" over 3 results. Sorting is interpolated into SQL,
// so the whitelist is also an injection boundary.
describe('ContactRepository — listing, filtering and sorting', () => {
  beforeEach(async () => {
    await repo.upsert({ email: 'zoe@corp.io', name: 'Zoe', lastSeen: NOW - DAY, sentCount: 9 });
    await repo.upsert({ email: 'adam@corp.io', name: 'Adam', lastSeen: NOW - 3 * DAY, receivedCount: 2 });
    await repo.upsert({ email: 'mia@other.io', displayName: 'Mia Corp', lastSeen: NOW - 2 * DAY, receivedCount: 1 });
    db.prepare("UPDATE contacts SET contact_type = 'vendor' WHERE email = 'zoe@corp.io'").run();
    db.prepare("UPDATE contacts SET contact_type = 'unknown' WHERE email = 'adam@corp.io'").run();
    db.prepare('UPDATE contacts SET contact_type = NULL WHERE email = \'mia@other.io\'').run();
  });

  it('paginates on the default last_seen DESC order', async () => {
    const page1 = await repo.getAll({ limit: 2, offset: 0 });
    expect(page1.map((c) => c.email)).toEqual(['zoe@corp.io', 'mia@other.io']);
    const page2 = await repo.getAll({ limit: 2, offset: 2 });
    expect(page2.map((c) => c.email)).toEqual(['adam@corp.io']);
  });

  it('honours a whitelisted sort column and direction, and falls back to last_seen for anything else', async () => {
    const byEmailAsc = await repo.getAll({ limit: 10, offset: 0, sortBy: 'email', sortOrder: 'asc' });
    expect(byEmailAsc.map((c) => c.email)).toEqual(['adam@corp.io', 'mia@other.io', 'zoe@corp.io']);

    // camelCase input maps onto the snake_case column.
    const bySent = await repo.getAll({ limit: 10, offset: 0, sortBy: 'sentCount', sortOrder: 'desc' });
    expect(bySent[0].email).toBe('zoe@corp.io');

    // An unlisted / hostile sortBy must not reach SQL — it degrades to the
    // default column rather than erroring or injecting.
    const injected = await repo.getAll({
      limit: 10, offset: 0, sortBy: 'name; DROP TABLE contacts --', sortOrder: 'asc',
    });
    expect(injected.map((c) => c.email)).toEqual(['adam@corp.io', 'mia@other.io', 'zoe@corp.io']);
    expect(await repo.getCount()).toBe(3); // table still there
  });

  it('ranks by the relevance formula, which weights sent mail 3x and decays with staleness', async () => {
    const rows = await repo.getAll({ limit: 10, offset: 0, sortBy: 'relevance' });
    // Compute the same score the SQL does, from the seeded rows.
    const expected = ['zoe@corp.io', 'adam@corp.io', 'mia@other.io']
      .map((email) => {
        const r = contactRow(email) as { sent_count: number; received_count: number; last_seen: number };
        return {
          email,
          score: (r.sent_count * 3 + r.received_count) * (1 / (1 + (NOW - r.last_seen) / 2592000)),
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((r) => r.email);
    expect(rows.map((c) => c.email)).toEqual(expected);

    const asc = await repo.getAll({ limit: 10, offset: 0, sortBy: 'relevance', sortOrder: 'asc' });
    expect(asc.map((c) => c.email)).toEqual([...expected].reverse());
  });

  it('searches email, name AND display_name, with getCount agreeing with getAll', async () => {
    const search = 'corp';
    const rows = await repo.getAll({ limit: 50, offset: 0, search });
    // corp.io matches by email (zoe, adam); "Mia Corp" matches by display_name.
    expect(rows.map((c) => c.email).sort()).toEqual(['adam@corp.io', 'mia@other.io', 'zoe@corp.io']);
    expect(await repo.getCount(search)).toBe(rows.length);

    const byName = await repo.getAll({ limit: 50, offset: 0, search: 'Zo' });
    expect(byName.map((c) => c.email)).toEqual(['zoe@corp.io']);
    expect(await repo.getCount('Zo')).toBe(1);
  });

  it('treats quotes and unmatched brackets in a search term as literal text (parameterized, never interpolated)', async () => {
    await repo.upsert({ email: `quote@corp.io`, name: `O'Brien "Bob"` });
    const rows = await repo.getAll({ limit: 50, offset: 0, search: `O'Brien "Bob"` });
    expect(rows.map((c) => c.email)).toEqual(['quote@corp.io']);

    // A term that would break naive string-built SQL returns nothing, not an error.
    await expect(repo.getAll({ limit: 50, offset: 0, search: `'; DROP TABLE contacts; --` }))
      .resolves.toEqual([]);
    expect(await repo.getCount()).toBe(4);
  });

  it('documents that LIKE metacharacters in a search term still act as wildcards', async () => {
    // Current behaviour: the term is wrapped in %…% and passed to LIKE with no
    // ESCAPE clause, so `_` matches any single char. Recorded so a future
    // escaping fix is a deliberate change, not an accident.
    const underscore = await repo.getAll({ limit: 50, offset: 0, search: 'z_e@' });
    expect(underscore.map((c) => c.email)).toEqual(['zoe@corp.io']);

    const everything = await repo.getAll({ limit: 50, offset: 0, search: '%' });
    expect(everything).toHaveLength(3);
  });

  it('matches NULL-typed contacts when filtering by "unknown" so a fresh address book is not empty', async () => {
    const unknown = await repo.getAll({ limit: 50, offset: 0, contactType: 'unknown' });
    expect(unknown.map((c) => c.email).sort()).toEqual(['adam@corp.io', 'mia@other.io']);
    expect(await repo.getCount(undefined, 'unknown')).toBe(2);

    const vendors = await repo.getAll({ limit: 50, offset: 0, contactType: 'vendor' });
    expect(vendors.map((c) => c.email)).toEqual(['zoe@corp.io']);
    expect(await repo.getCount(undefined, 'vendor')).toBe(1);

    // Filters AND together.
    expect(await repo.getCount('corp', 'vendor')).toBe(1);
    expect(await repo.getCount('mia', 'vendor')).toBe(0);
    const both = await repo.getAll({ limit: 50, offset: 0, search: 'adam', contactType: 'unknown' });
    expect(both.map((c) => c.email)).toEqual(['adam@corp.io']);

    // Relevance sort still applies the same filters.
    const relevanceFiltered = await repo.getAll({
      limit: 50, offset: 0, sortBy: 'relevance', contactType: 'vendor',
    });
    expect(relevanceFiltered.map((c) => c.email)).toEqual(['zoe@corp.io']);
  });

  it('returns an empty list (and zero count) when nothing matches', async () => {
    expect(await repo.getAll({ limit: 10, offset: 0, search: 'nobody-here' })).toEqual([]);
    expect(await repo.getCount('nobody-here')).toBe(0);
    expect(await repo.getCount(undefined, 'no_such_type')).toBe(0);
  });
});

// Extraction runs for every synced message. Getting the address list parsing or
// the exclusion list wrong pollutes the address book permanently.
describe('ContactRepository — extraction from an email', () => {
  const email = (over: Partial<EmailRecord>): EmailRecord =>
    ({ id: 'e1', date: NOW - DAY, ...over } as unknown as EmailRecord);

  it('records the sender (with display name) for received mail', async () => {
    await repo.extractFromEmail(
      email({ fromAddress: 'Sender@Corp.IO', fromName: 'The Sender' }), 'received',
    );
    const c = await repo.getByEmail('sender@corp.io');
    expect(c).toMatchObject({
      email: 'sender@corp.io', name: 'The Sender', receivedCount: 1, sentCount: 0,
      firstSeen: NOW - DAY, lastSeen: NOW - DAY,
    });
  });

  it('records every To and Cc recipient for sent mail and keeps names containing a comma intact', async () => {
    // A naive split on "," shreds `"VIP, Client" <vip@x.io>` and then misaligns
    // the name/address pairing — the exact bug the parser-based path fixes.
    await repo.extractFromEmail(
      email({
        toAddress: '"VIP, Client" <vip@x.io>, Bob <bob@y.io>',
        ccAddress: 'Cc Person <cc@z.io>, bare-cc@z.io',
      }),
      'sent',
    );

    expect((await repo.getByEmail('vip@x.io'))?.name).toBe('VIP, Client');
    expect((await repo.getByEmail('bob@y.io'))?.name).toBe('Bob');
    expect((await repo.getByEmail('cc@z.io'))?.name).toBe('Cc Person');
    expect((await repo.getByEmail('bare-cc@z.io'))?.name).toBeNull();
    expect((await repo.getByEmail('bare-cc@z.io'))?.sentCount).toBe(1);
    for (const addr of ['vip@x.io', 'bob@y.io', 'cc@z.io']) {
      expect((await repo.getByEmail(addr))?.sentCount).toBe(1);
      expect((await repo.getByEmail(addr))?.receivedCount).toBe(0);
    }
  });

  it('leaves an address with no display name nameless rather than inventing one', async () => {
    await repo.extractFromEmail(email({ toAddress: 'plain@x.io' }), 'sent');
    expect((await repo.getByEmail('plain@x.io'))?.name).toBeNull();
  });

  it('skips non-deliverable system addresses and anything without an @', async () => {
    await repo.extractFromEmail(
      email({ toAddress: 'MAILER-DAEMON@corp.io, postmaster@corp.io, real@corp.io' }), 'sent',
    );
    expect(await repo.getByEmail('mailer-daemon@corp.io')).toBeNull();
    expect(await repo.getByEmail('postmaster@corp.io')).toBeNull();
    expect(await repo.getByEmail('real@corp.io')).not.toBeNull();

    expect(repo.isExcludedEmail('not-an-address')).toBe(true);
    expect(repo.isExcludedEmail('  MAILER-Daemon@x.io ')).toBe(true);
    expect(repo.isExcludedEmail('postmaster@x.io')).toBe(true);
    expect(repo.isExcludedEmail('human@x.io')).toBe(false);
  });

  it('writes nothing when the direction has no usable addresses', async () => {
    await repo.extractFromEmail(email({ fromAddress: undefined }), 'received');
    await repo.extractFromEmail(email({ toAddress: undefined, ccAddress: undefined }), 'sent');
    expect(await repo.getCount()).toBe(0);
  });

  // Regression: notification services send from a machine address but put the
  // HUMAN who triggered the event in the From display name. Taken at face value
  // that mints contacts wearing a real colleague's name on an address that is
  // not theirs — "Devendra Rathore <pullrequests-reply@bitbucket.org>" — and
  // searching for that person then returns mostly robots.
  it('never lets a machine mailbox wear the name of the human in the From', async () => {
    await repo.extractFromEmail(
      email({ fromAddress: 'notifications@atlassian.net', fromName: 'Bhupesh Chugh' }), 'received',
    );
    await repo.extractFromEmail(
      email({ fromAddress: 'pullrequests-reply@bitbucket.org', fromName: 'Devendra Rathore' }), 'received',
    );

    expect((await repo.getByEmail('notifications@atlassian.net'))?.name).toBe('atlassian.net');
    expect((await repo.getByEmail('pullrequests-reply@bitbucket.org'))?.name).toBe('bitbucket.org');
  });

  // The flip side: this rule sits on the path EVERY contact is created through,
  // so a real person's name must come through untouched.
  it('keeps a real person’s display name', async () => {
    await repo.extractFromEmail(
      email({ fromAddress: 'bhupesh@sarv.com', fromName: 'Bhupesh Chugh' }), 'received',
    );
    expect((await repo.getByEmail('bhupesh@sarv.com'))?.name).toBe('Bhupesh Chugh');
  });

  it('falls back to now when the email carries no date, so activity ordering never gets a 1970 row', async () => {
    await repo.extractFromEmailSync(
      email({ date: undefined, fromAddress: 'nodate@corp.io' }) as EmailRecord, 'received',
    );
    expect((await repo.getByEmail('nodate@corp.io'))?.firstSeen).toBe(NOW);
  });
});

// sender_stats is the engagement ledger behind VIP/blocked and the AI tier.
// Additive vs absolute writes and the MAX/MIN date guards are where it drifts.
describe('ContactRepository — sender stats', () => {
  it('creates a row with the derived domain and only stamps the dates the caller actually reported', async () => {
    const created = await repo.upsertSenderStats({
      email: ' Boss@Corp.IO ', receivedCount: 2, eventDate: NOW - 5 * DAY,
    });
    expect(created).toMatchObject({
      email: 'boss@corp.io', domain: 'corp.io', receivedCount: 2, repliedCount: 0,
      sentToCount: 0, readCount: 0, deletedCount: 0, firstSeen: NOW - 5 * DAY,
      lastReceived: NOW - 5 * DAY, lastReplied: null, lastSentTo: null,
      isVip: false, isBlocked: false, authPassCount: 0, authFailCount: 0,
    });

    const read = await repo.getSenderStats('BOSS@corp.io');
    expect(read).toMatchObject({
      email: 'boss@corp.io', domain: 'corp.io', receivedCount: 2,
      lastReceived: NOW - 5 * DAY, lastReplied: null, lastSentTo: null, reputationScore: 0,
    });
    expect(read?.id).toBe(created.id);
  });

  it('adds to the counters and keeps last_received/replied/sent_to at the MAX event date', async () => {
    await repo.upsertSenderStats({ email: 'x@corp.io', receivedCount: 1, eventDate: NOW - 2 * DAY });
    await repo.upsertSenderStats({ email: 'x@corp.io', repliedCount: 1, sentToCount: 1, eventDate: NOW - DAY });
    // A backfill of OLDER mail must not drag the "last" timestamps backwards.
    const merged = await repo.upsertSenderStats({
      email: 'x@corp.io', receivedCount: 1, repliedCount: 1, sentToCount: 1, eventDate: NOW - 30 * DAY,
    });

    expect(merged).toMatchObject({
      receivedCount: 2, repliedCount: 2, sentToCount: 2,
      lastReceived: NOW - 2 * DAY, lastReplied: NOW - DAY, lastSentTo: NOW - DAY,
      firstSeen: NOW - 30 * DAY, // …but first_seen DOES move to the oldest mail
    });
    expect(await repo.getSenderStats('x@corp.io')).toMatchObject({
      receivedCount: 2, repliedCount: 2, sentToCount: 2,
      lastReceived: NOW - 2 * DAY, lastReplied: NOW - DAY, lastSentTo: NOW - DAY,
      firstSeen: NOW - 30 * DAY,
    });
  });

  it('stamps last_received on the first received event even though the row already existed', async () => {
    // The row is created by a reply/read action, so last_received starts NULL.
    // Treating NULL as "unknown" (not as a huge number) is what lets the first
    // inbound mail set the date at all.
    await repo.upsertSenderStats({ email: 'later@corp.io', repliedCount: 1, eventDate: NOW - 3 * DAY });
    expect((await repo.getSenderStats('later@corp.io'))?.lastReceived).toBeNull();

    await repo.upsertSenderStats({ email: 'later@corp.io', receivedCount: 1, eventDate: NOW - DAY });
    expect(await repo.getSenderStats('later@corp.io')).toMatchObject({
      receivedCount: 1, lastReceived: NOW - DAY, lastReplied: NOW - 3 * DAY,
    });
  });

  it('repairs a zeroed first_seen instead of treating 1970 as the oldest mail', async () => {
    await repo.upsertSenderStats({ email: 'epoch@corp.io', receivedCount: 1, eventDate: NOW });
    db.prepare('UPDATE sender_stats SET first_seen = 0 WHERE email = ?').run('epoch@corp.io');

    await repo.upsertSenderStats({ email: 'epoch@corp.io', receivedCount: 1, eventDate: NOW - DAY });
    expect((await repo.getSenderStats('epoch@corp.io'))?.firstSeen).toBe(NOW - DAY);
  });

  it('clamps read/deleted counters at zero so an over-applied undo cannot go negative', async () => {
    await repo.upsertSenderStats({ email: 'y@corp.io', readCount: 1, deletedCount: 1 });
    const after = await repo.upsertSenderStats({ email: 'y@corp.io', readCount: -5, deletedCount: -5 });
    expect(after).toMatchObject({ readCount: 0, deletedCount: 0 });
    expect(await repo.getSenderStats('y@corp.io')).toMatchObject({ readCount: 0, deletedCount: 0 });
  });

  it('tracks auth pass and fail counts independently', async () => {
    await repo.upsertSenderStats({ email: 'auth@corp.io', authPass: true });
    let row = await repo.getSenderStats('auth@corp.io');
    expect(row).toMatchObject({ authPassCount: 1, authFailCount: 0 });

    await repo.upsertSenderStats({ email: 'auth@corp.io', authPass: true });
    await repo.upsertSenderStats({ email: 'auth@corp.io', authPass: false });
    row = await repo.getSenderStats('auth@corp.io');
    expect(row).toMatchObject({ authPassCount: 2, authFailCount: 1 });

    const failFirst = await repo.upsertSenderStats({ email: 'fail@corp.io', authPass: false });
    expect(failFirst).toMatchObject({ authPassCount: 0, authFailCount: 1 });
  });

  it('is a no-op UPDATE when an existing row is re-upserted with no counters', async () => {
    const first = await repo.upsertSenderStats({ email: 'noop@corp.io', receivedCount: 3, eventDate: NOW });
    const again = await repo.upsertSenderStats({ email: 'noop@corp.io' });
    expect(again).toMatchObject({
      id: first.id, receivedCount: 3, lastReceived: NOW, firstSeen: NOW,
    });
  });

  it('defaults the event date to now and stores an empty domain for a malformed address', async () => {
    const noAt = await repo.upsertSenderStats({ email: 'malformed', receivedCount: 1 });
    expect(noAt).toMatchObject({ domain: '', firstSeen: NOW, lastReceived: NOW });
    expect((await repo.getSenderStats('malformed'))?.domain).toBe('');
  });

  it('groups senders by domain and returns [] for a domain nobody wrote from', async () => {
    await repo.upsertSenderStats({ email: 'a@shared.io', receivedCount: 1 });
    await repo.upsertSenderStats({ email: 'b@shared.io', receivedCount: 1 });
    await repo.upsertSenderStats({ email: 'c@other.io', receivedCount: 1 });

    const shared = await repo.getSenderStatsByDomain(' Shared.IO ');
    expect(shared.map((s) => s.email).sort()).toEqual(['a@shared.io', 'b@shared.io']);
    expect(await repo.getSenderStatsByDomain('nope.io')).toEqual([]);
    expect(await repo.getSenderStats('ghost@nope.io')).toBeNull();
  });

  it('flips VIP and blocked flags on the addressed row only, and ignores an unknown address', async () => {
    await repo.upsertSenderStats({ email: 'vip@corp.io', receivedCount: 1 });
    await repo.upsertSenderStats({ email: 'spam@bad.io', receivedCount: 1 });

    await repo.setSenderVip(' VIP@Corp.IO ', true);
    await repo.setSenderBlocked('SPAM@bad.io', true);
    expect((await repo.getVipSenders()).map((s) => s.email)).toEqual(['vip@corp.io']);
    expect((await repo.getBlockedSenders()).map((s) => s.email)).toEqual(['spam@bad.io']);

    await repo.setSenderVip('vip@corp.io', false);
    await repo.setSenderBlocked('spam@bad.io', false);
    expect(await repo.getVipSenders()).toEqual([]);
    expect(await repo.getBlockedSenders()).toEqual([]);

    // No row, no write, no throw.
    await expect(repo.setSenderVip('ghost@corp.io', true)).resolves.toBeUndefined();
    await expect(repo.setSenderBlocked('ghost@corp.io', true)).resolves.toBeUndefined();
    expect(await repo.getVipSenders()).toEqual([]);
  });
});

// setSenderStatsCounts exists because the additive path made a full re-scan
// cumulative: every press of "Scan" stacked another complete pass, pushing
// read_count above received_count. Idempotence is the whole point.
describe('ContactRepository — absolute sender-stat re-scan', () => {
  const entry = (email: string, n: number) => ({
    email, receivedCount: n, readCount: n - 1, deletedCount: 0, repliedCount: 1, sentToCount: 2,
  });

  it('SETS the five scan counters instead of adding, so running a scan twice is identical', async () => {
    await repo.setSenderStatsCounts([entry('scan@corp.io', 10)]);
    const first = await repo.getSenderStats('scan@corp.io');
    expect(first).toMatchObject({
      receivedCount: 10, readCount: 9, deletedCount: 0, repliedCount: 1, sentToCount: 2,
    });

    await repo.setSenderStatsCounts([entry('scan@corp.io', 10)]);
    const second = await repo.getSenderStats('scan@corp.io');
    expect(second).toMatchObject({
      receivedCount: 10, readCount: 9, deletedCount: 0, repliedCount: 1, sentToCount: 2,
    });
    expect(second?.id).toBe(first?.id); // same row, not a duplicate

    // A later scan that sees fewer emails writes the smaller truth.
    await repo.setSenderStatsCounts([entry('scan@corp.io', 4)]);
    expect(await repo.getSenderStats('scan@corp.io')).toMatchObject({ receivedCount: 4, readCount: 3 });
  });

  it('leaves reputation, VIP/blocked, auth counts and first_seen untouched', async () => {
    await repo.upsertSenderStats({ email: 'keep@corp.io', receivedCount: 1, authPass: true, eventDate: NOW - 100 * DAY });
    await repo.setSenderVip('keep@corp.io', true);
    db.prepare('UPDATE sender_stats SET reputation_score = 42 WHERE email = ?').run('keep@corp.io');

    await repo.setSenderStatsCounts([entry('keep@corp.io', 7)]);
    expect(await repo.getSenderStats('keep@corp.io')).toMatchObject({
      receivedCount: 7, isVip: true, reputationScore: 42, authPassCount: 1,
      firstSeen: NOW - 100 * DAY,
    });
  });

  it('seeds a brand-new sender (with its domain) and skips blank addresses', async () => {
    await repo.setSenderStatsCounts([entry('fresh@corp.io', 3), entry('   ', 9)]);
    expect(await repo.getSenderStats('fresh@corp.io')).toMatchObject({ domain: 'corp.io', receivedCount: 3 });
    expect((db.prepare('SELECT COUNT(*) AS c FROM sender_stats').get() as { c: number }).c).toBe(1);
  });

  it('is a no-op for an empty batch', async () => {
    await repo.setSenderStatsCounts([]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM sender_stats').get() as { c: number }).c).toBe(0);
  });

  it('writes every entry across the 500-row chunk boundary (the yield between chunks must not drop rows)', async () => {
    const entries = Array.from({ length: 501 }, (_, i) => entry(`bulk${i}@corp.io`, i + 1));
    await repo.setSenderStatsCounts(entries);

    expect((db.prepare('SELECT COUNT(*) AS c FROM sender_stats').get() as { c: number }).c).toBe(501);
    // Spot-check the row on either side of the chunk seam against its seed.
    expect(await repo.getSenderStats('bulk499@corp.io')).toMatchObject({ receivedCount: 500, readCount: 499 });
    expect(await repo.getSenderStats('bulk500@corp.io')).toMatchObject({ receivedCount: 501, readCount: 500 });
  });

  it('rolls the whole chunk back when one entry fails, leaving no half-written rows', async () => {
    // A failure inside the transaction must not commit the EARLIER entries of the
    // same chunk — a partially-applied re-scan reports counts that match neither
    // the old nor the new truth, and nothing detects it afterwards.
    //
    // The failure is INJECTED rather than provoked with a bad value, because no
    // bad value is portable: `received_count` is `INTEGER DEFAULT 0` (nullable),
    // so `undefined`/NULL commits happily, and the two SQLite bindings we run
    // against disagree about whether a non-scalar throws. Failing the second
    // entry's UPDATE is exactly the condition we care about either way.
    const realPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql);
      if (!/UPDATE sender_stats/.test(sql)) return stmt;
      return {
        ...stmt,
        run: (...args: unknown[]) => {
          if (args[args.length - 1] === 'boom@corp.io') throw new Error('disk I/O error');
          return (stmt.run as (...a: unknown[]) => unknown)(...args);
        },
      };
    }) as typeof db.prepare);

    try {
      await expect(
        repo.setSenderStatsCounts([entry('ok@corp.io', 3), entry('boom@corp.io', 5)]),
      ).rejects.toThrow(/disk I\/O error/);
    } finally {
      prepareSpy.mockRestore();
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM sender_stats').get() as { c: number }).c).toBe(0);
  });
});

// Signature patterns let the composer strip a sender's boilerplate. Re-saving
// must merge (one row per address, growing evidence) not duplicate.
describe('ContactRepository — signature patterns', () => {
  it('creates a pattern with usage 1 and returns exactly what was persisted', async () => {
    const saved = await repo.saveSignaturePattern({
      email: ' Sig@Corp.IO ', htmlSelector: 'div.sig', sampleHtml: '<div>Ann</div>',
      emailId: 'e1', confidence: 'high',
    });
    expect(saved).toMatchObject({
      email: 'sig@corp.io', htmlSelector: 'div.sig', sampleHtml: '<div>Ann</div>',
      emailIds: ['e1'], confidence: 'high', usageCount: 1, lastUsed: NOW,
    });

    const read = await repo.getSignaturePatternByEmail('SIG@corp.io');
    expect(read).toMatchObject({
      id: saved.id, email: 'sig@corp.io', htmlSelector: 'div.sig',
      sampleHtml: '<div>Ann</div>', emailIds: ['e1'], confidence: 'high', usageCount: 1,
    });
  });

  it('merges a repeat save: one row, bumped usage, unioned email ids, retained sample', async () => {
    await repo.saveSignaturePattern({
      email: 'sig@corp.io', htmlSelector: 'div.sig', sampleHtml: '<div>first</div>',
      emailId: 'e1', confidence: 'low',
    });
    // No sampleHtml this time — the stored sample must survive.
    const second = await repo.saveSignaturePattern({
      email: 'sig@corp.io', htmlSelector: 'table.sig', emailId: 'e2', confidence: 'high',
    });
    expect(second.emailIds).toEqual(['e1', 'e2']);

    // Same email id again must not be appended twice.
    await repo.saveSignaturePattern({
      email: 'sig@corp.io', htmlSelector: 'table.sig', emailId: 'e2', confidence: 'high',
    });

    expect((db.prepare('SELECT COUNT(*) AS c FROM signature_patterns').get() as { c: number }).c).toBe(1);
    expect(await repo.getSignaturePatternByEmail('sig@corp.io')).toMatchObject({
      htmlSelector: 'table.sig', sampleHtml: '<div>first</div>',
      emailIds: ['e1', 'e2'], confidence: 'high', usageCount: 3,
    });
  });

  it('stores a null sample and no email ids when the detector had neither', async () => {
    const saved = await repo.saveSignaturePattern({
      email: 'nosample@corp.io', htmlSelector: 'p', confidence: 'medium',
    });
    expect(saved.sampleHtml).toBeNull();
    expect(saved.emailIds).toEqual([]);
    expect(await repo.getSignaturePatternByEmail('nosample@corp.io')).toMatchObject({
      sampleHtml: null, emailIds: [],
    });
  });

  it('lists newest-used first, honours limit+offset, and deletes by id', async () => {
    await repo.saveSignaturePattern({ email: 'old@corp.io', htmlSelector: 'a', confidence: 'low' });
    db.prepare('UPDATE signature_patterns SET last_used = ? WHERE email = ?').run(NOW - 10 * DAY, 'old@corp.io');
    await repo.saveSignaturePattern({ email: 'mid@corp.io', htmlSelector: 'b', confidence: 'low' });
    db.prepare('UPDATE signature_patterns SET last_used = ? WHERE email = ?').run(NOW - 5 * DAY, 'mid@corp.io');
    const newest = await repo.saveSignaturePattern({ email: 'new@corp.io', htmlSelector: 'c', confidence: 'low' });

    expect((await repo.getSignaturePatterns()).map((p) => p.email))
      .toEqual(['new@corp.io', 'mid@corp.io', 'old@corp.io']);
    expect((await repo.getSignaturePatterns({ limit: 2 })).map((p) => p.email))
      .toEqual(['new@corp.io', 'mid@corp.io']);
    expect((await repo.getSignaturePatterns({ limit: 2, offset: 1 })).map((p) => p.email))
      .toEqual(['mid@corp.io', 'old@corp.io']);

    await repo.deleteSignaturePattern(newest.id);
    expect(await repo.getSignaturePatternByEmail('new@corp.io')).toBeNull();
    expect((await repo.getSignaturePatterns()).map((p) => p.email)).toEqual(['mid@corp.io', 'old@corp.io']);

    await expect(repo.deleteSignaturePattern('ghost')).resolves.toBeUndefined();
    expect(await repo.getSignaturePatterns()).toHaveLength(2);
  });

  it('recovers the default when the stored email_ids JSON is corrupt', async () => {
    await repo.saveSignaturePattern({ email: 'bad@corp.io', htmlSelector: 'a', confidence: 'low' });
    db.prepare('UPDATE signature_patterns SET email_ids = ? WHERE email = ?').run('[[[', 'bad@corp.io');
    expect((await repo.getSignaturePatternByEmail('bad@corp.io'))?.emailIds).toEqual([]);
  });

  it('returns null / an empty list when nothing has been detected yet', async () => {
    expect(await repo.getSignaturePatternByEmail('nobody@corp.io')).toBeNull();
    expect(await repo.getSignaturePatterns()).toEqual([]);
  });
});

// SenderContext feeds the categorization prompt. A wrong tier changes which
// mail is surfaced, so the mapping from raw rows to tier must be exact — and
// every requested address must come back, even ones we've never seen.
describe('ContactRepository — getSenderContextBatch', () => {
  it('returns {} for an empty request without touching the database', () => {
    expect(repo.getSenderContextBatch([])).toEqual({});
  });

  it('joins contacts with sender_stats and reports both sets of counters', async () => {
    await repo.upsert({ email: 'both@corp.io', receivedCount: 1, isFavorite: false });
    await repo.upsert({ email: 'both@corp.io', receivedCount: 1 });
    await repo.upsertSenderStats({
      email: 'both@corp.io', repliedCount: 2, sentToCount: 3, readCount: 4, deletedCount: 1,
      eventDate: NOW - 2 * DAY,
    });

    const ctx = repo.getSenderContextBatch(['BOTH@Corp.IO'])['both@corp.io'];
    const contact = await repo.getByEmail('both@corp.io');
    const stats = await repo.getSenderStats('both@corp.io');
    expect(ctx).toMatchObject({
      emailCount: contact!.emailCount,
      sentCount: contact!.sentCount,
      receivedCount: contact!.receivedCount,
      repliedCount: stats!.repliedCount,
      sentToCount: stats!.sentToCount,
      readCount: stats!.readCount,
      deletedCount: stats!.deletedCount,
      lastReplied: NOW - 2 * DAY,
      lastSentTo: NOW - 2 * DAY,
      isFavorite: false, isVip: false, isBlocked: false,
    });
  });

  it('still returns a sender that has stats but no contact row (never-saved automated senders)', async () => {
    await repo.upsertSenderStats({ email: 'statsonly@corp.io', receivedCount: 6, repliedCount: 1 });
    const ctx = repo.getSenderContextBatch(['statsonly@corp.io'])['statsonly@corp.io'];
    expect(ctx).toMatchObject({
      emailCount: 0, sentCount: 0, receivedCount: 6, repliedCount: 1, tier: 'known',
    });
  });

  it('derives the tier from the seeded counters, with blocked beating VIP beating favorite', async () => {
    // frequent: user sent them >= 5
    await repo.upsert({ email: 'freq@corp.io', sentCount: 5 });
    // known: received >= 5
    for (let i = 0; i < 5; i++) await repo.upsert({ email: 'known@corp.io', receivedCount: 1 });
    // occasional: received 2..4
    for (let i = 0; i < 2; i++) await repo.upsert({ email: 'occ@corp.io', receivedCount: 1 });
    // first-time: a single received mail
    await repo.upsert({ email: 'first@corp.io', receivedCount: 1 });
    // favorite alone promotes to vip
    await repo.upsert({ email: 'fav@corp.io', receivedCount: 1, isFavorite: true });
    // vip flag on the stats row promotes too
    await repo.upsert({ email: 'vipflag@corp.io', receivedCount: 1 });
    await repo.upsertSenderStats({ email: 'vipflag@corp.io', receivedCount: 1 });
    await repo.setSenderVip('vipflag@corp.io', true);
    // blocked wins even when favorite AND vip
    await repo.upsert({ email: 'blocked@corp.io', receivedCount: 1, isFavorite: true });
    await repo.upsertSenderStats({ email: 'blocked@corp.io', receivedCount: 1 });
    await repo.setSenderVip('blocked@corp.io', true);
    await repo.setSenderBlocked('blocked@corp.io', true);

    const ctx = repo.getSenderContextBatch([
      'freq@corp.io', 'known@corp.io', 'occ@corp.io', 'first@corp.io',
      'fav@corp.io', 'vipflag@corp.io', 'blocked@corp.io',
    ]);
    expect(ctx['freq@corp.io'].tier).toBe('frequent');
    expect(ctx['known@corp.io'].tier).toBe('known');
    expect(ctx['occ@corp.io'].tier).toBe('occasional');
    expect(ctx['first@corp.io'].tier).toBe('first-time');
    expect(ctx['fav@corp.io']).toMatchObject({ tier: 'vip', isFavorite: true, isVip: false });
    expect(ctx['vipflag@corp.io']).toMatchObject({ tier: 'vip', isVip: true });
    expect(ctx['blocked@corp.io']).toMatchObject({ tier: 'blocked', isBlocked: true, isVip: true });
  });

  it('fills every unknown address with a zeroed first-time context so the caller never reads undefined', () => {
    const ctx = repo.getSenderContextBatch(['Ghost@corp.io', 'other@corp.io']);
    expect(Object.keys(ctx).sort()).toEqual(['ghost@corp.io', 'other@corp.io']);
    expect(ctx['ghost@corp.io']).toEqual({
      emailCount: 0, sentCount: 0, receivedCount: 0, repliedCount: 0, sentToCount: 0,
      readCount: 0, deletedCount: 0, isFavorite: false, isVip: false, isBlocked: false,
      tier: 'first-time',
    });
    expect(ctx['ghost@corp.io'].recent).toBeUndefined();
  });

  it('survives a contact row with a blank email instead of throwing on the key lookup', async () => {
    // Imports can leave an empty address behind; the batch must still key it and
    // return a usable context rather than crashing the categorization pass.
    db.prepare(`INSERT INTO contacts (id, email, first_seen, last_seen, received_count) VALUES ('blank', '', ?, ?, 3)`)
      .run(NOW, NOW);
    const ctx = repo.getSenderContextBatch(['']);
    expect(ctx['']).toMatchObject({ receivedCount: 3, tier: 'occasional' });
  });

  it('omits lastReplied/lastSentTo rather than reporting epoch 0 when the user never replied', async () => {
    await repo.upsert({ email: 'noreply@corp.io', receivedCount: 1 });
    await repo.upsertSenderStats({ email: 'noreply@corp.io', receivedCount: 1 });
    const ctx = repo.getSenderContextBatch(['noreply@corp.io'])['noreply@corp.io'];
    expect(ctx.lastReplied).toBeUndefined();
    expect(ctx.lastSentTo).toBeUndefined();
  });

  describe('90-day window', () => {
    // The window is what stops a colleague from three years ago outranking a
    // current one. Its boundary is inclusive at exactly `now - 90d`; one second
    // older must fall outside, or the numbers change silently as time passes.
    const SINCE = NOW - 90 * DAY;

    it('counts received mail on the boundary and excludes mail one second older', async () => {
      insertEmail('in-1', 'win@corp.io', SINCE);          // exactly on the edge → in
      insertEmail('in-2', 'WIN@Corp.IO', NOW - DAY);      // inside, mixed case → in
      insertEmail('out-1', 'win@corp.io', SINCE - 1);     // one second too old → out
      await repo.upsert({ email: 'win@corp.io', receivedCount: 1 });

      const ctx = repo.getSenderContextBatch(['win@corp.io'])['win@corp.io'];
      expect(ctx.recent).toEqual({
        windowDays: 90, receivedCount: 2, readCount: 0, deletedCount: 0, repliedCount: 0,
      });
    });

    it('aggregates read/delete/reply actions in the window and ignores other action types', async () => {
      insertEmail('a-1', 'act@corp.io', NOW - DAY);
      logAction('l1', 'a-1', 'act@corp.io', 'read', NOW - DAY);
      logAction('l2', 'a-1', 'act@corp.io', 'read', NOW - 2 * DAY);
      logAction('l3', 'a-1', 'act@corp.io', 'delete', SINCE);       // on the edge → in
      logAction('l4', 'a-1', 'act@corp.io', 'reply', NOW - 3 * DAY);
      logAction('l5', 'a-1', 'act@corp.io', 'archive', NOW - DAY);  // not a tracked type
      logAction('l6', 'a-1', 'act@corp.io', 'read', SINCE - 1);     // outside the window

      const ctx = repo.getSenderContextBatch(['act@corp.io'])['act@corp.io'];
      expect(ctx.recent).toEqual({
        windowDays: 90, receivedCount: 1, readCount: 2, deletedCount: 1, repliedCount: 1,
      });
    });

    it('attaches recent for an action-only sender (no mail rows) but leaves a silent sender without it', async () => {
      insertEmail('s-1', 'someone@corp.io', NOW - DAY);
      logAction('l7', 's-1', 'actonly@corp.io', 'read', NOW - DAY);
      await repo.upsert({ email: 'silent@corp.io', receivedCount: 1, lastSeen: NOW - 500 * DAY });

      const ctx = repo.getSenderContextBatch(['actonly@corp.io', 'silent@corp.io']);
      expect(ctx['actonly@corp.io'].recent).toEqual({
        windowDays: 90, receivedCount: 0, readCount: 1, deletedCount: 0, repliedCount: 0,
      });
      expect(ctx['silent@corp.io'].recent).toBeUndefined();
    });

    it('still returns lifetime counters when the windowed query cannot run', async () => {
      // Windowed stats are best-effort by design: an older DB (or a mid-migration
      // one) without user_action_log must not blank the whole context batch.
      await repo.upsert({ email: 'lifetime@corp.io', receivedCount: 3 });
      await repo.upsertSenderStats({ email: 'lifetime@corp.io', repliedCount: 2 });
      db.exec('DROP TABLE user_action_log');

      const ctx = repo.getSenderContextBatch(['lifetime@corp.io'])['lifetime@corp.io'];
      expect(ctx).toMatchObject({ receivedCount: 3, repliedCount: 2, tier: 'occasional' });
      expect(ctx.recent).toBeUndefined();
    });
  });
});

// The repository refuses to work without a database rather than writing into a
// half-initialized store — the main process restarts (dev reload) go through
// this path.
describe('ContactRepository — uninitialized storage', () => {
  it('throws "Storage not initialized" instead of silently dropping writes', async () => {
    const orphan = new ContactRepository(() => undefined as unknown as Database.Database);
    await expect(orphan.getByEmail('x@corp.io')).rejects.toThrow('Storage not initialized');
    expect(() => orphan.getSenderContextBatch(['x@corp.io'])).toThrow('Storage not initialized');
  });
});
