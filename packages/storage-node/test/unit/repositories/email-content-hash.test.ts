import { NO_BODY_CONTENT_HASH_PREFIX, bodyContentHash, emailContentHash } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { EmailRepository } from '../../../src/repositories/email-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';

// What breaks if this file fails: nothing visibly, which is why it exists.
//
// `emails.content_hash` is the column that answers "is this the same content?".
// It was computed ONCE, at ingest, as a hash of `cleanBody || subject` — and
// under headers-first sync (how the entire mailbox arrives) `cleanBody` is '',
// so the stored value was a hash of the SUBJECT. It was then never recomputed
// when the body arrived by prefetch or reheal. Two consequences, both silent:
//
//  * Unrelated mail sharing a subject line — every issue of a recurring
//    notification — claimed identical content. Anything collapsing or deduping
//    on the hash would hide real mail.
//  * The embedding freshness check (`hasEmbedding(emailId, contentHash)`) never
//    fires when a body lands, so a vector built from the subject alone is
//    treated as current forever.
//
// Measured on a live account before the fix: 1,809 hash groups spanned more than
// one distinct `clean_body_len`, which a body-derived hash cannot do.
//
// So every test here asserts one thing from a different angle: the column is
// derived from the BODY, and the body arriving is what updates it.

const NOW = 1780315200; // 2026-06-15T12:00:00Z

/** A stored email, headers-first by default — exactly how sync creates rows. */
async function seed(
  repo: EmailRepository,
  db: Database.Database,
  id: string,
  over: { cleanBody?: string; rawBody?: string; subject?: string } = {},
): Promise<void> {
  db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
    .run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, ?)`,
  ).run(`t-${id}`, `<${id}@test>`, `<${id}@test>`, NOW);

  const cleanBody = over.cleanBody ?? '';
  const rawBody = over.rawBody ?? '';
  const messageId = `<${id}@test>`;

  await repo.insert({
    id,
    messageId,
    threadId: `t-${id}`,
    folderId: 'f-inbox',
    uid: 1,
    subject: over.subject ?? 'a subject',
    fromAddress: 'a@b.example',
    fromName: null,
    toAddress: 'me@test.example',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: NOW,
    receivedDate: NOW,
    cleanBody,
    rawBody,
    contentType: 'text',
    // Through the same shared rule production uses, so the seeded row is what
    // MessageProcessor.convertMessage would actually have produced.
    contentHash: emailContentHash({ cleanBody, rawBody, messageId }),
    inReplyTo: null,
    references: null,
    priority: null,
    tags: '|INBOX|',
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    embeddingLastGenerated: null,
  } as never);
}

const hashOf = (db: Database.Database, id: string): string =>
  (db.prepare('SELECT content_hash AS h FROM emails WHERE id = ?').get(id) as { h: string }).h;

describe('content_hash — the body write is what makes it true', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new EmailRepository(() => db);
  });

  // THE headline regression. Before the fix this assertion held the marker
  // forever, because nothing recomputed the column after ingest.
  it('recomputes the hash from the body a prefetch delivers', async () => {
    await seed(repo, db, 'a');
    expect(hashOf(db, 'a').startsWith(NO_BODY_CONTENT_HASH_PREFIX)).toBe(true);

    await repo.update('a', { cleanBody: 'the pangolin report', rawBody: '<p>the pangolin report</p>' });

    expect(hashOf(db, 'a')).toBe(bodyContentHash({ cleanBody: 'the pangolin report' }));
    expect(hashOf(db, 'a')).not.toContain(NO_BODY_CONTENT_HASH_PREFIX);
  });

  // Cross-path agreement: the two routes a message can take into storage — body
  // with the headers, or headers then a fetch — must end on the SAME hash, or
  // identical mail looks different depending on how it happened to sync.
  it('lands on the same hash whether the body came at ingest or later', async () => {
    await seed(repo, db, 'inline', { cleanBody: 'same words', rawBody: '<p>same words</p>' });
    await seed(repo, db, 'later');

    await repo.update('later', { cleanBody: 'same words', rawBody: '<p>same words</p>' });

    expect(hashOf(db, 'later')).toBe(hashOf(db, 'inline'));
  });

  // Two unrelated notifications that share a subject and nothing else. This is
  // the shape of the bug that was found in the wild.
  it('does not give two messages the same hash just because their subjects match', async () => {
    const subject = 'OverTime Request is approved.';
    await seed(repo, db, 'ot1', { subject });
    await seed(repo, db, 'ot2', { subject });
    expect(hashOf(db, 'ot1')).not.toBe(hashOf(db, 'ot2'));

    await repo.update('ot1', { cleanBody: 'August approval' });
    await repo.update('ot2', { cleanBody: 'September approval' });

    expect(hashOf(db, 'ot1')).not.toBe(hashOf(db, 'ot2'));
  });

  // An HTML-only send (most marketing mail) has an EMPTY clean body and all its
  // content in the raw part. Hashing only the clean body would leave it marked
  // body-less forever, exactly as before the fix.
  it('hashes the raw part when the clean part is empty', async () => {
    await seed(repo, db, 'a');

    await repo.update('a', { cleanBody: '', rawBody: '<p>html only</p>' });

    expect(hashOf(db, 'a')).toBe(bodyContentHash({ rawBody: '<p>html only</p>' }));
  });

  // TRANSIENT FAILURE: a reheal that came back with nothing must not downgrade a
  // row that already has a real body hash. Treating an empty result as "the
  // content is now empty" is how a retry turns a temporary blip into permanent
  // wrong data.
  it('leaves a good hash alone when a body write comes back empty', async () => {
    await seed(repo, db, 'a');
    await repo.update('a', { cleanBody: 'real body' });
    const good = hashOf(db, 'a');

    await repo.update('a', { cleanBody: '', rawBody: '' });

    expect(hashOf(db, 'a')).toBe(good);
  });

  // A header-only patch must not touch the column — and must not bind a
  // parameter the statement never mentions, which better-sqlite3 rejects
  // outright (that would break every flag flip in the app).
  it('does not touch the hash on a patch that carries no body', async () => {
    await seed(repo, db, 'a', { cleanBody: 'real body' });
    const before = hashOf(db, 'a');

    await repo.update('a', { subject: 'renamed', tags: '|INBOX|read|' });

    expect(hashOf(db, 'a')).toBe(before);
  });

  // IDEMPOTENT RE-RUN: the body prefetch can legitimately deliver the same body
  // twice (a re-sync, a retried fetch). The hash must not churn, or a freshness
  // check re-embeds the same mail on every pass.
  it('is stable when the same body is written twice', async () => {
    await seed(repo, db, 'a');

    await repo.update('a', { cleanBody: 'real body', rawBody: '<p>real body</p>' });
    const first = hashOf(db, 'a');
    await repo.update('a', { cleanBody: 'real body', rawBody: '<p>real body</p>' });

    expect(hashOf(db, 'a')).toBe(first);
  });

  // A body that genuinely CHANGED (charset re-decode, a reheal that fetched a
  // repaired source) must move the hash — that is the signal a re-embed needs.
  it('follows the body when the body is replaced', async () => {
    await seed(repo, db, 'a');
    await repo.update('a', { cleanBody: 'mojibake' });
    const before = hashOf(db, 'a');

    await repo.update('a', { cleanBody: 'properly decoded' });

    expect(hashOf(db, 'a')).not.toBe(before);
    expect(hashOf(db, 'a')).toBe(bodyContentHash({ cleanBody: 'properly decoded' }));
  });

  // MULTI-ACCOUNT: each account has its own DB, and the hash is content-derived,
  // so the same message synced through two accounts must hash identically —
  // that is what lets a cross-account duplicate ever be recognised as one.
  it('gives the same body the same hash in a second account DB', async () => {
    const other = newMigratedDb();
    const otherRepo = new EmailRepository(() => other);
    await seed(repo, db, 'a');
    await seed(otherRepo, other, 'a');

    await repo.update('a', { cleanBody: 'shared body' });
    await otherRepo.update('a', { cleanBody: 'shared body' });

    expect(hashOf(other, 'a')).toBe(hashOf(db, 'a'));
  });

  // The inline-image relocation rewrites `data:` URIs in the raw body into
  // `sarv-inline:` refs on the way to disk. The hash is taken from the body as
  // FETCHED, so it does not depend on what the image store already held — two
  // accounts receiving the same mail would otherwise disagree.
  it('is not perturbed by the inline-image rewrite of the raw body', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    await seed(repo, db, 'a');

    await repo.update('a', { cleanBody: '', rawBody: `<img src="${png}">` });

    expect(hashOf(db, 'a')).toBe(bodyContentHash({ rawBody: `<img src="${png}">` }));
  });
});
